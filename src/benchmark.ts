import "dotenv/config";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { runAgent } from "./agent.js";
import { consumeMultilineInput, emptyMultilineState, highlightDiff, renderMarkdown } from "./cli-experience.js";
import { loadAppConfig } from "./config.js";
import { EditWorkflowStore } from "./edit-workflow.js";
import { loadMcpToolManager } from "./mcp-client.js";
import { defaultSecurityPolicy } from "./security.js";
import { runRegisteredTool } from "./tool-scheduler.js";
import type { ToolContext, ToolResult } from "./types.js";
import { tools } from "./tools/registry.js";

type BenchmarkCase = {
  id: string;
  description: string;
  run: (ctx: ToolContext) => Promise<void>;
};

type BenchmarkCaseResult = {
  id: string;
  description: string;
  passed: boolean;
  durationMs: number;
  error?: string;
};

type BenchmarkReport = {
  timestamp: string;
  workspace: string;
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  results: BenchmarkCaseResult[];
};

const benchmarkRoot = resolve(process.cwd(), ".agent-benchmark");
const memoryDir = resolve(process.cwd(), ".agent-memory");
const benchmarkMemoryDir = resolve(benchmarkRoot, ".agent-memory");

const cases: BenchmarkCase[] = [
  {
    id: "list-and-read-file",
    description: "Read files and list workspace content",
    async run(ctx) {
      await writeText(resolve(ctx.cwd, "README.md"), "# Fixture\n\nhello agent\n");
      const list = await runTool(ctx, "listDir", { path: "." });
      assertOk(list);
      assertIncludes(list.content, "README.md");

      const read = await runTool(ctx, "readFile", { path: "README.md" });
      assertOk(read);
      assertIncludes(read.content, "hello agent");
    }
  },
  {
    id: "search-text",
    description: "Search code/text with regex",
    async run(ctx) {
      await writeText(resolve(ctx.cwd, "src", "agent-note.ts"), "export const agentNote = 'benchmark';\n");
      const result = await runTool(ctx, "searchText", { root: ".", pattern: "agentNote" });
      assertOk(result);
      assertIncludes(result.content, "agent-note.ts");
    }
  },
  {
    id: "project-scan",
    description: "Build a lightweight project index",
    async run(ctx) {
      await writeText(
        resolve(ctx.cwd, "package.json"),
        JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "node test.js" } }, null, 2)
      );
      await writeText(resolve(ctx.cwd, "tsconfig.json"), "{}\n");
      await writeText(resolve(ctx.cwd, "src", "main.ts"), "export const main = true;\n");

      const result = await runTool(ctx, "projectScan", { root: ".", depth: 2 });
      assertOk(result);
      assertIncludes(result.content, "Cache: miss");
      assertIncludes(result.content, "Kinds: Node.js, TypeScript");
      assertIncludes(result.content, "Suggested checks: npm run typecheck; npm test");
      assertIncludes(result.content, "src/");

      const summary = await readFile(resolve(ctx.memoryDir, "project-summary.md"), "utf8");
      assertIncludes(summary, "# Project Summary");
      assertIncludes(summary, "npm run typecheck");

      const index = await readFile(resolve(ctx.memoryDir, "project-index.json"), "utf8");
      assertIncludes(index, "fingerprintHash");

      const cached = await runTool(ctx, "projectScan", { root: ".", depth: 2 });
      assertOk(cached);
      assertIncludes(cached.content, "Cache: hit");
    }
  },
  {
    id: "edit-plan-workflow",
    description: "Save an edit plan for the current run",
    async run(ctx) {
      await new EditWorkflowStore(ctx.memoryDir, ctx.runId).reset();
      const result = await runTool(ctx, "editPlan", {
        summary: "Update benchmark fixture",
        expectedFiles: ["README.md"],
        steps: ["Read file", "Patch text", "Run check"]
      });
      assertOk(result);
      assertIncludes(result.content, "Edit plan saved");

      const state = await new EditWorkflowStore(ctx.memoryDir, ctx.runId).get();
      if (!state.plan) {
        throw new Error("Expected edit plan to be saved.");
      }
      assertIncludes(state.plan.expectedFiles.join(","), "README.md");
    }
  },
  {
    id: "readonly-blocks-write",
    description: "Readonly mode blocks write tools",
    async run(ctx) {
      const readonlyCtx = { ...ctx, readonly: true };
      const result = await runTool(readonlyCtx, "writeFile", { path: "blocked.txt", content: "nope" });
      assertFailed(result, "READONLY_BLOCKED");
    }
  },
  {
    id: "apply-patch",
    description: "Apply a unified diff patch",
    async run(ctx) {
      await writeText(resolve(ctx.cwd, "patch-target.txt"), "before\n");
      const patch = [
        "diff --git a/patch-target.txt b/patch-target.txt",
        "index 96d80cd..3e75765 100644",
        "--- a/patch-target.txt",
        "+++ b/patch-target.txt",
        "@@ -1 +1 @@",
        "-before",
        "+after",
        ""
      ].join("\n");
      const result = await runTool(ctx, "applyPatch", { patch });
      assertOk(result);
      const content = await readFile(resolve(ctx.cwd, "patch-target.txt"), "utf8");
      assertIncludes(content, "after");
    }
  },
  {
    id: "shell-success-and-failure",
    description: "Shell returns structured success and failure",
    async run(ctx) {
      const success = await runTool(ctx, "shell", { command: "node -e \"console.log('ok')\"" });
      assertOk(success);
      assertIncludes(success.content, "ok");

      const failure = await runTool(ctx, "shell", { command: "node -e \"process.exit(7)\"" });
      assertFailed(failure, "SHELL_EXIT_NONZERO");
    }
  },
  {
    id: "security-policy",
    description: "Enforce tool permissions and shell command policy",
    async run(ctx) {
      const deniedToolCtx: ToolContext = {
        ...ctx,
        securityPolicy: { ...ctx.securityPolicy, deniedTools: ["shell"] }
      };
      const deniedTool = await runTool(deniedToolCtx, "shell", { command: "node -e \"console.log('no')\"" });
      assertFailed(deniedTool, "TOOL_DENIED");

      const allowlistCtx: ToolContext = {
        ...ctx,
        securityPolicy: { ...ctx.securityPolicy, shellAllowlist: [String.raw`^node\s+-e`] }
      };
      const notAllowed = await runTool(allowlistCtx, "shell", { command: "npm run typecheck" });
      assertFailed(notAllowed, "SHELL_NOT_ALLOWED");

      const highRisk = await runTool(ctx, "shell", { command: "git reset --hard HEAD" });
      assertFailed(highRisk, "SHELL_HIGH_RISK");
    }
  },
  {
    id: "config-precedence",
    description: "Resolve config precedence across env, user, project, and CLI",
    async run(ctx) {
      const userHome = resolve(ctx.cwd, "fake-home");
      const projectDir = resolve(ctx.cwd, "config-project");
      await writeText(
        resolve(userHome, ".actlume", "config.json"),
        JSON.stringify({ model: "user-model", maxSteps: 3, readonly: true, workspace: projectDir }, null, 2)
      );
      await writeText(
        resolve(projectDir, ".actlume", "config.json"),
        JSON.stringify({ model: "project-model", maxSteps: 5, memoryDir: ".custom-memory" }, null, 2)
      );

      const oldActlumeHome = process.env.ACTLUME_HOME;
      const oldOpenAiModel = process.env.OPENAI_MODEL;
      const oldMaxSteps = process.env.AGENT_MAX_STEPS;
      process.env.ACTLUME_HOME = userHome;
      process.env.OPENAI_MODEL = "env-model";
      process.env.AGENT_MAX_STEPS = "2";
      try {
        const config = await loadAppConfig({ model: "cli-model" }, ctx.cwd);
        if (config.workspace !== projectDir) {
          throw new Error(`Expected workspace ${projectDir}, got ${config.workspace}`);
        }
        if (config.memoryDir !== resolve(projectDir, ".custom-memory")) {
          throw new Error(`Expected project memoryDir, got ${config.memoryDir}`);
        }
        if (config.model !== "cli-model") {
          throw new Error(`Expected CLI model, got ${config.model}`);
        }
        if (config.maxSteps !== 5) {
          throw new Error(`Expected project maxSteps 5, got ${config.maxSteps}`);
        }
        if (config.readonly !== true) {
          throw new Error("Expected user readonly true.");
        }
      } finally {
        restoreEnv("ACTLUME_HOME", oldActlumeHome);
        restoreEnv("OPENAI_MODEL", oldOpenAiModel);
        restoreEnv("AGENT_MAX_STEPS", oldMaxSteps);
      }
    }
  },
  {
    id: "cli-experience-helpers",
    description: "Handle multiline input and terminal rendering helpers",
    async run(_ctx) {
      const state = emptyMultilineState();
      const first = consumeMultilineInput(state, "first line\\");
      if (first.ready) {
        throw new Error("Expected multiline input to wait for continuation.");
      }
      const second = consumeMultilineInput(state, "second line");
      if (!second.ready || second.text !== "first line\nsecond line") {
        throw new Error(`Unexpected multiline result: ${JSON.stringify(second)}`);
      }

      const diff = highlightDiff("+added\n-removed\n unchanged");
      assertIncludes(diff, "added");
      assertIncludes(diff, "removed");

      const markdown = renderMarkdown("# Title\n- item");
      assertIncludes(markdown, "Title");
      assertIncludes(markdown, "item");
    }
  },
  {
    id: "mcp-status-and-realtime-guard",
    description: "Report MCP status and block realtime tasks without search tools",
    async run(ctx) {
      const mcpConfigPath = resolve(ctx.cwd, "mcp-status.json");
      await writeText(
        mcpConfigPath,
        JSON.stringify(
          {
            servers: {
              disabled_search: {
                disabled: true,
                command: "npx",
                args: ["-y", "fake-search-server"],
                toolPrefix: "mcp_search",
                startupTimeoutMs: 1000,
                toolTimeoutMs: 1000
              }
            }
          },
          null,
          2
        )
      );

      const manager = await loadMcpToolManager({
        workspace: ctx.cwd,
        projectRoot: ctx.cwd,
        configPath: mcpConfigPath
      });
      if (manager.statuses[0]?.status !== "disabled") {
        throw new Error("Expected disabled MCP server status.");
      }

      const result = await runAgent({
        userTask: "查询今天世界杯最新比分",
        cwd: ctx.cwd,
        memoryDir: ctx.memoryDir,
        runId: "realtime-guard",
        tools,
        securityPolicy: ctx.securityPolicy
      });
      if (result.status !== "failed") {
        throw new Error(`Expected realtime guard failure, got ${result.status}`);
      }
      assertIncludes(result.answer, "MCP");
      assertIncludes(result.answer, "搜索");
    }
  },
  {
    id: "patch-path-safety",
    description: "Block patches that target paths outside the workspace",
    async run(ctx) {
      const plan = await runTool(ctx, "editPlan", {
        summary: "Attempt unsafe patch",
        expectedFiles: ["../outside.txt"],
        steps: ["Apply patch"]
      });
      assertOk(plan);
      const patch = [
        "diff --git a/../outside.txt b/../outside.txt",
        "--- a/../outside.txt",
        "+++ b/../outside.txt",
        "@@ -0,0 +1 @@",
        "+unsafe",
        ""
      ].join("\n");
      const result = await runTool(ctx, "applyPatch", { patch });
      assertFailed(result, "PATCH_PATH_BLOCKED");
    }
  },
  {
    id: "task-tracker",
    description: "Add, update, and list tracked tasks",
    async run(ctx) {
      const add = await runTool(ctx, "taskAdd", { title: "benchmark task" });
      assertOk(add);
      const id = getMetadataString(add, "id");

      const update = await runTool(ctx, "taskUpdate", { id, status: "done" });
      assertOk(update);

      const list = await runTool(ctx, "taskList", {});
      assertOk(list);
      assertIncludes(list.content, "benchmark task");
      assertIncludes(list.content, "[done]");
    }
  },
  {
    id: "invalid-tool-input",
    description: "Invalid tool input returns a structured error",
    async run(ctx) {
      const result = await runTool(ctx, "readFile", {});
      assertFailed(result, "INVALID_TOOL_INPUT");
    }
  }
];

async function main(): Promise<void> {
  const started = performance.now();
  await resetBenchmarkWorkspace();
  const ctx: ToolContext = {
    cwd: benchmarkRoot,
    memoryDir: benchmarkMemoryDir,
    readonly: false,
    runId: "benchmark",
    securityPolicy: defaultSecurityPolicy
  };

  const results: BenchmarkCaseResult[] = [];
  for (const item of cases) {
    const caseStarted = performance.now();
    try {
      await item.run(ctx);
      results.push({
        id: item.id,
        description: item.description,
        passed: true,
        durationMs: elapsed(caseStarted)
      });
    } catch (error) {
      results.push({
        id: item.id,
        description: item.description,
        passed: false,
        durationMs: elapsed(caseStarted),
        error: (error as Error).message
      });
    }
  }

  const passed = results.filter((item) => item.passed).length;
  const report: BenchmarkReport = {
    timestamp: new Date().toISOString(),
    workspace: benchmarkRoot,
    total: results.length,
    passed,
    failed: results.length - passed,
    durationMs: elapsed(started),
    results
  };

  await writeReport(report);
  printReport(report);
  if (report.failed > 0) {
    process.exitCode = 1;
  }
}

async function resetBenchmarkWorkspace(): Promise<void> {
  await rm(benchmarkRoot, { recursive: true, force: true });
  await mkdir(benchmarkRoot, { recursive: true });
  await writeText(resolve(benchmarkRoot, ".gitignore"), ".agent-memory/\n");
  await runCommand("git", ["init"], benchmarkRoot);
  await runCommand("git", ["config", "user.email", "benchmark@example.local"], benchmarkRoot);
  await runCommand("git", ["config", "user.name", "Benchmark"], benchmarkRoot);
}

async function writeReport(report: BenchmarkReport): Promise<void> {
  const dir = resolve(memoryDir, "benchmarks");
  await mkdir(dir, { recursive: true });
  const safeTimestamp = report.timestamp.replace(/[:.]/g, "-");
  await writeFile(resolve(dir, `${safeTimestamp}.json`), JSON.stringify(report, null, 2), "utf8");
}

function printReport(report: BenchmarkReport): void {
  console.log("\n[benchmark summary]");
  console.log(`total: ${report.total}`);
  console.log(`passed: ${report.passed}`);
  console.log(`failed: ${report.failed}`);
  console.log(`durationMs: ${report.durationMs}`);
  console.log("");

  for (const result of report.results) {
    const status = result.passed ? "PASS" : "FAIL";
    const suffix = result.error ? ` - ${result.error}` : "";
    console.log(`${status} ${result.id} (${result.durationMs}ms)${suffix}`);
  }
}

async function runTool(ctx: ToolContext, toolName: string, input: unknown): Promise<ToolResult> {
  return runRegisteredTool(tools, toolName, input, ctx);
}

function assertOk(result: ToolResult): asserts result is Extract<ToolResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`Expected success, got ${result.errorCode}: ${result.content}`);
  }
}

function assertFailed(result: ToolResult, errorCode: string): asserts result is Extract<ToolResult, { ok: false }> {
  if (result.ok) {
    throw new Error(`Expected failure ${errorCode}, got success: ${result.content}`);
  }

  if (result.errorCode !== errorCode) {
    throw new Error(`Expected failure ${errorCode}, got ${result.errorCode}: ${result.content}`);
  }
}

function assertIncludes(content: string, expected: string): void {
  if (!content.includes(expected)) {
    throw new Error(`Expected content to include ${JSON.stringify(expected)}, got: ${content.slice(0, 500)}`);
  }
}

function getMetadataString(result: Extract<ToolResult, { ok: true }>, key: string): string {
  if (!result.metadata || typeof result.metadata !== "object" || !(key in result.metadata)) {
    throw new Error(`Missing metadata key ${key}`);
  }

  const value = (result.metadata as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    throw new Error(`Metadata key ${key} is not a string`);
  }

  return value;
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
      }
    });
  });
}

await main();
