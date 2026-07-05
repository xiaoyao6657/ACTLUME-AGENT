import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { SearchResult, ToolDefinition } from "../types.js";
import { toolSuccess } from "../tool-result.js";
import { resolveInsideCwd, toProjectRelative } from "./path-utils.js";

const ignoredNames = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "coverage",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  ".agent-memory",
  ".agent-benchmark",
  ".next",
  ".turbo",
  ".cache"
]);

const listSchema = z.object({ path: z.string().default(".") });
const treeSchema = z.object({ path: z.string().default("."), depth: z.number().int().min(0).max(8).default(2) });
const searchSchema = z.object({
  root: z.string().default("."),
  pattern: z.string().min(1),
  maxResults: z.number().int().min(1).max(200).default(50)
});
const globSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().default("."),
  maxResults: z.number().int().min(1).max(500).default(200)
});

export const listDirTool: ToolDefinition = {
  name: "listDir",
  description: "List files and directories under a workspace path.",
  sideEffect: "read",
  parameters: {
    type: "object",
    properties: { path: { type: "string", default: "." } }
  },
  async run(input, ctx) {
    const args = listSchema.parse(input ?? {});
    const dir = resolveInsideCwd(ctx.cwd, args.path);
    const entries = await readdir(dir, { withFileTypes: true });
    const lines = entries
      .filter((entry) => !ignoredNames.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`)
      .join("\n");
    return toolSuccess(lines, { path: args.path });
  }
};

export const treeTool: ToolDefinition = {
  name: "tree",
  description: "Return a compact directory tree, ignoring dependency, build, cache, VCS, virtualenv, and agent memory directories.",
  sideEffect: "read",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", default: "." },
      depth: { type: "number", default: 2 }
    }
  },
  async run(input, ctx) {
    const args = treeSchema.parse(input ?? {});
    const dir = resolveInsideCwd(ctx.cwd, args.path);
    const lines = await buildTree(ctx.cwd, dir, args.depth);
    return toolSuccess(lines.join("\n"), { path: args.path, depth: args.depth });
  }
};

export const searchTextTool: ToolDefinition = {
  name: "searchText",
  description:
    "Search text files under a directory, or inside a single file, with a regular expression pattern. Uses ripgrep (rg) when available for fast native search, falling back to Node.js traversal.",
  sideEffect: "read",
  parameters: {
    type: "object",
    properties: {
      root: { type: "string", default: "." },
      pattern: { type: "string" },
      maxResults: { type: "number", default: 50 }
    },
    required: ["pattern"]
  },
  async run(input, ctx) {
    const args = searchSchema.parse(input ?? {});
    const root = resolveInsideCwd(ctx.cwd, args.root);
    const results = await searchText(ctx.cwd, root, args.pattern, args.maxResults);
    return toolSuccess(results.length === 0 ? "No matches found." : JSON.stringify(results, null, 2), {
      root: args.root,
      pattern: args.pattern,
      resultCount: results.length
    });
  }
};

export const globTool: ToolDefinition = {
  name: "glob",
  description:
    "Find files matching a glob pattern. Supports ** (recursive), * (any name chars), and ? (single char). Fast file discovery by pattern — use before searchText/grep on the results.",
  sideEffect: "read",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. \"**/*.test.ts\" or \"src/**/*.py\"." },
      path: { type: "string", default: ".", description: "Search root directory." },
      maxResults: { type: "number", default: 200, description: "Maximum file count to return." }
    },
    required: ["pattern"]
  },
  async run(input, ctx) {
    const args = globSchema.parse(input ?? {});
    const root = resolveInsideCwd(ctx.cwd, args.path);
    const results = await globSearch(ctx.cwd, root, args.pattern, args.maxResults);
    if (results.length === 0) {
      return toolSuccess("No files matched.", { pattern: args.pattern, path: args.path, count: 0 });
    }
    return toolSuccess(results.join("\n"), {
      pattern: args.pattern,
      path: args.path,
      count: results.length,
      truncated: results.length >= args.maxResults
    });
  }
};

// ── ripgrep integration ─────────────────────────────────────────────

function execFileAsync(
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number; maxBuffer?: number }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function tryRipgrepSearch(
  cwd: string,
  root: string,
  pattern: string,
  maxResults: number
): Promise<SearchResult[] | null> {
  try {
    // --json: machine-readable output, one JSON object per line
    // --no-config: skip user rg config for consistent behaviour
    const args = [
      "--json",
      "--line-number",
      "--color", "never",
      "--no-config",
      "--no-ignore-vcs",
      "--max-count", String(maxResults),
      "--", pattern, root
    ];

    const { stdout } = await execFileAsync("rg", args, {
      cwd,
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024
    });

    const results: SearchResult[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim() || results.length >= maxResults) {
        break;
      }
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.type === "match" && parsed.data && typeof parsed.data === "object") {
          const data = parsed.data as Record<string, unknown>;
          const pathData = data.path as Record<string, unknown> | undefined;
          const filePath = typeof pathData?.text === "string" ? pathData.text : String(pathData?.text ?? "");
          results.push({
            file: toProjectRelative(cwd, filePath),
            line: typeof data.line_number === "number" ? data.line_number : Number(data.line_number ?? 0),
            text: typeof data.lines === "object" && data.lines
              ? String((data.lines as Record<string, unknown>).text ?? "").trimEnd()
              : ""
          });
        }
      } catch {
        // Skip malformed JSON lines (should not happen with rg)
      }
    }

    return results.length > 0 ? results : null;
  } catch {
    // rg not installed, or pattern syntax incompatible → fall back to JS
    return null;
  }
}

// ── glob implementation ─────────────────────────────────────────────

function globToRegex(pattern: string): RegExp {
  // Normalize separators to forward slash for matching
  const normalized = pattern.replace(/\\/g, "/");

  let regexStr = "";
  let i = 0;
  while (i < normalized.length) {
    if (normalized[i] === "*" && normalized[i + 1] === "*") {
      // ** matches zero or more path segments
      if (normalized[i + 2] === "/") {
        regexStr += "(?:.*/)?";
        i += 3;
      } else if (i + 2 >= normalized.length) {
        regexStr += ".*";
        i += 2;
      } else {
        regexStr += ".*";
        i += 2;
      }
    } else if (normalized[i] === "*") {
      regexStr += "[^/]*";
      i += 1;
    } else if (normalized[i] === "?") {
      regexStr += "[^/]";
      i += 1;
    } else if (normalized[i] === ".") {
      regexStr += "\\.";
      i += 1;
    } else if (normalized[i] === ",") {
      // Allow comma-separated patterns like "*.ts,*.tsx"
      regexStr += "|";
      i += 1;
    } else if (/[.+^${}()|[\]\\]/.test(normalized[i])) {
      regexStr += "\\" + normalized[i];
      i += 1;
    } else if (normalized[i] === "/") {
      regexStr += "/";
      i += 1;
    } else {
      regexStr += normalized[i];
      i += 1;
    }
  }

  return new RegExp("^" + regexStr + "$", "i");
}

async function globSearch(
  cwd: string,
  root: string,
  pattern: string,
  maxResults: number
): Promise<string[]> {
  const commaPatterns = pattern.includes(",") ? pattern.split(",").map((p) => p.trim()).filter(Boolean) : [pattern];
  const regexes = (commaPatterns.length > 0 ? commaPatterns : [pattern]).map((p) => globToRegex(p));
  const results: string[] = [];
  const rootInfo = await stat(root).catch(() => null);
  if (!rootInfo) {
    return results;
  }

  async function walk(dir: string): Promise<void> {
    if (results.length >= maxResults) {
      return;
    }

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxResults || ignoredNames.has(entry.name)) {
        continue;
      }

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (entry.isFile()) {
        const relative = toProjectRelative(cwd, fullPath);
        if (regexes.some((r) => r.test(relative))) {
          results.push(relative);
        }
      }
    }
  }

  if (rootInfo.isDirectory()) {
    await walk(root);
  } else if (rootInfo.isFile()) {
    const relative = toProjectRelative(cwd, root);
    if (regexes.some((r) => r.test(relative))) {
      results.push(relative);
    }
  }

  return results;
}

// ── tree ─────────────────────────────────────────────────────────────

async function buildTree(cwd: string, dir: string, depth: number, prefix = ""): Promise<string[]> {
  const label = prefix === "" ? toProjectRelative(cwd, dir) : undefined;
  const lines = label ? [label] : [];
  if (depth < 0) {
    return lines;
  }

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return lines;
  }

  entries = entries
    .filter((entry) => !ignoredNames.has(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const marker = entry.isDirectory() ? "/" : "";
    lines.push(`${prefix}${entry.name}${marker}`);
    if (entry.isDirectory() && depth > 0) {
      const childLines = await buildTree(cwd, join(dir, entry.name), depth - 1, `${prefix}  `);
      lines.push(...childLines);
    }
  }

  return lines;
}

// ── searchText ──────────────────────────────────────────────────────

async function searchText(
  cwd: string,
  root: string,
  pattern: string,
  maxResults: number
): Promise<SearchResult[]> {
  // Try ripgrep first for native speed; fall back to JS walker if unavailable
  const rgResults = await tryRipgrepSearch(cwd, root, pattern, maxResults);
  if (rgResults !== null) {
    return rgResults;
  }

  return jsSearchText(cwd, root, pattern, maxResults);
}

async function jsSearchText(
  cwd: string,
  root: string,
  pattern: string,
  maxResults: number
): Promise<SearchResult[]> {
  const regex = new RegExp(pattern, "i");
  const results: SearchResult[] = [];

  async function searchFile(fullPath: string): Promise<void> {
    if (results.length >= maxResults) {
      return;
    }

    let info;
    try {
      info = await stat(fullPath);
    } catch {
      return;
    }

    if (info.size > 1024 * 1024) {
      return;
    }

    let content: string;
    try {
      content = await readFile(fullPath, "utf8");
    } catch {
      return;
    }

    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (regex.test(line)) {
        results.push({
          file: toProjectRelative(cwd, fullPath),
          line: index + 1,
          text: line.trim()
        });
        if (results.length >= maxResults) {
          return;
        }
      }
    }
  }

  async function walk(dir: string): Promise<void> {
    if (results.length >= maxResults) {
      return;
    }

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxResults || ignoredNames.has(entry.name)) {
        continue;
      }

      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      await searchFile(fullPath);
    }
  }

  let rootInfo;
  try {
    rootInfo = await stat(root);
  } catch {
    return results;
  }

  if (rootInfo.isDirectory()) {
    await walk(root);
  } else if (rootInfo.isFile()) {
    await searchFile(root);
  }

  return results;
}
