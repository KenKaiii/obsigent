import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { App, TFile } from "obsidian";
import { z } from "zod";
import type { ObsigentSettings } from "./settings";

export type MarkdownSection = Readonly<{
  heading: string;
  level: number;
  startLine: number;
  endLine: number;
  content: string;
}>;

export type LinkRewrite = Readonly<{
  path: string;
  before: string;
  after: string;
}>;

export function createMaintenanceTools(app: App, settings: ObsigentSettings): AgentTool[] {
  return [
    listSectionsTool(app, settings),
    planReplaceSectionTool(app, settings),
    planInsertAtSectionTool(app, settings),
    planEditBlockTool(app, settings),
    planRenameNoteTool(app, settings),
    planMoveNoteTool(app, settings),
    planTrashNoteTool(app, settings),
  ];
}

export function parseMarkdownSections(content: string): readonly MarkdownSection[] {
  const lines = content.split("\n");
  const headingIndexes = lines.flatMap((line, index): number[] =>
    /^#{1,6}\s+\S/u.test(line) ? [index] : [],
  );
  return headingIndexes.map((startIndex, index) => {
    const line = lines[startIndex] ?? "";
    const match = /^(#{1,6})\s+(.+)$/u.exec(line);
    const nextStart = headingIndexes[index + 1] ?? lines.length;
    return {
      heading: match?.[2]?.trim() ?? line.trim(),
      level: match?.[1]?.length ?? 1,
      startLine: startIndex + 1,
      endLine: nextStart,
      content: lines.slice(startIndex, nextStart).join("\n"),
    };
  });
}

export function findBlockById(content: string, blockId: string): MarkdownSection | null {
  const normalizedBlockId = blockId.startsWith("^") ? blockId : `^${blockId}`;
  const lines = content.split("\n");
  const index = lines.findIndex((line) => line.includes(normalizedBlockId));
  if (index < 0) {
    return null;
  }
  return {
    heading: normalizedBlockId,
    level: 0,
    startLine: index + 1,
    endLine: index + 1,
    content: lines[index] ?? "",
  };
}

export function planLinkRewrite(
  files: readonly TFile[],
  contents: Readonly<Record<string, string>>,
  oldPath: string,
  newPath: string,
): readonly LinkRewrite[] {
  const oldBase = stripMarkdownExtension(oldPath.split("/").pop() ?? oldPath);
  const newBase = stripMarkdownExtension(newPath.split("/").pop() ?? newPath);
  return files
    .flatMap((file): LinkRewrite[] => {
      const before = contents[file.path] ?? "";
      const after = before
        .replaceAll(`[[${oldBase}]]`, `[[${newBase}]]`)
        .replaceAll(`[[${oldPath}]]`, `[[${newPath}]]`)
        .replaceAll(`](${oldPath})`, `](${newPath})`);
      return before === after ? [] : [{ path: file.path, before, after }];
    })
    .sort((first, second) => first.path.localeCompare(second.path));
}

function listSectionsTool(
  app: App,
  settings: ObsigentSettings,
): AgentTool<z.ZodObject<{ path: z.ZodString }>> {
  const parameters = z.object({ path: z.string().describe("Vault-relative markdown note path.") });
  return {
    name: "list_sections",
    description: "List markdown headings/sections in a note. Read-only.",
    parameters,
    execute: async ({ path }) => {
      const file = getAllowedMarkdownFile(app, settings, path);
      const sections = parseMarkdownSections(await app.vault.cachedRead(file));
      return sections.length
        ? sections
            .map(
              (section) =>
                `- ${"#".repeat(section.level)} ${section.heading} (lines ${section.startLine}-${section.endLine})`,
            )
            .join("\n")
        : "No sections found.";
    },
  } satisfies AgentTool<typeof parameters>;
}

function planReplaceSectionTool(
  app: App,
  settings: ObsigentSettings,
): AgentTool<z.ZodObject<{ path: z.ZodString; heading: z.ZodString; content: z.ZodString }>> {
  const parameters = z.object({
    path: z.string(),
    heading: z.string(),
    content: z.string(),
  });
  return {
    name: "plan_replace_section",
    description: "Preview replacing a markdown section. Does not write files.",
    parameters,
    execute: async ({ path, heading, content }) => {
      const file = getAllowedMarkdownFile(app, settings, path);
      const existing = await app.vault.cachedRead(file);
      const section = findSection(existing, heading);
      if (!section) {
        throw new Error(`Section not found: ${heading}`);
      }
      return `Preview replace ${file.path} lines ${section.startLine}-${section.endLine}\n\nBefore:\n${section.content}\n\nAfter:\n${content}`;
    },
  } satisfies AgentTool<typeof parameters>;
}

function planInsertAtSectionTool(
  app: App,
  settings: ObsigentSettings,
): AgentTool<z.ZodObject<{ path: z.ZodString; heading: z.ZodString; content: z.ZodString }>> {
  const parameters = z.object({ path: z.string(), heading: z.string(), content: z.string() });
  return {
    name: "plan_insert_at_section",
    description: "Preview inserting text at the end of a section. Does not write files.",
    parameters,
    execute: async ({ path, heading, content }) => {
      const file = getAllowedMarkdownFile(app, settings, path);
      const section = findSection(await app.vault.cachedRead(file), heading);
      if (!section) {
        throw new Error(`Section not found: ${heading}`);
      }
      return `Preview insert into ${file.path} after line ${section.endLine}\n\n${content}`;
    },
  } satisfies AgentTool<typeof parameters>;
}

function planEditBlockTool(
  app: App,
  settings: ObsigentSettings,
): AgentTool<z.ZodObject<{ path: z.ZodString; blockId: z.ZodString; content: z.ZodString }>> {
  const parameters = z.object({ path: z.string(), blockId: z.string(), content: z.string() });
  return {
    name: "plan_edit_block",
    description: "Preview replacing a block-id line. Does not write files.",
    parameters,
    execute: async ({ path, blockId, content }) => {
      const file = getAllowedMarkdownFile(app, settings, path);
      const block = findBlockById(await app.vault.cachedRead(file), blockId);
      if (!block) {
        throw new Error(`Block not found: ${blockId}`);
      }
      return `Preview edit block ${block.heading} in ${file.path} line ${block.startLine}\n\nBefore:\n${block.content}\n\nAfter:\n${content}`;
    },
  } satisfies AgentTool<typeof parameters>;
}

function planRenameNoteTool(
  app: App,
  settings: ObsigentSettings,
): AgentTool<z.ZodObject<{ path: z.ZodString; newPath: z.ZodString }>> {
  const parameters = z.object({ path: z.string(), newPath: z.string() });
  return {
    name: "plan_rename_note",
    description: "Preview note rename and likely link rewrites. Does not write files.",
    parameters,
    execute: async ({ path, newPath }) =>
      await planMoveLikeOperation(app, settings, path, newPath, "rename"),
  } satisfies AgentTool<typeof parameters>;
}

function planMoveNoteTool(
  app: App,
  settings: ObsigentSettings,
): AgentTool<z.ZodObject<{ path: z.ZodString; newPath: z.ZodString }>> {
  const parameters = z.object({ path: z.string(), newPath: z.string() });
  return {
    name: "plan_move_note",
    description: "Preview note move and likely link rewrites. Does not write files.",
    parameters,
    execute: async ({ path, newPath }) =>
      await planMoveLikeOperation(app, settings, path, newPath, "move"),
  } satisfies AgentTool<typeof parameters>;
}

function planTrashNoteTool(
  app: App,
  settings: ObsigentSettings,
): AgentTool<z.ZodObject<{ path: z.ZodString }>> {
  const parameters = z.object({ path: z.string() });
  return {
    name: "plan_trash_note",
    description: "Preview trashing a note and affected links. Does not write files.",
    parameters,
    execute: async ({ path }) => {
      const file = getAllowedMarkdownFile(app, settings, path);
      const incoming = Object.entries(app.metadataCache.resolvedLinks)
        .filter(([, links]) => (links[file.path] ?? 0) > 0)
        .map(([source, links]) => `- ${source} (${links[file.path] ?? 0})`)
        .sort();
      return `Preview trash ${file.path}. Incoming links:\n${incoming.length ? incoming.join("\n") : "None"}`;
    },
  } satisfies AgentTool<typeof parameters>;
}

async function planMoveLikeOperation(
  app: App,
  settings: ObsigentSettings,
  path: string,
  newPath: string,
  action: "move" | "rename",
): Promise<string> {
  const file = getAllowedMarkdownFile(app, settings, path);
  const normalizedNewPath = normalizeMarkdownPath(newPath);
  assertPathAllowed(settings, normalizedNewPath);
  const contents = Object.fromEntries(
    await Promise.all(
      getVisibleMarkdownFiles(app, settings).map(async (candidate) => [
        candidate.path,
        await app.vault.cachedRead(candidate),
      ]),
    ),
  );
  const rewrites = planLinkRewrite(
    getVisibleMarkdownFiles(app, settings),
    contents,
    file.path,
    normalizedNewPath,
  );
  return `Preview ${action} ${file.path} -> ${normalizedNewPath}. Link rewrite candidates: ${rewrites.length}${
    rewrites.length ? `\n${rewrites.map((rewrite) => `- ${rewrite.path}`).join("\n")}` : ""
  }`;
}

function findSection(content: string, heading: string): MarkdownSection | null {
  const normalizedHeading = heading.toLowerCase();
  return (
    parseMarkdownSections(content).find(
      (section) => section.heading.toLowerCase() === normalizedHeading,
    ) ?? null
  );
}

function getVisibleMarkdownFiles(app: App, settings: ObsigentSettings): TFile[] {
  return app.vault
    .getMarkdownFiles()
    .filter((file) => file.extension === "md" && isAllowedPath(settings, file.path))
    .sort((first, second) => first.path.localeCompare(second.path));
}

function getAllowedMarkdownFile(app: App, settings: ObsigentSettings, path: string): TFile {
  const normalizedPath = normalizeMarkdownPath(path);
  assertPathAllowed(settings, normalizedPath);
  const file = app.vault.getFileByPath(normalizedPath);
  if (!file || file.extension !== "md") {
    throw new Error(`Note not found: ${normalizedPath}`);
  }
  return file;
}

function assertPathAllowed(settings: ObsigentSettings, path: string): void {
  if (!isAllowedPath(settings, path)) {
    throw new Error(`Path is excluded: ${path}`);
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

function normalizeMarkdownPath(path: string): string {
  const normalizedPath = normalizePath(path);
  return normalizedPath.toLowerCase().endsWith(".md") ? normalizedPath : `${normalizedPath}.md`;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
}

function stripMarkdownExtension(path: string): string {
  return path.replace(/\.md$/iu, "");
}
