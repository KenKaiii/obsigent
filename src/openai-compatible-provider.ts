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

const OPENAI_COMPATIBLE_PROVIDER_NAME = "obsigent-openai-compatible";

export function registerOpenAiCompatibleProvider(): void {
  if (providerRegistry.has(OPENAI_COMPATIBLE_PROVIDER_NAME)) {
    return;
  }
  providerRegistry.register(OPENAI_COMPATIBLE_PROVIDER_NAME, {
    stream: (options) => new StreamResult(runOpenAiCompatibleStream(options)),
  });
}

export function getOpenAiCompatibleProviderName(): string {
  return OPENAI_COMPATIBLE_PROVIDER_NAME;
}

type OpenAiMessage = Readonly<{
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: readonly OpenAiToolCall[];
}>;

type OpenAiToolCall = Readonly<{
  id: string;
  type: "function";
  function: Readonly<{
    name: string;
    arguments: string;
  }>;
}>;

type OpenAiChatResponse = Readonly<{
  choices?: readonly Readonly<{
    message?: Readonly<{
      content?: string | null;
      tool_calls?: readonly OpenAiToolCall[];
    }>;
    delta?: Readonly<{
      content?: string | null;
      tool_calls?: readonly Partial<OpenAiToolCall>[];
    }>;
    finish_reason?: string | null;
  }>[];
  usage?: Readonly<{ prompt_tokens?: number; completion_tokens?: number }>;
}>;

async function* runOpenAiCompatibleStream(
  options: StreamOptions,
): AsyncGenerator<StreamEvent, StreamResponse> {
  const baseUrl = options.baseUrl ?? "http://localhost:1234/v1";
  const url = new URL("chat/completions", `${baseUrl.replace(/\/+$/u, "")}/`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: options.model,
      messages: toOpenAiMessages(options.messages),
      stream: options.streaming !== false,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      ...(options.tools?.length ? { tools: toOpenAiTools(options.tools) } : {}),
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok) {
    throw new Error(
      `OpenAI-compatible endpoint returned ${response.status}: ${await response.text()}`,
    );
  }

  if (options.streaming === false) {
    const body = (await response.json()) as OpenAiChatResponse;
    const choice = body.choices?.[0];
    const text = choice?.message?.content ?? "";
    if (text) {
      yield { type: "text_delta", text };
    }
    const toolCalls = toToolCalls(choice?.message?.tool_calls ?? []);
    return toStreamResponse(text, toolCalls, {
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
    });
  }

  if (!response.body) {
    throw new Error("OpenAI-compatible endpoint did not include a stream body.");
  }

  let text = "";
  const toolCalls: ToolCall[] = [];
  for await (const event of parseOpenAiSse(response.body)) {
    const choice = event.choices?.[0];
    const delta = choice?.delta?.content ?? "";
    if (delta) {
      text += delta;
      yield { type: "text_delta", text: delta };
    }
    const newToolCalls = toToolCallsFromPartial(choice?.delta?.tool_calls ?? [], toolCalls.length);
    toolCalls.push(...newToolCalls);
  }
  return toStreamResponse(text, toolCalls, { inputTokens: 0, outputTokens: 0 });
}

export function toOpenAiMessages(messages: readonly Message[]): OpenAiMessage[] {
  return messages.flatMap((message): OpenAiMessage[] => {
    if (message.role === "system") {
      return [{ role: "system", content: message.content }];
    }
    if (message.role === "user") {
      return [{ role: "user", content: contentToText(message.content) }];
    }
    if (message.role === "assistant") {
      const toolCalls = contentToToolCalls(message.content);
      return [
        {
          role: "assistant",
          content: contentToText(message.content) || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
      ];
    }
    return message.content.map((result) => ({
      role: "tool",
      tool_call_id: result.toolCallId,
      content: typeof result.content === "string" ? result.content : JSON.stringify(result.content),
    }));
  });
}

function toOpenAiTools(tools: readonly Tool[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.rawInputSchema ?? { type: "object", properties: {} },
    },
  }));
}

function contentToToolCalls(content: Message["content"]): OpenAiToolCall[] {
  if (typeof content === "string") {
    return [];
  }
  return content
    .filter((part): part is ToolCall => part.type === "tool_call")
    .map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.args),
      },
    }));
}

function toToolCalls(toolCalls: readonly OpenAiToolCall[]): ToolCall[] {
  return toolCalls.map((toolCall) => ({
    type: "tool_call",
    id: toolCall.id,
    name: toolCall.function.name,
    args: parseToolArguments(toolCall.function.arguments),
  }));
}

function toToolCallsFromPartial(
  toolCalls: readonly Partial<OpenAiToolCall>[],
  offset: number,
): ToolCall[] {
  return toolCalls.flatMap((toolCall, index): ToolCall[] => {
    const name = toolCall.function?.name;
    if (!name) {
      return [];
    }
    return [
      {
        type: "tool_call",
        id: toolCall.id ?? `openai-tool-${offset + index}:${name}`,
        name,
        args: parseToolArguments(toolCall.function.arguments ?? "{}"),
      },
    ];
  });
}

async function* parseOpenAiSse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<OpenAiChatResponse> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const event of events) {
        const parsed = parseOpenAiSseEvent(event);
        if (parsed) {
          yield parsed;
        }
      }
    }
    const parsed = parseOpenAiSseEvent(buffer);
    if (parsed) {
      yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseOpenAiSseEvent(event: string): OpenAiChatResponse | null {
  for (const line of event.split("\n")) {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith("data:")) {
      continue;
    }
    const data = trimmedLine.slice("data:".length).trim();
    if (!data || data === "[DONE]") {
      return null;
    }
    return JSON.parse(data) as OpenAiChatResponse;
  }
  return null;
}

function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toStreamResponse(
  text: string,
  toolCalls: readonly ToolCall[],
  usage: StreamResponse["usage"],
): StreamResponse {
  const content: ContentPart[] = [...(text ? [{ type: "text" as const, text }] : []), ...toolCalls];
  const message: AssistantMessage = { role: "assistant", content };
  return {
    message,
    stopReason: toolCalls.length ? "tool_use" : "end_turn",
    usage,
  };
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
