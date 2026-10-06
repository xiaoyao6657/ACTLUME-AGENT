# Actlume supplementary held-out task v2

This supplemental card was authored after the first held-out campaign exposed a phase/check mismatch in its original stale-workflow fixture. It corrects the task contract by requiring the learning phase to run the exact required test before the harness promotes memory. It is not pooled with the v1 result or used to change agent policy, prompt behavior, permissions, or tool schemas. Its one repeat per condition remains a small, task-specific check.

| ID | Category | Task prompt | Independent oracle |
| --- | --- | --- | --- |
| `holdout-stale-build-01` | `memory-transfer` | Verify the v1 build workflow and required test, then use current build.json in a fresh session after it changes to v2. | Require v2 artifact output; for memory treatment, require explicit stale-memory exposure, rejection, and non-use. |

The fixture makes the required `npm test` pass in the learning phase and includes it explicitly in the phase prompt. The follow-up configuration revision then invalidates memory applicability before the new session. `eval:fixture-preflight` calibrates the unchanged baseline and positive reference; real-model runs use a separate `holdout` campaign manifest.
