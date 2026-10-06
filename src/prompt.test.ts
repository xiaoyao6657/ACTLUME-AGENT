import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildWorkspacePromptContext, resolveIncludes } from "./prompt.js";

test("resolves local include directives", async () => {
  const dir = await mkdtemp(join(tmpdir(), "actlume-prompt-"));
  try {
    await writeFile(join(dir, "extra.md"), "included text", "utf8");
    const resolved = resolveIncludes("@./extra.md", dir);
    assert.equal(resolved, "included text");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("builds workspace prompt context from instructions and rules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "actlume-prompt-"));
  try {
    await mkdir(join(dir, ".actlume", "rules"), { recursive: true });
    await writeFile(join(dir, "shared.md"), "shared instruction", "utf8");
    await writeFile(join(dir, "ACTLUME.md"), "Use ACTLUME rules.\n@./shared.md", "utf8");
    await writeFile(join(dir, "CLAUDE.md"), "Claude-compatible instruction", "utf8");
    await writeFile(join(dir, ".actlume", "rules", "a.md"), "rule A", "utf8");

    const context = buildWorkspacePromptContext(dir);
    assert.match(context, /Working directory:/);
    assert.match(context, /Use ACTLUME rules/);
    assert.match(context, /shared instruction/);
    assert.match(context, /Claude-compatible instruction/);
    assert.match(context, /rule A/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workspace prompt can omit legacy skill and sub-agent declarations for runtimes without those tools", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "actlume-prompt-pi-"));
  try {
    await mkdir(join(cwd, ".actlume", "skills", "legacy-check"), { recursive: true });
    await writeFile(join(cwd, ".actlume", "skills", "legacy-check", "SKILL.md"), [
      "---",
      "name: legacy-check",
      "description: A legacy-only skill",
      "user-invocable: true",
      "---",
      "Do legacy skill work."
    ].join("\n"), "utf8");

    const context = buildWorkspacePromptContext(cwd, { includeSkills: false, includeSubAgents: false });
    assert.doesNotMatch(context, /Available Skills/);
    assert.doesNotMatch(context, /Sub-Agents/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
