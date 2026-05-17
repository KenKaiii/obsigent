import { Agent } from "@kenkaiiii/gg-agent";
import { providerRegistry, StreamResult, stream } from "@kenkaiiii/gg-ai";
import { describe, expect, it } from "vitest";
import { getOllamaProviderName, registerOllamaProvider, toOllamaMessages } from "./ollama-provider";

describe("ollama provider", () => {
  it("registers with gg-ai provider registry", () => {
    registerOllamaProvider();

    expect(getOllamaProviderName()).toBe("obsigent-ollama");
  });

  it("returns text as actionable content for gg-agent", async () => {
    providerRegistry.register("obsigent-test-text", {
      stream: () =>
        new StreamResult(
          (async function* () {
            yield { type: "text_delta", text: "ok" } as const;
            return {
              message: {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: "ok" }],
              },
              stopReason: "end_turn" as const,
              usage: { inputTokens: 0, outputTokens: 0 },
            };
          })(),
        ),
    });
    const agent = new Agent({
      provider: "obsigent-test-text" as never,
      model: "test",
      maxTurns: 4,
    });

    let text = "";
    let retries = 0;
    for await (const event of agent.prompt("hi")) {
      if (event.type === "text_delta") {
        text += event.text;
      }
      if (event.type === "retry") {
        retries += 1;
      }
    }

    expect(text).toBe("ok");
    expect(retries).toBe(0);
  });

  it("serializes assistant tool calls for Ollama follow-up requests", () => {
    expect(
      toOllamaMessages([
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: "call-1",
              name: "create_note",
              args: { path: "News.md", content: "# News" },
            },
          ],
        },
      ]),
    ).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            type: "function",
            function: {
              index: 0,
              name: "create_note",
              arguments: { path: "News.md", content: "# News" },
            },
          },
        ],
      },
    ]);
  });

  it("serializes user image content for Ollama vision models", () => {
    expect(
      toOllamaMessages([
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this" },
            { type: "image", mediaType: "image/png", data: "abc123" },
          ],
        },
      ]),
    ).toEqual([
      { role: "user", content: "Describe this\n[Image attachment: image/png]", images: ["abc123"] },
    ]);
  });

  it.skipIf(process.env.OBSIGENT_LIVE_OLLAMA !== "1")("streams from local Ollama", async () => {
    registerOllamaProvider();
    const result = stream({
      provider: getOllamaProviderName() as never,
      model: "gemma4:e2b",
      baseUrl: "http://localhost:11434",
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      maxTokens: 20,
      temperature: 0,
    });

    let text = "";
    for await (const event of result) {
      if (event.type === "text_delta") {
        text += event.text;
      }
    }

    expect(text.trim().toLowerCase()).toContain("ok");
  });
});
