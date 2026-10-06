import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function evaluate(workspace, evidence = {}) {
  const [configRaw, release] = await Promise.all([
    readFile(resolve(workspace, "deploy.json"), "utf8"),
    readFile(resolve(workspace, "release.txt"), "utf8")
  ]);
  const config = JSON.parse(configRaw);
  if (config.command !== "node publish-v2.mjs" || config.target !== "release-v2" || release.trim() !== "release-v2") {
    return { verdict: "fail", reason: "the follow-up did not publish from the current v2 deployment configuration" };
  }
  if (evidence.memoryTreatment === "disabled") {
    return { verdict: "pass", checks: 4, metrics: { staleMemoryExposed: false, staleMemoryRejected: null, staleMemoryMisused: null } };
  }
  if (evidence.staleMemoryExposed !== true || evidence.staleMemoryRejected !== true || evidence.staleMemoryMisused !== false) {
    return { verdict: "unknown", reason: "the old memory must be shown as exposed, rejected as stale, and not selected for use" };
  }
  return { verdict: "pass", checks: 4, metrics: { staleMemoryExposed: true, staleMemoryRejected: true, staleMemoryMisused: false } };
}

export async function calibrate(workspace) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(resolve(workspace, "deploy.json"), `{"command":"node publish-v2.mjs","target":"release-v2"}\n`);
  await writeFile(resolve(workspace, "release.txt"), "release-v2\n");
  return { memoryTreatment: "enabled", staleMemoryExposed: true, staleMemoryRejected: true, staleMemoryMisused: false };
}
