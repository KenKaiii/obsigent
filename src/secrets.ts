import type { App } from "obsidian";
import type { McpServerConfig, ObsigentSettings } from "./settings";

export const OPENAI_API_KEY_SECRET_ID = "obsigent-openai-compatible-api-key";
const MCP_SECRET_PREFIX = "obsigent-mcp-";

type SecretStorageLike = Readonly<{
  getSecret: (id: string) => string | null;
  setSecret: (id: string, secret: string) => void;
}>;

type AppWithOptionalSecrets = App & Readonly<{ secretStorage?: SecretStorageLike }>;

export type SecretStore = Readonly<{
  getSecret: (id: string) => string | null;
  setSecret: (id: string, secret: string) => void;
  isAvailable: boolean;
}>;

export function createSecretStore(app: App): SecretStore {
  const secretStorage = (app as AppWithOptionalSecrets).secretStorage;
  if (!secretStorage) {
    return {
      isAvailable: false,
      getSecret: () => null,
      setSecret: () => undefined,
    };
  }

  return {
    isAvailable: true,
    getSecret: (id) => secretStorage.getSecret(id),
    setSecret: (id, secret) => {
      secretStorage.setSecret(id, secret);
    },
  };
}

export function getMcpTokenSecretId(serverId: string): string {
  return `${MCP_SECRET_PREFIX}${sanitizeSecretId(serverId)}`;
}

export function getOpenAiCompatibleApiKey(
  app: App,
  settings: ObsigentSettings,
): string | undefined {
  return createSecretStore(app).getSecret(settings.openAiCompatibleApiKeySecretId) ?? undefined;
}

export function storeOpenAiCompatibleApiKey(
  app: App,
  settings: ObsigentSettings,
  apiKey: string,
): string {
  const secretId = settings.openAiCompatibleApiKeySecretId || OPENAI_API_KEY_SECRET_ID;
  writeVerifiedSecret(createSecretStore(app), secretId, apiKey.trim());
  return secretId;
}

export function clearOpenAiCompatibleApiKey(app: App, settings: ObsigentSettings): void {
  writeVerifiedSecret(createSecretStore(app), settings.openAiCompatibleApiKeySecretId, "");
}

export function storeMcpServerToken(app: App, serverId: string, token: string): string {
  const secretId = getMcpTokenSecretId(serverId);
  writeVerifiedSecret(createSecretStore(app), secretId, token.trim());
  return secretId;
}

export function clearMcpServerToken(app: App, server: McpServerConfig): void {
  if (server.tokenSecretId) {
    writeVerifiedSecret(createSecretStore(app), server.tokenSecretId, "");
  }
}

export function resolveMcpServersWithSecrets(
  app: App,
  servers: readonly McpServerConfig[],
): readonly McpServerConfig[] {
  const store = createSecretStore(app);
  return servers.map((server) => {
    const secretToken = store.getSecret(server.tokenSecretId ?? getMcpTokenSecretId(server.id));
    if (!secretToken) {
      return server;
    }
    return {
      ...server,
      token: secretToken,
    };
  });
}

export function stripPersistedSecrets(settings: ObsigentSettings): ObsigentSettings {
  return {
    ...settings,
    mcpServers: settings.mcpServers.map((server) => {
      const { token: _token, ...safeServer } = server;
      return safeServer;
    }),
  };
}

function writeVerifiedSecret(store: SecretStore, secretId: string, secret: string): void {
  if (!store.isAvailable) {
    throw new Error("Obsidian SecretStorage is not available.");
  }
  store.setSecret(secretId, secret);
  if (store.getSecret(secretId) !== secret) {
    throw new Error(`Could not verify SecretStorage write for ${secretId}.`);
  }
}

export function sanitizeSecretId(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/gu, "-")
    .replace(/-+/gu, "-");
  return sanitized.replace(/^-|-$/gu, "") || "server";
}
