#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { writeFile } from "node:fs/promises";
import * as z from "zod/v4";

const server = new McpServer({
  name: "actlume-mock-mcp",
  version: "0.1.0"
});

server.registerTool(
  "web_search",
  {
    description: "Mock web search tool",
    inputSchema: {
      query: z.string()
    },
    annotations: {
      readOnlyHint: true
    }
  },
  async ({ query }) => ({
    content: [{ type: "text", text: `mock result for ${query}` }]
  })
);

server.registerTool(
  "slow_write",
  {
    description: "Writes a delayed marker to demonstrate that a client-side cancellation cannot prove remote rollback",
    inputSchema: { delayMs: z.number().int().min(1).max(5000) },
    annotations: { destructiveHint: true }
  },
  async ({ delayMs }) => {
    const markerPath = process.argv[2];
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    if (markerPath) await writeFile(markerPath, "remote side effect completed\n", "utf8");
    return { content: [{ type: "text", text: "remote write completed" }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
