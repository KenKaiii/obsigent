export type ObsigentProvider = "ollama" | "openai-compatible";
export type EmbeddingProvider = "ollama" | "openai-compatible";
export type ApiKeyStorageMode = "secret-storage";

export type McpTransportType = "streamable-http" | "sse";

export type McpServerConfig = Readonly<{
  id: string;
  name: string;
  endpoint: string;
  enabled: boolean;
  transport: McpTransportType;
  tokenSecretId?: string;
  token?: string;
}>;

export type ToolApprovalStatus = "pending" | "approved" | "denied";

export type ToolApprovalDecision = Readonly<{
  id: string;
  runId: string;
  serverName: string;
  toolName: string;
  argsJson: string;
  status: ToolApprovalStatus;
  createdAt: string;
  decidedAt: string | null;
}>;

export type ObsigentSettings = Readonly<{
  provider: ObsigentProvider;
  localEndpoint: string;
  openAiCompatibleEndpoint: string;
  apiKeyStorageMode: ApiKeyStorageMode;
  model: string;
  visionModel: string;
  embeddingProvider: EmbeddingProvider;
  embeddingModel: string;
  semanticSearchEnabled: boolean;
  semanticChunkChars: number;
  semanticMaxResults: number;
  persistChatHistory: boolean;
  maxStoredChats: number;
  memoryEnabled: boolean;
  memoryNotePath: string;
  openAiCompatibleApiKeySecretId: string;
  mcpServers: readonly McpServerConfig[];
  safetyMode: "read-only" | "approve-writes";
  excludedFolders: readonly string[];
  unloadAfterIdleMinutes: number;
  customSystemPrompt: string;
  promptTemplates: readonly string[];
  projectFolders: readonly string[];
  projectTags: readonly string[];
  debug: boolean;
}>;

export const DEFAULT_SETTINGS: ObsigentSettings = {
  provider: "ollama",
  localEndpoint: "http://localhost:11434",
  openAiCompatibleEndpoint: "http://localhost:1234/v1",
  apiKeyStorageMode: "secret-storage",
  model: "gemma4:e2b",
  visionModel: "gemma4:e2b",
  embeddingProvider: "ollama",
  embeddingModel: "nomic-embed-text",
  semanticSearchEnabled: true,
  semanticChunkChars: 1200,
  semanticMaxResults: 8,
  persistChatHistory: true,
  maxStoredChats: 20,
  memoryEnabled: false,
  memoryNotePath: "Obsigent Memory.md",
  openAiCompatibleApiKeySecretId: "obsigent-openai-compatible-api-key",
  mcpServers: [],
  safetyMode: "approve-writes",
  excludedFolders: [".obsidian", ".git"],
  unloadAfterIdleMinutes: 5,
  customSystemPrompt: "",
  promptTemplates: [],
  projectFolders: [],
  projectTags: [],
  debug: false,
};
