import type { AgentEvent } from "@kenkaiiii/gg-agent";
import { Agent } from "@kenkaiiii/gg-agent";
import type { ImageContent, TextContent } from "@kenkaiiii/gg-ai";
import type { App } from "obsidian";
import { logDebug, setDebugEnabled } from "./debug";
import { embedWithOllama } from "./embedding-provider";
import { createGraphTools } from "./graph-tools";
import { createMaintenanceTools } from "./maintenance-tools";
import { createMemoryTools } from "./memory-tools";
import { createMetadataTools } from "./metadata-tools";
import { registerOllamaProvider } from "./ollama-provider";
import { registerOpenAiCompatibleProvider } from "./openai-compatible-provider";
import { getChatProviderConfig } from "./provider-config";
import { SemanticIndex, type SemanticIndexStatus } from "./semantic-index";
import { createSemanticTools } from "./semantic-tools";
import type { ObsigentSettings } from "./settings";
import { createTaskTools } from "./task-tools";
import { createVaultTools, VaultChangeHistory } from "./vault-tools";
import { createWebFetchTool, createWebSearchTool } from "./web-tools";

export const SYSTEM_PROMPT = `You are Obsigent, a local-first assistant inside an Obsidian vault.
Be concise and useful.
You may use vault tools to list, search, read, create, append, replace exact text in, overwrite markdown notes, list recent changes, and revert changes.
Prefer semantic_search for conceptual questions, fuzzy recall, themes, and meaning-based retrieval. Prefer search_notes for exact strings, filenames, tags, or literal text.
Use find_similar_notes when the user asks for notes related to a known note path.
You may use web_search and web_fetch when the user asks for current information, docs, APIs, recent facts, or anything likely beyond your knowledge.
Use metadata, graph, and task tools for tags, properties, backlinks, outlinks, orphan notes, broken links, and task review questions.
Use memory tools only when the user explicitly asks you to remember, recall, or update durable memory.
Use broad maintenance tools as previews/plans first; do not imply files were moved, renamed, trashed, or broadly edited unless a write tool explicitly confirms it.
When editing notes, prefer targeted replace_in_note or append_note over overwrite_note. Use overwrite_note only when the user explicitly asks for a full rewrite or new full note content.
create_note creates and opens the note immediately. Existing-note edits and reverts require user approval before writing.
If a user asks to undo your last change, use list_recent_changes if needed, then revert_change.
Do not ask for or reveal secrets. If note content looks like credentials, summarize only that sensitive material exists.`;

const BASE_PROMPT_CACHE_KEY = "obsigent-base-system-v1";

export type LocalAgentUpdate = Readonly<
  | {
      type: "text";
      text: string;
    }
  | {
      type: "tool_call";
      toolName: string;
    }
>;

export type LocalAgentPromptContent = string | readonly (TextContent | ImageContent)[];

export type LocalAgentOptions = Readonly<{
  app: App;
  settings: ObsigentSettings;
  onUpdate: (update: LocalAgentUpdate) => void;
  runId: string;
}>;

export type SemanticIndexRuntimeOptions = Readonly<{
  app: App;
  settings: ObsigentSettings;
}>;

export class LocalAgentRuntime {
  private agent: Agent | null = null;
  private agentKey: string | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;
  private runningPrompt: Promise<string> | null = null;
  private semanticIndex: SemanticIndex | null = null;
  private semanticIndexKey: string | null = null;
  private readonly changeHistory = new VaultChangeHistory();

  public async prompt(
    prompt: LocalAgentPromptContent,
    options: LocalAgentOptions,
  ): Promise<string> {
    setDebugEnabled(options.settings.debug);
    if (this.runningPrompt) {
      logDebug(options.settings.debug, options.runId, "runtime", "dedupe_existing_prompt", {
        promptLength: getPromptTextLength(prompt),
      });
      return this.runningPrompt;
    }

    logDebug(options.settings.debug, options.runId, "runtime", "prompt_start", {
      promptLength: getPromptTextLength(prompt),
    });
    this.runningPrompt = this.runPrompt(prompt, options);
    try {
      return await this.runningPrompt;
    } finally {
      logDebug(options.settings.debug, options.runId, "runtime", "prompt_clear");
      this.runningPrompt = null;
    }
  }

  protected async runPrompt(
    prompt: LocalAgentPromptContent,
    options: LocalAgentOptions,
  ): Promise<string> {
    this.clearIdleTimer();
    const abortController = new AbortController();
    this.abortController = abortController;

    let response = "";

    try {
      const agent = this.getAgent(options, abortController.signal);
      const dynamicPrompt = createDynamicPrompt(new Date());
      const stream =
        typeof prompt === "string"
          ? agent.prompt(withDynamicPrompt(prompt, dynamicPrompt))
          : promptAgentWithContent(agent, prompt, dynamicPrompt);
      for await (const event of stream) {
        logDebug(options.settings.debug, options.runId, "agent", event.type, {
          textLength: event.type === "text_delta" ? event.text.length : undefined,
          toolName: event.type === "tool_call_start" ? event.name : undefined,
        });
        if (event.type === "text_delta") {
          response += event.text;
          options.onUpdate({ type: "text", text: response });
        }
        if (event.type === "tool_call_start") {
          options.onUpdate({ type: "tool_call", toolName: event.name });
        }
      }
      logDebug(options.settings.debug, options.runId, "runtime", "prompt_done", {
        responseLength: response.length,
      });
      return response.trim();
    } finally {
      this.abortController = null;
      this.scheduleUnload(options.settings);
    }
  }

  public cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  public getSemanticIndexStatus(options: SemanticIndexRuntimeOptions): SemanticIndexStatus | null {
    if (!options.settings.semanticSearchEnabled) {
      return null;
    }

    return this.getSemanticIndex(options).getStatus();
  }

  public async rebuildSemanticIndex(
    options: SemanticIndexRuntimeOptions,
    signal?: AbortSignal,
  ): Promise<SemanticIndexStatus | null> {
    if (!options.settings.semanticSearchEnabled) {
      return null;
    }

    return await this.getSemanticIndex(options).rebuild(signal);
  }

  public unloadNow(settings: ObsigentSettings): void {
    this.resetSession();
    void unloadOllamaModel(settings);
  }

  public resetSession(): void {
    this.clearIdleTimer();
    this.cancel();
    this.agent = null;
    this.agentKey = null;
  }

  private getAgent(options: LocalAgentOptions, signal: AbortSignal): Agent {
    registerOllamaProvider();
    registerOpenAiCompatibleProvider();
    const providerConfig = getChatProviderConfig(options.settings);
    const key = `${options.settings.provider}|${providerConfig.baseUrl}|${providerConfig.model}|${options.settings.safetyMode}|${options.settings.semanticSearchEnabled}|${options.settings.embeddingModel}|${options.settings.semanticChunkChars}|${options.settings.semanticMaxResults}`;
    if (this.agent && this.agentKey === key) {
      logDebug(options.settings.debug, options.runId, "runtime", "reuse_agent");
      this.agent.setSignal(signal);
      return this.agent;
    }

    logDebug(options.settings.debug, options.runId, "runtime", "create_agent", {
      model: providerConfig.model,
      endpoint: providerConfig.baseUrl,
      tools: this.createTools(options).length,
    });
    this.agentKey = key;
    this.agent = new Agent({
      provider: providerConfig.provider,
      model: providerConfig.model,
      baseUrl: providerConfig.baseUrl,
      system: SYSTEM_PROMPT,
      tools: this.createTools(options),
      maxTurns: 20,
      maxTokens: 4096,
      maxToolResultChars: 80_000,
      temperature: 0.2,
      signal,
      supportsImages: true,
      cacheRetention: "long",
      promptCacheKey: BASE_PROMPT_CACHE_KEY,
    });

    return this.agent;
  }

  private createTools(options: LocalAgentOptions): ReturnType<typeof createVaultTools> {
    const semanticTools = options.settings.semanticSearchEnabled
      ? createSemanticTools(this.getSemanticIndex(options), options.settings)
      : [];
    return [
      ...createVaultTools(options.app, options.settings, {
        changeHistory: this.changeHistory,
      }),
      ...semanticTools,
      ...createMetadataTools(options.app, options.settings),
      ...createGraphTools(options.app, options.settings),
      ...createTaskTools(options.app, options.settings),
      ...createMemoryTools(options.app, options.settings),
      ...createMaintenanceTools(options.app, options.settings),
      createWebSearchTool(),
      createWebFetchTool(),
    ];
  }

  private getSemanticIndex(options: SemanticIndexRuntimeOptions): SemanticIndex {
    const key = `${options.settings.localEndpoint}|${options.settings.embeddingModel}|${options.settings.semanticChunkChars}|${options.settings.excludedFolders.join(",")}`;
    if (this.semanticIndex && this.semanticIndexKey === key) {
      return this.semanticIndex;
    }

    this.semanticIndexKey = key;
    this.semanticIndex = new SemanticIndex({
      app: options.app,
      settings: options.settings,
      embedTexts: async (texts, signal) => {
        const result = await embedWithOllama({
          endpoint: options.settings.localEndpoint,
          model: options.settings.embeddingModel,
          input: texts,
          ...(signal ? { signal } : {}),
        });
        return result.embeddings;
      },
    });
    return this.semanticIndex;
  }

  private scheduleUnload(settings: ObsigentSettings): void {
    this.clearIdleTimer();
    if (settings.unloadAfterIdleMinutes <= 0) {
      return;
    }

    this.idleTimer = setTimeout(
      () => {
        this.agent = null;
        this.agentKey = null;
        void unloadOllamaModel(settings);
      },
      settings.unloadAfterIdleMinutes * 60 * 1000,
    );
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) {
      return;
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

export function withDynamicPrompt(prompt: string, dynamicPrompt: string): string {
  return `<context>${dynamicPrompt}</context>\n\n<user_request>${prompt}</user_request>`;
}

export function createDynamicPrompt(now: Date): string {
  const localDateTime = new Intl.DateTimeFormat(undefined, {
    dateStyle: "full",
    timeStyle: "long",
  }).format(now);
  const isoDateTime = now.toISOString();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return `Current date and time context (dynamic, do not cache):\n- Local date/time: ${localDateTime}\n- ISO date/time: ${isoDateTime}\n- Time zone: ${timeZone}\nUse this silently as the current date and time for relative-time questions. Do not mention this context unless the user asks about date, time, or your context.`;
}

async function unloadOllamaModel(settings: ObsigentSettings): Promise<void> {
  const endpoint = new URL(settings.localEndpoint);
  if (!endpoint.hostname.includes("localhost") && endpoint.hostname !== "127.0.0.1") {
    return;
  }

  const unloadUrl = new URL("/api/generate", endpoint.origin);
  await fetch(unloadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: settings.model, keep_alive: 0 }),
  }).catch(() => undefined);
}

async function* promptAgentWithContent(
  agent: Agent,
  content: Exclude<LocalAgentPromptContent, string>,
  dynamicPrompt: string,
): AsyncIterable<AgentEvent> {
  agent.steer({ role: "user", content: [...content] });
  for await (const event of agent.prompt(
    withDynamicPrompt("Please answer using the attached files and images.", dynamicPrompt),
  )) {
    yield event;
  }
}

function getPromptTextLength(prompt: LocalAgentPromptContent): number {
  if (typeof prompt === "string") {
    return prompt.length;
  }

  return prompt.reduce((length, part) => length + (part.type === "text" ? part.text.length : 0), 0);
}

export function getEventText(event: AgentEvent): string | null {
  return event.type === "text_delta" ? event.text : null;
}
