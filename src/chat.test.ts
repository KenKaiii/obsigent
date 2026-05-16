import { describe, expect, it } from "vitest";
import { parseStoredChatSessions, serializeChatSession } from "./chat";

describe("chat serialization", () => {
  it("serializes chat sessions with deterministic ids and titles", () => {
    const session = serializeChatSession(
      [
        { id: "user-0", role: "user", text: "Hello vault", createdAt: "2026-05-15T00:00:00.000Z" },
        { id: "assistant-1", role: "assistant", text: "Hi", createdAt: "2026-05-15T00:00:01.000Z" },
      ],
      "2026-05-15T00:00:02.000Z",
    );

    expect(session.id).toMatch(/^chat-/u);
    expect(session.title).toBe("Hello vault");
    expect(session.updatedAt).toBe("2026-05-15T00:00:02.000Z");
  });

  it("drops invalid stored chat entries", () => {
    expect(
      parseStoredChatSessions([
        { id: "ok", title: "Ok", updatedAt: "now", messages: [] },
        { bad: true },
      ]),
    ).toEqual([{ id: "ok", title: "Ok", updatedAt: "now", messages: [] }]);
  });
});
