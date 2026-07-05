import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

export type MemoryType = "user" | "feedback" | "project" | "reference";

export type MemoryEntry = {
  name: string;
  description: string;
  type: MemoryType;
  filename: string;
  content: string;
  updatedAt?: string;
};

const validTypes = new Set<MemoryType>(["user", "feedback", "project", "reference"]);

export function getTypedMemoryDir(memoryDir: string): string {
  return join(memoryDir, "memories");
}

export async function saveMemory(
  memoryDir: string,
  entry: Omit<MemoryEntry, "filename">
): Promise<MemoryEntry> {
  const dir = getTypedMemoryDir(memoryDir);
  await mkdir(dir, { recursive: true });
  const filename = `${entry.type}_${slugify(entry.name)}_${hash(entry.name).slice(0, 8)}.md`;
  const stored: MemoryEntry = {
    ...entry,
    filename,
    updatedAt: new Date().toISOString()
  };
  await writeFile(join(dir, filename), formatMemoryFile(stored), "utf8");
  await updateMemoryIndex(memoryDir);
  return stored;
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

export async function recallMemories(memoryDir: string, query: string, limit = 5): Promise<MemoryEntry[]> {
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

  const memories = await listMemories(memoryDir);
  if (memories.length === 0) {
    return [];
  }

  // Phase 1: keyword matching (word + CJK bigram terms)
  if (allTerms.length > 0) {
    const keywordResults = memories
      .map((memory) => ({ memory, score: scoreMemory(memory, allTerms) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.memory);

    if (keywordResults.length > 0) {
      return keywordResults;
    }
  }

  // Phase 2: trigram overlap (fuzzy, catches "前端框架" ↔ "React前端开发")
  const scored = memories
    .map((memory) => ({
      memory,
      score: trigramScore(normalizedQuery, `${memory.name} ${memory.description} ${memory.content}`)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.memory);

  if (scored.length > 0) {
    return scored;
  }

  // Phase 3: substring fallback — any query word appears as a substring in memory
  const substringResults = memories
    .map((memory) => {
      const haystack = `${memory.name} ${memory.description} ${memory.content}`.toLowerCase();
      const score = words.reduce((s, w) => s + (w.length >= 2 && haystack.includes(w) ? 1 : 0), 0);
      return { memory, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.memory);

  if (substringResults.length > 0) {
    return substringResults;
  }

  // Phase 4: most-recent fallback for the LLM to semantically filter
  return memories.slice(0, limit);
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
  try {
    await unlink(join(getTypedMemoryDir(memoryDir), filename));
    await updateMemoryIndex(memoryDir);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
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

async function updateMemoryIndex(memoryDir: string): Promise<void> {
  const dir = getTypedMemoryDir(memoryDir);
  await mkdir(dir, { recursive: true });
  const memories = await listMemories(memoryDir);
  const lines = ["# Memory Index", ""];
  for (const memory of memories) {
    lines.push(`- **[${memory.name}](${memory.filename})** (${memory.type}) - ${memory.description}`);
  }
  await writeFile(join(dir, "MEMORY.md"), `${lines.join("\n")}\n`, "utf8");
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
    return {
      name: meta.name || filename.replace(/\.md$/, ""),
      description: meta.description || "",
      type,
      filename,
      content: body,
      updatedAt: meta.updatedAt || stats.mtime.toISOString()
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
