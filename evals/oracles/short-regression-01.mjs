import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export async function evaluate(workspace) {
  try {
    const moduleUrl = `${pathToFileURL(resolve(workspace, "parser.js")).href}?oracle=${Date.now()}`;
    const { parseOptionalField } = await import(moduleUrl);
    const empty = parseOptionalField("title:");
    const ordinary = parseOptionalField("title:Actlume");
    if (JSON.stringify(empty) !== JSON.stringify({ key: "title", value: "" })) {
      return { verdict: "fail", reason: "empty optional value did not round-trip" };
    }
    if (JSON.stringify(ordinary) !== JSON.stringify({ key: "title", value: "Actlume" })) {
      return { verdict: "fail", reason: "non-empty value regressed" };
    }
    for (const malformed of [":empty", "title:a:b", "title"] ) {
      let rejected = false;
      try { parseOptionalField(malformed); } catch { rejected = true; }
      if (!rejected) return { verdict: "fail", reason: `malformed input accepted: ${malformed}` };
    }
    return { verdict: "pass", checks: 5 };
  } catch (error) {
    return { verdict: "fail", reason: `oracle execution failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function calibrate(workspace) {
  await writeFile(resolve(workspace, "parser.js"), `export function parseOptionalField(input) {\n  if (typeof input !== "string") throw new TypeError("input must be a string");\n  const match = /^([^:]+):([^:]*)$/.exec(input);\n  if (!match) throw new Error("invalid field");\n  return { key: match[1], value: match[2] };\n}\n`);
  return {};
}
