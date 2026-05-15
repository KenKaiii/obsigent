import {
  type AssistantMessage,
  type ContentPart,
  type Message,
  providerRegistry,
  type StreamEvent,
  type StreamOptions,
  type StreamResponse,
  StreamResult,
  type Tool,
  type ToolCall,
} from "@kenkaiiii/gg-ai";
import { isDebugEnabled, logDebug } from "./debug";

type OllamaToolCall = Readonly<{
  function?: Readonly<{
    name?: string;
    arguments?: Record<string, unknown>;
  }>;
}>;

type OllamaMessage = Readonly<{
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: readonly string[];
  tool_name?: string;
  tool_calls?: readonly OllamaToolCall[];
}>;

type OllamaStreamChunk = Readonly<{
  message?: Readonly<{
    content?: string;
    tool_calls?: readonly OllamaToolCall[];
  }>;
  done?: boolean;
}>;

const OLLAMA_PROVIDER_NAME = "obsigent-ollama";

export function registerOllamaProvider(): void {
  if (providerRegistry.has(OLLAMA_PROVIDER_NAME)) {
    return;
  }

  providerRegistry.register(OLLAMA_PROVIDER_NAME, {
    stream: (options) => new StreamResult(runOllamaStream(options)),
  });
}

export function getOllamaProviderName(): string {
  return OLLAMA_PROVIDER_NAME;
}

async function* runOllamaStream(
  options: StreamOptions,
): AsyncGenerator<StreamEvent, StreamResponse> {
  const endpoint = new URL(options.baseUrl ?? "http://localhost:11434");
  const url = new URL("/api/chat", endpoint.origin);
  const requestBody = {
    model: options.model,
    messages: toOllamaMessages(options.messages),
    stream: options.streaming !== false,
    keep_alive: "5m",
    ...(options.tools?.length ? { tools: toOllamaTools(options.tools) } : {}),
    options: {
      temperature: options.temperature,
      num_predict: options.maxTokens,
    },
  };
  const runId = options.promptCacheKey ?? "no-run-id";
  logDebug(isDebugEnabled(), runId, "ollama", "request_start", {
    url: url.toString(),
    messageCount: requestBody.messages.length,
    roles: requestBody.messages.map((message) => message.role).join(","),
    toolCount: requestBody.tools?.length ?? 0,
    stream: requestBody.stream,
  });
  const requestInit: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
    ...(options.signal ? { signal: options.signal } : {}),
  };

  const startedAt = performance.now();
  const response = await fetch(url, requestInit);
  logDebug(isDebugEnabled(), runId, "ollama", "response_headers", {
    ok: response.ok,
    status: response.status,
    elapsedMs: Math.round(performance.now() - startedAt),
  });

  if (!response.ok) {
    throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
  }

  if (options.streaming === false) {
    const chunk = (await response.json()) as OllamaStreamChunk;
    const text = chunk.message?.content ?? "";
    if (text) {
      yield { type: "text_delta", text };
    }
    const toolCalls = toToolCalls(chunk.message?.tool_calls ?? []);
    logDebug(isDebugEnabled(), runId, "ollama", "response_done", {
      textLength: text.length,
      toolCallCount: toolCalls.length,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    return toStreamResponse(text, toolCalls);
  }

  if (!response.body) {
    throw new Error("Ollama response did not include a stream body.");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const toolCalls: ToolCall[] = [];

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) {
          continue;
        }

        const chunk = JSON.parse(trimmedLine) as OllamaStreamChunk;
        const delta = chunk.message?.content ?? "";
        if (delta) {
          text += delta;
          yield { type: "text_delta", text: delta };
        }
        const newToolCalls = toToolCalls(chunk.message?.tool_calls ?? [], toolCalls.length);
        if (newToolCalls.length > 0) {
          logDebug(isDebugEnabled(), runId, "ollama", "tool_calls", {
            count: newToolCalls.length,
            names: newToolCalls.map((toolCall) => toolCall.name).join(","),
          });
        }
        toolCalls.push(...newToolCalls);
      }
    }
  } finally {
    reader.releaseLock();
  }

  logDebug(isDebugEnabled(), runId, "ollama", "response_done", {
    textLength: text.length,
    toolCallCount: toolCalls.length,
    elapsedMs: Math.round(performance.now() - startedAt),
  });
  return toStreamResponse(text, toolCalls);
}

function toStreamResponse(text: string, toolCalls: readonly ToolCall[] = []): StreamResponse {
  const content: ContentPart[] = [...(text ? [{ type: "text" as const, text }] : []), ...toolCalls];
  const message: AssistantMessage = {
    role: "assistant",
    content,
  };

  return {
    message,
    stopReason: toolCalls.length ? "tool_use" : "end_turn",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
    },
  };
}

export function toOllamaMessages(messages: Message[]): OllamaMessage[] {
  return messages.flatMap((message): OllamaMessage[] => {
    if (message.role === "system") {
      return [{ role: "system", content: message.content }];
    }

    if (message.role === "user") {
      return [toOllamaUserMessage(message.content)];
    }

    if (message.role === "assistant") {
      return [toOllamaAssistantMessage(message.content)];
    }

    return message.content.map((result) => ({
      role: "tool",
      tool_name: result.toolCallId.replace(/^ollama-tool-\d+:/u, ""),
      content: typeof result.content === "string" ? result.content : JSON.stringify(result.content),
    }));
  });
}

function toOllamaUserMessage(content: Message["content"]): OllamaMessage {
  if (typeof content === "string") {
    return { role: "user", content };
  }

  const images = content.flatMap((part): string[] => (part.type === "image" ? [part.data] : []));
  return {
    role: "user",
    content: contentToText(content),
    ...(images.length ? { images } : {}),
  };
}

function toOllamaAssistantMessage(content: Message["content"]): OllamaMessage {
  if (typeof content === "string") {
    return { role: "assistant", content };
  }

  const toolCalls = content
    .filter((part): part is ToolCall => part.type === "tool_call")
    .map((toolCall) => ({
      function: {
        name: toolCall.name,
        arguments: toolCall.args,
      },
    }));

  return {
    role: "assistant",
    content: contentToText(content),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
}

function toOllamaTools(tools: readonly Tool[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.rawInputSchema ?? zodToBasicJsonSchema(tool.parameters),
    },
  }));
}

function toToolCalls(toolCalls: readonly OllamaToolCall[], offset = 0): ToolCall[] {
  return toolCalls.flatMap((toolCall, index): ToolCall[] => {
    const name = toolCall.function?.name;
    if (!name) {
      return [];
    }

    return [
      {
        type: "tool_call",
        id: `ollama-tool-${offset + index}:${name}`,
        name,
        args: toolCall.function?.arguments ?? {},
      },
    ];
  });
}

function zodToBasicJsonSchema(parameters: Tool["parameters"]): Record<string, unknown> {
  const maybeZod = parameters as { def?: unknown; _def?: unknown };
  const shape = getZodShape(maybeZod);
  if (!shape) {
    return { type: "object", properties: {} };
  }

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    properties[key] = zodFieldToJsonSchema(value);
    if (!isOptionalZodField(value)) {
      required.push(key);
    }
  }

  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
  };
}

function getZodShape(schema: { def?: unknown; _def?: unknown }): Record<string, unknown> | null {
  const definition = (schema.def ?? schema._def) as { shape?: unknown } | undefined;
  const shape = typeof definition?.shape === "function" ? definition.shape() : definition?.shape;
  return shape && typeof shape === "object" ? (shape as Record<string, unknown>) : null;
}

function zodFieldToJsonSchema(field: unknown): Record<string, unknown> {
  const definition = ((field as { def?: unknown; _def?: unknown }).def ??
    (field as { def?: unknown; _def?: unknown })._def) as
    | { type?: string; description?: string; innerType?: unknown }
    | undefined;
  const type = definition?.type;
  const base = definition?.description ? { description: definition.description } : {};

  if (type === "optional") {
    return {
      ...zodFieldToJsonSchema(definition?.innerType),
      ...base,
    };
  }
  if (type === "number") {
    return { ...base, type: "number" };
  }
  if (type === "boolean") {
    return { ...base, type: "boolean" };
  }
  return { ...base, type: "string" };
}

function isOptionalZodField(field: unknown): boolean {
  const definition = ((field as { def?: unknown; _def?: unknown }).def ??
    (field as { def?: unknown; _def?: unknown })._def) as { type?: string } | undefined;
  return definition?.type === "optional";
}

function contentToText(content: Message["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .flatMap((part): string[] => {
      if (part.type === "text") {
        return [part.text];
      }
      if (part.type === "image") {
        return [`[Image attachment: ${part.mediaType}]`];
      }
      return [];
    })
    .join("\n");
}
