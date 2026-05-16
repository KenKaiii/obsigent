import { describe, expect, it } from "vitest";
import {
  applyMentionSuggestion,
  getMentionQuery,
  getMentionSuggestions,
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
});
