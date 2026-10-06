import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readArtifactTool } from "./artifact.js";
import { defaultSecurityPolicy } from "../security.js";

test("readArtifact accepts artifacts inside memoryDir and rejects paths outside its root", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "actlume-artifact-"));
  const outside = join(memoryDir, "private.txt");
  const artifact = join(memoryDir, "artifacts", "run-1", "001-readFile.txt");
  await mkdir(join(memoryDir, "artifacts", "run-1"), { recursive: true });
  await writeFile(outside, "private");
  await writeFile(artifact, "full output");
  const ctx = {
    cwd: memoryDir,
    memoryDir,
    readonly: true,
    runId: "run-1",
    permissionMode: "plan" as const,
    securityPolicy: defaultSecurityPolicy
  };
  try {
    // Windows' extended-length path namespace is a valid spelling of the same file,
    // but lexical path comparison treats it as a different root from realpath().
    const artifactInputPath = process.platform === "win32" ? "\\\\?\\" + artifact : artifact;
    const result = await readArtifactTool.run({ path: artifactInputPath, limit: 5 }, ctx);
    assert.equal(result.ok, true);
    if (result.ok) assert.match(result.content, /full /);
    const next = await readArtifactTool.run({ path: artifactInputPath, offset: 5 }, ctx);
    assert.equal(next.ok, true);
    if (next.ok) assert.match(next.content, /output/);

    const denied = await readArtifactTool.run({ path: outside }, ctx);
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.errorCode, "ARTIFACT_PATH_OUTSIDE_ROOT");

    const missing = await readArtifactTool.run({ path: resolve(memoryDir, "artifacts", "missing.txt") }, ctx);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.errorCode, "ARTIFACT_NOT_FOUND");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
