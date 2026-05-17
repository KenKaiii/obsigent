import type { ImageContent, Message, TextContent } from "@kenkaiiii/gg-ai";
import {
  Component,
  ItemView,
  MarkdownRenderer,
  Notice,
  normalizePath,
  parseLinktext,
  setIcon,
  TFile,
  type WorkspaceLeaf,
} from "obsidian";
import {
  ACCEPTED_ATTACHMENT_EXTENSIONS,
  ATTACHMENT_ACCEPT,
  isSupportedAttachment,
  type ProcessedAttachment,
  processAttachment,
} from "./attachments";
import { type ChatMessage, createMessageId, STARTER_MESSAGES, serializeChatSession } from "./chat";
import { resolvePromptContext } from "./context-resolver";
import { createRunId, logDebug } from "./debug";
import type ObsigentPlugin from "./main";
import {
  applyMentionSuggestion,
  getMentionQuery,
  getMentionSuggestions,
  getResolvedMentionRanges,
  type MentionQuery,
  type MentionSuggestion,
} from "./mention-suggestions";
import {
  getEmbeddingModel,
  getVisionModel,
  isVisionCatalogModel,
  listLocalModels,
  type PullProgress,
  pullModel,
  VISION_MODELS,
} from "./model-manager";
import { shouldOfferEmbeddingModelDownload } from "./semantic-index-status";
export const OBSIGENT_VIEW_TYPE = "obsigent-agent-view";

const THINKING_STATUS_LABELS: readonly string[] = [
  "Thinking tiny thoughts…",
  "Gathering little brain sparks…",
  "Letting ideas simmer softly…",
  "Connecting vault constellations…",
  "Warming up the neurons…",
  "Hatching a helpful answer…",
  "Sorting thoughts into stacks…",
  "Consulting the note sprites…",
  "Tuning the tiny antenna…",
  "Brewing something useful…",
];

const STOPPING_STATUS_LABELS: readonly string[] = [
  "Stopping the little engine…",
  "Tucking the gears away…",
  "Closing the thought loop…",
  "Putting sparks to bed…",
  "Pausing the helper goblin…",
];

const UNKNOWN_TOOL_STATUS_LABELS: readonly string[] = [
  "Consulting the vault goblin 🧌",
  "Checking a secret drawer 🗄️",
  "Asking the note sprites ✨",
  "Opening a tiny toolkit 🧰",
  "Following a hunch trail 🧭",
];

const MAX_AGENT_PRIOR_MESSAGES = 24;
const MAX_AGENT_PRIOR_CHARS = 32_000;

const IMAGE_FILE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "heic",
  "heif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "tif",
  "tiff",
  "webp",
]);

const TOOL_STATUS_LABELS: Readonly<Record<string, readonly string[]>> = {
  append_note: [
    "Tucking words into place ✍️",
    "Adding a cozy note tail 🧵",
    "Dropping in fresh lines 🌱",
    "Nestling text at the end 🪺",
    "Stitching on a note patch 🧷",
    "Extending the little scroll 📜",
  ],
  create_note: [
    "Summoning a fresh note ✨",
    "Planting a brand-new note 🌱",
    "Opening a blank doorway 🚪",
    "Making a cozy page 🕯️",
    "Spawning a little note 🐣",
    "Sketching a new home 🏡",
  ],
  list_notes: [
    "Wandering the note garden 🌿",
    "Counting stars in the vault ✨",
    "Browsing the shelf labels 🏷️",
    "Mapping nearby note trails 🗺️",
    "Peeking down folder paths 👀",
    "Gathering note name confetti 🎊",
  ],
  list_recent_changes: [
    "Reading my tiny trail 🧾",
    "Checking the breadcrumb jar 🍞",
    "Reviewing recent note footprints 🐾",
    "Dusting off change cards 🗂️",
    "Scanning the edit diary 📔",
    "Finding my last scribbles ✏️",
  ],
  overwrite_note: [
    "Giving this note a glow-up 🪄",
    "Polishing the whole page ✨",
    "Repainting the note canvas 🎨",
    "Refreshing every little line 🫧",
    "Rebuilding the note nest 🪺",
    "Swapping in a fresh draft 🍃",
  ],
  read_note: [
    "Peeking inside a note 👀",
    "Unfolding a little page 📖",
    "Reading with tiny glasses 🤓",
    "Opening the note curtains 🎭",
    "Checking what lives inside 🏡",
    "Listening to note whispers 👂",
  ],
  replace_in_note: [
    "Doing tiny text surgery ✂️",
    "Swapping one note pebble 🪨",
    "Tweezing words into place 🪄",
    "Patching a precise sentence 🧵",
    "Snipping and stitching text 🪡",
    "Polishing one little corner ✨",
  ],
  revert_change: [
    "Rolling that change back 🧶",
    "Walking the edit backward 👣",
    "Undoing the little oopsie 🧽",
    "Rewinding the note tape 📼",
    "Restoring the cozy version 🏡",
    "Putting things back gently 🧺",
  ],
  search_notes: [
    "Sniffing through the vault 🐾",
    "Following a keyword trail 🧭",
    "Looking under note rocks 🪨",
    "Sending out search fireflies ✨",
    "Rummaging through page pockets 🧥",
    "Chasing matching little words 🏃",
  ],
  semantic_search: [
    "Following meaning fireflies ✨",
    "Asking the vector sprites 🧚",
    "Searching by vibes and themes 🧭",
    "Listening for similar ideas 👂",
    "Comparing note constellations 🌌",
    "Finding conceptual cousins 🧬",
  ],
  find_similar_notes: [
    "Finding note neighbors 🏘️",
    "Tracing related thought trails 🧵",
    "Looking for sibling pages 📚",
    "Matching kindred note spirits ✨",
    "Mapping nearby ideas 🗺️",
    "Gathering related context 🌿",
  ],
  web_fetch: [
    "Reading a web page 🌐",
    "Opening the browser periscope 🔎",
    "Skimming fresh page text 📄",
    "Fetching outside notes 🧺",
    "Checking that link trail 🧭",
    "Pulling web words closer 🪝",
  ],
  web_search: [
    "Searching the wider web 🌐",
    "Casting query nets 🕸️",
    "Asking the search ducks 🦆",
    "Looking beyond the vault 🔭",
    "Gathering fresh web clues 🧩",
    "Sorting search results 🗂️",
  ],
};

function getStatusLabel(labels: readonly string[], index: number): string {
  if (labels.length === 0) {
    return "";
  }

  return labels.at(index % labels.length) ?? labels.at(0) ?? "";
}

function getToolStatusLabels(toolName: string): readonly string[] {
  return TOOL_STATUS_LABELS[toolName] ?? UNKNOWN_TOOL_STATUS_LABELS;
}

function formatSemanticIndexStatus(
  status: ReturnType<ObsigentPlugin["localAgent"]["getSemanticIndexStatus"]>,
): string {
  if (!status || status.chunkCount === 0) {
    return "Semantic index ready to build";
  }

  return `Indexed ${status.noteCount} notes · ${status.chunkCount} chunks`;
}

function truncateForPriorMessage(text: string, remainingChars: number): string {
  if (text.length <= remainingChars) {
    return text;
  }
  const suffix = "\n\n[Earlier message truncated]";
  return `${text.slice(0, Math.max(0, remainingChars - suffix.length))}${suffix}`;
}

function renderTextWithResolvedMentions(
  parent: Node,
  value: string,
  ranges: readonly ReturnType<typeof getResolvedMentionRanges>[number][],
): void {
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      parent.appendChild(document.createTextNode(value.slice(cursor, range.start)));
    }
    const mentionEl = document.createElement("span");
    mentionEl.className = `obsigent-resolved-mention obsigent-resolved-mention-${range.kind}`;
    mentionEl.textContent = range.text;
    parent.appendChild(mentionEl);
    cursor = range.end;
  }
  if (cursor < value.length) {
    parent.appendChild(document.createTextNode(value.slice(cursor)));
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export class ObsigentView extends ItemView {
  private readonly plugin: ObsigentPlugin;
  private messages: ChatMessage[] = [...STARTER_MESSAGES];
  private attachments: readonly ProcessedAttachment[] = [];
  private isProcessingAttachments = false;
  private draftPrompt = "";
  private readonly messageMarkdownComponents = new Map<string, Component>();
  private installedModelNames = new Set<string>();
  private modelMenuOpen = false;
  private closeModelMenuListener: ((event: PointerEvent) => void) | null = null;
  private modelLoadError: string | null = null;
  private modelDownloadProgress: PullProgress | null = null;
  private modelDownloadController: AbortController | null = null;
  private semanticIndexStatusText: string | null = null;
  private isRebuildingSemanticIndex = false;
  private mentionQuery: MentionQuery | null = null;
  private mentionSuggestions: readonly MentionSuggestion[] = [];
  private activeMentionSuggestionIndex = 0;
  private messageIdToAnchor: string | null = null;
  private userScrolledDuringResponse = false;
  private activeAssistantMessageId: string | null = null;
  private activeStatusIndex = 0;
  private activeToolName: string | null = null;
  private isSubmitting = false;
  private isStopping = false;

  public constructor(leaf: WorkspaceLeaf, plugin: ObsigentPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  public getViewType(): string {
    return OBSIGENT_VIEW_TYPE;
  }

  public getDisplayText(): string {
    return "Obsigent";
  }

  public setDraftPrompt(prompt: string): void {
    this.draftPrompt = prompt;
    this.render();
  }

  public async onOpen(): Promise<void> {
    this.render();
    void this.refreshInstalledModels();
  }

  public async onClose(): Promise<void> {
    this.modelDownloadController?.abort();
    this.modelDownloadController = null;
    this.clearModelMenuClickAwayListener();
    this.containerEl.empty();
  }

  private render(): void {
    const root = this.containerEl.children[1];
    const shouldPreserveMessageScroll =
      this.userScrolledDuringResponse || this.messageIdToAnchor === null;
    const messageScrollTop = shouldPreserveMessageScroll
      ? this.getCurrentMessageScrollTop(root)
      : null;
    this.clearModelMenuClickAwayListener();
    this.clearRenderedMessageMarkdown();
    root.empty();
    root.addClass("obsigent-view");

    this.renderMessages(root, messageScrollTop);
    this.renderComposer(root);
  }

  private clearModelMenuClickAwayListener(): void {
    if (!this.closeModelMenuListener) {
      return;
    }

    document.removeEventListener("pointerdown", this.closeModelMenuListener);
    this.closeModelMenuListener = null;
  }

  private renderMessages(root: Element, messageScrollTop: number | null): void {
    const messagesEl = root.createDiv({ cls: "obsigent-messages" });
    this.registerMessageScrollTracking(messagesEl);

    for (const message of this.messages) {
      this.renderMessage(messagesEl, message);
    }

    const spacerEl = messagesEl.createDiv({ cls: "obsigent-scroll-spacer" });
    if (messageScrollTop === null) {
      this.scrollAnchoredMessageToTop(messagesEl, spacerEl);
    } else {
      this.restoreMessageScrollTop(messagesEl, messageScrollTop);
    }
  }

  private renderMessage(parent: Element, message: ChatMessage): void {
    const messageEl = parent.createDiv({
      cls: `obsigent-message obsigent-message-${message.role}`,
      attr: {
        "data-message-id": message.id,
      },
    });
    const bubbleEl = messageEl.createDiv({ cls: "obsigent-message-bubble" });
    this.renderMessageMarkdown(message.id, message.text, bubbleEl);

    if (this.shouldShowAssistantStatus(message)) {
      this.renderAssistantStatus(messageEl);
    }
  }

  private shouldShowAssistantStatus(message: ChatMessage): boolean {
    return this.isSubmitting && message.id === this.activeAssistantMessageId;
  }

  private renderAssistantStatus(parent: Element): void {
    const statusEl = parent.createDiv({ cls: "obsigent-assistant-status" });
    statusEl.setAttribute("aria-live", "polite");
    this.renderAssistantStatusContent(statusEl);
  }

  private renderAssistantStatusContent(statusEl: Element): void {
    statusEl.empty();

    if (this.isStopping) {
      statusEl.createSpan({ cls: "obsigent-status-stop-icon", text: "■" });
      statusEl.createSpan({
        cls: "obsigent-status-text",
        text: getStatusLabel(STOPPING_STATUS_LABELS, this.activeStatusIndex),
      });
      return;
    }

    const dotsEl = statusEl.createSpan({ cls: "obsigent-status-dots" });
    dotsEl.createSpan({ text: "•" });
    dotsEl.createSpan({ text: "•" });
    dotsEl.createSpan({ text: "•" });
    const labels = this.activeToolName
      ? getToolStatusLabels(this.activeToolName)
      : THINKING_STATUS_LABELS;
    statusEl.createSpan({
      cls: "obsigent-status-text",
      text: getStatusLabel(labels, this.activeStatusIndex),
    });
  }

  private renderComposer(root: Element): void {
    const composer = root.createDiv({ cls: "obsigent-composer" });

    this.renderAttachments(composer);
    this.renderSemanticIndexBar(composer);

    const inputWrap = composer.createDiv({ cls: "obsigent-input-wrap" });
    const inputLayer = inputWrap.createDiv({ cls: "obsigent-input-layer" });
    this.renderDraftHighlight(inputLayer);
    const input = inputLayer.createEl("textarea", {
      cls: "obsigent-input",
      attr: {
        placeholder: "Ask about your vault…",
        rows: "3",
        spellcheck: "true",
      },
    });
    input.value = this.draftPrompt;
    input.disabled = this.isSubmitting || this.isProcessingAttachments;
    this.updateMentionSuggestions(input);
    this.renderMentionSuggestions(inputWrap, input);

    const controlsRow = inputWrap.createDiv({ cls: "obsigent-input-controls" });
    const resetButton = controlsRow.createEl("button", {
      cls: "obsigent-reset-button",
      attr: {
        "aria-label": "Reset chat session",
        type: "button",
      },
    });
    resetButton.disabled = this.isProcessingAttachments;
    setIcon(resetButton, "refresh-ccw");

    const actions = controlsRow.createDiv({ cls: "obsigent-input-actions" });
    this.renderModelPicker(actions);

    const fileInput = actions.createEl("input", {
      cls: "obsigent-file-input",
      attr: {
        accept: ATTACHMENT_ACCEPT,
        multiple: "true",
        type: "file",
      },
    });
    fileInput.disabled = this.isSubmitting || this.isProcessingAttachments;

    const attachButton = actions.createEl("button", {
      cls: "obsigent-attach-button",
      attr: {
        "aria-label": "Attach files",
        type: "button",
      },
    });
    attachButton.disabled = this.isSubmitting || this.isProcessingAttachments;
    setIcon(attachButton, "paperclip");

    const sendButton = actions.createEl("button", {
      cls: "obsigent-send-button",
      attr: {
        "aria-label": this.isSubmitting ? "Stop response" : "Send message",
        type: "button",
      },
    });
    const updateSendButtonState = () => {
      const canSend = input.value.trim().length > 0 || this.attachments.length > 0;
      sendButton.disabled =
        this.isProcessingAttachments || this.isStopping || (!this.isSubmitting && !canSend);
      sendButton.toggleClass("obsigent-send-button-active", !this.isSubmitting && canSend);
      sendButton.toggleClass("obsigent-send-button-idle", !this.isSubmitting && !canSend);
      sendButton.toggleClass("obsigent-stop-button", this.isSubmitting);
    };
    setIcon(sendButton, this.isSubmitting ? "square" : "arrow-up");
    updateSendButtonState();

    this.registerDomEvent(input, "input", () => {
      this.draftPrompt = input.value;
      this.updateMentionSuggestions(input);
      this.renderComposerOnly();
      updateSendButtonState();
    });

    this.registerDomEvent(input, "keydown", (event: KeyboardEvent) => {
      if (this.handleMentionSuggestionKeydown(event, input)) {
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.repeat) {
        event.preventDefault();
        if (!this.isSubmitting) {
          void this.submitPrompt(input.value);
        }
      }
    });

    this.registerDomEvent(resetButton, "click", () => {
      this.resetSession();
    });

    this.registerDomEvent(attachButton, "click", () => {
      fileInput.click();
    });

    this.registerDomEvent(fileInput, "change", () => {
      void this.addAttachments(Array.from(fileInput.files ?? []));
      fileInput.value = "";
    });

    this.registerDomEvent(sendButton, "click", () => {
      if (this.isSubmitting) {
        this.stopPrompt();
        return;
      }
      void this.submitPrompt(input.value);
    });

    this.focusComposer(input);
  }

  private renderDraftHighlight(parent: HTMLElement): void {
    const highlightEl = parent.createDiv({
      cls: "obsigent-input-highlight",
      attr: { "aria-hidden": "true" },
    });
    renderTextWithResolvedMentions(
      highlightEl,
      this.draftPrompt,
      getResolvedMentionRanges(this.draftPrompt, this.app, this.plugin.settings),
    );
    if (!this.draftPrompt) {
      highlightEl.createSpan({ text: "\u200b" });
    }
  }

  private updateMentionSuggestions(input: HTMLTextAreaElement): void {
    const query = getMentionQuery(input.value, input.selectionStart ?? input.value.length);
    this.mentionQuery = query;
    this.mentionSuggestions = query
      ? getMentionSuggestions(this.app, this.plugin.settings, query.query)
      : [];
    this.activeMentionSuggestionIndex = Math.min(
      this.activeMentionSuggestionIndex,
      Math.max(0, this.mentionSuggestions.length - 1),
    );
  }

  private renderMentionSuggestions(parent: HTMLElement, input: HTMLTextAreaElement): void {
    if (!this.mentionQuery || this.mentionSuggestions.length === 0 || input.disabled) {
      return;
    }

    const menu = parent.createDiv({ cls: "obsigent-mention-menu" });
    for (const [index, suggestion] of this.mentionSuggestions.entries()) {
      const option = menu.createEl("button", {
        cls: `obsigent-mention-option${index === this.activeMentionSuggestionIndex ? " obsigent-mention-option-active" : ""}`,
        attr: { type: "button" },
      });
      option.createSpan({ cls: "obsigent-mention-label", text: suggestion.label });
      option.createSpan({ cls: "obsigent-mention-detail", text: suggestion.detail });
      this.registerDomEvent(option, "mousedown", (event) => {
        event.preventDefault();
        this.applyMentionSuggestion(input, suggestion);
      });
    }
  }

  private handleMentionSuggestionKeydown(
    event: KeyboardEvent,
    input: HTMLTextAreaElement,
  ): boolean {
    if (!this.mentionQuery || this.mentionSuggestions.length === 0) {
      return false;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.activeMentionSuggestionIndex =
        (this.activeMentionSuggestionIndex + 1) % this.mentionSuggestions.length;
      this.renderComposerOnly();
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      this.activeMentionSuggestionIndex =
        (this.activeMentionSuggestionIndex - 1 + this.mentionSuggestions.length) %
        this.mentionSuggestions.length;
      this.renderComposerOnly();
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      const suggestion = this.mentionSuggestions[this.activeMentionSuggestionIndex];
      if (suggestion) {
        this.applyMentionSuggestion(input, suggestion);
      }
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.mentionQuery = null;
      this.mentionSuggestions = [];
      this.renderComposerOnly();
      return true;
    }
    return false;
  }

  private applyMentionSuggestion(input: HTMLTextAreaElement, suggestion: MentionSuggestion): void {
    if (!this.mentionQuery) {
      return;
    }
    const nextValue = applyMentionSuggestion(input.value, this.mentionQuery, suggestion);
    this.draftPrompt = nextValue;
    this.mentionQuery = null;
    this.mentionSuggestions = [];
    this.activeMentionSuggestionIndex = 0;
    this.renderComposerOnly();
  }

  private renderSemanticIndexBar(parent: HTMLElement): void {
    if (!this.plugin.settings.semanticSearchEnabled) {
      return;
    }

    const status = this.plugin.localAgent.getSemanticIndexStatus({
      app: this.app,
      settings: this.plugin.settings,
    });
    const statusText = this.semanticIndexStatusText ?? formatSemanticIndexStatus(status);
    const bar = parent.createDiv({ cls: "obsigent-semantic-index-bar" });
    bar.createSpan({ cls: "obsigent-semantic-index-label", text: statusText });
    if (this.shouldOfferEmbeddingModelDownload(statusText)) {
      const downloadButton = bar.createEl("button", {
        cls: "obsigent-semantic-index-rebuild",
        attr: {
          type: "button",
        },
        text: this.modelDownloadController ? "Downloading…" : "Download embedding model",
      });
      downloadButton.disabled =
        this.isSubmitting ||
        this.isRebuildingSemanticIndex ||
        this.modelDownloadController !== null;
      this.registerDomEvent(downloadButton, "click", () => {
        void this.downloadEmbeddingModelAndRebuild();
      });
    }

    const rebuildButton = bar.createEl("button", {
      cls: "obsigent-semantic-index-rebuild",
      attr: {
        type: "button",
      },
      text: this.isRebuildingSemanticIndex ? "Indexing…" : "Rebuild",
    });
    rebuildButton.disabled = this.isSubmitting || this.isRebuildingSemanticIndex;
    this.registerDomEvent(rebuildButton, "click", () => {
      void this.rebuildSemanticIndexFromView();
    });
  }

  private shouldOfferEmbeddingModelDownload(statusText: string): boolean {
    return shouldOfferEmbeddingModelDownload(statusText, this.plugin.settings.embeddingModel);
  }

  private async rebuildSemanticIndexFromView(): Promise<void> {
    if (this.isRebuildingSemanticIndex) {
      return;
    }

    this.isRebuildingSemanticIndex = true;
    this.semanticIndexStatusText = "Indexing vault…";
    this.renderComposerOnly();
    try {
      const status = await this.plugin.localAgent.rebuildSemanticIndex({
        app: this.app,
        settings: this.plugin.settings,
      });
      this.semanticIndexStatusText = status
        ? `Indexed ${status.noteCount} notes · ${status.chunkCount} chunks`
        : "Semantic search disabled";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.semanticIndexStatusText = `Index failed: ${message}`;
      new Notice(`Could not rebuild semantic index: ${message}`);
    } finally {
      this.isRebuildingSemanticIndex = false;
      this.renderComposerOnly();
    }
  }

  private renderModelPicker(parent: HTMLElement): void {
    const picker = parent.createDiv({ cls: "obsigent-model-picker" });
    const activeModel = getVisionModel(this.plugin.settings.model);
    const trigger = picker.createEl("button", {
      cls: "obsigent-model-trigger",
      attr: {
        "aria-expanded": this.modelMenuOpen ? "true" : "false",
        "aria-label": "Select local vision model",
        type: "button",
      },
    });
    trigger.disabled = this.isSubmitting;
    trigger.createSpan({ cls: "obsigent-model-name", text: activeModel.label });
    trigger.createSpan({ cls: "obsigent-model-chevron", text: "⌃" });

    this.registerDomEvent(trigger, "click", () => {
      this.modelMenuOpen = !this.modelMenuOpen;
      this.render();
    });

    if (!this.modelMenuOpen) {
      return;
    }

    const menu = picker.createDiv({ cls: "obsigent-model-menu" });
    this.closeModelMenuListener = (event: PointerEvent) => {
      if (picker.contains(event.target as Node | null)) {
        return;
      }

      this.modelMenuOpen = false;
      this.render();
    };
    document.addEventListener("pointerdown", this.closeModelMenuListener);
    if (this.modelLoadError) {
      menu.createDiv({ cls: "obsigent-model-error", text: this.modelLoadError });
    }

    const modelIds = isVisionCatalogModel(this.plugin.settings.model)
      ? VISION_MODELS.map((model) => model.id)
      : [this.plugin.settings.model, ...VISION_MODELS.map((model) => model.id)];
    for (const modelId of modelIds) {
      this.renderModelOption(menu, modelId);
    }
  }

  private renderModelOption(menu: HTMLElement, modelId: string): void {
    const model = getVisionModel(modelId);
    const isInstalled = this.installedModelNames.has(modelId);
    const isActive = this.plugin.settings.model === modelId;
    const progress =
      this.modelDownloadProgress?.model === modelId ? this.modelDownloadProgress : null;
    const row = menu.createDiv({
      cls: `obsigent-model-option${isActive ? " obsigent-model-option-active" : ""}`,
    });

    const detailsButton = row.createEl("button", {
      cls: `obsigent-model-details${isActive ? " obsigent-model-details-active" : ""}`,
      attr: {
        type: "button",
      },
    });
    detailsButton.disabled = this.isSubmitting || !isInstalled;
    detailsButton.createSpan({ cls: "obsigent-model-option-name", text: model.label });
    detailsButton.createSpan({ cls: "obsigent-model-option-meta", text: model.sizeLabel });
    this.registerDomEvent(detailsButton, "click", () => {
      if (!isInstalled) {
        return;
      }
      void this.selectModel(modelId);
    });

    if (progress) {
      this.renderModelDownloadProgress(row, progress);
      return;
    }

    if (isInstalled) {
      if (!isActive) {
        row.createDiv({ cls: "obsigent-model-state", text: "Ready" });
      }
      return;
    }

    const downloadButton = row.createEl("button", {
      cls: "obsigent-model-download",
      attr: {
        "aria-label": `Download ${model.label}`,
        type: "button",
      },
    });
    downloadButton.disabled = this.modelDownloadController !== null;
    setIcon(downloadButton, "download");
    this.registerDomEvent(downloadButton, "click", () => {
      void this.downloadModel(modelId);
    });
  }

  private renderModelDownloadProgress(parent: HTMLElement, progress: PullProgress): void {
    const wrapper = parent.createDiv({ cls: "obsigent-model-progress" });
    const percentText = progress.percent === null ? "…" : `${Math.round(progress.percent)}%`;
    wrapper.createSpan({ text: percentText });
    wrapper.createSpan({ cls: "obsigent-model-progress-status", text: progress.status });
    const cancelButton = wrapper.createEl("button", {
      cls: "obsigent-model-cancel",
      attr: {
        "aria-label": `Cancel ${progress.model} download`,
        type: "button",
      },
    });
    cancelButton.createSpan({ text: "Cancel" });
    this.registerDomEvent(cancelButton, "click", () => {
      this.cancelModelDownload();
    });
  }

  private async refreshInstalledModels(): Promise<void> {
    try {
      const models = await listLocalModels(this.plugin.settings.localEndpoint);
      this.installedModelNames = new Set(models.map((model) => model.name));
      this.modelLoadError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.modelLoadError = `Could not reach Ollama: ${message}`;
    }
    this.render();
  }

  private async selectModel(modelId: string): Promise<void> {
    if (this.plugin.settings.model === modelId || this.isSubmitting) {
      this.modelMenuOpen = false;
      this.render();
      return;
    }

    const previousSettings = this.plugin.settings;
    this.plugin.localAgent.unloadNow(previousSettings);
    await this.plugin.saveSettings({
      ...this.plugin.settings,
      model: modelId,
    });
    this.modelMenuOpen = false;
    this.render();
  }

  private async downloadEmbeddingModelAndRebuild(): Promise<void> {
    if (this.modelDownloadController) {
      return;
    }

    const modelId = this.plugin.settings.embeddingModel;
    const model = getEmbeddingModel(modelId);
    const abortController = new AbortController();
    this.modelDownloadController = abortController;
    this.semanticIndexStatusText = `Downloading ${model.label}…`;
    this.renderComposerOnly();

    try {
      await pullModel(
        this.plugin.settings.localEndpoint,
        modelId,
        (progress) => {
          const percentText = progress.percent === null ? "…" : `${Math.round(progress.percent)}%`;
          this.semanticIndexStatusText = `Downloading ${model.label}: ${percentText} ${progress.status}`;
          this.renderComposerOnly();
        },
        abortController.signal,
      );
      new Notice(`Downloaded ${model.label}. Rebuilding semantic index…`);
      await this.refreshInstalledModels();
      await this.rebuildSemanticIndexFromView();
    } catch (error) {
      if (abortController.signal.aborted) {
        new Notice(`Cancelled ${model.label} download.`);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.semanticIndexStatusText = `Download failed: ${message}`;
        new Notice(`Could not download ${model.label}: ${message}`);
      }
    } finally {
      if (this.modelDownloadController === abortController) {
        this.modelDownloadController = null;
      }
      this.renderComposerOnly();
    }
  }

  private async downloadModel(modelId: string): Promise<void> {
    if (this.modelDownloadController) {
      return;
    }

    const abortController = new AbortController();
    this.modelDownloadController = abortController;
    this.modelDownloadProgress = {
      model: modelId,
      status: "starting",
      completed: null,
      total: null,
      percent: null,
    };
    this.render();

    try {
      await pullModel(
        this.plugin.settings.localEndpoint,
        modelId,
        (progress) => {
          this.modelDownloadProgress = progress;
          this.render();
        },
        abortController.signal,
      );
      new Notice(`Downloaded ${getVisionModel(modelId).label}.`);
      await this.selectModel(modelId);
      await this.refreshInstalledModels();
    } catch (error) {
      if (abortController.signal.aborted) {
        new Notice(`Cancelled ${getVisionModel(modelId).label} download.`);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`Could not download ${getVisionModel(modelId).label}: ${message}`);
      }
    } finally {
      if (this.modelDownloadController === abortController) {
        this.modelDownloadController = null;
        this.modelDownloadProgress = null;
      }
      this.render();
    }
  }

  private cancelModelDownload(): void {
    this.modelDownloadController?.abort();
  }

  private renderAttachments(parent: Element): void {
    if (this.attachments.length === 0) {
      return;
    }

    const attachmentsEl = parent.createDiv({ cls: "obsigent-attachments" });
    for (const attachment of this.attachments) {
      const chip = attachmentsEl.createDiv({ cls: "obsigent-attachment-chip" });
      chip.createSpan({ text: attachment.name });
      const removeButton = chip.createEl("button", {
        cls: "obsigent-attachment-remove",
        attr: {
          "aria-label": `Remove ${attachment.name}`,
          type: "button",
        },
        text: "×",
      });
      this.registerDomEvent(removeButton, "click", () => {
        this.attachments = this.attachments.filter((item) => item !== attachment);
        this.render();
      });
    }
  }

  private async addAttachments(files: readonly File[]): Promise<void> {
    const supportedFiles = files.filter(isSupportedAttachment);
    const unsupportedCount = files.length - supportedFiles.length;
    if (unsupportedCount > 0) {
      new Notice(
        `Skipped ${unsupportedCount} unsupported file${unsupportedCount === 1 ? "" : "s"}. Supported: ${ACCEPTED_ATTACHMENT_EXTENSIONS.join(", ")}`,
      );
    }
    if (supportedFiles.length === 0) {
      return;
    }

    this.isProcessingAttachments = true;
    this.render();
    try {
      const processed = await Promise.all(supportedFiles.map((file) => processAttachment(file)));
      this.attachments = [...this.attachments, ...processed];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Could not attach file: ${message}`);
    } finally {
      this.isProcessingAttachments = false;
      this.render();
    }
  }

  private resetSession(): void {
    this.plugin.localAgent.resetSession();
    this.messages = [...STARTER_MESSAGES];
    this.attachments = [];
    this.draftPrompt = "";
    this.isStopping = false;
    this.activeAssistantMessageId = null;
    this.activeToolName = null;
    this.messageIdToAnchor = null;
    this.userScrolledDuringResponse = false;
    this.modelMenuOpen = false;
    new Notice("Obsigent session reset.");
    this.render();
  }

  private async submitPrompt(prompt: string): Promise<void> {
    const runId = createRunId("ui");
    logDebug(this.plugin.settings.debug, runId, "view", "submit_called", {
      isSubmitting: this.isSubmitting,
      promptLength: prompt.length,
    });

    if (this.isSubmitting || this.isProcessingAttachments) {
      logDebug(this.plugin.settings.debug, runId, "view", "submit_ignored_busy");
      return;
    }

    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt && this.attachments.length === 0) {
      logDebug(this.plugin.settings.debug, runId, "view", "submit_ignored_empty");
      return;
    }

    const resolvedContext = await resolvePromptContext({
      app: this.app,
      settings: this.plugin.settings,
      prompt: trimmedPrompt,
    });
    const submittedPrompt = this.createSubmittedPrompt(resolvedContext.request);
    const displayPrompt = this.createDisplayPrompt(trimmedPrompt);

    const priorMessages = this.createAgentPriorMessages();

    this.isSubmitting = true;
    this.isStopping = false;
    this.userScrolledDuringResponse = false;
    this.activeStatusIndex += 1;
    this.activeToolName = null;
    logDebug(this.plugin.settings.debug, runId, "view", "submit_accepted", {
      messageCount: this.messages.length,
    });
    const now = new Date().toISOString();
    const userMessageId = createMessageId("user", this.messages.length);
    const assistantMessageId = createMessageId("assistant", this.messages.length + 1);
    this.messageIdToAnchor = userMessageId;
    this.activeAssistantMessageId = assistantMessageId;
    this.messages = [
      ...this.messages,
      {
        id: userMessageId,
        role: "user",
        text: displayPrompt,
        createdAt: now,
      },
      {
        id: assistantMessageId,
        role: "assistant",
        text: "",
        createdAt: now,
      },
    ];

    this.attachments = [];
    this.draftPrompt = "";
    this.render();

    try {
      const response = await this.plugin.localAgent.prompt(submittedPrompt, {
        app: this.app,
        settings: this.plugin.settings,
        runId,
        ...(priorMessages.length ? { priorMessages } : {}),
        onUpdate: (update) => {
          if (update.type === "text") {
            this.updateMessage(assistantMessageId, update.text);
            this.updateRenderedMessage(assistantMessageId, update.text);
          } else {
            this.activeStatusIndex += 1;
            this.activeToolName = update.toolName;
            this.updateRenderedAssistantStatus();
          }
        },
      });
      logDebug(this.plugin.settings.debug, runId, "view", "submit_response", {
        responseLength: response.length,
      });
      if (this.isStopping) {
        this.updateMessage(
          assistantMessageId,
          this.getStoppedMessage(assistantMessageId, response),
        );
      } else {
        this.updateMessage(assistantMessageId, response || "Done.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logDebug(this.plugin.settings.debug, runId, "view", "submit_error", { message });
      if (this.isStopping) {
        this.updateMessage(assistantMessageId, this.getStoppedMessage(assistantMessageId, ""));
      } else {
        this.updateMessage(assistantMessageId, `Local model error: ${message}`);
        new Notice("Obsigent local model request failed.");
      }
    } finally {
      this.isSubmitting = false;
      this.isStopping = false;
      this.activeAssistantMessageId = null;
      this.activeToolName = null;
      logDebug(this.plugin.settings.debug, runId, "view", "submit_finished", {
        messageCount: this.messages.length,
      });
      await this.persistCurrentChat();
      this.render();
      this.messageIdToAnchor = null;
      this.userScrolledDuringResponse = false;
    }
  }

  private async persistCurrentChat(): Promise<void> {
    if (!this.plugin.settings.persistChatHistory || this.messages.length === 0) {
      return;
    }
    await this.plugin.saveChatSession(
      serializeChatSession(this.messages, new Date().toISOString()),
    );
  }

  private createAgentPriorMessages(): readonly Message[] {
    const messages: Message[] = [];
    let remainingChars = MAX_AGENT_PRIOR_CHARS;
    const chatMessages = this.messages
      .filter((message) => message.text.trim() && !message.text.startsWith("Local model error:"))
      .slice(-MAX_AGENT_PRIOR_MESSAGES);

    for (const message of chatMessages.reverse()) {
      if (remainingChars <= 0) {
        break;
      }
      const content = truncateForPriorMessage(message.text, remainingChars);
      remainingChars -= content.length;
      messages.push({ role: message.role, content });
    }

    return messages.reverse();
  }

  private createSubmittedPrompt(prompt: string): string | (TextContent | ImageContent)[] {
    if (this.attachments.length === 0) {
      return prompt;
    }

    return [
      { type: "text", text: prompt || "Please review the attached files." },
      ...this.attachments.flatMap((attachment) => attachment.parts),
    ];
  }

  private createDisplayPrompt(prompt: string): string {
    if (this.attachments.length === 0) {
      return prompt;
    }

    const attachmentNames = this.attachments.map((attachment) => attachment.name).join(", ");
    return `${prompt || "Review the attached files."}\n\nAttached: ${attachmentNames}`;
  }

  private stopPrompt(): void {
    if (!this.isSubmitting || this.isStopping) {
      return;
    }

    this.isStopping = true;
    this.activeStatusIndex += 1;
    this.plugin.localAgent.cancel();
    this.updateRenderedAssistantStatus();
    this.renderComposerOnly();
  }

  private getCurrentMessageScrollTop(root: Element): number | null {
    return root.querySelector<HTMLElement>(".obsigent-messages")?.scrollTop ?? null;
  }

  private registerMessageScrollTracking(messagesEl: HTMLElement): void {
    this.registerDomEvent(messagesEl, "wheel", () => {
      if (this.isSubmitting) {
        this.userScrolledDuringResponse = true;
      }
    });
    this.registerDomEvent(messagesEl, "touchmove", () => {
      if (this.isSubmitting) {
        this.userScrolledDuringResponse = true;
      }
    });
    this.registerDomEvent(messagesEl, "keydown", () => {
      if (this.isSubmitting) {
        this.userScrolledDuringResponse = true;
      }
    });
    this.registerDomEvent(messagesEl, "pointerdown", () => {
      if (this.isSubmitting) {
        this.userScrolledDuringResponse = true;
      }
    });
  }

  private restoreMessageScrollTop(messagesEl: HTMLElement, scrollTop: number): void {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = scrollTop;
    });
  }

  private scrollAnchoredMessageToTop(messagesEl: HTMLElement, spacerEl: HTMLElement): void {
    const messageId = this.messageIdToAnchor;
    if (!messageId) {
      return;
    }

    requestAnimationFrame(() => {
      const messageEl = messagesEl.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(messageId)}"]`,
      );
      if (!messageEl) {
        return;
      }

      const targetScrollTop = Math.max(0, messageEl.offsetTop - messagesEl.offsetTop);
      const neededScrollHeight = targetScrollTop + messagesEl.clientHeight;
      const missingScrollHeight = neededScrollHeight - messagesEl.scrollHeight;
      spacerEl.style.height = `${Math.max(0, missingScrollHeight)}px`;
      messagesEl.scrollTop = targetScrollTop;
    });
  }

  private renderComposerOnly(): void {
    const root = this.containerEl.children[1];
    const composer = root.querySelector(".obsigent-composer");
    composer?.remove();
    this.renderComposer(root);
  }

  private updateRenderedMessage(id: string, text: string): void {
    const messageEl = this.getRenderedMessageElement(id);
    const bubbleEl = messageEl?.querySelector<HTMLElement>(".obsigent-message-bubble");
    if (bubbleEl) {
      this.renderMessageMarkdown(id, text, bubbleEl);
    }
  }

  private renderMessageMarkdown(id: string, markdown: string, bubbleEl: HTMLElement): void {
    this.removeRenderedMessageMarkdown(id);
    bubbleEl.empty();

    if (!markdown) {
      return;
    }

    const component = this.addChild(new Component());
    this.messageMarkdownComponents.set(id, component);
    const renderedEl = bubbleEl.createDiv({ cls: "obsigent-markdown-content markdown-rendered" });
    const sourcePath = this.getMarkdownSourcePath();

    void MarkdownRenderer.render(this.app, markdown, renderedEl, sourcePath, component)
      .then(() => {
        if (this.messageMarkdownComponents.get(id) !== component) {
          return;
        }

        this.highlightResolvedMentions(renderedEl);
        this.renderVaultImages(renderedEl, sourcePath);
      })
      .catch((error) => {
        if (this.messageMarkdownComponents.get(id) !== component) {
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        logDebug(this.plugin.settings.debug, "markdown", "view", "render_error", { message });
        renderedEl.empty();
        renderTextWithResolvedMentions(
          renderedEl,
          markdown,
          getResolvedMentionRanges(markdown, this.app, this.plugin.settings),
        );
      });
  }

  private highlightResolvedMentions(renderedEl: HTMLElement): void {
    const walker = document.createTreeWalker(renderedEl, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    while (true) {
      const node = walker.nextNode();
      if (!node) {
        break;
      }
      if (node.parentElement?.closest(".obsigent-resolved-mention")) {
        continue;
      }
      textNodes.push(node as Text);
    }

    for (const textNode of textNodes) {
      const ranges = getResolvedMentionRanges(textNode.data, this.app, this.plugin.settings);
      if (ranges.length === 0 || !textNode.parentNode) {
        continue;
      }
      const fragment = document.createDocumentFragment();
      renderTextWithResolvedMentions(fragment, textNode.data, ranges);
      textNode.parentNode.replaceChild(fragment, textNode);
    }
  }

  private renderVaultImages(renderedEl: HTMLElement, sourcePath: string): void {
    this.renderVaultImageEmbeds(renderedEl, sourcePath);
    this.resolveMarkdownImageSources(renderedEl, sourcePath);
  }

  private renderVaultImageEmbeds(renderedEl: HTMLElement, sourcePath: string): void {
    const embeds = Array.from(renderedEl.querySelectorAll<HTMLElement>(".internal-embed"));
    for (const embed of embeds) {
      const linkText = this.getEmbedLinkText(embed);
      if (!linkText) {
        continue;
      }

      const file = this.resolveVaultImageFile(linkText, sourcePath);
      if (!file) {
        continue;
      }

      const imageEl = createEl("img");
      imageEl.src = this.app.vault.getResourcePath(file);
      imageEl.alt = embed.getAttribute("alt") ?? file.name;
      imageEl.addClass("obsigent-markdown-image");
      embed.replaceWith(imageEl);
    }
  }

  private resolveMarkdownImageSources(renderedEl: HTMLElement, sourcePath: string): void {
    const images = Array.from(renderedEl.querySelectorAll<HTMLImageElement>("img"));
    for (const image of images) {
      image.addClass("obsigent-markdown-image");
      const src = image.getAttribute("src")?.trim();
      if (!src || this.isExternalImageSource(src)) {
        continue;
      }

      const file = this.resolveVaultImageFile(src, sourcePath);
      if (file) {
        image.src = this.app.vault.getResourcePath(file);
      }
    }
  }

  private getEmbedLinkText(embed: HTMLElement): string | null {
    const candidates = [
      embed.getAttribute("src"),
      embed.getAttribute("data-src"),
      embed.getAttribute("data-href"),
      embed.getAttribute("alt"),
      embed.querySelector<HTMLElement>(".file-embed-title")?.getAttribute("data-href"),
      embed.querySelector<HTMLAnchorElement>("a.internal-link")?.getAttribute("data-href"),
      embed.querySelector<HTMLAnchorElement>("a.internal-link")?.getAttribute("href"),
    ];

    for (const candidate of candidates) {
      const linkText = candidate?.trim();
      if (linkText) {
        return linkText;
      }
    }

    return null;
  }

  private resolveVaultImageFile(linkText: string, sourcePath: string): TFile | null {
    const normalizedLinkText = this.normalizeImageLinkText(linkText);
    const { path } = parseLinktext(normalizedLinkText);
    const cleanPath = path.trim();
    if (!cleanPath || !this.isImagePath(cleanPath)) {
      return null;
    }

    const linkedFile = this.app.metadataCache.getFirstLinkpathDest(cleanPath, sourcePath);
    if (linkedFile instanceof TFile && this.isImagePath(linkedFile.path)) {
      return linkedFile;
    }

    const relativePath = this.resolveRelativeImagePath(cleanPath, sourcePath);
    const exactFile = this.app.vault.getFileByPath(relativePath);
    return exactFile && this.isImagePath(exactFile.path) ? exactFile : null;
  }

  private normalizeImageLinkText(linkText: string): string {
    const decodedLinkText = safeDecodeURIComponent(linkText.trim());
    const withoutAppPrefix = decodedLinkText.replace(/^app:\/\/[^#]*#/u, "");
    const withoutWikiBrackets = withoutAppPrefix.replace(/^!?\[\[/u, "").replace(/\]\]$/u, "");
    const withoutMarkdownImagePrefix = withoutWikiBrackets
      .replace(/^!\[[^\]]*\]\(/u, "")
      .replace(/\)$/u, "");
    return withoutMarkdownImagePrefix.split("|")[0]?.trim() ?? "";
  }

  private resolveRelativeImagePath(path: string, sourcePath: string): string {
    if (path.startsWith("/") || !sourcePath.includes("/")) {
      return normalizePath(path.replace(/^\//u, ""));
    }

    const sourceFolder = sourcePath.slice(0, sourcePath.lastIndexOf("/"));
    return normalizePath(`${sourceFolder}/${path}`);
  }

  private isExternalImageSource(src: string): boolean {
    return /^(?:[a-z][a-z0-9+.-]*:|#|\/)/iu.test(src);
  }

  private isImagePath(path: string): boolean {
    const extension = path.split(/[?#]/u)[0]?.split(".").pop()?.toLowerCase();
    return extension ? IMAGE_FILE_EXTENSIONS.has(extension) : false;
  }

  private removeRenderedMessageMarkdown(id: string): void {
    const component = this.messageMarkdownComponents.get(id);
    if (!component) {
      return;
    }

    this.removeChild(component);
    this.messageMarkdownComponents.delete(id);
  }

  private clearRenderedMessageMarkdown(): void {
    for (const component of this.messageMarkdownComponents.values()) {
      this.removeChild(component);
    }
    this.messageMarkdownComponents.clear();
  }

  private getMarkdownSourcePath(): string {
    return this.app.workspace.getActiveFile()?.path ?? "";
  }

  private updateRenderedAssistantStatus(): void {
    const id = this.activeAssistantMessageId;
    if (!id) {
      return;
    }

    const messageEl = this.getRenderedMessageElement(id);
    const statusEl = messageEl?.querySelector<HTMLElement>(".obsigent-assistant-status");
    if (statusEl) {
      this.renderAssistantStatusContent(statusEl);
    }
  }

  private getRenderedMessageElement(id: string): HTMLElement | null {
    return this.containerEl.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
  }

  private focusComposer(input: HTMLTextAreaElement): void {
    if (this.isSubmitting) {
      return;
    }

    requestAnimationFrame(() => {
      if (!input.isConnected || this.isSubmitting) {
        return;
      }

      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }

  private getStoppedMessage(id: string, fallback: string): string {
    const currentText = this.messages.find((message) => message.id === id)?.text.trim() ?? "";
    const text = fallback.trim() || currentText;
    return text ? `${text}\n\n_Stopped._` : "_Stopped._";
  }

  private updateMessage(id: string, text: string): void {
    this.messages = this.messages.map((message) =>
      message.id === id
        ? {
            ...message,
            text,
          }
        : message,
    );
  }
}
