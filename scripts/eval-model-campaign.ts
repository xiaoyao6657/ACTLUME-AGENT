import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCampaignTaskSuite, decideCampaignAttempt, type CampaignSuite } from "../src/eval-campaign.js";
import { parseEvalConditionManifest, resolveEvalConditionTreatment } from "../src/eval-conditions.js";
import { policyConfigHash } from "../src/policy-config.js";
import { createEvalSmokeOverlay } from "./eval-smoke-overlay.js";

type MatrixRow = { taskId: string; conditions: string[] };
type TaskLock = { fixtureHash: string; oracleHash: string; checkHash: string | null; phaseCount: number };
type Attempt = { taskId: string; condition: string; repeatIndex: number };
type FreezeManifest = {
  schemaVersion: 1; status: "frozen"; suite: CampaignSuite; experimentId: string; createdAt: string;
  candidate: { head: string; snapshotHash: string };
  conditionManifest: { id: string; hash: string; conditions: Array<{ id: string; memoryEnabled: boolean; policyConfigHash: string }> };
  taskLocks: Record<string, TaskLock>;
  sharedControls: Record<string, string>;
  executionOrder: Attempt[];
  limits: { maxAttempts: number; maxTotalReportedTokens: number; maxReportedTokensPerAttempt: number; maxRequestsPerAttempt: number; maxOutputTokensPerRequest: number; maxDurationMsPerAttempt: number; maxStepsPerAttempt: number };
  analysisPlan: { classification: string; reportAllAttempts: true; stopWhenUsageUnknown: true; limitations: string[] };
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv.includes("--freeze") ? "freeze" : "run";
const SUPPORTED_TASKS = new Set([
  "short-regression-01", "long-context-01", "memory-transfer-01", "stale-memory-01",
  "requirement-revision-01", "verification-claim-01", "guardrail-retry-01",
  "holdout-parser-boundary-01", "holdout-memory-transfer-01", "holdout-stale-memory-01", "holdout-honesty-01",
  "holdout-stale-build-01", "holdout-stale-config-01"
]);

if (mode === "freeze") await freezeCampaign();
else await runCampaign();

async function freezeCampaign(): Promise<void> {
  const name = option("--name") ?? "core-v1-dev";
  const suite = (option("--suite") ?? "development") as CampaignSuite;
  if (suite !== "development" && suite !== "holdout") throw new Error("--suite must be development or holdout.");
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("--name must contain lowercase letters, digits, and hyphens.");
  const repeats = integerOption("--repeats", 3, 1, 10);
  const maxTotalReportedTokens = integerOption("--max-total-tokens", 240_000, 1_000, 2_000_000);
  const maxReportedTokensPerAttempt = integerOption("--attempt-token-budget", 20_000, 1_000, 100_000);
  const maxRequestsPerAttempt = integerOption("--max-requests", 8, 1, 12);
  const maxOutputTokensPerRequest = integerOption("--max-output-tokens", 512, 64, 2_048);
  const maxDurationMsPerAttempt = integerOption("--max-duration-ms", 150_000, 10_000, 180_000);
  const maxStepsPerAttempt = integerOption("--max-steps", 8, 1, 10);
  const matrix = parseMatrix(requiredOption("--matrix"));
  for (const { taskId } of matrix) assertCampaignTaskSuite(taskId, suite);
  const outPath = resolve(root, option("--output") ?? `.agent-benchmark/frozen-experiments/${name}.json`);
  const manifestPath = resolve(root, "evals/experiments/core-v1-condition-design.json");
  const manifestBytes = await readFile(manifestPath);
  const conditions = parseEvalConditionManifest(JSON.parse(manifestBytes.toString("utf8")) as unknown);
  const conditionLocks = matrix.flatMap(({ conditions: ids }) => ids).filter((id, index, values) => values.indexOf(id) === index).map((id) => {
    const treatment = resolveEvalConditionTreatment(conditions, id);
    return { id, memoryEnabled: treatment.memoryEnabled, policyConfigHash: policyConfigHash(treatment.policyConfig) };
  });
  const taskLocks: Record<string, TaskLock> = {};
  for (const { taskId } of matrix) taskLocks[taskId] = await lockTask(taskId);
  const executionOrder = interleave(matrix, repeats);
  const candidate = await currentCandidate();
  if (await exists(outPath)) throw new Error(`Refusing to overwrite frozen campaign '${relative(root, outPath)}'.`);
  if (maxTotalReportedTokens < maxReportedTokensPerAttempt) throw new Error("Campaign token ceiling must reserve at least one complete attempt.");
  const freeze: FreezeManifest = {
    schemaVersion: 1, status: "frozen", suite, experimentId: name, createdAt: new Date().toISOString(), candidate,
    conditionManifest: { id: conditions.manifestId, hash: hash(manifestBytes), conditions: conditionLocks },
    taskLocks,
    sharedControls: {
      runtime: "Actlume on pinned Pi adapter",
      permissionMode: "acceptEdits",
      mcp: "isolated-empty-config",
      toolSchema: "identical-across-conditions",
      checkApproval: "only exact fixture CheckSpec command; other headless approvals blocked",
      workspaceAndMemory: "fresh per attempt; within-attempt phases follow fixture session keys",
      modelRevisionAndSampling: "recorded as reported; unknown values exclude strict pairing"
    },
    executionOrder,
    limits: { maxAttempts: executionOrder.length, maxTotalReportedTokens, maxReportedTokensPerAttempt, maxRequestsPerAttempt, maxOutputTokensPerRequest, maxDurationMsPerAttempt, maxStepsPerAttempt },
    analysisPlan: {
      classification: suite === "development" ? "exploratory-real-model-development-set" : "final-configuration-held-out-set",
      reportAllAttempts: true,
      stopWhenUsageUnknown: true,
      limitations: [
        "The campaign proxy can block later requests but a single in-flight provider response may cross the reported-token threshold.",
        "Unknown model revision or sampling prevents strict paired inference.",
        suite === "development"
          ? "This development manifest contains no held-out tasks; freeze and execute a separate holdout manifest only after configuration decisions are final."
          : "Holdout outcomes are for final frozen configuration assessment; any subsequent tuning invalidates this holdout result.",
        "Real-model outcomes are task-specific and do not measure general coding ability."
      ]
    }
  };
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(freeze, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${JSON.stringify({ frozen: relative(root, outPath).replaceAll("\\", "/"), attempts: executionOrder.length, candidate: candidate.snapshotHash }, null, 2)}\n`);
}

async function runCampaign(): Promise<void> {
  const manifestPath = resolve(root, requiredOption("--manifest"));
  const bytes = await readFile(manifestPath);
  const manifest = JSON.parse(bytes.toString("utf8")) as FreezeManifest;
  validateFreeze(manifest);
  const candidate = await currentCandidate();
  if (candidate.snapshotHash !== manifest.candidate.snapshotHash) throw new Error("Current source candidate does not match the frozen experiment; no provider request was made.");
  const conditionBytes = await readFile(resolve(root, "evals/experiments/core-v1-condition-design.json"));
  if (hash(conditionBytes) !== manifest.conditionManifest.hash) throw new Error("Condition manifest changed after freeze; no provider request was made.");
  for (const taskId of Object.keys(manifest.taskLocks)) {
    const actual = await lockTask(taskId);
    if (canonical(actual) !== canonical(manifest.taskLocks[taskId])) throw new Error(`Task '${taskId}' changed after freeze; no provider request was made.`);
  }
  const resultPath = resolve(root, `.agent-benchmark/frozen-experiments/${manifest.experimentId}-results.json`);
  if (await exists(resultPath)) throw new Error(`Campaign results already exist at '${relative(root, resultPath)}'; refusing to overwrite.`);
  const campaign = {
    schemaVersion: 1, dataClass: "real-model-campaign", experimentId: manifest.experimentId,
    freezePath: relative(root, manifestPath).replaceAll("\\", "/"), freezeHash: hash(bytes),
    candidate: manifest.candidate, startedAt: new Date().toISOString(), status: "running",
    attempts: [] as Array<Record<string, unknown>>, notStarted: [] as Array<{ taskId: string; condition: string; repeatIndex: number; reason: string }>,
    cumulativeReportedTokens: 0, cumulativeUsageComplete: true
  };
  await persistCampaign(resultPath, campaign);
  const workerPath = resolve(root, "scripts/eval-model-smoke.ts");
  let stopReason: string | undefined;
  for (const attempt of manifest.executionOrder) {
    const decision = decideCampaignAttempt({
      attemptsStarted: campaign.attempts.length,
      maxAttempts: manifest.limits.maxAttempts,
      cumulativeReportedTokens: campaign.cumulativeReportedTokens,
      usageKnown: campaign.cumulativeUsageComplete,
      maxTotalReportedTokens: manifest.limits.maxTotalReportedTokens,
      maxReportedTokensPerAttempt: manifest.limits.maxReportedTokensPerAttempt
    });
    if (!decision.start) {
      stopReason = decision.reason;
      campaign.notStarted = manifest.executionOrder.slice(campaign.attempts.length).map((pending) => ({ ...pending, reason: decision.reason }));
      break;
    }
    const latestCandidate = await currentCandidate();
    if (latestCandidate.snapshotHash !== manifest.candidate.snapshotHash) {
      stopReason = "candidate-changed-during-campaign";
      campaign.notStarted = manifest.executionOrder.slice(campaign.attempts.length).map((pending) => ({ ...pending, reason: stopReason! }));
      break;
    }
    let run: Awaited<ReturnType<typeof runAttempt>>;
    try { run = await runAttempt(workerPath, attempt, manifest); }
    catch (error) {
      campaign.attempts.push({ ...attempt, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        exitCode: null, signal: null, reportPath: null, reportedTokens: null, usageKnownRequests: 0, usageUnknownRequests: null,
        spawnError: String((error as Error).message) });
      campaign.cumulativeUsageComplete = false;
      stopReason = "attempt-spawn-failed";
      campaign.notStarted = manifest.executionOrder.slice(campaign.attempts.length).map((pending) => ({ ...pending, reason: stopReason! }));
      await persistCampaign(resultPath, campaign);
      break;
    }
    campaign.attempts.push(run.record);
    if (run.report) {
      const execution = run.report.execution as Record<string, unknown>;
      const proxyBudget = execution?.proxyBudget as Record<string, unknown> | undefined;
      const total = execution?.totalTokens;
      const forwardedRequests = Number(proxyBudget?.forwardedRequests ?? execution?.modelRequests ?? 0);
      const knownRequests = Number(proxyBudget?.usageKnownRequests ?? execution?.usageKnownRequests ?? 0);
      const unknownRequests = Number(proxyBudget?.usageUnknownRequests ?? execution?.usageUnknownRequests ?? (forwardedRequests - knownRequests));
      if (typeof total === "number" && Number.isFinite(total) && forwardedRequests > 0
        && unknownRequests === 0 && knownRequests === forwardedRequests) campaign.cumulativeReportedTokens += total;
      else campaign.cumulativeUsageComplete = false;
    } else campaign.cumulativeUsageComplete = false;
    await persistCampaign(resultPath, campaign);
    if (!campaign.cumulativeUsageComplete) {
      stopReason = "usage-unknown-or-report-missing";
      campaign.notStarted = manifest.executionOrder.slice(campaign.attempts.length).map((pending) => ({ ...pending, reason: stopReason! }));
      break;
    }
  }
  campaign.status = campaign.attempts.length < manifest.executionOrder.length
    ? "stopped-with-attempts-pending"
    : campaign.cumulativeUsageComplete ? "completed-all-frozen-attempts" : "completed-order-usage-incomplete";
  Object.assign(campaign, { completedAt: new Date().toISOString(), stopReason: stopReason ?? null });
  await persistCampaign(resultPath, campaign);
  process.stdout.write(`${JSON.stringify({ results: relative(root, resultPath).replaceAll("\\", "/"), status: campaign.status, attempts: campaign.attempts.length, pending: campaign.notStarted.length, reportedTokens: campaign.cumulativeReportedTokens, usageComplete: campaign.cumulativeUsageComplete, stopReason: stopReason ?? null }, null, 2)}\n`);
  if (campaign.notStarted.length) process.exitCode = 2;
}

async function runAttempt(workerPath: string, attempt: Attempt, manifest: FreezeManifest): Promise<{ record: Record<string, unknown>; report?: Record<string, unknown> }> {
  const args = ["--import", "tsx", workerPath,
    "--task", attempt.taskId, "--condition", attempt.condition, "--repeat-index", String(attempt.repeatIndex),
    "--max-steps", String(manifest.limits.maxStepsPerAttempt), "--max-duration-ms", String(manifest.limits.maxDurationMsPerAttempt),
    "--max-requests", String(manifest.limits.maxRequestsPerAttempt), "--max-total-tokens", String(manifest.limits.maxReportedTokensPerAttempt),
    "--max-output-tokens", String(manifest.limits.maxOutputTokensPerRequest)];
  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
  const cleanStderr = redact(stderr);
  let smokeSummary: Record<string, unknown> | undefined;
  if (stdout.trim()) { try { smokeSummary = JSON.parse(stdout.trim()) as Record<string, unknown>; } catch { /* preserved in record */ } }
  let report: Record<string, unknown> | undefined;
  const reportPath = typeof smokeSummary?.report === "string" ? resolve(root, smokeSummary.report) : undefined;
  if (reportPath) { try { report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>; } catch { /* missing reports stop the campaign */ } }
  const execution = report?.execution as Record<string, unknown> | undefined;
  const proxyBudget = execution?.proxyBudget as Record<string, unknown> | undefined;
  const forwardedRequests = Number(proxyBudget?.forwardedRequests ?? execution?.modelRequests ?? 0);
  const knownRequests = Number(proxyBudget?.usageKnownRequests ?? execution?.usageKnownRequests ?? 0);
  const reportedUnknownRequests = Number(proxyBudget?.usageUnknownRequests ?? execution?.usageUnknownRequests ?? 0);
  return {
    record: {
      ...attempt, startedAt, completedAt: new Date().toISOString(), exitCode: exit.code, signal: exit.signal,
      smokeSummary: smokeSummary ?? null,
      reportPath: smokeSummary?.report ?? null,
      reportedTokens: (report?.execution as Record<string, unknown> | undefined)?.totalTokens ?? null,
      usageKnownRequests: knownRequests,
      usageUnknownRequests: report ? Math.max(reportedUnknownRequests, forwardedRequests - knownRequests) : null,
      stderr: cleanStderr || null,
      stdoutDiagnostic: smokeSummary ? null : redact(stdout).slice(-4000) || null
    }, report
  };
}

async function lockTask(taskId: string): Promise<TaskLock> {
  if (!SUPPORTED_TASKS.has(taskId)) throw new Error(`Task '${taskId}' does not have a scoreable real-model runner protocol.`);
  const fixturePath = resolve(root, "evals/fixtures", taskId, "task.json");
  const oraclePath = resolve(root, "evals/oracles", `${taskId}.mjs`);
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
  const oracleBytes = await readFile(oraclePath);
  const fixtureFiles = fixture.files as Record<string, string>;
  const overlay = createEvalSmokeOverlay(taskId, fixtureFiles);
  let checkHash: string | null = overlay ? hash(canonical(overlay)) : null;
  if (!checkHash && typeof fixtureFiles[".actlume/checks.json"] === "string") {
    checkHash = hash(canonical(JSON.parse(fixtureFiles[".actlume/checks.json"]!) as unknown));
  }
  const phases = (fixture.protocol as { phases?: unknown[] } | undefined)?.phases;
  return { fixtureHash: hash(canonical(fixture)), oracleHash: hash(oracleBytes), checkHash, phaseCount: phases?.length ?? 1 };
}

async function currentCandidate(): Promise<{ head: string; snapshotHash: string }> {
  const result = await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["scripts/worktree-manifest.mjs"], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject); child.once("close", (code) => code === 0 ? resolvePromise(stdout) : reject(new Error(stderr || `Manifest command exited ${code}.`)));
  });
  const value = JSON.parse(result) as { head: string; candidateSha256: string };
  return { head: value.head, snapshotHash: `sha256:${value.candidateSha256}` };
}

function parseMatrix(raw: string): MatrixRow[] {
  const rows = raw.split(";").map((entry) => {
    const [taskId, conditionText] = entry.split("=");
    const conditions = conditionText?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
    if (!taskId || !/^[a-z0-9-]+$/.test(taskId.trim()) || conditions.length < 2 || new Set(conditions).size !== conditions.length) {
      throw new Error(`Invalid matrix row '${entry}'; expected task-id=control,treatment.`);
    }
    return { taskId: taskId.trim(), conditions };
  });
  if (rows.length === 0 || new Set(rows.map((row) => row.taskId)).size !== rows.length) throw new Error("Matrix must contain unique task ids.");
  return rows;
}

function interleave(matrix: MatrixRow[], repeats: number): Attempt[] {
  const order: Attempt[] = [];
  for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex += 1) {
    for (let taskIndex = 0; taskIndex < matrix.length; taskIndex += 1) {
      const row = matrix[taskIndex]!;
      const rotation = repeatIndex % row.conditions.length;
      const rotated = [...row.conditions.slice(rotation), ...row.conditions.slice(0, rotation)];
      for (const condition of rotated) order.push({ taskId: row.taskId, condition, repeatIndex });
    }
  }
  return order;
}

function validateFreeze(value: FreezeManifest): void {
  if (!value || value.schemaVersion !== 1 || value.status !== "frozen" || !["development", "holdout"].includes(value.suite) || !/^[a-z0-9-]+$/.test(value.experimentId)
    || !Array.isArray(value.executionOrder) || value.executionOrder.length !== value.limits.maxAttempts
    || value.limits.maxTotalReportedTokens < value.limits.maxReportedTokensPerAttempt) throw new Error("Invalid or unsupported frozen campaign manifest.");
  const seenConditions = new Set(value.conditionManifest.conditions.map((item) => item.id));
  for (const attempt of value.executionOrder) {
    try { assertCampaignTaskSuite(attempt.taskId, value.suite); }
    catch { throw new Error("Frozen execution order mixes campaign suites or references an invalid task."); }
    if (!value.taskLocks[attempt.taskId] || !seenConditions.has(attempt.condition) || !Number.isInteger(attempt.repeatIndex) || attempt.repeatIndex < 0) {
      throw new Error("Frozen execution order references an unknown task/condition or invalid repeat.");
    }
  }
}

async function persistCampaign(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

async function exists(path: string): Promise<boolean> { try { await readFile(path); return true; } catch { return false; } }
function option(name: string): string | undefined { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function requiredOption(name: string): string { const value = option(name); if (!value) throw new Error(`${name} is required.`); return value; }
function integerOption(name: string, fallback: number, min: number, max: number): number {
  const raw = option(name); if (raw === undefined) return fallback;
  const value = Number(raw); if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in [${min}, ${max}].`);
  return value;
}
function hash(value: string | Buffer): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function redact(value: string): string { return value.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[redacted]").replace(/(api[_-]?key\s*[:=]\s*)[^\s"']+/gi, "$1[redacted]"); }
