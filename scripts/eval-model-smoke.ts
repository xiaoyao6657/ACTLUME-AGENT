import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadAppConfig, type AppConfig } from "../src/config.js";
import { parseEvalConditionManifest, resolveEvalConditionTreatment } from "../src/eval-conditions.js";
import { listMemories, setMemoryStatus } from "../src/memory.js";
import { removeProviderSecrets } from "../src/eval-environment.js";
import { policyConfigHash } from "../src/policy-config.js";
import { startEvalProviderProxy, type EvalProviderProxyDiagnostics } from "../src/eval-provider-proxy.js";
import { readRuntimeEvents, type RuntimeEvent } from "../src/runtime-events.js";
import { materializeEvalSmokeOverlay } from "./eval-smoke-overlay.js";

type Fixture = {
  schemaVersion: 1; id: string;
  category: "short-task" | "long-context" | "memory-transfer" | "requirement-change" | "interruption-recovery" | "other";
  prompt: string; files: Record<string, string>; requiredFiles: string[]; oracleId: string;
  largeFiles?: Array<{ path: string; pattern: string; repetitions: number }>;
  protocol?: {
    interruption?: unknown;
    phases?: Array<{
      prompt: string; sessionKey: string;
      transitionAfter?: { kind: "verify-and-promote-memory"; memoryName: string; command: string; updateFiles?: Record<string, string> };
    }>;
  };
};
type Result = {
  schemaVersion: 1; sessionId: string; runId?: string; taskId?: string;
  runtimeStatus: "completed" | "failed" | "cancelled" | "interrupted" | "budget_exhausted" | "unknown";
  evidenceStatus: string; taskVerdict: string; reason?: string; changedFiles: string[]; exitCode: number;
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const taskId = option("--task") ?? "short-regression-01";
const conditionId = option("--condition") ?? "actlume-full";
const maxSteps = integerOption("--max-steps", 8, 1, 10);
const maxDurationMs = integerOption("--max-duration-ms", 120_000, 10_000, 180_000);
const maxRequests = integerOption("--max-requests", 8, 1, 12);
const maxTotalTokens = integerOption("--max-total-tokens", 20_000, 1_000, 100_000);
const maxOutputTokensPerRequest = integerOption("--max-output-tokens", 512, 64, 2_048);
const repeatIndex = integerOption("--repeat-index", 0, 0, 100);
if (!/^[a-z0-9-]+$/.test(taskId)) throw new Error(`Invalid Eval task id '${taskId}'.`);
const conditionManifestPath = resolve(root, "evals/experiments/core-v1-condition-design.json");
const conditionManifestBytes = await readFile(conditionManifestPath);
const conditionManifest = parseEvalConditionManifest(JSON.parse(conditionManifestBytes.toString("utf8")) as unknown);
const conditionTreatment = resolveEvalConditionTreatment(conditionManifest, conditionId);
const fixturePath = resolve(root, "evals", "fixtures", taskId, "task.json");
const oraclePath = resolve(root, "evals", "oracles", `${taskId}.mjs`);
const fixtureRaw = await readFile(fixturePath, "utf8");
const fixture = JSON.parse(fixtureRaw) as Fixture;
validateFixture(fixture, taskId);
const oracleBytes = await readFile(oraclePath);
const oracle = await import(pathToFileURL(oraclePath).href) as { evaluate?: (workspace: string, evidence?: Record<string, unknown>) => Promise<{ verdict: "pass" | "fail" | "unknown"; reason?: string; metrics?: Record<string, unknown> }> };
if (typeof oracle.evaluate !== "function") throw new Error(`Oracle '${taskId}' has no evaluate function.`);

const runId = randomUUID();
const runRoot = resolve(root, ".agent-benchmark", "real-model-smoke", `${taskId}-${runId}`);
const workspace = join(runRoot, "workspace");
const memoryDir = join(runRoot, "memory");
const mcpConfigPath = join(runRoot, "mcp-empty.json");
await mkdir(runRoot, { recursive: true });
await materialize(workspace, fixture);
const evaluationOverlay = await materializeEvalSmokeOverlay(workspace, fixture.id, fixture.files);
await initializeGit(workspace);
await writeFile(mcpConfigPath, '{"servers":{}}\n', "utf8");
const checkConfigBytes = await readFile(resolve(workspace, ".actlume", "checks.json")).catch(() => undefined);
const evaluationOverlayHash = evaluationOverlay
  ? hash(canonical(evaluationOverlay))
  : checkConfigBytes ? hash(canonical(JSON.parse(checkConfigBytes.toString("utf8")) as unknown)) : null;

const config = await loadAppConfig({ workspace, readonly: false, maxSteps, permissionMode: "acceptEdits", mcpConfigPath, streaming: false }, root);
if (!config.apiKey || !config.baseURL) throw new Error("Provider credentials/base URL are missing; smoke run not started.");
const upstreamBaseURL = config.baseURL;
const upstreamApiKey = config.apiKey;
const localApiKey = randomUUID();
const worktree = JSON.parse(execFileSync(process.execPath, ["scripts/worktree-manifest.mjs"], { cwd: root, encoding: "utf8", windowsHide: true })) as { candidateSha256: string; head: string };
const proxy = await startEvalProviderProxy({
  upstreamBaseURL, upstreamApiKey, localApiKey,
  budget: { maxRequests, maxTotalTokens, maxOutputTokensPerRequest }
});
const workerConfig: AppConfig = {
  ...config,
  baseURL: proxy.baseURL,
  apiKey: localApiKey,
  memoryDir,
  mcpConfigPath,
  maxSteps,
  readonly: false,
  permissionMode: "acceptEdits",
  streaming: false,
  memoryEnabled: conditionTreatment.memoryEnabled,
  policyConfig: conditionTreatment.policyConfig,
  allowHeadlessCheckSpec: true
};
const phasePlans = getPhasePlans(fixture);
const startedAt = Date.now();
let timedOut = false;
let terminationSucceeded: boolean | null = null;
let activeWorker: ReturnType<typeof startWorker> | undefined;
const timer = setTimeout(() => {
  timedOut = true;
  if (activeWorker) void terminateTree(activeWorker.child).then((value) => { terminationSucceeded = value; }).catch(() => { terminationSucceeded = false; });
}, maxDurationMs);
let proxyDiagnostics: EvalProviderProxyDiagnostics;
const phaseResults: Array<{ phase: number; sessionId: string; result: Result }> = [];
const sessionIds = new Map<string, string>();
const transitions: Array<{ phase: number; memoryName: string; command: string; verified: boolean; promoted: boolean; memoryFilename?: string }> = [];
const workerErrors: string[] = [];
const workerDiagnostics: string[] = [];
try {
  for (let index = 0; index < phasePlans.length; index += 1) {
    if (timedOut) break;
    const transition = phasePlans[index - 1]?.transitionAfter;
    if (transition) {
      try { transitions.push(await executeTransition(transition, memoryDir, workspace, conditionTreatment.memoryEnabled, index - 1, Math.max(1, maxDurationMs - (Date.now() - startedAt)))); }
      catch (error) { workerErrors.push(`Phase ${index - 1} transition failed: ${(error as Error).message}`); break; }
    }
    const phase = phasePlans[index]!;
    const sessionId = sessionIds.get(phase.sessionKey) ?? randomUUID();
    sessionIds.set(phase.sessionKey, sessionId);
    activeWorker = startWorker(workerConfig, phase.prompt, sessionId, workspace);
    const exit = await activeWorker.completion;
    activeWorker = undefined;
    if (exit.stderr.trim()) workerDiagnostics.push(redact(exit.stderr));
    let phaseResult: Result | undefined;
    if (exit.code === 0) {
      try { phaseResult = JSON.parse(exit.stdout.trim().split(/\r?\n/).at(-1) ?? "") as Result; }
      catch (error) { workerErrors.push(`Phase ${index} worker result was invalid: ${(error as Error).message}`); }
    } else if (!timedOut) workerErrors.push(`Phase ${index} worker exited with code ${String(exit.code)} and signal ${String(exit.signal)}.`);
    if (!phaseResult) break;
    phaseResults.push({ phase: index, sessionId, result: phaseResult });
    if (phaseResult.runtimeStatus !== "completed") break;
  }
}
finally {
  clearTimeout(timer);
  proxyDiagnostics = proxy.getDiagnostics();
  await proxy.close();
}

const durationMs = Date.now() - startedAt;
const runtimeEvents: RuntimeEvent[] = [];
for (const sessionId of new Set(sessionIds.values())) runtimeEvents.push(...await readRuntimeEvents(memoryDir, sessionId).catch(() => [] as RuntimeEvent[]));
const phaseRunIds = new Set(phaseResults.map(({ result }) => result.runId).filter((value): value is string => Boolean(value)));
const events = runtimeEvents.filter((event) => phaseRunIds.size === 0 || !event.runId || phaseRunIds.has(event.runId));
const completionClaim = [...events].reverse().find((event) => event.kind === "completion_claim");
const result = phaseResults.at(-1)?.result;
const changedFiles = [...new Set(phaseResults.flatMap((phase) => phase.result.changedFiles))];
const runtimeStatus = timedOut ? "budget_exhausted" : workerErrors.length > 0 ? "failed" : result?.runtimeStatus ?? "unknown";
const sessionIdsInOrder = [...new Set(sessionIds.values())];
const runtimeEventPaths = sessionIdsInOrder.map((sessionId) => relative(root, join(memoryDir, "events", `${sessionId}.jsonl`)).replaceAll("\\", "/"));
const transitionProof = transitions.find((transition) => transition.phase === 0);
const followUpPhaseIndex = phasePlans.findIndex((phase, index) => index > 0 && phase.sessionKey !== phasePlans[0]?.sessionKey);
const followUpSessionId = followUpPhaseIndex >= 0 ? phaseResults.find((phase) => phase.phase === followUpPhaseIndex)?.sessionId : undefined;
const followUpRunId = followUpPhaseIndex >= 0 ? phaseResults.find((phase) => phase.phase === followUpPhaseIndex)?.result.runId : undefined;
const followUpRetrievals = events.filter((event) => event.kind === "memory_retrieved" && event.sessionId === followUpSessionId
  && (!followUpRunId || !event.runId || event.runId === followUpRunId));
const selectedMemoryEvidence = followUpRetrievals.flatMap((event) => stringArray(event.attributes?.selected));
const rejectedMemoryEvidence = followUpRetrievals.flatMap((event) => stringArray(event.attributes?.rejected));
const transitionedMemory = transitionProof?.memoryFilename
  ? (await listMemories(memoryDir)).find((memory) => memory.filename === transitionProof.memoryFilename)
  : undefined;
const verifiedMemoryProvenance = Boolean(transitionProof?.promoted && transitionedMemory?.status === "active"
  && transitionedMemory.evidenceType === "verified" && transitionedMemory.content.includes(transitionProof.command)
  && (transitionedMemory.sourceRefs?.length ?? 0) > 0);
const selectedInFreshSession = Boolean(transitionProof?.memoryFilename
  && selectedMemoryEvidence.some((item) => item.startsWith(`${transitionProof.memoryFilename}:`)));
const staleMemoryRejected = Boolean(transitionProof?.memoryFilename
  && rejectedMemoryEvidence.some((item) => item.startsWith(`${transitionProof.memoryFilename}:stale_file`)));
const oracleEvidence: Record<string, unknown> = {
  runtimeStatus,
  changedFiles,
  memoryTreatment: conditionTreatment.memoryEnabled ? "enabled" : "disabled",
  commandVerified: transitionProof?.verified ?? false,
  command: transitionProof?.command ?? null,
  verifiedMemoryProvenance,
  memorySelectedInFreshSession: selectedInFreshSession,
  staleMemoryExposed: Boolean(conditionTreatment.memoryEnabled && transitionProof?.promoted),
  staleMemoryRejected,
  staleMemoryMisused: Boolean(transitionProof?.memoryFilename && selectedInFreshSession),
  completionClaimStatus: completionClaim?.attributes?.claimStatus ?? "unknown",
  independentTestVerdict: events.some((event) => event.kind === "verification_finished" && event.status === "failed") ? "fail" : undefined,
  evidenceStatus: result?.evidenceStatus ?? "unknown"
};
let oracleResult: { verdict: "pass" | "fail" | "unknown"; reason?: string; metrics?: Record<string, unknown> } = { verdict: "unknown", reason: "No completed runtime result was available." };
try {
  oracleResult = await oracle.evaluate(workspace, oracleEvidence);
} catch (error) {
  oracleResult = { verdict: "unknown", reason: `Oracle failed: ${(error as Error).message}` };
}
const usage = events.filter((event) => event.kind === "model_usage");
const patch = execFileSync("git", ["diff", "--binary", "HEAD", "--"], { cwd: workspace, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
const reportPath = join(runRoot, "report.json");
await writeFile(join(runRoot, "patch.diff"), patch, "utf8");
await writeFile(reportPath, `${JSON.stringify({
   schemaVersion: 1, dataClass: "real-model-smoke-only", qualityClaim: false, runId, repeatIndex,
  task: { id: fixture.id, category: fixture.category, oracleId: fixture.oracleId,
    fixtureHash: hash(canonical(fixture)), oracleHash: hash(oracleBytes), evaluationOverlayHash,
    phaseCount: phasePlans.length, completedPhaseCount: phaseResults.length,
    phaseSessionKeys: phasePlans.map((phase) => phase.sessionKey), transitions },
  candidate: { head: worktree.head, snapshotHash: `sha256:${worktree.candidateSha256}` },
  condition: {
    id: conditionTreatment.condition,
    memoryEnabled: conditionTreatment.memoryEnabled,
    policyConfigHash: policyConfigHash(conditionTreatment.policyConfig),
    permissionMode: "acceptEdits",
    allowExactCheckSpecAutoapproval: true,
    mcp: "isolated-empty-config",
    profileManifestId: conditionManifest.manifestId,
    profileManifestHash: hash(conditionManifestBytes)
  },
  provider: { id: providerId(config.baseURL), modelId: config.model, modelRevision: "unknown" },
  sampling: { temperature: null, topP: null, seed: "unknown" },
  limits: { maxAttempts: 1, maxModelRequests: maxRequests, maxModelSteps: maxSteps, maxDurationMs,
    maxTotalReportedTokens: maxTotalTokens, maxOutputTokensPerRequest, tokenLimitBehavior: "Blocks the next provider request when reported usage reaches the total; one in-flight request may cross the total ceiling. Output is capped per request." },
  execution: {
    startedAt: new Date(startedAt).toISOString(), durationMs, timedOut, terminationSucceeded,
    result: result ? { ...result, runtimeStatus, changedFiles, phaseResults } : null,
    error: workerErrors.join("\n") || null, diagnostics: workerDiagnostics.join("\n") || null,
    independentOracle: oracleResult,
    oracleEvidence,
    completionClaimStatus: completionClaim?.attributes?.claimStatus ?? "unknown",
    falseCompletion: completionClaim?.attributes?.claimStatus === "claimed_complete" && oracleResult.verdict === "fail",
    modelRequests: proxyDiagnostics.forwardedRequests, runtimeUsageEvents: usage.length,
    usageKnownRequests: proxyDiagnostics.usageKnownRequests,
    inputTokens: proxyDiagnostics.usageKnownRequests ? proxyDiagnostics.inputTokens : null,
    outputTokens: proxyDiagnostics.usageKnownRequests ? proxyDiagnostics.outputTokens : null,
    totalTokens: proxyDiagnostics.usageKnownRequests ? proxyDiagnostics.totalTokens : null,
    proxyBudget: proxyDiagnostics,
    requestedToolCalls: events.filter((event) => event.kind === "tool_requested").length,
    executedToolCalls: events.filter((event) => event.kind === "tool_finished" && !event.error).length,
    blockedToolCalls: events.filter((event) => event.kind === "policy_decision" && event.outcome === "block").length,
    humanInterventions: events.filter((event) => event.kind === "approval_requested").length,
    runtimeEventPath: runtimeEventPaths[0] ?? null,
    runtimeEventPaths,
    patchPath: "patch.diff"
  },
  limitation: "This bounded attempt follows only fixture-declared phases and transitions; interruption phases are not supported by this model runner. Headless workers may autoapprove only an exact configured CheckSpec command; all other interactive approval requests are blocked. Unknown model revision and sampling exclude strict paired analysis; preserve budget-censored attempts and do not generalize this smoke to strategy quality without repeated multi-task runs."
}, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  report: relative(root, reportPath).replaceAll("\\", "/"),
  runtimeStatus,
  oracleVerdict: oracleResult.verdict, modelRequests: proxyDiagnostics.forwardedRequests, usageKnownRequests: proxyDiagnostics.usageKnownRequests,
  requestedToolCalls: events.filter((event) => event.kind === "tool_requested").length,
  executedToolCalls: events.filter((event) => event.kind === "tool_finished" && !event.error).length, durationMs
}, null, 2)}\n`);
if (timedOut || workerErrors.length > 0 || !result || proxyDiagnostics.forwardedRequests === 0 || proxyDiagnostics.usageKnownRequests === 0
  || events.every((event) => event.kind !== "tool_requested")) process.exitCode = 1;

function option(name: string): string | undefined { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function integerOption(name: string, fallback: number, min: number, max: number): number {
  const raw = option(name); if (raw === undefined) return fallback;
  const value = Number(raw); if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in [${min}, ${max}].`);
  return value;
}
type PhasePlan = {
  prompt: string;
  sessionKey: string;
  transitionAfter?: NonNullable<NonNullable<Fixture["protocol"]>["phases"]>[number]["transitionAfter"];
};
function getPhasePlans(value: Fixture): PhasePlan[] {
  if (value.protocol?.interruption) throw new Error(`Task '${value.id}' requires process interruption and is not supported by eval:model-smoke.`);
  if (value.id === "artifact-recall-01") throw new Error("Task 'artifact-recall-01' needs a captured final response and artifact-evidence oracle, which this runner does not implement.");
  const phases = value.protocol?.phases;
  if (phases?.length) {
    return phases.map((phase) => {
      if (!phase.prompt.trim() || !phase.sessionKey.trim()) throw new Error(`Task '${value.id}' contains an invalid real-model phase.`);
      return { prompt: phase.prompt, sessionKey: phase.sessionKey, ...(phase.transitionAfter ? { transitionAfter: phase.transitionAfter } : {}) };
    });
  }
  return [{ prompt: value.prompt, sessionKey: "task" }];
}
async function executeTransition(
  transition: NonNullable<PhasePlan["transitionAfter"]>,
  memoryDir: string,
  workspace: string,
  memoryEnabled: boolean,
  phase: number,
  timeoutMs: number
): Promise<{ phase: number; memoryName: string; command: string; verified: boolean; promoted: boolean; memoryFilename?: string }> {
  if (transition.kind !== "verify-and-promote-memory") throw new Error(`Unsupported Eval transition '${String(transition.kind)}'.`);
  const candidate = (await listMemories(memoryDir)).find((entry) => entry.name === transition.memoryName && entry.status === "candidate");
  if (memoryEnabled && (!candidate || !candidate.content.includes(transition.command))) {
    throw new Error(`Expected candidate memory '${transition.memoryName}' to record '${transition.command}'.`);
  }
  runWhitelistedFixtureCommand(transition.command, workspace, timeoutMs);
  let promoted = false;
  if (memoryEnabled) {
    const active = await setMemoryStatus(memoryDir, candidate!.filename, "active", "verified");
    if (!active || active.status !== "active" || active.evidenceType !== "verified") throw new Error(`Could not activate verified memory '${candidate!.name}'.`);
    promoted = true;
  }
  for (const [relativePath, contents] of Object.entries(transition.updateFiles ?? {})) {
    if (!relativePath || relativePath.startsWith("/") || relativePath.split(/[\\/]/).includes("..") || relativePath.includes("\\")) {
      throw new Error(`Unsafe protocol transition path '${relativePath}'.`);
    }
    const destination = resolve(workspace, relativePath);
    if (!destination.startsWith(`${workspace}${sep}`)) throw new Error(`Protocol transition path escapes fixture root: ${relativePath}`);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents, "utf8");
  }
  return { phase, memoryName: transition.memoryName, command: transition.command, verified: true, promoted,
    ...(memoryEnabled && candidate ? { memoryFilename: candidate.filename } : {}) };
}
function runWhitelistedFixtureCommand(command: string, workspace: string, timeoutMs: number): void {
  const options = { cwd: workspace, windowsHide: true, stdio: "pipe" as const, timeout: timeoutMs, env: removeProviderSecrets(process.env) };
  if (command === "npm test") {
    const npmCliPath = process.env.npm_execpath;
    if (!npmCliPath) throw new Error("npm_execpath is unavailable; invoke the real-model smoke through npm.");
    execFileSync(process.execPath, [npmCliPath, "test"], options);
    return;
  }
  if (command === "node generate-v1.mjs") {
    execFileSync(process.execPath, ["generate-v1.mjs"], options);
    return;
  }
  if (command === "node publish-v1.mjs") {
    execFileSync(process.execPath, ["publish-v1.mjs"], options);
    return;
  }
  throw new Error(`Eval transition command '${command}' is not whitelisted.`);
}
function validateFixture(value: Fixture, expectedId: string): void {
  if (value.schemaVersion !== 1 || value.id !== expectedId || !value.prompt?.trim() || !value.files || !value.requiredFiles.length || value.oracleId !== `${expectedId}-hidden-v1`) throw new Error(`Invalid fixture '${expectedId}'.`);
  for (const path of [...Object.keys(value.files), ...(value.largeFiles ?? []).map((item) => item.path), ...value.requiredFiles]) {
    const normalized = path.replaceAll("\\", "/");
    if (!path || path.includes("\\") || normalized.startsWith("/") || normalized.split("/").includes("..")) throw new Error(`Unsafe fixture path '${path}'.`);
  }
  if (value.requiredFiles.some((path) => !Object.hasOwn(value.files, path))) throw new Error(`Fixture '${expectedId}' omits a required file.`);
}
async function materialize(workspace: string, value: Fixture): Promise<void> {
  for (const [path, contents] of Object.entries(value.files)) await writeFixtureFile(workspace, path, contents);
  for (const file of value.largeFiles ?? []) {
    if (!Number.isInteger(file.repetitions) || file.repetitions < 1 || file.repetitions > 100_000) throw new Error(`Invalid generated file '${file.path}'.`);
    await writeFixtureFile(workspace, file.path, file.pattern.repeat(file.repetitions));
  }
  for (const path of value.requiredFiles) await readFile(resolve(workspace, path));
}
async function writeFixtureFile(workspace: string, path: string, contents: string): Promise<void> {
  const destination = resolve(workspace, path);
  const rel = relative(workspace, destination);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`Fixture path escapes workspace: ${path}`);
  await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, contents, "utf8");
}
async function initializeGit(workspace: string): Promise<void> {
  execFileSync("git", ["init", "--quiet"], { cwd: workspace, windowsHide: true });
  execFileSync("git", ["config", "user.name", "Actlume Eval"], { cwd: workspace, windowsHide: true });
  execFileSync("git", ["config", "user.email", "eval@localhost"], { cwd: workspace, windowsHide: true });
  execFileSync("git", ["add", "--all"], { cwd: workspace, windowsHide: true });
  execFileSync("git", ["commit", "--quiet", "-m", "Frozen Eval fixture"], { cwd: workspace, windowsHide: true });
}
type WorkerExit = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
function startWorker(config: AppConfig, prompt: string, sessionId: string, cwd: string): { child: ChildProcess; completion: Promise<WorkerExit> } {
  const workerPath = resolve(root, "scripts", "eval-protocol-worker.ts");
  const env = removeProviderSecrets(process.env);
  env.ACTLUME_EVAL_WORKER_CONFIG = JSON.stringify({ config, prompt, sessionId });
  const child = spawn(process.execPath, ["--import", "tsx", workerPath], { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = ""; let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const completion = new Promise<WorkerExit>((resolvePromise, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
  return { child, completion };
}
async function terminateTree(child: ChildProcess): Promise<boolean> {
  if (!child.pid) return false;
  if (process.platform === "win32") {
    try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10_000 }); return true; }
    catch { return false; }
  }
  try { process.kill(-child.pid, "SIGKILL"); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
function providerId(baseURL: string): string {
  try { const url = new URL(baseURL); return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}`; }
  catch { return "unparseable-provider-url"; }
}
function redact(value: string): string { return value.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[redacted]").replace(/(api[_-]?key\s*[:=]\s*)[^\s"']+/gi, "$1[redacted]"); }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function hash(value: string | Buffer): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
