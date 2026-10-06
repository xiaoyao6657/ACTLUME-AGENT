import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { normalizePermissionMode, parseBoolean } from "./security.js";
import type { PermissionMode } from "./types.js";
import { loadPolicyConfig, type PolicyConfig } from "./policy-config.js";

export type CliConfigOverrides = {
  workspace?: string;
  readonly?: boolean;
  maxSteps?: number;
  model?: string;
  yes?: boolean;
  mcpConfigPath?: string;
  permissionMode?: PermissionMode;
  streaming?: boolean;
};

export type AppConfig = {
  workspace: string;
  memoryDir: string;
  readonly: boolean;
  maxSteps?: number;
  model: string;
  baseURL?: string;
  apiKey?: string;
  yes: boolean;
  mcpConfigPath?: string;
  permissionMode: PermissionMode;
  streaming: boolean;
  policyConfig?: PolicyConfig;
  /** Internal evaluation control. Omitted means the normal, memory-enabled runtime. */
  memoryEnabled?: boolean;
  /** Internal Eval opt-in: headless runs may execute only an exact configured CheckSpec command. */
  allowHeadlessCheckSpec?: boolean;
  sources: {
    userConfigPath: string;
    projectConfigPath: string;
    userConfigLoaded: boolean;
    projectConfigLoaded: boolean;
  };
};

type PartialAppConfig = {
  workspace?: string;
  memoryDir?: string;
  readonly?: boolean;
  maxSteps?: number;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  yes?: boolean;
  mcpConfigPath?: string;
  permissionMode?: PermissionMode;
  streaming?: boolean;
};

const configSchema = z.object({
  workspace: z.string().min(1).optional(),
  memoryDir: z.string().min(1).optional(),
  readonly: z.boolean().optional(),
  maxSteps: z.number().int().min(1).optional(),
  model: z.string().min(1).optional(),
  baseURL: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  yes: z.boolean().optional(),
  mcpConfigPath: z.string().min(1).optional(),
  permissionMode: z.enum(["default", "plan", "acceptEdits", "dontAsk", "bypassPermissions"]).optional(),
  streaming: z.boolean().optional()
});

const defaults: Required<Pick<AppConfig, "memoryDir" | "readonly" | "model" | "yes" | "permissionMode" | "streaming">> = {
  memoryDir: ".agent-memory",
  readonly: false,
  model: "gpt-4.1-mini",
  yes: false,
  permissionMode: "default",
  streaming: false
};

export async function loadAppConfig(overrides: CliConfigOverrides, cwd = process.cwd()): Promise<AppConfig> {
  const envConfig = configFromEnv();
  const userConfigPath = resolve(getActlumeHome(), ".actlume", "config.json");
  const userConfig = await readConfigFile(userConfigPath);

  const initialWorkspace = resolvePath(cwd, overrides.workspace ?? envConfig.workspace ?? cwd);
  let projectConfigPath = resolve(initialWorkspace, ".actlume", "config.json");
  let projectConfig = await readConfigFile(projectConfigPath);

  let merged = mergeConfig(
    {
      memoryDir: defaults.memoryDir,
      readonly: defaults.readonly,

      model: defaults.model,
      yes: defaults.yes,
      permissionMode: defaults.permissionMode,
      streaming: defaults.streaming
    },
    envConfig,
    userConfig,
    projectConfig,
    cliOverridesToConfig(overrides)
  );

  let workspace = resolvePath(cwd, merged.workspace ?? cwd);
  const finalProjectConfigPath = resolve(workspace, ".actlume", "config.json");
  if (finalProjectConfigPath !== projectConfigPath) {
    const finalProjectConfig = await readConfigFile(finalProjectConfigPath);
    if (Object.keys(finalProjectConfig).length > 0) {
      projectConfigPath = finalProjectConfigPath;
      projectConfig = finalProjectConfig;
      merged = mergeConfig(
        {
          memoryDir: defaults.memoryDir,
          readonly: defaults.readonly,
          model: defaults.model,
          yes: defaults.yes,
          permissionMode: defaults.permissionMode,
          streaming: defaults.streaming
        },
        envConfig,
        userConfig,
        projectConfig,
        cliOverridesToConfig(overrides)
      );
      workspace = resolvePath(cwd, merged.workspace ?? cwd);
    }
  }

  const memoryDir = resolveMemoryDir(workspace, merged.memoryDir ?? defaults.memoryDir);
  const mcpConfigPath = merged.mcpConfigPath ? resolvePath(workspace, merged.mcpConfigPath) : undefined;
  const permissionMode = merged.permissionMode ?? (merged.yes ? "bypassPermissions" : defaults.permissionMode);
  const policyConfig = await loadPolicyConfig(workspace);

  return {
    workspace,
    memoryDir,
    readonly: (merged.readonly ?? defaults.readonly) || permissionMode === "plan",
    maxSteps: merged.maxSteps,
    model: merged.model ?? defaults.model,
    baseURL: merged.baseURL,
    apiKey: merged.apiKey,
    yes: merged.yes ?? defaults.yes,
    mcpConfigPath,
    permissionMode,
    streaming: merged.streaming ?? defaults.streaming,
    policyConfig,
    sources: {
      userConfigPath,
      projectConfigPath,
      userConfigLoaded: Object.keys(userConfig).length > 0,
      projectConfigLoaded: Object.keys(projectConfig).length > 0
    }
  };
}

export async function ensureConfigDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

function mergeConfig(...configs: PartialAppConfig[]): PartialAppConfig {
  const merged: PartialAppConfig = {};
  for (const config of configs) {
    for (const [key, value] of Object.entries(config) as [keyof PartialAppConfig, unknown][]) {
      if (value !== undefined) {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
  }
  return merged;
}

async function readConfigFile(path: string): Promise<PartialAppConfig> {
  try {
    const raw = await readFile(path, "utf8");
    return configSchema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw new Error(`Failed to read config ${path}: ${(error as Error).message}`);
  }
}

function configFromEnv(): PartialAppConfig {
  return {
    workspace: emptyToUndefined(process.env.AGENT_WORKSPACE),
    memoryDir: emptyToUndefined(process.env.AGENT_MEMORY_DIR),
    readonly: parseBoolean(process.env.AGENT_READONLY),
    maxSteps: parsePositiveIntegerEnv(process.env.AGENT_MAX_STEPS),
    model: emptyToUndefined(process.env.OPENAI_MODEL),
    baseURL: emptyToUndefined(process.env.OPENAI_BASE_URL),
    apiKey: emptyToUndefined(process.env.OPENAI_API_KEY),
    mcpConfigPath: emptyToUndefined(process.env.AGENT_MCP_CONFIG),
    permissionMode: parsePermissionModeEnv(process.env.AGENT_PERMISSION_MODE),
    streaming: parseBoolean(process.env.AGENT_STREAMING)
  };
}

function getActlumeHome(): string {
  return process.env.ACTLUME_HOME ? resolve(process.env.ACTLUME_HOME) : homedir();
}

function cliOverridesToConfig(overrides: CliConfigOverrides): PartialAppConfig {
  return {
    workspace: overrides.workspace,
    readonly: overrides.readonly,
    maxSteps: overrides.maxSteps,
    model: overrides.model,
    yes: overrides.yes,
    mcpConfigPath: overrides.mcpConfigPath,
    permissionMode: overrides.permissionMode,
    streaming: overrides.streaming
  };
}

function resolveMemoryDir(workspace: string, memoryDir: string): string {
  if (isAbsolute(memoryDir)) {
    return memoryDir;
  }
  return resolve(workspace, memoryDir);
}

function resolvePath(base: string, value: string): string {
  if (isAbsolute(value)) {
    return resolve(value);
  }
  return resolve(base, value);
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parsePositiveIntegerEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`AGENT_MAX_STEPS must be a positive integer, got ${value}`);
  }
  return parsed;
}

function parsePermissionModeEnv(value: string | undefined): PermissionMode | undefined {
  const mode = normalizePermissionMode(value);
  if (value && !mode) {
    throw new Error(`AGENT_PERMISSION_MODE must be one of default, plan, acceptEdits, dontAsk, bypassPermissions; got ${value}`);
  }
  return mode;
}
