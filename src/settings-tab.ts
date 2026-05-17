import { Notice, PluginSettingTab, Setting } from "obsidian";
import type ObsigentPlugin from "./main";
import { createSecretStore, storeMcpServerToken, storeOpenAiCompatibleApiKey } from "./secrets";
import type { ObsigentProvider } from "./settings";

const PROVIDER_LABELS: Readonly<Record<ObsigentProvider, string>> = {
  ollama: "Ollama",
  "openai-compatible": "OpenAI-compatible",
};

export class ObsigentSettingTab extends PluginSettingTab {
  public constructor(private readonly plugin: ObsigentPlugin) {
    super(plugin.app, plugin);
  }

  public display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Obsigent" });

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Choose the chat provider Obsigent should use.")
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(PROVIDER_LABELS)) {
          dropdown.addOption(value, label);
        }
        dropdown.setValue(this.plugin.settings.provider);
        dropdown.onChange((value) => {
          void this.updateSettings({ provider: value as ObsigentProvider });
        });
      });

    new Setting(containerEl)
      .setName("Ollama endpoint")
      .setDesc("Used for local chat, model downloads, and Ollama embeddings.")
      .addText((text) => {
        text.setPlaceholder("http://localhost:11434");
        text.setValue(this.plugin.settings.localEndpoint);
        text.onChange((value) => {
          void this.updateSettings({ localEndpoint: value.trim() || "http://localhost:11434" });
        });
      });

    new Setting(containerEl)
      .setName("OpenAI-compatible endpoint")
      .setDesc("Base URL for OpenAI-compatible chat APIs, such as LM Studio or OpenRouter.")
      .addText((text) => {
        text.setPlaceholder("http://localhost:1234/v1");
        text.setValue(this.plugin.settings.openAiCompatibleEndpoint);
        text.onChange((value) => {
          void this.updateSettings({
            openAiCompatibleEndpoint: value.trim() || "http://localhost:1234/v1",
          });
        });
      });

    new Setting(containerEl)
      .setName("OpenAI-compatible API key")
      .setDesc("Stored in Obsidian SecretStorage when available, not in plugin data.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("Paste a key and leave blank to keep the current key");
        text.onChange((value) => {
          const trimmed = value.trim();
          if (!trimmed) {
            return;
          }
          const store = createSecretStore(this.plugin.app);
          if (!store.isAvailable) {
            new Notice("Obsidian SecretStorage is not available in this app version.");
            return;
          }
          try {
            const secretId = storeOpenAiCompatibleApiKey(
              this.plugin.app,
              this.plugin.settings,
              trimmed,
            );
            void this.updateSettings({ openAiCompatibleApiKeySecretId: secretId });
            text.setValue("");
            new Notice("Obsigent API key saved to Obsidian SecretStorage.");
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`Could not save Obsigent API key: ${message}`);
          }
        });
      });

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Chat model name for the selected provider.")
      .addText((text) => {
        text.setPlaceholder("gemma4:e2b");
        text.setValue(this.plugin.settings.model);
        text.onChange((value) => {
          void this.updateSettings({ model: value.trim() || "gemma4:e2b" });
        });
      });

    new Setting(containerEl)
      .setName("Read-only safety mode")
      .setDesc("When enabled, Obsigent can read/search but cannot create or edit notes.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.safetyMode === "read-only");
        toggle.onChange((enabled) => {
          void this.updateSettings({ safetyMode: enabled ? "read-only" : "approve-writes" });
        });
      });

    new Setting(containerEl)
      .setName("Semantic search")
      .setDesc("Build a local semantic index of visible Markdown notes.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.semanticSearchEnabled);
        toggle.onChange((semanticSearchEnabled) => {
          void this.updateSettings({ semanticSearchEnabled });
        });
      });

    new Setting(containerEl)
      .setName("Embedding model")
      .setDesc("Ollama embedding model used for semantic search.")
      .addText((text) => {
        text.setPlaceholder("nomic-embed-text");
        text.setValue(this.plugin.settings.embeddingModel);
        text.onChange((value) => {
          void this.updateSettings({ embeddingModel: value.trim() || "nomic-embed-text" });
        });
      });

    new Setting(containerEl)
      .setName("MCP servers")
      .setDesc(
        "JSON array of MCP servers. Tokens are moved to SecretStorage when available and omitted from plugin data.",
      )
      .addTextArea((text) => {
        text.setPlaceholder(
          '[{"id":"local","name":"Local MCP","endpoint":"http://127.0.0.1:3333/mcp","enabled":true,"transport":"streamable-http"}]',
        );
        text.setValue(JSON.stringify(this.plugin.settings.mcpServers, null, 2));
        text.onChange((value) => {
          const trimmed = value.trim();
          if (!trimmed) {
            void this.updateSettings({ mcpServers: [] });
            return;
          }
          try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (!Array.isArray(parsed)) {
              throw new Error("Expected an array of server objects.");
            }
            const servers = parsed.map((server) => parseMcpServerConfig(server));
            const secretStore = createSecretStore(this.plugin.app);
            const safeServers = servers.map((server) => {
              if (server.token && secretStore.isAvailable) {
                const tokenSecretId = storeMcpServerToken(this.plugin.app, server.id, server.token);
                const { token: _token, ...safeServer } = server;
                return { ...safeServer, tokenSecretId };
              }
              const { token: _token, ...safeServer } = server;
              return safeServer;
            });
            void this.updateSettings({ mcpServers: safeServers });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`Invalid MCP server JSON: ${message}`);
          }
        });
      });

    new Setting(containerEl)
      .setName("Prompt templates")
      .setDesc("Reusable prompts shown above the composer, one per line.")
      .addTextArea((text) => {
        text.setPlaceholder("Summarize this note\nCreate action items from this context");
        text.setValue(this.plugin.settings.promptTemplates.join("\n"));
        text.onChange((value) => {
          void this.updateSettings({
            promptTemplates: value
              .split("\n")
              .map((item) => item.trim())
              .filter(Boolean),
          });
        });
      });

    new Setting(containerEl)
      .setName("Custom system prompt")
      .setDesc("Optional extra instructions appended to Obsigent's built-in safety prompt.")
      .addTextArea((text) => {
        text.setPlaceholder("Prefer concise bullet summaries for research notes.");
        text.setValue(this.plugin.settings.customSystemPrompt);
        text.onChange((customSystemPrompt) => {
          void this.updateSettings({ customSystemPrompt });
        });
      });

    new Setting(containerEl)
      .setName("Project folders")
      .setDesc("Comma-separated folders to include as saved project context hints.")
      .addText((text) => {
        text.setPlaceholder("Projects/Alpha, Areas/Research");
        text.setValue(this.plugin.settings.projectFolders.join(", "));
        text.onChange((value) => {
          void this.updateSettings({
            projectFolders: value
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean),
          });
        });
      });

    new Setting(containerEl)
      .setName("Project tags")
      .setDesc("Comma-separated tags to include as saved project context hints.")
      .addText((text) => {
        text.setPlaceholder("project/alpha, research");
        text.setValue(this.plugin.settings.projectTags.join(", "));
        text.onChange((value) => {
          void this.updateSettings({
            projectTags: value
              .split(",")
              .map((item) => item.trim().replace(/^#/u, ""))
              .filter(Boolean),
          });
        });
      });

    new Setting(containerEl)
      .setName("Mobile setup note")
      .setDesc(
        "Obsigent can load on mobile, but local Ollama usually needs a reachable desktop/server endpoint. Use a remote OpenAI-compatible endpoint or disable heavy local indexing on constrained devices.",
      );

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("Comma-separated vault folders Obsigent should not read or index.")
      .addTextArea((text) => {
        text.setPlaceholder(".obsidian, .git");
        text.setValue(this.plugin.settings.excludedFolders.join(", "));
        text.onChange((value) => {
          void this.updateSettings({
            excludedFolders: value
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean),
          });
        });
      });

    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Write Obsigent debug events to the developer console.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.debug);
        toggle.onChange((debug) => {
          void this.updateSettings({ debug });
        });
      });
  }

  private async updateSettings(patch: Partial<typeof this.plugin.settings>): Promise<void> {
    await this.plugin.saveSettings({
      ...this.plugin.settings,
      ...patch,
    });
  }
}

type EditableMcpServerConfig = Readonly<{
  id: string;
  name: string;
  endpoint: string;
  enabled: boolean;
  transport: "streamable-http" | "sse";
  tokenSecretId?: string;
  token?: string;
}>;

function parseMcpServerConfig(value: unknown): EditableMcpServerConfig {
  if (!isRecord(value)) {
    throw new Error("Each MCP server must be an object.");
  }
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const endpoint = typeof value.endpoint === "string" ? value.endpoint.trim() : "";
  if (!id || !name || !endpoint) {
    throw new Error("Each MCP server needs id, name, and endpoint.");
  }
  const transport = value.transport === "sse" ? "sse" : "streamable-http";
  return {
    id,
    name,
    endpoint,
    enabled: value.enabled === true,
    transport,
    ...(typeof value.tokenSecretId === "string" && value.tokenSecretId.trim()
      ? { tokenSecretId: value.tokenSecretId.trim() }
      : {}),
    ...(typeof value.token === "string" && value.token.trim() ? { token: value.token.trim() } : {}),
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
