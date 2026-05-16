import { afterEach, describe, expect, it, vi } from "vitest";
import { embedWithOllama } from "./embedding-provider";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("embedWithOllama", () => {
  it("requests Ollama /api/embed with batch input", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            embeddings: [
              [0.1, 0.2],
              [0.3, 0.4],
            ],
          }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await embedWithOllama({
      endpoint: "http://localhost:11434",
      model: "nomic-embed-text",
      input: ["alpha", "beta"],
    });

    expect(result.embeddings).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://localhost:11434/api/embed"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "nomic-embed-text", input: ["alpha", "beta"] }),
      }),
    );
  });

  it("falls back to legacy /api/embeddings when /api/embed is missing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ embedding: [1, 0] }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await embedWithOllama({
      endpoint: "http://localhost:11434",
      model: "nomic-embed-text",
      input: "legacy",
    });

    expect(result.embeddings).toEqual([[1, 0]]);
    expect(fetchMock).toHaveBeenLastCalledWith(
      new URL("http://localhost:11434/api/embeddings"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "nomic-embed-text", prompt: "legacy" }),
      }),
    );
  });

  it("requests legacy embeddings once per input when /api/embed is missing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ embedding: [1, 0] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ embedding: [0, 1] }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await embedWithOllama({
      endpoint: "http://localhost:11434",
      model: "nomic-embed-text",
      input: ["first", "second"],
    });

    expect(result.embeddings).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      new URL("http://localhost:11434/api/embeddings"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "nomic-embed-text", prompt: "first" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      new URL("http://localhost:11434/api/embeddings"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "nomic-embed-text", prompt: "second" }),
      }),
    );
  });

  it("explains when both Ollama embedding APIs are unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      embedWithOllama({
        endpoint: "http://localhost:11434",
        model: "nomic-embed-text",
        input: "missing",
      }),
    ).rejects.toThrow(
      "Ollama embedding APIs are unavailable at http://localhost:11434. Update Ollama to a version that supports /api/embed.",
    );
  });

  it("explains when Ollama has not pulled the embedding model", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: 'model "nomic-embed-text" not found, try pulling it first' }),
          {
            status: 404,
          },
        ),
      );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      embedWithOllama({
        endpoint: "http://localhost:11434",
        model: "nomic-embed-text",
        input: "missing",
      }),
    ).rejects.toThrow(
      "Embedding model nomic-embed-text is not installed in Ollama. Run: ollama pull nomic-embed-text",
    );
  });

  it("detects Ollama model-missing errors from the first embedding endpoint", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: 'model "nomic-embed-text" not found, try pulling it first' }),
          {
            status: 404,
          },
        ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      embedWithOllama({
        endpoint: "http://localhost:11434",
        model: "nomic-embed-text",
        input: "missing",
      }),
    ).rejects.toThrow(
      "Embedding model nomic-embed-text is not installed in Ollama. Run: ollama pull nomic-embed-text",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns stable errors for invalid embedding responses", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ embeddings: [[1, "bad"]] }), { status: 200 }),
    ) as typeof fetch;

    await expect(
      embedWithOllama({
        endpoint: "http://localhost:11434",
        model: "nomic-embed-text",
        input: "bad",
      }),
    ).rejects.toThrow("Ollama /api/embed response included a non-numeric embedding value.");
  });

  it("passes abort signals through to fetch", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ embeddings: [[0.5]] }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await embedWithOllama({
      endpoint: "http://localhost:11434",
      model: "nomic-embed-text",
      input: "signal",
      signal: controller.signal,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
