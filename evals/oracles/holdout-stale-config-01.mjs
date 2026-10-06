import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function evaluate(workspace, evidence = {}) {
  const config = JSON.parse(await readFile(resolve(workspace, "artifact.json"), "utf8"));
  const artifact = await readFile(resolve(workspace, "dist/release.txt"), "utf8");
  if (config.target !== "release-v2" || config.output !== "dist/release.txt" || artifact.trim() !== "release-v2") {
    return { verdict: "fail", reason: "the final artifact does not match the current release-v2 configuration" };
  }
  if (evidence.memoryTreatment === "disabled") {
    return { verdict: "pass", checks: 4, metrics: { staleMemoryExposed: false, staleMemoryRejected: null, staleMemoryMisused: null } };
  }
  if (evidence.staleMemoryExposed !== true || evidence.staleMemoryRejected !== true || evidence.staleMemoryMisused !== false) {
    return { verdict: "unknown", reason: "the changed artifact.json memory must be shown as exposed, rejected, and not used" };
  }
  return { verdict: "pass", checks: 4, metrics: { staleMemoryExposed: true, staleMemoryRejected: true, staleMemoryMisused: false } };
}

export async function calibrate(workspace) {
  await writeFile(resolve(workspace, "artifact.json"), `{"target":"release-v2","output":"dist/release.txt"}\n`);
  await writeFile(resolve(workspace, "dist/release.txt"), "release-v2\n");
  return { memoryTreatment: "enabled", staleMemoryExposed: true, staleMemoryRejected: true, staleMemoryMisused: false };
}
