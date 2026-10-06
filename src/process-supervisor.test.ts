import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runShellCommand } from "./process-supervisor.js";

test("shell cancellation terminates a child process before its delayed side effect", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-process-tree-"));
  const marker = join(workspace, "late-marker.txt");
  const childScript = join(workspace, "child.js");
  const parentScript = join(workspace, "parent.js");
  const controller = new AbortController();
  try {
    await writeFile(childScript, `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"), 1400);\n`);
    await writeFile(parentScript, [
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, [process.argv[2]], { stdio: "ignore" });',
      'child.on("error", () => process.exitCode = 1);',
      'setTimeout(() => {}, 2200);'
    ].join("\n"));
    const command = `${quote(process.execPath)} ${quote(parentScript)} ${quote(childScript)}`;
    const timer = setTimeout(() => controller.abort(), 120);
    const startedAt = Date.now();
    const result = await runShellCommand({ command, cwd: workspace, timeoutMs: 5_000, signal: controller.signal });
    clearTimeout(timer);

    assert.equal(result.outcome, "cancelled");
    assert.equal(result.terminationConfirmed, true);
    assert.ok(Date.now() - startedAt < 1_000, `cancellation took ${Date.now() - startedAt}ms`);
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" });
  } finally {
    controller.abort();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an already-aborted signal never starts the command", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-process-preabort-"));
  const controller = new AbortController();
  controller.abort();
  try {
    const result = await runShellCommand({ command: "echo should-not-run", cwd: workspace, timeoutMs: 2_000, signal: controller.signal });
    assert.equal(result.outcome, "cancelled");
    assert.equal(result.terminationConfirmed, true);
    assert.equal(result.exitCode, null);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function quote(value: string): string {
  return process.platform === "win32" ? `"${value.replaceAll('"', '""')}"` : `'${value.replaceAll("'", "'\\''")}'`;
}
