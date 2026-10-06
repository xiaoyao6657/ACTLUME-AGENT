import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createIsolatedBenchmarkWorkspace } from "./benchmark-workspace.js";

test("benchmark cleanup only removes its unique temporary workspace", async () => {
  const project = await mkdtemp(join(tmpdir(), "actlume-project-"));
  const originalBenchmark = join(project, ".agent-benchmark");
  const isolated = await createIsolatedBenchmarkWorkspace();
  try {
    await mkdir(originalBenchmark, { recursive: true });
    await writeFile(join(originalBenchmark, "keep.json"), "{\"keep\":true}\n");
    await writeFile(join(isolated.path, "fixture.txt"), "temporary\n");
    await isolated.cleanup();
    await isolated.cleanup();

    assert.equal(await readFile(join(originalBenchmark, "keep.json"), "utf8"), "{\"keep\":true}\n");
    await assert.rejects(readFile(join(isolated.path, "fixture.txt"), "utf8"));
  } finally {
    await isolated.cleanup();
    await rm(project, { recursive: true, force: true });
  }
});
