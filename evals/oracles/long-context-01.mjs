import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function evaluate(workspace) {
  try {
    const module = await import(`${pathToFileURL(resolve(workspace, "src/config.js"))}?oracle=${Date.now()}`);
    if (module.defaults.cacheEnabled !== true) return { verdict: "fail", reason: "cache remains disabled by default" };
    if (!module.isCacheFresh(999999, 0)) return { verdict: "fail", reason: "zero TTL compatibility behavior changed" };
    if (!module.isCacheFresh(10, 20) || module.isCacheFresh(20, 20)) return { verdict: "fail", reason: "positive TTL boundary regressed" };
    return { verdict: "pass", checks: 4 };
  } catch (error) {
    return { verdict: "fail", reason: `validator error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function calibrate(workspace) {
  await writeFile(resolve(workspace, "src/config.js"), `export const defaults = { cacheEnabled: true, cacheTtlMs: 0 };\nexport function isCacheFresh(ageMs, ttlMs = defaults.cacheTtlMs) {\n  return ttlMs === 0 || ageMs < ttlMs;\n}\n`);
  return {};
}
