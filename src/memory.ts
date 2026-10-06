import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

export type MemoryType = "user" | "feedback" | "project" | "reference";
export type MemoryScope = "repository" | "worktree" | "task" | "user";
export type MemoryEvidenceType = "user_confirmed" | "verified" | "observed" | "inferred" | "candidate";
export type MemoryStatus = "candidate" | "active" | "needs_review" | "superseded" | "disabled";

export type MemoryApplicabilityFile = {
  path: string;
  sha256: string;
};

export type MemoryIdentity = {
  repositoryId?: string;
  worktreeId?: string;
  taskId?: string;
  sessionId?: string;
  branchId?: string;
  userConsent?: "current-os-user";
};

export type MemoryRejection = { filename: string; reason: "candidate" | "needs_review" | "superseded" | "disabled" | "scope_mismatch" | "stale_file" | "consent_required" | "rank_limit" | "below_retrieval_rank" };

export type MemoryRecallResult = {
  memories: MemoryEntry[];
  selected: Array<{ filename: string; reason: "keyword" | "trigram" | "substring" }>;
  rejected: MemoryRejection[];
};

export type MemoryEntry = {
  schemaVersion?: number;
  id?: string;
  name: string;
  description: string;
  type: MemoryType;
  filename: string;
  content: string;
  updatedAt?: string;
  scope?: MemoryScope;
  sourceRefs?: string[];
  evidenceType?: MemoryEvidenceType;
  status?: MemoryStatus;
  applicability?: MemoryApplicabilityFile[];
  identity?: MemoryIdentity;
  supersedes?: string[];
  reviewReason?: string;
  schemaWarning?: string;
};

type SaveMemoryOptions = { workspace?: string; identity?: MemoryIdentity };

const execFileAsync = promisify(execFile);
const memoryMutationQueues = new Map<string, Promise<void>>();
const userMemoryStoreName = "user-memories";

const validTypes = new Set<MemoryType>(["user", "feedback", "project", "reference"]);

export function getTypedMemoryDir(memoryDir: string): string {
  return join(memoryDir, "memories");
}

export async function saveMemory(
  memoryDir: string,
  entry: Omit<MemoryEntry, "filename" | "schemaVersion" | "id">,
  options: SaveMemoryOptions = {}
): Promise<MemoryEntry> {
  return withMemoryMutation(memoryDir, async () => {
    const scope = entry.scope ?? "repository";
    const identity = options.identity ?? entry.identity ?? await captureMemoryIdentity(options.workspace ?? memoryDir);
    const id = hash(`${scope}:${entry.type}:${entry.name}:${identity.repositoryId ?? ""}:${identity.worktreeId ?? ""}:${identity.taskId ?? ""}:${identity.sessionId ?? ""}:${identity.branchId ?? ""}:${identity.userConsent ?? ""}`);
    const filename = `${entry.type}_${slugify(entry.name)}_${id.slice(0, 10)}.md`;
    const requestedStatus = entry.status ?? "candidate";
    const identityIncomplete = !identitySupportsScope(scope, identity);
    const stored: MemoryEntry = {
      ...entry,
      schemaVersion: 3,
      id,
      filename,
      updatedAt: new Date().toISOString(),
      scope,
      identity,
      sourceRefs: entry.sourceRefs ?? [],
      evidenceType: entry.evidenceType ?? "candidate",
      status: requestedStatus === "active" && identityIncomplete ? "needs_review" : requestedStatus,
      applicability: entry.applicability ?? [],
      supersedes: entry.supersedes ?? [],
      reviewReason: requestedStatus === "active" && identityIncomplete
        ? `Scope '${scope}' cannot be activated without its required identity fields.`
        : entry.reviewReason
    };
    await writeMemoryFile(memoryDir, stored);
    await updateMemoryIndex(memoryDir);
    return stored;
  });
}

export async function listMemories(memoryDir: string): Promise<MemoryEntry[]> {
  const dir = getTypedMemoryDir(memoryDir);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const entries = await Promise.all(
    files
      .filter((file) => file.endsWith(".md") && file !== "MEMORY.md")
      .map((file) => readMemoryFile(memoryDir, file))
  );
  return entries
    .filter((entry): entry is MemoryEntry => Boolean(entry))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

export async function recallMemories(
  memoryDir: string,
  query: string,
  limit = 5,
  workspace?: string,
  identity?: MemoryIdentity,
  userMemoryDir = getUserMemoryDir()
): Promise<MemoryEntry[]> {
  return (await recallMemoriesDetailed(memoryDir, query, limit, workspace, identity, userMemoryDir)).memories;
}

export async function recallMemoriesDetailed(
  memoryDir: string,
  query: string,
  limit = 5,
  workspace?: string,
  identity?: MemoryIdentity,
  userMemoryDir = getUserMemoryDir()
): Promise<MemoryRecallResult> {
  const normalizedQuery = query.toLowerCase();
  const words = normalizedQuery
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((term) => term.length > 0);

  // Generate CJK bigrams to bridge Chinese queries to mixed-script content.
  // Only for CJK characters (U+4E00–U+9FFF, U+3400–U+4DBF, U+F900–U+FAFF).
  // "前端框架偏好" → extra terms: "前端", "端框", "框架", "架偏", "偏好"
  const cjkBigrams: string[] = [];
  for (const word of words) {
    if (word.length >= 2 && isCjkDense(word)) {
      for (let i = 0; i <= word.length - 2; i += 1) {
        cjkBigrams.push(word.slice(i, i + 2));
      }
    }
  }
  const allTerms = [...new Set([...words, ...cjkBigrams])];

  const currentIdentity = { ...(await captureMemoryIdentity(workspace ?? memoryDir)), ...identity };
  if (await hasUserMemoryConsent(userMemoryDir)) currentIdentity.userConsent = "current-os-user";
  const localMemories = await listMemories(memoryDir);
  const userMemories = currentIdentity.userConsent ? await listMemories(userMemoryDir) : [];
  const allMemories = [...localMemories, ...userMemories];
  const rejected: MemoryRejection[] = [];
  const eligible: MemoryEntry[] = [];
  const superseding = allMemories.filter((entry) => entry.status === "active" && (entry.supersedes?.length ?? 0) > 0);
  const suppressedIds = new Set<string>();
  for (const source of superseding) {
    if (!memoryIdentityMatches(source, currentIdentity)) continue;
    for (const id of source.supersedes ?? []) {
      const target = allMemories.find((entry) => entry.id === id);
      if (target && sameIdentityScope(source, target)) suppressedIds.add(id);
    }
  }

  for (const memory of allMemories) {
    if (memory.status !== "active") {
      rejected.push({ filename: memory.filename, reason: memory.status ?? "needs_review" });
      continue;
    }
    if (memory.scope === "user" && !currentIdentity.userConsent) {
      rejected.push({ filename: memory.filename, reason: "consent_required" });
      continue;
    }
    if (!memory.identity) {
      rejected.push({ filename: memory.filename, reason: "needs_review" });
      if (localMemories.some((item) => item.filename === memory.filename)) {
        await setMemoryStatus(memoryDir, memory.filename, "needs_review", undefined, "Legacy active memory has no repository/task identity; review its applicability before reuse.");
      }
      continue;
    }
    if (!memoryIdentityMatches(memory, currentIdentity)) {
      rejected.push({ filename: memory.filename, reason: "scope_mismatch" });
      continue;
    }
    if (memory.id && suppressedIds.has(memory.id)) {
      rejected.push({ filename: memory.filename, reason: "superseded" });
      continue;
    }
    if (memory.scope !== "user" && !await isMemoryApplicable(workspace ?? memoryDir, memory)) {
      rejected.push({ filename: memory.filename, reason: "stale_file" });
      const local = localMemories.some((item) => item.filename === memory.filename);
      if (local) await setMemoryStatus(memoryDir, memory.filename, "needs_review", undefined, "Referenced workspace file fingerprint changed or disappeared.");
      else await setMemoryStatus(userMemoryDir, memory.filename, "needs_review", undefined, "Referenced workspace file fingerprint changed or disappeared.");
      continue;
    }
    eligible.push(memory);
  }

  const keywordMatches = allTerms.length > 0
    ? eligible.map((memory) => ({ memory, score: scoreMemory(memory, allTerms) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score)
    : [];
  const trigramMatches = keywordMatches.length === 0
    ? eligible.map((memory) => ({ memory, score: trigramScore(normalizedQuery, `${memory.name} ${memory.description} ${memory.content}`) }))
      .filter((item) => item.score > 0).sort((a, b) => b.score - a.score)
    : [];
  const substringMatches = keywordMatches.length === 0 && trigramMatches.length === 0
    ? eligible.map((memory) => ({ memory, score: words.reduce((score, word) => score + (word.length >= 2 && `${memory.name} ${memory.description} ${memory.content}`.toLowerCase().includes(word) ? 1 : 0), 0) }))
      .filter((item) => item.score > 0).sort((a, b) => b.score - a.score)
    : [];
  const chosen = keywordMatches.length > 0 ? keywordMatches : trigramMatches.length > 0 ? trigramMatches : substringMatches;
  const reason = keywordMatches.length > 0 ? "keyword" as const : trigramMatches.length > 0 ? "trigram" as const : "substring" as const;
  const memories = chosen.slice(0, limit).map((item) => item.memory);
  const selected = memories.map((memory) => ({ filename: memory.filename, reason }));
  const selectedFilenames = new Set(memories.map((memory) => memory.filename));
  for (const item of chosen.slice(limit)) rejected.push({ filename: item.memory.filename, reason: "rank_limit" });
  for (const memory of eligible) {
    if (!selectedFilenames.has(memory.filename) && !chosen.some((item) => item.memory.filename === memory.filename)) {
      rejected.push({ filename: memory.filename, reason: "below_retrieval_rank" });
    }
  }
  return { memories, selected, rejected };
}

function trigramScore(query: string, text: string): number {
  const queryTrigrams = extractTrigrams(query.toLowerCase());
  const textTrigrams = extractTrigrams(text.toLowerCase());
  if (queryTrigrams.size === 0 || textTrigrams.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const trigram of queryTrigrams) {
    if (textTrigrams.has(trigram)) {
      overlap += 1;
    }
  }

  // Jaccard-like: overlap / (query size), penalize very short queries
  return overlap / Math.max(queryTrigrams.size, 3);
}

function extractTrigrams(text: string): Set<string> {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length < 3) {
    return new Set([normalized]);
  }

  const trigrams = new Set<string>();
  // Character trigrams — works for both CJK and Latin scripts
  for (let i = 0; i <= normalized.length - 3; i += 1) {
    trigrams.add(normalized.slice(i, i + 3));
  }
  return trigrams;
}

export async function deleteMemory(memoryDir: string, filename: string): Promise<boolean> {
  return withMemoryMutation(memoryDir, async () => {
    try {
      await unlink(join(getTypedMemoryDir(memoryDir), filename));
      await updateMemoryIndex(memoryDir);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  });
}

export async function captureMemoryApplicability(workspace: string, paths: string[]): Promise<MemoryApplicabilityFile[]> {
  const root = resolve(workspace);
  const files: MemoryApplicabilityFile[] = [];
  for (const path of [...new Set(paths)]) {
    const absolute = resolve(root, path);
    const relativePath = relative(root, absolute);
    if (!path || isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
      throw new Error(`Memory applicability path must stay inside the workspace: ${path}`);
    }
    const content = await readFile(absolute);
    files.push({ path: relativePath.replaceAll("\\", "/"), sha256: hash(content.toString("base64")) });
  }
  return files;
}

export async function captureMemoryIdentity(
  workspace: string,
  scopeContext: Pick<MemoryIdentity, "taskId" | "sessionId" | "branchId" | "userConsent"> = {}
): Promise<MemoryIdentity> {
  const resolvedWorkspace = resolve(workspace);
  let worktreeRoot = resolvedWorkspace;
  let repositoryRoot = resolvedWorkspace;
  try {
    const rootOutput = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: resolvedWorkspace, windowsHide: true });
    worktreeRoot = resolve(rootOutput.stdout.trim());
    const commonOutput = await execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd: resolvedWorkspace, windowsHide: true });
    repositoryRoot = resolve(worktreeRoot, commonOutput.stdout.trim());
  } catch {
    // A non-Git workspace gets a stable path identity and remains isolated from other folders.
  }
  return {
    repositoryId: hash(canonicalPath(repositoryRoot)),
    worktreeId: hash(canonicalPath(worktreeRoot)),
    ...scopeContext
  };
}

export async function setMemoryStatus(
  memoryDir: string,
  filename: string,
  status: MemoryStatus,
  evidenceType?: MemoryEvidenceType,
  reviewReason?: string
): Promise<MemoryEntry | undefined> {
  if (!/^[A-Za-z0-9_\-\u3400-\u9fff]+\.md$/.test(filename)) {
    throw new Error("Invalid memory filename.");
  }
  return withMemoryMutation(memoryDir, async () => {
    const current = await readMemoryFile(memoryDir, filename);
    if (!current) return undefined;
    let updated: MemoryEntry = {
      ...current,
      status,
      evidenceType: evidenceType ?? current.evidenceType ?? "inferred",
      reviewReason: status === "needs_review" ? reviewReason ?? current.reviewReason : undefined,
      updatedAt: new Date().toISOString()
    };
    const targetsToSupersede: MemoryEntry[] = [];
    if (status === "active" && (current.supersedes?.length ?? 0) > 0) {
      const records = await listMemories(memoryDir);
      for (const targetId of current.supersedes ?? []) {
        const target = records.find((entry) => entry.id === targetId);
        if (!target) {
          updated = { ...updated, status: "needs_review", reviewReason: `supersedes target '${targetId}' is missing; both historical evidence and candidate source were retained for review.` };
          break;
        }
        if (!sameIdentityScope(current, target)) {
          updated = { ...updated, status: "needs_review", reviewReason: `supersedes target '${targetId}' belongs to a different memory scope or identity; resolve the conflict manually.` };
          break;
        }
        if (target.status === "active") targetsToSupersede.push(target);
      }
    }
    await writeMemoryFile(memoryDir, updated);
    if (updated.status === "active") {
      for (const target of targetsToSupersede) {
        await writeMemoryFile(memoryDir, { ...target, status: "superseded", reviewReason: undefined, updatedAt: new Date().toISOString() });
      }
    }
    await updateMemoryIndex(memoryDir);
    return updated;
  });
}

export async function promoteUserMemory(memoryDir: string, filename: string, userMemoryDir = getUserMemoryDir()): Promise<MemoryEntry | undefined> {
  const candidate = (await listMemories(memoryDir)).find((entry) => entry.filename === filename);
  if (!candidate || candidate.scope !== "user") return undefined;
  const userIdentity: MemoryIdentity = { userConsent: "current-os-user" };
  const { filename: _filename, schemaVersion: _schemaVersion, id: _id, ...candidateData } = candidate;
  const storedCandidate = await saveMemory(userMemoryDir, {
    ...candidateData,
    scope: "user",
    identity: userIdentity,
    applicability: [],
    evidenceType: "candidate",
    status: "candidate",
    updatedAt: new Date().toISOString()
  }, { identity: userIdentity });
  const promoted = await setMemoryStatus(userMemoryDir, storedCandidate.filename, "active", "user_confirmed");
  if (!promoted || promoted.status !== "active") return promoted;
  await writeAtomic(join(userMemoryDir, "CONSENT.json"), `${JSON.stringify({ schemaVersion: 1, scope: "current-os-user", grantedAt: new Date().toISOString() }, null, 2)}\n`);
  await setMemoryStatus(memoryDir, filename, "superseded", "user_confirmed", "Promoted into the explicitly consented current-OS-user memory store.");
  return promoted;
}

export async function hasUserMemoryConsent(userMemoryDir = getUserMemoryDir()): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(join(userMemoryDir, "CONSENT.json"), "utf8")) as { schemaVersion?: unknown; scope?: unknown };
    return value.schemaVersion === 1 && value.scope === "current-os-user";
  } catch {
    return false;
  }
}

export async function revokeUserMemoryConsent(userMemoryDir = getUserMemoryDir()): Promise<void> {
  try { await unlink(join(userMemoryDir, "CONSENT.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export function getUserMemoryDir(): string {
  const home = process.env.ACTLUME_HOME ? resolve(process.env.ACTLUME_HOME) : homedir();
  return join(home, ".actlume", userMemoryStoreName);
}

export async function buildMemoryPromptSection(memoryDir: string): Promise<string> {
  const index = await loadMemoryIndex(memoryDir);
  const dir = getTypedMemoryDir(memoryDir);
  return [
    "## Typed Memory",
    `Memory directory: ${dir}`,
    "Memory types: user, feedback, project, reference.",
    "Use memorySave for durable user preferences, feedback, project decisions, and references.",
    index ? `Current memory index:\n${index}` : "No typed memories saved yet."
  ].join("\n");
}

export function buildRelevantMemoryContext(entries: MemoryEntry[], maxChars = 10_000): string {
  if (entries.length === 0 || maxChars <= 0) return "";

  const sections: string[] = [
    "## Retrieved Actlume Memories",
    "These are prior notes with the listed type and source file. Treat them as fallible context; check whether each note applies to the current task."
  ];
  let remaining = maxChars - sections.join("\n").length - 2;
  for (const entry of entries) {
    if (remaining <= 0) break;
    const content = entry.content.trim();
    const refs = entry.sourceRefs?.length ? entry.sourceRefs.join(", ") : "unspecified";
    const section = `### ${entry.name} (${entry.type}; ${entry.scope ?? "legacy scope"}; ${entry.status ?? "needs_review"}; ${entry.evidenceType ?? "legacy evidence"}; source: ${entry.filename}; refs: ${refs})\n${entry.description}\n\n${content}`;
    const bounded = section.length > remaining ? `${section.slice(0, Math.max(0, remaining - 22))}\n[truncated]` : section;
    sections.push(bounded);
    remaining -= bounded.length + 2;
  }
  return sections.join("\n\n");
}

async function updateMemoryIndex(memoryDir: string): Promise<void> {
  const dir = getTypedMemoryDir(memoryDir);
  await mkdir(dir, { recursive: true });
  const memories = await listMemories(memoryDir);
  const lines = ["# Memory Index", ""];
  for (const memory of memories) {
    lines.push(`- **[${memory.name}](${memory.filename})** (${memory.type}; ${memory.scope ?? "unknown scope"}; ${memory.status ?? "needs_review"}; ${memory.evidenceType ?? "legacy evidence"}) - ${memory.description}`);
  }
  await writeAtomic(join(dir, "MEMORY.md"), `${lines.join("\n")}\n`);
}

async function writeMemoryFile(memoryDir: string, entry: MemoryEntry): Promise<void> {
  const directory = getTypedMemoryDir(memoryDir);
  await mkdir(directory, { recursive: true });
  await writeAtomic(join(directory, entry.filename), formatMemoryFile(entry));
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    try { await unlink(temporary); } catch { /* best-effort removal of a failed atomic write */ }
    throw error;
  }
}

function withMemoryMutation<T>(memoryDir: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(memoryDir);
  const previous = memoryMutationQueues.get(key) ?? Promise.resolve();
  const current = previous.then(async () => {
    await mkdir(key, { recursive: true });
    const lockPath = join(key, ".memory-write.lock");
    const lock = await acquireMemoryLock(lockPath);
    try { return await operation(); }
    finally {
      await lock.close();
      try { await unlink(lockPath); } catch { /* a stale lock will be detected by its owner */ }
    }
  });
  memoryMutationQueues.set(key, current.then(() => undefined, () => undefined));
  return current;
}

async function acquireMemoryLock(path: string): Promise<Awaited<ReturnType<typeof open>>> {
  const timeoutAt = Date.now() + 10_000;
  while (Date.now() < timeoutAt) {
    try {
      return await open(path, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const info = await stat(path);
        if (Date.now() - info.mtimeMs > 120_000) {
          await unlink(path);
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
  throw new Error(`Timed out waiting for memory store lock: ${path}`);
}

async function loadMemoryIndex(memoryDir: string): Promise<string> {
  try {
    const raw = await readFile(join(getTypedMemoryDir(memoryDir), "MEMORY.md"), "utf8");
    const lines = raw.split(/\r?\n/).slice(0, 200).join("\n");
    return lines.length > 25000 ? `${lines.slice(0, 25000)}\n\n[truncated memory index]` : lines;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function readMemoryFile(memoryDir: string, filename: string): Promise<MemoryEntry | undefined> {
  try {
    const path = join(getTypedMemoryDir(memoryDir), filename);
    const raw = await readFile(path, "utf8");
    const { meta, body } = parseFrontmatter(raw);
    const stats = await stat(path);
    const type = validTypes.has(meta.type as MemoryType) ? (meta.type as MemoryType) : "project";
    const parsedSchemaVersion = meta.schemaVersion === undefined || meta.schemaVersion === "" ? 1 : Number(meta.schemaVersion);
    const unsupportedSchema = parsedSchemaVersion !== 1 && parsedSchemaVersion !== 2 && parsedSchemaVersion !== 3;
    const identity = parseJsonObject<MemoryIdentity>(meta.identity);
    const scope = isEnumValue<MemoryScope>(meta.scope, ["repository", "worktree", "task", "user"])
      ? meta.scope as MemoryScope
      : type === "user" ? "user" : "repository";
    const identityMissing = !identity || !identitySupportsScope(scope, identity);
    const needsIdentityReview = !unsupportedSchema && identityMissing;
    return {
      schemaVersion: Number.isFinite(parsedSchemaVersion) ? parsedSchemaVersion : undefined,
      id: meta.id || undefined,
      name: meta.name || filename.replace(/\.md$/, ""),
      description: meta.description || "",
      type,
      filename,
      content: body,
      updatedAt: meta.updatedAt || stats.mtime.toISOString(),
      scope,
      sourceRefs: parseJsonArray(meta.sourceRefs),
      evidenceType: isEnumValue<MemoryEvidenceType>(meta.evidenceType, ["user_confirmed", "verified", "observed", "inferred", "candidate"])
        ? meta.evidenceType as MemoryEvidenceType
        : "inferred",
      status: unsupportedSchema || needsIdentityReview ? "needs_review" : isEnumValue<MemoryStatus>(meta.status, ["candidate", "active", "needs_review", "superseded", "disabled"])
        ? meta.status as MemoryStatus
        : "needs_review",
      applicability: parseJsonArrayOfObjects<MemoryApplicabilityFile>(meta.applicability),
      identity,
      supersedes: parseJsonArray(meta.supersedes),
      reviewReason: meta.reviewReason || undefined,
      schemaWarning: unsupportedSchema
        ? `Unsupported memory schema version '${meta.schemaVersion}'. This entry is retained for review and excluded from recall.`
        : needsIdentityReview ? `Memory schema version '${parsedSchemaVersion}' has no repository/task identity. This entry is retained for review and excluded from recall.` : undefined
    };
  } catch {
    return undefined;
  }
}

function formatMemoryFile(entry: MemoryEntry): string {
  return [
    "---",
    `name: ${entry.name}`,
    `description: ${entry.description}`,
    `type: ${entry.type}`,
    `schemaVersion: ${entry.schemaVersion ?? 3}`,
    `id: ${entry.id ?? hash(`${entry.type}:${entry.name}`)}`,
    `scope: ${entry.scope ?? "repository"}`,
    `sourceRefs: ${JSON.stringify(entry.sourceRefs ?? [])}`,
    `evidenceType: ${entry.evidenceType ?? "candidate"}`,
    `status: ${entry.status ?? "candidate"}`,
    `applicability: ${JSON.stringify(entry.applicability ?? [])}`,
    `identity: ${JSON.stringify(entry.identity ?? {})}`,
    `supersedes: ${JSON.stringify(entry.supersedes ?? [])}`,
    ...(entry.reviewReason ? [`reviewReason: ${entry.reviewReason}`] : []),
    `updatedAt: ${entry.updatedAt ?? new Date().toISOString()}`,
    "---",
    "",
    entry.content.trim(),
    ""
  ].join("\n");
}

function scoreMemory(memory: MemoryEntry, terms: string[]): number {
  const haystack = `${memory.name}\n${memory.description}\n${memory.type}\n${memory.content}`.toLowerCase();
  return terms.reduce((score, term) => score + countOccurrences(haystack, term), 0);
}

function isCjkDense(text: string): boolean {
  let cjk = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0xf900 && cp <= 0xfaff)) {
      cjk += 1;
    }
  }
  return cjk >= text.length * 0.5;
}

function countOccurrences(text: string, term: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const found = text.indexOf(term, index);
    if (found === -1) {
      return count;
    }
    count += 1;
    index = found + term.length;
  }
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return slug || "memory";
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function isMemoryApplicable(workspace: string, entry: MemoryEntry): Promise<boolean> {
  for (const file of entry.applicability ?? []) {
    const absolute = resolve(workspace, file.path);
    const relativePath = relative(workspace, absolute);
    if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) return false;
    try {
      const currentHash = hash((await readFile(absolute)).toString("base64"));
      if (currentHash !== file.sha256) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function memoryIdentityMatches(entry: MemoryEntry, current: MemoryIdentity): boolean {
  const stored = entry.identity;
  if (!stored || !identitySupportsScope(entry.scope ?? "repository", stored)) return false;
  switch (entry.scope ?? "repository") {
    case "repository": return stored.repositoryId === current.repositoryId;
    case "worktree": return stored.repositoryId === current.repositoryId && stored.worktreeId === current.worktreeId;
    case "task": return stored.repositoryId === current.repositoryId && stored.worktreeId === current.worktreeId
      && stored.taskId === current.taskId && stored.sessionId === current.sessionId && stored.branchId === current.branchId;
    case "user": return stored.userConsent === "current-os-user" && current.userConsent === "current-os-user";
  }
}

function sameIdentityScope(left: MemoryEntry, right: MemoryEntry): boolean {
  if ((left.scope ?? "repository") !== (right.scope ?? "repository") || !left.identity || !right.identity) return false;
  const scope = left.scope ?? "repository";
  switch (scope) {
    case "repository": return Boolean(left.identity.repositoryId) && left.identity.repositoryId === right.identity.repositoryId;
    case "worktree": return Boolean(left.identity.repositoryId && left.identity.worktreeId)
      && left.identity.repositoryId === right.identity.repositoryId && left.identity.worktreeId === right.identity.worktreeId;
    case "task": return Boolean(left.identity.repositoryId && left.identity.worktreeId && left.identity.taskId && left.identity.sessionId && left.identity.branchId)
      && left.identity.repositoryId === right.identity.repositoryId && left.identity.worktreeId === right.identity.worktreeId
      && left.identity.taskId === right.identity.taskId && left.identity.sessionId === right.identity.sessionId && left.identity.branchId === right.identity.branchId;
    case "user": return left.identity.userConsent === "current-os-user" && right.identity.userConsent === "current-os-user";
  }
}

function identitySupportsScope(scope: MemoryScope, identity: MemoryIdentity): boolean {
  if (scope === "user") return identity.userConsent === "current-os-user";
  if (!identity.repositoryId || !identity.worktreeId) return false;
  if (scope === "task") return Boolean(identity.taskId && identity.sessionId && identity.branchId);
  return true;
}

function canonicalPath(path: string): string {
  const canonical = resolve(path).replaceAll("\\", "/").replace(/\/$/, "");
  return process.platform === "win32" ? canonical.toLocaleLowerCase("en-US") : canonical;
}

function parseJsonArray(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonArrayOfObjects<T extends object>(value: string | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is T => typeof item === "object" && item !== null) : [];
  } catch {
    return [];
  }
}

function parseJsonObject<T extends object>(value: string | undefined): T | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as T : undefined;
  } catch {
    return undefined;
  }
}

function isEnumValue<T extends string>(value: string | undefined, values: T[]): value is T {
  return value !== undefined && values.includes(value as T);
}
