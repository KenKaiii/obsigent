import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  Modal: class Modal {
    public contentEl = {
      createDiv: () => ({ createEl: () => ({ addEventListener: () => undefined }) }),
      createEl: () => undefined,
      empty: () => undefined,
    };

    public constructor(public readonly app: unknown) {}
    public close(): void {}
    public open(): void {}
    public setTitle(): this {
      return this;
    }
  },
  Notice: class Notice {
    public constructor(public readonly message: string) {}
  },
}));

import { DEFAULT_SETTINGS } from "./settings";
import { createVaultTools, VaultChangeHistory } from "./vault-tools";

type MockFile = Readonly<{
  path: string;
  extension: string;
}>;

type MockApp = ReturnType<typeof createMockApp>;

function createMockApp(
  initialFiles: readonly MockFile[],
  initialContents: Readonly<Record<string, string>>,
) {
  const files: MockFile[] = [...initialFiles];
  const contents: Record<string, string> = { ...initialContents };
  const openedPaths: string[] = [];
  const viewData: Record<string, string> = {};

  const leaf = {
    view: {
      file: null as MockFile | null,
      requestSave: () => undefined,
      setViewData: (data: string) => {
        const file = leaf.view.file;
        if (file) {
          viewData[file.path] = data;
        }
      },
    },
    openFile: async (file: MockFile) => {
      leaf.view.file = file;
      openedPaths.push(file.path);
    },
  };

  return {
    contents,
    openedPaths,
    viewData,
    vault: {
      getMarkdownFiles: () => files,
      getAbstractFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
      getFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
      create: async (path: string, data: string) => {
        const file = { path, extension: path.split(".").pop() ?? "" };
        files.push(file);
        contents[path] = data;
        return file;
      },
      createFolder: async () => undefined,
      read: async (file: MockFile) => contents[file.path] ?? "",
      cachedRead: async (file: MockFile) => contents[file.path] ?? "",
      modify: async (file: MockFile, data: string) => {
        contents[file.path] = data;
      },
    },
    fileManager: {
      trashFile: async (file: MockFile) => {
        const index = files.findIndex((candidate) => candidate.path === file.path);
        if (index >= 0) {
          files.splice(index, 1);
        }
        delete contents[file.path];
      },
    },
    workspace: {
      getLeaf: () => leaf,
      getLeavesOfType: () => [leaf],
      revealLeaf: () => undefined,
    },
  };
}

function getTool(
  app: MockApp,
  name: string,
  approveWrite = () => true,
  changeHistory = new VaultChangeHistory(() => "2026-05-15T00:00:00.000Z"),
) {
  const tools = createVaultTools(
    app as never,
    { ...DEFAULT_SETTINGS, safetyMode: "approve-writes" },
    {
      approveWrite,
      changeHistory,
    },
  );
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Missing tool: ${name}`);
  }
  return tool;
}

describe("vault tools", () => {
  it("excludes configured folders from list_notes", async () => {
    const app = createMockApp(
      [
        { path: "Public.md", extension: "md" },
        { path: ".obsidian/secret.md", extension: "md" },
      ],
      {},
    );
    const [listNotes] = createVaultTools(app as never, DEFAULT_SETTINGS);

    const result = await listNotes.execute(
      { limit: 10 },
      { signal: new AbortController().signal, toolCallId: "test" },
    );

    expect(result).toBe("Public.md");
  });

  it("blocks read_note for excluded paths", async () => {
    const app = createMockApp([{ path: ".obsidian/secret.md", extension: "md" }], {
      ".obsidian/secret.md": "secret",
    });
    const [, readNote] = createVaultTools(app as never, DEFAULT_SETTINGS);

    await expect(
      readNote.execute(
        { path: ".obsidian/secret.md" },
        { signal: new AbortController().signal, toolCallId: "test" },
      ),
    ).rejects.toThrow("Path is excluded");
  });

  it("registers write tools in approve-writes mode only", () => {
    const app = createMockApp([], {});

    expect(
      createVaultTools(app as never, { ...DEFAULT_SETTINGS, safetyMode: "read-only" }).map(
        (tool) => tool.name,
      ),
    ).toEqual(["list_notes", "read_note", "search_notes"]);
    expect(createVaultTools(app as never, DEFAULT_SETTINGS).map((tool) => tool.name)).toContain(
      "create_note",
    );
  });

  it("creates and opens a note before writing content without approval", async () => {
    const app = createMockApp([], {});
    const createNote = getTool(app, "create_note", () => {
      throw new Error("create_note should not request approval");
    });

    const result = await createNote.execute(
      { path: "Agent/New Note", content: "Hello" },
      { signal: new AbortController().signal, toolCallId: "test" },
    );

    expect(result).toContain("Created");
    expect(app.openedPaths).toEqual(["Agent/New Note.md"]);
    expect(app.viewData["Agent/New Note.md"]).toBe("Hello");
    expect(app.contents["Agent/New Note.md"]).toBe("Hello");
  });

  it("appends content to an opened note", async () => {
    const app = createMockApp([{ path: "Daily.md", extension: "md" }], { "Daily.md": "Start" });
    const appendNote = getTool(app, "append_note");

    await appendNote.execute(
      { path: "Daily.md", content: "Next" },
      { signal: new AbortController().signal, toolCallId: "test" },
    );

    expect(app.openedPaths).toEqual(["Daily.md"]);
    expect(app.contents["Daily.md"]).toBe("Start\nNext");
  });

  it("replaces exact text only when it appears once", async () => {
    const app = createMockApp([{ path: "Project.md", extension: "md" }], {
      "Project.md": "before target after",
    });
    const replaceNote = getTool(app, "replace_in_note");

    await replaceNote.execute(
      { path: "Project.md", find: "target", replace: "updated" },
      { signal: new AbortController().signal, toolCallId: "test" },
    );

    expect(app.contents["Project.md"]).toBe("before updated after");
  });

  it("lists and reverts a created note", async () => {
    const app = createMockApp([], {});
    const history = new VaultChangeHistory(() => "2026-05-15T00:00:00.000Z");
    const createNote = getTool(app, "create_note", () => true, history);
    await createNote.execute(
      { path: "Created.md", content: "temporary" },
      { signal: new AbortController().signal, toolCallId: "test" },
    );

    const listChanges = getTool(app, "list_recent_changes", () => true, history);
    const changes = await listChanges.execute(
      { limit: 5 },
      { signal: new AbortController().signal, toolCallId: "test" },
    );
    expect(changes).toContain("change-1 create Created.md");

    const revertChange = getTool(app, "revert_change", () => true, history);
    await revertChange.execute(
      { changeId: "change-1" },
      { signal: new AbortController().signal, toolCallId: "test" },
    );

    expect(app.vault.getFileByPath("Created.md")).toBeNull();
  });

  it("reverts an edit by restoring previous content", async () => {
    const app = createMockApp([{ path: "Daily.md", extension: "md" }], { "Daily.md": "Start" });
    const history = new VaultChangeHistory(() => "2026-05-15T00:00:00.000Z");
    const appendNote = getTool(app, "append_note", () => true, history);
    await appendNote.execute(
      { path: "Daily.md", content: "Next" },
      { signal: new AbortController().signal, toolCallId: "test" },
    );

    const revertChange = getTool(app, "revert_change", () => true, history);
    await revertChange.execute(
      { changeId: "change-1" },
      { signal: new AbortController().signal, toolCallId: "test" },
    );

    expect(app.contents["Daily.md"]).toBe("Start");
  });

  it("rejects ambiguous replacement text", async () => {
    const app = createMockApp([{ path: "Project.md", extension: "md" }], {
      "Project.md": "target target",
    });
    const replaceNote = getTool(app, "replace_in_note");

    await expect(
      replaceNote.execute(
        { path: "Project.md", find: "target", replace: "updated" },
        { signal: new AbortController().signal, toolCallId: "test" },
      ),
    ).rejects.toThrow("found 2");
  });
});
