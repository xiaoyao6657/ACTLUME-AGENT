import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { platform, arch } from "node:os";
import { buildSkillDescriptions } from "./skills.js";
import { describeSubAgents } from "./subagent.js";

const includeRegex = /^@(\.\/[^\s]+|~\/[^\s]+|\/[^\s]+)$/gm;
const maxIncludeDepth = 5;

export function buildWorkspacePromptContext(cwd: string): string {
  const sections = [
    buildEnvironmentSection(cwd),
    getGitContext(cwd),
    loadWorkspaceInstructions(cwd),
    loadRules(cwd),
    buildSkillDescriptions(cwd),
    describeSubAgents()
  ].filter(Boolean);

  return sections.length > 0 ? `Workspace prompt context:\n${sections.join("\n\n")}` : "";
}

export function resolveIncludes(
  content: string,
  basePath: string,
  visited: Set<string> = new Set(),
  depth = 0
): string {
  if (depth >= maxIncludeDepth) {
    return content;
  }

  return content.replace(includeRegex, (_match, rawPath: string) => {
    const filePath = resolveIncludedPath(basePath, rawPath);
    if (visited.has(filePath)) {
      return `<!-- circular include: ${rawPath} -->`;
    }
    if (!existsSync(filePath)) {
      return `<!-- include not found: ${rawPath} -->`;
    }
    try {
      if (!statSync(filePath).isFile()) {
        return `<!-- include is not a file: ${rawPath} -->`;
      }
      visited.add(filePath);
      const included = readFileSync(filePath, "utf8");
      return resolveIncludes(included, dirname(filePath), visited, depth + 1);
    } catch {
      return `<!-- include read failed: ${rawPath} -->`;
    }
  });
}

function buildEnvironmentSection(cwd: string): string {
  const shell = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : process.env.SHELL ?? "/bin/sh";
  return [
    "## Environment",
    `Working directory: ${cwd}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    `Platform: ${platform()} ${arch()}`,
    `Shell: ${shell}`
  ].join("\n");
}

function loadWorkspaceInstructions(cwd: string): string {
  const files = findInstructionFiles(cwd);
  if (files.length === 0) {
    return "";
  }
  const parts = files.map((file) => {
    const raw = readFileSync(file, "utf8");
    return `<!-- ${file} -->\n${resolveIncludes(raw, dirname(file))}`;
  });
  return `## Workspace Instructions\n${parts.join("\n\n---\n\n")}`;
}

function findInstructionFiles(cwd: string): string[] {
  const dirs: string[] = [];
  let current = resolve(cwd);
  while (true) {
    dirs.unshift(current);
    const parent = resolve(current, "..");
    if (parent === current) {
      break;
    }
    current = parent;
  }

  const files: string[] = [];
  for (const dir of dirs) {
    for (const name of ["ACTLUME.md", "CLAUDE.md"]) {
      const file = join(dir, name);
      if (existsSync(file)) {
        files.push(file);
      }
    }
  }
  return files;
}

function loadRules(cwd: string): string {
  const rulesDir = join(cwd, ".actlume", "rules");
  if (!existsSync(rulesDir)) {
    return "";
  }
  const files = readdirSync(rulesDir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => join(rulesDir, file))
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
  if (files.length === 0) {
    return "";
  }
  const parts = files.map((file) => `<!-- rule: ${file} -->\n${resolveIncludes(readFileSync(file, "utf8"), dirname(file))}`);
  return `## ACTLUME Rules\n${parts.join("\n\n")}`;
}

function getGitContext(cwd: string): string {
  try {
    const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const status = git(cwd, ["status", "--short"]);
    const recentCommits = git(cwd, ["log", "--oneline", "-5"]);
    const lines = ["## Git Context", `Branch: ${branch || "<unknown>"}`];
    if (recentCommits) {
      lines.push(`Recent commits:\n${recentCommits}`);
    }
    if (status) {
      lines.push(`Status:\n${status}`);
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

function resolveIncludedPath(basePath: string, rawPath: string): string {
  if (rawPath.startsWith("~/")) {
    return resolve(homedir(), rawPath.slice(2));
  }
  if (rawPath.startsWith("/")) {
    return resolve(rawPath);
  }
  return resolve(basePath, rawPath);
}
