import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type EvalSmokeOverlay = {
  source: "smoke-reference-check" | "fixture-test-check";
  checkConfig: {
    schemaVersion: 1;
    checks: Array<{
      id: string; command: string; cwd: string; kind: "test"; required: true;
      scopePaths: string[]; requiredFiles: string[]; environmentFiles: string[]; environmentKeys: string[];
    }>;
  };
  testSource?: string;
};

export function createEvalSmokeOverlay(taskId: string, files: Record<string, string> = {}): EvalSmokeOverlay | undefined {
  if (taskId === "short-regression-01") return {
    source: "smoke-reference-check",
    checkConfig: {
      schemaVersion: 1,
      checks: [{
        id: "real-model-smoke-short-regression",
        command: "node eval-smoke-check.mjs",
        cwd: ".",
        kind: "test",
        required: true,
        scopePaths: ["parser.js"],
        requiredFiles: ["parser.js", "eval-smoke-check.mjs"],
        environmentFiles: ["package.json", "eval-smoke-check.mjs"],
        environmentKeys: []
      }]
    },
    testSource: [
      'import assert from "node:assert/strict";',
      'import { parseOptionalField } from "./parser.js";',
      'assert.deepEqual(parseOptionalField("title:"), { key: "title", value: "" });',
      'assert.deepEqual(parseOptionalField("title:Actlume"), { key: "title", value: "Actlume" });',
      'for (const input of [":empty", "title:a:b", "title"]) assert.throws(() => parseOptionalField(input));',
      ""
      ].join("\n")
  };

  if (files[".actlume/checks.json"] || typeof files["test.mjs"] !== "string") return undefined;
  let testCommand = "node test.mjs";
  try {
    const packageJson = JSON.parse(files["package.json"] ?? "{}") as { scripts?: Record<string, unknown> };
    if (packageJson.scripts?.test === "node test.mjs") testCommand = "npm test";
  } catch {
    throw new Error(`Eval fixture '${taskId}' has an invalid package.json.`);
  }
  const sourcePaths = Object.keys(files).filter((path) => /\.(?:[cm]?js|tsx?|py)$/.test(path));
  if (sourcePaths.length === 0) return undefined;
  const requiredFiles = [...new Set(["package.json", "test.mjs", ...sourcePaths])];
  return {
    source: "fixture-test-check",
    checkConfig: {
      schemaVersion: 1,
      checks: [{
        id: `real-model-smoke-${taskId}`,
        command: testCommand,
        cwd: ".",
        kind: "test",
        required: true,
        scopePaths: sourcePaths,
        requiredFiles,
        environmentFiles: ["package.json", "test.mjs"],
        environmentKeys: []
      }]
    }
  };
}

export async function materializeEvalSmokeOverlay(workspace: string, taskId: string, files: Record<string, string> = {}): Promise<EvalSmokeOverlay | undefined> {
  const overlay = createEvalSmokeOverlay(taskId, files);
  if (!overlay) return undefined;
  await mkdir(join(workspace, ".actlume"), { recursive: true });
  await writeFile(join(workspace, ".actlume", "checks.json"), `${JSON.stringify(overlay.checkConfig, null, 2)}\n`, "utf8");
  if (overlay.testSource) await writeFile(join(workspace, "eval-smoke-check.mjs"), overlay.testSource, "utf8");
  return overlay;
}
