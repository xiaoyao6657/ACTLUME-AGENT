# Eval input contract

This directory defines the handoff format for controlled model-task evaluation. The unscored development cards in [`tasks/dev-v1.md`](tasks/dev-v1.md) cover nine core protocol scenarios plus one optional research scenario; they are not a public benchmark. The initial four-card holdout is defined in [`tasks/holdout-v1.md`](tasks/holdout-v1.md); two separately reported supplementary cards and their fixture-contract corrections are documented in [`tasks/holdout-v2.md`](tasks/holdout-v2.md) and [`tasks/holdout-v3.md`](tasks/holdout-v3.md). The deterministic benchmark under `src/benchmark.ts` tests tool behavior and is not a coding-task Eval.

Each JSONL row is one independently executed repeat and must include:

- `taskId`, `repeatIndex`, `condition`, and `category`;
- exact `modelId` and `modelRevision`, repository commit, environment ID, and a hash of the prompt/task description;
- the independent validator verdict (`pass`, `fail`, or `unknown`), separate from the model's completion claim;
- runtime status, request/tool/intervention counts, duration, and optional token usage;
- explicit interruption/resume and stale-memory exposure/misuse fields when those scenarios apply.

Do not replace missing usage or verdicts with zero/pass. Omit unknown token fields and set verdict to `unknown`. Do not put credentials, full private prompts, raw tool output, or unredacted user data in this report. Link a locally protected trace through `tracePath` when needed.

Summarize a run file with:

```bash
npm run eval:summary -- evals/runs.jsonl
npm run eval:summary -- evals/runs.jsonl actlume-control=actlume-full
npm run eval:fixture-preflight
npm run eval:protocol-smoke
npm run eval:protocol-smoke -- --fault http-500
npm run eval:model-smoke -- --task short-regression-01 --max-requests 8 --max-total-tokens 20000 --max-output-tokens 512 --max-duration-ms 120000
```

`eval:model-smoke` is a one-attempt provider/tools/usage integration smoke, not the strategy experiment. It loads the configured provider, creates an isolated fixture workspace and empty MCP config, and routes calls through a local authenticated proxy. The proxy caps upstream requests and per-response output, then stops forwarding new calls after reported cumulative usage reaches its limit; one in-flight response can cross that threshold. It preserves a report, runtime event log and patch under the ignored `.agent-benchmark/real-model-smoke/` directory. Model revision or sampling values that the provider does not expose remain `unknown`; smoke records must not be merged into strategy-quality denominators. The current historical probes are indexed by [`real-model-smoke-v1`](experiments/real-model-smoke-v1.json), [`real-model-smoke-v2`](experiments/real-model-smoke-v2.json), and [`real-model-smoke-v3`](experiments/real-model-smoke-v3.json).

The smoke runner follows fixture-declared phases, reuses a Pi session only when the phase keys match, and can perform only the two frozen verification transitions used by the memory fixtures. `artifact-recall-01` is excluded because the current worker does not capture final-answer evidence; `interrupt-recovery-01` remains on the deterministic protocol runner. Fixture commands and model workers do not inherit upstream provider secrets. For a repeated development campaign, first freeze a task-condition matrix and complete token/request limits, then run that exact manifest:

```bash
npm run eval:model-campaign -- --freeze --suite development --name round2-core-dev --repeats 3 --max-total-tokens 2000000 --attempt-token-budget 75000 --max-requests 12 --max-steps 10 --max-duration-ms 180000 --matrix "memory-transfer-01=actlume-control,actlume-memory;stale-memory-01=actlume-control,actlume-memory;guardrail-retry-01=actlume-control,actlume-guardrails;verification-claim-01=actlume-control,actlume-guardrails"
npm run eval:model-campaign -- --manifest .agent-benchmark/frozen-experiments/round2-core-dev.json
```

Freezing records the source-candidate, fixture, oracle, CheckSpec, and condition hashes plus an interleaved order. The runner refuses to start if any frozen input changes; it writes a per-attempt index and stops before another attempt when usage is unknown or the aggregate budget cannot reserve one full attempt. A provider response already in flight can still cross its per-attempt reported-token ceiling. The manifest has an explicit suite field: holdout cards cannot be mixed into development runs. Freeze holdouts with `--suite holdout` only after tuning ends, then report them separately; any later configuration change invalidates the holdout result. Use the actual frozen manifest and result index in reports rather than assuming the example command was executed.

The current development protocol pairs memory-transfer/stale-memory with `actlume-control` vs `actlume-memory`, and guardrail-retry/verification-claim with `actlume-control` vs `actlume-guardrails`. It uses three interleaved repeats, a 75,000 reported-token per-attempt ceiling, 12-request/10-step/180-second limits, and a 2,000,000 aggregate reported-token stop. These are explicit resource ceilings, not a promise that all attempts will start or finish; any unknown usage or budget-censored run is retained and prevents additional starts as specified by the manifest.

The predeclared Actlume profiles live in [`experiments/core-v1-condition-design.json`](experiments/core-v1-condition-design.json). Select one for a bounded integration smoke with `--condition actlume-control`, `actlume-memory`, `actlume-guardrails`, or `actlume-full` (the default is `actlume-full`). Memory-disabled runs keep the same model tool schema but return a no-side-effect treatment response from memory tools, omit recalled memory context, and record the treatment in events and hashes. The isolated Eval worker may autoapprove only a command that exactly matches a configured CheckSpec; other headless approval requests remain blocked, and the mode is recorded. The native Pi profile is a separate descriptive reference and cannot be run through the Actlume adapter. This file is condition-design preflight only: it is not a frozen execution manifest, core experiment, holdout set, or evidence of strategy benefit.

The [four-condition short-task pilot](experiments/core-v1-smoke-pilot-freeze.json) is a frozen integration-and-cost pilot. Its one attempt per condition does not satisfy the repeated development experiment or held-out task requirement. It belongs to neither `eval:summary` model-quality denominators nor the deterministic protocol reports. The source repository's second-round experiment report records its denominators and budget-censored outcomes.

The summary reports attempted/judged/pass/fail/unknown counts. Claim errors use only independently judged completion claims as the measured denominator; `falseCompletionRateConservative` counts unknown verdicts as possible false claims over all completion claims. Recovery exposes judged/unknown interruption denominators plus an all-attempt conservative rate. Stale-memory misuse exposes judged/unknown exposure denominators plus an all-exposure conservative rate. Missing usage remains unknown. A paired comparison requires the same `taskId` and `repeatIndex` under both conditions and matching fixture/candidate/input, provider and fixed model revision, sampling settings, permission/toolset, environment, budget, and interruption protocol. Unknown controls are excluded and counted separately. System-context and treatment hashes are preserved but may differ for a planned memory or guardrail treatment.

`eval:protocol-smoke -- --task <id>` materializes an isolated fixture, calls the actual Pi RPC runtime through a local deterministic OpenAI-compatible provider, and runs the oracle from `evals/oracles` outside the agent workspace. All nine core cards have passing deterministic protocol runs on Windows and Ubuntu 24.04 WSL. The interruption card kills the runtime process tree after its edit checkpoint and resumes the same session/task. These runs validate the harness and runtime contracts only. Their `protocol-validation-only` JSON artifacts under `.agent-benchmark/protocol-runs/` must never be imported into a model-quality report. The `http-500` mode ends with runtime failure and an unknown oracle verdict; it is a failure-handling test, not a model attempt. Fixture runs use an isolated empty MCP configuration and test-only permission mode where needed; they do not read the developer's MCP settings.

`eval:fixture-preflight` checks that every development and holdout card has a safe materializable fixture and an independent oracle, then confirms the oracle rejects or withholds judgment on the unchanged baseline and accepts its positive reference calibration. Holdout preflight is validator calibration, not model exposure. Its `fixture-oracle-preflight-only` output does not execute Actlume or count as task-quality data. Runtime protocol passes do not establish strategy benefit or model quality. Local Windows and Ubuntu 24.04 WSL process-tree execution have passed; hosted CI and human terminal usability remain separate product-delivery checks.

Before using the format for a resume-worthy claim, materialize and freeze each task fixture and independent validator, pin model/provider/environment/repository versions and permissions, interleave repetitions across conditions, preserve every failure, and report the denominator. A successful harness run validates aggregation only; it does not establish that a strategy improves coding outcomes.
