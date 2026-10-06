import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export async function evaluate(workspace) {
  try {
    const module = await import(`${pathToFileURL(resolve(workspace, "src/ports.js"))}?oracle=${Date.now()}`);
    for (const value of [1, "1", 65535, "65535"]) assert.equal(module.parsePort(value), Number(value));
    for (const value of [0, "0", -1, 65536, 1.5, "abc", ""]) assert.throws(() => module.parsePort(value));
    return { verdict: "pass", checks: 11 };
  } catch (error) {
    return { verdict: "fail", reason: `port-boundary validator failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function calibrate(workspace) {
  await writeFile(resolve(workspace, "src/ports.js"), `export function parsePort(value) {\n  const port = Number(value);\n  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('invalid port');\n  return port;\n}\n`);
  return {};
}
