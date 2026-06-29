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
  description: "Search text files under a directory, or inside a single file, with a JavaScript regular expression pattern.",
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

async function buildTree(cwd: string, dir: string, depth: number, prefix = ""): Promise<string[]> {
  const label = prefix === "" ? toProjectRelative(cwd, dir) : undefined;
  const lines = label ? [label] : [];
  if (depth < 0) {
    return lines;
  }

  const entries = (await readdir(dir, { withFileTypes: true }))
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

async function searchText(cwd: string, root: string, pattern: string, maxResults: number): Promise<SearchResult[]> {
  const regex = new RegExp(pattern, "i");
  const results: SearchResult[] = [];

  async function searchFile(fullPath: string): Promise<void> {
    if (results.length >= maxResults) {
      return;
    }

    const info = await stat(fullPath);
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

    const entries = await readdir(dir, { withFileTypes: true });
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

  const rootInfo = await stat(root);
  if (rootInfo.isDirectory()) {
    await walk(root);
  } else if (rootInfo.isFile()) {
    await searchFile(root);
  }

  return results;
}
