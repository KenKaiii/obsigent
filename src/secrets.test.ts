import { describe, expect, it } from "vitest";
import {
  getOpenAiCompatibleApiKey,
  storeMcpServerToken,
  storeOpenAiCompatibleApiKey,
} from "./secrets";
import { DEFAULT_SETTINGS } from "./settings";

function createMockApp(): unknown {
  const secrets = new Map<string, string>();
  return {
    secretStorage: {
      getSecret: (id: string) => secrets.get(id) ?? null,
      setSecret: (id: string, secret: string) => {
        secrets.set(id, secret);
      },
    },
  };
}

describe("SecretStorage helpers", () => {
  it("stores and retrieves the OpenAI-compatible API key by configured secret id", () => {
    const app = createMockApp() as never;

    const secretId = storeOpenAiCompatibleApiKey(app, DEFAULT_SETTINGS, "sk-test");

    expect(secretId).toBe(DEFAULT_SETTINGS.openAiCompatibleApiKeySecretId);
    expect(getOpenAiCompatibleApiKey(app, DEFAULT_SETTINGS)).toBe("sk-test");
  });

  it("returns the MCP token secret id after verified storage", () => {
    const app = createMockApp() as never;

    expect(storeMcpServerToken(app, "Local Server", "token")).toBe("obsigent-mcp-local-server");
  });
});
