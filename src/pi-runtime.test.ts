import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { RpcClient, SessionManager, type ExtensionAPI, type ExtensionFactory, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { buildPiLaunchArgs, createActlumePiExtension, resolvePiCliPath, runPiTask, type PiBridgeConfig } from "./pi-runtime.js";
import { listMemories, saveMemory } from "./memory.js";
import { readRuntimeEvents } from "./runtime-events.js";
import { saveSessionSnapshot } from "./session.js";
import { defaultSecurityPolicy } from "./security.js";
import { defaultPolicyConfig } from "./policy-config.js";
import { materializeEvalSmokeOverlay } from "../scripts/eval-smoke-overlay.js";
import { readArtifactTool } from "./tools/artifact.js";
import { createTaskDomainEvent, reduceTaskBranch, taskDomainEntryType, workspaceIdentity } from "./task-state.js";
import type { AppConfig } from "./config.js";
import type { Session } from "./types.js";

type ExtensionHandler = (...args: unknown[]) => unknown;
const execFileAsync = promisify(execFile);

function fakePi() {
  const handlers = new Map<string, ExtensionHandler>();
  const commands: string[] = [];
  const commandHandlers = new Map<string, (...args: any[]) => unknown>();
  const providers: Array<{ name: string; config: unknown }> = [];
  const servers: Array<{ name: string; config: unknown }> = [];
  const registeredTools: Array<{ name: string; definition: any }> = [];
  const api = {
    on: (event: string, handler: ExtensionHandler) => handlers.set(event, handler),
    registerCommand: (name: string, options: { handler?: (...args: any[]) => unknown }) => {
      commands.push(name);
      if (options?.handler) commandHandlers.set(name, options.handler);
    },
    registerProvider: (name: string, config: unknown) => providers.push({ name, config }),
    registerMcpServer: (name: string, config: unknown) => servers.push({ name, config }),
    registerTool: (definition: any) => registeredTools.push({ name: definition.name, definition })
  } as unknown as ExtensionAPI;
  return { api, handlers, commands, commandHandlers, providers, servers, registeredTools };
}

function bridgeConfig(workspace: string, overrides: Partial<PiBridgeConfig> = {}): PiBridgeConfig {
  return {
    workspace,
    memoryDir: join(workspace, ".agent-memory"),
    readonly: false,
    permissionMode: "default",
    model: "gpt-4.1-mini",
    securityPolicy: defaultSecurityPolicy,
    projectRoot: workspace,
    ...overrides
  };
}

test("Pi launch args preserve workspace read-only behavior and compatible model selection", () => {
  const config = bridgeConfig("C:/work/project", { readonly: true, baseURL: "https://llm.example/v1" });
  assert.deepEqual(buildPiLaunchArgs(config, "C:/actlume/pi-extension.ts"), [
    "--no-extensions",
    "--extension", "C:/actlume/pi-extension.ts",
    "--extension", "builtin:mcp",
    "--no-builtin-tools",
    "--session-dir", resolve("C:/work/project/.agent-memory", "pi-sessions"),
    "--provider", "actlume-compatible",
    "--model", "gpt-4.1-mini"
  ]);
});

test("the published Pi CLI loads the Actlume TypeScript extension and registers its provider", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-pi-cli-smoke-"));
  try {
    const marker = join(workspace, "ambient-extension-loaded.txt");
    await mkdir(join(workspace, ".pi", "extensions"), { recursive: true });
    await writeFile(join(workspace, ".pi", "extensions", "ambient.mjs"), [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(process.env.ACTLUME_EXTENSION_PROBE, "loaded");',
      "export default function ambientExtension() {}"
    ].join("\n"));
    const config = bridgeConfig(workspace, {
      readonly: true,
      permissionMode: "plan",
      baseURL: "https://llm.example/v1",
      apiKey: "test-key"
    });
    const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "pi-extension.ts");
    const result = await execFileAsync(process.execPath, [
      resolvePiCliPath(),
      ...buildPiLaunchArgs(config, extensionPath),
      "--offline",
      "--list-models", "actlume-compatible"
    ], {
      cwd: workspace,
      env: { ...process.env, ACTLUME_PI_BRIDGE_CONFIG: JSON.stringify(config), ACTLUME_EXTENSION_PROBE: marker },
      timeout: 30_000
    });

    assert.match(result.stdout, /actlume-compatible\s+gpt-4\.1-mini/);
    await assert.rejects(access(marker), { code: "ENOENT" }, "project-discovered extensions must not execute in an Actlume session");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Pi extension injects only relevant memories and converts Actlume MCP settings", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-pi-bridge-"));
  try {
    await saveMemory(join(workspace, ".agent-memory"), {
      type: "project",
      name: "Database schema",
      description: "Storage decision",
      content: "Database schema uses SQLite with one transaction per task.",
      status: "active",
      evidenceType: "verified",
      sourceRefs: ["test-fixture"]
    }, { workspace });
    await writeFile(join(workspace, ".agent-mcp.json"), JSON.stringify({
      servers: {
        docs: {
          command: "node",
          args: ["server.js"],
          env: { DOCS_MODE: "local" },
          cwd: ".",
          toolPrefix: "mcp_docs",
          startupTimeoutMs: 4_000,
          toolTimeoutMs: 8_000
        }
      }
    }));

    const fake = fakePi();
    const extension: ExtensionFactory = createActlumePiExtension(bridgeConfig(workspace));
    await extension(fake.api);

    assert.equal(fake.servers.length, 1);
    assert.equal(fake.servers[0]?.name, "docs");
    assert.deepEqual(fake.servers[0]?.config, {
      type: "stdio",
      command: "node",
      args: ["server.js"],
      env: { DOCS_MODE: "local" },
      cwd: ".",
      enabled: true,
      exposure: "direct",
      timeout: 8
    });
    assert.deepEqual(fake.commands, [
      "actlume-memory", "actlume-context", "actlume-new-task", "actlume-close-task", "actlume-accept-task", "actlume-reject-task", "actlume-changes", "actlume-verify", "actlume-result",
      "actlume-legacy", "actlume-import", "actlume-doctor"
    ]);
    assert.ok(fake.registeredTools.some((tool) => tool.name === "readFile"));
    assert.ok(fake.registeredTools.some((tool) => tool.name === "applyPatch"));
    assert.ok(!fake.registeredTools.some((tool) => tool.name === "agent"));

    const readTool = fake.registeredTools.find((tool) => tool.name === "readFile");
    assert.ok(readTool);
    const invalidRead = await readTool.definition.execute("tool-call-invalid", {}, undefined, undefined, {} as ExtensionToolContext);
    assert.equal(invalidRead.isError, true);
    assert.equal((invalidRead.details as { errorCode: string }).errorCode, "INVALID_TOOL_INPUT");

    const beforeAgentStart = fake.handlers.get("before_agent_start");
    assert.ok(beforeAgentStart);
    const result = await beforeAgentStart({ prompt: "database schema", systemPrompt: "base prompt" }, {
      sessionManager: {
        getSessionId: () => "session-test",
        getSessionFile: () => join(workspace, ".agent-memory", "pi-sessions", "session-test.jsonl")
      }
    });
    assert.match((result as { systemPrompt: string }).systemPrompt, /Database schema/);
    assert.match((result as { systemPrompt: string }).systemPrompt, /source: project_database_schema/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("memory-disabled evaluation treatment keeps a stable tool surface but disables recall, writes, and context injection", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-pi-memory-control-"));
  try {
    const memoryDir = join(workspace, ".agent-memory");
    await saveMemory(memoryDir, {
      type: "project",
      name: "Hidden memory sentinel",
      description: "Must not enter the control condition",
      content: "SECRET_MEMORY_SENTINEL",
      status: "active",
      evidenceType: "verified",
      sourceRefs: ["test-fixture"]
    }, { workspace });

    const fake = fakePi();
    await createActlumePiExtension(bridgeConfig(workspace, { memoryEnabled: false }))(fake.api);
    const enabledFake = fakePi();
    await createActlumePiExtension(bridgeConfig(workspace, { memoryEnabled: true }))(enabledFake.api);
    assert.deepEqual(
      fake.registeredTools.map((tool) => tool.name).sort(),
      enabledFake.registeredTools.map((tool) => tool.name).sort(),
      "control and memory treatment must expose the same tool schema"
    );
    assert.ok(fake.registeredTools.some((tool) => tool.name === "memorySave"));
    assert.ok(fake.registeredTools.some((tool) => tool.name === "memoryRecall"));
    assert.ok(!fake.commands.includes("actlume-memory"));

    const beforeAgentStart = fake.handlers.get("before_agent_start");
    assert.ok(beforeAgentStart);
    const result = await beforeAgentStart({ prompt: "Inspect the project", systemPrompt: "base prompt" }, {
      sessionManager: {
        getSessionId: () => "memory-control-session",
        getSessionFile: () => join(memoryDir, "pi-sessions", "memory-control-session.jsonl")
      }
    });
    const systemPrompt = (result as { systemPrompt: string }).systemPrompt;
    assert.match(systemPrompt, /Active task continuity/);
    assert.doesNotMatch(systemPrompt, /SECRET_MEMORY_SENTINEL|Hidden memory sentinel|Evidence-aware memory use/);

    const memorySave = fake.registeredTools.find((tool) => tool.name === "memorySave");
    assert.ok(memorySave);
    const blockedSave = await memorySave.definition.execute("disabled-memory-call", {
      type: "project", name: "Should not persist", description: "disabled", content: "must not be saved"
    }, undefined, undefined, {} as ExtensionToolContext);
    assert.equal(blockedSave.isError, true);
    assert.match(String(blockedSave.content?.[0]?.text ?? ""), /memory treatment is disabled/i);
    assert.equal((await listMemories(memoryDir)).length, 1, "disabled memorySave must not write a candidate");
    const memoryEvent = (await readRuntimeEvents(memoryDir, "memory-control-session")).find((event) => event.kind === "memory_retrieved");
    assert.equal(memoryEvent?.attributes?.reasonCode, "MEMORY_TREATMENT_DISABLED");
    assert.equal(memoryEvent?.attributes?.retrievalSource, "context");
    assert.equal(memoryEvent?.attributes?.memoryTreatment, "disabled");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("headless Eval autoapproves only exact configured CheckSpec commands when explicitly enabled", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-pi-headless-checkspec-"));
  try {
    await materializeEvalSmokeOverlay(workspace, "short-regression-01");
    await writeFile(join(workspace, "parser.js"), "export function parseOptionalField(value) { return value; }\n");
    const memoryDir = join(workspace, ".agent-memory");
    const fake = fakePi();
    await createActlumePiExtension(bridgeConfig(workspace, {
      memoryDir,
      permissionMode: "acceptEdits",
      allowHeadlessCheckSpec: true
    }))(fake.api);
    const sessionManager = {
      getSessionId: () => "headless-checkspec-session",
      getSessionFile: () => join(memoryDir, "pi-sessions", "headless-checkspec-session.jsonl")
    };
    await fake.handlers.get("before_agent_start")?.({ prompt: "Run the configured repository check.", systemPrompt: "base" }, {
      sessionManager,
      mode: "rpc",
      ui: {}
    });
    const toolCall = fake.handlers.get("tool_call");
    assert.ok(toolCall);

    const exact = await toolCall({
      toolCallId: "exact-checkspec-call",
      toolName: "shell",
      input: { command: "node eval-smoke-check.mjs", cwd: "." }
    }, { sessionManager, mode: "rpc", ui: {} });
    const events = await readRuntimeEvents(memoryDir, "headless-checkspec-session");
    assert.equal(events.find((event) => event.kind === "run_started")?.attributes?.headlessCheckSpecAutoapproval, true);
    assert.ok(events.some((event) => event.policyId === "headless-checkspec-v1"
      && event.reasonCode === "EXACT_CONFIGURED_CHECKSPEC_AUTOAPPROVED"
      && event.attributes?.checkSpecId === "real-model-smoke-short-regression"));
    assert.ok(!events.some((event) => event.toolCallId === "exact-checkspec-call" && event.policyId === "permission-policy-v1"));
    assert.notEqual(exact && typeof exact === "object" && "reason" in exact ? exact.reason : undefined,
      "Interactive approval is required for shell; run this task in the Actlume TUI or select an explicit permission mode.");

    const nearMatch = await toolCall({
      toolCallId: "near-match-call",
      toolName: "shell",
      input: { command: "node eval-smoke-check.mjs && node -v", cwd: "." }
    }, { sessionManager, mode: "rpc", ui: {} });
    assert.equal((nearMatch as { block?: boolean }).block, true, "an augmented command must still require interactive approval");
    assert.match((nearMatch as { reason: string }).reason, /Interactive approval is required/i);

    const strictWorkspace = join(workspace, "strict-default");
    await mkdir(strictWorkspace, { recursive: true });
    await materializeEvalSmokeOverlay(strictWorkspace, "short-regression-01");
    await writeFile(join(strictWorkspace, "parser.js"), "export function parseOptionalField(value) { return value; }\n");
    const strictMemoryDir = join(strictWorkspace, ".agent-memory");
    const strictFake = fakePi();
    await createActlumePiExtension(bridgeConfig(strictWorkspace, {
      memoryDir: strictMemoryDir,
      permissionMode: "acceptEdits"
    }))(strictFake.api);
    const strictSessionManager = {
      getSessionId: () => "headless-checkspec-default-session",
      getSessionFile: () => join(strictMemoryDir, "pi-sessions", "headless-checkspec-default-session.jsonl")
    };
    await strictFake.handlers.get("before_agent_start")?.({ prompt: "Run the configured repository check.", systemPrompt: "base" }, {
      sessionManager: strictSessionManager,
      mode: "rpc",
      ui: {}
    });
    const strictResult = await strictFake.handlers.get("tool_call")?.({
      toolCallId: "default-checkspec-call",
      toolName: "shell",
      input: { command: "node eval-smoke-check.mjs", cwd: "." }
    }, { sessionManager: strictSessionManager, mode: "rpc", ui: {} });
    assert.equal((await readRuntimeEvents(strictMemoryDir, "headless-checkspec-default-session")).find((event) => event.kind === "run_started")?.attributes?.headlessCheckSpecAutoapproval, false);
    assert.equal((strictResult as { block?: boolean }).block, true, "the opt-in must remain off for normal headless CLI tasks");
    assert.match((strictResult as { reason: string }).reason, /Interactive approval is required/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legacy sessions are read-only until explicitly imported into a new Pi session", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-pi-legacy-session-"));
  try {
    const config = bridgeConfig(workspace);
    const fake = fakePi();
    await createActlumePiExtension(config)(fake.api);
    const session: Session = {
      id: "legacy-session-1",
      startedAt: "2026-10-01T00:00:00.000Z",
      endedAt: "2026-10-01T00:01:00.000Z",
      userTask: "Inspect the old parser",
      status: "completed"
    };
    await saveSessionSnapshot(config.memoryDir, session, [{
      thought: "Read the parser",
      action: { type: "action", thought: "Read", tool: "readFile", input: { path: "src/parser.ts" } },
      observation: "Historical output from a previous runtime"
    }], "Historical final response");

    const notices: string[] = [];
    await fake.commandHandlers.get("actlume-legacy")?.("", { ui: { notify: (message: string) => notices.push(message) } });
    assert.match(notices.at(-1) ?? "", /legacy-session-1/);
    await fake.commandHandlers.get("actlume-legacy")?.("legacy-session-1", { ui: { notify: (message: string) => notices.push(message) } });
    assert.match(notices.at(-1) ?? "", /Historical output from a previous runtime/);
    assert.match(notices.at(-1) ?? "", /not a current tool execution/i);

    let imported: { customType: string; content: string; details: Record<string, unknown> } | undefined;
    await fake.commandHandlers.get("actlume-import")?.("legacy-session-1", {
      mode: "tui",
      ui: { notify: (message: string) => notices.push(message) },
      newSession: async (options: any) => {
        await options.setup({
          appendCustomMessageEntry: (customType: string, content: string, _display: boolean, details: Record<string, unknown>) => {
            imported = { customType, content, details };
          }
        });
        await options.withSession?.({ ui: { notify: (message: string) => notices.push(message) } });
        return { cancelled: false };
      }
    });
    assert.equal(imported?.customType, "actlume.legacy-import");
    assert.match(imported?.content ?? "", /Historical output from a previous runtime/);
    assert.equal(imported?.details.provenance, "historical-text-not-executable-tool-transcript");
    assert.ok(notices.some((notice) => /new Pi session/.test(notice)));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("task result and evidence commands expose runtime state without treating model stop as verification", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-pi-result-"));
  try {
    const fake = fakePi();
    await createActlumePiExtension(bridgeConfig(workspace))(fake.api);
    const sessionManager = {
      getSessionId: () => "result-session",
      getSessionFile: () => join(workspace, ".agent-memory", "pi-sessions", "result-session.jsonl")
    };
    const beforeStart = fake.handlers.get("before_agent_start");
    const settled = fake.handlers.get("agent_settled");
    assert.ok(beforeStart && settled);
    const statuses: Array<{ key: string; text?: string }> = [];
    const ui = { setStatus: (key: string, text?: string) => statuses.push({ key, text }) };
    await beforeStart({ prompt: "Check the status of this repository.", systemPrompt: "base" }, { sessionManager, mode: "tui", ui });

    await settled({}, { sessionManager, mode: "tui", ui });
    assert.equal(statuses.at(-1)?.key, "actlume-task");
    assert.match(statuses.at(-1)?.text ?? "", /completed · unknown · unjudged/);

    const notices: string[] = [];
    const commandContext = { ui: { notify: (message: string) => notices.push(message) } };
    await fake.commandHandlers.get("actlume-result")?.("", commandContext);
    assert.match(notices.at(-1) ?? "", /Evidence: unknown/);
    assert.match(notices.at(-1) ?? "", /Git workspace fingerprint is unavailable/);

    await fake.commandHandlers.get("actlume-changes")?.("", commandContext);
    assert.match(notices.at(-1) ?? "", /No workspace differences/);
    await fake.commandHandlers.get("actlume-verify")?.("", commandContext);
    assert.match(notices.at(-1) ?? "", /No verification records/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("task baseline and identity persist across prompts and reopening the same Pi branch", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-pi-task-continuity-"));
  const memoryDir = join(workspace, ".agent-memory");
  try {
    await writeFile(join(workspace, "tracked.txt"), "before\n");
    await execFileAsync("git", ["init"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@example.local"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: workspace });
    await execFileAsync("git", ["add", "."], { cwd: workspace });
    await execFileAsync("git", ["commit", "-m", "baseline"], { cwd: workspace });

    const sessionDir = join(memoryDir, "pi-sessions");
    const manager = SessionManager.create(workspace, sessionDir);
    const fake = fakePi();
    (fake.api as unknown as { appendEntry: (customType: string, data: unknown) => void }).appendEntry = (customType, data) => {
      manager.appendCustomEntry(customType, data);
    };
    await createActlumePiExtension(bridgeConfig(workspace))(fake.api);
    const beforeStart = fake.handlers.get("before_agent_start");
    assert.ok(beforeStart);
    const sessionManager = manager as unknown as ExtensionToolContext["sessionManager"];
    const context = { sessionManager, mode: "tui", ui: { setStatus: () => {}, notify: () => {} } };

    manager.appendMessage({ role: "user", content: "Implement the parser fix", timestamp: Date.now() } as any);
    await beforeStart({ prompt: "Implement the parser fix", systemPrompt: "base" }, context);
    const first = reduceTaskBranch(manager.getBranch(), workspaceIdentity(workspace)).active;
    assert.ok(first);
    const originalBaseline = first.baseline?.fingerprint;
    await writeFile(join(workspace, "tracked.txt"), "edited between user turns\n");
    manager.appendMessage({ role: "user", content: "Keep the exported API stable", timestamp: Date.now() } as any);
    await beforeStart({ prompt: "Keep the exported API stable", systemPrompt: "base" }, context);
    const second = reduceTaskBranch(manager.getBranch(), workspaceIdentity(workspace)).active;
    assert.ok(second);
    assert.equal(second.taskId, first.taskId);
    assert.equal(second.baseline?.fingerprint, originalBaseline, "a follow-up prompt must not silently move the task baseline");
    assert.equal(second.requirementRevision, 2);
    assert.equal(second.recentPrompts.at(-1)?.preview, "Keep the exported API stable");
    const reopened = SessionManager.open(manager.getSessionFile()!, sessionDir, workspace);
    const recovered = reduceTaskBranch(reopened.getBranch(), workspaceIdentity(workspace)).active;
    assert.ok(recovered);
    assert.equal(recovered?.taskId, first.taskId);
    assert.equal(recovered?.baseline?.fingerprint, originalBaseline);
    assert.equal(recovered?.requirementRevision, 2);
    assert.ok(manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === taskDomainEntryType));

    await writeFile(join(workspace, "tracked.txt"), "second task baseline\n");
    const startNewTask = fake.commandHandlers.get("actlume-new-task");
    const closeTask = fake.commandHandlers.get("actlume-close-task");
    const acceptTask = fake.commandHandlers.get("actlume-accept-task");
    assert.ok(startNewTask && closeTask && acceptTask);
    const commandContext = { ...context, ui: { notify: () => {}, setStatus: () => {} } };
    await startNewTask("Build an independent follow-up", commandContext);
    let independent = reduceTaskBranch(manager.getBranch(), workspaceIdentity(workspace)).active;
    assert.ok(independent);
    assert.notEqual(independent.taskId, first.taskId);
    assert.notEqual(independent.baseline?.fingerprint, originalBaseline);
    await acceptTask("Human reviewed the intended behavior", {
      ...context,
      ui: { notify: () => {}, confirm: async (_title: string, _message: string, options?: { signal?: AbortSignal }) => !options?.signal?.aborted }
    });
    independent = reduceTaskBranch(manager.getBranch(), workspaceIdentity(workspace)).active;
    assert.equal(independent?.taskVerdict, "accepted");
    assert.equal(independent?.taskVerdictSource, "human");
    manager.appendMessage({ role: "user", content: "Also preserve the legacy export", timestamp: Date.now() } as any);
    await beforeStart({ prompt: "Also preserve the legacy export", systemPrompt: "base" }, context);
    independent = reduceTaskBranch(manager.getBranch(), workspaceIdentity(workspace)).active;
    assert.equal(independent?.taskVerdict, "unjudged", "new requirements need a fresh human or oracle verdict");
    assert.equal(independent?.requirementRevision, 2);
    await closeTask("", commandContext);
    const closed = reduceTaskBranch(manager.getBranch(), workspaceIdentity(workspace));
    assert.equal(closed.active, undefined);
    assert.equal(closed.latest?.status, "closed");
    manager.appendMessage({ role: "user", content: "A third task", timestamp: Date.now() } as any);
    await beforeStart({ prompt: "Start over for this unrelated task", systemPrompt: "base" }, context);
    const restarted = reduceTaskBranch(manager.getBranch(), workspaceIdentity(workspace)).active;
    assert.ok(restarted);
    assert.notEqual(restarted.taskId, independent.taskId);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("task requirements, plan, unresolved side effects, and artifact access survive repeated Pi compaction and reopen", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-pi-repeated-compaction-"));
  const memoryDir = join(workspace, ".agent-memory");
  const sessionDir = join(memoryDir, "pi-sessions");
  const artifactPath = join(memoryDir, "artifacts", "compaction-fixture", "001-readFile.txt");
  try {
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, "Recovered evidence: parser reports byte offset 17.\n", "utf8");
    let manager = SessionManager.create(workspace, sessionDir, { id: "repeated-compaction-session" });
    const fake = fakePi();
    (fake.api as unknown as { appendEntry: (customType: string, data: unknown) => void }).appendEntry = (customType, data) => manager.appendCustomEntry(customType, data);
    await createActlumePiExtension(bridgeConfig(workspace, { memoryDir }))(fake.api);
    const initialPrompt = "Implement the parser fix and preserve every original byte offset.";
    manager.appendMessage({ role: "user", content: initialPrompt, timestamp: Date.now() } as any);
    const beforeStart = fake.handlers.get("before_agent_start");
    const sessionStart = fake.handlers.get("session_start");
    const compacted = fake.handlers.get("session_compact");
    assert.ok(beforeStart && sessionStart && compacted);
    const makeContext = () => ({
      sessionManager: manager as unknown as ExtensionToolContext["sessionManager"],
      mode: "tui",
      ui: { setStatus: () => {}, notify: () => {} }
    });
    let injected = await beforeStart({ prompt: initialPrompt, systemPrompt: "base" }, makeContext()) as { systemPrompt?: string };
    assert.match(injected.systemPrompt ?? "", /Initial goal:[\s\S]*preserve every original byte offset/);

    manager.appendMessage({ role: "user", content: "Also preserve the legacy error wording and report the first failing byte.", timestamp: Date.now() } as any);
    injected = await beforeStart({ prompt: "Also preserve the legacy error wording and report the first failing byte.", systemPrompt: "base" }, makeContext()) as { systemPrompt?: string };
    const state = reduceTaskBranch(manager.getBranch(), workspaceIdentity(workspace)).active;
    assert.ok(state);
    const common = { workspaceId: state.workspaceId, sessionId: state.sessionId, taskId: state.taskId, branchId: state.branchId };
    const appendState = (kind: Parameters<typeof createTaskDomainEvent>[0]["kind"], payload: Record<string, unknown>, extra: Partial<Parameters<typeof createTaskDomainEvent>[0]> = {}) => {
      manager.appendCustomEntry(taskDomainEntryType, createTaskDomainEvent({ kind, ...common, payload, ...extra }));
    };
    appendState("workflow_snapshot", {
      workflow: {
        schemaVersion: 1,
        state: {
          runId: "compaction-run",
          plan: { summary: "Parser compatibility plan", content: "Keep byte offsets stable; preserve legacy wording.", expectedFiles: ["src/parser.ts"], steps: ["inspect parser", "add regression", "run required checks"], createdAt: new Date().toISOString() },
          changedFiles: [{ path: "src/parser.ts", tool: "applyPatch", timestamp: new Date().toISOString() }],
          checks: [{ command: "npm test", ok: false, errorCode: "TESTS_NOT_RUN", timestamp: new Date().toISOString() }]
        },
        history: []
      }
    });
    appendState("tool_started", { parentToolCallId: "" }, { toolCallId: "pending-write", toolName: "writeFile", runId: "compaction-run" });
    appendState("run_interrupted", { reason: "The process ended during a file update; inspect for side effects before retry." }, { runId: "compaction-run" });

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      manager.appendMessage({ role: "assistant", content: `Long historical work notes for compaction ${cycle}.`, timestamp: Date.now() } as any);
      const keptEntryId = manager.appendMessage({ role: "user", content: `After compaction ${cycle}, continue without repeating the write.`, timestamp: Date.now() } as any);
      const compactionId = manager.appendCompaction(`Compaction summary ${cycle}: preserve the currently stated requirement and inspect uncertain side effects.`, keptEntryId, 24_000 + cycle);
      await compacted({ reason: "threshold", willRetry: false, compactionEntry: manager.getEntry(compactionId) }, makeContext());
      manager = SessionManager.open(manager.getSessionFile()!, sessionDir, workspace);
      await sessionStart({}, makeContext());
      injected = await beforeStart({
        prompt: `Continue after compaction ${cycle}; check existing files before another write.`,
        systemPrompt: "base"
      }, makeContext()) as { systemPrompt?: string };
    }

    const recoveredPrompt = injected.systemPrompt ?? "";
    assert.match(recoveredPrompt, /Initial goal:[\s\S]*preserve every original byte offset/);
    assert.match(recoveredPrompt, /Current user message:[\s\S]*check existing files before another write/);
    assert.match(recoveredPrompt, /requirement revision 5/);
    assert.match(recoveredPrompt, /Unconfirmed tool actions:[\s\S]*writeFile \(pending-write\)/);
    assert.match(recoveredPrompt, /Recovery warning:[\s\S]*Inspect unfinished side effects/);
    assert.match(recoveredPrompt, /Current plan \(Parser compatibility plan\):[\s\S]*Keep byte offsets stable/);
    assert.match(recoveredPrompt, /Prior checks[\s\S]*failed: npm test/);
    assert.doesNotMatch(JSON.stringify(manager.buildSessionContext().messages), /Implement the parser fix and preserve every original byte offset/,
      "the original user message should have fallen behind the latest Pi compaction boundary; Actlume must restore it from its domain record");

    const artifact = await readArtifactTool.run({ path: artifactPath, limit: 200 }, {
      workspace,
      memoryDir,
      signal: new AbortController().signal
    } as any);
    assert.equal(artifact.ok, true);
    assert.match(artifact.content, /byte offset 17/);
    const branch = manager.getBranch(manager.getLeafId() ?? undefined);
    assert.equal(branch.filter((entry) => entry.type === "compaction").length, 3);
    assert.equal(branch.filter((entry) => entry.type === "custom" && entry.customType === taskDomainEntryType).length >= 7, true,
      "task state events must remain in the canonical branch even when older messages are outside model context");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Pi session startup marks open runs interrupted and surfaces the side-effect recovery warning", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-pi-interrupted-run-"));
  try {
    const fake = fakePi();
    await createActlumePiExtension(bridgeConfig(workspace))(fake.api);
    const sessionManager = {
      getSessionId: () => "interrupted-session",
      getSessionFile: () => join(workspace, ".agent-memory", "pi-sessions", "interrupted-session.jsonl")
    };
    const beforeStart = fake.handlers.get("before_agent_start");
    const sessionStart = fake.handlers.get("session_start");
    assert.ok(beforeStart && sessionStart);
    const statuses: string[] = [];
    const notices: string[] = [];
    const ui = {
      setStatus: (_key: string, text?: string) => { if (text) statuses.push(text); },
      notify: (message: string) => notices.push(message)
    };
    await beforeStart({ prompt: "Implement a small change.", systemPrompt: "base" }, { sessionManager, mode: "tui", ui });
    await sessionStart({}, { sessionManager, mode: "tui", ui });
    const events = await readRuntimeEvents(join(workspace, ".agent-memory"), "interrupted-session");
    const interrupted = events.find((event) => event.kind === "run_interrupted");
    assert.equal(interrupted?.status, "interrupted");
    assert.equal(interrupted?.reasonCode, "PROCESS_RESTART_WITH_OPEN_RUN");
    assert.equal(interrupted?.attributes?.recoveryRequiresSideEffectCheck, true);
    assert.ok(statuses.some((status) => /interrupted run detected/.test(status)));
    assert.ok(notices.some((notice) => /side effects/.test(notice)));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime records cancelling before settlement and keeps cancellation distinct from verdict", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-pi-cancelling-state-"));
  try {
    const fake = fakePi();
    await createActlumePiExtension(bridgeConfig(workspace))(fake.api);
    const sessionManager = {
      getSessionId: () => "cancelling-session",
      getSessionFile: () => join(workspace, ".agent-memory", "pi-sessions", "cancelling-session.jsonl")
    };
    const context = { sessionManager, mode: "tui", ui: { setStatus: () => {}, notify: () => {} } };
    await fake.handlers.get("before_agent_start")?.({ prompt: "Implement a small parser fix", systemPrompt: "base" }, context);
    const controller = new AbortController();
    await fake.handlers.get("agent_start")?.({}, { ...context, signal: controller.signal });
    controller.abort();
    await fake.handlers.get("agent_end")?.({ messages: [{ role: "assistant", content: "", stopReason: "aborted" }] }, context);
    await fake.handlers.get("agent_settled")?.({}, context);

    const events = await readRuntimeEvents(join(workspace, ".agent-memory"), "cancelling-session");
    const cancelling = events.find((event) => event.kind === "run_cancelling");
    const finished = events.find((event) => event.kind === "run_finished");
    const claim = events.find((event) => event.kind === "completion_claim");
    assert.equal(cancelling?.status, "cancelling");
    assert.equal(finished?.status, "cancelled");
    assert.equal(finished?.attributes?.taskVerdict, "unjudged");
    assert.equal(claim?.attributes?.claimStatus, "unknown");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Pi RPC starts with Actlume commands, workspace session storage, and registered extension", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-pi-rpc-smoke-"));
  const config = bridgeConfig(workspace);
  const bridge = {
    ...config,
    baseURL: "https://llm.example/v1",
    apiKey: "test-key"
  };
  const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "pi-extension.ts");
  const client = new RpcClient({
    cliPath: resolvePiCliPath(),
    cwd: workspace,
    env: { ...process.env, ACTLUME_PI_BRIDGE_CONFIG: JSON.stringify(bridge) },
    args: ["--offline", "--extension", extensionPath, "--no-builtin-tools", "--session-dir", join(workspace, ".agent-memory", "pi-sessions"), "--session-id", "rpc-smoke-session"]
  });
  try {
    await client.start();
    const [state, commands] = await Promise.all([client.getState(), client.getCommands()]);
    assert.equal(state.sessionId, "rpc-smoke-session");
    assert.ok(commands.some((command) => command.name === "actlume-memory"));
    assert.ok(commands.some((command) => command.name === "actlume-context"));
  } finally {
    await client.stop();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Pi RPC completes a local mock-provider turn through an Actlume tool and records honest outcome evidence", async () => {
  const workspace = process.cwd();
  const memoryDir = await mkdtemp(join(tmpdir(), "actlume-pi-e2e-memory-"));

  const requests: Array<Record<string, unknown>> = [];
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push(body);
    requestCount += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "close" });

    const common = { id: "chatcmpl-local-actlume", object: "chat.completion.chunk", created: 1_799_999_999, model: "mock-model" };
    const toolArguments = JSON.stringify({ path: "package.json" });
    const events = requestCount === 1
      ? [
          { ...common, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_read_note", type: "function", function: { name: "readFile", arguments: toolArguments.slice(0, 8) } }] }, finish_reason: null }] },
          { ...common, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: toolArguments.slice(8) } }] }, finish_reason: null }] },
          { ...common, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
        ]
      : [
          { ...common, choices: [{ index: 0, delta: { role: "assistant", content: "The package name is actlume." }, finish_reason: null }] },
          { ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
        ];

    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const config: AppConfig = {
    workspace,
    memoryDir,
    readonly: false,
    model: "mock-model",
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "local-test-key",
    yes: false,
    permissionMode: "default",
    streaming: true,
    policyConfig: {
      ...structuredClone(defaultPolicyConfig),
      rules: {
        "actlume.workflow.efficiency": { version: "1.0.0", mode: "disabled" },
        "actlume.task.scope-precheck": { version: "1.0.0", mode: "observe" }
      }
    },
    sources: {
      userConfigPath: "",
      projectConfigPath: "",
      userConfigLoaded: false,
      projectConfigLoaded: false
    }
  };

  let output = "";
  let diagnostics = "";
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    diagnostics += chunk.toString();
    return true;
  }) as typeof process.stderr.write;

  try {
    const exitCode = await runPiTask(config, defaultSecurityPolicy, "Read package.json and report the package name. Do not make changes.", "local-e2e-session");
    assert.equal(exitCode, 0, JSON.stringify({ output, diagnostics, requestCount, requests }));
    assert.match(output, /package name is actlume/);
    assert.equal(requestCount, 2);
    assert.ok(JSON.stringify(requests[0]).includes('"name":"readFile"'));
    const secondMessages = requests[1]?.messages as Array<{ role?: string; content?: unknown }> | undefined;
    const toolResult = secondMessages?.find((message) => message.role === "tool");
    assert.equal(typeof toolResult?.content, "string");
    assert.ok((toolResult?.content as string).includes('"name": "actlume"'), "the second model turn should receive the Actlume tool result");

    const events = await readRuntimeEvents(memoryDir, "local-e2e-session");
    const policyRules = JSON.parse(String(events.find((event) => event.kind === "run_started")?.attributes?.policyRules)) as Array<{ id: string; mode: string }>;
    assert.deepEqual(policyRules.map(({ id, mode }) => [id, mode]), [
      ["actlume.workflow.efficiency", "disabled"],
      ["actlume.task.scope-precheck", "observe"]
    ]);
    assert.deepEqual(events.filter((event) => event.kind === "tool_started").map((event) => event.toolName), ["readFile"]);
    assert.deepEqual(events.filter((event) => event.kind === "tool_finished").map((event) => event.error), [false]);
    const finished = events.find((event) => event.kind === "run_finished");
    assert.equal(finished?.status, "completed");
    assert.equal(finished?.attributes?.evidenceStatus, "unchecked");
    assert.equal(finished?.attributes?.taskVerdict, "unjudged");
    assert.equal(finished?.attributes?.stopReason, "stop");
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rm(memoryDir, { recursive: true, force: true });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt >= 100) throw error;
        await new Promise((resolveRetry) => setTimeout(resolveRetry, 100));
      }
    }
  }
});

test("Pi scopedResearch runs isolated read-only child sessions and returns structured evidence", async () => {
  const workspace = process.cwd();
  const memoryDir = await mkdtemp(join(tmpdir(), "actlume-pi-subagent-memory-"));
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push(body);
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "close" });
    const common = { id: "chatcmpl-local-subagent", object: "chat.completion.chunk", created: 1_799_999_999, model: "mock-model" };
    const scopedArgs = JSON.stringify({
      tasks: [
        { id: "package-name", goal: "Read package.json and report the name.", scope: ["package.json"] },
        { id: "package-scripts", goal: "Read package.json and list the test scripts.", scope: ["package.json"] }
      ],
      maxSteps: 2,
      timeoutMs: 20000
    });
    const messages = Array.isArray(body.messages) ? body.messages as Array<{ role?: unknown }> : [];
    const transcript = JSON.stringify(messages);
    const isChildRequest = transcript.includes("Subtask ID:");
    const parentHasToolResult = messages.some((message) => message.role === "tool");
    const event = !isChildRequest && !parentHasToolResult
      ? { ...common, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_scoped_research", type: "function", function: { name: "scopedResearch", arguments: scopedArgs } }] }, finish_reason: "tool_calls" }] }
      : isChildRequest
        ? { ...common, choices: [{ index: 0, delta: { role: "assistant", content: JSON.stringify({ summary: "The package is actlume.", findings: [{ claim: "The npm package name is actlume.", evidence: ["package.json:2"] }], unresolved: [] }) }, finish_reason: "stop" }] }
        : { ...common, choices: [{ index: 0, delta: { role: "assistant", content: "The isolated researcher found the package name." }, finish_reason: "stop" }] };
    response.write("data: " + JSON.stringify(event) + "\n\n");
    response.write("data: [DONE]\n\n");
    response.end();
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const config: AppConfig = {
    workspace,
    memoryDir,
    readonly: false,
    model: "mock-model",
    baseURL: "http://127.0.0.1:" + address.port + "/v1",
    apiKey: "local-test-key",
    yes: false,
    permissionMode: "default",
    streaming: false,
    sources: { userConfigPath: "", projectConfigPath: "", userConfigLoaded: false, projectConfigLoaded: false }
  };
  const originalStdoutWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const exitCode = await runPiTask(config, defaultSecurityPolicy, "Research the package metadata and report it.", "scoped-research-session");
    assert.equal(exitCode, 0);
    assert.ok(requests.length >= 4, `expected a parent request, two child requests, and one completion request, saw ${requests.length}`);
    const parentTools = requests[0]?.tools as Array<{ function?: { name?: string } }> | undefined;
    assert.ok(parentTools?.some((tool) => tool.function?.name === "scopedResearch"));
    const requestTranscript = JSON.stringify(requests.map((request) => request.messages));
    assert.match(requestTranscript, /Goal: Read package\.json and report the name\./);
    assert.match(requestTranscript, /Goal: Read package\.json and list the test scripts\./);
    for (const childRequest of requests.slice(1, 3)) {
      const childTools = childRequest.tools as Array<{ function?: { name?: string } }> | undefined;
      const childToolNames = childTools?.map((tool) => tool.function?.name) ?? [];
      assert.ok(childToolNames.includes("readFile"));
      assert.ok(!childToolNames.includes("writeFile"));
      assert.ok(!childToolNames.includes("shell"));
      assert.ok(!childToolNames.includes("scopedResearch"));
    }

    const events = await readRuntimeEvents(memoryDir, "scoped-research-session");
    const starts = events.filter((event) => event.kind === "agent_started");
    const finishes = events.filter((event) => event.kind === "agent_finished");
    assert.equal(starts.length, 2);
    assert.equal(finishes.length, 2);
    assert.equal(new Set(starts.map((event) => event.agentId)).size, 2);
    for (const start of starts) {
      const finish = finishes.find((event) => event.agentId === start.agentId);
      assert.equal(finish?.parentRunId, start.runId);
      assert.equal(finish?.status, "completed");
      assert.equal(Object.hasOwn(finish?.attributes ?? {}, "inputTokens"), false, "unknown token usage must stay unknown, not use a sentinel");
      assert.equal(Object.hasOwn(finish?.attributes ?? {}, "outputTokens"), false, "unknown token usage must stay unknown, not use a sentinel");
      const childEvents = await readRuntimeEvents(join(memoryDir, "subagents", start.runId ?? "", start.agentId ?? ""), start.agentId ?? "");
      const childRun = childEvents.find((event) => event.kind === "run_finished");
      assert.ok(childRun);
      assert.equal(childRun.agentId, start.agentId);
      assert.equal(childRun.parentRunId, start.runId);
      const childUsage = childEvents.filter((event) => event.kind === "model_usage");
      assert.ok(childUsage.length > 0);
      assert.ok(childUsage.every((event) => event.usage === undefined), "Pi's all-zero usage fallback must not become measured token usage");
    }
  } finally {
    process.stdout.write = originalStdoutWrite;
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("Pi extension registers custom endpoints and gates write tools through Actlume approval", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-pi-policy-"));
  try {
    const fake = fakePi();
    await createActlumePiExtension(bridgeConfig(workspace, {
      baseURL: "https://llm.example/v1",
      apiKey: "test-key"
    }))(fake.api);

    assert.equal(fake.providers.length, 1);
    assert.equal(fake.providers[0]?.name, "actlume-compatible");
    assert.deepEqual(fake.providers[0]?.config, {
      name: "Actlume OpenAI-compatible endpoint",
      baseUrl: "https://llm.example/v1",
      apiKey: "test-key",
      api: "openai-completions",
      models: [{
        id: "gpt-4.1-mini",
        name: "gpt-4.1-mini (Actlume endpoint; pricing unknown)",
        api: "openai-completions",
        input: ["text", "image"],
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192
      }]
    });

    const toolCall = fake.handlers.get("tool_call");
    assert.ok(toolCall);
    let prompted = false;
    const rejected = await toolCall(
      { type: "tool_call", toolCallId: "call-1", toolName: "edit", input: { path: "src/index.ts", oldText: "a", newText: "b" } },
      { mode: "tui", ui: { confirm: async () => { prompted = true; return false; } } }
    );
    assert.equal(prompted, true);
    assert.deepEqual(rejected, { block: true, reason: "User rejected edit." });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Pi extension hard-blocks writes in read-only mode without opening a prompt", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-pi-readonly-"));
  try {
    const fake = fakePi();
    await createActlumePiExtension(bridgeConfig(workspace, { readonly: true }))(fake.api);
    const toolCall = fake.handlers.get("tool_call");
    assert.ok(toolCall);
    const result = await toolCall(
      { type: "tool_call", toolCallId: "call-2", toolName: "write", input: { path: "src/index.ts", content: "new" } },
      { mode: "tui", ui: { confirm: async () => assert.fail("read-only writes must not request approval") } }
    );
    assert.deepEqual(result, {
      block: true,
      reason: "Actlume is in read-only or plan mode; this operation can change state."
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("cancelling a scopedResearch parent aborts the running read-only child and records its outcome", async () => {
  const workspace = process.cwd();
  const memoryDir = await mkdtemp(join(tmpdir(), "actlume-pi-subagent-cancel-"));
  let releaseServer: (() => void) | undefined;
  let signalChildRequest: (() => void) | undefined;
  const childRequestSeen = new Promise<void>((resolveSeen) => { signalChildRequest = resolveSeen; });
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request body */ }
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    signalChildRequest?.();
    await new Promise<void>((resolveRelease) => { releaseServer = resolveRelease; });
    if (!response.destroyed) response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const manager = SessionManager.create(workspace, join(memoryDir, "sessions"), { id: "scoped-cancel-session" });
  const fake = fakePi();
  (fake.api as unknown as { appendEntry: (customType: string, data: unknown) => void }).appendEntry = (customType, data) => manager.appendCustomEntry(customType, data);
  await createActlumePiExtension(bridgeConfig(workspace, {
    memoryDir,
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "local-test-key"
  }))(fake.api);
  const context = { sessionManager: manager as unknown as ExtensionToolContext["sessionManager"], mode: "rpc", ui: { notify: () => {}, setStatus: () => {} } };
  const beforeStart = fake.handlers.get("before_agent_start");
  assert.ok(beforeStart);
  manager.appendMessage({ role: "user", content: "Research package metadata.", timestamp: Date.now() } as any);
  await beforeStart({ prompt: "Research package metadata.", systemPrompt: "base" }, context);
  const definition = fake.registeredTools.find((tool) => tool.name === "scopedResearch")?.definition as {
    execute: (id: string, args: unknown, signal?: AbortSignal) => Promise<{ isError?: boolean; content?: Array<{ text?: string }> }>;
  } | undefined;
  assert.ok(definition);
  const controller = new AbortController();
  const execution = definition.execute("call-parent-cancel", {
    tasks: [{ id: "cancel-child", goal: "Read package.json and report the package name.", scope: ["package.json"] }],
    timeoutMs: 20_000
  }, controller.signal);
  try {
    await Promise.race([
      childRequestSeen,
      new Promise<never>((_, reject) => { const timeout = setTimeout(() => reject(new Error("scopedResearch child never reached the test provider")), 20_000); timeout.unref(); })
    ]);
    controller.abort(new Error("parent cancelled"));
    const result = await Promise.race([
      execution,
      new Promise<never>((_, reject) => { const timeout = setTimeout(() => reject(new Error("scopedResearch did not settle after parent cancellation")), 20_000); timeout.unref(); })
    ]);
    assert.equal(result.isError, true);
    const payload = JSON.parse(result.content?.[0]?.text ?? "{}") as { results?: Array<{ status?: string; structured?: { unresolved?: string[] } }> };
    assert.equal(payload.results?.[0]?.status, "cancelled");
    assert.match(payload.results?.[0]?.structured?.unresolved?.[0] ?? "", /Parent task cancelled/);
    const events = await readRuntimeEvents(memoryDir, "scoped-cancel-session");
    const started = events.find((event) => event.kind === "agent_started");
    const finished = events.find((event) => event.kind === "agent_finished");
    assert.ok(started?.agentId);
    assert.equal(finished?.agentId, started?.agentId);
    assert.equal(finished?.status, "cancelled");
    assert.equal(finished?.parentRunId, started?.runId);
  } finally {
    releaseServer?.();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("aborting while a write approval dialog is open blocks the tool and records cancelled approval", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-pi-approval-cancel-"));
  try {
    const fake = fakePi();
    const memoryDir = join(workspace, ".agent-memory");
    await createActlumePiExtension(bridgeConfig(workspace, { memoryDir }))(fake.api);
    const manager = SessionManager.create(workspace, join(memoryDir, "pi-sessions"), { id: "approval-cancel-session" });
    manager.appendMessage({ role: "user", content: "Write a file after approval.", timestamp: Date.now() } as any);
    (fake.api as unknown as { appendEntry: (customType: string, data: unknown) => void }).appendEntry = (customType, data) => manager.appendCustomEntry(customType, data);
    const sessionManager = manager as unknown as ExtensionToolContext["sessionManager"];
    let signalApprovalReady: (() => void) | undefined;
    const approvalReady = new Promise<void>((resolveReady) => { signalApprovalReady = resolveReady; });
    const uiContext = {
      sessionManager,
      mode: "tui",
      ui: { notify: () => {}, setStatus: () => {}, confirm: async (_title: string, _message: string, options?: { signal?: AbortSignal }) => {
        assert.ok(options?.signal, "the approval prompt must receive the tool cancellation signal");
        if (options.signal.aborted) return false;
        signalApprovalReady?.();
        return await new Promise<boolean>((resolveApproval) => options.signal!.addEventListener("abort", () => resolveApproval(false), { once: true }));
      } }
    };
    const beforeStart = fake.handlers.get("before_agent_start");
    const toolCall = fake.handlers.get("tool_call");
    assert.ok(beforeStart && toolCall);
    await beforeStart({ prompt: "Write a file after approval.", systemPrompt: "base" }, uiContext);
    const controller = new AbortController();
    const resultPromise = toolCall(
      { type: "tool_call", toolCallId: "approval-cancel-call", toolName: "write", input: { path: join(workspace, "should-not-exist.txt"), content: "no write" } },
      { mode: "tui", signal: controller.signal, ui: uiContext.ui }
    );
    await approvalReady;
    controller.abort(new Error("user cancelled approval"));
    const result = await resultPromise as { block?: boolean; reason?: string };
    assert.equal(result.block, true);
    assert.match(result.reason ?? "", /Approval was cancelled/);
    const events = await readRuntimeEvents(memoryDir, "approval-cancel-session");
    const decision = events.find((event) => event.kind === "policy_decision" && event.reasonCode === "APPROVAL_CANCELLED");
    assert.equal(decision?.outcome, "block");
    await assert.rejects(access(join(workspace, "should-not-exist.txt")), { code: "ENOENT" });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Pi extension applies Actlume shell deny rules before requesting execution approval", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-pi-shell-policy-"));
  try {
    const fake = fakePi();
    await createActlumePiExtension(bridgeConfig(workspace, {
      securityPolicy: { ...defaultSecurityPolicy, shellDenylist: [String.raw`\bgit\s+push\b`] }
    }))(fake.api);
    const toolCall = fake.handlers.get("tool_call");
    assert.ok(toolCall);
    const result = await toolCall(
      { type: "tool_call", toolCallId: "call-3", toolName: "bash", input: { command: "git push origin main" } },
      { mode: "tui", ui: { confirm: async () => assert.fail("denied shell commands must not request approval") } }
    );
    assert.deepEqual(result, { block: true, reason: "Command matched shellDenylist." });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Pi extension still prompts before writing sensitive paths in bypass mode", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-pi-sensitive-path-"));
  try {
    const fake = fakePi();
    await createActlumePiExtension(bridgeConfig(workspace, {
      permissionMode: "bypassPermissions"
    }))(fake.api);
    const toolCall = fake.handlers.get("tool_call");
    assert.ok(toolCall);
    let prompted = false;
    const result = await toolCall(
      { type: "tool_call", toolCallId: "call-4", toolName: "write", input: { path: ".env", content: "secret=value" } },
      { mode: "tui", ui: { confirm: async () => { prompted = true; return false; } } }
    );
    assert.equal(prompted, true);
    assert.deepEqual(result, { block: true, reason: "User rejected write." });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Actlume shell tool stops promptly when Pi aborts the tool call", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-pi-shell-abort-"));
  try {
    const fake = fakePi();
    const config = bridgeConfig(workspace, { disableMcp: true, allowedTools: ["shell"] });
    await createActlumePiExtension(config)(fake.api);
    const shell = fake.registeredTools.find((item) => item.name === "shell")?.definition;
    assert.ok(shell);

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 60);
    const startedAt = Date.now();
    const result = await shell.execute(
      "cancelled-shell-call",
      { command: "node -e \"setTimeout(console.log, 1200, 42)\"", timeoutMs: 4_000 },
      controller.signal,
      undefined,
      {} as ExtensionToolContext
    );
    clearTimeout(abortTimer);

    assert.equal(controller.signal.aborted, true);
    assert.equal(result.isError, true, "an aborted shell must not return a successful tool result");
    assert.ok(Date.now() - startedAt < 800, "the tool should settle shortly after cancellation");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
