import { type Editor, Notice, Plugin, TFile, type WorkspaceLeaf } from "obsidian";
import { parseStoredChatSessions, type StoredChatSession } from "./chat";
import { logDebug } from "./debug";
import { openEditProposalModal } from "./edit-modal";
import {
  assertSelectionFresh,
  type EditProposal,
  parseAssistantEditProposal,
} from "./edit-proposals";
import { LocalAgentRuntime } from "./local-agent";
import { registerOllamaProvider } from "./ollama-provider";
import { registerOpenAiCompatibleProvider } from "./openai-compatible-provider";
import { parseSemanticIndexSnapshot, type SemanticIndexSnapshot } from "./semantic-index";
import type { ObsigentSettings } from "./settings";
import { DEFAULT_SETTINGS } from "./settings";
import { OBSIGENT_VIEW_TYPE, ObsigentView } from "./view";

const SEMANTIC_INDEX_UPDATE_DELAY_MS = 15_000;

export default class ObsigentPlugin extends Plugin {
  public readonly localAgent = new LocalAgentRuntime();
  public settings: ObsigentSettings = DEFAULT_SETTINGS;
  private storedChats: readonly StoredChatSession[] = [];
  private semanticIndexSnapshot: SemanticIndexSnapshot | null = null;
  private semanticIndexUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private semanticIndexUpdateController: AbortController | null = null;

  public override async onload(): Promise<void> {
    registerOllamaProvider();
    registerOpenAiCompatibleProvider();
    await this.loadSettings();

    this.registerView(OBSIGENT_VIEW_TYPE, (leaf: WorkspaceLeaf) => new ObsigentView(leaf, this));

    this.addRibbonIcon("bot", "Open Obsigent", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-obsigent",
      name: "Open local vault agent",
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: "rebuild-semantic-index",
      name: "Rebuild semantic vault index",
      callback: () => {
        void this.rebuildSemanticIndex();
      },
    });

    this.addCommand({
      id: "ask-obsigent-about-current-note",
      name: "Ask Obsigent about current note",
      callback: () => {
        void this.openWithPrompt("What should I know about @Current note?");
      },
    });

    this.addCommand({
      id: "ask-obsigent-about-selection",
      name: "Ask Obsigent about selection",
      editorCallback: (editor) => {
        const selection = editor.getSelection().trim();
        if (!selection) {
          new Notice("Select text before asking Obsigent about it.");
          return;
        }
        void this.openWithPrompt("Help me understand @selection");
      },
    });

    this.addCommand({
      id: "add-current-note-to-obsigent-context",
      name: "Add current note to Obsigent context",
      callback: () => {
        void this.openWithPrompt("@Current note ");
      },
    });

    this.addCommand({
      id: "rewrite-selection-with-obsigent",
      name: "Rewrite selection with Obsigent",
      editorCallback: (editor) => {
        void this.proposeSelectionEdit(
          editor,
          "Rewrite this selection clearly while preserving its meaning.",
        );
      },
    });

    this.addCommand({
      id: "summarize-selection-with-obsigent",
      name: "Summarize selection with Obsigent",
      editorCallback: (editor) => {
        void this.proposeSelectionEdit(editor, "Summarize this selection concisely.");
      },
    });

    this.addCommand({
      id: "append-obsigent-response-to-current-note",
      name: "Append Obsigent response to current note",
      editorCallback: (editor) => {
        void this.appendResponseToSelectionContext(editor);
      },
    });

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        this.scheduleSemanticIndexUpdateForFile(file);
      }),
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        this.scheduleSemanticIndexUpdateForFile(file);
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.scheduleSemanticIndexUpdateForFile(file);
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file) => {
        this.scheduleSemanticIndexUpdateForFile(file);
      }),
    );
    this.scheduleSemanticIndexUpdate(1_000);
  }

  public override onunload(): void {
    this.clearSemanticIndexUpdateTimer();
    this.semanticIndexUpdateController?.abort();
    this.localAgent.unloadNow(this.settings);
    this.app.workspace.detachLeavesOfType(OBSIGENT_VIEW_TYPE);
  }

  public async rebuildSemanticIndex(): Promise<void> {
    if (!this.settings.semanticSearchEnabled) {
      new Notice("Semantic search is disabled.");
      return;
    }

    new Notice("Obsigent is rebuilding the semantic index…");
    try {
      const status = await this.localAgent.rebuildSemanticIndex({
        app: this.app,
        settings: this.settings,
        ...(this.semanticIndexSnapshot
          ? { semanticIndexSnapshot: this.semanticIndexSnapshot }
          : {}),
      });
      if (!status) {
        new Notice("Semantic search is disabled.");
        return;
      }
      await this.persistSemanticIndexSnapshot();
      new Notice(`Indexed ${status.noteCount} notes into ${status.chunkCount} chunks.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Could not rebuild semantic index: ${message}`);
    }
  }

  private async proposeSelectionEdit(editor: Editor, instruction: string): Promise<void> {
    const selection = editor.getSelection();
    if (!selection.trim()) {
      new Notice("Select text before asking Obsigent to edit it.");
      return;
    }

    const response = await this.localAgent.prompt(
      `${instruction}\n\nReturn only the replacement text.\n\nSelected text:\n${selection}`,
      {
        app: this.app,
        settings: this.settings,
        runId: "editor-edit",
        onUpdate: () => undefined,
      },
    );
    const proposal = parseAssistantEditProposal(response, selection);
    await this.applySelectionProposal(editor, proposal);
  }

  private async appendResponseToSelectionContext(editor: Editor): Promise<void> {
    const selection = editor.getSelection();
    const prompt = selection.trim()
      ? `Respond to this selected text. Return only text to append.\n\nSelected text:\n${selection}`
      : "Return a brief helpful note to append to the current note.";
    const response = await this.localAgent.prompt(prompt, {
      app: this.app,
      settings: this.settings,
      runId: "editor-append",
      onUpdate: () => undefined,
    });
    const proposal: EditProposal = {
      kind: "append-to-note",
      before: "",
      after: response.trim(),
    };
    if (!proposal.after) {
      new Notice("Obsigent did not return text to append.");
      return;
    }
    const approved = await openEditProposalModal(this.app, proposal);
    if (!approved) {
      new Notice("Obsigent edit rejected.");
      return;
    }
    const lastLine = editor.lastLine();
    const lastLineText = editor.getLine(lastLine);
    const prefix = lastLineText.trim() ? "\n\n" : "";
    editor.replaceRange(`${prefix}${proposal.after}`, { line: lastLine, ch: lastLineText.length });
    new Notice("Obsigent appended text to the current note.");
  }

  private async applySelectionProposal(editor: Editor, proposal: EditProposal): Promise<void> {
    if (!proposal.after) {
      new Notice("Obsigent did not return replacement text.");
      return;
    }
    const approved = await openEditProposalModal(this.app, proposal);
    if (!approved) {
      new Notice("Obsigent edit rejected.");
      return;
    }

    assertSelectionFresh(editor.getSelection(), proposal);
    editor.replaceSelection(proposal.after, "obsigent-edit");
    new Notice("Obsigent applied the selected-text edit.");
  }

  private async openWithPrompt(prompt: string): Promise<void> {
    await this.activateView();
    const obsigentLeaf = this.app.workspace.getLeavesOfType(OBSIGENT_VIEW_TYPE).first();
    const obsigentView = obsigentLeaf?.view;
    if (obsigentView instanceof ObsigentView) {
      obsigentView.setDraftPrompt(prompt);
    }
  }

  private async activateView(): Promise<void> {
    const existingLeaf = this.app.workspace.getLeavesOfType(OBSIGENT_VIEW_TYPE).first();

    if (existingLeaf) {
      this.app.workspace.revealLeaf(existingLeaf);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice("Unable to open Obsigent view.");
      return;
    }

    await leaf.setViewState({ type: OBSIGENT_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as
      | Partial<ObsigentSettings>
      | {
          settings?: Partial<ObsigentSettings>;
          storedChats?: unknown;
          semanticIndexSnapshot?: unknown;
        }
      | null;
    const settingsData = data && "settings" in data ? data.settings : data;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...settingsData,
    };
    this.storedChats =
      data && "storedChats" in data ? parseStoredChatSessions(data.storedChats) : [];
    this.semanticIndexSnapshot =
      data && "semanticIndexSnapshot" in data
        ? parseSemanticIndexSnapshot(data.semanticIndexSnapshot)
        : null;
  }

  public getStoredChats(): readonly StoredChatSession[] {
    return this.storedChats;
  }

  public async saveChatSession(session: StoredChatSession): Promise<void> {
    if (!this.settings.persistChatHistory) {
      return;
    }
    this.storedChats = [
      session,
      ...this.storedChats.filter((chat) => chat.id !== session.id),
    ].slice(0, this.settings.maxStoredChats);
    await this.savePluginData();
  }

  public async deleteStoredChat(sessionId: string): Promise<void> {
    this.storedChats = this.storedChats.filter((chat) => chat.id !== sessionId);
    await this.savePluginData();
  }

  public async saveSettings(nextSettings: ObsigentSettings): Promise<void> {
    const shouldResetSemanticIndex =
      this.settings.embeddingModel !== nextSettings.embeddingModel ||
      this.settings.semanticChunkChars !== nextSettings.semanticChunkChars ||
      this.settings.localEndpoint !== nextSettings.localEndpoint ||
      this.settings.excludedFolders.join("\n") !== nextSettings.excludedFolders.join("\n");
    this.settings = nextSettings;
    if (shouldResetSemanticIndex) {
      this.semanticIndexSnapshot = null;
    }
    await this.savePluginData();
    if (shouldResetSemanticIndex) {
      this.scheduleSemanticIndexUpdate(1_000);
    }
  }

  private scheduleSemanticIndexUpdateForFile(file: unknown): void {
    if (!(file instanceof TFile) || file.extension !== "md") {
      return;
    }
    this.scheduleSemanticIndexUpdate(SEMANTIC_INDEX_UPDATE_DELAY_MS);
  }

  private scheduleSemanticIndexUpdate(delayMs: number): void {
    if (!this.settings.semanticSearchEnabled) {
      return;
    }
    this.clearSemanticIndexUpdateTimer();
    this.semanticIndexUpdateTimer = setTimeout(() => {
      this.semanticIndexUpdateTimer = null;
      void this.updateSemanticIndexInBackground();
    }, delayMs);
  }

  private clearSemanticIndexUpdateTimer(): void {
    if (!this.semanticIndexUpdateTimer) {
      return;
    }
    clearTimeout(this.semanticIndexUpdateTimer);
    this.semanticIndexUpdateTimer = null;
  }

  private async updateSemanticIndexInBackground(): Promise<void> {
    if (!this.settings.semanticSearchEnabled || this.semanticIndexUpdateController) {
      return;
    }

    const abortController = new AbortController();
    this.semanticIndexUpdateController = abortController;
    try {
      const status = await this.localAgent.updateSemanticIndex(
        {
          app: this.app,
          settings: this.settings,
          ...(this.semanticIndexSnapshot
            ? { semanticIndexSnapshot: this.semanticIndexSnapshot }
            : {}),
        },
        abortController.signal,
      );
      if (status) {
        await this.persistSemanticIndexSnapshot();
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        logDebug(
          this.settings.debug,
          "semantic-index-background",
          "semantic_index",
          "update_failed",
          {
            message: error instanceof Error ? error.message : String(error),
          },
        );
      }
    } finally {
      if (this.semanticIndexUpdateController === abortController) {
        this.semanticIndexUpdateController = null;
      }
    }
  }

  private async persistSemanticIndexSnapshot(): Promise<void> {
    this.semanticIndexSnapshot = this.localAgent.getSemanticIndexSnapshot({
      app: this.app,
      settings: this.settings,
      ...(this.semanticIndexSnapshot ? { semanticIndexSnapshot: this.semanticIndexSnapshot } : {}),
    });
    await this.savePluginData();
  }

  private async savePluginData(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      storedChats: this.storedChats,
      semanticIndexSnapshot: this.semanticIndexSnapshot,
    });
  }
}
