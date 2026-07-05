import test from "node:test";
import assert from "node:assert/strict";
import { describeSubAgents, filterSubAgentTools, getSubAgentSystemPrompt } from "./subagent.js";
import { tools } from "./tools/registry.js";

test("filters sub-agent tools by profile", () => {
  const exploreTools = filterSubAgentTools("explore", tools);
  assert.equal(exploreTools.some((tool) => tool.name === "readFile"), true);
  assert.equal(exploreTools.some((tool) => tool.name === "writeFile"), false);
  assert.equal(exploreTools.some((tool) => tool.name === "agent"), false);

  const generalTools = filterSubAgentTools("general", tools);
  assert.equal(generalTools.some((tool) => tool.name === "readFile"), true);
  assert.equal(generalTools.some((tool) => tool.name === "writeFile"), false);
  assert.equal(generalTools.some((tool) => tool.name === "agent"), false);
});

test("describes built-in sub-agents for prompt injection", () => {
  assert.match(getSubAgentSystemPrompt("plan"), /read-only/i);
  assert.match(describeSubAgents(), /explore/);
  assert.match(describeSubAgents(), /general/);
});
