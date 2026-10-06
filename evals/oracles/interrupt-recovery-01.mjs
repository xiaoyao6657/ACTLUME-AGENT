import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export async function evaluate(workspace, evidence = {}) {
  try {
    const module = await import(`${pathToFileURL(resolve(workspace, "src/parser.js"))}?oracle=${Date.now()}`);
    assert.deepEqual(module.parseField("title:"), { key: "title", value: "" });
    assert.throws(() => module.parseField(":x"));
    if (evidence.interruptionInjected !== true || evidence.resumed !== true || evidence.sameSession !== true
      || evidence.sameTask !== true || evidence.runtimeTerminated !== true || evidence.duplicateEdits !== 0
      || evidence.checkPassed !== true || evidence.evidenceStatus !== "checks_passed") {
      return { verdict: "unknown", reason: "forced process termination, same-session resume, no duplicated write, and post-resume check evidence are required" };
    }
    return { verdict: "pass", checks: 7 };
  } catch (error) {
    return { verdict: "fail", reason: `validator error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function calibrate(workspace) {
  await writeFile(resolve(workspace, "src/parser.js"), `export function parseField(input) {\n  const match = /^([^:]+):([^:]*)$/.exec(input);\n  if (!match) throw new Error("invalid field");\n  return { key: match[1], value: match[2] };\n}\n`);
  return { interruptionInjected: true, resumed: true, sameSession: true, sameTask: true, runtimeTerminated: true, duplicateEdits: 0, checkPassed: true, evidenceStatus: "checks_passed" };
}
