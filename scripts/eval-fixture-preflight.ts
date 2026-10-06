import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type TaskManifest = {
  schemaVersion: 1;
  id: string;
  category: string;
  prompt: string;
  files: Record<string, string>;
  largeFiles?: Array<{ path: string; pattern: string; repetitions: number }>;
  requiredFiles: string[];
  oracleId: string;
};

type OracleResult = { verdict: "pass" | "fail" | "unknown"; reason?: string; checks?: number };
type Oracle = {
  evaluate: (workspace: string, evidence?: Record<string, unknown>) => Promise<OracleResult>;
  calibrate?: (workspace: string) => Promise<Record<string, unknown>>;
};

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(repositoryRoot, "evals", "fixtures");
const taskCards = await Promise.all(["dev-v1.md", "holdout-v1.md", "holdout-v2.md", "holdout-v3.md"].map((name) => readFile(join(repositoryRoot, "evals", "tasks", name), "utf8")));
const expectedIds = taskCards.flatMap((cards) => [...cards.matchAll(/^\| `([a-z0-9-]+)` \|/gm)]
  .map((match) => match[1]!)
  .filter((id) => id !== "parallel-research-01"));
const fixtureDirectories = await readdir(fixtureRoot, { withFileTypes: true });
const tempRoot = await mkdtemp(join(tmpdir(), "actlume-eval-fixtures-"));
const expectedBaselineVerdicts: Record<string, OracleResult["verdict"]> = {
  "short-regression-01": "fail",
  "long-context-01": "fail",
  "artifact-recall-01": "unknown",
  "memory-transfer-01": "fail",
  "stale-memory-01": "fail",
  "requirement-revision-01": "fail",
  "verification-claim-01": "fail",
  "interrupt-recovery-01": "fail",
  "guardrail-retry-01": "fail",
  "holdout-parser-boundary-01": "fail",
  "holdout-memory-transfer-01": "fail",
  "holdout-stale-memory-01": "fail",
  "holdout-honesty-01": "fail",
  "holdout-stale-build-01": "fail",
  "holdout-stale-config-01": "fail"
};

const report: Array<{ id: string; fixtureHash: string; baselineOracle: string; reason?: string }> = [];
try {
  const manifests = new Map<string, { path: string; manifest: TaskManifest }>();
  for (const directory of fixtureDirectories.filter((item) => item.isDirectory())) {
    const path = join(fixtureRoot, directory.name, "task.json");
    let manifest: TaskManifest;
    try { manifest = JSON.parse(await readFile(path, "utf8")) as TaskManifest; }
    catch (error) { throw new Error(`Invalid fixture manifest '${path}': ${(error as Error).message}`); }
    validateManifest(manifest, directory.name);
    if (manifests.has(manifest.id)) throw new Error(`Duplicate fixture id '${manifest.id}'.`);
    manifests.set(manifest.id, { path, manifest });
  }

  const missing = expectedIds.filter((id) => !manifests.has(id));
  const extra = [...manifests.keys()].filter((id) => !expectedIds.includes(id));
  if (missing.length || extra.length) throw new Error(`Fixture/task-card mismatch. Missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}.`);

  for (const id of expectedIds) {
    const item = manifests.get(id)!;
    const expected = expectedBaselineVerdicts[id];
    if (!expected) throw new Error(`No frozen baseline-oracle expectation for '${id}'.`);
    const oraclePath = join(repositoryRoot, "evals", "oracles", `${id}.mjs`);
    const oracle = await import(pathToFileURL(oraclePath).href) as Oracle;
    if (typeof oracle.evaluate !== "function") throw new Error(`Oracle '${id}' does not export evaluate(workspace, evidence).`);

    const workspace = join(tempRoot, id);
    await materialize(workspace, item.manifest);
    const result = await oracle.evaluate(workspace, {});
    if (!result || !["pass", "fail", "unknown"].includes(result.verdict)) {
      throw new Error(`Oracle '${id}' returned an invalid verdict.`);
    }
    if (result.verdict !== expected) {
      throw new Error(`Oracle '${id}' baseline calibration expected '${expected}', received '${result.verdict}': ${result.reason ?? "no reason supplied"}`);
    }
    if (typeof oracle.calibrate !== "function") throw new Error(`Oracle '${id}' has no positive reference calibration.`);
    const referenceEvidence = await oracle.calibrate(workspace);
    const calibrated = await oracle.evaluate(workspace, referenceEvidence);
    if (calibrated.verdict !== "pass") {
      throw new Error(`Oracle '${id}' reference calibration expected 'pass', received '${calibrated.verdict}': ${calibrated.reason ?? "no reason supplied"}`);
    }
    report.push({
      id,
      fixtureHash: `sha256:${createHash("sha256").update(canonicalJson(item.manifest)).digest("hex")}`,
      baselineOracle: result.verdict,
      referenceOracle: calibrated.verdict,
      ...(result.reason ? { reason: result.reason } : {})
    });
  }

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    dataClass: "fixture-oracle-preflight-only",
    qualityClaim: false,
    generatedAt: new Date().toISOString(),
    materializedTaskCount: report.length,
    tasks: report,
    limitation: "Checks frozen fixture coverage and each independent oracle against an unchanged baseline and a positive reference fixture. It does not run the agent or measure task quality."
  }, null, 2)}\n`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function validateManifest(value: TaskManifest, directoryName: string): void {
  if (!value || value.schemaVersion !== 1 || value.id !== directoryName || !value.prompt?.trim()
    || !value.category || !Array.isArray(value.requiredFiles) || value.requiredFiles.length === 0
    || !value.files || typeof value.files !== "object" || Array.isArray(value.files)
    || typeof value.oracleId !== "string" || value.oracleId !== `${value.id}-hidden-v1`) {
    throw new Error(`Unsupported or incomplete task manifest in fixture '${directoryName}'.`);
  }
  for (const path of [...Object.keys(value.files), ...(value.largeFiles ?? []).map((file) => file.path), ...value.requiredFiles]) {
    const normalized = path.replaceAll("\\", "/");
    if (!path || normalized.startsWith("/") || normalized.split("/").some((part) => part === "..") || path.includes("\\")) {
      throw new Error(`Unsafe fixture path '${path}' in '${directoryName}'.`);
    }
  }
  for (const required of value.requiredFiles) {
    if (!Object.hasOwn(value.files, required)) throw new Error(`Required fixture file '${required}' is not materialized in '${directoryName}'.`);
  }
  if (Object.values(value.files).some((contents) => typeof contents !== "string")) {
    throw new Error(`Fixture '${directoryName}' contains a non-string file payload.`);
  }
  if ((value.largeFiles ?? []).some((file) => typeof file.pattern !== "string"
    || !Number.isInteger(file.repetitions) || file.repetitions < 1 || file.repetitions > 100_000)) {
    throw new Error(`Fixture '${directoryName}' has an invalid generated large-file specification.`);
  }
}

async function materialize(workspace: string, manifest: TaskManifest): Promise<void> {
  for (const [path, contents] of Object.entries(manifest.files)) {
    const destination = resolve(workspace, path);
    const inside = relative(workspace, destination);
    if (inside === ".." || inside.startsWith(`..${sep}`)) throw new Error(`Fixture path escapes its temporary workspace: ${path}`);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents, "utf8");
  }
  for (const file of manifest.largeFiles ?? []) {
    const destination = resolve(workspace, file.path);
    const inside = relative(workspace, destination);
    if (inside === ".." || inside.startsWith(`..${sep}`)) throw new Error(`Generated fixture path escapes its temporary workspace: ${file.path}`);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.pattern.repeat(file.repetitions), "utf8");
  }
  for (const path of manifest.requiredFiles) {
    const destination = resolve(workspace, path);
    try { await readFile(destination); }
    catch { throw new Error(`Required file '${path}' was not materialized for '${manifest.id}'.`); }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right, "en"));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
