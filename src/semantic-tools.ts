import type { AgentTool } from "@kenkaiiii/gg-agent";
import { z } from "zod";
import type { SemanticIndex, SemanticSearchResult } from "./semantic-index";
import type { ObsigentSettings } from "./settings";

export function createSemanticTools(index: SemanticIndex, settings: ObsigentSettings): AgentTool[] {
  if (!settings.semanticSearchEnabled) {
    return [];
  }

  return [createSemanticSearchTool(index, settings), createFindSimilarNotesTool(index, settings)];
}

function createSemanticSearchTool(
  index: SemanticIndex,
  settings: ObsigentSettings,
): AgentTool<z.ZodObject<{ query: z.ZodString; limit: z.ZodOptional<z.ZodNumber> }>> {
  const parameters = z.object({
    query: z
      .string()
      .min(1)
      .describe("Conceptual or semantic query to search for in indexed notes."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("Maximum semantic matches to return."),
  });

  return {
    name: "semantic_search",
    description:
      "Search indexed vault notes by meaning rather than exact words. Use for conceptual questions. Read-only.",
    parameters,
    execute: async ({ query, limit = settings.semanticMaxResults }, context) => {
      await index.update(context.signal);
      const results = await index.search(
        query,
        Math.min(limit, settings.semanticMaxResults),
        context.signal,
      );
      return formatSemanticResults(results);
    },
  } satisfies AgentTool<typeof parameters>;
}

function createFindSimilarNotesTool(
  index: SemanticIndex,
  settings: ObsigentSettings,
): AgentTool<z.ZodObject<{ path: z.ZodString; limit: z.ZodOptional<z.ZodNumber> }>> {
  const parameters = z.object({
    path: z.string().describe("Vault-relative markdown note path to use as the similarity source."),
    limit: z.number().int().min(1).max(20).optional().describe("Maximum related chunks to return."),
  });

  return {
    name: "find_similar_notes",
    description:
      "Find notes semantically similar to a source note path using the local vault index. Read-only.",
    parameters,
    execute: async ({ path, limit = settings.semanticMaxResults }, context) => {
      await index.update(context.signal);
      const results = index.findSimilarToPath(path, Math.min(limit, settings.semanticMaxResults));
      return formatSemanticResults(results);
    },
  } satisfies AgentTool<typeof parameters>;
}

export function formatSemanticResults(results: readonly SemanticSearchResult[]): string {
  if (results.length === 0) {
    return "No semantic matches found.";
  }

  return results
    .map((result) => {
      const heading = result.heading ? ` > ${result.heading}` : "";
      const lineRange =
        result.startLine === result.endLine
          ? `line ${result.startLine}`
          : `lines ${result.startLine}-${result.endLine}`;
      return `- ${result.path}${heading} (${lineRange}, score ${result.score.toFixed(3)}): ${result.snippet}`;
    })
    .join("\n");
}
