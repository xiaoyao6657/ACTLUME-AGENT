import { z } from "zod";
import { getSkillByName, resolveSkillPrompt } from "../skills.js";
import { toolFailure, toolSuccess } from "../tool-result.js";
import type { ToolDefinition } from "../types.js";

const skillSchema = z.object({
  name: z.string().min(1),
  args: z.string().default("")
});

export const skillTool: ToolDefinition = {
  name: "skill",
  description: "Resolve a project or user skill prompt from .actlume/skills/<name>/SKILL.md.",
  sideEffect: "read",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name." },
      args: { type: "string", default: "", description: "Optional arguments for $ARGUMENTS." }
    },
    required: ["name"]
  },
  async run(input, ctx) {
    const args = skillSchema.parse(input);
    const skill = getSkillByName(ctx.cwd, args.name);
    if (!skill) {
      return toolFailure({
        content: `Skill not found: ${args.name}`,
        errorCode: "SKILL_NOT_FOUND",
        retryable: true,
        metadata: { name: args.name }
      });
    }

    return toolSuccess(resolveSkillPrompt(skill, args.args), {
      name: skill.name,
      context: skill.context,
      allowedTools: skill.allowedTools,
      source: skill.source,
      skillDir: skill.skillDir
    });
  }
};
