# Evidence-backed resume claims

These statements are limited to repository artifacts and local checks. The current local Windows and Ubuntu 24.04 WSL2/ext4 native-Linux `release:dry` runs pass typecheck, 191 tests, 16 benchmarks, and a 116-file npm pack on candidate manifest `sha256:1897300da47ce4047a5cddbb0af6b4e1efb3dc3862e7c05ddd22e1145e59677f`; hosted CI is still pending, and local checks do not imply real-model strategy gains.

## Defensible now

- **Pi-based agent runtime:** Migrated Actlume's execution host to Pi CLI/RPC + a TypeScript extension; kept project-specific task state, policies, typed memory, verification evidence and privacy-filtered OTLP export in Actlume, with schema-checked local events and session recovery.
- **Task continuity and verification:** Added branch-aware task projections and required CheckSpec evidence; interrupted runs resume as pending/unknown, and changes are not treated as accepted solely because the model stopped. Verified locally by same-session interruption recovery and a passing fixture check.
- **Memory and runtime guardrails:** Added repository/worktree/task applicability, stale-file rejection, explicit candidate promotion and same-scope supersession; exercised memory transfer, requirement revision and stale-memory handling with independent fixture oracles.
- **Evaluation engineering:** Built nine isolated fixture/oracle protocol cards, failure injection, run-event collection, strict control matching, and bounded usage-unknown response diagnostics. All nine deterministic protocol runs pass on Windows and Ubuntu 24.04 WSL2 native Linux for current candidate `sha256:1897300da47ce4047a5cddbb0af6b4e1efb3dc3862e7c05ddd22e1145e59677f`; this validates harness/runtime behavior only and is not a real-model success rate. Real-model bounded smoke and campaigns ran on source candidate `eb941e32…36c4ca`; its runtime inputs match the current candidate, whose only manifest differences are the README files. The bounded smoke had 5/5 provider usages (24,419 tokens) and passed its oracle. A 24-attempt development matrix and eight-attempt post-freeze confirmation finished with complete usage, but mixed outcomes, reused confirmation cards, and unknown model revision/sampling prevent strategy-benefit or unseen-task generalization claims. No general task-quality rate is established.

## Keep out until the remaining gates pass

Do not claim a measured improvement in resolve rate, recovery, stale-memory safety, tokens or cost. Linux process-tree recovery and deterministic Linux PTY resize/input/approval-denial checks have local Ubuntu 24.04 WSL evidence, but hosted dual-platform CI and the human terminal matrix/recording still need their own verification. Do not present `scopedResearch` as an OS/filesystem sandbox or a fault-isolated orchestrator. Pi supplies the terminal UI, transcript, model loop and MCP lifecycle; describe those as reused runtime capabilities. Avoid unsupported historical numbers such as “95 tests” or “20+ real issues” unless separate, reproducible evidence is attached.

## Compact version

> Built a Pi CLI/RPC-based coding-agent extension with branch-aware task recovery, scope- and freshness-aware memory, and CheckSpec-backed verification evidence. Added nine isolated fixture/oracle protocols and strict Eval controls; deterministic protocol coverage passes locally, while real-model strategy gains remain unmeasured.
