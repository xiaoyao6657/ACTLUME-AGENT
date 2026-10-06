import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadMcpToolManager, mcpPiMigrationWarnings, readMcpConfig, type McpServerStatus } from "./mcp-client.js";

const execFileAsync = promisify(execFile);

export type DoctorStatus = "ok" | "warn" | "fail" | "unknown";
export type DoctorCheck = { name: string; status: DoctorStatus; detail: string };
export type DoctorReport = { checks: DoctorCheck[]; exitCode: 0 | 1 };

export type DoctorOptions = {
  workspace: string;
  memoryDir: string;
  projectRoot: string;
  piCliPath: string;
  model: string;
  baseURL?: string;
  apiKey?: string;
  mcpConfigPath?: string;
  probeProvider?: boolean;
};

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const nodeVersion = process.versions.node;
  checks.push({
    name: "Node.js",
    status: versionAtLeast(nodeVersion, 22, 19) ? "ok" : "fail",
    detail: `${nodeVersion} (required >=22.19.0)`
  });

  const workspace = resolve(options.workspace);
  try {
    const result = await execFileAsync(process.execPath, [options.piCliPath, "--version"], { timeout: 10_000, windowsHide: true });
    checks.push({ name: "Pi CLI", status: "ok", detail: result.stdout.trim() || result.stderr.trim() || "version command succeeded" });
  } catch (error) {
    checks.push({ name: "Pi CLI", status: "fail", detail: `version command failed: ${safeError(error)}` });
  }

  try {
    await access(workspace);
    checks.push({ name: "Workspace", status: "ok", detail: workspace });
  } catch {
    checks.push({ name: "Workspace", status: "fail", detail: `directory is not accessible: ${workspace}` });
  }

  const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : process.env.SHELL || "/bin/sh";
  try {
    const args = process.platform === "win32" ? ["/d", "/s", "/c", "exit 0"] : ["-c", "exit 0"];
    await execFileAsync(shell, args, { cwd: workspace, timeout: 5_000, windowsHide: true });
    checks.push({ name: "Shell startup", status: "ok", detail: shell });
  } catch (error) {
    checks.push({ name: "Shell startup", status: "fail", detail: `${shell}: ${safeError(error)}` });
  }

  try {
    const memoryDir = resolve(options.memoryDir);
    await mkdir(memoryDir, { recursive: true });
    const probePath = join(memoryDir, `.doctor-${randomUUID()}.tmp`);
    const probeValue = randomUUID();
    try {
      await writeFile(probePath, probeValue, { flag: "wx" });
      const observed = await readFile(probePath, "utf8");
      if (observed !== probeValue) throw new Error("read-back did not match the written probe");
    } finally {
      await unlink(probePath).catch(() => undefined);
    }
    checks.push({ name: "Data storage", status: "ok", detail: `temporary write/read/delete succeeded in ${memoryDir}` });
  } catch (error) {
    checks.push({ name: "Data storage", status: "fail", detail: safeError(error) });
  }

  checks.push({ name: "Model configuration", status: options.model ? "ok" : "fail", detail: options.model || "model is not configured" });
  checks.push({
    name: "Provider credentials",
    status: options.apiKey ? "ok" : "unknown",
    detail: options.apiKey
      ? `credential is available to Actlume; endpoint ${safeEndpoint(options.baseURL)}`
      : "no direct API key is configured; Pi-managed credentials may still be available and were not checked"
  });

  if (options.probeProvider) {
    checks.push(await probeProvider(options));
  } else {
    checks.push({ name: "Provider connection", status: "unknown", detail: "not probed; use --doctor --probe-provider for one minimal request" });
  }

  let mcpManager;
  try {
    const { config: parsedMcpConfig } = await readMcpConfig({
      workspace,
      projectRoot: options.projectRoot,
      configPath: options.mcpConfigPath
    });
    for (const detail of mcpPiMigrationWarnings(parsedMcpConfig)) {
      checks.push({ name: "MCP migration", status: "warn", detail });
    }
    mcpManager = await loadMcpToolManager({
      workspace,
      projectRoot: options.projectRoot,
      configPath: options.mcpConfigPath
    });
    checks.push({
      name: "MCP configuration",
      status: mcpManager.configPath ? "ok" : "unknown",
      detail: mcpManager.configPath ? `loaded ${mcpManager.configPath}` : "no MCP configuration file found"
    });
    if (mcpManager.statuses.length === 0) {
      checks.push({ name: "MCP connections", status: "unknown", detail: "no configured server connections to probe" });
    } else {
      for (const status of mcpManager.statuses) checks.push(mcpStatusCheck(status));
    }
  } catch (error) {
    checks.push({ name: "MCP configuration", status: "fail", detail: safeError(error) });
  } finally {
    await mcpManager?.close();
  }

  return { checks, exitCode: checks.some((item) => item.status === "fail") ? 1 : 0 };
}

export function formatDoctorReport(report: DoctorReport): string {
  const marker = (status: DoctorStatus) => status === "ok" ? "OK" : status === "fail" ? "FAIL" : status === "warn" ? "WARN" : "UNKNOWN";
  return ["Actlume doctor", ...report.checks.map((item) => `[${marker(item.status)}] ${item.name}: ${item.detail}`)].join("\n");
}

async function probeProvider(options: DoctorOptions): Promise<DoctorCheck> {
  if (!options.apiKey) {
    return { name: "Provider connection", status: "unknown", detail: "not probed: Actlume has no direct API key; Pi-managed auth is not used by this probe" };
  }
  const baseURL = options.baseURL ?? "https://api.openai.com/v1";
  let endpoint: URL;
  try {
    endpoint = new URL("chat/completions", `${baseURL.replace(/\/+$/, "")}/`);
  } catch {
    return { name: "Provider connection", status: "fail", detail: "configured endpoint is not a valid URL" };
  }
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: options.model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(12_000)
    });
    await response.body?.cancel();
    return response.ok
      ? { name: "Provider connection", status: "ok", detail: `minimal request succeeded (${response.status}) at ${safeEndpoint(options.baseURL)}` }
      : { name: "Provider connection", status: "fail", detail: `minimal request returned HTTP ${response.status} at ${safeEndpoint(options.baseURL)}` };
  } catch (error) {
    return { name: "Provider connection", status: "fail", detail: `minimal request failed at ${safeEndpoint(options.baseURL)}: ${safeError(error)}` };
  }
}

function mcpStatusCheck(status: McpServerStatus): DoctorCheck {
  if (status.status === "connected") {
    return { name: `MCP ${status.name}`, status: "ok", detail: `connected; ${status.toolCount} tools; timeout ${status.toolTimeoutMs}ms` };
  }
  if (status.status === "disabled") return { name: `MCP ${status.name}`, status: "unknown", detail: "configured but disabled; no connection attempted" };
  return { name: `MCP ${status.name}`, status: "warn", detail: `connection failed${status.message ? `: ${status.message}` : ""}` };
}

function versionAtLeast(version: string, major: number, minor: number): boolean {
  const [currentMajor, currentMinor] = version.split(".").map(Number);
  return Number.isFinite(currentMajor) && Number.isFinite(currentMinor)
    && (currentMajor! > major || currentMajor === major && currentMinor! >= minor);
}

function safeEndpoint(baseURL?: string): string {
  const raw = baseURL ?? "https://api.openai.com/v1";
  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "<invalid endpoint>";
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/[^\s]+/gi, "<endpoint>").slice(0, 240);
}
