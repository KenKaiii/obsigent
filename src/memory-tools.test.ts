import { describe, expect, it } from "vitest";
import { createMemoryTools } from "./memory-tools";
import { DEFAULT_SETTINGS } from "./settings";

type MockFile = Readonly<{ path: string; extension: string }>;

function createMockApp() {
  const files: MockFile[] = [];
  const contents: Record<string, string> = {};
  return {
    contents,
    vault: {
      getFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
      cachedRead: async (file: MockFile) => contents[file.path] ?? "",
      modify: async (file: MockFile, content: string) => {
        contents[file.path] = content;
      },
      create: async (path: string, content: string) => {
        const file = { path, extension: path.split(".").pop() ?? "" };
        files.push(file);
        contents[path] = content;
        return file;
      },
    },
  };
}

describe("memory tools", () => {
  it("are disabled by default", () => {
    expect(createMemoryTools(createMockApp() as never, DEFAULT_SETTINGS)).toEqual([]);
  });

  it("creates and reads the memory note when enabled", async () => {
    const app = createMockApp();
    const tools = createMemoryTools(app as never, { ...DEFAULT_SETTINGS, memoryEnabled: true });
    const append = tools.find((tool) => tool.name === "append_memory");
    const read = tools.find((tool) => tool.name === "read_memory");
    if (!append || !read) {
      throw new Error("Missing memory tools");
    }

    await append.execute(
      { content: "Remember this" },
      { signal: new AbortController().signal, toolCallId: "test" },
    );

    expect(app.contents[DEFAULT_SETTINGS.memoryNotePath]).toBe("Remember this\n");
    await expect(
      read.execute({}, { signal: new AbortController().signal, toolCallId: "test" }),
    ).resolves.toBe("Remember this\n");
  });

  it("blocks excluded memory paths", async () => {
    const app = createMockApp();
    const tools = createMemoryTools(app as never, {
      ...DEFAULT_SETTINGS,
      memoryEnabled: true,
      memoryNotePath: ".obsidian/Memory.md",
    });
    const append = tools.find((tool) => tool.name === "append_memory");
    if (!append) {
      throw new Error("Missing append_memory");
    }

    await expect(
      append.execute(
        { content: "nope" },
        { signal: new AbortController().signal, toolCallId: "test" },
      ),
    ).rejects.toThrow("Memory path is excluded");
  });
});
