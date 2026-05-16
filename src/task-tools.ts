import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { App, TFile } from "obsidian";
import { z } from "zod";
import type { ObsigentSettings } from "./settings";

export function createTaskTools(app: App, settings: ObsigentSettings): AgentTool[] {
  return [
    listOpenTasksTool(app, settings),
    dailyReviewTool(app, settings),
    weeklyRollupContextTool(app, settings),
  ];
}

function listOpenTasksTool(
  app: App,
  settings: ObsigentSettings,
): AgentTool<z.ZodObject<{ limit: z.ZodOptional<z.ZodNumber> }>> {
  const parameters = z.object({ limit: z.number().int().min(1).max(200).optional() });
  return {
    name: "list_open_tasks",
    description: "List unchecked markdown tasks from visible notes. Read-only.",
    parameters,
    execute: async ({ limit = 100 }) => {
      const rows: string[] = [];
      for (const file of getVisibleMarkdownFiles(app, settings)) {
        const content = await app.vault.cachedRead(file);
        const lines = content.split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          if (/^\s*- \[ \] /u.test(line)) {
            rows.push(`- ${file.path}:${index + 1} ${line.trim()}`);
          }
          if (rows.length >= limit) {
            return rows.join("\n");
          }
        }
      }
      return rows.length ? rows.join("\n") : "No open tasks found.";
    },
  } satisfies AgentTool<typeof parameters>;
}

function dailyReviewTool(
  app: App,
  settings: ObsigentSettings,
): AgentTool<z.ZodObject<{ limit: z.ZodOptional<z.ZodNumber> }>> {
  const parameters = z.object({ limit: z.number().int().min(1).max(50).optional() });
  return {
    name: "daily_review",
    description:
      "Build a concise read-only daily review context from recent-looking notes and open tasks.",
    parameters,
    execute: async ({ limit = 10 }) => {
      const files = getVisibleMarkdownFiles(app, settings).slice(-limit);
      const summaries = await Promise.all(
        files.map(
          async (file) => `## ${file.path}\n${makeSnippet(await app.vault.cachedRead(file))}`,
        ),
      );
      return summaries.length ? summaries.join("\n\n") : "No notes available for daily review.";
    },
  } satisfies AgentTool<typeof parameters>;
}

function weeklyRollupContextTool(
  app: App,
  settings: ObsigentSettings,
): AgentTool<
  z.ZodObject<{ folder: z.ZodOptional<z.ZodString>; limit: z.ZodOptional<z.ZodNumber> }>
> {
  const parameters = z.object({
    folder: z.string().optional().describe("Optional folder to roll up."),
    limit: z.number().int().min(1).max(50).optional(),
  });
  return {
    name: "weekly_rollup_context",
    description: "Collect snippets from visible notes for a weekly rollup. Read-only.",
    parameters,
    execute: async ({ folder, limit = 20 }) => {
      const normalizedFolder = folder ? normalizePath(folder) : "";
      const files = getVisibleMarkdownFiles(app, settings)
        .filter((file) => !normalizedFolder || file.path.startsWith(`${normalizedFolder}/`))
        .slice(0, limit);
      const snippets = await Promise.all(
        files.map(
          async (file) => `## ${file.path}\n${makeSnippet(await app.vault.cachedRead(file))}`,
        ),
      );
      return snippets.length ? snippets.join("\n\n") : "No notes found for weekly rollup.";
    },
  } satisfies AgentTool<typeof parameters>;
}

function getVisibleMarkdownFiles(app: App, settings: ObsigentSettings): TFile[] {
  return app.vault
    .getMarkdownFiles()
    .filter((file) => file.extension === "md" && isAllowedPath(settings, file.path))
    .sort((first, second) => first.path.localeCompare(second.path));
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

function makeSnippet(content: string): string {
  const compact = content.replace(/\s+/gu, " ").trim();
  return compact.length <= 500 ? compact : `${compact.slice(0, 500)}…`;
}
