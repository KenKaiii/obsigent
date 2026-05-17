import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  MarkdownView: class MarkdownView {},
  TFile: class TFile {},
  TFolder: class TFolder {},
}));

import { parseContextReferences, resolvePromptContext } from "./context-resolver";
import { DEFAULT_SETTINGS } from "./settings";

type MockFile = Readonly<{
  path: string;
  name: string;
  extension: string;
}>;

type MockFolder = Readonly<{
  path: string;
  children: readonly unknown[];
}>;

function createMockApp(options: {
  contents: Readonly<Record<string, string>>;
  activePath?: string;
  selection?: string;
  folders?: readonly string[];
}) {
  const files = Object.keys(options.contents).map(
    (path): MockFile => ({
      path,
      name: path.split("/").pop() ?? path,
      extension: path.split(".").pop() ?? "",
    }),
  );
  const folders = new Map<string, MockFolder>(
    (options.folders ?? []).map((path) => [path, { path, children: [] }]),
  );

  return {
    vault: {
      getMarkdownFiles: () => files,
      cachedRead: async (file: MockFile) => options.contents[file.path] ?? "",
      getAbstractFileByPath: (path: string) =>
        folders.get(path) ?? files.find((file) => file.path === path) ?? null,
    },
    workspace: {
      getActiveFile: () => files.find((file) => file.path === options.activePath) ?? null,
      getActiveViewOfType: () => ({ editor: { getSelection: () => options.selection ?? "" } }),
    },
    metadataCache: {
      getFirstLinkpathDest: (target: string) =>
        files.find((file) => file.path === target || file.path === `${target}.md`) ?? null,
    },
  };
}

describe("parseContextReferences", () => {
  it("parses current note, selection, wiki links, note mentions, and folder mentions", () => {
    expect(
      parseContextReferences("Use @Current note @selection [[Ideas]] @Projects/Active @Daily"),
    ).toEqual([
      { kind: "current-note", raw: "@Current note", target: "Current note" },
      { kind: "selection", raw: "@selection", target: "selection" },
      { kind: "note", raw: "[[Ideas]]", target: "Ideas" },
      { kind: "folder", raw: "@Projects/Active", target: "Projects/Active" },
      { kind: "note", raw: "@Daily", target: "Daily" },
    ]);
  });

  it("parses @ note references with spaces through the .md extension", () => {
    expect(
      parseContextReferences("Use @example apple.md and @Folder/another example.md please"),
    ).toEqual([
      { kind: "note", raw: "@example apple.md", target: "example apple.md" },
      {
        kind: "note",
        raw: "@Folder/another example.md",
        target: "Folder/another example.md",
      },
    ]);
  });
});

describe("resolvePromptContext", () => {
  it("injects current note and selection context", async () => {
    const app = createMockApp({
      contents: { "Daily.md": "daily note" },
      activePath: "Daily.md",
      selection: "selected text",
    });

    const result = await resolvePromptContext({
      app: app as never,
      settings: DEFAULT_SETTINGS,
      prompt: "Summarize @Current note and @selection",
    });

    expect(result.request).toContain('<context_block label="Current note: Daily.md">');
    expect(result.request).toContain("daily note");
    expect(result.request).toContain("selected text");
    expect(result.displayRequest).toContain("Context:\n- Current note: Daily.md\n- Selection");
  });

  it("resolves note mentions with spaces", async () => {
    const app = createMockApp({
      contents: { "example apple.md": "spaced note" },
    });

    const result = await resolvePromptContext({
      app: app as never,
      settings: DEFAULT_SETTINGS,
      prompt: "Read @example apple.md please",
    });

    expect(result.warnings).toEqual([]);
    expect(result.request).toContain('<context_block label="Note: example apple.md">');
    expect(result.request).toContain("spaced note");
  });

  it("reports ambiguous note mentions", async () => {
    const app = createMockApp({
      contents: {
        "A/Idea.md": "one",
        "B/Idea.md": "two",
      },
    });

    const result = await resolvePromptContext({
      app: app as never,
      settings: DEFAULT_SETTINGS,
      prompt: "Compare @Idea",
    });

    expect(result.warnings).toEqual(["Ambiguous note reference @Idea: A/Idea.md, B/Idea.md"]);
    expect(result.request).toContain("Context warnings:");
  });

  it("enforces excluded folders", async () => {
    const app = createMockApp({
      contents: { ".obsidian/Secret.md": "secret" },
      activePath: ".obsidian/Secret.md",
    });

    const result = await resolvePromptContext({
      app: app as never,
      settings: DEFAULT_SETTINGS,
      prompt: "Read @Current note",
    });

    expect(result.blocks).toEqual([]);
    expect(result.warnings).toEqual(["Context path is excluded: .obsidian/Secret.md"]);
  });

  it("resolves folder mentions with a capped set of markdown files", async () => {
    const app = createMockApp({
      contents: {
        "Projects/A.md": "alpha",
        "Projects/B.md": "beta",
        "Other/C.md": "gamma",
      },
      folders: ["Projects"],
    });

    const result = await resolvePromptContext({
      app: app as never,
      settings: DEFAULT_SETTINGS,
      prompt: "Review @Projects/",
    });

    expect(result.request).toContain("Folder: Projects");
    expect(result.request).toContain("Folder note: Projects/A.md");
    expect(result.request).toContain("alpha");
    expect(result.request).not.toContain("Other/C.md");
  });

  it("truncates huge context blocks", async () => {
    const app = createMockApp({
      contents: { "Long.md": "x".repeat(20_000) },
    });

    const result = await resolvePromptContext({
      app: app as never,
      settings: DEFAULT_SETTINGS,
      prompt: "Use [[Long]]",
    });

    expect(result.blocks[0]?.truncated).toBe(true);
    expect(result.request).toContain("[Truncated");
    expect(result.displayRequest).toContain("Note: Long.md (truncated)");
  });
});
