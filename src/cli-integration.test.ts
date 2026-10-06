import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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

test("explicit process provider settings take precedence over values loaded from .env", async () => {
  const root = await mkdtemp(join(tmpdir(), "actlume-dotenv-precedence-"));
  const home = join(root, "home");
  const mcpConfig = join(root, "mcp-empty.json");
  await mkdir(home, { recursive: true });
  await writeFile(mcpConfig, '{"servers":{}}\n', "utf8");
  try {
    const result = await execFileAsync(process.execPath, [
      "--import", pathToFileURL(resolve(process.cwd(), "node_modules", "tsx", "dist", "loader.mjs")).href,
      resolve(process.cwd(), "src", "main.ts"), "--doctor"
    ], {
      cwd: root,
      env: {
        ...process.env,
        ACTLUME_HOME: home,
        AGENT_WORKSPACE: root,
        AGENT_MCP_CONFIG: mcpConfig,
        OPENAI_API_KEY: "dotenv-precedence-test-key",
        OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
        OPENAI_MODEL: "actlume-dotenv-precedence-test"
      },
      timeout: 30_000,
      windowsHide: true
    });
    assert.match(result.stdout, /Model configuration: actlume-dotenv-precedence-test/);
    assert.match(result.stdout, /endpoint http:\/\/127\.0\.0\.1:9\/v1/);
    assert.doesNotMatch(result.stdout, /dotenv-precedence-test-key/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
