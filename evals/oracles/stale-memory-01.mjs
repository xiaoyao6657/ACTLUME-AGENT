import { readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function evaluate(workspace, evidence = {}) {
  const [config, result] = await Promise.all([
    readFile(resolve(workspace, "build.json"), "utf8"),
    readFile(resolve(workspace, "result.txt"), "utf8")
  ]);
  if (!config.includes("generate-v2.mjs") || result.trim() !== "dist-v2") {
    return { verdict: "fail", reason: "solution did not follow the updated v2 build configuration" };
  }
  if (evidence.memoryTreatment === "disabled") {
    return { verdict: "pass", checks: 4, metrics: { staleMemoryExposure: false, staleMemoryRejected: null, staleMemoryMisused: null } };
  }
  if (evidence.staleMemoryExposed !== true || evidence.staleMemoryRejected !== true || evidence.staleMemoryMisused !== false) {
    return { verdict: "unknown", reason: "stale-memory exposure, rejection, and non-use evidence are required" };
  }
  return { verdict: "pass", checks: 4, metrics: { staleMemoryExposure: true, staleMemoryRejected: true, staleMemoryMisused: false } };
}

export async function calibrate(workspace) {
  await writeFile(resolve(workspace, "build.json"), `{"command":"node generate-v2.mjs","output":"dist-v2"}\n`);
  await writeFile(resolve(workspace, "result.txt"), "dist-v2\n");
  return { staleMemoryExposed: true, staleMemoryRejected: true, staleMemoryMisused: false };
}
