import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadCheckSpecs, matchCheckSpec } from "./verification.js";
import { materializeEvalSmokeOverlay } from "../scripts/eval-smoke-overlay.js";

test("real-model smoke overlay provides a scoped CheckSpec that fails baseline and passes the reference edit", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-smoke-overlay-"));
  try {
    await mkdir(join(workspace, ".actlume"), { recursive: true });
    await writeFile(join(workspace, "package.json"), '{"type":"module"}\n', "utf8");
    await writeFile(join(workspace, "parser.js"), 'export function parseOptionalField(input) { const match = /^([^:]+):([^:]+)$/.exec(input); if (!match) throw new Error("invalid field"); return { key: match[1], value: match[2] }; }\n', "utf8");
    const overlay = await materializeEvalSmokeOverlay(workspace, "short-regression-01");
    assert.ok(overlay);
    const specs = await loadCheckSpecs(workspace);
    assert.equal(specs.length, 1);
    assert.deepEqual(matchCheckSpec(workspace, specs, "node eval-smoke-check.mjs", workspace)?.requiredFiles, ["parser.js", "eval-smoke-check.mjs"]);
    assert.throws(() => execFileSync("node", ["eval-smoke-check.mjs"], { cwd: workspace, windowsHide: true, stdio: "ignore" }));
    await writeFile(join(workspace, "parser.js"), 'export function parseOptionalField(input) { const match = /^([^:]+):([^:]*)$/.exec(input); if (!match) throw new Error("invalid field"); return { key: match[1], value: match[2] }; }\n', "utf8");
    execFileSync("node", ["eval-smoke-check.mjs"], { cwd: workspace, windowsHide: true, stdio: "ignore" });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("fixture test scripts become exact task-scoped CheckSpecs without replacing fixture checks", async () => {
  const workspace = resolve(tmpdir(), "not-created");
  const files = {
    "package.json": '{"type":"module"}\n',
    "src/config.js": "export const enabled = false;\n",
    "test.mjs": "import assert from 'node:assert/strict';\n"
  };
  const overlay = await materializeEvalSmokeOverlay(workspace, "long-context-01", files);
  assert.equal(overlay?.source, "fixture-test-check");
  assert.equal(overlay?.checkConfig.checks[0]?.command, "node test.mjs");
  assert.deepEqual(overlay?.checkConfig.checks[0]?.scopePaths, ["src/config.js", "test.mjs"]);
  assert.equal(await materializeEvalSmokeOverlay(workspace, "verification-claim-01", {
    ...files,
    ".actlume/checks.json": '{"schemaVersion":1,"checks":[]}\n'
  }), undefined);
  assert.equal(await materializeEvalSmokeOverlay(workspace, "artifact-recall-01", {
    "package.json": '{"type":"module"}\n',
    "README.md": "A lookup fixture without a runnable test.\n"
  }), undefined);
});
