import { describe, expect, it } from "vitest";
import {
  createMaintenanceTools,
  findBlockById,
  parseMarkdownSections,
  planLinkRewrite,
} from "./maintenance-tools";
import { DEFAULT_SETTINGS } from "./settings";

type MockFile = Readonly<{ path: string; extension: string }>;

function createMockApp() {
  const contents: Record<string, string> = {
    "A.md": "# Intro\nHello\n\n## Details\nLine ^block-a\n[[B]]",
    "B.md": "Back to [[A]] and [A](A.md)",
    "C.md": "No links",
  };
  const files = Object.keys(contents).map((path): MockFile => ({ path, extension: "md" }));
  return {
    contents,
    files,
    vault: {
      getMarkdownFiles: () => files,
      getFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
      cachedRead: async (file: MockFile) => contents[file.path] ?? "",
    },
    metadataCache: {
      resolvedLinks: {
        "B.md": { "A.md": 2 },
      },
    },
  };
}

function getTool(tools: ReturnType<typeof createMaintenanceTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Missing tool: ${name}`);
  }
  return tool;
}

describe("maintenance tools", () => {
  it("parses sections and block ids", () => {
    const sections = parseMarkdownSections("# Intro\nHello\n## Details\nBody");

    expect(sections.map((section) => section.heading)).toEqual(["Intro", "Details"]);
    expect(findBlockById("Line one\nLine two ^abc", "abc")?.startLine).toBe(2);
  });

  it("plans link rewrites deterministically", () => {
    const app = createMockApp();

    expect(planLinkRewrite(app.files as never, app.contents, "A.md", "Folder/Renamed.md")).toEqual([
      {
        path: "B.md",
        before: "Back to [[A]] and [A](A.md)",
        after: "Back to [[Renamed]] and [A](Folder/Renamed.md)",
      },
    ]);
  });

  it("previews section and block edits without writing", async () => {
    const app = createMockApp();
    const tools = createMaintenanceTools(app as never, DEFAULT_SETTINGS);

    expect(
      await getTool(tools, "list_sections").execute(
        { path: "A.md" },
        { signal: new AbortController().signal, toolCallId: "test" },
      ),
    ).toContain("Details");
    expect(
      await getTool(tools, "plan_replace_section").execute(
        { path: "A.md", heading: "Details", content: "## Details\nNew" },
        { signal: new AbortController().signal, toolCallId: "test" },
      ),
    ).toContain("Preview replace A.md");
    expect(
      await getTool(tools, "plan_edit_block").execute(
        { path: "A.md", blockId: "block-a", content: "Line replacement ^block-a" },
        { signal: new AbortController().signal, toolCallId: "test" },
      ),
    ).toContain("Before:\nLine ^block-a");
    expect(app.contents["A.md"]).toContain("Line ^block-a");
  });

  it("previews move and trash impacts", async () => {
    const app = createMockApp();
    const tools = createMaintenanceTools(app as never, DEFAULT_SETTINGS);

    expect(
      await getTool(tools, "plan_move_note").execute(
        { path: "A.md", newPath: "Archive/A.md" },
        { signal: new AbortController().signal, toolCallId: "test" },
      ),
    ).toContain("Link rewrite candidates: 1");
    expect(
      await getTool(tools, "plan_trash_note").execute(
        { path: "A.md" },
        { signal: new AbortController().signal, toolCallId: "test" },
      ),
    ).toContain("B.md (2)");
  });
});
