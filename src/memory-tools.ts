import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { App, TFile } from "obsidian";
import { z } from "zod";
import type { ObsigentSettings } from "./settings";

export function createMemoryTools(app: App, settings: ObsigentSettings): AgentTool[] {
  if (!settings.memoryEnabled) {
    return [];
  }
  return [readMemoryTool(app, settings), appendMemoryTool(app, settings)];
}

function readMemoryTool(
  app: App,
  settings: ObsigentSettings,
): AgentTool<z.ZodObject<Record<string, never>>> {
  const parameters = z.object({});
  return {
    name: "read_memory",
    description: "Read the explicit Obsigent memory note. Read-only.",
    parameters,
    execute: async () => {
      const file = getMemoryFile(app, settings);
      if (!file) {
        return "No Obsigent memory note exists yet.";
      }
      return await app.vault.cachedRead(file);
    },
  } satisfies AgentTool<typeof parameters>;
}

function appendMemoryTool(
  app: App,
  settings: ObsigentSettings,
): AgentTool<z.ZodObject<{ content: z.ZodString }>> {
  const parameters = z.object({
    content: z.string().min(1).describe("Memory text to append after approval."),
  });
  return {
    name: "append_memory",
    description: "Append user-approved text to the explicit Obsigent memory note.",
    parameters,
    execute: async ({ content }) => {
      ensureMemoryPathAllowed(settings);
      const existing = getMemoryFile(app, settings);
      const entry = content.trim();
      if (!entry) {
        throw new Error("Memory content is empty.");
      }
      if (existing) {
        const before = await app.vault.cachedRead(existing);
        const separator = before.endsWith("\n") || before.length === 0 ? "" : "\n";
        await app.vault.modify(existing, `${before}${separator}${entry}\n`);
        return `Appended memory to ${existing.path}.`;
      }
      const file = await app.vault.create(settings.memoryNotePath, `${entry}\n`);
      return `Created memory note ${file.path}.`;
    },
  } satisfies AgentTool<typeof parameters>;
}

function getMemoryFile(app: App, settings: ObsigentSettings): TFile | null {
  ensureMemoryPathAllowed(settings);
  return app.vault.getFileByPath(settings.memoryNotePath);
}

function ensureMemoryPathAllowed(settings: ObsigentSettings): void {
  if (!isAllowedPath(settings, settings.memoryNotePath)) {
    throw new Error(`Memory path is excluded: ${settings.memoryNotePath}`);
  }
}

function isAllowedPath(settings: ObsigentSettings, path: string): boolean {
  const normalizedPath = path.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
  if (normalizedPath.includes("..")) {
    return false;
  }
  return !settings.excludedFolders.some((folder) => {
    const normalizedFolder = folder.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
    return normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}/`);
  });
}
