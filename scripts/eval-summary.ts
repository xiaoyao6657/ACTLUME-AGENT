import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEvalJsonl, summarizeEvaluations } from "../src/eval-harness.js";

const [input, ...comparisonArgs] = process.argv.slice(2);
if (!input) {
  console.error("Usage: npm run eval:summary -- <records.jsonl> [baseline=candidate ...]");
  process.exitCode = 2;
} else {
  try {
    const records = parseEvalJsonl(await readFile(resolve(input), "utf8"));
    const comparisons = comparisonArgs.map((value) => {
      const [baseline, candidate] = value.split("=", 2);
      if (!baseline || !candidate) throw new Error(`Invalid comparison '${value}'; use baseline=candidate.`);
      return { baseline, candidate };
    });
    process.stdout.write(`${JSON.stringify(summarizeEvaluations(records, comparisons), null, 2)}\n`);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
