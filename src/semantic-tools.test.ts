import { describe, expect, it, vi } from "vitest";
import { SemanticIndex } from "./semantic-index";
import { createSemanticTools, formatSemanticResults } from "./semantic-tools";
import { DEFAULT_SETTINGS } from "./settings";

type MockFile = Readonly<{
  path: string;
  extension: string;
  stat: Readonly<{ mtime: number; size: number }>;
}>;

function createMockApp(contents: Readonly<Record<string, string>>): unknown {
  const files = Object.entries(contents).map(
    ([path, content]): MockFile => ({
      path,
      extension: "md",
      stat: { mtime: 1, size: content.length },
    }),
  );
  return {
    vault: {
      getMarkdownFiles: () => files,
      cachedRead: async (file: MockFile) => contents[file.path] ?? "",
    },
  };
}

function embedTexts(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
  return Promise.resolve(
    texts.map((text) => (text.toLowerCase().includes("garden") ? [1, 0] : [0, 1])),
  );
}

describe("semantic tools", () => {
  it("formats semantic result output with paths, headings, line ranges, snippets, and scores", () => {
    expect(
      formatSemanticResults([
        {
          id: "Gardens.md:0:0:1",
          path: "Gardens.md",
          heading: "Soil",
          text: "garden soil",
          snippet: "garden soil",
          startLine: 3,
          endLine: 4,
          score: 0.98765,
        },
      ]),
    ).toBe("- Gardens.md > Soil (lines 3-4, score 0.988): garden soil");
  });

  it("registers semantic_search and find_similar_notes when enabled", async () => {
    const index = new SemanticIndex({
      app: createMockApp({
        "Gardens.md": "# Soil\ngarden care",
        "Cooking.md": "soup stock",
      }) as never,
      settings: DEFAULT_SETTINGS,
      embedTexts,
    });
    const tools = createSemanticTools(index, DEFAULT_SETTINGS);

    expect(tools.map((tool) => tool.name)).toEqual(["semantic_search", "find_similar_notes"]);
    const semanticSearch = tools.find((tool) => tool.name === "semantic_search");
    if (!semanticSearch) {
      throw new Error("Missing semantic_search");
    }

    const result = await semanticSearch.execute(
      { query: "garden planning", limit: 1 },
      { signal: new AbortController().signal, toolCallId: "test" },
    );

    expect(result).toContain("Gardens.md");
    expect(result).toContain("score 1.000");
  });

  it("does not register tools when semantic search is disabled", () => {
    const index = new SemanticIndex({
      app: createMockApp({ "Gardens.md": "garden" }) as never,
      settings: DEFAULT_SETTINGS,
      embedTexts,
    });

    expect(
      createSemanticTools(index, { ...DEFAULT_SETTINGS, semanticSearchEnabled: false }),
    ).toEqual([]);
  });

  it("updates the index before executing a semantic search", async () => {
    const index = new SemanticIndex({
      app: createMockApp({ "Gardens.md": "garden" }) as never,
      settings: DEFAULT_SETTINGS,
      embedTexts,
    });
    const update = vi.spyOn(index, "update");
    const [semanticSearch] = createSemanticTools(index, DEFAULT_SETTINGS);
    if (!semanticSearch) {
      throw new Error("Missing semantic_search");
    }

    await semanticSearch.execute(
      { query: "garden", limit: 1 },
      { signal: new AbortController().signal, toolCallId: "test" },
    );

    expect(update).toHaveBeenCalledTimes(1);
  });
});
