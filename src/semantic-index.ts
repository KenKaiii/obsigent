import type { App, TFile } from "obsidian";
import type { ObsigentSettings } from "./settings";

const INDEX_VERSION = 1;
const FIXED_CHUNK_OVERLAP = 150;
const MIN_CHUNK_CHARS = 200;

export type EmbedTexts = (
  texts: readonly string[],
  signal?: AbortSignal,
) => Promise<readonly (readonly number[])[]>;

export type SemanticChunk = Readonly<{
  id: string;
  path: string;
  heading: string | null;
  text: string;
  snippet: string;
  startLine: number;
  endLine: number;
}>;

export type IndexedSemanticChunk = SemanticChunk &
  Readonly<{
    embedding: readonly number[];
  }>;

export type SemanticSearchResult = SemanticChunk &
  Readonly<{
    score: number;
  }>;

export type SemanticFileEntry = Readonly<{
  path: string;
  mtime: number;
  size: number;
  chunks: readonly IndexedSemanticChunk[];
}>;

export type SemanticIndexSnapshot = Readonly<{
  version: number;
  embeddingModel: string;
  chunkChars: number;
  files: readonly SemanticFileEntry[];
}>;

export type SemanticIndexStatus = Readonly<{
  noteCount: number;
  chunkCount: number;
  embeddingModel: string;
  chunkChars: number;
}>;

export type SemanticIndexOptions = Readonly<{
  app: App;
  settings: ObsigentSettings;
  embedTexts: EmbedTexts;
  snapshot?: SemanticIndexSnapshot;
}>;

export class SemanticIndex {
  private readonly filesByPath = new Map<string, SemanticFileEntry>();

  public constructor(private readonly options: SemanticIndexOptions) {
    if (options.snapshot) {
      this.loadSnapshot(options.snapshot);
    }
  }

  public getStatus(): SemanticIndexStatus {
    const files = [...this.filesByPath.values()];
    return {
      noteCount: files.length,
      chunkCount: files.reduce((total, file) => total + file.chunks.length, 0),
      embeddingModel: this.options.settings.embeddingModel,
      chunkChars: this.options.settings.semanticChunkChars,
    };
  }

  public toSnapshot(): SemanticIndexSnapshot {
    return {
      version: INDEX_VERSION,
      embeddingModel: this.options.settings.embeddingModel,
      chunkChars: this.options.settings.semanticChunkChars,
      files: [...this.filesByPath.values()].sort((first, second) =>
        first.path.localeCompare(second.path),
      ),
    };
  }

  public async rebuild(signal?: AbortSignal): Promise<SemanticIndexStatus> {
    this.filesByPath.clear();
    return await this.update(signal);
  }

  public async update(signal?: AbortSignal): Promise<SemanticIndexStatus> {
    const nextFiles = new Map<string, SemanticFileEntry>();
    const files = getVisibleMarkdownFiles(this.options.app, this.options.settings);

    for (const file of files) {
      signal?.throwIfAborted();
      const existing = this.filesByPath.get(file.path);
      if (existing && isFreshEntry(existing, file)) {
        nextFiles.set(file.path, existing);
        continue;
      }

      const content = await this.options.app.vault.cachedRead(file);
      const chunks = chunkMarkdown({
        path: file.path,
        content,
        chunkChars: this.options.settings.semanticChunkChars,
      });
      const embeddings = chunks.length
        ? await this.options.embedTexts(
            chunks.map((chunk) => chunk.text),
            signal,
          )
        : [];
      if (embeddings.length !== chunks.length) {
        throw new Error(
          `Embedding provider returned ${embeddings.length} vectors for ${chunks.length} chunks in ${file.path}.`,
        );
      }

      nextFiles.set(file.path, {
        path: file.path,
        mtime: file.stat.mtime,
        size: file.stat.size,
        chunks: chunks.map((chunk, index) => ({
          ...chunk,
          embedding: embeddings[index] ?? [],
        })),
      });
    }

    this.filesByPath.clear();
    for (const [path, entry] of [...nextFiles.entries()].sort(([first], [second]) =>
      first.localeCompare(second),
    )) {
      this.filesByPath.set(path, entry);
    }
    return this.getStatus();
  }

  public async search(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SemanticSearchResult[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const [queryEmbedding] = await this.options.embedTexts([normalizedQuery], signal);
    if (!queryEmbedding) {
      throw new Error("Embedding provider did not return a query embedding.");
    }

    return rankChunks(this.getChunks(), queryEmbedding, limit);
  }

  public findSimilarToPath(path: string, limit: number): SemanticSearchResult[] {
    const normalizedPath = normalizeMarkdownPath(path);
    const source = this.filesByPath.get(normalizedPath);
    if (!source) {
      throw new Error(`Note is not indexed: ${normalizedPath}`);
    }

    const sourceEmbedding = averageVectors(source.chunks.map((chunk) => chunk.embedding));
    return rankChunks(
      this.getChunks().filter((chunk) => chunk.path !== normalizedPath),
      sourceEmbedding,
      limit,
    );
  }

  private getChunks(): readonly IndexedSemanticChunk[] {
    return [...this.filesByPath.values()].flatMap((file) => [...file.chunks]);
  }

  private loadSnapshot(snapshot: SemanticIndexSnapshot): void {
    if (
      snapshot.version !== INDEX_VERSION ||
      snapshot.embeddingModel !== this.options.settings.embeddingModel ||
      snapshot.chunkChars !== this.options.settings.semanticChunkChars
    ) {
      return;
    }

    for (const file of [...snapshot.files].sort((first, second) =>
      first.path.localeCompare(second.path),
    )) {
      if (isAllowedPath(this.options.settings, file.path)) {
        this.filesByPath.set(file.path, file);
      }
    }
  }
}

export type ChunkMarkdownInput = Readonly<{
  path: string;
  content: string;
  chunkChars: number;
}>;

export function chunkMarkdown(input: ChunkMarkdownInput): readonly SemanticChunk[] {
  const chunkChars = Math.max(MIN_CHUNK_CHARS, input.chunkChars);
  const lines = input.content.split("\n");
  const sections = splitIntoHeadingSections(lines);
  return sections.flatMap((section, sectionIndex) =>
    splitSectionIntoChunks({
      path: input.path,
      section,
      sectionIndex,
      chunkChars,
    }),
  );
}

export function cosineSimilarity(first: readonly number[], second: readonly number[]): number {
  const length = Math.min(first.length, second.length);
  if (length === 0) {
    return 0;
  }

  let dot = 0;
  let firstMagnitude = 0;
  let secondMagnitude = 0;
  for (let index = 0; index < length; index += 1) {
    const firstValue = first[index] ?? 0;
    const secondValue = second[index] ?? 0;
    dot += firstValue * secondValue;
    firstMagnitude += firstValue * firstValue;
    secondMagnitude += secondValue * secondValue;
  }

  if (firstMagnitude === 0 || secondMagnitude === 0) {
    return 0;
  }
  return dot / (Math.sqrt(firstMagnitude) * Math.sqrt(secondMagnitude));
}

function rankChunks(
  chunks: readonly IndexedSemanticChunk[],
  queryEmbedding: readonly number[],
  limit: number,
): SemanticSearchResult[] {
  return chunks
    .map((chunk) => ({
      id: chunk.id,
      path: chunk.path,
      heading: chunk.heading,
      text: chunk.text,
      snippet: chunk.snippet,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }))
    .sort((first, second) => {
      const scoreOrder = second.score - first.score;
      if (scoreOrder !== 0) {
        return scoreOrder;
      }
      const pathOrder = first.path.localeCompare(second.path);
      if (pathOrder !== 0) {
        return pathOrder;
      }
      return first.startLine - second.startLine;
    })
    .slice(0, Math.max(0, limit));
}

type HeadingSection = Readonly<{
  heading: string | null;
  text: string;
  startLine: number;
  endLine: number;
}>;

function splitIntoHeadingSections(lines: readonly string[]): readonly HeadingSection[] {
  const headingIndexes = lines.flatMap((line, index): number[] =>
    isHeadingLine(line) ? [index] : [],
  );
  if (headingIndexes.length === 0) {
    return [
      {
        heading: null,
        text: lines.join("\n").trim(),
        startLine: 1,
        endLine: lines.length,
      },
    ].filter((section) => section.text.length > 0);
  }

  const sections: HeadingSection[] = [];
  if ((headingIndexes[0] ?? 0) > 0) {
    const prefaceEnd = (headingIndexes[0] ?? 1) - 1;
    const text = lines
      .slice(0, prefaceEnd + 1)
      .join("\n")
      .trim();
    if (text) {
      sections.push({ heading: null, text, startLine: 1, endLine: prefaceEnd + 1 });
    }
  }

  for (let index = 0; index < headingIndexes.length; index += 1) {
    const startIndex = headingIndexes[index] ?? 0;
    const nextStartIndex = headingIndexes[index + 1] ?? lines.length;
    const text = lines.slice(startIndex, nextStartIndex).join("\n").trim();
    if (!text) {
      continue;
    }

    sections.push({
      heading: parseHeading(lines[startIndex] ?? ""),
      text,
      startLine: startIndex + 1,
      endLine: nextStartIndex,
    });
  }

  return sections;
}

type SplitSectionInput = Readonly<{
  path: string;
  section: HeadingSection;
  sectionIndex: number;
  chunkChars: number;
}>;

function splitSectionIntoChunks(input: SplitSectionInput): readonly SemanticChunk[] {
  if (input.section.text.length <= input.chunkChars) {
    return [
      toSemanticChunk(input, input.section.text, 0, input.section.startLine, input.section.endLine),
    ];
  }

  const chunks: SemanticChunk[] = [];
  let offset = 0;
  let chunkIndex = 0;
  while (offset < input.section.text.length) {
    const end = Math.min(input.section.text.length, offset + input.chunkChars);
    const text = input.section.text.slice(offset, end).trim();
    if (text) {
      const startLine =
        input.section.startLine + countNewlines(input.section.text.slice(0, offset));
      const endLine = startLine + countNewlines(text);
      chunks.push(toSemanticChunk(input, text, chunkIndex, startLine, endLine));
      chunkIndex += 1;
    }

    if (end >= input.section.text.length) {
      break;
    }
    offset = Math.max(end - FIXED_CHUNK_OVERLAP, offset + 1);
  }

  return chunks;
}

function toSemanticChunk(
  input: SplitSectionInput,
  text: string,
  chunkIndex: number,
  startLine: number,
  endLine: number,
): SemanticChunk {
  const id = `${input.path}:${input.sectionIndex}:${chunkIndex}:${startLine}`;
  return {
    id,
    path: input.path,
    heading: input.section.heading,
    text,
    snippet: makeSnippet(text),
    startLine,
    endLine,
  };
}

function averageVectors(vectors: readonly (readonly number[])[]): readonly number[] {
  const first = vectors[0];
  if (!first) {
    return [];
  }

  const totals = new Array<number>(first.length).fill(0);
  for (const vector of vectors) {
    for (let index = 0; index < totals.length; index += 1) {
      totals[index] = (totals[index] ?? 0) + (vector[index] ?? 0);
    }
  }
  return totals.map((total) => total / vectors.length);
}

function isFreshEntry(entry: SemanticFileEntry, file: TFile): boolean {
  return (
    entry.path === file.path && entry.mtime === file.stat.mtime && entry.size === file.stat.size
  );
}

function getVisibleMarkdownFiles(app: App, settings: ObsigentSettings): TFile[] {
  return app.vault
    .getMarkdownFiles()
    .filter((file) => isAllowedPath(settings, file.path))
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

function normalizeMarkdownPath(path: string): string {
  const normalizedPath = normalizePath(path);
  return normalizedPath.toLowerCase().endsWith(".md") ? normalizedPath : `${normalizedPath}.md`;
}

function isHeadingLine(line: string): boolean {
  return /^#{1,6}\s+\S/u.test(line);
}

function parseHeading(line: string): string | null {
  const match = /^(#{1,6})\s+(.+)$/u.exec(line.trim());
  return match ? (match[2]?.trim() ?? null) : null;
}

function countNewlines(text: string): number {
  return text.match(/\n/gu)?.length ?? 0;
}

function makeSnippet(text: string): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length <= 240 ? compact : `${compact.slice(0, 240)}…`;
}
