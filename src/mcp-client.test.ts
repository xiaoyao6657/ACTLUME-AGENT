import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMcpToolManager } from "./mcp-client.js";

const here = dirname(fileURLToPath(import.meta.url));

test("loads and calls a mock MCP stdio server", async () => {
  const workspace = resolve(process.cwd(), ".agent-benchmark", "mcp-test");
  await mkdir(workspace, { recursive: true });
  const configPath = resolve(workspace, ".agent-mcp.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        servers: {
          mock: {
            command: process.execPath,
            args: [resolve(here, "test-fixtures", "mock-mcp-server.mjs")],
            toolPrefix: "mcp_mock",
            startupTimeoutMs: 10000,
            toolTimeoutMs: 10000
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const manager = await loadMcpToolManager({ workspace, projectRoot: workspace, configPath });
  try {
    assert.equal(manager.statuses[0]?.status, "connected");
    const tool = manager.getTools().find((item) => item.name === "mcp_mock_web_search");
    assert.ok(tool);
    const result = await tool.run({ query: "actlume" }, {
      cwd: workspace,
      memoryDir: resolve(workspace, ".agent-memory"),
      readonly: false,
      runId: "mcp-test",
      securityPolicy: {}
    });
    assert.equal(result.ok, true);
    assert.match(result.content, /mock result/);
  } finally {
    await manager.close();
  }
});
