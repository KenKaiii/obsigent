import { providerRegistry } from "@kenkaiiii/gg-ai";
import { describe, expect, it, vi } from "vitest";
import {
  getOpenAiCompatibleProviderName,
  registerOpenAiCompatibleProvider,
  toOpenAiMessages,
} from "./openai-compatible-provider";

describe("openai-compatible provider", () => {
  it("registers a custom provider name", () => {
    registerOpenAiCompatibleProvider();

    expect(getOpenAiCompatibleProviderName()).toBe("obsigent-openai-compatible");
  });

  it("serializes multimodal user content into OpenAI-compatible text", () => {
    expect(
      toOpenAiMessages([
        {
          role: "user",
          content: [
            { type: "text", text: "Describe" },
            { type: "image", mediaType: "image/png", data: "abc" },
          ],
        },
      ]),
    ).toEqual([{ role: "user", content: "Describe\n[Image attachment: image/png]" }]);
  });

  it("streams OpenAI-compatible SSE chunks", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(
                encoder.encode('data: {"choices":[{"delta":{"content":"he"}}]}\n\n'),
              );
              controller.enqueue(
                encoder.encode('data: {"choices":[{"delta":{"content":"llo"}}]}\n\n'),
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    ) as typeof fetch;
    try {
      registerOpenAiCompatibleProvider();
      const result = providerRegistry.get(getOpenAiCompatibleProviderName())?.stream({
        provider: getOpenAiCompatibleProviderName() as never,
        model: "test",
        baseUrl: "http://localhost:1234/v1",
        messages: [{ role: "user", content: "hi" }],
      });
      let text = "";
      if (!result) {
        throw new Error("Missing provider result");
      }
      for await (const event of result) {
        if (event.type === "text_delta") {
          text += event.text;
        }
      }
      expect(text).toBe("hello");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("serializes assistant tool calls", () => {
    expect(
      toOpenAiMessages([
        {
          role: "assistant",
          content: [{ type: "tool_call", id: "call-1", name: "read_note", args: { path: "A.md" } }],
        },
      ]),
    ).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "read_note", arguments: JSON.stringify({ path: "A.md" }) },
          },
        ],
      },
    ]);
  });
});
