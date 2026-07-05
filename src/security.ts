import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PermissionMode, SecurityPolicy, ToolDefinition, ToolSideEffect } from "./types.js";

export type ShellRiskAssessment = {
  allowed: boolean;
  risk: "low" | "medium" | "high" | "blocked";
  reason?: string;
  errorCode?: string;
  matchedPattern?: string;
};

// ── shell patterns ─────────────────────────────────────────────────

const builtInBlockedShellPatterns = [
  String.raw`\brm\s+-rf\s+(?:[/.~]|["']?[A-Z]:\\?)`,
  String.raw`\bRemove-Item\b[\s\S]*\s-(?:Recurse|r)\b[\s\S]*\s-(?:Force|f)\b`,
  String.raw`\bshutdown\b`,
  String.raw`\breboot\b`,
  String.raw`\bmkfs\b`,
  String.raw`\bdd\s+if=`,
  String.raw`\bdel\s+\/[fsq]`,
  String.raw`(^|[;&|]\s*)format(\s|$)`,
  String.raw`>\s*\/dev\/sd[a-z]`,
  String.raw`\bgit\s+clean\s+-fdx\b`
];

const highRiskShellPatterns = [
  String.raw`\bgit\s+reset\s+--hard\b`,
  String.raw`\bgit\s+push\b[\s\S]*\s--force(?:-with-lease)?\b`,
  String.raw`\bnpm\s+publish\b`,
  String.raw`\bpip\s+install\b[\s\S]*\s--break-system-packages\b`,
  String.raw`\bchmod\s+-R\s+777\b`,
  String.raw`\bchown\s+-R\b`
];

// Commands that delete files — not blocked, but flagged as medium risk for confirmation
const deleteShellPatterns = [
  String.raw`\brm\s+(?:-[a-z]*r[a-z]*\s+)?["']?(?:\.\/)?[^\s|;&]+`,  // rm file or rm -r dir
  String.raw`\bdel\s+(?:\/[a-z]+\s+)?["']?(?:\.\/)?[^\s|;&]+`,       // del file (Windows)
  String.raw`\brmdir\b`,
  String.raw`\brd\s+["']?(?:\.\/)?[^\s|;&]+`,                          // rd (Windows)
  String.raw`\bgit\s+rm\b`,
  String.raw`\bMove-Item\b`,
  String.raw`\bRemove-Item\b`,
  String.raw`\bRename-Item\b`,
  String.raw`\btruncate\b`,
  String.raw`\bunlink\b`,
];

// ── sensitive file paths ───────────────────────────────────────────

const sensitivePathPatterns = [
  /(?:^|[\\/])\.env(\.[a-z]+)?$/i,
  /(?:^|[\\/])\.git[\\/]/i,
  /(?:^|[\\/])\.git$/i,
  /(?:^|[\\/])\.actlume[\\/]config\.json$/i,
  /(?:^|[\\/])\.agent-security\.json$/i,
  /(?:^|[\\/])\.agent-mcp\.json$/i,
  /\.(?:pem|key|p12|pfx|cer|crt)$/i,
  /(?:^|[\\/])\.?credentials/i,
  /(?:^|[\\/])\.?secrets?(?:[\\/]|$)/i,
  /(?:^|[\\/])\.?tokens?(?:[\\/]|$)/i,
  /(?:^|[\\/])id_rsa/i,
  /(?:^|[\\/])\.?ssh[\\/]/i,
  /\.envrc$/i,
  /(?:^|[\\/])\.docker[\\/]config\.json$/i,
];

export function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  return sensitivePathPatterns.some((p) => p.test(normalized));
}

export function sensitivePathMessage(filePath: string): string {
  return `${filePath} matches a sensitive path pattern. This file may contain credentials, configuration, or secrets.`;
}

// ── policy ─────────────────────────────────────────────────────────

export const defaultSecurityPolicy: SecurityPolicy = {
  allowedTools: undefined,
  deniedTools: [],
  shellAllowlist: undefined,
  shellDenylist: [],
  allowHighRiskShell: false
};

export const permissionModes: PermissionMode[] = ["default", "plan", "acceptEdits", "dontAsk", "bypassPermissions"];

export function normalizePermissionMode(value: string | undefined): PermissionMode | undefined {
  if (!value) return undefined;
  return permissionModes.find((mode) => mode.toLowerCase() === value.toLowerCase());
}

export function shouldAutoApproveTool(sideEffect: ToolSideEffect, mode: PermissionMode): boolean {
  if (sideEffect === "read") return true;
  if (mode === "bypassPermissions") return true;
  return mode === "acceptEdits" && sideEffect === "write";
}

export function shouldAutoDenyConfirmation(mode: PermissionMode): boolean {
  return mode === "dontAsk";
}

export function isPlanModeAllowedWriteTool(toolName: string): boolean {
  return toolName === "writePlan" || toolName === "updatePlan";
}

export async function loadSecurityPolicy(workspace: string): Promise<SecurityPolicy> {
  const filePolicy = await readSecurityPolicyFile(join(workspace, ".agent-security.json"));
  return normalizeSecurityPolicy({ ...defaultSecurityPolicy, ...filePolicy, ...envSecurityPolicy() });
}

export function normalizeSecurityPolicy(policy: SecurityPolicy): SecurityPolicy {
  return {
    allowedTools: normalizeList(policy.allowedTools),
    deniedTools: normalizeList(policy.deniedTools) ?? [],
    shellAllowlist: normalizeList(policy.shellAllowlist),
    shellDenylist: normalizeList(policy.shellDenylist) ?? [],
    allowHighRiskShell: policy.allowHighRiskShell === true
  };
}

export function checkToolPermission(
  tool: ToolDefinition,
  policy: SecurityPolicy
): { allowed: true } | { allowed: false; reason: string; errorCode: string } {
  const deniedTools = policy.deniedTools ?? [];
  if (matchesName(tool.name, deniedTools)) {
    return { allowed: false, reason: `Tool ${tool.name} is denied by security policy.`, errorCode: "TOOL_DENIED" };
  }
  const allowedTools = policy.allowedTools;
  if (allowedTools && allowedTools.length > 0 && !matchesName(tool.name, allowedTools)) {
    return { allowed: false, reason: `Tool ${tool.name} is not included in security policy allowedTools.`, errorCode: "TOOL_NOT_ALLOWED" };
  }
  return { allowed: true };
}

export function assessShellCommand(command: string, policy: SecurityPolicy): ShellRiskAssessment {
  const customDeny = firstMatchingPattern(command, policy.shellDenylist ?? []);
  if (customDeny) {
    return { allowed: false, risk: "blocked", reason: "Command matched shellDenylist.", errorCode: "SHELL_DENIED", matchedPattern: customDeny };
  }

  const allowlist = policy.shellAllowlist;
  if (allowlist && allowlist.length > 0 && !firstMatchingPattern(command, allowlist)) {
    return { allowed: false, risk: "blocked", reason: "Command is not included in shellAllowlist.", errorCode: "SHELL_NOT_ALLOWED" };
  }

  const builtInBlocked = firstMatchingPattern(command, builtInBlockedShellPatterns);
  if (builtInBlocked) {
    return { allowed: false, risk: "blocked", reason: "Command matched a built-in dangerous shell pattern.", errorCode: "SHELL_BLOCKED", matchedPattern: builtInBlocked };
  }

  const highRisk = firstMatchingPattern(command, highRiskShellPatterns);
  if (highRisk && !policy.allowHighRiskShell) {
    return { allowed: false, risk: "high", reason: "Command is high-risk and allowHighRiskShell is false.", errorCode: "SHELL_HIGH_RISK", matchedPattern: highRisk };
  }

  const isDelete = firstMatchingPattern(command, deleteShellPatterns);
  if (isDelete) {
    return { allowed: true, risk: "medium", reason: "This command may delete files.", errorCode: "SHELL_DELETE_WARNING", matchedPattern: isDelete };
  }

  return { allowed: true, risk: highRisk ? "high" : "low", matchedPattern: highRisk };
}

// ── helpers ────────────────────────────────────────────────────────

async function readSecurityPolicyFile(path: string): Promise<SecurityPolicy> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as SecurityPolicy;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function envSecurityPolicy(): SecurityPolicy {
  return {
    allowedTools: csv(process.env.AGENT_ALLOWED_TOOLS),
    deniedTools: csv(process.env.AGENT_DENIED_TOOLS),
    shellAllowlist: csv(process.env.AGENT_SHELL_ALLOWLIST),
    shellDenylist: csv(process.env.AGENT_SHELL_DENYLIST),
    allowHighRiskShell: parseBoolean(process.env.AGENT_ALLOW_HIGH_RISK_SHELL)
  };
}

function csv(value: string | undefined): string[] | undefined {
  const items = (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  return items.length === 0 ? undefined : items;
}

export function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function normalizeList(value: string[] | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.map((item) => item.trim()).filter(Boolean);
  return items.length === 0 ? undefined : items;
}

function matchesName(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => pattern === name || pattern === "*" || wildcardToRegExp(pattern).test(name));
}

function firstMatchingPattern(command: string, patterns: string[]): string | undefined {
  return patterns.find((pattern) => safeRegExp(pattern).test(command));
}

function safeRegExp(pattern: string): RegExp {
  try { return new RegExp(pattern, "i"); }
  catch { return new RegExp(escapeRegExp(pattern), "i"); }
}

function wildcardToRegExp(pattern: string): RegExp {
  return new RegExp(`^${escapeRegExp(pattern).replaceAll("\\*", ".*")}$`, "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
