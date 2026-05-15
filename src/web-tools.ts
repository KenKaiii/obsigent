import type { AgentTool } from "@kenkaiiii/gg-agent";
import { type RequestUrlParam, type RequestUrlResponse, requestUrl } from "obsidian";
import { z } from "zod";

export type SearchEngine = "DuckDuckGo" | "DuckDuckGoLite" | "Brave" | "Google";

export type SearchResult = Readonly<{
  title: string;
  url: string;
  snippet: string;
}>;

type SearchRequest = Readonly<{
  url: string;
  headers: Record<string, string>;
  method: "GET" | "POST";
  body?: string;
}>;

type WebRequest = (request: RequestUrlParam) => Promise<RequestUrlResponse>;

export type WebToolsOptions = Readonly<{
  request?: WebRequest;
}>;

const SEARCH_ENGINES: readonly SearchEngine[] = ["DuckDuckGo", "DuckDuckGoLite", "Brave", "Google"];
const SEARCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MAX_WEB_FETCH_CHARS = 20_000;
const DEFAULT_WEB_FETCH_CHARS = 10_000;
const WEB_FETCH_TIMEOUT_MS = 30_000;
const WEB_SEARCH_TIMEOUT_MS = 15_000;

const RATE_LIMIT_PATTERNS = [
  "you appear to be a bot",
  "unusual traffic",
  "captcha",
  "rate limit",
  "too many requests",
  "blocked",
  "access denied",
  "sorry, you have been blocked",
  "anomaly-modal",
  "unfortunately, bots use duckduckgo",
  "challenge-form",
] as const;

const webFetchParameters = z.object({
  url: z.string().describe("The URL to fetch."),
  max_length: z
    .number()
    .int()
    .min(1)
    .max(MAX_WEB_FETCH_CHARS)
    .optional()
    .describe("Maximum characters to return. Default: 10000. Max: 20000."),
});

const webSearchParameters = z.object({
  query: z.string().min(1).describe("Search query."),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Max results to return. Default: 5. Max: 20."),
});

export function createWebFetchTool(
  options: WebToolsOptions = {},
): AgentTool<typeof webFetchParameters> {
  return {
    name: "web_fetch",
    description:
      "Fetch and read content from a URL. Returns page text with HTML stripped. Use after web_search to read current docs, articles, or reference pages.",
    parameters: webFetchParameters,
    async execute(args, context) {
      const maxLength = args.max_length ?? DEFAULT_WEB_FETCH_CHARS;
      if (isBlockedUrl(args.url)) {
        return "Error: URL blocked — requests to private/internal network addresses are not allowed.";
      }

      try {
        const response = await requestWithTimeout(
          options.request ?? requestUrl,
          {
            url: args.url,
            method: "GET",
            headers: {
              "User-Agent": SEARCH_USER_AGENT,
              Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
            throw: false,
          },
          context.signal,
          WEB_FETCH_TIMEOUT_MS,
        );

        if (response.status >= 400) {
          return `Error: HTTP ${response.status}`;
        }

        const contentType = findHeader(response.headers, "content-type");
        const responseText = response.text;
        const content = contentType.includes("html")
          ? htmlToText(responseText)
          : responseText.replace(/\s+/gu, " ").trim();

        if (content.length <= maxLength) {
          return content;
        }

        return `${content.slice(0, maxLength)}\n\n[Content truncated]`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Error fetching ${args.url}: ${message}`;
      }
    },
  } satisfies AgentTool<typeof webFetchParameters>;
}

export function createWebSearchTool(
  options: WebToolsOptions = {},
): AgentTool<typeof webSearchParameters> {
  return {
    name: "web_search",
    description:
      "Search the web and return results. Use for current information, recent events, docs, APIs, or facts beyond your knowledge cutoff.",
    parameters: webSearchParameters,
    async execute(args, context) {
      const maxResults = Math.min(args.max_results ?? 5, 20);
      const { results, engine } = await performSearch(
        args.query,
        maxResults,
        context.signal,
        options.request ?? requestUrl,
      );

      if (results.length === 0) {
        return `No search results found for: "${args.query}". Search engines were unavailable or returned no results.`;
      }

      const lines = [`Web search results for: "${args.query}"`, ""];
      results.forEach((result, index) => {
        lines.push(`${index + 1}. [${result.title}](${result.url})`);
        if (result.snippet) {
          lines.push(`   ${result.snippet}`);
        }
        lines.push("");
      });
      lines.push(`(${results.length} results from ${engine})`);
      return lines.join("\n");
    },
  } satisfies AgentTool<typeof webSearchParameters>;
}

async function performSearch(
  query: string,
  maxResults: number,
  signal: AbortSignal,
  request: WebRequest,
): Promise<Readonly<{ results: readonly SearchResult[]; engine: SearchEngine }>> {
  for (const engine of SEARCH_ENGINES) {
    try {
      const searchRequest = buildSearchRequest(engine, query);
      const { html, statusCode } = await fetchSearchHtml(searchRequest, signal, request);
      if (isRateLimited(statusCode, html)) {
        continue;
      }

      const results = parseSearchResults(engine, html).slice(0, maxResults);
      if (results.length > 0) {
        return { results, engine };
      }
    } catch {
      // Try the next engine.
    }
  }

  return { results: [], engine: "DuckDuckGo" };
}

function buildSearchRequest(engine: SearchEngine, query: string): SearchRequest {
  const encodedQuery = encodeURIComponent(query);
  const headers: Record<string, string> = {
    "User-Agent": SEARCH_USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };

  if (engine === "DuckDuckGo") {
    return {
      url: `https://html.duckduckgo.com/html/?q=${encodedQuery}`,
      headers,
      method: "GET",
    };
  }
  if (engine === "DuckDuckGoLite") {
    return {
      url: "https://lite.duckduckgo.com/lite/",
      headers: {
        ...headers,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
      body: new URLSearchParams({ q: query }).toString(),
    };
  }
  if (engine === "Brave") {
    return {
      url: `https://search.brave.com/search?q=${encodedQuery}&source=web`,
      headers: { ...headers, Accept: "text/html" },
      method: "GET",
    };
  }

  return {
    url: `https://www.google.com/search?q=${encodedQuery}&hl=en`,
    headers,
    method: "GET",
  };
}

async function fetchSearchHtml(
  request: SearchRequest,
  signal: AbortSignal,
  webRequest: WebRequest,
): Promise<Readonly<{ html: string; statusCode: number }>> {
  const response = await requestWithTimeout(
    webRequest,
    {
      url: request.url,
      method: request.method,
      headers: request.headers,
      ...(request.body ? { body: request.body } : {}),
      throw: false,
    },
    signal,
    WEB_SEARCH_TIMEOUT_MS,
  );
  return { html: response.text, statusCode: response.status };
}

export function parseSearchResults(engine: SearchEngine, html: string): SearchResult[] {
  if (engine === "DuckDuckGo" || engine === "DuckDuckGoLite") {
    return parseDuckDuckGoResults(html);
  }
  if (engine === "Brave") {
    return parseBraveResults(html);
  }
  return parseGoogleResults(html);
}

function parseDuckDuckGoResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const resultMatches = Array.from(
    html.matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gsu),
  );
  const snippetMatches = Array.from(
    html.matchAll(/class="[^"]*result__snippet[^"]*"[^>]*>(.*?)<\/(?:a|div|span)>/gsu),
  );

  resultMatches.forEach((match, index) => {
    const rawUrl = match[1];
    const rawTitle = match[2];
    if (!rawUrl || !rawTitle) {
      return;
    }

    const snippet = snippetMatches[index]?.[1] ? cleanHtmlText(snippetMatches[index][1]) : "";
    const result = {
      title: cleanHtmlText(rawTitle),
      url: unwrapDuckDuckGoRedirect(rawUrl),
      snippet,
    };
    if (result.title && result.url) {
      results.push(result);
    }
  });

  return results;
}

function parseBraveResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = Array.from(
    html.matchAll(/<div[^>]*class="snippet[^"]*"[^>]*>(.*?)<\/div>\s*<\/div>/gsu),
  );
  for (const block of blocks) {
    const blockHtml = block[1] ?? "";
    const linkMatch = blockHtml.match(
      /<a[^>]*href="([^"]*)"[^>]*class="[^"]*result-header[^"]*"[^>]*>(.*?)<\/a>/su,
    );
    if (!linkMatch?.[1] || !linkMatch[2]) {
      continue;
    }

    const snippetMatch = blockHtml.match(
      /<p[^>]*class="[^"]*snippet-description[^"]*"[^>]*>(.*?)<\/p>/su,
    );
    results.push({
      title: cleanHtmlText(linkMatch[2]),
      url: linkMatch[1],
      snippet: snippetMatch?.[1] ? cleanHtmlText(snippetMatch[1]) : "",
    });
  }
  return results;
}

function parseGoogleResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const linkMatches = Array.from(html.matchAll(/<a[^>]*href="\/url\?q=([^&"]+)[^"]*"[^>]*>/gu));
  const headingMatches = Array.from(html.matchAll(/<h3[^>]*>(.*?)<\/h3>/gsu));

  linkMatches.forEach((match, index) => {
    const rawUrl = match[1];
    if (!rawUrl) {
      return;
    }

    const url = safeDecodeURIComponent(rawUrl);
    if (!url.startsWith("http")) {
      return;
    }

    results.push({
      title: headingMatches[index]?.[1] ? cleanHtmlText(headingMatches[index][1]) : url,
      url,
      snippet: "",
    });
  });

  return results;
}

function isRateLimited(statusCode: number, html: string): boolean {
  if ([403, 429, 503].includes(statusCode)) {
    return true;
  }
  const lowerHtml = html.toLowerCase();
  return RATE_LIMIT_PATTERNS.some((pattern) => lowerHtml.includes(pattern));
}

function unwrapDuckDuckGoRedirect(rawUrl: string): string {
  if (rawUrl.includes("uddg=")) {
    try {
      const redirectedUrl = new URL(rawUrl, "https://duckduckgo.com").searchParams.get("uddg");
      if (redirectedUrl) {
        return redirectedUrl;
      }
    } catch {
      // Return the original URL below.
    }
  }
  return rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
}

function htmlToText(html: string): string {
  return cleanHtmlText(
    html
      .replace(/<script[\s\S]*?<\/script>/giu, " ")
      .replace(/<style[\s\S]*?<\/style>/giu, " ")
      .replace(/<[^>]+>/gu, " "),
  );
}

function findHeader(headers: Readonly<Record<string, string>>, name: string): string {
  const exactValue = headers[name];
  if (exactValue) {
    return exactValue;
  }

  const lowerName = name.toLowerCase();
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (headerName.toLowerCase() === lowerName) {
      return headerValue;
    }
  }
  return "";
}

function cleanHtmlText(text: string): string {
  return decodeHtmlEntities(text.replace(/<[^>]+>/gu, " "))
    .replace(/\s+/gu, " ")
    .trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&apos;/gu, "'")
    .replace(/&nbsp;/gu, " ")
    .replace(/&#x27;/gu, "'")
    .replace(/&#x2F;/gu, "/");
}

export function isBlockedUrl(urlString: string): boolean {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    return true;
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return true;
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "::1", "0.0.0.0", "metadata.google.internal"].includes(hostname)) {
    return true;
  }
  if (/^10\./u.test(hostname)) {
    return true;
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./u.test(hostname)) {
    return true;
  }
  if (/^192\.168\./u.test(hostname)) {
    return true;
  }
  if (/^169\.254\./u.test(hostname)) {
    return true;
  }
  return hostname.startsWith("[fe80:") || hostname.startsWith("[fd") || hostname.startsWith("[fc");
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function requestWithTimeout(
  request: WebRequest,
  params: RequestUrlParam,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<RequestUrlResponse> {
  if (signal.aborted) {
    throw new Error("Request cancelled.");
  }

  return Promise.race([
    request(params),
    new Promise<never>((_, reject) => {
      const timeoutId = globalThis.setTimeout(
        () => reject(new Error("Request timed out.")),
        timeoutMs,
      );
      signal.addEventListener(
        "abort",
        () => {
          globalThis.clearTimeout(timeoutId);
          reject(new Error("Request cancelled."));
        },
        { once: true },
      );
    }),
  ]);
}
