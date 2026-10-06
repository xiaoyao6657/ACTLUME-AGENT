import { runPiTaskDetailed } from "../src/pi-runtime.js";
import { defaultSecurityPolicy } from "../src/security.js";
import type { AppConfig } from "../src/config.js";

type WorkerInput = { config: AppConfig; prompt: string; sessionId: string };

const raw = process.env.ACTLUME_EVAL_WORKER_CONFIG;
if (!raw) throw new Error("Missing isolated Eval worker configuration.");
const input = JSON.parse(raw) as WorkerInput;
const result = await runPiTaskDetailed(input.config, defaultSecurityPolicy, input.prompt, input.sessionId, { silent: true });
process.stdout.write(`${JSON.stringify(result)}\n`);
