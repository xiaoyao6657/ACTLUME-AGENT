import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SecurityPolicy, ToolDefinition } from "./types.js";

export type ShellRiskAssessment = {
  allowed: boolean;
  risk: "low" | "medium" | "high" | "blocked";
  reason?: string;
  errorCode?: string;
  matchedPattern?: string;
};

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

export const defaultSecurityPolicy: SecurityPolicy = {
  allowedTools: undefined,
  deniedTools: [],
  shellAllowlist: undefined,
  shellDenylist: [],
  allowHighRiskShell: false
};

export async function loadSecurityPolicy(workspace: string): Promise<SecurityPolicy> {
  const filePolicy = await readSecurityPolicyFile(join(workspace, ".agent-security.json"));
  return normalizeSecurityPolicy({
    ...defaultSecurityPolicy,
    ...filePolicy,
    ...envSecurityPolicy()
  });
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
    return {
      allowed: false,
      reason: `Tool ${tool.name} is denied by security policy.`,
      errorCode: "TOOL_DENIED"
    };
  }

  const allowedTools = policy.allowedTools;
  if (allowedTools && allowedTools.length > 0 && !matchesName(tool.name, allowedTools)) {
    return {
      allowed: false,
      reason: `Tool ${tool.name} is not included in security policy allowedTools.`,
      errorCode: "TOOL_NOT_ALLOWED"
    };
  }

  return { allowed: true };
}

export function assessShellCommand(command: string, policy: SecurityPolicy): ShellRiskAssessment {
  const customDeny = firstMatchingPattern(command, policy.shellDenylist ?? []);
  if (customDeny) {
    return {
      allowed: false,
      risk: "blocked",
      reason: "Command matched shellDenylist.",
      errorCode: "SHELL_DENIED",
      matchedPattern: customDeny
    };
  }

  const allowlist = policy.shellAllowlist;
  if (allowlist && allowlist.length > 0 && !firstMatchingPattern(command, allowlist)) {
    return {
      allowed: false,
      risk: "blocked",
      reason: "Command is not included in shellAllowlist.",
      errorCode: "SHELL_NOT_ALLOWED"
    };
  }

  const builtInBlocked = firstMatchingPattern(command, builtInBlockedShellPatterns);
  if (builtInBlocked) {
    return {
      allowed: false,
      risk: "blocked",
      reason: "Command matched a built-in dangerous shell pattern.",
      errorCode: "SHELL_BLOCKED",
      matchedPattern: builtInBlocked
    };
  }

  const highRisk = firstMatchingPattern(command, highRiskShellPatterns);
  if (highRisk && !policy.allowHighRiskShell) {
    return {
      allowed: false,
      risk: "high",
      reason: "Command is high-risk and allowHighRiskShell is false.",
      errorCode: "SHELL_HIGH_RISK",
      matchedPattern: highRisk
    };
  }

  return {
    allowed: true,
    risk: highRisk ? "high" : "low",
    matchedPattern: highRisk
  };
}

async function readSecurityPolicyFile(path: string): Promise<SecurityPolicy> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as SecurityPolicy;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
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
  const items = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length === 0 ? undefined : items;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function normalizeList(value: string[] | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
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
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(escapeRegExp(pattern), "i");
  }
}

function wildcardToRegExp(pattern: string): RegExp {
  return new RegExp(`^${escapeRegExp(pattern).replaceAll("\\*", ".*")}$`, "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
