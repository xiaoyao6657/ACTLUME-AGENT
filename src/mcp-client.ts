import { access, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { toolFailure, toolSuccess } from "./tool-result.js";
import type { ToolDefinition, ToolResult, ToolSideEffect } from "./types.js";

const mcpServerConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
  disabled: z.boolean().default(false),
  toolPrefix: z.string().optional(),
  startupTimeoutMs: z.number().int().min(1000).max(120000).default(15000),
  toolTimeoutMs: z.number().int().min(1000).max(300000).default(60000)
});

const mcpConfigSchema = z.object({
  servers: z.record(z.string(), mcpServerConfigSchema).default({})
});

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type McpConfig = z.infer<typeof mcpConfigSchema>;

export type McpLoadedServer = {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: ToolDefinition[];
  status: "connected";
  command: string;
  toolTimeoutMs: number;
};

export type McpServerStatus =
  | {
      name: string;
      status: "connected";
      command: string;
      toolCount: number;
      toolTimeoutMs: number;
    }
  | {
      name: string;
      status: "disabled" | "failed";
      command?: string;
      message?: string;
    };

export class McpToolManager {
  constructor(
    readonly configPath: string | undefined,
    readonly servers: McpLoadedServer[],
    readonly warnings: string[],
    readonly statuses: McpServerStatus[]
  ) {}

  getTools(): ToolDefinition[] {
    return this.servers.flatMap((server) => server.tools);
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.servers.map((server) => server.transport.close()));
  }
}

export async function loadMcpToolManager(params: {
  workspace: string;
  projectRoot: string;
  configPath?: string;
}): Promise<McpToolManager> {
  const configPath = await findMcpConfigPath(params);
  if (!configPath) {
    return new McpToolManager(undefined, [], [], []);
  }

  const raw = await readFile(configPath, "utf8");
  const config = mcpConfigSchema.parse(JSON.parse(raw));
  const loadedServers: McpLoadedServer[] = [];
  const warnings: string[] = [];
  const statuses: McpServerStatus[] = [];

  for (const [serverName, serverConfig] of Object.entries(config.servers)) {
    if (serverConfig.disabled) {
      statuses.push({ name: serverName, status: "disabled", command: serverConfig.command });
      continue;
    }

    try {
      const loaded = await connectMcpServer(serverName, serverConfig, params.workspace);
      loadedServers.push(loaded);
      statuses.push({
        name: serverName,
        status: "connected",
        command: [serverConfig.command, ...serverConfig.args].join(" "),
        toolCount: loaded.tools.length,
        toolTimeoutMs: serverConfig.toolTimeoutMs
      });
    } catch (error) {
      const message = (error as Error).message;
      warnings.push(`MCP server ${serverName} failed to load: ${message}`);
      statuses.push({
        name: serverName,
        status: "failed",
        command: [serverConfig.command, ...serverConfig.args].join(" "),
        message
      });
    }
  }

  return new McpToolManager(configPath, loadedServers, warnings, statuses);
}

async function findMcpConfigPath(params: {
  workspace: string;
  projectRoot: string;
  configPath?: string;
}): Promise<string | undefined> {
  const candidates = [
    params.configPath,
    process.env.AGENT_MCP_CONFIG,
    resolve(params.workspace, ".agent-mcp.json"),
    resolve(params.projectRoot, ".agent-mcp.json")
  ].filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    const fullPath = isAbsolute(candidate) ? candidate : resolve(params.workspace, candidate);
    try {
      await access(fullPath);
      return fullPath;
    } catch {
      // Try the next candidate.
    }
  }

  return undefined;
}

async function connectMcpServer(
  serverName: string,
  serverConfig: McpServerConfig,
  workspace: string
): Promise<McpLoadedServer> {
  const transport = new StdioClientTransport({
    command: serverConfig.command,
    args: serverConfig.args,
    cwd: serverConfig.cwd ? resolve(workspace, serverConfig.cwd) : workspace,
    env: {
      ...getDefaultEnvironment(),
      ...serverConfig.env
    },
    stderr: "pipe"
  });

  const client = new Client({
    name: "actlume",
    version: "0.1.0"
  });

  await withTimeout(client.connect(transport), serverConfig.startupTimeoutMs, `MCP server ${serverName} connect timed out`);
  const listed = await withTimeout(
    client.listTools(),
    serverConfig.startupTimeoutMs,
    `MCP server ${serverName} listTools timed out`
  );
  const tools = listed.tools.map((tool) => toToolDefinition(serverName, serverConfig, client, tool));

  return {
    name: serverName,
    client,
    transport,
    tools,
    status: "connected",
    command: [serverConfig.command, ...serverConfig.args].join(" "),
    toolTimeoutMs: serverConfig.toolTimeoutMs
  };
}

type McpTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type McpCallToolResult = Awaited<ReturnType<Client["callTool"]>>;
type McpContentResult = Extract<McpCallToolResult, { content: unknown[] }>;
type McpContentPart = McpContentResult["content"][number];

function toToolDefinition(
  serverName: string,
  serverConfig: McpServerConfig,
  client: Client,
  tool: McpTool
): ToolDefinition {
  const prefix = serverConfig.toolPrefix ?? `mcp_${sanitizeToolName(serverName)}`;
  const exposedName = `${prefix}_${sanitizeToolName(tool.name)}`;
  const sideEffect = inferSideEffect(tool.annotations);

  return {
    name: exposedName,
    description: `[MCP:${serverName}] ${tool.description ?? tool.name}`,
    sideEffect,
    source: "mcp",
    parameters: tool.inputSchema,
    async run(input) {
      try {
        const result = await withTimeout(
          client.callTool({
            name: tool.name,
            arguments: isRecord(input) ? input : {}
          }),
          serverConfig.toolTimeoutMs,
          `MCP tool ${exposedName} timed out after ${serverConfig.toolTimeoutMs}ms`
        );
        return formatMcpToolResult(result);
      } catch (error) {
        const message = (error as Error).message;
        return toolFailure({
          content: message,
          errorCode: message.includes("timed out") ? "MCP_TOOL_TIMEOUT" : "MCP_TOOL_EXCEPTION",
          retryable: true,
          metadata: { serverName, toolName: tool.name, exposedName }
        });
      }
    }
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function inferSideEffect(annotations: McpTool["annotations"]): ToolSideEffect {
  if (annotations?.readOnlyHint) {
    return "read";
  }

  if (annotations?.destructiveHint) {
    return "write";
  }

  return "execute";
}

function formatMcpToolResult(result: Awaited<ReturnType<Client["callTool"]>>): ToolResult {
  if ("toolResult" in result) {
    return toolSuccess(JSON.stringify(result.toolResult, null, 2), { raw: result });
  }

  const content = result.content.map(formatMcpContentPart).join("\n");
  if (result.isError) {
    return toolFailure({
      content,
      errorCode: "MCP_TOOL_ERROR",
      retryable: true,
      metadata: { structuredContent: result.structuredContent }
    });
  }

  return toolSuccess(content, {
    structuredContent: result.structuredContent
  });
}

function formatMcpContentPart(part: McpContentPart): string {
  if (part.type === "text") {
    return part.text;
  }

  if (part.type === "image") {
    return `[image:${part.mimeType}; ${part.data.length} base64 chars]`;
  }

  if (part.type === "audio") {
    return `[audio:${part.mimeType}; ${part.data.length} base64 chars]`;
  }

  if (part.type === "resource") {
    if ("text" in part.resource) {
      return `[resource:${part.resource.uri}]\n${part.resource.text}`;
    }
    return `[resource:${part.resource.uri}; ${part.resource.blob.length} base64 chars]`;
  }

  return `[resource_link:${part.uri}] ${part.name}`;
}

function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
