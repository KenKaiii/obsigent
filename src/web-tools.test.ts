import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  requestUrl: fetchBackedRequest,
}));

import { createWebFetchTool, createWebSearchTool, parseSearchResults } from "./web-tools";

async function fetchBackedRequest(params: RequestUrlParam): Promise<RequestUrlResponse> {
  const requestInit: RequestInit = {};
  if (params.method) {
    requestInit.method = params.method;
  }
  if (params.headers) {
    requestInit.headers = params.headers;
  }
  if (typeof params.body === "string") {
    requestInit.body = params.body;
  }

  const response = await fetch(params.url, requestInit);
  const text = await response.text();
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    status: response.status,
    headers,
    arrayBuffer: new TextEncoder().encode(text).buffer,
    json: undefined,
    text,
  };
}

describe("web tools", () => {
  it("creates web search and fetch tools for the agent", () => {
    expect(createWebSearchTool().name).toBe("web_search");
    expect(createWebFetchTool().name).toBe("web_fetch");
  });

  it("blocks internal URLs for web fetch", async () => {
    const result = await createWebFetchTool().execute(
      { url: "http://localhost:11434/api/tags" },
      { signal: new AbortController().signal, toolCallId: "test" },
    );

    expect(result).toContain("URL blocked");
  });

  it("parses DuckDuckGo HTML search results", () => {
    const results = parseSearchResults(
      "DuckDuckGo",
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Example <b>Result</b></a><div class="result__snippet">A useful snippet</div>',
    );

    expect(results).toEqual([
      {
        title: "Example Result",
        url: "https://example.com",
        snippet: "A useful snippet",
      },
    ]);
  });

  it.skipIf(process.env.OBSIGENT_LIVE_WEB !== "1")(
    "searches the live web and fetches a result page",
    async () => {
      const context = { signal: new AbortController().signal, toolCallId: "test" };
      const searchResult = await createWebSearchTool({ request: fetchBackedRequest }).execute(
        { query: "Obsidian plugin API", max_results: 3 },
        context,
      );
      expect(searchResult).toContain("Web search results for");
      expect(searchResult).toMatch(/https?:\/\//u);

      const fetchResult = await createWebFetchTool({ request: fetchBackedRequest }).execute(
        { url: "https://docs.obsidian.md/Home", max_length: 2000 },
        context,
      );
      expect(fetchResult).toMatch(/Obsidian|Developer/u);
    },
    45_000,
  );
});
