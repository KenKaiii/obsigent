import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { App, TFile } from "obsidian";
import { z } from "zod";
import type { ObsigentSettings } from "./settings";

export function createGraphTools(app: App, settings: ObsigentSettings): AgentTool[] {
  return [
    getBacklinksTool(app, settings),
    getOutlinksTool(app, settings),
    findOrphanNotesTool(app, settings),
    findBrokenLinksTool(app, settings),
  ];
}

function getBacklinksTool(
  app: App,
  settings: ObsigentSettings,
): AgentTool<z.ZodObject<{ path: z.ZodString }>> {
  const parameters = z.object({ path: z.string().describe("Vault-relative markdown note path.") });
  return {
    name: "get_backlinks",
    description: "List visible notes linking to a note. Read-only.",
    parameters,
    execute: ({ path }) => {
      const file = getAllowedMarkdownFile(app, settings, path);
      const rows = Object.entries(app.metadataCache.resolvedLinks)
        .filter(([source, links]) => isAllowedPath(settings, source) && (links[file.path] ?? 0) > 0)
        .sort(([first], [second]) => first.localeCompare(second))
        .map(([source, links]) => `- ${source} (${links[file.path] ?? 0})`);
      return rows.length ? rows.join("\n") : `No backlinks found for ${file.path}.`;
    },
  } satisfies AgentTool<typeof parameters>;
}

function getOutlinksTool(
  app: App,
  settings: ObsigentSettings,
): AgentTool<z.ZodObject<{ path: z.ZodString }>> {
  const parameters = z.object({ path: z.string().describe("Vault-relative markdown note path.") });
  return {
    name: "get_outlinks",
    description: "List resolved outlinks from a note. Read-only.",
    parameters,
    execute: ({ path }) => {
      const file = getAllowedMarkdownFile(app, settings, path);
      const rows = Object.entries(app.metadataCache.resolvedLinks[file.path] ?? {})
        .filter(([target]) => isAllowedPath(settings, target))
        .sort(([first], [second]) => first.localeCompare(second))
        .map(([target, count]) => `- ${target} (${count})`);
      return rows.length ? rows.join("\n") : `No outlinks found for ${file.path}.`;
    },
  } satisfies AgentTool<typeof parameters>;
}

function findOrphanNotesTool(
  app: App,
  settings: ObsigentSettings,
): AgentTool<z.ZodObject<{ limit: z.ZodOptional<z.ZodNumber> }>> {
  const parameters = z.object({ limit: z.number().int().min(1).max(200).optional() });
  return {
    name: "find_orphan_notes",
    description: "Find visible notes with no resolved inlinks and no resolved outlinks. Read-only.",
    parameters,
    execute: ({ limit = 100 }) => {
      const files = getVisibleMarkdownFiles(app, settings);
      const linkedTargets = new Set<string>();
      for (const [source, links] of Object.entries(app.metadataCache.resolvedLinks)) {
        if (!isAllowedPath(settings, source)) {
          continue;
        }
        for (const target of Object.keys(links)) {
          if (isAllowedPath(settings, target)) {
            linkedTargets.add(target);
          }
        }
      }
      const rows = files
        .filter(
          (file) =>
            !linkedTargets.has(file.path) &&
            Object.keys(app.metadataCache.resolvedLinks[file.path] ?? {}).length === 0,
        )
        .slice(0, limit)
        .map((file) => `- ${file.path}`);
      return rows.length ? rows.join("\n") : "No orphan notes found.";
    },
  } satisfies AgentTool<typeof parameters>;
}

function findBrokenLinksTool(
  app: App,
  settings: ObsigentSettings,
): AgentTool<z.ZodObject<{ limit: z.ZodOptional<z.ZodNumber> }>> {
  const parameters = z.object({ limit: z.number().int().min(1).max(200).optional() });
  return {
    name: "find_broken_links",
    description: "List unresolved wiki links from visible notes. Read-only.",
    parameters,
    execute: ({ limit = 100 }) => {
      const rows = Object.entries(app.metadataCache.unresolvedLinks)
        .filter(([source]) => isAllowedPath(settings, source))
        .flatMap(([source, links]) =>
          Object.entries(links).map(([target, count]) => `- ${source} -> ${target} (${count})`),
        )
        .sort((first, second) => first.localeCompare(second))
        .slice(0, limit);
      return rows.length ? rows.join("\n") : "No broken links found.";
    },
  } satisfies AgentTool<typeof parameters>;
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

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
}

function normalizeMarkdownPath(path: string): string {
  const normalizedPath = normalizePath(path);
  return normalizedPath.toLowerCase().endsWith(".md") ? normalizedPath : `${normalizedPath}.md`;
}
