import type { App, TFile } from "obsidian";
import type { ObsigentSettings } from "./settings";

export type MentionSuggestionKind = "special" | "note" | "folder";

export type MentionSuggestion = Readonly<{
  kind: MentionSuggestionKind;
  label: string;
  insertText: string;
  detail: string;
}>;

export type MentionQuery = Readonly<{
  start: number;
  end: number;
  query: string;
}>;

export type ResolvedMentionRange = Readonly<{
  start: number;
  end: number;
  text: string;
  kind: MentionSuggestionKind;
}>;

const SPECIAL_SUGGESTIONS: readonly MentionSuggestion[] = [
  { kind: "special", label: "Current note", insertText: "@Current note", detail: "Active note" },
  { kind: "special", label: "selection", insertText: "@selection", detail: "Selected editor text" },
];

export function getMentionQuery(value: string, cursor: number): MentionQuery | null {
  const beforeCursor = value.slice(0, cursor);
  const match = /(^|\s)@([^@\n\r]*)$/u.exec(beforeCursor);
  if (!match) {
    return null;
  }
  const rawQuery = match[2] ?? "";
  if (rawQuery.includes("]]") || rawQuery.length > 80) {
    return null;
  }
  return {
    start: beforeCursor.length - rawQuery.length - 1,
    end: cursor,
    query: rawQuery.trimStart(),
  };
}

export function getMentionSuggestions(
  app: App,
  settings: ObsigentSettings,
  query: string,
  limit = 8,
): readonly MentionSuggestion[] {
  const normalizedQuery = query.toLowerCase();
  const suggestions = [
    ...SPECIAL_SUGGESTIONS,
    ...getNoteSuggestions(app, settings),
    ...getFolderSuggestions(app, settings),
  ];
  return suggestions
    .filter((suggestion) => suggestion.label.toLowerCase().includes(normalizedQuery))
    .sort((first, second) => {
      const firstStarts = first.label.toLowerCase().startsWith(normalizedQuery) ? 0 : 1;
      const secondStarts = second.label.toLowerCase().startsWith(normalizedQuery) ? 0 : 1;
      if (firstStarts !== secondStarts) {
        return firstStarts - secondStarts;
      }
      const kindOrder = getKindOrder(first.kind) - getKindOrder(second.kind);
      if (kindOrder !== 0) {
        return kindOrder;
      }
      return first.label.localeCompare(second.label);
    })
    .slice(0, limit);
}

export function applyMentionSuggestion(
  value: string,
  mentionQuery: MentionQuery,
  suggestion: MentionSuggestion,
): string {
  const before = value.slice(0, mentionQuery.start);
  const after = value.slice(mentionQuery.end);
  const suffix = after.startsWith(" ") ? "" : " ";
  return `${before}${suggestion.insertText}${suffix}${after}`;
}

export function getResolvedMentionRanges(
  value: string,
  app: App,
  settings: ObsigentSettings,
): readonly ResolvedMentionRange[] {
  const knownMentions = new Map<string, MentionSuggestionKind>();
  for (const suggestion of [
    ...SPECIAL_SUGGESTIONS,
    ...getNoteSuggestions(app, settings),
    ...getFolderSuggestions(app, settings),
  ]) {
    knownMentions.set(suggestion.insertText, suggestion.kind);
  }

  const ranges: ResolvedMentionRange[] = [];
  for (const [mentionText, kind] of [...knownMentions.entries()].sort(
    ([first], [second]) => second.length - first.length,
  )) {
    const escapedMention = escapeRegExp(mentionText);
    const mentionPattern = new RegExp(`(^|\\s)(${escapedMention})(?=\\s|$)`, "gu");
    for (const match of value.matchAll(mentionPattern)) {
      const prefix = match[1] ?? "";
      const start = match.index + prefix.length;
      const end = start + mentionText.length;
      if (ranges.some((range) => start < range.end && end > range.start)) {
        continue;
      }
      ranges.push({ start, end, text: mentionText, kind });
    }
  }

  return ranges.sort((first, second) => first.start - second.start);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function getNoteSuggestions(app: App, settings: ObsigentSettings): readonly MentionSuggestion[] {
  return getVisibleMarkdownFiles(app, settings).map((file) => ({
    kind: "note",
    label: file.basename || stripMarkdownExtension(file.name),
    insertText: `@${file.path}`,
    detail: file.path,
  }));
}

function getFolderSuggestions(app: App, settings: ObsigentSettings): readonly MentionSuggestion[] {
  const folders = new Set<string>();
  for (const file of getVisibleMarkdownFiles(app, settings)) {
    const parts = file.path.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (isAllowedPath(settings, current)) {
        folders.add(current);
      }
    }
  }
  return [...folders]
    .sort((first, second) => first.localeCompare(second))
    .map((folder) => ({
      kind: "folder",
      label: folder,
      insertText: `@${folder}/`,
      detail: "Folder",
    }));
}

function getVisibleMarkdownFiles(app: App, settings: ObsigentSettings): TFile[] {
  return app.vault
    .getMarkdownFiles()
    .filter((file) => file.extension === "md" && isAllowedPath(settings, file.path))
    .sort((first, second) => first.path.localeCompare(second.path));
}

function getKindOrder(kind: MentionSuggestionKind): number {
  if (kind === "special") {
    return 0;
  }
  return kind === "note" ? 1 : 2;
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

function stripMarkdownExtension(path: string): string {
  return path.replace(/\.md$/iu, "");
}
