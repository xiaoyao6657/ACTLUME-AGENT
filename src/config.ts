import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

export type CliConfigOverrides = {
  workspace?: string;
  readonly?: boolean;
  maxSteps?: number;
  model?: string;
  yes?: boolean;
  mcpConfigPath?: string;
};

export type AppConfig = {
  workspace: string;
  memoryDir: string;
  readonly: boolean;
  maxSteps: number;
  model: string;
  baseURL?: string;
  apiKey?: string;
  yes: boolean;
  mcpConfigPath?: string;
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
  mcpConfigPath: z.string().min(1).optional()
});

const defaults: Required<Pick<AppConfig, "memoryDir" | "readonly" | "maxSteps" | "model" | "yes">> = {
  memoryDir: ".agent-memory",
  readonly: false,
  maxSteps: 10,
  model: "gpt-4.1-mini",
  yes: false
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
      maxSteps: defaults.maxSteps,
      model: defaults.model,
      yes: defaults.yes
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
          maxSteps: defaults.maxSteps,
          model: defaults.model,
          yes: defaults.yes
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

  return {
    workspace,
    memoryDir,
    readonly: merged.readonly ?? defaults.readonly,
    maxSteps: merged.maxSteps ?? defaults.maxSteps,
    model: merged.model ?? defaults.model,
    baseURL: merged.baseURL,
    apiKey: merged.apiKey,
    yes: merged.yes ?? defaults.yes,
    mcpConfigPath,
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
    mcpConfigPath: emptyToUndefined(process.env.AGENT_MCP_CONFIG)
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
    mcpConfigPath: overrides.mcpConfigPath
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

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
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
