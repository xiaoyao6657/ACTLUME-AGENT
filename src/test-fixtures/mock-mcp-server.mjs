#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

const transport = new StdioServerTransport();
await server.connect(transport);
