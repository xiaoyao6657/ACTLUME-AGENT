import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export async function evaluate(workspace, evidence = {}) {
  try {
    const module = await import(`${pathToFileURL(resolve(workspace, "src/tag.js"))}?oracle=${Date.now()}`);
    assert.equal(module.normalizeTag(" Actlume "), "actlume");
    assert.equal(module.normalizeTag("Pi Agent"), "pi agent");
    assert.equal(typeof module.normalizeTag(""), "string");
    if (!evidence.commandVerified || evidence.command !== "npm test") {
      return { verdict: "unknown", reason: "the exact frozen test command must pass before the follow-up phase" };
    }
    return {
      verdict: "pass",
      checks: 5,
      metrics: {
        verifiedMemoryProvenance: evidence.verifiedMemoryProvenance === true,
        memorySelectedInFreshSession: evidence.memorySelectedInFreshSession === true
      }
    };
  } catch (error) {
    return { verdict: "fail", reason: `validator error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function calibrate(workspace) {
  await writeFile(resolve(workspace, "src/tag.js"), `export function normalizeTag(value) {\n  return value.trim().toLowerCase();\n}\n`);
  return { commandVerified: true, command: "npm test", memorySelectedInFreshSession: true };
}
