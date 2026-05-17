import { type App, MarkdownView, type TFile, TFolder } from "obsidian";
import type { ObsigentSettings } from "./settings";

const MAX_CONTEXT_CHARS = 24_000;
const MAX_CONTEXT_ITEM_CHARS = 8_000;
const MAX_FOLDER_FILES = 20;

export type ContextReferenceKind = "current-note" | "selection" | "note" | "folder";

export type ContextReference = Readonly<{
  kind: ContextReferenceKind;
  raw: string;
  target: string;
}>;

export type ResolvedContextBlock = Readonly<{
  label: string;
  content: string;
  truncated: boolean;
}>;

export type ContextResolution = Readonly<{
  request: string;
  displayRequest: string;
  blocks: readonly ResolvedContextBlock[];
  warnings: readonly string[];
}>;

export type ResolvePromptContextOptions = Readonly<{
  app: App;
  settings: ObsigentSettings;
  prompt: string;
  projectContext?: ResolvedContextBlock;
}>;

export async function resolvePromptContext(
  options: ResolvePromptContextOptions,
): Promise<ContextResolution> {
  const references = parseContextReferences(options.prompt);
  const blocks: ResolvedContextBlock[] = options.projectContext ? [options.projectContext] : [];
  const warnings: string[] = [];
  let remainingBudget =
    MAX_CONTEXT_CHARS - blocks.reduce((total, block) => total + block.content.length, 0);

  for (const reference of references) {
    if (remainingBudget <= 0) {
      warnings.push("Context limit reached; remaining references were skipped.");
      break;
    }

    const resolved = await resolveReference(
      options.app,
      options.settings,
      reference,
      remainingBudget,
    );
    warnings.push(...resolved.warnings);
    if (resolved.block) {
      blocks.push(resolved.block);
      remainingBudget -= resolved.block.content.length;
    }
  }

  return {
    request: createSubmittedRequest(options.prompt, blocks, warnings),
    displayRequest: createDisplayRequest(options.prompt, blocks, warnings),
    blocks,
    warnings,
  };
}

export function parseContextReferences(prompt: string): readonly ContextReference[] {
  const references: ContextReference[] = [];
  const seen = new Set<string>();

  for (const match of prompt.matchAll(/@Current note\b/giu)) {
    addReference(references, seen, {
      kind: "current-note",
      raw: match[0],
      target: "Current note",
    });
  }

  for (const match of prompt.matchAll(/@selection\b/giu)) {
    addReference(references, seen, {
      kind: "selection",
      raw: match[0],
      target: "selection",
    });
  }

  for (const match of prompt.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/gu)) {
    const target = match[1]?.trim();
    if (target) {
      addReference(references, seen, { kind: "note", raw: match[0], target });
    }
  }

  for (const reference of parseAtPathReferences(prompt)) {
    if (
      /^Current$/iu.test(reference.target) ||
      /^Current note$/iu.test(reference.target) ||
      /^selection$/iu.test(reference.target)
    ) {
      continue;
    }
    addReference(references, seen, reference);
  }

  return references;
}

type ReferenceResolution = Readonly<{
  block: ResolvedContextBlock | null;
  warnings: readonly string[];
}>;

async function resolveReference(
  app: App,
  settings: ObsigentSettings,
  reference: ContextReference,
  remainingBudget: number,
): Promise<ReferenceResolution> {
  if (reference.kind === "selection") {
    return resolveSelection(app, remainingBudget);
  }

  if (reference.kind === "current-note") {
    const file = app.workspace.getActiveFile();
    if (!file) {
      return { block: null, warnings: ["No current note is active."] };
    }
    return await resolveFile(app, settings, file, `Current note: ${file.path}`, remainingBudget);
  }

  if (reference.kind === "folder") {
    return await resolveFolder(app, settings, reference.target, remainingBudget);
  }

  const file = resolveNoteFile(app, settings, reference.target);
  if (file.status === "missing") {
    return { block: null, warnings: [`Could not resolve note reference: ${reference.raw}`] };
  }
  if (file.status === "ambiguous") {
    return {
      block: null,
      warnings: [`Ambiguous note reference ${reference.raw}: ${file.paths.join(", ")}`],
    };
  }
  return await resolveFile(app, settings, file.file, `Note: ${file.file.path}`, remainingBudget);
}

function resolveSelection(app: App, remainingBudget: number): ReferenceResolution {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  const selection = view?.editor.getSelection().trim() ?? "";
  if (!selection) {
    return { block: null, warnings: ["No editor selection is active."] };
  }

  return {
    block: makeBlock("Selection", selection, remainingBudget),
    warnings: [],
  };
}

async function resolveFile(
  app: App,
  settings: ObsigentSettings,
  file: TFile,
  label: string,
  remainingBudget: number,
): Promise<ReferenceResolution> {
  if (!isAllowedPath(settings, file.path)) {
    return { block: null, warnings: [`Context path is excluded: ${file.path}`] };
  }
  if (file.extension !== "md") {
    return { block: null, warnings: [`Context file is not markdown: ${file.path}`] };
  }

  return {
    block: makeBlock(label, await app.vault.cachedRead(file), remainingBudget),
    warnings: [],
  };
}

async function resolveFolder(
  app: App,
  settings: ObsigentSettings,
  target: string,
  remainingBudget: number,
): Promise<ReferenceResolution> {
  const folderPath = normalizePath(target);
  if (!isAllowedPath(settings, folderPath)) {
    return { block: null, warnings: [`Context path is excluded: ${folderPath}`] };
  }

  const folder = app.vault.getAbstractFileByPath(folderPath);
  if (!(folder instanceof TFolder) && !isFolderLike(folder)) {
    return { block: null, warnings: [`Could not resolve folder reference: @${target}`] };
  }

  const files = app.vault
    .getMarkdownFiles()
    .filter((file) => file.path.startsWith(`${folderPath}/`) && isAllowedPath(settings, file.path))
    .sort((first, second) => first.path.localeCompare(second.path))
    .slice(0, MAX_FOLDER_FILES);
  if (files.length === 0) {
    return { block: null, warnings: [`No readable markdown notes found in @${target}.`] };
  }

  const parts: string[] = [];
  let budget = remainingBudget;
  for (const file of files) {
    if (budget <= 0) {
      break;
    }
    const content = await app.vault.cachedRead(file);
    const block = makeBlock(`Folder note: ${file.path}`, content, budget);
    parts.push(`## ${block.label}\n${block.content}`);
    budget -= block.content.length;
  }

  return {
    block: makeBlock(`Folder: ${folderPath}`, parts.join("\n\n"), remainingBudget),
    warnings: [],
  };
}

type NoteResolution =
  | Readonly<{ status: "found"; file: TFile }>
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "ambiguous"; paths: readonly string[] }>;

function resolveNoteFile(app: App, settings: ObsigentSettings, target: string): NoteResolution {
  const activePath = app.workspace.getActiveFile()?.path ?? "";
  const linkedFile = app.metadataCache.getFirstLinkpathDest(target, activePath);
  if (linkedFile && isAllowedMarkdownFile(settings, linkedFile)) {
    return { status: "found", file: linkedFile };
  }

  const normalizedTarget = normalizeMarkdownPath(target).toLowerCase();
  const basenameTarget = stripMarkdownExtension(target).toLowerCase();
  const matches = app.vault
    .getMarkdownFiles()
    .filter((file) => isAllowedMarkdownFile(settings, file))
    .filter((file) => {
      const normalizedPath = normalizePath(file.path).toLowerCase();
      const basename = stripMarkdownExtension(file.name).toLowerCase();
      return normalizedPath === normalizedTarget || basename === basenameTarget;
    })
    .sort((first, second) => first.path.localeCompare(second.path));

  if (matches.length === 0) {
    return { status: "missing" };
  }
  if (matches.length > 1) {
    return { status: "ambiguous", paths: matches.map((file) => file.path) };
  }

  const file = matches[0];
  return file ? { status: "found", file } : { status: "missing" };
}

function createSubmittedRequest(
  prompt: string,
  blocks: readonly ResolvedContextBlock[],
  warnings: readonly string[],
): string {
  if (blocks.length === 0 && warnings.length === 0) {
    return prompt;
  }

  const context = blocks
    .map(
      (block) =>
        `<context_block label="${escapeAttribute(block.label)}">\n${block.content}\n</context_block>`,
    )
    .join("\n\n");
  const warningText = warnings.length
    ? `\n\nContext warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`
    : "";
  return `${context}${warningText}\n\nUser request:\n${prompt}`.trim();
}

function createDisplayRequest(
  prompt: string,
  blocks: readonly ResolvedContextBlock[],
  warnings: readonly string[],
): string {
  const labels = blocks.map((block) => `- ${block.label}${block.truncated ? " (truncated)" : ""}`);
  const warningLabels = warnings.map((warning) => `- ${warning}`);
  if (labels.length === 0 && warningLabels.length === 0) {
    return prompt;
  }

  return `${prompt}\n\nContext:\n${[...labels, ...warningLabels].join("\n")}`;
}

function makeBlock(label: string, content: string, remainingBudget: number): ResolvedContextBlock {
  const limit = Math.max(0, Math.min(MAX_CONTEXT_ITEM_CHARS, remainingBudget));
  if (content.length <= limit) {
    return { label, content, truncated: false };
  }

  const suffix = `\n\n[Truncated ${content.length - limit} characters]`;
  return {
    label,
    content: `${content.slice(0, Math.max(0, limit - suffix.length))}${suffix}`,
    truncated: true,
  };
}

function parseAtPathReferences(prompt: string): readonly ContextReference[] {
  const references: ContextReference[] = [];
  let cursor = 0;
  while (cursor < prompt.length) {
    const atIndex = prompt.indexOf("@", cursor);
    if (atIndex === -1) {
      break;
    }
    if (atIndex > 0 && !/\s/u.test(prompt[atIndex - 1] ?? "")) {
      cursor = atIndex + 1;
      continue;
    }

    const tail = prompt.slice(atIndex + 1);
    const markdownEnd = tail.toLowerCase().indexOf(".md");
    if (markdownEnd !== -1) {
      const target = tail.slice(0, markdownEnd + 3).trim();
      if (target) {
        references.push({ kind: "note", raw: `@${target}`, target });
        cursor = atIndex + target.length + 1;
        continue;
      }
    }

    const match = /^([^@\n\r\s]+)/u.exec(tail);
    const target = match?.[1]?.trim();
    if (target) {
      references.push({
        kind: looksLikeFolderReference(target) ? "folder" : "note",
        raw: `@${target}`,
        target,
      });
      cursor = atIndex + target.length + 1;
      continue;
    }

    cursor = atIndex + 1;
  }

  return references;
}

function addReference(
  references: ContextReference[],
  seen: Set<string>,
  reference: ContextReference,
): void {
  const key = `${reference.kind}:${reference.target.toLowerCase()}`;
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  references.push(reference);
}

function looksLikeFolderReference(target: string): boolean {
  return target.includes("/") && !target.toLowerCase().endsWith(".md");
}

function isAllowedMarkdownFile(settings: ObsigentSettings, file: TFile): boolean {
  return file.extension === "md" && isAllowedPath(settings, file.path);
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

function stripMarkdownExtension(path: string): string {
  const normalizedPath = normalizePath(path);
  const basename = normalizedPath.split("/").pop() ?? normalizedPath;
  return basename.replace(/\.md$/iu, "");
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function isFolderLike(value: unknown): value is TFolder {
  return Boolean(value && typeof value === "object" && "children" in value);
}
