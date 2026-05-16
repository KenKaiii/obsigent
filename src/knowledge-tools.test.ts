import { describe, expect, it } from "vitest";
import { createGraphTools } from "./graph-tools";
import { createMetadataTools } from "./metadata-tools";
import { DEFAULT_SETTINGS } from "./settings";
import { createTaskTools } from "./task-tools";

type MockFile = Readonly<{
  path: string;
  name: string;
  extension: string;
}>;

function createMockApp() {
  const contents: Record<string, string> = {
    "A.md": "---\ntags: [project]\n---\n- [ ] Do thing\n[[B]]",
    "B.md": "#tagged\nDone",
    "C.md": "lonely",
    ".obsidian/Secret.md": "#secret",
  };
  const files = Object.keys(contents).map(
    (path): MockFile => ({
      path,
      name: path.split("/").pop() ?? path,
      extension: "md",
    }),
  );
  const frontmatterByPath: Record<string, Record<string, unknown>> = {
    "A.md": { tags: ["project"] },
    "B.md": {},
    "C.md": {},
    ".obsidian/Secret.md": {},
  };
  return {
    fileManager: {
      processFrontMatter: async (
        file: MockFile,
        fn: (frontmatter: Record<string, unknown>) => void,
      ) => {
        fn(frontmatterByPath[file.path] ?? {});
      },
    },
    vault: {
      getMarkdownFiles: () => files,
      getFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
      cachedRead: async (file: MockFile) => contents[file.path] ?? "",
    },
    metadataCache: {
      resolvedLinks: {
        "A.md": { "B.md": 1 },
      },
      unresolvedLinks: {
        "A.md": { Missing: 2 },
      },
      getFileCache: (file: MockFile) => {
        if (file.path === "A.md") {
          return { frontmatter: frontmatterByPath[file.path] ?? {}, tags: [] };
        }
        if (file.path === "B.md") {
          return { frontmatter: frontmatterByPath[file.path] ?? {}, tags: [{ tag: "#tagged" }] };
        }
        return { frontmatter: {}, tags: [] };
      },
    },
  };
}

function getTool(tools: ReturnType<typeof createMetadataTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Missing tool: ${name}`);
  }
  return tool;
}

describe("knowledge tools", () => {
  it("reads, searches, and updates frontmatter", async () => {
    const app = createMockApp();
    const tools = createMetadataTools(app as never, DEFAULT_SETTINGS);

    expect(
      await getTool(tools, "read_frontmatter").execute(
        { path: "A.md" },
        { signal: new AbortController().signal, toolCallId: "test" },
      ),
    ).toContain("project");
    expect(
      await getTool(tools, "list_tags").execute(
        { limit: 10 },
        { signal: new AbortController().signal, toolCallId: "test" },
      ),
    ).toContain("#project");
    expect(
      await getTool(tools, "search_by_tag").execute(
        { tag: "tagged" },
        { signal: new AbortController().signal, toolCallId: "test" },
      ),
    ).toContain("B.md");
    expect(
      await getTool(tools, "update_frontmatter").execute(
        { path: "A.md", key: "status", value: "active" },
        { signal: new AbortController().signal, toolCallId: "test" },
      ),
    ).toContain("Updated frontmatter status in A.md");
    expect(
      app.metadataCache.getFileCache({ path: "A.md", name: "A.md", extension: "md" }).frontmatter
        .status,
    ).toBe("active");
  });

  it("reports graph backlinks, outlinks, orphans, and broken links", async () => {
    const app = createMockApp();
    const tools = createGraphTools(app as never, DEFAULT_SETTINGS);

    expect(
      await getTool(tools, "get_backlinks").execute(
        { path: "B.md" },
        { signal: new AbortController().signal, toolCallId: "test" },
      ),
    ).toContain("A.md");
    expect(
      await getTool(tools, "get_outlinks").execute(
        { path: "A.md" },
        { signal: new AbortController().signal, toolCallId: "test" },
      ),
    ).toContain("B.md");
    expect(
      await getTool(tools, "find_orphan_notes").execute(
        { limit: 10 },
        { signal: new AbortController().signal, toolCallId: "test" },
      ),
    ).toContain("C.md");
    expect(
      await getTool(tools, "find_broken_links").execute(
        { limit: 10 },
        { signal: new AbortController().signal, toolCallId: "test" },
      ),
    ).toContain("Missing");
  });

  it("lists open tasks and rollup context", async () => {
    const app = createMockApp();
    const tools = createTaskTools(app as never, DEFAULT_SETTINGS);

    expect(
      await getTool(tools, "list_open_tasks").execute(
        { limit: 10 },
        { signal: new AbortController().signal, toolCallId: "test" },
      ),
    ).toContain("A.md:4");
    expect(
      await getTool(tools, "weekly_rollup_context").execute(
        { limit: 2 },
        { signal: new AbortController().signal, toolCallId: "test" },
      ),
    ).toContain("## A.md");
  });
});
