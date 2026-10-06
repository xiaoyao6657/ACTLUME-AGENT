import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runPiTaskDetailed, type PiTaskResult } from "../src/pi-runtime.js";
import { readRuntimeEvents } from "../src/runtime-events.js";
import { listMemories, setMemoryStatus } from "../src/memory.js";
import type { AppConfig } from "../src/config.js";
import { defaultSecurityPolicy } from "../src/security.js";

type TaskManifest = {
  schemaVersion: 1;
  id: string;
  category: "short-task" | "long-context" | "memory-transfer" | "requirement-change" | "interruption-recovery" | "other";
  prompt: string;
  files: Record<string, string>;
  largeFiles?: Array<{ path: string; pattern: string; repetitions: number }>;
  requiredFiles: string[];
  oracleId: string;
  protocol?: {
    permissionMode?: AppConfig["permissionMode"];
    actions?: Array<{ toolName: string; input: Record<string, unknown> }>;
    finalText?: string;
    phases?: ProtocolPhase[];
    artifacts?: Array<{ name: string; noiseLine: string; sentinelLine: string; repetitions: number }>;
    interruption?: { checkpointPath: string; checkpointContains: string; checkToolName: string };
  };
};

type FaultMode = "none" | "http-500";
type ProtocolTransition = {
  kind: "verify-and-promote-memory";
  memoryName: string;
  command: "npm test" | "node generate-v1.mjs";
  updateFiles?: Record<string, string>;
};
type ProtocolPhase = {
  prompt: string;
  sessionKey: string;
  actions: Array<{ toolName: string; input: Record<string, unknown> }>;
  finalText: string;
  transitionAfter?: ProtocolTransition;
  holdAfterActions?: boolean;
};

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const taskArgument = process.argv.indexOf("--task");
const taskId = taskArgument >= 0 && process.argv[taskArgument + 1] ? process.argv[taskArgument + 1]! : "short-regression-01";
if (!/^[a-z0-9-]+$/.test(taskId)) throw new Error(`Invalid Eval task id: ${taskId}`);
const fixturePath = resolve(repositoryRoot, "evals", "fixtures", taskId, "task.json");
const oraclePath = resolve(repositoryRoot, "evals", "oracles", `${taskId}.mjs`);
const protocolRunId = randomUUID();
const fixtureRoot = resolve(repositoryRoot, ".agent-benchmark", "protocol-workspaces", protocolRunId);
const outputArgument = process.argv.indexOf("--out");
const faultArgument = process.argv.indexOf("--fault");
const outputPath = outputArgument >= 0 && process.argv[outputArgument + 1]
  ? resolve(process.argv[outputArgument + 1]!)
  : resolve(repositoryRoot, ".agent-benchmark", "protocol-runs", `${taskId}-${Date.now()}.json`);
const fault = (faultArgument >= 0 ? process.argv[faultArgument + 1] : "none") as FaultMode;

if (fault !== "none" && fault !== "http-500") throw new Error(`Unsupported protocol smoke fault: ${fault}`);

const manifest = JSON.parse(await readFile(fixturePath, "utf8")) as TaskManifest;
validateManifest(manifest);
const protocolPhases: ProtocolPhase[] = manifest.protocol?.phases ?? (
  manifest.protocol?.actions || manifest.id === "short-regression-01"
    ? [{
        prompt: manifest.prompt,
        sessionKey: "main",
        actions: manifest.protocol?.actions ?? legacyShortRegressionActions(manifest),
        finalText: manifest.protocol?.finalText ?? "Implemented the documented empty optional field while retaining malformed-input rejection."
      }]
    : []
);
if (protocolPhases.length === 0) {
  throw new Error(`Task '${manifest.id}' has a fixture and oracle but no runtime protocol script yet.`);
}
await materializeFixture(fixtureRoot, manifest);
const fixtureCommit = initializeGitFixture(fixtureRoot);
const sessionId = randomUUID();
const memoryDir = join(fixtureRoot, ".actlume-memory");
await mkdir(memoryDir, { recursive: true });
const isolatedMcpConfigPath = join(memoryDir, "mcp-empty.json");
await writeFile(isolatedMcpConfigPath, '{"servers":{}}\n', "utf8");
await materializeProtocolArtifacts(memoryDir, manifest);
const provider = await startDeterministicProvider(manifest, fault, memoryDir, protocolPhases[0]!);
const appConfig: AppConfig = {
  workspace: fixtureRoot,
  memoryDir,
  mcpConfigPath: isolatedMcpConfigPath,
  readonly: false,
  permissionMode: manifest.protocol?.permissionMode ?? "acceptEdits",
  model: "fixture-edit-v1",
  baseURL: provider.baseURL,
  apiKey: "protocol-smoke-key",
  yes: false,
  streaming: false,
  sources: {
    userConfigPath: "",
    projectConfigPath: "",
    userConfigLoaded: false,
    projectConfigLoaded: false
  }
};

let report: Record<string, unknown>;
try {
  const startedAt = Date.now();
  const sessions = new Map<string, string>();
  const executions: Array<{ phase: number; sessionId: string; runtime: PiTaskResult; events: Awaited<ReturnType<typeof readRuntimeEvents>>; error?: string }> = [];
  const transitions: Array<{ memoryName: string; filename: string; command: string; verified: boolean }> = [];
  let interruptionEvidence = {
    interruptionInjected: false,
    resumed: false,
    sameTask: false,
    runtimeTerminated: false,
    duplicateEdits: 0,
    checkPassed: false
  };
  let runtimeError: string | undefined;
  if (manifest.protocol?.interruption) {
    const result = await executeInterruptedProtocol({
      phases: protocolPhases,
      interruption: manifest.protocol.interruption,
      provider,
      appConfig,
      memoryDir,
      fixtureRoot,
      protocolRunId
    });
    executions.push(...result.executions);
    interruptionEvidence = result.evidence;
  } else {
    for (let index = 0; index < protocolPhases.length; index += 1) {
      const phase = protocolPhases[index]!;
      const previousTransition = protocolPhases[index - 1]?.transitionAfter;
      if (previousTransition) transitions.push(await executeTransition(memoryDir, fixtureRoot, previousTransition));
      provider.configurePhase(phase);
      const phaseSessionId = sessions.get(phase.sessionKey) ?? randomUUID();
      sessions.set(phase.sessionKey, phaseSessionId);
      let phaseRuntime: PiTaskResult;
      try {
        phaseRuntime = await withIsolatedEvalEnvironment(memoryDir, () =>
          runPiTaskDetailed(appConfig, defaultSecurityPolicy, phase.prompt, phaseSessionId, { silent: true }));
      } catch (error) {
        runtimeError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        phaseRuntime = {
          schemaVersion: 1,
          sessionId: phaseSessionId,
          runtimeStatus: "failed",
          evidenceStatus: "unknown",
          taskVerdict: "unjudged",
          reason: "Pi runtime failed before a structured result was produced.",
          changedFiles: [],
          exitCode: 1
        };
      }
      executions.push({ phase: index, sessionId: phaseSessionId, runtime: phaseRuntime, events: await readRuntimeEvents(memoryDir, phaseSessionId), ...(runtimeError ? { error: runtimeError } : {}) });
      if (phaseRuntime.runtimeStatus !== "completed") break;
    }
  }
  const durationMs = Date.now() - startedAt;
  const runtime = executions.at(-1)?.runtime ?? {
    schemaVersion: 1 as const, sessionId, runtimeStatus: "failed" as const, evidenceStatus: "unknown" as const,
    taskVerdict: "unjudged" as const, reason: "No protocol phase ran.", changedFiles: [], exitCode: 1
  };
  const runtimeEvents = executions.flatMap((execution) => execution.events);
  const completedRuns = new Set(executions.map((execution) => execution.runtime.runId).filter((value): value is string => Boolean(value)));
  const matchingEvents = runtimeEvents.filter((event) => completedRuns.size === 0 || !event.runId || completedRuns.has(event.runId));
  const latestFinished = [...matchingEvents].reverse().find((event) => event.kind === "run_finished");
  const claim = [...matchingEvents].reverse().find((event) => event.kind === "completion_claim");
  const policyEvents = matchingEvents.filter((event) => event.kind === "policy_decision");
  const taskEntries = await readPersistedTaskEntries(memoryDir);
  const latestPhaseSessionIds = [...new Set(executions.map((execution) => execution.sessionId))];
  const phaseTaskIds = executions.map((execution) => execution.events.find((event) =>
    event.kind === "run_finished" && event.runId === execution.runtime.runId
  )?.taskId);
  const staleRejections = executions.flatMap((execution) => execution.events
    .filter((event) => event.kind === "memory_retrieved")
    .flatMap((event) => Array.isArray(event.attributes?.rejected) ? event.attributes.rejected : []));
  const latestFollowupMemoryEvent = executions.length > 1
    ? executions.at(-1)!.events.find((event) => event.kind === "memory_retrieved")
    : undefined;
  const verifiedTransition = transitions.find((transition) => transition.verified);
  const promotedMemory = verifiedTransition
    ? (await listMemories(memoryDir)).find((memory) => memory.filename === verifiedTransition.filename)
    : undefined;
  const verifiedMemoryProvenance = Boolean(verifiedTransition && promotedMemory?.status === "active"
    && promotedMemory.evidenceType === "verified" && promotedMemory.content.includes(verifiedTransition.command)
    && (promotedMemory.sourceRefs?.length ?? 0) > 0);
  const requirementRevision = inferRequirementRevision(taskEntries, latestPhaseSessionIds.at(-1));
  const oracleEvidence = {
    runtimeStatus: runtime.runtimeStatus,
    evidenceStatus: runtime.evidenceStatus,
    completionClaimStatus: claim?.attributes?.claimStatus,
    independentTestVerdict: matchingEvents.some((event) => event.kind === "verification_finished" && event.status === "failed") ? "fail" : undefined,
    changedFiles: runtime.changedFiles,
    policyEvents: policyEvents.map(({ outcome, reasonCode, toolName }) => ({ outcome, reasonCode, toolName })),
    usefulActionAfterBlock: hasUsefulActionAfterBlock(matchingEvents),
    artifactRetrieved: matchingEvents.some((event) => event.kind === "tool_finished" && event.toolName === "readArtifact")
      && provider.artifactSentinelObserved,
    artifactToolResults: provider.artifactSentinelObserved ? ["INC-48271 · cache invalidation skipped after config reload"] : [],
    finalAnswer: provider.finalText,
    runFinishedEvidenceStatus: latestFinished?.attributes?.evidenceStatus,
    commandVerified: transitions.some((transition) => transition.verified),
    command: transitions.find((transition) => transition.verified)?.command,
    verifiedMemoryProvenance,
    memorySelectedInFreshSession: executions.length > 1
      && latestPhaseSessionIds.at(-1) !== latestPhaseSessionIds[0]
      && Array.isArray(executions.at(-1)?.events.find((event) => event.kind === "memory_retrieved")?.attributes?.selected)
      && executions.at(-1)!.events.find((event) => event.kind === "memory_retrieved")!.attributes!.selected
        .some((value) => typeof value === "string" && value.includes(transitions.find((transition) => transition.verified)?.filename ?? "\0")),
    staleMemoryExposed: staleRejections.some((value) => typeof value === "string" && value.endsWith(":stale_file")),
    staleMemoryRejected: staleRejections.some((value) => typeof value === "string" && value.endsWith(":stale_file")),
    staleMemoryMisused: provider.obsoleteMemoryReturned || provider.finalText.includes("generate-v1.mjs"),
    requirementRevision,
    sameSession: new Set(executions.map((execution) => execution.sessionId)).size === 1,
    phaseCount: executions.length,
    phaseResults: executions.map(({ phase, sessionId: currentSession, runtime: phaseResult }, index) => ({ phase, sessionId: currentSession, runId: phaseResult.runId, taskId: phaseTaskIds[index], runtimeStatus: phaseResult.runtimeStatus, evidenceStatus: phaseResult.evidenceStatus })),
    taskDomainEntryCount: taskEntries.length,
    staleMemoryRejectedForFollowup: Array.isArray(latestFollowupMemoryEvent?.attributes?.rejected)
      && latestFollowupMemoryEvent.attributes.rejected.some((value) => typeof value === "string" && value.endsWith(":stale_file")),
    ...interruptionEvidence,
    // The event log is the canonical identity evidence; keep this after the
    // interruption projection so its default field cannot overwrite it.
    sameTask: manifest.protocol?.interruption
      ? interruptionEvidence.sameTask
      : phaseTaskIds.length > 1 && phaseTaskIds.every((taskId) => Boolean(taskId) && taskId === phaseTaskIds[0])
  };
  const verdict = runtime.runtimeStatus === "completed"
    ? await runHiddenOracle(fixtureRoot, oraclePath, oracleEvidence)
    : { verdict: "unknown" as const, reason: `oracle skipped because runtime status was ${runtime.runtimeStatus}` };
  const toolRequests = provider.requests.filter((request) => request.toolCallSent).length;
  const reportData = {
    schemaVersion: 1,
    dataClass: "protocol-validation-only",
    qualityClaim: false,
    runId: randomUUID(),
    taskId: manifest.id,
    workspacePath: fixtureRoot,
    oracleId: manifest.oracleId,
    fixtureCommit,
    fixtureHash: sha256(canonicalJson(manifest)),
    promptHash: sha256(manifest.prompt),
    actlumeCommit: tryGit("rev-parse", "HEAD", repositoryRoot),
    candidateWorktreeHash: candidateWorktreeHash(repositoryRoot),
    provider: {
      id: "deterministic-protocol-provider-v1",
      modelId: "fixture-edit-v1",
      modelRevision: "scripted-tool-call-v1",
      fault,
      requests: provider.requests.length,
      toolCallResponses: toolRequests,
      finalResponses: provider.finalResponses,
      httpFailures: provider.httpFailures,
      phaseCount: protocolPhases.length,
      harnessTransitions: transitions.length,
      artifactSentinelObserved: provider.artifactSentinelObserved,
      finalAnswerHash: sha256(provider.finalText),
      requestSummaries: provider.requests.map(({ toolCallSent, toolNames, messageRoles }) => ({ toolCallSent, toolNames, messageRoles }))
    },
    runtime: {
      ...runtime,
      permissionMode: appConfig.permissionMode,
      phaseCount: executions.length,
      durationMs,
      requestedToolCalls: matchingEvents.filter((event) => event.kind === "tool_requested").length,
      executedToolCalls: matchingEvents.filter((event) => event.kind === "tool_started").length,
      finishedToolCalls: matchingEvents.filter((event) => event.kind === "tool_finished").length,
      blockedToolCalls: matchingEvents.filter((event) => event.kind === "policy_decision" && event.outcome === "block").length,
      modelRequests: matchingEvents.filter((event) => event.kind === "model_usage").length,
      usage: sumKnownUsage(matchingEvents.filter((event) => event.kind === "model_usage").map((event) => event.usage)),
      compressionEvents: matchingEvents.filter((event) => event.kind === "context_compacted").length,
      retryCount: provider.httpFailures
    },
    runtimeError,
    oracleEvidence: {
      runtimeStatus: oracleEvidence.runtimeStatus,
      evidenceStatus: oracleEvidence.evidenceStatus,
      completionClaimStatus: oracleEvidence.completionClaimStatus ?? "unknown",
      changedFiles: oracleEvidence.changedFiles,
      policyInterventions: policyEvents.filter((event) => event.outcome === "block").length,
      artifactRetrieved: oracleEvidence.artifactRetrieved,
      phaseCount: executions.length,
      requirementRevision: oracleEvidence.requirementRevision,
      memorySelectedInFreshSession: oracleEvidence.memorySelectedInFreshSession,
      staleMemoryExposed: oracleEvidence.staleMemoryExposed,
      staleMemoryMisused: oracleEvidence.staleMemoryMisused,
      interruptionInjected: interruptionEvidence.interruptionInjected,
      resumed: interruptionEvidence.resumed,
      sameTask: oracleEvidence.sameTask,
      runtimeTerminated: interruptionEvidence.runtimeTerminated,
      duplicateEdits: interruptionEvidence.duplicateEdits,
      checkPassed: interruptionEvidence.checkPassed,
      finalAnswerHash: sha256(provider.finalText)
    },
    phases: oracleEvidence.phaseResults,
    oracle: verdict,
    patch: git("diff", "--no-ext-diff", "--", ".", fixtureRoot),
    runtimeEvents
  };
  report = reportData;
} finally {
  await provider.close();
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
const runtimeSummary = report.runtime as { runtimeStatus?: string };
const oracleSummary = report.oracle as { verdict?: string };
const protocolValidated = fault === "none"
  ? runtimeSummary.runtimeStatus === "completed" && (runtimeSummary as { phaseCount?: number }).phaseCount === protocolPhases.length && oracleSummary.verdict === "pass"
  : runtimeSummary.runtimeStatus === "failed" && oracleSummary.verdict === "unknown";
process.stdout.write(`${JSON.stringify({ outputPath, dataClass: report.dataClass, protocolValidated, runtime: report.runtime, oracle: report.oracle })}\n`);
if (!protocolValidated) process.exitCode = 1;

function validateManifest(value: TaskManifest): void {
  if (value.schemaVersion !== 1 || value.id !== taskId || !value.prompt?.trim()
    || !Array.isArray(value.requiredFiles) || value.requiredFiles.length === 0
    || !value.files || typeof value.files !== "object" || Array.isArray(value.files)
    || value.oracleId !== `${value.id}-hidden-v1`) {
    throw new Error("Unsupported or unsafe Eval task manifest.");
  }
  for (const path of [...Object.keys(value.files), ...(value.largeFiles ?? []).map((file) => file.path), ...value.requiredFiles]) {
    if (!path || path.startsWith("/") || path.split(/[\\/]/).includes("..") || path.includes("\\")) throw new Error(`Fixture path escapes task root: ${path}`);
  }
  for (const required of value.requiredFiles) if (!Object.hasOwn(value.files, required) && !(value.largeFiles ?? []).some((file) => file.path === required)) {
    throw new Error(`Required fixture file is not materialized: ${required}`);
  }
  if (value.protocol && value.protocol.phases?.some((phase) => !phase.prompt?.trim() || !phase.sessionKey
    || !Array.isArray(phase.actions) || typeof phase.finalText !== "string")) throw new Error("Invalid deterministic protocol phase.");
  if (value.protocol?.actions && value.protocol.actions.some((action) => !action.toolName || !action.input)) throw new Error("Invalid deterministic protocol action.");
}

async function materializeFixture(workspace: string, task: TaskManifest): Promise<void> {
  await mkdir(workspace, { recursive: true });
  for (const [relativePath, contents] of Object.entries(task.files)) {
    const path = resolve(workspace, relativePath);
    if (path !== workspace && !path.startsWith(`${workspace}${sep}`)) throw new Error(`Fixture path escapes task root: ${relativePath}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
  }
  for (const file of task.largeFiles ?? []) {
    if (!Number.isInteger(file.repetitions) || file.repetitions < 1 || file.repetitions > 100_000) throw new Error(`Invalid generated large file: ${file.path}`);
    const path = resolve(workspace, file.path);
    if (path !== workspace && !path.startsWith(`${workspace}${sep}`)) throw new Error(`Fixture path escapes task root: ${file.path}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.pattern.repeat(file.repetitions), "utf8");
  }
}

function initializeGitFixture(workspace: string): string {
  git("init", "-q", workspace);
  git("config", "user.email", "eval-fixture@actlume.invalid", workspace);
  git("config", "user.name", "Actlume Eval Fixture", workspace);
  git("add", "-A", workspace);
  git("commit", "-q", "-m", "fixture baseline", workspace);
  return git("rev-parse", "HEAD", workspace);
}

function git(...args: string[]): string {
  const cwd = args.at(-1)!;
  const commandArgs = args.slice(0, -1);
  return execFileSync("git", commandArgs, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function candidateWorktreeHash(root: string): string {
  try {
    const status = execFileSync("node", ["scripts/worktree-manifest.mjs"], { cwd: root, encoding: "utf8", windowsHide: true });
    const manifestValue = JSON.parse(status) as { candidateSha256?: string };
    return manifestValue.candidateSha256 ?? "unknown";
  } catch {
    return "unavailable-not-a-git-checkout";
  }
}

function tryGit(...args: string[]): string {
  try { return git(...args); }
  catch { return "unavailable-not-a-git-checkout"; }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right, "en"));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function runHiddenOracle(workspace: string, path: string, evidence: Record<string, unknown>): Promise<{ verdict: "pass" | "fail" | "unknown"; checks?: number; reason?: string; metrics?: Record<string, unknown> }> {
  const oracle = await import(pathToFileURL(path).href) as { evaluate: (path: string, evidence?: Record<string, unknown>) => Promise<{ verdict: "pass" | "fail" | "unknown"; checks?: number; reason?: string; metrics?: Record<string, unknown> }> };
  return oracle.evaluate(workspace, evidence);
}

async function materializeProtocolArtifacts(memoryDir: string, task: TaskManifest): Promise<void> {
  for (const artifact of task.protocol?.artifacts ?? []) {
    if (!/^[A-Za-z0-9._-]+$/.test(artifact.name) || artifact.name.includes("..")
      || !Number.isInteger(artifact.repetitions) || artifact.repetitions < 1 || artifact.repetitions > 100_000) {
      throw new Error(`Invalid protocol artifact specification: ${artifact.name}`);
    }
    const path = resolve(memoryDir, "artifacts", artifact.name);
    const root = resolve(memoryDir, "artifacts");
    if (!path.startsWith(`${root}${sep}`)) throw new Error(`Protocol artifact path escapes artifact root: ${artifact.name}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, artifact.sentinelLine + artifact.noiseLine.repeat(artifact.repetitions), "utf8");
  }
}

async function withIsolatedEvalEnvironment<T>(memoryDir: string, run: () => Promise<T>): Promise<T> {
  const keys = [
    "AGENT_MCP_CONFIG", "AGENT_ALLOWED_TOOLS", "AGENT_DENIED_TOOLS", "AGENT_SHELL_ALLOWLIST", "AGENT_SHELL_DENYLIST",
    "AGENT_ALLOW_HIGH_RISK_SHELL", "ACTLUME_OTEL_EXPORTER_OTLP_ENDPOINT", "ACTLUME_OTEL_EXPORTER_OTLP_HEADERS",
    "OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL", "EVAL_FIXTURE_ENV"
  ];
  const localValues: Record<string, string> = {
    ACTLUME_HOME: join(memoryDir, "actlume-home"),
    PI_CODING_AGENT_DIR: join(memoryDir, "pi-config"),
    PI_OFFLINE: "1"
  };
  const allKeys = [...new Set([...keys, ...Object.keys(localValues)])];
  const original = new Map(allKeys.map((key) => [key, process.env[key]]));
  for (const key of allKeys) delete process.env[key];
  for (const [key, value] of Object.entries(localValues)) process.env[key] = value;
  try { return await run(); }
  finally {
    for (const key of allKeys) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function executeTransition(
  memoryDir: string,
  workspace: string,
  transition: ProtocolTransition
): Promise<{ memoryName: string; filename: string; command: string; verified: boolean }> {
  const candidate = (await listMemories(memoryDir)).find((entry) => entry.name === transition.memoryName && entry.status === "candidate");
  if (!candidate || !candidate.content.includes(transition.command)) {
    throw new Error(`Expected candidate memory '${transition.memoryName}' to record '${transition.command}'.`);
  }
  const checked = runWhitelistedFixtureCommand(transition.command, workspace);
  if (checked.exitCode !== 0) throw new Error(`Independent memory promotion check '${transition.command}' failed with exit code ${checked.exitCode}.`);
  const active = await setMemoryStatus(memoryDir, candidate.filename, "active", "verified");
  if (!active || active.status !== "active" || active.evidenceType !== "verified") throw new Error(`Could not activate verified memory '${candidate.name}'.`);
  for (const [relativePath, contents] of Object.entries(transition.updateFiles ?? {})) {
    if (!relativePath || relativePath.startsWith("/") || relativePath.split(/[\\/]/).includes("..") || relativePath.includes("\\")) {
      throw new Error(`Unsafe protocol transition path '${relativePath}'.`);
    }
    const path = resolve(workspace, relativePath);
    if (!path.startsWith(`${workspace}${sep}`)) throw new Error(`Protocol transition path escapes fixture root: ${relativePath}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
  }
  return { memoryName: candidate.name, filename: candidate.filename, command: transition.command, verified: true };
}

function runWhitelistedFixtureCommand(command: ProtocolTransition["command"], workspace: string): { exitCode: number } {
  try {
    if (command === "npm test") {
      const npmCliPath = process.env.npm_execpath;
      if (!npmCliPath) throw new Error("npm_execpath is unavailable; invoke the protocol runner through npm.");
      execFileSync(process.execPath, [npmCliPath, "test"], { cwd: workspace, windowsHide: true, stdio: "pipe" });
    } else {
      execFileSync(process.execPath, ["generate-v1.mjs"], { cwd: workspace, windowsHide: true, stdio: "pipe" });
    }
    return { exitCode: 0 };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { status?: number }).status;
    return { exitCode: typeof code === "number" ? code : 1 };
  }
}

async function readPersistedTaskEntries(memoryDir: string): Promise<Array<{ kind: string; sessionId: string; taskId: string; payload: Record<string, unknown> }>> {
  const sessionDirectory = join(memoryDir, "pi-sessions");
  let files: string[];
  try { files = (await readdir(sessionDirectory)).filter((name) => name.endsWith(".jsonl")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const events: Array<{ kind: string; sessionId: string; taskId: string; payload: Record<string, unknown> }> = [];
  for (const filename of files) {
    const raw = await readFile(join(sessionDirectory, filename), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let entry: unknown;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== "actlume.task-state.v1" || !isRecord(entry.data)) continue;
      const data = entry.data;
      if (typeof data.kind !== "string" || typeof data.sessionId !== "string" || typeof data.taskId !== "string" || !isRecord(data.payload)) continue;
      events.push({ kind: data.kind, sessionId: data.sessionId, taskId: data.taskId, payload: data.payload });
    }
  }
  return events;
}

async function executeInterruptedProtocol(input: {
  phases: ProtocolPhase[];
  interruption: NonNullable<NonNullable<TaskManifest["protocol"]>["interruption"]>;
  provider: Awaited<ReturnType<typeof startDeterministicProvider>>;
  appConfig: AppConfig;
  memoryDir: string;
  fixtureRoot: string;
  protocolRunId: string;
}): Promise<{
  executions: Array<{ phase: number; sessionId: string; runtime: PiTaskResult; events: Awaited<ReturnType<typeof readRuntimeEvents>> }>;
  evidence: { interruptionInjected: boolean; resumed: boolean; sameTask: boolean; runtimeTerminated: boolean; duplicateEdits: number; checkPassed: boolean };
}> {
  if (input.phases.length !== 2 || !input.phases[0]!.holdAfterActions
    || input.phases[0]!.sessionKey !== input.phases[1]!.sessionKey) {
    throw new Error("Interrupt recovery requires two phases on one session and a held first-phase response.");
  }
  const first = input.phases[0]!;
  const second = input.phases[1]!;
  const sessionId = randomUUID();
  const checkpoint = resolve(input.fixtureRoot, input.interruption.checkpointPath);
  if (!checkpoint.startsWith(`${input.fixtureRoot}${sep}`)) throw new Error("Interrupt checkpoint escaped fixture root.");
  input.provider.configurePhase(first);

  const firstAttempt = await withIsolatedEvalEnvironment(input.memoryDir, async () => {
    const worker = startProtocolWorker(input.appConfig, first.prompt, sessionId, input.fixtureRoot);
    const reachedCheckpoint = await waitForToolCheckpoint(worker, checkpoint, input.interruption.checkpointContains,
      input.memoryDir, sessionId, input.interruption.checkToolName, 60_000);
    const runtimeTerminated = reachedCheckpoint && !worker.exited && await terminateProtocolWorkerTree(worker.child);
    if (!reachedCheckpoint && !worker.exited) await terminateProtocolWorkerTree(worker.child);
    const exit = await worker.completion;
    input.provider.releaseHeldResponses();
    return { reachedCheckpoint, runtimeTerminated, exit };
  });

  const firstEvents = await readRuntimeEvents(input.memoryDir, sessionId);
  const firstTaskEntries = await readPersistedTaskEntries(input.memoryDir);
  const firstTask = [...firstTaskEntries].reverse().find((entry) => entry.sessionId === sessionId);
  const firstRun = [...firstEvents].reverse().find((event) => event.kind === "run_started");
  const interrupted: PiTaskResult = {
    schemaVersion: 1,
    sessionId,
    ...(firstRun?.runId ? { runId: firstRun.runId } : {}),
    ...(firstTask?.taskId ? { taskId: firstTask.taskId } : {}),
    runtimeStatus: firstAttempt.reachedCheckpoint && firstAttempt.runtimeTerminated ? "interrupted" : "failed",
    evidenceStatus: "unknown",
    taskVerdict: "unjudged",
    reason: firstAttempt.reachedCheckpoint && firstAttempt.runtimeTerminated
      ? "Worker process tree was forcibly terminated after the edit checkpoint and before verification."
      : `Interrupt checkpoint or confirmed process termination failed (${firstAttempt.exit.stderr.slice(0, 300)}).`,
    changedFiles: firstAttempt.reachedCheckpoint ? [input.interruption.checkpointPath.replaceAll("\\", "/")] : [],
    exitCode: firstAttempt.reachedCheckpoint && firstAttempt.runtimeTerminated ? 130 : 1
  };
  const executions: Array<{ phase: number; sessionId: string; runtime: PiTaskResult; events: Awaited<ReturnType<typeof readRuntimeEvents>> }> = [
    { phase: 0, sessionId, runtime: interrupted, events: firstEvents }
  ];

  let resumed: PiTaskResult | undefined;
  let resumeEvents: Awaited<ReturnType<typeof readRuntimeEvents>> = [];
  if (firstAttempt.reachedCheckpoint && firstAttempt.runtimeTerminated) {
    input.provider.configurePhase(second);
    try {
      resumed = await withIsolatedEvalEnvironment(input.memoryDir, () =>
        runPiTaskDetailed(input.appConfig, defaultSecurityPolicy, second.prompt, sessionId, { silent: true }));
    } catch (error) {
      resumed = {
        schemaVersion: 1, sessionId, runtimeStatus: "failed", evidenceStatus: "unknown", taskVerdict: "unjudged",
        reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error), changedFiles: [], exitCode: 1
      };
    }
    const allEvents = await readRuntimeEvents(input.memoryDir, sessionId);
    const firstIds = new Set(firstEvents.map((event) => event.eventId));
    resumeEvents = allEvents.filter((event) => !firstIds.has(event.eventId));
    executions.push({ phase: 1, sessionId, runtime: resumed, events: resumeEvents });
  }

  const allProtocolEvents = [...firstEvents, ...resumeEvents];
  const writes = allProtocolEvents.filter((event) => event.kind === "tool_started" && event.toolName === "writeFile").length;
  const resumedTask = resumed?.taskId;
  const sameTask = Boolean(firstTask?.taskId && resumedTask && firstTask.taskId === resumedTask);
  return {
    executions,
    evidence: {
      interruptionInjected: firstAttempt.reachedCheckpoint && firstAttempt.runtimeTerminated,
      resumed: Boolean(resumed && resumed.sessionId === sessionId && resumed.runtimeStatus === "completed"),
      sameTask,
      runtimeTerminated: firstAttempt.runtimeTerminated,
      duplicateEdits: Math.max(0, writes - 1),
      checkPassed: resumed?.exitCode === 0 && resumed.evidenceStatus === "checks_passed"
    }
  };
}

type ProtocolWorker = {
  child: ChildProcess;
  exited: boolean;
  completion: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;
};

function startProtocolWorker(config: AppConfig, prompt: string, sessionId: string, cwd: string): ProtocolWorker {
  const workerPath = resolve(repositoryRoot, "scripts", "eval-protocol-worker.ts");
  const workerConfig = JSON.stringify({ config, prompt, sessionId });
  const env = { ...process.env, ACTLUME_EVAL_WORKER_CONFIG: workerConfig };
  const child = spawn(process.execPath, ["--import", "tsx", workerPath], {
    cwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  let exited = false;
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      exited = true;
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
  return { child, get exited() { return exited; }, completion };
}

async function waitForToolCheckpoint(
  worker: ProtocolWorker,
  checkpointPath: string,
  expectedText: string,
  memoryDir: string,
  sessionId: string,
  toolName: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !worker.exited) {
    const content = await readFile(checkpointPath, "utf8").catch(() => "");
    const events = await readRuntimeEvents(memoryDir, sessionId).catch(() => []);
    if (content.includes(expectedText) && events.some((event) => event.kind === "tool_finished" && event.toolName === toolName && !event.error)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  return false;
}

async function terminateProtocolWorkerTree(child: ChildProcess): Promise<boolean> {
  if (!child.pid) return false;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10_000 });
    } catch {
      return false;
    }
    return true;
  }
  try { process.kill(-child.pid, "SIGKILL"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
  return true;
}

function inferRequirementRevision(
  events: Array<{ kind: string; sessionId: string; taskId: string; payload: Record<string, unknown> }>,
  sessionId: string | undefined
): number | undefined {
  if (!sessionId) return undefined;
  const opened = [...events].reverse().find((event) => event.sessionId === sessionId && event.kind === "task_opened");
  if (!opened) return undefined;
  const prompts = events.filter((event) => event.sessionId === sessionId && event.taskId === opened.taskId && event.kind === "task_prompt").length;
  return (typeof opened.payload.requirementRevision === "number" ? opened.payload.requirementRevision : 1) + prompts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasUsefulActionAfterBlock(events: Awaited<ReturnType<typeof readRuntimeEvents>>): boolean {
  const blockIndex = events.findIndex((event) => event.kind === "policy_decision" && event.outcome === "block");
  if (blockIndex < 0) return false;
  return events.slice(blockIndex + 1).some((event) => event.kind === "tool_finished" && !event.error
    && !["tree", "listDir", "projectScan"].includes(event.toolName ?? ""));
}

function sumKnownUsage(values: Array<{ input?: number; output?: number } | undefined>): { inputTokens: number | null; outputTokens: number | null; knownRuns: number } {
  const known = values.filter((value) => value && (value.input !== undefined || value.output !== undefined));
  if (known.length === 0) return { inputTokens: null, outputTokens: null, knownRuns: 0 };
  return {
    inputTokens: known.reduce((sum, value) => sum + (value?.input ?? 0), 0),
    outputTokens: known.reduce((sum, value) => sum + (value?.output ?? 0), 0),
    knownRuns: known.length
  };
}

async function startDeterministicProvider(task: TaskManifest, faultMode: FaultMode, memoryDir: string, initialPhase: ProtocolPhase): Promise<{
  baseURL: string;
  requests: Array<{ toolCallSent: boolean; toolNames: string[]; messageRoles: string[] }>;
  finalResponses: number;
  httpFailures: number;
  artifactSentinelObserved: boolean;
  obsoleteMemoryReturned: boolean;
  finalText: string;
  configurePhase: (phase: ProtocolPhase) => void;
  releaseHeldResponses: () => void;
  close: () => Promise<void>;
}> {
  const state = {
    requests: [] as Array<{ toolCallSent: boolean; toolNames: string[]; messageRoles: string[] }>,
    finalResponses: 0,
    httpFailures: 0,
    artifactSentinelObserved: false,
    obsoleteMemoryReturned: false,
    actions: initialPhase.actions,
    finalText: initialPhase.finalText,
    actionCursor: 0,
    holdAfterActions: initialPhase.holdAfterActions === true,
    heldResponseReleases: new Set<() => void>()
  };
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as {
      tools?: Array<{ function?: { name?: string } }>;
      messages?: Array<{ role?: string; content?: unknown; tool_calls?: Array<{ function?: { name?: string } }> }>;
    };
    const toolNames = (body.tools ?? []).map((tool) => tool.function?.name).filter((name): name is string => Boolean(name));
    const messageRoles = (body.messages ?? []).map((message) => message.role ?? "unknown");
    const messages = body.messages ?? [];
    for (const message of messages) {
      if (message.role === "tool" && typeof message.content === "string" && message.content.includes("node generate-v1.mjs")) {
        state.obsoleteMemoryReturned = true;
      }
      if (message.role === "tool" && typeof message.content === "string"
        && message.content.includes("INC-48271 · cache invalidation skipped after config reload")) {
        state.artifactSentinelObserved = true;
      }
    }
    const actionIndex = state.actionCursor;
    const action = state.actions[actionIndex];
    state.requests.push({ toolCallSent: Boolean(action) && faultMode === "none", toolNames, messageRoles });
    if (faultMode === "http-500") {
      state.httpFailures += 1;
      response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "scripted protocol failure" } }));
      return;
    }
    if (action && !toolNames.includes(action.toolName)) {
      response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `required ${action.toolName} tool was not exposed` } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const id = `fixture-${state.requests.length}`;
    if (!action) {
      if (state.holdAfterActions) {
        await new Promise<void>((resolvePromise) => {
          const release = () => {
            state.heldResponseReleases.delete(release);
            resolvePromise();
          };
          state.heldResponseReleases.add(release);
          response.once("close", release);
        });
        return;
      }
      state.finalResponses += 1;
      writeSse(response, id, { role: "assistant" }, null);
      writeSse(response, id, { content: state.finalText }, null);
      writeSse(response, id, {}, "stop");
    } else {
      state.actionCursor += 1;
      const args = JSON.stringify(resolveProtocolValue(action.input, task, memoryDir));
      writeSse(response, id, { role: "assistant" }, null);
      writeSse(response, id, { tool_calls: [{ index: 0, id: `fixture-action-${actionIndex + 1}`, type: "function", function: { name: action.toolName, arguments: args } }] }, null);
      writeSse(response, id, {}, "tool_calls");
    }
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "fixture-edit-v1", choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind deterministic provider.");
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests: state.requests,
    get finalResponses() { return state.finalResponses; },
    get httpFailures() { return state.httpFailures; },
    get artifactSentinelObserved() { return state.artifactSentinelObserved; },
    get obsoleteMemoryReturned() { return state.obsoleteMemoryReturned; },
    get finalText() { return state.finalText; },
    configurePhase: (phase) => {
      state.actions = phase.actions;
      state.finalText = phase.finalText;
      state.actionCursor = 0;
      state.holdAfterActions = phase.holdAfterActions === true;
    },
    releaseHeldResponses: () => {
      for (const release of [...state.heldResponseReleases]) release();
    },
    close: () => {
      for (const release of [...state.heldResponseReleases]) release();
      return new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    }
  };
}

function legacyShortRegressionActions(task: TaskManifest): Array<{ toolName: string; input: Record<string, unknown> }> {
  const parser = task.files["parser.js"];
  if (task.id !== "short-regression-01" || typeof parser !== "string") throw new Error(`Task '${task.id}' has no deterministic protocol script.`);
  return [
    { toolName: "editPlan", input: { summary: "Accept empty optional parser values", expectedFiles: ["parser.js"], steps: ["Allow an empty value while retaining separator validation"] } },
    { toolName: "writeFile", input: { path: "parser.js", content: parser.replace("([^:]+)$/.exec(input)", "([^:]*)$/.exec(input)") } }
  ];
}

function resolveProtocolValue<T>(value: T, task: TaskManifest, memoryDir: string): T {
  if (typeof value === "string") {
    const resolved = value.replaceAll(/\{\{ARTIFACT:([^}]+)}}/g, (_match, name: string) => resolve(memoryDir, "artifacts", name));
    return resolved as T;
  }
  if (Array.isArray(value)) return value.map((item) => resolveProtocolValue(item, task, memoryDir)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, resolveProtocolValue(item, task, memoryDir)])) as T;
  }
  return value;
}

function writeSse(response: ServerResponse<IncomingMessage>, id: string, delta: Record<string, unknown>, finishReason: string | null): void {
  response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "fixture-edit-v1", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
}
