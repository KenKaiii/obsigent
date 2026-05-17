import { describe, expect, it } from "vitest";
import {
  applyMentionSuggestion,
  getMentionQuery,
  getMentionSuggestions,
  getResolvedMentionRanges,
} from "./mention-suggestions";
import { DEFAULT_SETTINGS } from "./settings";

type MockFile = Readonly<{ path: string; name: string; basename: string; extension: string }>;

function createMockApp(files: readonly string[]) {
  const markdownFiles = files.map(
    (path): MockFile => ({
      path,
      name: path.split("/").pop() ?? path,
      basename: (path.split("/").pop() ?? path).replace(/\.md$/u, ""),
      extension: path.split(".").pop() ?? "",
    }),
  );
  return {
    vault: {
      getMarkdownFiles: () => markdownFiles,
    },
  };
}

describe("mention suggestions", () => {
  it("detects the active @ query at the cursor", () => {
    expect(getMentionQuery("Ask @Dai", 8)).toEqual({ start: 4, end: 8, query: "Dai" });
    expect(getMentionQuery("email@example.com", 17)).toBeNull();
  });

  it("suggests special values, notes, and folders while respecting exclusions", () => {
    const app = createMockApp(["Daily.md", "Projects/Alpha.md", ".obsidian/Secret.md"]);

    expect(
      getMentionSuggestions(app as never, DEFAULT_SETTINGS, "", 10).map((item) => item.insertText),
    ).toEqual(["@Current note", "@selection", "@Projects/Alpha.md", "@Daily.md", "@Projects/"]);
  });

  it("applies a selected mention into the draft", () => {
    const query = getMentionQuery("Read @Da please", 8);
    if (!query) {
      throw new Error("Missing mention query");
    }

    expect(
      applyMentionSuggestion("Read @Da please", query, {
        kind: "note",
        label: "Daily",
        insertText: "@Daily.md",
        detail: "Daily.md",
      }),
    ).toBe("Read @Daily.md please");
  });

  it("adds a trailing space after selected mentions at the end of the draft", () => {
    const query = getMentionQuery("Read @Da", 8);
    if (!query) {
      throw new Error("Missing mention query");
    }

    expect(
      applyMentionSuggestion("Read @Da", query, {
        kind: "note",
        label: "Daily",
        insertText: "@Daily.md",
        detail: "Daily.md",
      }),
    ).toBe("Read @Daily.md ");
  });

  it("finds only resolved mentions for highlighting", () => {
    const app = createMockApp(["Daily.md", "Projects/Alpha.md"]);

    expect(
      getResolvedMentionRanges(
        "Use @Daily.md and @Current note but not @Missing.md",
        app as never,
        DEFAULT_SETTINGS,
      ),
    ).toEqual([
      { start: 4, end: 13, text: "@Daily.md", kind: "note" },
      { start: 18, end: 31, text: "@Current note", kind: "special" },
    ]);
  });

  it("finds resolved note mentions that include spaces", () => {
    const app = createMockApp(["example apple.md", "Folder/another example.md"]);

    expect(
      getResolvedMentionRanges(
        "Compare @example apple.md with @Folder/another example.md please",
        app as never,
        DEFAULT_SETTINGS,
      ),
    ).toEqual([
      { start: 8, end: 25, text: "@example apple.md", kind: "note" },
      { start: 31, end: 57, text: "@Folder/another example.md", kind: "note" },
    ]);
  });
});
