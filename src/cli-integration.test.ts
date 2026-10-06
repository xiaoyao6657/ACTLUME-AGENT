import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

test("CLI help runs through the packaged bin entry", async () => {
  const result = await execFileAsync(process.execPath, [resolve(process.cwd(), "bin", "actlume.mjs"), "--help"], {
    cwd: process.cwd(),
    timeout: 30000
  });

  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /\/doctor/);
  assert.match(result.stdout, /\/compact/);
  assert.match(result.stdout, /--json/);
});

test("--json without a task is rejected before provider setup", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [resolve(process.cwd(), "bin", "actlume.mjs"), "--json"], {
      cwd: process.cwd(),
      timeout: 30000
    }),
    (error: unknown) => {
      const result = error as { code?: number; stderr?: string };
      assert.equal(result.code, 2);
      assert.match(result.stderr ?? "", /--json requires a task prompt/);
      return true;
    }
  );
});
