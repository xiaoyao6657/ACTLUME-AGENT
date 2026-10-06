import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { loadMcpToolManager, mcpPiMigrationWarnings, readMcpConfig } from "./mcp-client.js";

const here = dirname(fileURLToPath(import.meta.url));

test("loads and calls a mock MCP stdio server", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "actlume-mcp-test-"));
  try {
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
      const { config } = await readMcpConfig({ workspace, projectRoot: workspace, configPath });
      const compatibilityWarnings = mcpPiMigrationWarnings(config);
      assert.ok(compatibilityWarnings.some((item) => item.includes("startupTimeoutMs") && item.includes("not enforced")));
      assert.ok(compatibilityWarnings.some((item) => item.includes("toolPrefix 'mcp_mock'") && item.includes("Pi assigns MCP tool names")));
      assert.equal(manager.statuses[0]?.status, "connected");
      const tool = manager.getTools().find((item) => item.name === "mcp_mock_web_search");
      assert.ok(tool);
      const result = await tool.run({ query: "actlume" }, {
        cwd: workspace,
        memoryDir: resolve(workspace, ".agent-memory"),
        readonly: false,
        runId: "mcp-test",
        permissionMode: "default",
        securityPolicy: {}
      });
      assert.equal(result.ok, true);
      assert.match(result.content, /mock result/);
    } finally {
      await manager.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("cancelling an in-flight MCP request passes AbortSignal and reports an unknown non-retryable remote outcome", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "actlume-mcp-cancel-"));
  const marker = resolve(workspace, "remote-side-effect.txt");
  const configPath = resolve(workspace, ".agent-mcp.json");
  await writeFile(configPath, JSON.stringify({
    servers: { mock: {
      command: process.execPath,
      args: [resolve(here, "test-fixtures", "mock-mcp-server.mjs"), marker],
      startupTimeoutMs: 10000,
      toolTimeoutMs: 10000
    } }
  }), "utf8");
  const manager = await loadMcpToolManager({ workspace, projectRoot: workspace, configPath });
  const controller = new AbortController();
  try {
    const tool = manager.getTools().find((item) => item.name.endsWith("_slow_write"));
    assert.ok(tool);
    const resultPromise = tool.run({ delayMs: 220 }, {
      cwd: workspace, memoryDir: resolve(workspace, ".agent-memory"), readonly: false, runId: "mcp-cancel",
      permissionMode: "default", securityPolicy: {}, signal: controller.signal
    });
    setTimeout(() => controller.abort(), 35);
    const result = await resultPromise;
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errorCode, "MCP_OUTCOME_UNKNOWN_AFTER_CANCEL");
    assert.equal(result.retryable, false);
    assert.equal((result.metadata as { outcome?: string }).outcome, "unknown");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 280));
    assert.match(await readFile(marker, "utf8"), /remote side effect completed/);
  } finally {
    controller.abort();
    await manager.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
