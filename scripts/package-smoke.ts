import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCliPath = process.env.npm_execpath;
const smokeRoot = await mkdtemp(join(tmpdir(), "actlume-package-smoke-"));
const packDirectory = join(smokeRoot, "pack");
const consumerDirectory = join(smokeRoot, "consumer");
const reportDirectory = resolve(packageRoot, ".agent-benchmark", "package-smoke");
const reportPath = join(reportDirectory, `smoke-${new Date().toISOString().replaceAll(":", "-")}.json`);

await mkdir(packDirectory, { recursive: true });
await mkdir(consumerDirectory, { recursive: true });
await mkdir(reportDirectory, { recursive: true });

let provider: Awaited<ReturnType<typeof startMockProvider>> | undefined;
let report: Record<string, unknown>;
try {
  if (!npmCliPath) throw new Error("Run the package smoke through npm so npm_execpath is available.");
  const packed = await execFileAsync(process.execPath, [npmCliPath, "pack", "--ignore-scripts", "--json", "--pack-destination", packDirectory], {
    cwd: packageRoot,
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  });
  const packResult = JSON.parse(packed.stdout) as Array<{ filename: string; size: number; unpackedSize: number }>;
  const tarball = join(packDirectory, packResult[0]?.filename ?? "");
  if (!packResult[0]?.filename) throw new Error("npm pack did not report a tarball.");

  const install = await execFileAsync(process.execPath, [npmCliPath, "install",
    "--prefix", consumerDirectory, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund",
    "--prefer-offline", "--fetch-timeout=30000", "--fetch-retries=1", tarball
  ], { cwd: consumerDirectory, timeout: 300_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  const installedRoot = join(consumerDirectory, "node_modules", "actlume");
  const entry = join(installedRoot, "bin", "actlume.mjs");
  const helpStartedAt = Date.now();
  const help = await execFileAsync(process.execPath, [entry, "--help"], {
    cwd: consumerDirectory,
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024
  });
  const helpDurationMs = Date.now() - helpStartedAt;
  if (!help.stdout.includes("--json") || !help.stdout.includes("--doctor")) throw new Error("Installed CLI help is missing the current command surface.");

  provider = await startMockProvider();
  const workspace = join(smokeRoot, "workspace");
  await mkdir(workspace, { recursive: true });
  const env = isolatedMockEnvironment({
    AGENT_WORKSPACE: workspace,
    AGENT_MEMORY_DIR: ".agent-memory",
    OPENAI_BASE_URL: provider.baseURL,
    OPENAI_API_KEY: "package-smoke-key",
    OPENAI_MODEL: "package-smoke-model",
    PI_OFFLINE: "1",
    ACTLUME_HOME: join(smokeRoot, "actlume-home"),
    PI_CODING_AGENT_DIR: join(smokeRoot, "pi-home")
  });
  const firstRun = await execFileAsync(process.execPath, [entry, "--json", "Reply with a short smoke-test acknowledgment."], {
    cwd: workspace,
    env,
    timeout: 90_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  });
  const firstResult = parseJsonResult(firstRun.stdout);
  if (firstResult.runtimeStatus !== "completed" || typeof firstResult.sessionId !== "string") {
    throw new Error(`Installed headless task did not complete: ${JSON.stringify(firstResult)}`);
  }
  const resumed = await execFileAsync(process.execPath, [entry, "--resume", firstResult.sessionId, "--json", "Continue with one more brief acknowledgment."], {
    cwd: workspace,
    env,
    timeout: 90_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  });
  const resumedResult = parseJsonResult(resumed.stdout);
  if (resumedResult.runtimeStatus !== "completed" || resumedResult.sessionId !== firstResult.sessionId) {
    throw new Error(`Installed CLI could not resume the prior Pi session: ${JSON.stringify(resumedResult)}`);
  }

  const protocolOutput = join(smokeRoot, "protocol-report.json");
  const localTsx = join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const protocolScript = join(installedRoot, "scripts", "eval-protocol-smoke.ts");
  const protocol = await execFileAsync(process.execPath, [localTsx, protocolScript, "--out", protocolOutput], {
    cwd: consumerDirectory,
    env: isolatedMockEnvironment({
      ACTLUME_HOME: join(smokeRoot, "actlume-home"),
      PI_CODING_AGENT_DIR: join(smokeRoot, "pi-home"),
      PI_OFFLINE: "1"
    }),
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  });
  const protocolResult = JSON.parse(await readFile(protocolOutput, "utf8")) as {
    dataClass?: string;
    runtime?: { runtimeStatus?: string; requestedToolCalls?: number; executedToolCalls?: number };
    oracle?: { verdict?: string };
  };
  if (protocolResult.dataClass !== "protocol-validation-only"
    || protocolResult.runtime?.runtimeStatus !== "completed"
    || protocolResult.oracle?.verdict !== "pass"
    || !protocolResult.runtime.executedToolCalls) {
    throw new Error(`Packaged protocol runner did not exercise Actlume tools and the hidden oracle: ${JSON.stringify(protocolResult)}`);
  }

  report = {
    schemaVersion: 1,
    status: "passed",
    generatedAt: new Date().toISOString(),
    package: { filename: packResult[0].filename, size: packResult[0].size, unpackedSize: packResult[0].unpackedSize },
    installation: { command: "npm install --omit=dev <packed-tarball>", stdout: install.stdout.trim() },
    help: { exitCode: 0, includesJson: true, includesDoctor: true, durationMs: helpDurationMs },
    headless: firstResult,
    resume: resumedResult,
    providerRequests: provider.requests,
    packagedProtocol: {
      runner: "evals/fixtures/short-regression-01",
      dataClass: protocolResult.dataClass,
      runtimeStatus: protocolResult.runtime?.runtimeStatus,
      executedToolCalls: protocolResult.runtime?.executedToolCalls,
      oracleVerdict: protocolResult.oracle?.verdict,
      stdout: protocol.stdout.trim()
    },
    limitation: "Uses deterministic local providers; this validates the npm artifact/runtime protocol, not model task quality."
  };
} catch (error) {
  const processError = error as Error & { stdout?: string; stderr?: string; code?: string | number | null; signal?: string | null; killed?: boolean; cmd?: string };
  report = {
    schemaVersion: 1,
    status: "failed",
    generatedAt: new Date().toISOString(),
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    exitCode: processError.code,
    signal: processError.signal,
    killed: processError.killed,
    command: processError.cmd,
    stdout: processError.stdout?.slice(-12_000),
    stderr: processError.stderr?.slice(-12_000),
    smokeRoot
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stderr.write(`${JSON.stringify({ reportPath, status: report.status, error: report.error })}\n`);
  process.exitCode = 1;
} finally {
  await provider?.close();
  await rm(smokeRoot, { recursive: true, force: true });
}

if (report.status === "passed") {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ reportPath, status: report.status, package: report.package, resume: "passed", packagedProtocol: report.packagedProtocol })}\n`);
}

function parseJsonResult(raw: string): Record<string, unknown> {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  for (const line of [...lines].reverse()) {
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value === "object" && value !== null && "runtimeStatus" in value) return value as Record<string, unknown>;
    } catch {
      // Ignore non-JSON CLI lines and find the structured result.
    }
  }
  throw new Error("Installed --json invocation did not emit a structured result line.");
}

function isolatedMockEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const key of [
    "ACTLUME_OTEL_EXPORTER_OTLP_ENDPOINT",
    "ACTLUME_OTEL_EXPORTER_OTLP_HEADERS",
    "AGENT_MCP_CONFIG",
    "AGENT_PERMISSION_MODE",
    "AGENT_READONLY",
    "AGENT_STREAMING",
    "AGENT_MAX_STEPS"
  ]) delete env[key];
  return env;
}

async function startMockProvider(): Promise<{ baseURL: string; requests: number; close: () => Promise<void> }> {
  let requests = 0;
  const server = createServer(async (_request: IncomingMessage, response: ServerResponse) => {
    requests += 1;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const id = `package-smoke-${requests}`;
    writeSse(response, id, { role: "assistant" }, null);
    writeSse(response, id, { content: "Package smoke-test acknowledgment." }, null);
    writeSse(response, id, {}, "stop");
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "package-smoke-model", choices: [], usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start package smoke provider.");
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    get requests() { return requests; },
    close: () => new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()))
  };
}

function writeSse(response: ServerResponse<IncomingMessage>, id: string, delta: Record<string, unknown>, finishReason: string | null): void {
  response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "package-smoke-model", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
}
