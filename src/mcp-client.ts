import type { AgentTool } from "@kenkaiiii/gg-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import type { McpServerConfig } from "./settings";

export type McpToolDefinition = Readonly<{
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}>;

export type McpCallToolResponse = Readonly<{
  content?: readonly Readonly<{
    type?: string;
    text?: string;
    data?: unknown;
    resource?: unknown;
  }>[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

export type McpClientAdapter = Readonly<{
  listTools: (signal?: AbortSignal) => Promise<readonly McpToolDefinition[]>;
  callTool: (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<McpCallToolResponse>;
}>;

export type McpClientOptions = Readonly<{
  createAdapter?: (server: McpServerConfig) => McpClientAdapter;
}>;

export class SdkMcpClientAdapter implements McpClientAdapter {
  private client: Client | null = null;
  private transport: { close?: () => Promise<void> } | null = null;

  public constructor(private readonly server: McpServerConfig) {}

  public async listTools(signal?: AbortSignal): Promise<readonly McpToolDefinition[]> {
    const client = await this.getClient(signal);
    const result = await client.listTools(undefined, signal ? { signal } : undefined);
    return [...result.tools]
      .map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema,
      }))
      .sort((first, second) => first.name.localeCompare(second.name));
  }

  public async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallToolResponse> {
    const client = await this.getClient(signal);
    const result = await client.callTool(
      { name, arguments: args },
      undefined,
      signal ? { signal } : undefined,
    );
    return result as McpCallToolResponse;
  }

  private async getClient(signal?: AbortSignal): Promise<Client> {
    if (this.client) {
      return this.client;
    }

    const client = new Client({ name: "obsigent", version: "0.1.0" });
    const transport = createTransport(this.server);
    await client.connect(transport as never, signal ? { signal } : undefined);
    this.client = client;
    this.transport = transport;
    return client;
  }

  public async close(): Promise<void> {
    await this.transport?.close?.();
    this.client = null;
    this.transport = null;
  }
}

export async function createMcpTools(
  servers: readonly McpServerConfig[],
  options: McpClientOptions = {},
  signal?: AbortSignal,
): Promise<AgentTool[]> {
  const tools: AgentTool[] = [];
  for (const server of servers.filter((candidate) => candidate.enabled)) {
    const client = options.createAdapter?.(server) ?? new SdkMcpClientAdapter(server);
    const definitions = await client.listTools(signal);
    for (const definition of definitions) {
      tools.push(toAgentTool(server, client, definition));
    }
  }
  return tools.sort((first, second) => first.name.localeCompare(second.name));
}

function createTransport(
  server: McpServerConfig,
): SSEClientTransport | StreamableHTTPClientTransport {
  const headers = server.token ? { Authorization: `Bearer ${server.token}` } : undefined;
  const endpoint = new URL(server.endpoint);
  if (server.endpoint.endsWith("/sse")) {
    return new SSEClientTransport(endpoint, {
      ...(headers ? { requestInit: { headers } } : {}),
      ...(headers
        ? { eventSourceInit: { fetch: (input, init) => fetch(input, { ...init, headers }) } }
        : {}),
    });
  }

  return new StreamableHTTPClientTransport(endpoint, {
    ...(headers ? { requestInit: { headers } } : {}),
  });
}

function toAgentTool(
  server: McpServerConfig,
  client: McpClientAdapter,
  definition: McpToolDefinition,
): AgentTool<z.ZodRecord<z.ZodString, z.ZodUnknown>> {
  const parameters = z.record(z.string(), z.unknown());
  return {
    name: `mcp_${server.id}_${definition.name}`.replace(/[^a-zA-Z0-9_]/gu, "_"),
    description: definition.description ?? `MCP tool ${definition.name} from ${server.name}.`,
    parameters,
    rawInputSchema: definition.inputSchema ?? { type: "object", properties: {} },
    execute: async (args, context) => {
      const parsedArgs = parameters.parse(args);
      const result = await client.callTool(definition.name, parsedArgs, context.signal);
      if (result.isError) {
        throw new Error(formatMcpContent(result));
      }
      return formatMcpContent(result);
    },
  } satisfies AgentTool<typeof parameters>;
}

function formatMcpContent(result: McpCallToolResponse): string {
  if (result.structuredContent && Object.keys(result.structuredContent).length > 0) {
    return JSON.stringify(result.structuredContent, null, 2);
  }
  const parts = result.content ?? [];
  if (parts.length === 0) {
    return "MCP tool returned no content.";
  }
  return parts
    .map((part) => {
      if (part.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      return JSON.stringify(part.data ?? part.resource ?? part);
    })
    .join("\n");
}
