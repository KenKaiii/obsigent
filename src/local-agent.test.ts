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

import { z } from "zod";
import { createDynamicPrompt, withDynamicPrompt } from "./local-agent";
import { getOllamaProviderName, registerOllamaProvider } from "./ollama-provider";

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
