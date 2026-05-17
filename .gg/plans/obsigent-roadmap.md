# Obsigent Capability Roadmap Plan

## Objective

Turn Obsigent from a local Ollama chat sidebar with safe note tools into a competitive Obsidian vault agent while preserving its differentiators: local-first defaults, in-app UX, visible writes, approval gates, and undo.

## Current Baseline

- `src/local-agent.ts` creates one Ollama-backed `Agent` with vault tools and web tools.
- `src/vault-tools.ts` provides lexical list/read/search plus create/append/exact replace/overwrite/revert with approval-gated existing-note writes.
- `src/view.ts` provides sidebar chat, model picker/download, attachment upload, markdown rendering, stop/reset, and prompt submission.
- `src/settings.ts` only stores endpoint, chat model, safety mode, excluded folders, idle unload, and debug.
- Tests already cover attachments, Ollama conversion, model manager, settings shape, vault tools, local agent prompt wrapping, and web tools.

## Product Direction

Prioritize capabilities that make Obsigent feel smarter inside Obsidian before expanding into external-agent interoperability:

- First: semantic vault intelligence and explicit context selection.
- Second: editor-native apply/edit flows and graph-aware Obsidian tools.
- Third: durable memory, provider expansion, MCP bridge, and safer broad file operations.

## Milestone 1: Semantic Vault Intelligence

Add local semantic retrieval using Ollama embeddings and incremental indexing.

Implementation targets:

- Create `src/embedding-provider.ts` for Ollama `/api/embeddings` or `/api/embed` requests, with endpoint/model settings, abort support, stable error messages, and tests.
- Create `src/semantic-index.ts` for note chunking, metadata collection, vector storage, cosine similarity, deterministic ordering, and mtime/size invalidation.
- Store index data under plugin data if small; otherwise under a plugin-managed cache file in `.obsidian/plugins/obsigent/` or `.obsidian/cache/obsigent/`, with excluded-folder enforcement.
- Extend `ObsigentSettings` in `src/settings.ts` with `embeddingModel`, `semanticSearchEnabled`, `semanticChunkChars`, and `semanticMaxResults`.
- Add model catalog entries in `src/model-manager.ts` for embedding models such as `nomic-embed-text` and `mxbai-embed-large`, separate from vision/chat models.
- Add read-only tools in `src/vault-tools.ts` or a new `src/semantic-tools.ts`:
  - `index_vault`
  - `semantic_search`
  - `find_similar_notes`
  - `get_related_context`
- Update `SYSTEM_PROMPT` in `src/local-agent.ts` to prefer semantic search for conceptual questions and lexical search for exact strings.
- Add UI affordance in `src/view.ts`: index status, rebuild button, and optional related-notes section near the composer.

Key design choices:

- Start with local-only embeddings to keep privacy story clean.
- Chunk by headings when possible, falling back to fixed-size chunks with overlap.
- Return path, heading, snippet, score, and line-ish location where available.
- Never index excluded folders.

Risks:

- Large vault indexing can block UI if done synchronously.
- Ollama embedding endpoint shape varies by version/model.
- Stored vectors can bloat plugin data.

Verification:

- Unit tests for chunking, cache invalidation, cosine ranking, excluded folders, and tool result formatting.
- Manual test on a sample vault: conceptual query finds notes without exact keyword overlap.
- Run `pnpm check`, `pnpm test`, and `pnpm build`.

## Milestone 2: Context Selection and Mentions

Add explicit context injection so users can say exactly what the agent should use.

Implementation targets:

- Create `src/context-resolver.ts` with parsers/resolvers for:
  - `@Current note`
  - `@selection`
  - `@Note Name` / `[[Note Name]]`
  - `@folder/path`
  - later `#tag`
- Use Obsidian metadata/link resolution APIs where possible; fall back to vault path matching.
- Extend `src/view.ts` composer to detect `@` and show a lightweight autocomplete using existing files/folders.
- Extend `createSubmittedPrompt` in `src/view.ts` to prepend resolved context blocks before the user request.
- Include context labels in `createDisplayPrompt` without dumping full note text into the visible chat bubble.
- Add commands in `src/main.ts`:
  - `ask-obsigent-about-current-note`
  - `ask-obsigent-about-selection`
  - `add-current-note-to-obsigent-context`
- Keep all context resolution read-only and subject to excluded folders.

Key design choices:

- Resolve context before sending to the agent rather than relying on model tool calls for obvious user-selected context.
- Cap injected context and summarize truncation clearly.

Risks:

- Ambiguous note names can pick the wrong file.
- Huge folders can overfill context.
- Editor selection APIs differ between reading/markdown modes.

Verification:

- Unit tests for mention parsing, ambiguous matches, excluded paths, and truncation.
- Manual tests for current note, selected text, note mention, folder mention.
- Run `pnpm check`, `pnpm test`, and `pnpm build`.

## Milestone 3: Editor-Native Apply and Diff Flow

Make Obsigent useful for daily writing, not just chat.

Implementation targets:

- Add selected-text commands in `src/main.ts`:
  - `rewrite-selection-with-obsigent`
  - `summarize-selection-with-obsigent`
  - `append-obsigent-response-to-current-note`
- Add a structured edit proposal type in `src/chat.ts` or new `src/edit-proposals.ts`.
- Add a diff preview modal in `src/view.ts` or new `src/edit-modal.ts` using existing `Modal` patterns from `src/vault-tools.ts`.
- Add vault tool `propose_note_edit` or UI-only post-processing for assistant edit blocks.
- Prefer applying edits through existing approval/change-history functions so undo remains unified.
- Support selection replacement first; full-note and multi-section proposals later.

Key design choices:

- Keep exact-match replacement as the default safe write mechanism.
- Show before/after in-app before applying.
- Record all applied editor commands in `VaultChangeHistory`.

Risks:

- Parsing freeform assistant output into reliable edits is brittle.
- Applying to stale editor contents can corrupt user changes.

Verification:

- Unit tests for edit block parsing and stale-content guards.
- Manual test: select text, rewrite, inspect diff, approve, undo.
- Run `pnpm check`, `pnpm test`, and `pnpm build`.

## Milestone 4: Obsidian-Native Knowledge Tools

Expand beyond markdown content into Obsidian metadata and graph operations.

Implementation targets:

- Create `src/metadata-tools.ts` for frontmatter/tag operations:
  - `read_frontmatter`
  - `update_frontmatter`
  - `list_tags`
  - `search_by_tag`
- Use Obsidian `processFrontMatter` where possible for safer property updates.
- Create `src/graph-tools.ts` for links:
  - `get_backlinks`
  - `get_outlinks`
  - `find_orphan_notes`
  - `find_broken_links`
  - `traverse_note_graph`
- Create `src/task-tools.ts` for checklist extraction and daily/weekly routines:
  - `list_open_tasks`
  - `daily_review`
  - `weekly_rollup_context`
- Register these tools in `LocalAgentRuntime.createTools` based on settings and safety mode.
- Update status labels in `src/view.ts` for new tools.

Key design choices:

- Keep metadata and graph tools read-only first, except frontmatter update behind approval.
- Avoid vault-wide mutation until link-aware rename/move is implemented.

Risks:

- Obsidian metadata cache may be stale or incomplete.
- Frontmatter formatting preservation can be imperfect.

Verification:

- Unit tests with mocked metadata cache and vault files.
- Manual tests on notes with aliases, tags, nested tags, backlinks, and broken links.
- Run `pnpm check`, `pnpm test`, and `pnpm build`.

## Milestone 5: Persistent Chat and Memory

Let Obsigent maintain useful continuity without silently exfiltrating or mutating user knowledge.

Implementation targets:

- Extend `ChatMessage` in `src/chat.ts` with stable IDs, timestamps, optional metadata, and serialization helpers.
- Add settings in `src/settings.ts`: `persistChatHistory`, `maxStoredChats`, `memoryEnabled`, `memoryNotePath`.
- Persist chat sessions via plugin `loadData`/`saveData` in `src/main.ts`, not only in `ObsigentView` memory.
- Add commands/UI for new chat, load prior chat, delete chat, save chat as markdown.
- Add memory tools behind approval:
  - `read_memory`
  - `propose_memory_update`
  - `append_memory`
- Make memory note path excluded-folder aware and visible to user.

Key design choices:

- Default memory off or clearly disclosed on first use.
- Treat memory writes like note writes: preview, approve, record, revert.

Risks:

- Users may find persistent memory creepy if not transparent.
- Chat logs can grow quickly.

Verification:

- Unit tests for chat serialization/migration and memory path guards.
- Manual restart test: chat history reloads; memory can be inspected and cleared.
- Run `pnpm check`, `pnpm test`, and `pnpm build`.

## Milestone 6: Provider Flexibility

Allow stronger cloud models or other local servers while retaining Ollama-first defaults.

Implementation targets:

- Refactor provider selection in `src/local-agent.ts` around a provider config type.
- Add `provider`, `openAiCompatibleEndpoint`, `apiKeyStorageMode`, `chatModel`, `visionModel`, and `embeddingProvider` settings.
- Add an OpenAI-compatible provider adapter, preferably through existing `@kenkaiiii/gg-ai` registry patterns.
- Keep API keys out of vault notes; store via plugin data initially, with clear warning and future secure-storage option if available.
- Update `src/view.ts` model picker to distinguish chat, vision, and embedding models.
- Update onboarding copy to position Ollama as default and cloud providers as optional.

Key design choices:

- OpenAI-compatible first covers OpenRouter, LM Studio, LocalAI, vLLM, and many hosted gateways.
- Do not add every vendor-specific SDK until there is clear need.

Risks:

- API key storage in Obsidian plugin data is not ideal.
- Tool-calling schemas vary between providers.

Verification:

- Unit tests for provider config validation and request conversion.
- Manual smoke tests with Ollama and one OpenAI-compatible endpoint.
- Run `pnpm check`, `pnpm test`, and `pnpm build`.

## Milestone 7: MCP Bridge

Expose Obsigent’s safe vault capabilities to external agents and optionally consume external MCP tools.

Implementation targets:

- Phase A, MCP client:
  - Add settings for local MCP servers.
  - Add a small MCP client wrapper module, likely `src/mcp-client.ts`.
  - Convert selected MCP tools into `AgentTool`s for the local agent.
- Phase B, MCP server:
  - Create an optional local server process or in-plugin HTTP/SSE endpoint if feasible in Obsidian.
  - Expose existing safe vault tools with typed schemas and safety annotations where supported.
  - Reuse excluded folders, safety mode, approval gates, and audit history.
- Add security documentation and explicit opt-in settings.

Key design choices:

- MCP server should be disabled by default.
- Bind to localhost only and require a token for HTTP transport.
- Consider shipping MCP server as a separate package if Obsidian runtime limitations make in-plugin serving fragile.

Risks:

- MCP transport and packaging add significant complexity.
- Exposing vault tools externally increases security burden.

Verification:

- Unit tests for schema conversion and permission checks.
- Manual test from Claude Desktop or Cursor against a test vault.
- Security checklist: localhost bind, token, excluded paths, write approvals.
- Run `pnpm check`, `pnpm test`, and `pnpm build`.

## Milestone 8: Safer Broad File Operations and Product Polish

Add maintenance-grade operations once retrieval, context, and safety foundations are strong.

Implementation targets:

- Add section/block edits:
  - `list_sections`
  - `replace_section`
  - `insert_at_section`
  - `edit_block`
- Add link-aware operations:
  - `rename_note`
  - `move_note`
  - `trash_note`
- Rewrite wikilinks, markdown links, and canvas references where applicable.
- Add persistent audit log beyond in-memory `VaultChangeHistory`.
- Add onboarding checks: Ollama reachable, model installed, embedding model installed, index health.
- Improve README with screenshots, privacy model, safety model, roadmap, and comparison positioning.
- Prepare community plugin release assets and changelog discipline.

Key design choices:

- Trash, do not permanently delete, unless explicit typed confirmation is added.
- Link rewrites must show preview and affected-file count before applying.

Risks:

- Vault-wide link rewrite bugs are high-impact.
- Canvas/Bases formats may change.

Verification:

- Unit tests for heading parsing, block ID parsing, link rewrite planning, and no-op safety.
- Manual test in throwaway vault with wikilinks, aliases, embeds, markdown links, and canvas.
- Run `pnpm check`, `pnpm test`, and `pnpm build`.

## Recommended First Execution Slice

Build Milestone 1 in a minimal but complete form:

- Embedding provider.
- Semantic index with in-memory plus persisted cache.
- `semantic_search` and `find_similar_notes` tools.
- Settings defaults.
- Tests.
- Basic UI index status/rebuild command.

Then build Milestone 2 current-note/current-selection context before folder/tag autocomplete. This creates an immediately visible product leap without touching risky write paths.

## Open Questions

- Should vector cache live in plugin data, plugin directory, or `.obsidian/cache/obsigent/`?
- Should semantic indexing run automatically, manually, or both?
- Should memory be off by default until there is a first-run disclosure?
- Should MCP server ship inside this plugin or as a sibling npm package?
- Which exact embedding model should be the default for install size and quality?

## Steps

1. Implement Ollama embedding support in `src/embedding-provider.ts`, add embedding settings in `src/settings.ts`, and add unit tests for request/response/error handling.
2. Implement semantic chunking, vector ranking, and cache invalidation in `src/semantic-index.ts`, with tests for heading chunks, excluded folders, deterministic ordering, and stale-file updates.
3. Add `semantic_search` and `find_similar_notes` tools via `src/semantic-tools.ts`, register them in `src/local-agent.ts`, update the system prompt and tool status labels, and test tool outputs.
4. Add a minimal semantic index UI/command in `src/view.ts` and `src/main.ts` for index status and manual rebuild, then verify indexing on a sample vault.
5. Implement `src/context-resolver.ts` for current note, current selection, note mentions, and folder mentions with path exclusion, ambiguity, and truncation tests.
6. Wire context resolution into `src/view.ts` prompt submission and display formatting, then add `ask current note` and `ask selection` commands in `src/main.ts`.
7. Add editor-native selection rewrite/summarize commands, an edit proposal parser, and a diff approval modal that applies through existing change-history write paths.
8. Add frontmatter, tag, backlink, outlink, orphan, broken-link, graph traversal, and task review tools in new metadata/graph/task modules, with mocked Obsidian API tests.
9. Add persistent chat history and optional memory note support with transparent settings, approval-gated memory writes, restart tests, and clear/delete controls.
10. Refactor provider configuration to support OpenAI-compatible chat/vision/embedding endpoints while keeping Ollama defaults and tests for provider selection.
11. Add opt-in MCP client support, then evaluate and implement an opt-in localhost/token-protected MCP server or split-package server that reuses Obsigent permissions.
12. Add section/block edits, link-aware rename/move/trash, persistent audit log, onboarding health checks, README/security docs, and community plugin release polish.
