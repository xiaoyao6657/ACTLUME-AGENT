import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

export type SkillContext = "inline" | "fork";

export type SkillDefinition = {
  name: string;
  description: string;
  whenToUse?: string;
  allowedTools?: string[];
  userInvocable: boolean;
  context: SkillContext;
  promptTemplate: string;
  source: "project" | "user";
  skillDir: string;
};

export function discoverSkills(workspace: string): SkillDefinition[] {
  const skills = new Map<string, SkillDefinition>();
  loadSkillsFromDir(join(homedir(), ".actlume", "skills"), "user", skills);
  loadSkillsFromDir(join(workspace, ".actlume", "skills"), "project", skills);
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getSkillByName(workspace: string, name: string): SkillDefinition | undefined {
  return discoverSkills(workspace).find((skill) => skill.name === name);
}

export function resolveSkillPrompt(skill: SkillDefinition, args: string): string {
  return skill.promptTemplate
    .replace(/\$ARGUMENTS|\$\{ARGUMENTS\}/g, args)
    .replace(/\$\{ACTLUME_SKILL_DIR\}/g, skill.skillDir)
    .replace(/\$\{CLAUDE_SKILL_DIR\}/g, skill.skillDir);
}

export function buildSkillDescriptions(workspace: string): string {
  const skills = discoverSkills(workspace);
  if (skills.length === 0) {
    return "";
  }

  const lines = ["## Available Skills", ""];
  for (const skill of skills) {
    const invoke = skill.userInvocable ? `/${skill.name}` : skill.name;
    lines.push(`- ${invoke}: ${skill.description || "No description."} (${skill.context}, ${skill.source})`);
    if (skill.whenToUse) {
      lines.push(`  When to use: ${skill.whenToUse}`);
    }
  }
  lines.push("", "Use the `skill` tool or a user-invoked slash command when a skill matches the task.");
  return lines.join("\n");
}

function loadSkillsFromDir(
  baseDir: string,
  source: "project" | "user",
  skills: Map<string, SkillDefinition>
): void {
  if (!existsSync(baseDir)) {
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(baseDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const skillDir = join(baseDir, entry);
    try {
      if (!statSync(skillDir).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }

    const skillFile = join(skillDir, "SKILL.md");
    if (!existsSync(skillFile)) {
      continue;
    }

    const skill = parseSkillFile(skillFile, source, skillDir);
    if (skill) {
      skills.set(skill.name, skill);
    }
  }
}

function parseSkillFile(filePath: string, source: "project" | "user", skillDir: string): SkillDefinition | undefined {
  try {
    const raw = readFileSync(filePath, "utf8");
    const { meta, body } = parseFrontmatter(raw);
    const name = meta.name || basename(skillDir);
    return {
      name,
      description: meta.description ?? "",
      whenToUse: meta.when_to_use ?? meta["when-to-use"],
      allowedTools: parseAllowedTools(meta["allowed-tools"]),
      userInvocable: meta["user-invocable"] !== "false",
      context: meta.context === "fork" ? "fork" : "inline",
      promptTemplate: body,
      source,
      skillDir
    };
  } catch {
    return undefined;
  }
}

function parseAllowedTools(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  if (value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map(String);
      }
    } catch {
      // Fall through to CSV parsing.
    }
  }
  return value
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
