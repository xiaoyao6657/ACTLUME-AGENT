import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverSkills, getSkillByName, resolveSkillPrompt } from "./skills.js";
import { runRegisteredTool } from "./tool-scheduler.js";
import { defaultSecurityPolicy } from "./security.js";
import { tools } from "./tools/registry.js";

test("discovers and resolves project skills", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-skills-"));
  try {
    const skillDir = join(workspace, ".actlume", "skills", "commit");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: commit",
        "description: Draft a commit message",
        "when-to-use: When changes are ready",
        "allowed-tools: readFile, shell",
        "---",
        "Draft a commit message for $ARGUMENTS in ${ACTLUME_SKILL_DIR}."
      ].join("\n"),
      "utf8"
    );

    const skills = discoverSkills(workspace);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.name, "commit");
    assert.deepEqual(skills[0]?.allowedTools, ["readFile", "shell"]);

    const skill = getSkillByName(workspace, "commit");
    assert.ok(skill);
    const prompt = resolveSkillPrompt(skill, "current diff");
    assert.match(prompt, /current diff/);
    assert.match(prompt, /commit/);

    const result = await runRegisteredTool(tools, "skill", { name: "commit", args: "current diff" }, {
      cwd: workspace,
      memoryDir: join(workspace, ".agent-memory"),
      readonly: false,
      runId: "skills-run",
      permissionMode: "default",
      securityPolicy: defaultSecurityPolicy
    });
    assert.equal(result.ok, true);
    assert.match(result.content, /Draft a commit message/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
