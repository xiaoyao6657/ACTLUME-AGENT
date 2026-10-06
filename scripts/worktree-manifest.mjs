#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const raw = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true
});
const changed = parseStatus(raw);
const candidates = changed
  .map((path) => ({ path, absolute: resolve(root, path) }))
  .filter(({ path, absolute }) => isManifestInput(path) && isWithinRoot(root, absolute))
  .map(({ path, absolute }) => ({ path: path.replaceAll("\\", "/"), sha256: hashPath(absolute) }))
  .filter((item) => item.sha256 !== undefined)
  .sort((a, b) => a.path.localeCompare(b.path, "en"));

const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
const branch = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
const candidateSha256 = createHash("sha256")
  .update(candidates.map(({ path, sha256 }) => `${path}\0${sha256}\n`).join(""))
  .digest("hex");

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  head,
  branch,
  node: process.versions.node,
  changedProductionInputs: candidates.length,
  candidateSha256,
  inputs: candidates
}, null, 2)}\n`);

function parseStatus(value) {
  const records = value.split("\0");
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (path) paths.push(path);
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return paths;
}

function isManifestInput(path) {
  if (path === "scripts/worktree-manifest.mjs") return false;
  return path.startsWith("src/")
    || path.startsWith("scripts/")
    || path.startsWith("evals/")
    || path.startsWith(".github/workflows/")
    || path.startsWith("bin/")
    || path.startsWith(".actlume/")
    || path.startsWith("config/")
    || ["package.json", "package-lock.json", "README.md", "README.en.md", "CHANGELOG.md", "tsconfig.json"].includes(path);
}

function isWithinRoot(base, path) {
  const relativePath = relative(base, path);
  return relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

function hashPath(path) {
  try {
    const stat = lstatSync(path);
    const bytes = stat.isSymbolicLink() ? Buffer.from(`symlink:${readlinkSync(path)}`) : readFileSync(path);
    return createHash("sha256").update(bytes).digest("hex");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
