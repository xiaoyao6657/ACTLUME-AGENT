import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";

export type ProjectLanguage = {
  name: string;
  files: number;
};

export type ProjectScan = {
  root: string;
  generatedAt: string;
  totals: {
    files: number;
    directories: number;
    skipped: number;
  };
  languages: ProjectLanguage[];
  keyFiles: string[];
  packageManager?: string;
  projectKinds: string[];
  scripts: Record<string, string>;
  suggestedChecks: string[];
  tree: string[];
  ignoredNames: string[];
  truncated: boolean;
};

export type ProjectScanOptions = {
  root?: string;
  maxDepth?: number;
  maxFiles?: number;
  memoryDir?: string;
  useCache?: boolean;
  forceRefresh?: boolean;
};

export type ProjectScanWithCache = {
  scan: ProjectScan;
  summary: string;
  cacheHit: boolean;
  cachePath?: string;
  summaryPath?: string;
  fingerprintHash: string;
};

type ProjectIndexCache = {
  version: 1;
  updatedAt: string;
  fingerprintHash: string;
  scan: ProjectScan;
  summary: string;
};

type ProjectFingerprint = {
  root: string;
  maxDepth: number;
  maxFiles: number;
  entries: ProjectFingerprintEntry[];
  truncated: boolean;
};

type ProjectFingerprintEntry = {
  path: string;
  type: "dir" | "file";
  size: number;
  mtimeMs: number;
};

const ignoredNames = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".agent-memory",
  ".agent-benchmark",
  ".next",
  ".turbo",
  ".cache"
];

const keyFileNames = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "tsconfig.json",
  "vite.config.ts",
  "vite.config.js",
  "next.config.js",
  "next.config.mjs",
  "eslint.config.js",
  "eslint.config.mjs",
  ".eslintrc",
  ".eslintrc.json",
  ".prettierrc",
  "README.md",
  "README.en.md",
  ".env.example",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "Makefile",
  "Dockerfile"
]);

const languageByExtension = new Map<string, string>([
  [".ts", "TypeScript"],
  [".tsx", "TypeScript React"],
  [".js", "JavaScript"],
  [".jsx", "JavaScript React"],
  [".mjs", "JavaScript"],
  [".cjs", "JavaScript"],
  [".json", "JSON"],
  [".md", "Markdown"],
  [".py", "Python"],
  [".rs", "Rust"],
  [".go", "Go"],
  [".java", "Java"],
  [".kt", "Kotlin"],
  [".cs", "C#"],
  [".html", "HTML"],
  [".css", "CSS"],
  [".scss", "SCSS"],
  [".vue", "Vue"],
  [".svelte", "Svelte"],
  [".yml", "YAML"],
  [".yaml", "YAML"],
  [".toml", "TOML"],
  [".sql", "SQL"],
  [".sh", "Shell"],
  [".ps1", "PowerShell"]
]);

export async function scanProject(cwd: string, options: ProjectScanOptions = {}): Promise<ProjectScan> {
  const root = resolve(options.root ?? cwd);
  const maxDepth = options.maxDepth ?? 3;
  const maxFiles = options.maxFiles ?? 300;
  const languageCounts = new Map<string, number>();
  const keyFiles: string[] = [];
  const tree: string[] = [toDisplayPath(cwd, root)];
  const state = {
    files: 0,
    directories: 0,
    skipped: 0,
    truncated: false
  };

  await walkProject({ cwd, root, dir: root, depth: 0, maxDepth, maxFiles, languageCounts, keyFiles, tree, state });

  const scripts = await readPackageScripts(root);
  const keyFileSet = new Set(keyFiles);

  return {
    root: toDisplayPath(cwd, root),
    generatedAt: new Date().toISOString(),
    totals: {
      files: state.files,
      directories: state.directories,
      skipped: state.skipped
    },
    languages: [...languageCounts.entries()]
      .map(([name, files]) => ({ name, files }))
      .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name)),
    keyFiles,
    packageManager: detectPackageManager(keyFileSet),
    projectKinds: detectProjectKinds(keyFileSet, languageCounts),
    scripts,
    suggestedChecks: suggestChecks(keyFileSet, scripts),
    tree,
    ignoredNames,
    truncated: state.truncated
  };
}

export async function scanProjectWithCache(cwd: string, options: ProjectScanOptions = {}): Promise<ProjectScanWithCache> {
  const root = resolve(options.root ?? cwd);
  const maxDepth = options.maxDepth ?? 3;
  const maxFiles = options.maxFiles ?? 300;
  const fingerprint = await buildProjectFingerprint(cwd, root, maxDepth, maxFiles);
  const fingerprintHash = hashJson(fingerprint);
  const memoryDir = options.memoryDir;
  const cachePath = memoryDir ? join(memoryDir, "project-index.json") : undefined;
  const summaryPath = memoryDir ? join(memoryDir, "project-summary.md") : undefined;

  if (cachePath && options.useCache !== false && !options.forceRefresh) {
    const cached = await readProjectIndexCache(cachePath);
    if (cached?.fingerprintHash === fingerprintHash) {
      await persistProjectIndex({ cachePath, summaryPath, cache: cached });
      return {
        scan: cached.scan,
        summary: cached.summary,
        cacheHit: true,
        cachePath,
        summaryPath,
        fingerprintHash
      };
    }
  }

  const scan = await scanProject(cwd, { root, maxDepth, maxFiles });
  const summary = formatProjectSummary(scan);
  const cache: ProjectIndexCache = {
    version: 1,
    updatedAt: new Date().toISOString(),
    fingerprintHash,
    scan,
    summary
  };
  if (cachePath) {
    await persistProjectIndex({ cachePath, summaryPath, cache });
  }

  return {
    scan,
    summary,
    cacheHit: false,
    cachePath,
    summaryPath,
    fingerprintHash
  };
}

export function formatProjectScan(scan: ProjectScan): string {
  const scripts = Object.entries(scan.scripts);
  const parts = [
    "Project scan:",
    `Root: ${scan.root}`,
    `Kinds: ${scan.projectKinds.length === 0 ? "unknown" : scan.projectKinds.join(", ")}`,
    `Package manager: ${scan.packageManager ?? "unknown"}`,
    `Totals: ${scan.totals.files} files, ${scan.totals.directories} directories, ${scan.totals.skipped} skipped`,
    `Languages: ${scan.languages.length === 0 ? "unknown" : scan.languages.map((item) => `${item.name}(${item.files})`).join(", ")}`,
    `Suggested checks: ${scan.suggestedChecks.length === 0 ? "none detected" : scan.suggestedChecks.join("; ")}`,
    `Scripts: ${scripts.length === 0 ? "none detected" : scripts.map(([name, command]) => `${name}: ${command}`).join("; ")}`,
    `Key files:\n${scan.keyFiles.length === 0 ? "none detected" : scan.keyFiles.map((file) => `- ${file}`).join("\n")}`,
    `Tree:\n${scan.tree.join("\n")}`,
    `Ignored names: ${scan.ignoredNames.join(", ")}`,
    `Truncated: ${scan.truncated}`
  ];

  return parts.join("\n");
}

export function formatProjectSummary(scan: ProjectScan): string {
  const scripts = Object.entries(scan.scripts);
  return [
    "# Project Summary",
    "",
    `Generated: ${scan.generatedAt}`,
    `Root: ${scan.root}`,
    "",
    "## Overview",
    "",
    `- Kinds: ${scan.projectKinds.length === 0 ? "unknown" : scan.projectKinds.join(", ")}`,
    `- Package manager: ${scan.packageManager ?? "unknown"}`,
    `- Files: ${scan.totals.files}`,
    `- Directories: ${scan.totals.directories}`,
    `- Skipped entries: ${scan.totals.skipped}`,
    `- Truncated: ${scan.truncated}`,
    "",
    "## Languages",
    "",
    scan.languages.length === 0 ? "- unknown" : scan.languages.map((item) => `- ${item.name}: ${item.files}`).join("\n"),
    "",
    "## Suggested Checks",
    "",
    scan.suggestedChecks.length === 0 ? "- none detected" : scan.suggestedChecks.map((item) => `- ${item}`).join("\n"),
    "",
    "## Scripts",
    "",
    scripts.length === 0 ? "- none detected" : scripts.map(([name, command]) => `- ${name}: ${command}`).join("\n"),
    "",
    "## Key Files",
    "",
    scan.keyFiles.length === 0 ? "- none detected" : scan.keyFiles.map((file) => `- ${file}`).join("\n"),
    "",
    "## Tree",
    "",
    "```text",
    scan.tree.join("\n"),
    "```",
    ""
  ].join("\n");
}

type WalkParams = {
  cwd: string;
  root: string;
  dir: string;
  depth: number;
  maxDepth: number;
  maxFiles: number;
  languageCounts: Map<string, number>;
  keyFiles: string[];
  tree: string[];
  state: {
    files: number;
    directories: number;
    skipped: number;
    truncated: boolean;
  };
};

async function walkProject(params: WalkParams): Promise<void> {
  if (params.depth > params.maxDepth || params.state.truncated) {
    return;
  }

  let entries;
  try {
    entries = await readdir(params.dir, { withFileTypes: true });
  } catch {
    params.state.skipped += 1;
    return;
  }

  const sorted = entries
    .filter((entry) => {
      if (ignoredNames.includes(entry.name)) {
        params.state.skipped += 1;
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) {
        return a.isDirectory() ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

  for (const entry of sorted) {
    if (params.state.files >= params.maxFiles) {
      params.state.truncated = true;
      return;
    }

    if (entry.isSymbolicLink()) {
      params.state.skipped += 1;
      continue;
    }

    const fullPath = join(params.dir, entry.name);
    const relPath = toDisplayPath(params.cwd, fullPath);
    const indent = "  ".repeat(params.depth + 1);

    if (entry.isDirectory()) {
      params.state.directories += 1;
      params.tree.push(`${indent}${entry.name}/`);
      await walkProject({ ...params, dir: fullPath, depth: params.depth + 1 });
      continue;
    }

    const info = await safeStat(fullPath);
    if (!info || Number(info.size) > 1024 * 1024) {
      params.state.skipped += 1;
      continue;
    }

    params.state.files += 1;
    params.tree.push(`${indent}${entry.name}`);
    collectLanguage(entry.name, params.languageCounts);
    if (isKeyFile(entry.name, relPath)) {
      params.keyFiles.push(relPath);
    }
  }
}

async function safeStat(path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

async function readProjectIndexCache(cachePath: string): Promise<ProjectIndexCache | undefined> {
  try {
    const raw = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as ProjectIndexCache;
    return parsed.version === 1 ? parsed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    return undefined;
  }
}

async function persistProjectIndex(params: {
  cachePath: string;
  summaryPath?: string;
  cache: ProjectIndexCache;
}): Promise<void> {
  await mkdir(dirname(params.cachePath), { recursive: true });
  await writeFile(params.cachePath, JSON.stringify(params.cache, null, 2), "utf8");
  if (params.summaryPath) {
    await mkdir(dirname(params.summaryPath), { recursive: true });
    await writeFile(params.summaryPath, params.cache.summary, "utf8");
  }
}

async function buildProjectFingerprint(
  cwd: string,
  root: string,
  maxDepth: number,
  maxFiles: number
): Promise<ProjectFingerprint> {
  const entries: ProjectFingerprintEntry[] = [];
  const state = { files: 0, truncated: false };
  await walkFingerprint({ cwd, dir: root, depth: 0, maxDepth, maxFiles, entries, state });
  return {
    root: toDisplayPath(cwd, root),
    maxDepth,
    maxFiles,
    entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
    truncated: state.truncated
  };
}

type FingerprintWalkParams = {
  cwd: string;
  dir: string;
  depth: number;
  maxDepth: number;
  maxFiles: number;
  entries: ProjectFingerprintEntry[];
  state: {
    files: number;
    truncated: boolean;
  };
};

async function walkFingerprint(params: FingerprintWalkParams): Promise<void> {
  if (params.depth > params.maxDepth || params.state.truncated) {
    return;
  }

  let entries;
  try {
    entries = await readdir(params.dir, { withFileTypes: true });
  } catch {
    return;
  }

  const sorted = entries
    .filter((entry) => !ignoredNames.includes(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of sorted) {
    if (params.state.files >= params.maxFiles) {
      params.state.truncated = true;
      return;
    }

    if (entry.isSymbolicLink()) {
      continue;
    }

    const fullPath = join(params.dir, entry.name);
    const info = await safeStat(fullPath);
    if (!info) {
      continue;
    }

    const relPath = toDisplayPath(params.cwd, fullPath);
    if (entry.isDirectory()) {
      params.entries.push({
        path: `${relPath}/`,
        type: "dir",
        size: 0,
        mtimeMs: Math.round(Number(info.mtimeMs))
      });
      await walkFingerprint({ ...params, dir: fullPath, depth: params.depth + 1 });
      continue;
    }

    params.state.files += 1;
    const shouldTrackFile = isKeyFile(entry.name, relPath) || languageByExtension.has(extname(entry.name).toLowerCase());
    if (shouldTrackFile) {
      params.entries.push({
        path: relPath,
        type: "file",
        size: Number(info.size),
        mtimeMs: Math.round(Number(info.mtimeMs))
      });
    }
  }
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function readPackageScripts(root: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(join(root, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== "object") {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed.scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
  } catch {
    return {};
  }
}

function collectLanguage(fileName: string, languageCounts: Map<string, number>): void {
  const language = languageByExtension.get(extname(fileName).toLowerCase());
  if (!language) {
    return;
  }
  languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
}

function isKeyFile(fileName: string, relPath: string): boolean {
  if (keyFileNames.has(fileName)) {
    return true;
  }
  return relPath.startsWith("src/") && ["main.ts", "index.ts", "app.ts", "server.ts"].includes(fileName);
}

function detectPackageManager(keyFiles: Set<string>): string | undefined {
  if (keyFiles.has("pnpm-lock.yaml")) {
    return "pnpm";
  }
  if (keyFiles.has("yarn.lock")) {
    return "yarn";
  }
  if (keyFiles.has("bun.lockb")) {
    return "bun";
  }
  if (keyFiles.has("package-lock.json") || keyFiles.has("package.json")) {
    return "npm";
  }
  return undefined;
}

function detectProjectKinds(keyFiles: Set<string>, languageCounts: Map<string, number>): string[] {
  const kinds = new Set<string>();
  if (keyFiles.has("package.json")) {
    kinds.add("Node.js");
  }
  if (keyFiles.has("tsconfig.json") || languageCounts.has("TypeScript") || languageCounts.has("TypeScript React")) {
    kinds.add("TypeScript");
  }
  if (keyFiles.has("pyproject.toml") || keyFiles.has("requirements.txt") || languageCounts.has("Python")) {
    kinds.add("Python");
  }
  if (keyFiles.has("Cargo.toml") || languageCounts.has("Rust")) {
    kinds.add("Rust");
  }
  if (keyFiles.has("go.mod") || languageCounts.has("Go")) {
    kinds.add("Go");
  }
  return [...kinds];
}

function suggestChecks(keyFiles: Set<string>, scripts: Record<string, string>): string[] {
  const checks: string[] = [];
  const packageManager = detectPackageManager(keyFiles) ?? "npm";
  const run = packageManager === "npm" ? "npm run" : `${packageManager} run`;

  for (const script of ["typecheck", "test", "lint", "build", "benchmark"]) {
    if (!(script in scripts)) {
      continue;
    }

    if (script === "test" && packageManager === "npm") {
      checks.push("npm test");
    } else {
      checks.push(`${run} ${script}`);
    }
  }

  if (keyFiles.has("pyproject.toml")) {
    checks.push("pytest");
  }
  if (keyFiles.has("Cargo.toml")) {
    checks.push("cargo test");
  }
  if (keyFiles.has("go.mod")) {
    checks.push("go test ./...");
  }

  return checks;
}

function toDisplayPath(cwd: string, absolutePath: string): string {
  const rel = relative(resolve(cwd), absolutePath);
  return rel === "" ? "." : rel.replaceAll("\\", "/");
}
