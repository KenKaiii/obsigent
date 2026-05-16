# Obsigent

Obsigent is a local-first AI chat sidebar for Obsidian.

It lives inside your vault and can help you read notes, search around, make new notes, edit existing ones, attach files, and look things up on the web when you need fresh info.

It is meant to feel like a small agent sitting next to your notes — not a whole separate coding setup.

## What it can do

- Chat with a local model through Ollama, or an optional OpenAI-compatible endpoint
- Read, lexical-search, and semantic-search your vault
- Create notes and open them right away
- Suggest edits with a preview before changing existing notes
- Undo recent changes it made
- Attach images, PDFs, docs, spreadsheets, markdown, JSON, CSV, and text files
- Search and fetch web pages for current info
- Inspect tags, frontmatter, backlinks, broken links, tasks, and safe broad-edit previews

## Safety model

Obsigent keeps vault operations visible and conservative. Existing-note writes require approval, broad operations start as previews/plans, excluded folders are respected, and recent Obsigent changes can be reverted.

## Privacy model

Ollama is the default path for chat and embeddings. Cloud/OpenAI-compatible providers and MCP servers are opt-in settings, so vault content is not sent outside your machine unless you configure those integrations.

## Quick vibe

Private by default, useful in the sidebar, and built for people who want an AI helper directly in Obsidian.

More from me: https://www.youtube.com/@kenkaidoesai
