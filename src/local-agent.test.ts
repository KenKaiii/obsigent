import { Agent, type AgentTool } from "@kenkaiiii/gg-agent";
import type { Provider } from "@kenkaiiii/gg-ai";
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  Modal: class Modal {},
  Notice: class Notice {},
  requestUrl: async () => ({
    status: 500,
    headers: {},
    arrayBuffer: new ArrayBuffer(0),
    json: undefined,
    text: "",
  }),
}));

vi.mock("./embedding-provider", () => ({
  embedWithOllama: async ({ input }: { input: string | readonly string[] }) => ({
    embeddings: (typeof input === "string" ? [input] : input).map(() => [1, 0]),
  }),
}));

import { z } from "zod";
import {
  createDynamicPrompt,
  LocalAgentRuntime,
  SYSTEM_PROMPT,
  withDynamicPrompt,
} from "./local-agent";
import { getOllamaProviderName, registerOllamaProvider } from "./ollama-provider";
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

describe("local agent runtime", () => {
  it("builds dynamic date and time context for each prompt", () => {
    const dynamicPrompt = createDynamicPrompt(new Date("2026-05-15T14:03:04.000Z"));

    expect(dynamicPrompt).toContain("dynamic, do not cache");
    expect(dynamicPrompt).toContain("2026-05-15T14:03:04.000Z");
    expect(dynamicPrompt).toContain("Use this silently as the current date and time");
  });

  it("wraps dynamic context with the user request", () => {
    expect(withDynamicPrompt("hi there", "Current time: now")).toBe(
      "<context>Current time: now</context>\n\n<user_request>hi there</user_request>",
    );
  });

  it("guides the agent to choose semantic or lexical retrieval", () => {
    expect(SYSTEM_PROMPT).toContain("Prefer semantic_search for conceptual questions");
    expect(SYSTEM_PROMPT).toContain("Prefer search_notes for exact strings");
    expect(SYSTEM_PROMPT).toContain("Use find_similar_notes");
  });

  it("rebuilds and reports semantic index status", async () => {
    const runtime = new LocalAgentRuntime();
    const options = {
      app: createMockApp({ "Alpha.md": "alpha" }) as never,
      settings: { ...DEFAULT_SETTINGS, embeddingModel: "nomic-embed-text" },
    };

    const status = await runtime.rebuildSemanticIndex(options);

    expect(status?.noteCount).toBe(1);
    expect(runtime.getSemanticIndexStatus(options)?.chunkCount).toBe(1);
    expect(runtime.getSemanticIndexSnapshot(options)?.files).toHaveLength(1);
  });

  it("hydrates recreated agents with prior chat messages", async () => {
    const runtime = new LocalAgentRuntime();
    const signal = new AbortController().signal;
    runtime.hydrateAgentForTesting(
      {
        app: createMockApp({}) as never,
        settings: DEFAULT_SETTINGS,
        runId: "test",
        onUpdate: () => undefined,
        priorMessages: [
          { role: "user", content: "My favorite color is blue." },
          { role: "assistant", content: "I will remember that." },
        ],
      },
      signal,
    );

    expect(runtime.getAgentMessagesForTesting()).toEqual([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "My favorite color is blue." },
      { role: "assistant", content: "I will remember that." },
    ]);
  });

  it("loads semantic index snapshots in a fresh runtime", async () => {
    const firstRuntime = new LocalAgentRuntime();
    const baseOptions = {
      app: createMockApp({ "Alpha.md": "alpha" }) as never,
      settings: { ...DEFAULT_SETTINGS, embeddingModel: "nomic-embed-text" },
    };
    await firstRuntime.rebuildSemanticIndex(baseOptions);
    const snapshot = firstRuntime.getSemanticIndexSnapshot(baseOptions);

    const nextRuntime = new LocalAgentRuntime();
    const status = nextRuntime.getSemanticIndexStatus({
      ...baseOptions,
      ...(snapshot ? { semanticIndexSnapshot: snapshot } : {}),
    });

    expect(status?.noteCount).toBe(1);
    expect(status?.chunkCount).toBe(1);
  });

  it.skipIf(process.env.OBSIGENT_LIVE_OLLAMA !== "1")(
    "can use gg-agent loop with the Ollama provider",
    async () => {
      registerOllamaProvider();
      const parameters = z.object({ path: z.string() });
      let usedTool = false;
      const agent = new Agent({
        provider: getOllamaProviderName() as Provider,
        model: "gemma4:e2b",
        baseUrl: "http://localhost:11434",
        system: "Use read_note to answer questions about notes. Be brief.",
        tools: [
          {
            name: "read_note",
            description: "Read a note by path.",
            parameters,
            execute: (args: unknown) => {
              const { path } = parameters.parse(args);
              usedTool = true;
              return path === "Test.md" ? "The note says bananas are blue." : "Not found.";
            },
          } satisfies AgentTool<typeof parameters>,
        ],
        maxTurns: 4,
        maxTokens: 500,
        temperature: 0,
      });

      let text = "";
      for await (const event of agent.prompt("Read Test.md. What color are bananas?")) {
        if (event.type === "text_delta") {
          text += event.text;
        }
      }

      expect(usedTool).toBe(true);
      expect(text.toLowerCase()).toContain("blue");
    },
  );
});
