import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function evaluate(workspace, evidence = {}) {
  try {
    const module = await import(`${pathToFileURL(resolve(workspace, "src/labels.js"))}?oracle=${Date.now()}`);
    const legacy = module.normalizeLabel({ kind: "LEGACY", label: "OldCase" });
    const current = module.normalizeLabel({ kind: "CURRENT", label: "NewCase" });
    if (legacy !== "OldCase" || current !== "newcase") return { verdict: "fail", reason: "final implementation does not satisfy the revised requirement" };
    if (evidence.requirementRevision !== 2 || evidence.sameTask !== true) {
      return { verdict: "unknown", reason: "same-task requirement revision evidence is required" };
    }
    return { verdict: "pass", checks: 3 };
  } catch (error) {
    return { verdict: "fail", reason: `validator error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function calibrate(workspace) {
  await writeFile(resolve(workspace, "src/labels.js"), `export function normalizeLabel(record) {\n  return record.kind === "LEGACY" ? record.label : record.label.toLowerCase();\n}\n`);
  return { requirementRevision: 2, sameTask: true };
}
