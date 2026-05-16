export type ChatRole = "assistant" | "user";

export type ChatMessageMetadata = Readonly<Record<string, string | number | boolean>>;

export type ChatMessage = Readonly<{
  id: string;
  role: ChatRole;
  text: string;
  createdAt: string;
  metadata?: ChatMessageMetadata;
}>;

export type StoredChatSession = Readonly<{
  id: string;
  title: string;
  messages: readonly ChatMessage[];
  updatedAt: string;
}>;

export const STARTER_MESSAGES: readonly ChatMessage[] = [];

export function createMessageId(role: ChatRole, index: number): string {
  return `${role}-${index}`;
}

export function createChatSessionId(messages: readonly ChatMessage[]): string {
  const source = messages
    .map((message) => `${message.role}:${message.createdAt}:${message.text}`)
    .join("\n");
  return `chat-${hashString(source).toString(36)}`;
}

export function serializeChatSession(
  messages: readonly ChatMessage[],
  now: string,
): StoredChatSession {
  return {
    id: createChatSessionId(messages),
    title: createChatTitle(messages),
    messages: messages.map((message) => ({ ...message })),
    updatedAt: now,
  };
}

export function parseStoredChatSessions(value: unknown): readonly StoredChatSession[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item): StoredChatSession[] => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const candidate = item as Partial<StoredChatSession>;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.title !== "string" ||
      typeof candidate.updatedAt !== "string" ||
      !Array.isArray(candidate.messages)
    ) {
      return [];
    }

    return [
      {
        id: candidate.id,
        title: candidate.title,
        updatedAt: candidate.updatedAt,
        messages: candidate.messages.flatMap(parseChatMessage),
      },
    ];
  });
}

function parseChatMessage(value: unknown): ChatMessage[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const candidate = value as Partial<ChatMessage>;
  if (
    typeof candidate.id !== "string" ||
    (candidate.role !== "assistant" && candidate.role !== "user") ||
    typeof candidate.text !== "string" ||
    typeof candidate.createdAt !== "string"
  ) {
    return [];
  }
  return [
    {
      id: candidate.id,
      role: candidate.role,
      text: candidate.text,
      createdAt: candidate.createdAt,
      ...(candidate.metadata ? { metadata: candidate.metadata } : {}),
    },
  ];
}

function createChatTitle(messages: readonly ChatMessage[]): string {
  const firstUserMessage = messages.find(
    (message) => message.role === "user" && message.text.trim(),
  );
  const title = firstUserMessage?.text.replace(/\s+/gu, " ").trim() ?? "Untitled chat";
  return title.length <= 60 ? title : `${title.slice(0, 57)}…`;
}

function hashString(value: string): number {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return hash >>> 0;
}
