import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, lstat, readlink } from "node:fs/promises";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const execFileAsync = promisify(execFile);

export type WorkspaceFileState = {
  path: string;
  status: string;
  sha256: string | null;
};

export type WorkspaceSnapshot = {
  schemaVersion: 1;
  capturedAt: string;
  workspace: string;
  gitHead?: string;
  files: WorkspaceFileState[];
  fingerprint: string | null;
};

export type VerificationKind = "test" | "typecheck" | "lint" | "build" | "syntax" | "other";

export type EvidenceStatus = "unchecked" | "checks_passed" | "checks_failed" | "stale" | "unknown";
export type TaskVerdict = "accepted" | "rejected" | "unjudged";

export type CheckSpec = {
  id: string;
  command: string;
  cwd: string;
  kind: VerificationKind;
  required: boolean;
  scopePaths: string[];
  requiredFiles: string[];
  environmentFiles: string[];
  environmentKeys: string[];
};

export type VerificationRecord = {
  schemaVersion: 1 | 2;
  id: string;
  sessionId: string;
  runId: string;
  taskId?: string;
  toolCallId?: string;
  command: string;
  cwd: string;
  kind: VerificationKind;
  specId?: string;
  specVersion?: 1;
  evidenceStatus?: EvidenceStatus;
  exitReason?: "exit" | "cancelled" | "timeout" | "start_failed" | "unknown";
  requirementRevision?: number;
  scopePaths?: string[];
  requiredFiles?: string[];
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  ok: boolean;
  workspaceFingerprint: string | null;
  beforeFingerprint?: string | null;
  environmentId?: string;
  outputArtifactPath?: string;
  changedFiles: string[];
};

export type TaskAssessment = {
  evidenceStatus: EvidenceStatus;
  taskVerdict: TaskVerdict;
  reason: string;
  changedFiles: string[];
  verificationId?: string;
  verificationIds?: string[];
};

export async function captureWorkspaceSnapshot(workspace: string, excludePaths: string[] = []): Promise<WorkspaceSnapshot> {
  const root = resolve(workspace);
  let gitHead: string | undefined;
  let statusOutput: string | undefined;
  const [headResult, statusResult] = await Promise.allSettled([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, windowsHide: true }),
    execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root, windowsHide: true })
  ]);
  if (statusResult.status !== "fulfilled") {
    return { schemaVersion: 1, capturedAt: new Date().toISOString(), workspace: root, files: [], fingerprint: null };
  }
  gitHead = headResult.status === "fulfilled" ? headResult.value.stdout.trim() || undefined : undefined;
  statusOutput = statusResult.value.stdout;

  const exclusions = excludePaths.map((path) => resolve(root, path));
  const files = await readWorktreeFileStates(root, statusOutput, exclusions);
  const serialized = JSON.stringify({ gitHead, files: files.map(({ path, status, sha256 }) => ({ path, status, sha256 })) });
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    workspace: root,
    gitHead,
    files,
    fingerprint: createHash("sha256").update(serialized).digest("hex")
  };
}

export function changedFilesSince(baseline: WorkspaceSnapshot, current: WorkspaceSnapshot): string[] {
  if (!baseline.fingerprint || !current.fingerprint || baseline.workspace !== current.workspace) return [];
  const before = new Map(baseline.files.map((file) => [file.path, file.sha256]));
  const after = new Map(current.files.map((file) => [file.path, file.sha256]));
  const committedPaths = baseline.gitHead && current.gitHead && baseline.gitHead !== current.gitHead
    ? committedDiffPaths(current.workspace, baseline.gitHead, current.gitHead)
    : [];
  const paths = new Set([...before.keys(), ...after.keys(), ...committedPaths]);
  return [...paths].filter((path) => {
    const beforeHash = before.has(path) ? before.get(path) : gitBlobHash(baseline.workspace, baseline.gitHead, path);
    const afterHash = after.has(path) ? after.get(path) : gitBlobHash(current.workspace, current.gitHead, path);
    return beforeHash !== afterHash;
  }).sort();
}

function committedDiffPaths(workspace: string, from: string, to: string): string[] {
  try {
    return execFileSync("git", ["diff", "--name-only", "-z", from, to], { cwd: workspace, windowsHide: true })
      .toString("utf8").split("\0").filter(Boolean).map((path) => path.replaceAll("\\", "/"));
  } catch {
    return ["[git history changed; changed paths unavailable]"];
  }
}

function gitBlobHash(workspace: string, revision: string | undefined, path: string): string | null {
  if (!revision || path.startsWith("[git history changed")) return null;
  try {
    const content = execFileSync("git", ["show", `${revision}:${path}`], { cwd: workspace, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

export function classifyVerificationCommand(command: string): VerificationKind | undefined {
  for (const segment of splitShellCommands(command)) {
    const normalized = segment.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)+/, "");
    if (/^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|test:[\w:-]+)|(?:npx|bunx)\s+(?:--yes\s+)?(?:vitest|jest|mocha)|(?:pytest|vitest|jest|mocha)\b|python(?:\d+(?:\.\d+)?)?\s+-m\s+(?:pytest|unittest)|cargo\s+test|go\s+test)\b/i.test(normalized)) return "test";
    if (/^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?typecheck|(?:npx|bunx)\s+(?:--yes\s+)?(?:tsc\s+--noEmit|mypy|pyright)|(?:tsc\s+--noEmit|mypy|pyright)|cargo\s+check|go\s+vet)\b/i.test(normalized)) return "typecheck";
    if (/^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint|(?:npx|bunx)\s+(?:--yes\s+)?(?:eslint|ruff|flake8|biome\s+check)|(?:eslint|ruff|flake8)\b|biome\s+check)\b/i.test(normalized)) return "lint";
    if (/^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build|(?:npx|bunx)\s+(?:--yes\s+)?(?:webpack|vite\s+build)|(?:webpack|compile)\b|vite\s+build|cargo\s+build|go\s+build)\b/i.test(normalized)) return "build";
    if (/^(?:python(?:\d+(?:\.\d+)?)?\s+-m\s+(?:py_compile|compileall)|tsc\s+--noEmit)\b/i.test(normalized)) return "syntax";
  }
  return undefined;
}

function splitShellCommands(command: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if ((char === "'" || char === '"') && command[index - 1] !== "\\") {
      quote = quote === char ? undefined : quote ?? char;
      continue;
    }
    if (quote) continue;
    if (char === ";" || char === "\n" || (char === "&" && command[index + 1] === "&") || (char === "|" && command[index + 1] === "|")) {
      segments.push(command.slice(start, index));
      if (char === "&" || char === "|") index += 1;
      start = index + 1;
    }
  }
  segments.push(command.slice(start));
  return segments;
}

export async function loadCheckSpecs(workspace: string): Promise<CheckSpec[]> {
  const path = resolve(workspace, ".actlume", "checks.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let document: unknown;
  try { document = JSON.parse(raw); } catch { throw new Error(`Invalid check configuration JSON: ${path}`); }
  if (!isRecord(document) || document.schemaVersion !== 1 || !Array.isArray(document.checks)) {
    throw new Error(`Invalid check configuration schema in ${path}; expected schemaVersion 1 and a checks array.`);
  }
  const ids = new Set<string>();
  return document.checks.map((value, index) => {
    if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()
      || typeof value.command !== "string" || !value.command.trim()
      || typeof value.cwd !== "string" || !isVerificationKind(value.kind)) {
      throw new Error(`Invalid CheckSpec at ${path}:checks[${index}].`);
    }
    if (ids.has(value.id)) throw new Error(`Duplicate CheckSpec id '${value.id}' in ${path}.`);
    ids.add(value.id);
    const cwd = resolveCheckPath(workspace, value.cwd, `checks[${index}].cwd`);
    const scopePaths = parsePathList(value.scopePaths, workspace, `checks[${index}].scopePaths`);
    const requiredFiles = parsePathList(value.requiredFiles, workspace, `checks[${index}].requiredFiles`);
    const environmentFiles = parsePathList(value.environmentFiles, workspace, `checks[${index}].environmentFiles`);
    const environmentKeys = parseStringList(value.environmentKeys, `checks[${index}].environmentKeys`);
    return {
      id: value.id,
      command: value.command.trim(),
      cwd,
      kind: value.kind,
      required: value.required !== false,
      scopePaths,
      requiredFiles,
      environmentFiles,
      environmentKeys
    } satisfies CheckSpec;
  });
}

export function matchCheckSpec(workspace: string, specs: CheckSpec[], command: string, cwd: string): CheckSpec | undefined {
  const normalizedCommand = normalizeCommand(command);
  const normalizedCwd = resolve(cwd);
  return specs.find((spec) => normalizeCommand(spec.command) === normalizedCommand && resolve(spec.cwd) === normalizedCwd);
}

export async function checkEnvironmentId(workspace: string, spec: CheckSpec): Promise<string> {
  const files = await Promise.all(spec.environmentFiles.map(async (path) => {
    try {
      const content = await readFile(resolve(workspace, path));
      return [path, createHash("sha256").update(content).digest("hex")];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [path, null];
      throw error;
    }
  }));
  const environment = spec.environmentKeys.map((key) => [key, process.env[key] === undefined ? null : createHash("sha256").update(process.env[key] ?? "").digest("hex")]);
  return createHash("sha256").update(JSON.stringify({
    specId: spec.id,
    command: normalizeCommand(spec.command),
    cwd: resolve(spec.cwd),
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    environment,
    files
  })).digest("hex");
}

export async function requiredCheckFilesAvailable(workspace: string, spec: CheckSpec): Promise<boolean> {
  const results = await Promise.all(spec.requiredFiles.map(async (path) => {
    try { await lstat(resolve(workspace, path)); return true; } catch { return false; }
  }));
  return results.every(Boolean);
}

export async function createVerificationRecord(input: {
  memoryDir: string;
  workspace: string;
  baseline: WorkspaceSnapshot;
  sessionId: string;
  runId: string;
  taskId?: string;
  requirementRevision?: number;
  toolCallId?: string;
  command: string;
  cwd: string;
  checkSpec: CheckSpec;
  beforeSnapshot: WorkspaceSnapshot;
  requiredFilesAvailableAtStart?: boolean;
  environmentIdAtStart?: string;
  outputArtifactPath?: string;
  startedAt: string;
  finishedAt?: string;
  exitCode: number | null;
  exitReason?: VerificationRecord["exitReason"];
}): Promise<VerificationRecord | undefined> {
  if (matchCheckSpec(input.workspace, [input.checkSpec], input.command, input.cwd) === undefined) return undefined;
  const snapshot = await captureWorkspaceSnapshot(input.workspace, [input.memoryDir]);
  const beforeFingerprint = input.beforeSnapshot.fingerprint;
  const environmentId = await checkEnvironmentId(input.workspace, input.checkSpec);
  const filesAtCheckStartExist = await Promise.all(input.checkSpec.requiredFiles.map(async (path) => {
    try { await lstat(resolve(input.workspace, path)); return true; } catch { return false; }
  }));
  const environmentReady = input.requiredFilesAvailableAtStart !== false && filesAtCheckStartExist.every(Boolean)
    && (!input.environmentIdAtStart || input.environmentIdAtStart === environmentId);
  const beforeAfterStable = Boolean(beforeFingerprint && snapshot.fingerprint && beforeFingerprint === snapshot.fingerprint);
  const exitReason = input.exitReason ?? (input.exitCode === null ? "unknown" : "exit");
  const evidenceStatus: EvidenceStatus = !environmentReady || !beforeAfterStable || exitReason !== "exit"
    ? "unknown"
    : input.exitCode === 0 ? "checks_passed" : "checks_failed";
  const record: VerificationRecord = {
    schemaVersion: 2,
    id: randomUUID(),
    sessionId: input.sessionId,
    runId: input.runId,
    taskId: input.taskId,
    requirementRevision: input.requirementRevision,
    toolCallId: input.toolCallId,
    command: input.command,
    cwd: input.cwd,
    kind: input.checkSpec.kind,
    specId: input.checkSpec.id,
    specVersion: 1,
    evidenceStatus,
    exitReason,
    scopePaths: [...input.checkSpec.scopePaths],
    requiredFiles: [...input.checkSpec.requiredFiles],
    startedAt: input.startedAt,
    finishedAt: input.finishedAt ?? new Date().toISOString(),
    exitCode: input.exitCode,
    ok: evidenceStatus === "checks_passed",
    workspaceFingerprint: snapshot.fingerprint,
    beforeFingerprint,
    environmentId,
    outputArtifactPath: input.outputArtifactPath,
    changedFiles: changedFilesSince(input.baseline, snapshot)
  };
  const path = verificationLogPath(input.memoryDir, input.sessionId);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export async function listVerificationRecords(memoryDir: string, sessionId: string): Promise<VerificationRecord[]> {
  try {
    const raw = await readFile(verificationLogPath(memoryDir, sessionId), "utf8");
    return raw.split(/\r?\n/).flatMap((line, index) => {
      if (!line.trim()) return [];
      let record: unknown;
      try { record = JSON.parse(line); } catch { throw new Error(`Invalid verification JSON at ${verificationLogPath(memoryDir, sessionId)}:${index + 1}.`); }
      if (!isRecord(record) || ![1, 2].includes(Number(record.schemaVersion)) || typeof record.id !== "string") {
        throw new Error(`Unsupported or malformed verification record at ${verificationLogPath(memoryDir, sessionId)}:${index + 1}.`);
      }
      return [record as unknown as VerificationRecord];
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function isVerificationCurrent(record: VerificationRecord, snapshot: WorkspaceSnapshot): boolean {
  return record.schemaVersion === 2 && record.evidenceStatus === "checks_passed"
    && record.workspaceFingerprint !== null && record.workspaceFingerprint === snapshot.fingerprint;
}

export function assessTaskOutcome(input: {
  baseline: WorkspaceSnapshot;
  current: WorkspaceSnapshot;
  verifications: VerificationRecord[];
  runId: string;
  taskId?: string;
  requirementRevision?: number;
  checkSpecs: CheckSpec[];
  currentEnvironmentIds: Record<string, string>;
}): TaskAssessment {
  const changedFiles = changedFilesSince(input.baseline, input.current);
  if (!input.baseline.fingerprint || !input.current.fingerprint) {
    return assessment("unknown", "Git workspace fingerprint is unavailable.", changedFiles);
  }
  const requiredSpecs = input.checkSpecs.filter((spec) => spec.required);
  if (requiredSpecs.length === 0) {
    return assessment("unchecked", "No required CheckSpec is configured for this workspace.", changedFiles);
  }
  const latestBySpec = new Map<string, VerificationRecord>();
  for (const record of input.verifications.filter((item) => item.schemaVersion === 2
    && item.runId === input.runId && (!input.taskId || item.taskId === input.taskId)
    && (!input.requirementRevision || item.requirementRevision === input.requirementRevision) && item.specId)) {
    const previous = latestBySpec.get(record.specId!);
    if (!previous || previous.finishedAt.localeCompare(record.finishedAt) < 0) latestBySpec.set(record.specId!, record);
  }
  const checks = requiredSpecs.map((spec) => latestBySpec.get(spec.id));
  if (checks.some((record) => !record)) return assessment("unchecked", "One or more required checks have not run for this attempt.", changedFiles);
  const records = checks as VerificationRecord[];
  if (records.some((record) => record.evidenceStatus === "unknown" || record.exitReason !== "exit")) {
    return assessment("unknown", "A required check ended without a determinate result or its environment was incomplete.", changedFiles, records.map((record) => record.id));
  }
  if (records.some((record) => record.workspaceFingerprint !== input.current.fingerprint
    || record.environmentId !== input.currentEnvironmentIds[record.specId ?? ""])) {
    return assessment("stale", "A required check no longer matches the live workspace or check environment.", changedFiles, records.map((record) => record.id));
  }
  const uncovered = changedFiles.filter((path) => !requiredSpecs.some((spec) => spec.scopePaths.some((scope) => isPathCoveredByScope(path, scope))));
  if (uncovered.length > 0) return assessment("unchecked", `Changed files fall outside all required CheckSpec scopes: ${uncovered.join(", ")}.`, changedFiles, records.map((record) => record.id));
  if (records.some((record) => record.evidenceStatus === "checks_failed")) {
    return assessment("checks_failed", "At least one required CheckSpec failed.", changedFiles, records.map((record) => record.id));
  }
  return {
    evidenceStatus: "checks_passed",
    taskVerdict: "unjudged",
    reason: `All ${records.length} required CheckSpec checks passed for the current workspace and environment. Task acceptance remains unjudged without an independent oracle or human decision.`,
    changedFiles,
    verificationId: records.at(-1)?.id,
    verificationIds: records.map((record) => record.id)
  };
}

function assessment(status: EvidenceStatus, reason: string, changedFiles: string[], verificationIds: string[] = []): TaskAssessment {
  return {
    evidenceStatus: status,
    taskVerdict: "unjudged",
    reason,
    changedFiles,
    verificationId: verificationIds.at(-1),
    verificationIds
  };
}

function verificationLogPath(memoryDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return resolve(memoryDir, "verification", `${safe}.jsonl`);
}

function normalizeCommand(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isPathCoveredByScope(file: string, scope: string): boolean {
  const normalizedFile = file.replaceAll("\\", "/").replace(/^\.\//, "");
  const normalizedScope = scope.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  return normalizedScope === "." || normalizedScope === ""
    || normalizedFile === normalizedScope || normalizedFile.startsWith(`${normalizedScope}/`);
}

function isVerificationKind(value: unknown): value is VerificationKind {
  return ["test", "typecheck", "lint", "build", "syntax", "other"].includes(String(value));
}

function parseStringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`Invalid string list for ${field}.`);
  }
  return value.map((entry) => entry.trim());
}

function parsePathList(value: unknown, workspace: string, field: string): string[] {
  return parseStringList(value, field).map((path) => {
    resolveCheckPath(workspace, path, field);
    return path.replace(/[\\/]+/g, "/").replace(/^\.\//, "");
  });
}

function resolveCheckPath(workspace: string, path: string, field: string): string {
  const root = resolve(workspace);
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${field} must stay inside the workspace.`);
  return absolute;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readWorktreeFileStates(workspace: string, statusOutput: string, exclusions: string[]): Promise<WorkspaceFileState[]> {
  const segments = statusOutput.split("\0").filter(Boolean);
  const parsed: Array<{ path: string; status: string }> = [];
  for (let index = 0; index < segments.length; index += 1) {
    const item = segments[index] ?? "";
    const status = item.slice(0, 2);
    const path = item.slice(3);
    if (!path) continue;
    parsed.push({ path, status });
    if (status.includes("R") || status.includes("C")) {
      const renamedTo = segments[index + 1];
      if (renamedTo) {
        parsed.push({ path: renamedTo, status });
        index += 1;
      }
    }
  }

  return await Promise.all(parsed.map(async ({ path, status }) => {
    const absolute = resolve(workspace, path);
    const rel = relative(workspace, absolute);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { path, status, sha256: null };
    if (exclusions.some((excluded) => isPathWithin(excluded, absolute))) return undefined;
    try {
      const info = await lstat(absolute);
      const digestInput = info.isSymbolicLink() ? `symlink:${await readlink(absolute)}` : await readFile(absolute);
      return { path, status, sha256: createHash("sha256").update(digestInput).digest("hex") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, status, sha256: null };
      throw error;
    }
  })).then((entries) => entries.filter((entry): entry is WorkspaceFileState => Boolean(entry)));
}

function isPathWithin(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return relativePath === "" || (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`));
}
