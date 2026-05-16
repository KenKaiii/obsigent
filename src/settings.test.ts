import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./settings";

describe("DEFAULT_SETTINGS", () => {
  it("starts in approve-writes mode", () => {
    expect(DEFAULT_SETTINGS.safetyMode).toBe("approve-writes");
  });

  it("uses Ollama as the default local provider", () => {
    expect(DEFAULT_SETTINGS.provider).toBe("ollama");
    expect(DEFAULT_SETTINGS.localEndpoint).toMatch(/^http:\/\/localhost:/u);
    expect(DEFAULT_SETTINGS.openAiCompatibleEndpoint).toMatch(/^http:\/\/localhost:/u);
    expect(DEFAULT_SETTINGS.apiKeyStorageMode).toBe("plugin-data");
  });

  it("enables semantic search with a local embedding model", () => {
    expect(DEFAULT_SETTINGS.semanticSearchEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.embeddingModel).toBe("nomic-embed-text");
    expect(DEFAULT_SETTINGS.semanticChunkChars).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.semanticMaxResults).toBeGreaterThan(0);
  });

  it("persists chats but keeps memory explicit", () => {
    expect(DEFAULT_SETTINGS.persistChatHistory).toBe(true);
    expect(DEFAULT_SETTINGS.maxStoredChats).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.memoryEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.memoryNotePath).toBe("Obsigent Memory.md");
  });

  it("keeps MCP disabled until explicitly configured", () => {
    expect(DEFAULT_SETTINGS.mcpServers).toEqual([]);
  });
});
