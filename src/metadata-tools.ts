import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { App, TFile } from "obsidian";
import { z } from "zod";
import type { ObsigentSettings } from "./settings";

export function createMetadataTools(app: App, settings: ObsigentSettings): AgentTool[] {
  const tools: AgentTool[] = [
    readFrontmatterTool(app, settings),
    listTagsTool(app, settings),
    searchByTagTool(app, settings),
  ];
  if (settings.safetyMode === "approve-writes") {
    tools.push(updateFrontmatterTool(app, settings));
  }
  return tools;
}

function readFrontmatterTool(
  app: App,
  settings: ObsigentSettings,
): AgentTool<z.ZodObject<{ path: z.ZodString }>> {
  const parameters = z.object({ path: z.string().describe("Vault-relative markdown note path.") });
  return {
    name: "read_frontmatter",
    description: "Read parsed frontmatter/properties for a markdown note. Read-only.",
    parameters,
    execute: ({ path }) => {
      const file = getAllowedMarkdownFile(app, settings, path);
      const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
      return JSON.stringify(frontmatter, null, 2);
    },
  } satisfies AgentTool<typeof parameters>;
}

function updateFrontmatterTool(
  app: App,
  settings: ObsigentSettings,
): AgentTool<
  z.ZodObject<{
    path: z.ZodString;
    key: z.ZodString;
    value: z.ZodUnknown;
    remove: z.ZodOptional<z.ZodBoolean>;
  }>
> {
  const parameters = z.object({
    path: z.string().describe("Vault-relative markdown note path."),
    key: z.string().min(1).describe("Frontmatter key to set or remove."),
    value: z.unknown().describe("JSON-compatible value to set."),
    remove: z.boolean().optional().describe("Remove this key instead of setting it."),
  });
  return {
    name: "update_frontmatter",
    description: "Atomically update one frontmatter property after approval mode is enabled.",
    parameters,
    execute: async ({ path, key, value, remove = false }) => {
      if (settings.safetyMode !== "approve-writes") {
        throw new Error("Frontmatter updates require approve-writes safety mode.");
      }
      const file = getAllowedMarkdownFile(app, settings, path);
      await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
        if (remove) {
          delete frontmatter[key];
          return;
        }
        frontmatter[key] = value;
      });
      return `${remove ? "Removed" : "Updated"} frontmatter ${key} in ${file.path}.`;
    },
  } satisfies AgentTool<typeof parameters>;
}

function listTagsTool(
  app: App,
  settings: ObsigentSettings,
): AgentTool<z.ZodObject<{ limit: z.ZodOptional<z.ZodNumber> }>> {
  const parameters = z.object({ limit: z.number().int().min(1).max(200).optional() });
  return {
    name: "list_tags",
    description: "List tags found in visible markdown notes. Read-only.",
    parameters,
    execute: ({ limit = 100 }) => {
      const counts = new Map<string, number>();
      for (const file of getVisibleMarkdownFiles(app, settings)) {
        for (const tag of getFileTags(app, file)) {
          counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
      }
      const rows = [...counts.entries()]
        .sort(
          ([firstTag, firstCount], [secondTag, secondCount]) =>
            secondCount - firstCount || firstTag.localeCompare(secondTag),
        )
        .slice(0, limit)
        .map(([tag, count]) => `- ${tag} (${count})`);
      return rows.length ? rows.join("\n") : "No tags found.";
    },
  } satisfies AgentTool<typeof parameters>;
}

function searchByTagTool(
  app: App,
  settings: ObsigentSettings,
): AgentTool<z.ZodObject<{ tag: z.ZodString; limit: z.ZodOptional<z.ZodNumber> }>> {
  const parameters = z.object({
    tag: z.string().min(1).describe("Tag to find, with or without #."),
    limit: z.number().int().min(1).max(100).optional(),
  });
  return {
    name: "search_by_tag",
    description: "Find visible markdown notes containing a tag. Read-only.",
    parameters,
    execute: ({ tag, limit = 50 }) => {
      const normalizedTag = normalizeTag(tag);
      const rows = getVisibleMarkdownFiles(app, settings)
        .filter((file) => getFileTags(app, file).includes(normalizedTag))
        .slice(0, limit)
        .map((file) => `- ${file.path}`);
      return rows.length ? rows.join("\n") : `No notes found with ${normalizedTag}.`;
    },
  } satisfies AgentTool<typeof parameters>;
}

function getFileTags(app: App, file: TFile): readonly string[] {
  const cache = app.metadataCache.getFileCache(file);
  const inlineTags = (cache?.tags ?? []).flatMap((tag): string[] =>
    tag.tag ? [normalizeTag(tag.tag)] : [],
  );
  const frontmatterTags = toStringArray(cache?.frontmatter?.tags ?? cache?.frontmatter?.tag).map(
    normalizeTag,
  );
  return [...new Set([...inlineTags, ...frontmatterTags])].sort((first, second) =>
    first.localeCompare(second),
  );
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item): string[] => (typeof item === "string" ? [item] : []));
  }
  return typeof value === "string" ? value.split(/[\s,]+/u).filter(Boolean) : [];
}

function getVisibleMarkdownFiles(app: App, settings: ObsigentSettings): TFile[] {
  return app.vault
    .getMarkdownFiles()
    .filter((file) => isAllowedMarkdownFile(settings, file))
    .sort((first, second) => first.path.localeCompare(second.path));
}

function getAllowedMarkdownFile(app: App, settings: ObsigentSettings, path: string): TFile {
  const normalizedPath = normalizeMarkdownPath(path);
  const file = app.vault.getFileByPath(normalizedPath);
  if (!file || !isAllowedMarkdownFile(settings, file)) {
    throw new Error(`Note not found or excluded: ${normalizedPath}`);
  }
  return file;
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

function normalizeTag(tag: string): string {
  const trimmed = tag.trim();
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
}

function normalizeMarkdownPath(path: string): string {
  const normalizedPath = normalizePath(path);
  return normalizedPath.toLowerCase().endsWith(".md") ? normalizedPath : `${normalizedPath}.md`;
}
