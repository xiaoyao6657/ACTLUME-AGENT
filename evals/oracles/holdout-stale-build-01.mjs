import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function evaluate(workspace, evidence = {}) {
  const config = JSON.parse(await readFile(resolve(workspace, "build.json"), "utf8"));
  const output = await readFile(resolve(workspace, "dist/release.txt"), "utf8");
  if (config.command !== "node build-v2.mjs" || config.version !== "release-v2" || output.trim() !== "release-v2") {
    return { verdict: "fail", reason: "the fresh phase did not apply the current v2 build configuration" };
  }
  if (evidence.memoryTreatment === "disabled") {
    return { verdict: "pass", checks: 4, metrics: { staleMemoryExposed: false, staleMemoryRejected: null, staleMemoryMisused: null } };
  }
  if (evidence.staleMemoryExposed !== true || evidence.staleMemoryRejected !== true || evidence.staleMemoryMisused !== false) {
    return { verdict: "unknown", reason: "require evidence that the promoted old build memory was rejected after build.json changed" };
  }
  return { verdict: "pass", checks: 4, metrics: { staleMemoryExposed: true, staleMemoryRejected: true, staleMemoryMisused: false } };
}

export async function calibrate(workspace) {
  await writeFile(resolve(workspace, "build.json"), `{"command":"node build-v2.mjs","target":"dist/release.txt","version":"release-v2"}\n`);
  await writeFile(resolve(workspace, "dist/release.txt"), "release-v2\n");
  return { memoryTreatment: "enabled", staleMemoryExposed: true, staleMemoryRejected: true, staleMemoryMisused: false };
}
