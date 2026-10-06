import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export async function evaluate(workspace, evidence = {}) {
  try {
    const module = await import(`${pathToFileURL(resolve(workspace, "src/cache.js"))}?oracle=${Date.now()}`);
    assert.equal(module.normalizeCacheKey("  User:42 "), "user:42");
    assert.equal(module.normalizeCacheKey("PI"), "pi");
    if (evidence.commandVerified !== true || evidence.command !== "npm test") {
      return { verdict: "unknown", reason: "the exact fixture test command must be independently verified" };
    }
    return {
      verdict: "pass",
      checks: 4,
      metrics: {
        verifiedMemoryProvenance: evidence.verifiedMemoryProvenance === true,
        memorySelectedInFreshSession: evidence.memorySelectedInFreshSession === true
      }
    };
  } catch (error) {
    return { verdict: "fail", reason: `cache-key validator failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function calibrate(workspace) {
  await writeFile(resolve(workspace, "src/cache.js"), `export function normalizeCacheKey(value) {\n  return value.trim().toLowerCase();\n}\n`);
  return { commandVerified: true, command: "npm test", verifiedMemoryProvenance: true, memorySelectedInFreshSession: true };
}
