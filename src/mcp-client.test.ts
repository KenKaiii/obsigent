import { describe, expect, it, vi } from "vitest";
import { createMcpTools, type McpClientAdapter, SdkMcpClientAdapter } from "./mcp-client";

const server = {
  id: "local",
  name: "Local MCP",
  endpoint: "http://127.0.0.1:3333/mcp",
  enabled: true,
  token: "secret",
};

function createAdapter(): McpClientAdapter {
  return {
    listTools: async () => [{ name: "echo", description: "Echo" }],
    callTool: async () => ({ content: [{ type: "text", text: "hello" }] }),
  };
}

describe("MCP tool bridge", () => {
  it("uses an SDK client adapter by default", () => {
    expect(new SdkMcpClientAdapter(server)).toBeInstanceOf(SdkMcpClientAdapter);
  });

  it("converts MCP tools into AgentTools", async () => {
    const tools = await createMcpTools([server], { createAdapter });

    expect(tools.map((tool) => tool.name)).toEqual(["mcp_local_echo"]);
    await expect(
      tools[0]?.execute(
        { message: "hi" },
        { signal: new AbortController().signal, toolCallId: "test" },
      ),
    ).resolves.toBe("hello");
  });

  it("passes abort signals through adapter calls", async () => {
    const signal = new AbortController().signal;
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "hello" }] }));
    const tools = await createMcpTools([server], {
      createAdapter: () => ({
        listTools: async () => [{ name: "echo", description: "Echo" }],
        callTool,
      }),
    });

    await tools[0]?.execute({ message: "hi" }, { signal, toolCallId: "test" });

    expect(callTool).toHaveBeenCalledWith("echo", { message: "hi" }, signal);
  });

  it("ignores disabled servers", async () => {
    await expect(
      createMcpTools([{ ...server, enabled: false }], { createAdapter }),
    ).resolves.toEqual([]);
  });
});
