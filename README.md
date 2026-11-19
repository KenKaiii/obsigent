# Obsigent

Obsigent is a local-first AI chat sidebar for Obsidian.

It lives inside your vault and can help you read notes, search around, make new notes, edit existing ones, attach files, and look things up on the web when you need fresh info.

It is meant to feel like a small agent sitting next to your notes — not a whole separate coding setup.

> [!TIP]
> **Want to build your own apps with AI?**
> - **Raid+:** land your first paying client in 90 days or your money back, plus private tools you won't find anywhere else: [skool.com/kenkai](https://www.skool.com/kenkai)
> - **Want it built for you?** [work.kenkais.com](https://work.kenkais.com/)

## What it can do

- Chat with a local model through Ollama, or an optional OpenAI-compatible endpoint
- Read, lexical-search, and semantic-search your vault
- Create notes and open them right away
- Suggest edits with a preview before changing existing notes
- Undo recent changes it made
- Attach images, PDFs, docs, spreadsheets, markdown, JSON, CSV, and text files
- Search and fetch web pages for current info
- Inspect tags, frontmatter, backlinks, broken links, tasks, and safe broad-edit previews

## Setup

1. Install [Ollama](https://ollama.com/download) on desktop, or configure an OpenAI-compatible endpoint in Obsidian settings.
2. Enable Obsigent in Obsidian.
3. Open **Settings → Obsigent** to choose a provider, model, safety mode, excluded folders, prompt templates, and project context.
4. For Ollama, use the model picker in the sidebar or run `pnpm prepare:gemma4` while developing locally.

API keys are stored with Obsidian SecretStorage when available. MCP server tokens should be entered through settings or stored as Obsidian secrets, not committed to your vault.

## Workflows

- Use prompt templates from the composer for repeated tasks like summaries, edits, and reviews.
- Configure project folders/tags to add NotebookLM-style project context hints to chats.
- Use command palette actions for current-note, selection, rewrite, summarize, and append workflows.
- Attach supported images, PDFs, DOCX, Markdown, JSON, CSV, and text files. Spreadsheet attachments are intentionally disabled until a maintained safe parser is used.

## Local development

```bash
pnpm install
pnpm dev
```

To copy assets into a test vault while watching `main.js`:

```bash
OBSIGENT_PLUGIN_DIR="/path/to/Vault/.obsidian/plugins/obsigent" pnpm dev:vault
```

Run checks before release:

```bash
pnpm check
pnpm test
pnpm build
pnpm release:validate
pnpm package
```

GitHub Actions run CI on pushes/PRs and package release assets from tags.

## Mobile notes

Obsigent is not marked desktop-only, but local Ollama normally runs on a desktop or server. On mobile, use a reachable remote/local-network endpoint, consider disabling semantic indexing for large vaults, and avoid large attachments on constrained devices.

## Safety model

Obsigent keeps vault operations visible and conservative. Existing-note writes require approval, broad operations start as previews/plans, excluded folders are respected, and recent Obsigent changes can be reverted.

## Privacy model

Ollama is the default path for chat and embeddings. Cloud/OpenAI-compatible providers and MCP servers are opt-in settings, so vault content is not sent outside your machine unless you configure those integrations.

## Quick vibe

Private by default, useful in the sidebar, and built for people who want an AI helper directly in Obsidian.

More from me: https://www.youtube.com/@kenkaidoesai
