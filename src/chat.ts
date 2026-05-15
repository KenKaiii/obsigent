export type ChatRole = "assistant" | "user";

export type ChatMessage = Readonly<{
  id: string;
  role: ChatRole;
  text: string;
  createdAt: string;
}>;

export const STARTER_MESSAGES: readonly ChatMessage[] = [];

export function createMessageId(role: ChatRole, index: number): string {
  return `${role}-${index}`;
}
