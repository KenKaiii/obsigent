import { describe, expect, it, vi } from "vitest";
import { chunkMarkdown, cosineSimilarity, SemanticIndex } from "./semantic-index";
import { DEFAULT_SETTINGS } from "./settings";

type MockFile = Readonly<{
  path: string;
  extension: string;
  stat: Readonly<{ mtime: number; size: number }>;
}>;

type MockApp = Readonly<{
  vault: Readonly<{
    getMarkdownFiles: () => MockFile[];
    cachedRead: (file: MockFile) => Promise<string>;
  }>;
}>;

function createMockApp(initialContents: Readonly<Record<string, string>>): {
  app: MockApp;
  updateContent: (path: string, content: string, mtime: number) => void;
} {
  const files = new Map<string, MockFile>();
  const contents = new Map<string, string>();
  for (const [path, content] of Object.entries(initialContents)) {
    files.set(path, toMockFile(path, content, 1));
    contents.set(path, content);
  }

  return {
    app: {
      vault: {
        getMarkdownFiles: () => [...files.values()],
        cachedRead: async (file: MockFile) => contents.get(file.path) ?? "",
      },
    },
    updateContent: (path, content, mtime) => {
      files.set(path, toMockFile(path, content, mtime));
      contents.set(path, content);
    },
  };
}

function toMockFile(path: string, content: string, mtime: number): MockFile {
  return {
    path,
    extension: path.split(".").pop() ?? "",
    stat: { mtime, size: content.length },
  };
}

function createHashEmbedder(): (
  texts: readonly string[],
) => Promise<readonly (readonly number[])[]> {
  return async (texts) => texts.map((text) => [scoreText(text, "alpha"), scoreText(text, "beta")]);
}

function scoreText(text: string, token: string): number {
  return text.toLowerCase().includes(token) ? 1 : 0;
}

describe("chunkMarkdown", () => {
  it("chunks markdown by headings before falling back to fixed chunks", () => {
    const chunks = chunkMarkdown({
      path: "Project.md",
      chunkChars: 300,
      content: "Intro\n\n# Alpha\nAlpha details\n\n## Beta\nBeta details",
    });

    expect(chunks.map((chunk) => chunk.heading)).toEqual([null, "Alpha", "Beta"]);
    expect(chunks.map((chunk) => chunk.startLine)).toEqual([1, 3, 6]);
  });

  it("splits oversized sections deterministically", () => {
    const chunks = chunkMarkdown({
      path: "Long.md",
      chunkChars: 200,
      content: `# Long\n${"x".repeat(450)}`,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.id)).toEqual([
      "Long.md:0:0:1",
      "Long.md:0:1:2",
      "Long.md:0:2:2",
      "Long.md:0:3:2",
      "Long.md:0:4:2",
      "Long.md:0:5:2",
      "Long.md:0:6:2",
    ]);
  });
});

describe("cosineSimilarity", () => {
  it("ranks equivalent directions above unrelated directions", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });
});

describe("SemanticIndex", () => {
  it("indexes visible markdown files and excludes configured folders", async () => {
    const { app } = createMockApp({
      "Alpha.md": "alpha concept",
      ".obsidian/Secret.md": "alpha secret",
    });
    const embedTexts = vi.fn(createHashEmbedder());
    const index = new SemanticIndex({ app: app as never, settings: DEFAULT_SETTINGS, embedTexts });

    const status = await index.update();

    expect(status.noteCount).toBe(1);
    expect(status.chunkCount).toBe(1);
    expect(index.toSnapshot().files.map((file) => file.path)).toEqual(["Alpha.md"]);
  });

  it("returns deterministic semantic search results", async () => {
    const { app } = createMockApp({
      "Zeta.md": "alpha topic",
      "Alpha.md": "alpha topic",
      "Beta.md": "beta topic",
    });
    const index = new SemanticIndex({
      app: app as never,
      settings: DEFAULT_SETTINGS,
      embedTexts: createHashEmbedder(),
    });
    await index.update();

    const results = await index.search("alpha", 3);

    expect(results.map((result) => result.path)).toEqual(["Alpha.md", "Zeta.md", "Beta.md"]);
    expect(results[0]?.score).toBeGreaterThan(results[2]?.score ?? 0);
  });

  it("reuses fresh cached file entries and refreshes stale files", async () => {
    const { app, updateContent } = createMockApp({ "Alpha.md": "alpha" });
    const embedTexts = vi.fn(createHashEmbedder());
    const index = new SemanticIndex({ app: app as never, settings: DEFAULT_SETTINGS, embedTexts });
    await index.update();
    await index.update();

    updateContent("Alpha.md", "beta", 2);
    await index.update();

    expect(embedTexts).toHaveBeenCalledTimes(2);
    const results = await index.search("beta", 1);
    expect(results[0]?.path).toBe("Alpha.md");
  });

  it("loads compatible snapshots and ignores incompatible snapshots", async () => {
    const { app } = createMockApp({ "Alpha.md": "alpha" });
    const firstIndex = new SemanticIndex({
      app: app as never,
      settings: DEFAULT_SETTINGS,
      embedTexts: createHashEmbedder(),
    });
    await firstIndex.update();

    const snapshot = firstIndex.toSnapshot();
    const loadedIndex = new SemanticIndex({
      app: app as never,
      settings: DEFAULT_SETTINGS,
      embedTexts: createHashEmbedder(),
      snapshot,
    });
    const incompatibleIndex = new SemanticIndex({
      app: app as never,
      settings: { ...DEFAULT_SETTINGS, embeddingModel: "other-model" },
      embedTexts: createHashEmbedder(),
      snapshot,
    });

    expect(loadedIndex.getStatus().chunkCount).toBe(1);
    expect(incompatibleIndex.getStatus().chunkCount).toBe(0);
  });
});
