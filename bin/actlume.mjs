#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(packageRoot, "src", "main.ts");
// Resolve production dependencies through Node's package resolution so this
// entry works when npm hoists them into the consumer's node_modules directory.
const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));

const child = spawn(process.execPath, [tsxCli, entry, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
