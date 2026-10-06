# Actlume supplementary held-out task v3

This is a fresh supplemental card after the first two holdout drafts failed to enter the stale-memory follow-up: v1's learning phase did not run the required CheckSpec; v2 required non-CheckSpec shell commands that the headless worker correctly blocks. This card does not invoke auxiliary commands. Both phases run only the same exact `npm test` CheckSpec; the second-phase artifact edit uses the file tool. The agent policy, permissions, and tool surface are unchanged. Report this post-v1 supplemental separately from the original four-card holdout.

| ID | Category | Task prompt | Independent oracle |
| --- | --- | --- | --- |
| `holdout-stale-config-01` | `memory-transfer` | Verify the current artifact target, save it with source provenance, then follow a fresh-session v2 config update and update the artifact. | Require v2 output; for memory treatment, separately require stale-memory exposure, rejection, and non-use. |

The original v1/v2 failures remain preserved as runner/fixture contract findings. This card was authored without changing policy, prompt, permission, or tool behavior, then baseline/reference calibrated before its separate frozen run.
