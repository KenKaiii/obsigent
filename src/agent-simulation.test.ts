import { Agent, type AgentTool } from "@kenkaiiii/gg-agent";
import {
  type AssistantMessage,
  type Message,
  type ProviderEntry,
  providerRegistry,
  type StreamOptions,
  type StreamResponse,
  StreamResult,
} from "@kenkaiiii/gg-ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

type SimulatedTurn = Readonly<{
  when: (messages: readonly Message[]) => boolean;
  message: AssistantMessage;
}>;

type SimulationResult = Readonly<{
  text: string;
  toolCalls: readonly string[];
}>;

type SimulationState = Readonly<{
  files: Record<string, string>;
  opened: string[];
}>;

function registerSimulationProvider(name: string, turns: readonly SimulatedTurn[]): void {
  const provider: ProviderEntry = {
    stream: (options: StreamOptions) =>
      new StreamResult(
        (async function* (): AsyncGenerator<{ type: "text_delta"; text: string }, StreamResponse> {
          const turn = turns.find((candidate) => candidate.when(options.messages));
          if (!turn) {
            throw new Error(`No simulated turn matched ${summarizeMessages(options.messages)}`);
          }
          const text = hasToolCall(turn.message) ? "" : getAssistantText(turn.message);
          if (text) {
            yield { type: "text_delta", text };
          }
          return {
            message: turn.message,
            stopReason: hasToolCall(turn.message) ? "tool_use" : "end_turn",
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        })(),
      ),
  };
  providerRegistry.register(name as never, provider);
}

function textMessage(text: string): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function toolMessage(
  name: string,
  args: Record<string, unknown>,
  id = `call-${name}`,
): AssistantMessage {
  return { role: "assistant", content: [{ type: "tool_call", id, name, args }] };
}

function hasToolCall(message: AssistantMessage): boolean {
  return (
    Array.isArray(message.content) && message.content.some((part) => part.type === "tool_call")
  );
}

function getAssistantText(message: AssistantMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .flatMap((part): string[] => (part.type === "text" ? [part.text] : []))
    .join("");
}

function hasToolResult(messages: readonly Message[], toolName: string): boolean {
  return messages.some(
    (message) =>
      message.role === "tool" &&
      message.content.some((result) => result.toolCallId.includes(toolName)),
  );
}

function summarizeMessages(messages: readonly Message[]): string {
  return messages.map((message) => message.role).join(",");
}

async function runSimulation(
  testName: string,
  turns: readonly SimulatedTurn[],
  prompt: string,
  tools: AgentTool[],
): Promise<SimulationResult> {
  const providerName = `obsigent-simulation-${testName}`;
  registerSimulationProvider(providerName, turns);
  const agent = new Agent({
    provider: providerName as never,
    model: "simulation",
    system: "Use tools to complete requests. Continue follow-up tasks from recent context.",
    tools,
    maxTurns: 8,
    maxTokens: 1000,
    temperature: 0,
  });

  let text = "";
  const toolCalls: string[] = [];
  for await (const event of agent.prompt(prompt)) {
    if (event.type === "text_delta") {
      text += event.text;
    }
    if (event.type === "tool_call_start") {
      toolCalls.push(event.name);
    }
  }

  return { text, toolCalls };
}

function makeTools(state: SimulationState): AgentTool[] {
  const emptyParameters = z.object({});
  const pathParameters = z.object({ path: z.string() });
  const createParameters = z.object({ path: z.string(), content: z.string() });
  const appendParameters = z.object({ path: z.string(), content: z.string() });
  const searchParameters = z.object({ query: z.string() });
  const fetchParameters = z.object({ url: z.string() });
  const replaceParameters = z.object({ path: z.string(), find: z.string(), replace: z.string() });
  const overwriteParameters = z.object({ path: z.string(), content: z.string() });
  const tagParameters = z.object({ tag: z.string() });
  const sectionParameters = z.object({ path: z.string(), heading: z.string() });

  return [
    {
      name: "web_search",
      description: "Search web.",
      parameters: searchParameters,
      execute: (args: unknown) => {
        const { query } = searchParameters.parse(args);
        return `Web search results for ${query}: Source A says AI agents launched today.`;
      },
    } satisfies AgentTool<typeof searchParameters>,
    {
      name: "web_fetch",
      description: "Fetch web page.",
      parameters: fetchParameters,
      execute: (args: unknown) => {
        const { url } = fetchParameters.parse(args);
        return `Fetched ${url}: detailed current AI news.`;
      },
    } satisfies AgentTool<typeof fetchParameters>,
    {
      name: "list_notes",
      description: "List notes.",
      parameters: emptyParameters,
      execute: () => Object.keys(state.files).sort().join("\n") || "No matching notes found.",
    } satisfies AgentTool<typeof emptyParameters>,
    {
      name: "read_note",
      description: "Read note.",
      parameters: pathParameters,
      execute: (args: unknown) => {
        const { path } = pathParameters.parse(args);
        return state.files[path] ?? `Note not found: ${path}`;
      },
    } satisfies AgentTool<typeof pathParameters>,
    {
      name: "search_notes",
      description: "Search notes.",
      parameters: searchParameters,
      execute: (args: unknown) => {
        const { query } = searchParameters.parse(args);
        return (
          Object.entries(state.files)
            .filter(([path, content]) => path.includes(query) || content.includes(query))
            .map(([path]) => `- ${path}: match`)
            .join("\n") || "No matching notes found."
        );
      },
    } satisfies AgentTool<typeof searchParameters>,
    {
      name: "open_note",
      description: "Open note.",
      parameters: pathParameters,
      execute: (args: unknown) => {
        const { path } = pathParameters.parse(args);
        if (!state.files[path]) {
          throw new Error(`Note not found: ${path}`);
        }
        state.opened.push(path);
        return `Opened ${path}.`;
      },
    } satisfies AgentTool<typeof pathParameters>,
    {
      name: "create_note",
      description: "Create note.",
      parameters: createParameters,
      execute: (args: unknown) => {
        const { path, content } = createParameters.parse(args);
        state.files[path] = content;
        state.opened.push(path);
        return `Created and opened ${path}. Change id: change-1.`;
      },
    } satisfies AgentTool<typeof createParameters>,
    {
      name: "append_note",
      description: "Append note.",
      parameters: appendParameters,
      execute: (args: unknown) => {
        const { path, content } = appendParameters.parse(args);
        state.files[path] = `${state.files[path] ?? ""}${content}`;
        state.opened.push(path);
        return `Opened and appended to ${path}. Change id: change-2.`;
      },
    } satisfies AgentTool<typeof appendParameters>,
    {
      name: "replace_in_note",
      description: "Replace in note.",
      parameters: replaceParameters,
      execute: (args: unknown) => {
        const { path, find, replace } = replaceParameters.parse(args);
        state.files[path] = (state.files[path] ?? "").replace(find, replace);
        state.opened.push(path);
        return `Opened and edited ${path}. Change id: change-3.`;
      },
    } satisfies AgentTool<typeof replaceParameters>,
    {
      name: "overwrite_note",
      description: "Overwrite note.",
      parameters: overwriteParameters,
      execute: (args: unknown) => {
        const { path, content } = overwriteParameters.parse(args);
        state.files[path] = content;
        state.opened.push(path);
        return `Opened and rewrote ${path}. Change id: change-4.`;
      },
    } satisfies AgentTool<typeof overwriteParameters>,
    {
      name: "list_recent_changes",
      description: "List recent changes.",
      parameters: emptyParameters,
      execute: () => "- change-1 create news.md",
    } satisfies AgentTool<typeof emptyParameters>,
    {
      name: "revert_change",
      description: "Revert change.",
      parameters: z.object({ changeId: z.string().optional(), path: z.string().optional() }),
      execute: () => "Reverted change-1 by moving news.md to trash.",
    },
    {
      name: "semantic_search",
      description: "Semantic search.",
      parameters: searchParameters,
      execute: (args: unknown) => {
        const { query } = searchParameters.parse(args);
        return `Semantic results for ${query}: Concept.md`;
      },
    } satisfies AgentTool<typeof searchParameters>,
    {
      name: "find_similar_notes",
      description: "Find similar notes.",
      parameters: pathParameters,
      execute: (args: unknown) => {
        const { path } = pathParameters.parse(args);
        return `Similar notes to ${path}: Related.md`;
      },
    } satisfies AgentTool<typeof pathParameters>,
    {
      name: "read_frontmatter",
      description: "Read frontmatter.",
      parameters: pathParameters,
      execute: (args: unknown) => {
        const { path } = pathParameters.parse(args);
        return `${path} frontmatter: status: active`;
      },
    } satisfies AgentTool<typeof pathParameters>,
    {
      name: "update_frontmatter",
      description: "Update frontmatter.",
      parameters: z.object({ path: z.string(), key: z.string(), value: z.string() }),
      execute: () => "Updated frontmatter.",
    },
    {
      name: "list_tags",
      description: "List tags.",
      parameters: emptyParameters,
      execute: () => "#ai\n#project",
    } satisfies AgentTool<typeof emptyParameters>,
    {
      name: "search_by_tag",
      description: "Search by tag.",
      parameters: tagParameters,
      execute: (args: unknown) => {
        const { tag } = tagParameters.parse(args);
        return `Notes tagged ${tag}: Tagged.md`;
      },
    } satisfies AgentTool<typeof tagParameters>,
    {
      name: "get_backlinks",
      description: "Get backlinks.",
      parameters: pathParameters,
      execute: (args: unknown) => {
        const { path } = pathParameters.parse(args);
        return `Backlinks to ${path}: Source.md`;
      },
    } satisfies AgentTool<typeof pathParameters>,
    {
      name: "get_outlinks",
      description: "Get outlinks.",
      parameters: pathParameters,
      execute: (args: unknown) => {
        const { path } = pathParameters.parse(args);
        return `Outlinks from ${path}: Target.md`;
      },
    } satisfies AgentTool<typeof pathParameters>,
    {
      name: "find_orphan_notes",
      description: "Find orphan notes.",
      parameters: emptyParameters,
      execute: () => "Orphan.md",
    } satisfies AgentTool<typeof emptyParameters>,
    {
      name: "find_broken_links",
      description: "Find broken links.",
      parameters: emptyParameters,
      execute: () => "A.md -> Missing.md",
    } satisfies AgentTool<typeof emptyParameters>,
    {
      name: "list_open_tasks",
      description: "List open tasks.",
      parameters: emptyParameters,
      execute: () => "- [ ] Do thing",
    } satisfies AgentTool<typeof emptyParameters>,
    {
      name: "daily_review",
      description: "Daily review.",
      parameters: emptyParameters,
      execute: () => "Daily review context",
    } satisfies AgentTool<typeof emptyParameters>,
    {
      name: "weekly_rollup_context",
      description: "Weekly rollup.",
      parameters: emptyParameters,
      execute: () => "Weekly rollup context",
    } satisfies AgentTool<typeof emptyParameters>,
    {
      name: "read_memory",
      description: "Read memory.",
      parameters: emptyParameters,
      execute: () => state.files["Obsigent Memory.md"] ?? "No memory found.",
    } satisfies AgentTool<typeof emptyParameters>,
    {
      name: "append_memory",
      description: "Append memory.",
      parameters: z.object({ content: z.string() }),
      execute: (args: unknown) => {
        const { content } = z.object({ content: z.string() }).parse(args);
        state.files["Obsigent Memory.md"] = `${state.files["Obsigent Memory.md"] ?? ""}${content}`;
        return "Appended to memory.";
      },
    },
    {
      name: "list_sections",
      description: "List sections.",
      parameters: pathParameters,
      execute: () => "Intro\nDetails",
    } satisfies AgentTool<typeof pathParameters>,
    {
      name: "plan_replace_section",
      description: "Plan replace section.",
      parameters: sectionParameters,
      execute: (args: unknown) => {
        const { heading } = sectionParameters.parse(args);
        return `Plan to replace ${heading}`;
      },
    } satisfies AgentTool<typeof sectionParameters>,
    {
      name: "plan_insert_at_section",
      description: "Plan insert section.",
      parameters: sectionParameters,
      execute: (args: unknown) => {
        const { heading } = sectionParameters.parse(args);
        return `Plan to insert at ${heading}`;
      },
    } satisfies AgentTool<typeof sectionParameters>,
    {
      name: "plan_edit_block",
      description: "Plan edit block.",
      parameters: pathParameters,
      execute: () => "Plan to edit block",
    } satisfies AgentTool<typeof pathParameters>,
    {
      name: "plan_rename_note",
      description: "Plan rename note.",
      parameters: z.object({ path: z.string(), newPath: z.string() }),
      execute: () => "Plan to rename note",
    },
    {
      name: "plan_move_note",
      description: "Plan move note.",
      parameters: z.object({ path: z.string(), folder: z.string() }),
      execute: () => "Plan to move note",
    },
    {
      name: "plan_trash_note",
      description: "Plan trash note.",
      parameters: pathParameters,
      execute: () => "Plan to trash note",
    } satisfies AgentTool<typeof pathParameters>,
  ];
}

type SingleToolCase = Readonly<{
  name: string;
  prompt: string;
  toolName: string;
  args: Record<string, unknown>;
  finalText: string;
  initialFiles?: Record<string, string>;
  assert?: (state: SimulationState, result: SimulationResult) => void;
}>;

async function runSingleToolCase(testCase: SingleToolCase): Promise<void> {
  const state: SimulationState = { files: { ...(testCase.initialFiles ?? {}) }, opened: [] };
  const result = await runSimulation(
    testCase.name,
    [
      {
        when: (messages) => !hasToolResult(messages, testCase.toolName),
        message: toolMessage(testCase.toolName, testCase.args),
      },
      {
        when: (messages) => hasToolResult(messages, testCase.toolName),
        message: textMessage(testCase.finalText),
      },
    ],
    testCase.prompt,
    makeTools(state),
  );

  expect(result.toolCalls).toEqual([testCase.toolName]);
  expect(result.text).toBe(testCase.finalText);
  testCase.assert?.(state, result);
}

describe("agent tool simulations", () => {
  it("searches current news then creates a note in one request", async () => {
    const state: SimulationState = { files: {}, opened: [] };
    const result = await runSimulation(
      "news-create",
      [
        {
          when: (messages) => !hasToolResult(messages, "web_search"),
          message: toolMessage("web_search", { query: "latest AI news" }),
        },
        {
          when: (messages) => !hasToolResult(messages, "create_note"),
          message: toolMessage("create_note", {
            path: "news.md",
            content: "# AI News\n\nAI agents launched today.",
          }),
        },
        {
          when: (messages) => hasToolResult(messages, "create_note"),
          message: textMessage("Created and opened news.md."),
        },
      ],
      "get the latest ai news then create a news.md for me based on todays news",
      makeTools(state),
    );

    expect(result.toolCalls).toEqual(["web_search", "create_note"]);
    expect(state.files["news.md"]).toContain("AI agents");
    expect(state.opened).toContain("news.md");
    expect(result.text).toContain("Created");
  });

  it("opens a requested note instead of reading it", async () => {
    const state = { files: { "boobies.md": "Soft curves" }, opened: [] as string[] };
    const result = await runSimulation(
      "open-note",
      [
        {
          when: (messages) => !hasToolResult(messages, "open_note"),
          message: toolMessage("open_note", { path: "boobies.md" }),
        },
        {
          when: (messages) => hasToolResult(messages, "open_note"),
          message: textMessage("Opened boobies.md."),
        },
      ],
      "open boobies.md",
      makeTools(state),
    );

    expect(result.toolCalls).toEqual(["open_note"]);
    expect(result.text).toBe("Opened boobies.md.");
    expect(state.opened).toEqual(["boobies.md"]);
  });

  it("continues a follow-up file creation from explicit recent conversation context", async () => {
    const state: SimulationState = { files: {}, opened: [] };
    const prompt = `<recent_conversation>\nUser: get latest ai news\nAssistant: AI agents launched today.\n</recent_conversation>\n\n<current_request>yes place this into a news.md file</current_request>`;
    const result = await runSimulation(
      "follow-up-create",
      [
        {
          when: (messages) => !hasToolResult(messages, "create_note"),
          message: toolMessage("create_note", {
            path: "news.md",
            content: "# AI News\n\nAI agents launched today.",
          }),
        },
        {
          when: (messages) => hasToolResult(messages, "create_note"),
          message: textMessage("Created and opened news.md."),
        },
      ],
      prompt,
      makeTools(state),
    );

    expect(result.toolCalls).toEqual(["create_note"]);
    expect(state.files["news.md"]).toContain("AI agents launched today");
  });

  it("lists notes without claiming missing created files exist", async () => {
    const state = { files: { "A.md": "a", "B.md": "b" }, opened: [] as string[] };
    const result = await runSimulation(
      "list-notes",
      [
        {
          when: (messages) => !hasToolResult(messages, "list_notes"),
          message: toolMessage("list_notes", {}),
        },
        {
          when: (messages) => hasToolResult(messages, "list_notes"),
          message: textMessage("A.md\nB.md"),
        },
      ],
      "list all notes",
      makeTools(state),
    );

    expect(result.toolCalls).toEqual(["list_notes"]);
    expect(result.text).toBe("A.md\nB.md");
  });

  it("reads a note only when the user asks for content", async () => {
    const state = { files: { "Daily.md": "Today I learned TypeScript." }, opened: [] as string[] };
    const result = await runSimulation(
      "read-note",
      [
        {
          when: (messages) => !hasToolResult(messages, "read_note"),
          message: toolMessage("read_note", { path: "Daily.md" }),
        },
        {
          when: (messages) => hasToolResult(messages, "read_note"),
          message: textMessage("Today I learned TypeScript."),
        },
      ],
      "what is in Daily.md?",
      makeTools(state),
    );

    expect(result.toolCalls).toEqual(["read_note"]);
    expect(state.opened).toEqual([]);
    expect(result.text).toContain("TypeScript");
  });

  it("appends to an existing note", async () => {
    const state = { files: { "Daily.md": "Start\n" }, opened: [] as string[] };
    await runSimulation(
      "append-note",
      [
        {
          when: (messages) => !hasToolResult(messages, "append_note"),
          message: toolMessage("append_note", { path: "Daily.md", content: "Next" }),
        },
        {
          when: (messages) => hasToolResult(messages, "append_note"),
          message: textMessage("Opened and appended to Daily.md."),
        },
      ],
      "append Next to Daily.md",
      makeTools(state),
    );

    expect(state.files["Daily.md"]).toBe("Start\nNext");
    expect(state.opened).toEqual(["Daily.md"]);
  });

  it("replaces exact text in an existing note", async () => {
    const state = { files: { "Project.md": "before target after" }, opened: [] as string[] };
    await runSimulation(
      "replace-note",
      [
        {
          when: (messages) => !hasToolResult(messages, "replace_in_note"),
          message: toolMessage("replace_in_note", {
            path: "Project.md",
            find: "target",
            replace: "updated",
          }),
        },
        {
          when: (messages) => hasToolResult(messages, "replace_in_note"),
          message: textMessage("Opened and edited Project.md."),
        },
      ],
      "replace target with updated in Project.md",
      makeTools(state),
    );

    expect(state.files["Project.md"]).toBe("before updated after");
  });

  it("fetches a web result before answering current-facts questions", async () => {
    const state: SimulationState = { files: {}, opened: [] };
    const result = await runSimulation(
      "web-fetch",
      [
        {
          when: (messages) => !hasToolResult(messages, "web_search"),
          message: toolMessage("web_search", { query: "latest Obsidian release" }),
        },
        {
          when: (messages) => !hasToolResult(messages, "web_fetch"),
          message: toolMessage("web_fetch", { url: "https://example.com" }),
        },
        {
          when: (messages) => hasToolResult(messages, "web_fetch"),
          message: textMessage("Fetched latest release details."),
        },
      ],
      "what is the latest Obsidian release?",
      makeTools(state),
    );

    expect(result.toolCalls).toEqual(["web_search", "web_fetch"]);
    expect(result.text).toContain("Fetched");
  });

  it("does not stream pre-tool filler as final answer", async () => {
    const state: SimulationState = { files: {}, opened: [] };
    const result = await runSimulation(
      "pre-tool-filler",
      [
        {
          when: (messages) => !hasToolResult(messages, "create_note"),
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Hello, I am Obsigent." },
              {
                type: "tool_call",
                id: "call-create_note",
                name: "create_note",
                args: { path: "news.md", content: "# News" },
              },
            ],
          },
        },
        {
          when: (messages) => hasToolResult(messages, "create_note"),
          message: textMessage("Created and opened news.md."),
        },
      ],
      "create news.md",
      makeTools(state),
    );

    expect(result.text).toBe("Created and opened news.md.");
  });

  it("surfaces tool errors instead of claiming success", async () => {
    const failingTool: AgentTool = {
      name: "open_note",
      description: "Open note.",
      parameters: z.object({ path: z.string() }),
      execute: () => {
        throw new Error("Note not found: Missing.md");
      },
    };
    const result = await runSimulation(
      "tool-error",
      [
        {
          when: (messages) => !hasToolResult(messages, "open_note"),
          message: toolMessage("open_note", { path: "Missing.md" }),
        },
        {
          when: (messages) => hasToolResult(messages, "open_note"),
          message: textMessage("I could not open Missing.md because it was not found."),
        },
      ],
      "open Missing.md",
      [failingTool],
    );

    expect(result.toolCalls).toEqual(["open_note"]);
    expect(result.text).toContain("could not open");
  });

  describe("vault read/open/search routing", () => {
    const cases: readonly SingleToolCase[] = [
      {
        name: "vault-open-existing",
        prompt: "open Journal.md",
        toolName: "open_note",
        args: { path: "Journal.md" },
        finalText: "Opened Journal.md.",
        initialFiles: { "Journal.md": "day" },
        assert: (state) => expect(state.opened).toEqual(["Journal.md"]),
      },
      {
        name: "vault-read-content",
        prompt: "what does Journal.md say?",
        toolName: "read_note",
        args: { path: "Journal.md" },
        finalText: "Journal.md says day.",
        initialFiles: { "Journal.md": "day" },
      },
      {
        name: "vault-list-root",
        prompt: "list my notes",
        toolName: "list_notes",
        args: {},
        finalText: "Journal.md\nProject.md",
        initialFiles: { "Journal.md": "day", "Project.md": "plan" },
      },
      {
        name: "vault-search-title",
        prompt: "find Project",
        toolName: "search_notes",
        args: { query: "Project" },
        finalText: "Found Project.md.",
        initialFiles: { "Project.md": "plan" },
      },
      {
        name: "vault-search-content",
        prompt: "find notes mentioning bananas",
        toolName: "search_notes",
        args: { query: "bananas" },
        finalText: "Found Food.md.",
        initialFiles: { "Food.md": "bananas" },
      },
      {
        name: "vault-read-after-search-intent",
        prompt: "find and read Food.md",
        toolName: "read_note",
        args: { path: "Food.md" },
        finalText: "Food.md says bananas.",
        initialFiles: { "Food.md": "bananas" },
      },
      {
        name: "vault-open-follow-up-context",
        prompt:
          "<recent_conversation>\nAssistant: Found Project.md\n</recent_conversation>\n\n<current_request>open it</current_request>",
        toolName: "open_note",
        args: { path: "Project.md" },
        finalText: "Opened Project.md.",
        initialFiles: { "Project.md": "plan" },
      },
      {
        name: "vault-read-follow-up-context",
        prompt:
          "<recent_conversation>\nAssistant: Found Food.md\n</recent_conversation>\n\n<current_request>what does it say?</current_request>",
        toolName: "read_note",
        args: { path: "Food.md" },
        finalText: "Food.md says bananas.",
        initialFiles: { "Food.md": "bananas" },
      },
      {
        name: "vault-list-does-not-open",
        prompt: "show file names only",
        toolName: "list_notes",
        args: {},
        finalText: "A.md\nB.md",
        initialFiles: { "A.md": "a", "B.md": "b" },
        assert: (state) => expect(state.opened).toEqual([]),
      },
      {
        name: "vault-search-no-match",
        prompt: "find zebra",
        toolName: "search_notes",
        args: { query: "zebra" },
        finalText: "No matching notes found.",
        initialFiles: { "A.md": "a" },
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, async () => {
        await runSingleToolCase(testCase);
      });
    }
  });

  describe("vault writing and note changes", () => {
    const cases: readonly SingleToolCase[] = [
      {
        name: "write-create-root-note",
        prompt: "create Ideas.md saying hello",
        toolName: "create_note",
        args: { path: "Ideas.md", content: "hello" },
        finalText: "Created and opened Ideas.md.",
        assert: (state) => expect(state.files["Ideas.md"]).toBe("hello"),
      },
      {
        name: "write-create-folder-note",
        prompt: "create Research/AI.md",
        toolName: "create_note",
        args: { path: "Research/AI.md", content: "# AI" },
        finalText: "Created and opened Research/AI.md.",
        assert: (state) => expect(state.opened).toEqual(["Research/AI.md"]),
      },
      {
        name: "write-append-existing",
        prompt: "append next to Daily.md",
        toolName: "append_note",
        args: { path: "Daily.md", content: "next" },
        finalText: "Opened and appended to Daily.md.",
        initialFiles: { "Daily.md": "start " },
        assert: (state) => expect(state.files["Daily.md"]).toBe("start next"),
      },
      {
        name: "write-replace-exact",
        prompt: "replace alpha with beta in Note.md",
        toolName: "replace_in_note",
        args: { path: "Note.md", find: "alpha", replace: "beta" },
        finalText: "Opened and edited Note.md.",
        initialFiles: { "Note.md": "alpha" },
        assert: (state) => expect(state.files["Note.md"]).toBe("beta"),
      },
      {
        name: "write-overwrite-explicit",
        prompt: "rewrite Note.md fully",
        toolName: "overwrite_note",
        args: { path: "Note.md", content: "new" },
        finalText: "Opened and rewrote Note.md.",
        initialFiles: { "Note.md": "old" },
        assert: (state) => expect(state.files["Note.md"]).toBe("new"),
      },
      {
        name: "write-follow-up-create",
        prompt:
          "<recent_conversation>\nAssistant: summary text\n</recent_conversation>\n\n<current_request>put that in Summary.md</current_request>",
        toolName: "create_note",
        args: { path: "Summary.md", content: "summary text" },
        finalText: "Created and opened Summary.md.",
        assert: (state) => expect(state.files["Summary.md"]).toBe("summary text"),
      },
      {
        name: "write-follow-up-append",
        prompt:
          "<recent_conversation>\nAssistant: action item\n</recent_conversation>\n\n<current_request>add that to Tasks.md</current_request>",
        toolName: "append_note",
        args: { path: "Tasks.md", content: "action item" },
        finalText: "Opened and appended to Tasks.md.",
        initialFiles: { "Tasks.md": "" },
      },
      {
        name: "write-current-news-note",
        prompt: "save this news as news.md",
        toolName: "create_note",
        args: { path: "news.md", content: "# News" },
        finalText: "Created and opened news.md.",
      },
      {
        name: "write-open-after-create",
        prompt: "create and open Plan.md",
        toolName: "create_note",
        args: { path: "Plan.md", content: "plan" },
        finalText: "Created and opened Plan.md.",
        assert: (state) => expect(state.opened).toEqual(["Plan.md"]),
      },
      {
        name: "write-edit-does-not-claim-before-tool",
        prompt: "edit Project.md",
        toolName: "replace_in_note",
        args: { path: "Project.md", find: "old", replace: "new" },
        finalText: "Opened and edited Project.md.",
        initialFiles: { "Project.md": "old" },
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, async () => {
        await runSingleToolCase(testCase);
      });
    }
  });

  describe("web and multi-step execution", () => {
    const cases: readonly SingleToolCase[] = [
      {
        name: "web-search-current-news",
        prompt: "latest ai news",
        toolName: "web_search",
        args: { query: "latest ai news" },
        finalText: "Found current AI news.",
      },
      {
        name: "web-search-docs",
        prompt: "current Obsidian API docs",
        toolName: "web_search",
        args: { query: "Obsidian API docs" },
        finalText: "Found Obsidian API docs.",
      },
      {
        name: "web-fetch-url",
        prompt: "fetch https://example.com",
        toolName: "web_fetch",
        args: { url: "https://example.com" },
        finalText: "Fetched example.com.",
      },
      {
        name: "web-search-recent-release",
        prompt: "latest release info",
        toolName: "web_search",
        args: { query: "latest release info" },
        finalText: "Found latest release info.",
      },
      {
        name: "web-search-recent-facts",
        prompt: "what happened today in AI?",
        toolName: "web_search",
        args: { query: "today AI news" },
        finalText: "Found today's AI news.",
      },
      {
        name: "web-search-library-docs",
        prompt: "look up Zod docs",
        toolName: "web_search",
        args: { query: "Zod documentation" },
        finalText: "Found Zod documentation.",
      },
      {
        name: "web-fetch-source-detail",
        prompt: "fetch the source page",
        toolName: "web_fetch",
        args: { url: "https://example.com/source" },
        finalText: "Fetched source detail.",
      },
      {
        name: "web-search-before-note",
        prompt: "research AI then save",
        toolName: "web_search",
        args: { query: "AI news" },
        finalText: "Searched AI news.",
      },
      {
        name: "web-search-not-vault-search",
        prompt: "latest weather online",
        toolName: "web_search",
        args: { query: "latest weather" },
        finalText: "Found latest weather.",
      },
      {
        name: "web-fetch-current-page",
        prompt: "read this web page https://example.com/news",
        toolName: "web_fetch",
        args: { url: "https://example.com/news" },
        finalText: "Fetched news page.",
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, async () => {
        await runSingleToolCase(testCase);
      });
    }

    it("web search then fetch then create note", async () => {
      const state: SimulationState = { files: {}, opened: [] };
      const result = await runSimulation(
        "web-chain-create",
        [
          {
            when: (messages) => !hasToolResult(messages, "web_search"),
            message: toolMessage("web_search", { query: "latest AI news" }),
          },
          {
            when: (messages) => !hasToolResult(messages, "web_fetch"),
            message: toolMessage("web_fetch", { url: "https://example.com/ai" }),
          },
          {
            when: (messages) => !hasToolResult(messages, "create_note"),
            message: toolMessage("create_note", { path: "news.md", content: "# AI News" }),
          },
          {
            when: (messages) => hasToolResult(messages, "create_note"),
            message: textMessage("Created and opened news.md."),
          },
        ],
        "get latest ai news and create news.md",
        makeTools(state),
      );

      expect(result.toolCalls).toEqual(["web_search", "web_fetch", "create_note"]);
      expect(state.files["news.md"]).toBe("# AI News");
    });
  });

  describe("follow-up context and pronoun resolution", () => {
    const cases: readonly SingleToolCase[] = [
      {
        name: "context-that-to-file",
        prompt:
          "<recent_conversation>\nAssistant: Summary A\n</recent_conversation>\n\n<current_request>put that in A.md</current_request>",
        toolName: "create_note",
        args: { path: "A.md", content: "Summary A" },
        finalText: "Created and opened A.md.",
      },
      {
        name: "context-it-open",
        prompt:
          "<recent_conversation>\nAssistant: Found B.md\n</recent_conversation>\n\n<current_request>open it</current_request>",
        toolName: "open_note",
        args: { path: "B.md" },
        finalText: "Opened B.md.",
        initialFiles: { "B.md": "b" },
      },
      {
        name: "context-news-save",
        prompt:
          "<recent_conversation>\nAssistant: AI news summary\n</recent_conversation>\n\n<current_request>save the news</current_request>",
        toolName: "create_note",
        args: { path: "news.md", content: "AI news summary" },
        finalText: "Created and opened news.md.",
      },
      {
        name: "context-yes-continue",
        prompt:
          "<recent_conversation>\nUser: create a note?\nAssistant: I can create Ideas.md\n</recent_conversation>\n\n<current_request>yes</current_request>",
        toolName: "create_note",
        args: { path: "Ideas.md", content: "Ideas" },
        finalText: "Created and opened Ideas.md.",
      },
      {
        name: "context-add-this",
        prompt:
          "<recent_conversation>\nAssistant: Take vitamins\n</recent_conversation>\n\n<current_request>add this to Health.md</current_request>",
        toolName: "append_note",
        args: { path: "Health.md", content: "Take vitamins" },
        finalText: "Opened and appended to Health.md.",
        initialFiles: { "Health.md": "" },
      },
      {
        name: "context-replace-that",
        prompt:
          "<recent_conversation>\nAssistant: Replace old with new\n</recent_conversation>\n\n<current_request>do that in Project.md</current_request>",
        toolName: "replace_in_note",
        args: { path: "Project.md", find: "old", replace: "new" },
        finalText: "Opened and edited Project.md.",
        initialFiles: { "Project.md": "old" },
      },
      {
        name: "context-read-that-note",
        prompt:
          "<recent_conversation>\nAssistant: Found Notes/Meeting.md\n</recent_conversation>\n\n<current_request>read that note</current_request>",
        toolName: "read_note",
        args: { path: "Notes/Meeting.md" },
        finalText: "Meeting notes.",
        initialFiles: { "Notes/Meeting.md": "Meeting notes." },
      },
      {
        name: "context-list-then-open",
        prompt:
          "<recent_conversation>\nAssistant: A.md\nB.md\n</recent_conversation>\n\n<current_request>open B</current_request>",
        toolName: "open_note",
        args: { path: "B.md" },
        finalText: "Opened B.md.",
        initialFiles: { "A.md": "a", "B.md": "b" },
      },
      {
        name: "context-current-file-edit",
        prompt:
          "<recent_conversation>\nUser: We are editing Draft.md\n</recent_conversation>\n\n<current_request>append final line</current_request>",
        toolName: "append_note",
        args: { path: "Draft.md", content: "final line" },
        finalText: "Opened and appended to Draft.md.",
        initialFiles: { "Draft.md": "draft\n" },
      },
      {
        name: "context-summary-to-existing",
        prompt:
          "<recent_conversation>\nAssistant: Summary B\n</recent_conversation>\n\n<current_request>append it to Summary.md</current_request>",
        toolName: "append_note",
        args: { path: "Summary.md", content: "Summary B" },
        finalText: "Opened and appended to Summary.md.",
        initialFiles: { "Summary.md": "" },
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, async () => {
        await runSingleToolCase(testCase);
      });
    }
  });

  describe("semantic, metadata, graph, task, memory, and maintenance routing", () => {
    const cases: readonly SingleToolCase[] = [
      {
        name: "semantic-conceptual-question",
        prompt: "find notes about my long-term themes",
        toolName: "semantic_search",
        args: { query: "long-term themes" },
        finalText: "Semantic results for long-term themes: Concept.md",
      },
      {
        name: "semantic-similar-note",
        prompt: "find notes similar to Concept.md",
        toolName: "find_similar_notes",
        args: { path: "Concept.md" },
        finalText: "Similar notes to Concept.md: Related.md",
        initialFiles: { "Concept.md": "concept" },
      },
      {
        name: "metadata-read-properties",
        prompt: "show properties for Project.md",
        toolName: "read_frontmatter",
        args: { path: "Project.md" },
        finalText: "Project.md frontmatter: status: active",
        initialFiles: { "Project.md": "---\nstatus: active\n---" },
      },
      {
        name: "metadata-update-property",
        prompt: "set Project.md status active",
        toolName: "update_frontmatter",
        args: { path: "Project.md", key: "status", value: "active" },
        finalText: "Updated frontmatter.",
        initialFiles: { "Project.md": "---\n---" },
      },
      {
        name: "metadata-list-tags",
        prompt: "list tags in my vault",
        toolName: "list_tags",
        args: {},
        finalText: "#ai\n#project",
      },
      {
        name: "metadata-search-tag",
        prompt: "find notes tagged ai",
        toolName: "search_by_tag",
        args: { tag: "ai" },
        finalText: "Notes tagged ai: Tagged.md",
      },
      {
        name: "graph-backlinks",
        prompt: "what links to Project.md?",
        toolName: "get_backlinks",
        args: { path: "Project.md" },
        finalText: "Backlinks to Project.md: Source.md",
        initialFiles: { "Project.md": "project" },
      },
      {
        name: "graph-outlinks",
        prompt: "what does Project.md link to?",
        toolName: "get_outlinks",
        args: { path: "Project.md" },
        finalText: "Outlinks from Project.md: Target.md",
        initialFiles: { "Project.md": "[[Target]]" },
      },
      {
        name: "graph-orphans",
        prompt: "find orphan notes",
        toolName: "find_orphan_notes",
        args: {},
        finalText: "Orphan.md",
      },
      {
        name: "graph-broken-links",
        prompt: "find broken links",
        toolName: "find_broken_links",
        args: {},
        finalText: "A.md -> Missing.md",
      },
      {
        name: "tasks-open-tasks",
        prompt: "list open tasks",
        toolName: "list_open_tasks",
        args: {},
        finalText: "- [ ] Do thing",
      },
      {
        name: "tasks-daily-review",
        prompt: "make a daily review context",
        toolName: "daily_review",
        args: {},
        finalText: "Daily review context",
      },
      {
        name: "tasks-weekly-rollup",
        prompt: "make weekly rollup context",
        toolName: "weekly_rollup_context",
        args: {},
        finalText: "Weekly rollup context",
      },
      {
        name: "memory-read-explicit",
        prompt: "what do you remember about me?",
        toolName: "read_memory",
        args: {},
        finalText: "Likes local AI",
        initialFiles: { "Obsigent Memory.md": "Likes local AI" },
      },
      {
        name: "memory-append-explicit",
        prompt: "remember that I like local AI",
        toolName: "append_memory",
        args: { content: "Likes local AI" },
        finalText: "Appended to memory.",
        assert: (state) => expect(state.files["Obsigent Memory.md"]).toContain("local AI"),
      },
      {
        name: "maintenance-list-sections",
        prompt: "list sections in Long.md",
        toolName: "list_sections",
        args: { path: "Long.md" },
        finalText: "Intro\nDetails",
        initialFiles: { "Long.md": "# Intro\n# Details" },
      },
      {
        name: "maintenance-plan-replace-section",
        prompt: "plan replacing Details in Long.md",
        toolName: "plan_replace_section",
        args: { path: "Long.md", heading: "Details" },
        finalText: "Plan to replace Details",
      },
      {
        name: "maintenance-plan-insert-section",
        prompt: "plan inserting at Intro in Long.md",
        toolName: "plan_insert_at_section",
        args: { path: "Long.md", heading: "Intro" },
        finalText: "Plan to insert at Intro",
      },
      {
        name: "maintenance-plan-rename",
        prompt: "plan renaming Old.md to New.md",
        toolName: "plan_rename_note",
        args: { path: "Old.md", newPath: "New.md" },
        finalText: "Plan to rename note",
      },
      {
        name: "maintenance-plan-trash",
        prompt: "plan trashing Old.md",
        toolName: "plan_trash_note",
        args: { path: "Old.md" },
        finalText: "Plan to trash note",
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, async () => {
        await runSingleToolCase(testCase);
      });
    }
  });

  describe("long multi-turn continuity simulations", () => {
    it("handles a five-step user workflow without losing context", async () => {
      const state: SimulationState = { files: { "Draft.md": "old" }, opened: [] };
      const result = await runSimulation(
        "long-workflow",
        [
          {
            when: (messages) => !hasToolResult(messages, "web_search"),
            message: toolMessage("web_search", { query: "latest AI news" }),
          },
          {
            when: (messages) => !hasToolResult(messages, "create_note"),
            message: toolMessage("create_note", { path: "news.md", content: "# AI News" }),
          },
          {
            when: (messages) => !hasToolResult(messages, "open_note"),
            message: toolMessage("open_note", { path: "news.md" }),
          },
          {
            when: (messages) => !hasToolResult(messages, "append_note"),
            message: toolMessage("append_note", { path: "Draft.md", content: "# AI News" }),
          },
          {
            when: (messages) => hasToolResult(messages, "append_note"),
            message: textMessage(
              "Created news.md, opened it, and appended the summary to Draft.md.",
            ),
          },
        ],
        "research ai news, create news.md, open it, then append the summary to Draft.md",
        makeTools(state),
      );

      expect(result.toolCalls).toEqual(["web_search", "create_note", "open_note", "append_note"]);
      expect(state.files["news.md"]).toBe("# AI News");
      expect(state.files["Draft.md"]).toContain("# AI News");
    });

    it("uses recent conversation to resolve multiple short follow-ups", async () => {
      const state: SimulationState = { files: { "A.md": "a" }, opened: [] };
      const result = await runSimulation(
        "multi-follow-up",
        [
          {
            when: (messages) => !hasToolResult(messages, "read_note"),
            message: toolMessage("read_note", { path: "A.md" }),
          },
          {
            when: (messages) => !hasToolResult(messages, "append_note"),
            message: toolMessage("append_note", { path: "A.md", content: "\nsummary" }),
          },
          {
            when: (messages) => !hasToolResult(messages, "open_note"),
            message: toolMessage("open_note", { path: "A.md" }),
          },
          {
            when: (messages) => hasToolResult(messages, "open_note"),
            message: textMessage("Read A.md, appended the summary, and opened it."),
          },
        ],
        "<recent_conversation>\nUser: read A.md\nAssistant: a\nUser: summarize it\nAssistant: summary\n</recent_conversation>\n\n<current_request>add that and open it</current_request>",
        makeTools(state),
      );

      expect(result.toolCalls).toEqual(["read_note", "append_note", "open_note"]);
      expect(state.files["A.md"]).toContain("summary");
      expect(state.opened).toContain("A.md");
    });
  });

  describe("truthfulness, errors, and filler suppression", () => {
    it("does not claim success when create_note fails", async () => {
      const createParameters = z.object({ path: z.string(), content: z.string() });
      const failingTool: AgentTool<typeof createParameters> = {
        name: "create_note",
        description: "Create note.",
        parameters: createParameters,
        execute: () => {
          throw new Error("Note already exists: news.md");
        },
      };
      const result = await runSimulation(
        "create-error",
        [
          {
            when: (messages) => !hasToolResult(messages, "create_note"),
            message: toolMessage("create_note", { path: "news.md", content: "news" }),
          },
          {
            when: (messages) => hasToolResult(messages, "create_note"),
            message: textMessage("I could not create news.md because it already exists."),
          },
        ],
        "create news.md",
        [failingTool],
      );

      expect(result.text).toContain("could not create");
    });

    const cases: readonly SingleToolCase[] = [
      {
        name: "truth-list-after-missing-create",
        prompt: "where is news.md?",
        toolName: "list_notes",
        args: {},
        finalText: "news.md is not listed.",
        initialFiles: { "A.md": "a" },
      },
      {
        name: "truth-open-missing-check",
        prompt: "open Missing.md",
        toolName: "open_note",
        args: { path: "Missing.md" },
        finalText: "I could not open Missing.md because it was not found.",
      },
      {
        name: "truth-search-before-saying-searched",
        prompt: "search bananas",
        toolName: "search_notes",
        args: { query: "bananas" },
        finalText: "No matching notes found.",
        initialFiles: { "A.md": "a" },
      },
      {
        name: "truth-read-missing",
        prompt: "read Missing.md",
        toolName: "read_note",
        args: { path: "Missing.md" },
        finalText: "Missing.md was not found.",
      },
      {
        name: "truth-open-not-read",
        prompt: "open A.md",
        toolName: "open_note",
        args: { path: "A.md" },
        finalText: "Opened A.md.",
        initialFiles: { "A.md": "secret content" },
      },
      {
        name: "truth-read-not-open",
        prompt: "read A.md",
        toolName: "read_note",
        args: { path: "A.md" },
        finalText: "secret content",
        initialFiles: { "A.md": "secret content" },
        assert: (state) => expect(state.opened).toEqual([]),
      },
      {
        name: "truth-create-result-only",
        prompt: "make C.md",
        toolName: "create_note",
        args: { path: "C.md", content: "c" },
        finalText: "Created and opened C.md.",
      },
      {
        name: "truth-edit-result-only",
        prompt: "edit D.md",
        toolName: "replace_in_note",
        args: { path: "D.md", find: "d", replace: "done" },
        finalText: "Opened and edited D.md.",
        initialFiles: { "D.md": "d" },
      },
      {
        name: "truth-web-result-only",
        prompt: "search current ai",
        toolName: "web_search",
        args: { query: "current ai" },
        finalText: "Searched current ai.",
      },
      {
        name: "truth-empty-search-result",
        prompt: "find nonexistent",
        toolName: "search_notes",
        args: { query: "nonexistent" },
        finalText: "No matching notes found.",
        initialFiles: { "A.md": "a" },
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, async () => {
        await runSingleToolCase(testCase);
      });
    }
  });
});
