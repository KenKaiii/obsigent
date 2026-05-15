import type { AgentTool } from "@kenkaiiii/gg-agent";
import { type App, Modal, Notice, type TFile, type WorkspaceLeaf } from "obsidian";
import { z } from "zod";
import type { ObsigentSettings } from "./settings";

const MAX_READ_CHARS = 20_000;
const MAX_SEARCH_RESULTS = 12;
const MAX_WRITE_CHARS = 120_000;
const WRITE_DELAY_MS = 150;
const MAX_CHANGES = 50;

export type VaultChangeKind = "create" | "append" | "replace" | "overwrite";

export type VaultChange = Readonly<{
  id: string;
  kind: VaultChangeKind;
  path: string;
  beforeContent: string | null;
  afterContent: string;
  createdAt: string;
  revertedAt: string | null;
}>;

export class VaultChangeHistory {
  private nextId = 1;
  private readonly changes: VaultChange[] = [];

  public constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  public record(change: Omit<VaultChange, "id" | "createdAt" | "revertedAt">): VaultChange {
    const recordedChange: VaultChange = {
      ...change,
      id: `change-${this.nextId}`,
      createdAt: this.now(),
      revertedAt: null,
    };
    this.nextId += 1;
    this.changes.push(recordedChange);
    if (this.changes.length > MAX_CHANGES) {
      this.changes.splice(0, this.changes.length - MAX_CHANGES);
    }
    return recordedChange;
  }

  public list(limit: number): readonly VaultChange[] {
    return [...this.changes].reverse().slice(0, limit);
  }

  public get(changeId: string): VaultChange | null {
    return this.changes.find((change) => change.id === changeId) ?? null;
  }

  public getLastActive(path?: string): VaultChange | null {
    return (
      [...this.changes]
        .reverse()
        .find((change) => !change.revertedAt && (!path || change.path === path)) ?? null
    );
  }

  public markReverted(changeId: string): VaultChange {
    const index = this.changes.findIndex((change) => change.id === changeId);
    if (index < 0) {
      throw new Error(`Change not found: ${changeId}`);
    }

    const currentChange = this.changes[index];
    if (!currentChange) {
      throw new Error(`Change not found: ${changeId}`);
    }

    const revertedChange = { ...currentChange, revertedAt: this.now() };
    this.changes[index] = revertedChange;
    return revertedChange;
  }
}

export type VaultToolOptions = Readonly<{
  approveWrite?: (request: WriteApprovalRequest) => Promise<boolean> | boolean;
  changeHistory?: VaultChangeHistory;
}>;

export type WriteApprovalRequest = Readonly<{
  action: string;
  path: string;
  preview: string;
}>;

export function createVaultTools(
  app: App,
  settings: ObsigentSettings,
  options: VaultToolOptions = {},
): AgentTool[] {
  const tools: AgentTool[] = [
    createListNotesTool(app, settings),
    createReadNoteTool(app, settings),
    createSearchNotesTool(app, settings),
  ];

  if (settings.safetyMode === "approve-writes") {
    tools.push(
      createNoteTool(app, settings, options),
      appendNoteTool(app, settings, options),
      replaceNoteTool(app, settings, options),
      overwriteNoteTool(app, settings, options),
      listRecentChangesTool(options),
      revertChangeTool(app, settings, options),
    );
  }

  return tools;
}

function createListNotesTool(
  app: App,
  settings: ObsigentSettings,
): AgentTool<
  z.ZodObject<{ folder: z.ZodOptional<z.ZodString>; limit: z.ZodOptional<z.ZodNumber> }>
> {
  const parameters = z.object({
    folder: z.string().optional().describe("Optional folder path to list from."),
    limit: z.number().int().min(1).max(50).optional().describe("Maximum notes to return."),
  });

  return {
    name: "list_notes",
    description: "List markdown note paths in the vault. Read-only.",
    parameters,
    execute: ({ folder, limit = 30 }) => {
      const normalizedFolder = normalizePath(folder ?? "");
      const files = getVisibleMarkdownFiles(app, settings)
        .filter((file) => !normalizedFolder || file.path.startsWith(`${normalizedFolder}/`))
        .slice(0, limit)
        .map((file) => file.path);

      return files.length ? files.join("\n") : "No matching notes found.";
    },
  } satisfies AgentTool<typeof parameters>;
}

function createReadNoteTool(
  app: App,
  settings: ObsigentSettings,
): AgentTool<z.ZodObject<{ path: z.ZodString }>> {
  const parameters = z.object({
    path: z.string().describe("Vault-relative markdown note path to read."),
  });

  return {
    name: "read_note",
    description: "Read one markdown note by vault-relative path. Read-only.",
    parameters,
    execute: async ({ path }) => {
      const file = getAllowedMarkdownFile(app, settings, path, "read");
      const content = await app.vault.read(file);
      if (content.length <= MAX_READ_CHARS) {
        return content;
      }

      return `${content.slice(0, MAX_READ_CHARS)}\n\n[Truncated ${content.length - MAX_READ_CHARS} characters]`;
    },
  } satisfies AgentTool<typeof parameters>;
}

function createSearchNotesTool(
  app: App,
  settings: ObsigentSettings,
): AgentTool<z.ZodObject<{ query: z.ZodString; limit: z.ZodOptional<z.ZodNumber> }>> {
  const parameters = z.object({
    query: z
      .string()
      .min(1)
      .describe("Case-insensitive text to search in note paths and contents."),
    limit: z.number().int().min(1).max(25).optional().describe("Maximum matches to return."),
  });

  return {
    name: "search_notes",
    description: "Search note paths and contents for text. Returns snippets. Read-only.",
    parameters,
    execute: async ({ query, limit = MAX_SEARCH_RESULTS }) => {
      const normalizedQuery = query.toLowerCase();
      const matches: string[] = [];

      for (const file of getVisibleMarkdownFiles(app, settings)) {
        if (matches.length >= limit) {
          break;
        }

        const pathMatch = file.path.toLowerCase().includes(normalizedQuery);
        const content = pathMatch ? "" : await app.vault.cachedRead(file);
        const contentIndex = content.toLowerCase().indexOf(normalizedQuery);

        if (!pathMatch && contentIndex < 0) {
          continue;
        }

        const snippet = pathMatch ? "Path match" : makeSnippet(content, contentIndex, query.length);
        matches.push(`- ${file.path}: ${snippet}`);
      }

      return matches.length ? matches.join("\n") : "No matching notes found.";
    },
  } satisfies AgentTool<typeof parameters>;
}

function createNoteTool(
  app: App,
  settings: ObsigentSettings,
  options: VaultToolOptions,
): AgentTool<
  z.ZodObject<{
    path: z.ZodString;
    content: z.ZodString;
  }>
> {
  const parameters = z.object({
    path: z.string().describe("Vault-relative markdown note path to create."),
    content: z.string().describe("Full markdown content for the new note."),
  });

  return {
    name: "create_note",
    description:
      "Create a new markdown note, open it visibly in Obsidian, then write its full content immediately.",
    parameters,
    execute: async ({ path, content }) => {
      ensureWriteAllowed(settings);
      assertWriteContentSize(content);
      const normalizedPath = normalizeMarkdownPath(path);
      assertPathAllowed(settings, normalizedPath);
      if (app.vault.getAbstractFileByPath(normalizedPath)) {
        throw new Error(`Note already exists: ${normalizedPath}`);
      }

      await ensureParentFolder(app, normalizedPath);
      const file = await app.vault.create(normalizedPath, "");
      await openNote(app, file);
      await writeVisibleContent(app, file, content);
      const change = recordChange(options, {
        kind: "create",
        path: normalizedPath,
        beforeContent: null,
        afterContent: content,
      });
      await showNotice(`Obsigent created ${normalizedPath}`);
      return `Created and opened ${normalizedPath}. Change id: ${change.id}.`;
    },
  } satisfies AgentTool<typeof parameters>;
}

function appendNoteTool(
  app: App,
  settings: ObsigentSettings,
  options: VaultToolOptions,
): AgentTool<
  z.ZodObject<{
    path: z.ZodString;
    content: z.ZodString;
  }>
> {
  const parameters = z.object({
    path: z.string().describe("Vault-relative markdown note path to append to."),
    content: z.string().describe("Markdown content to append."),
  });

  return {
    name: "append_note",
    description:
      "Open an existing markdown note in Obsidian, then append markdown content so the change is visible.",
    parameters,
    execute: async ({ path, content }) => {
      ensureWriteAllowed(settings);
      assertWriteContentSize(content);
      const file = getAllowedMarkdownFile(app, settings, path, "edited");
      await requestWriteApproval(app, options, "Append to note", file.path, content);
      await openNote(app, file);
      const existing = await app.vault.read(file);
      const separator = existing.endsWith("\n") || content.startsWith("\n") ? "" : "\n";
      const nextContent = `${existing}${separator}${content}`;
      await writeVisibleContent(app, file, nextContent);
      const change = recordChange(options, {
        kind: "append",
        path: file.path,
        beforeContent: existing,
        afterContent: nextContent,
      });
      await showNotice(`Obsigent appended to ${file.path}`);
      return `Opened and appended to ${file.path}. Change id: ${change.id}.`;
    },
  } satisfies AgentTool<typeof parameters>;
}

function replaceNoteTool(
  app: App,
  settings: ObsigentSettings,
  options: VaultToolOptions,
): AgentTool<
  z.ZodObject<{
    path: z.ZodString;
    find: z.ZodString;
    replace: z.ZodString;
  }>
> {
  const parameters = z.object({
    path: z.string().describe("Vault-relative markdown note path to edit."),
    find: z.string().min(1).describe("Exact text to replace. Must appear exactly once."),
    replace: z.string().describe("Replacement markdown text."),
  });

  return {
    name: "replace_in_note",
    description:
      "Open an existing markdown note in Obsidian, then replace exact text that appears exactly once.",
    parameters,
    execute: async ({ path, find, replace }) => {
      ensureWriteAllowed(settings);
      assertWriteContentSize(replace);
      const file = getAllowedMarkdownFile(app, settings, path, "edited");
      await requestWriteApproval(app, options, "Replace text in note", file.path, replace);
      await openNote(app, file);
      const existing = await app.vault.read(file);
      const matches = countOccurrences(existing, find);
      if (matches !== 1) {
        throw new Error(
          `Expected replacement text to appear exactly once in ${file.path}; found ${matches}.`,
        );
      }

      const nextContent = existing.replace(find, replace);
      await writeVisibleContent(app, file, nextContent);
      const change = recordChange(options, {
        kind: "replace",
        path: file.path,
        beforeContent: existing,
        afterContent: nextContent,
      });
      await showNotice(`Obsigent edited ${file.path}`);
      return `Opened and edited ${file.path}. Change id: ${change.id}.`;
    },
  } satisfies AgentTool<typeof parameters>;
}

function overwriteNoteTool(
  app: App,
  settings: ObsigentSettings,
  options: VaultToolOptions,
): AgentTool<
  z.ZodObject<{
    path: z.ZodString;
    content: z.ZodString;
  }>
> {
  const parameters = z.object({
    path: z.string().describe("Vault-relative markdown note path to overwrite."),
    content: z.string().describe("Full replacement markdown content."),
  });

  return {
    name: "overwrite_note",
    description:
      "Open an existing markdown note in Obsidian, then replace the entire note content. Use only when a full rewrite is explicitly requested.",
    parameters,
    execute: async ({ path, content }) => {
      ensureWriteAllowed(settings);
      assertWriteContentSize(content);
      const file = getAllowedMarkdownFile(app, settings, path, "edited");
      await requestWriteApproval(app, options, "Overwrite note", file.path, content);
      await openNote(app, file);
      const existing = await app.vault.read(file);
      await writeVisibleContent(app, file, content);
      const change = recordChange(options, {
        kind: "overwrite",
        path: file.path,
        beforeContent: existing,
        afterContent: content,
      });
      await showNotice(`Obsigent rewrote ${file.path}`);
      return `Opened and rewrote ${file.path}. Change id: ${change.id}.`;
    },
  } satisfies AgentTool<typeof parameters>;
}

function listRecentChangesTool(
  options: VaultToolOptions,
): AgentTool<z.ZodObject<{ limit: z.ZodOptional<z.ZodNumber> }>> {
  const parameters = z.object({
    limit: z.number().int().min(1).max(20).optional().describe("Maximum changes to list."),
  });

  return {
    name: "list_recent_changes",
    description: "List recent Obsigent note changes that can be reverted.",
    parameters,
    execute: ({ limit = 10 }) => {
      const changes = getChangeHistory(options).list(limit);
      if (changes.length === 0) {
        return "No recent Obsigent changes found.";
      }

      return changes
        .map(
          (change) =>
            `- ${change.id} ${change.kind} ${change.path} at ${change.createdAt}${change.revertedAt ? ` (reverted ${change.revertedAt})` : ""}`,
        )
        .join("\n");
    },
  } satisfies AgentTool<typeof parameters>;
}

function revertChangeTool(
  app: App,
  settings: ObsigentSettings,
  options: VaultToolOptions,
): AgentTool<
  z.ZodObject<{
    changeId: z.ZodOptional<z.ZodString>;
    path: z.ZodOptional<z.ZodString>;
  }>
> {
  const parameters = z.object({
    changeId: z
      .string()
      .optional()
      .describe("Change id from list_recent_changes. Defaults to latest active change."),
    path: z
      .string()
      .optional()
      .describe("Optional note path when reverting the latest active change for one note."),
  });

  return {
    name: "revert_change",
    description:
      "Revert an Obsigent-created change. Created notes are moved to trash; edits restore previous content after approval.",
    parameters,
    execute: async ({ changeId, path }) => {
      ensureWriteAllowed(settings);
      const normalizedPath = path ? normalizeMarkdownPath(path) : undefined;
      if (normalizedPath) {
        assertPathAllowed(settings, normalizedPath);
      }
      const history = getChangeHistory(options);
      const change = changeId ? history.get(changeId) : history.getLastActive(normalizedPath);
      if (!change) {
        throw new Error(
          changeId ? `Change not found: ${changeId}` : "No active change found to revert.",
        );
      }
      if (change.revertedAt) {
        throw new Error(`Change already reverted: ${change.id}`);
      }
      assertPathAllowed(settings, change.path);

      if (change.beforeContent === null) {
        const file = getAllowedMarkdownFile(app, settings, change.path, "edited");
        await openNote(app, file);
        await requestWriteApproval(
          app,
          options,
          "Revert created note",
          file.path,
          "Move note to trash",
        );
        await app.fileManager.trashFile(file);
        history.markReverted(change.id);
        await showNotice(`Obsigent reverted ${change.id}`);
        return `Reverted ${change.id} by moving ${change.path} to trash.`;
      }

      const file = getAllowedMarkdownFile(app, settings, change.path, "edited");
      await requestWriteApproval(app, options, "Revert note edit", file.path, change.beforeContent);
      await openNote(app, file);
      await writeVisibleContent(app, file, change.beforeContent);
      history.markReverted(change.id);
      await showNotice(`Obsigent reverted ${change.id}`);
      return `Reverted ${change.id} and restored ${change.path}.`;
    },
  } satisfies AgentTool<typeof parameters>;
}

function getVisibleMarkdownFiles(app: App, settings: ObsigentSettings): TFile[] {
  return app.vault
    .getMarkdownFiles()
    .filter((file) => isAllowedPath(settings, file.path))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function getChangeHistory(options: VaultToolOptions): VaultChangeHistory {
  return options.changeHistory ?? defaultChangeHistory;
}

function recordChange(
  options: VaultToolOptions,
  change: Omit<VaultChange, "id" | "createdAt" | "revertedAt">,
): VaultChange {
  return getChangeHistory(options).record(change);
}

const defaultChangeHistory = new VaultChangeHistory();

function getAllowedMarkdownFile(
  app: App,
  settings: ObsigentSettings,
  path: string,
  action: "read" | "edited",
): TFile {
  const normalizedPath = normalizeMarkdownPath(path);
  assertPathAllowed(settings, normalizedPath);

  const file = app.vault.getFileByPath(normalizedPath);
  if (!file) {
    throw new Error(`Note not found: ${normalizedPath}`);
  }

  if (file.extension !== "md") {
    throw new Error(`Only markdown notes can be ${action}: ${normalizedPath}`);
  }

  return file;
}

function ensureWriteAllowed(settings: ObsigentSettings): void {
  if (settings.safetyMode !== "approve-writes") {
    throw new Error("Write tools require approve-writes safety mode.");
  }
}

function assertWriteContentSize(content: string): void {
  if (content.length > MAX_WRITE_CHARS) {
    throw new Error(`Write content is too large: ${content.length} characters.`);
  }
}

function assertPathAllowed(settings: ObsigentSettings, path: string): void {
  if (!isAllowedPath(settings, path)) {
    throw new Error(`Path is excluded: ${path}`);
  }
}

async function requestWriteApproval(
  app: App,
  options: VaultToolOptions,
  action: string,
  path: string,
  content: string,
): Promise<void> {
  const preview = content.length > 1_500 ? `${content.slice(0, 1_500)}\n\n…` : content;
  const approved = options.approveWrite
    ? await options.approveWrite({ action, path, preview })
    : await openWriteApprovalModal(app, action, path, preview);
  if (!approved) {
    throw new Error(`User rejected write to ${path}.`);
  }
}

async function openWriteApprovalModal(
  app: App,
  action: string,
  path: string,
  preview: string,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    class WriteApprovalModal extends Modal {
      private resolved = false;

      public override onOpen(): void {
        this.setTitle(`Approve Obsigent write: ${action}`);
        this.contentEl.empty();
        this.contentEl.createEl("p", { text: path });
        this.contentEl.createEl("pre", {
          cls: "obsigent-write-preview",
          text: preview || "[empty content]",
        });

        const actions = this.contentEl.createDiv({ cls: "obsigent-write-actions" });
        const rejectButton = actions.createEl("button", { text: "Reject", type: "button" });
        rejectButton.addEventListener("click", () => this.finish(false));
        const approveButton = actions.createEl("button", {
          cls: "mod-cta",
          text: "Approve write",
          type: "button",
        });
        approveButton.addEventListener("click", () => this.finish(true));
      }

      public override onClose(): void {
        this.finish(false);
      }

      private finish(approved: boolean): void {
        if (this.resolved) {
          return;
        }
        this.resolved = true;
        resolve(approved);
        this.close();
      }
    }

    new WriteApprovalModal(app).open();
  });
}

async function showNotice(message: string): Promise<void> {
  new Notice(message);
}

async function ensureParentFolder(app: App, path: string): Promise<void> {
  const parts = path.split("/").slice(0, -1);
  let currentPath = "";
  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(currentPath)) {
      await app.vault.createFolder(currentPath);
    }
  }
}

async function openNote(app: App, file: TFile): Promise<void> {
  const leaf = findOpenLeaf(app, file) ?? app.workspace.getLeaf("split");
  await leaf.openFile(file, { active: true });
  app.workspace.revealLeaf(leaf);
  await delay(WRITE_DELAY_MS);
}

async function writeVisibleContent(app: App, file: TFile, content: string): Promise<void> {
  const leaf = findOpenLeaf(app, file);
  const view = leaf?.view;
  if (view && "setViewData" in view && "requestSave" in view) {
    const textView = view as {
      setViewData: (data: string, clear: boolean) => void;
      requestSave: () => void;
    };
    textView.setViewData(content, false);
    textView.requestSave();
    await delay(WRITE_DELAY_MS);
    await app.vault.modify(file, content);
    return;
  }

  await app.vault.modify(file, content);
}

function findOpenLeaf(app: App, file: TFile): WorkspaceLeaf | null {
  return (
    app.workspace
      .getLeavesOfType("markdown")
      .find((leaf) => getViewFilePath(leaf.view) === file.path) ?? null
  );
}

function getViewFilePath(view: unknown): string | null {
  if (!view || typeof view !== "object" || !("file" in view)) {
    return null;
  }

  const file = (view as { file?: { path?: unknown } | null }).file;
  return typeof file?.path === "string" ? file.path : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countOccurrences(content: string, search: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const nextIndex = content.indexOf(search, index);
    if (nextIndex < 0) {
      return count;
    }
    count += 1;
    index = nextIndex + search.length;
  }
}

function isAllowedPath(settings: ObsigentSettings, path: string): boolean {
  const normalizedPath = normalizePath(path);
  if (normalizedPath.includes("..")) {
    return false;
  }

  return !settings.excludedFolders.some((folder) => {
    const normalizedFolder = normalizePath(folder);
    return normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}/`);
  });
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
}

function normalizeMarkdownPath(path: string): string {
  const normalizedPath = normalizePath(path);
  return normalizedPath.toLowerCase().endsWith(".md") ? normalizedPath : `${normalizedPath}.md`;
}

function makeSnippet(content: string, index: number, queryLength: number): string {
  const start = Math.max(0, index - 80);
  const end = Math.min(content.length, index + queryLength + 160);
  return content.slice(start, end).replace(/\s+/gu, " ").trim();
}
