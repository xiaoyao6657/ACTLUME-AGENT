# Actlume 第二轮源码基线

建立时间：2026-10-05。用途：固定开始第二轮时审查到的候选工作区输入。此清单不代表变更已提交，也不把当前 HEAD 当作包含工作区改动的交付版本。

## 候选输入摘要

| 字段 | 值 |
| --- | --- |
| Git HEAD | `256e476ef5bdd624526c1ea306c755fd4ad354e7` |
| 分支 | `codex/actlume-pi-migration` |
| 起始工作区中有变更或未跟踪文件的路径数 | 46 |
| 第二轮开始时源代码输入 hash | `bd140326c26a531854c5c1f2a69ae16c0e8b1616352c30d18747a620e4c867ca` |
| Node | `v24.14.1` |
| npm | `11.11.0` |
| Pi | `@earendil-works/pi-coding-agent@1.0.2` |
| TypeScript | `6.0.3` |
| tsx | `4.22.4` |
| Zod | `4.4.3` |
| MCP SDK | `1.29.0` |
| 上次本地 CI 证据 | `npm run ci`：typecheck、128 项测试和 16 项确定性 smoke 全部通过（第二轮新增代码前） |

hash 由工作区 manifest 命令生成，覆盖 dirty/untracked 的应用源码、package、fixture、CI、入口与项目使用文档，并逐文件记录 SHA-256。它不覆盖 node_modules、忽略文件或本规划/评估/工程笔记；不等价于完整仓库快照、依赖供应链证明或提交签名。每轮交付应另外记录最新候选 hash 和实际运行的验证结果。

## 重建命令

```powershell
npm run baseline:worktree
```

初始扫描观察到 46 个 dirty/untracked 路径，其中包含当时已经存在但尚未提交的 Pi 迁移实现、评估文档、场景卡、依赖锁和 CI。路径清单通过扫描当时的 `git status --short --untracked-files=all` 取得。`scripts/worktree-manifest.mjs` 首次加入后，R0 源代码输入扫描统计到 42 个 dirty/untracked 应用输入；连续两次扫描得到相同的 `bd140326c26a531854c5c1f2a69ae16c0e8b1616352c30d18747a620e4c867ca`。脚本与 `package.json` 中的命令在计算此候选 hash 时已经存在。初始 HEAD 不包含这些路径的完整内容。

## 基线测试与限制

第二轮开始时沿用的已验证结果是 128/128 测试和 16/16 smoke 通过。该计数混合旧 Runtime 行为单测、迁移代码及 Pi mock 集成测试，不能作为 Pi-only 覆盖率或真实模型成功率。本文件不重新声明模型 API、生产包安装、远端 Windows CI、人工 TUI 矩阵通过。

第二轮通过后增加新的源码与测试。后续 CI 结果必须注明其候选 manifest hash，不能继续将这里的历史计数写作最新结果。

## 最新增量候选验证（2026-10-07）

| 字段 | 值 |
| --- | --- |
| 候选 manifest SHA-256 | `a857d20fa11ac35e72eea8105bdd145733e2782f750d6532291867bc8fc4ae15` |
| 覆盖的变更生产输入 | 1（artifact path implementation，相对 base commit） |
| Candidate base HEAD / branch | `6ae8b7c46cb30089b576f08370c7a0de4779d3ba` / `codex/actlume-pi-migration` |
| Windows/Linux release dry-run | Current incremental candidate `a857d20f…c4ae15`: Windows `npm run ci` passes 192 tests and 16 benchmarks, plus production package smoke. Exact source commit `fa4ba7d` passed the hosted Windows and Ubuntu jobs in [run 37503514367](https://github.com/xiaoyao6657/ACTLUME-AGENT/actions/runs/37503514367), including full CI and package smoke. Preceding candidate `e34d0393…cc03` also passed local Windows and Ubuntu 24.04 WSL2/ext4 native Linux release dry (192 tests, 16 benchmarks, 116-file pack). |
| Windows/Linux deterministic protocol | Nine independent oracle cards pass on current Windows candidate `a857d20f…c4ae15` and preceding Ubuntu native Linux candidate `e34d0393…cc03`; reports are `.agent-benchmark/protocol-runs/candidate-a857-<task>.json` and `.agent-benchmark/linux-ci/protocol-runs/summary-final-e34d0393-native.json`. These validate harness/runtime contracts only. |
| Windows/Linux package smoke | Production-only package smoke passes on current Windows candidate `a857d20f…c4ae15`; both hosted packages also passed on exact source commit `fa4ba7d` in run `37503514367`. Preceding candidate `e34d0393…cc03` passed both Windows and Ubuntu native Linux package smoke. |
| Fixture/oracle preflight | Windows preflight on current candidate `a857d20f…c4ae15` and native Linux preflight on preceding candidate `e34d0393…cc03` calibrate 15 fixture/oracle pairs; no Agent task quality is measured. |
| Windows/Linux TUI smoke | Automated Linux PTY input/resize/exit, deterministic-provider approval denial, and interruption/recovery transcript were recorded on preceding candidate `e34d0393…cc03`; human Windows/Linux IME, focus, long-history, visual checks and continuous recording remain pending. |
| 真实模型 campaign | Bounded provider smoke, development 24/24 and post-freeze confirmation 8/8 ran on `eb941e32…36c4ca`, not current candidate `a857d20f…c4ae15` (four production-input changes since the campaign). Usage was complete, outcomes mixed, provider revision/sampling unknown, and confirmation cards reused; no strategy-benefit conclusion follows. |
| Hosted CI / 人工矩阵 | Exact source commit `fa4ba7d` passed hosted Windows and Ubuntu jobs in [run 37503514367](https://github.com/xiaoyao6657/ACTLUME-AGENT/actions/runs/37503514367); raw logs are `.agent-benchmark/windows-ci/hosted-fa4ba7d-job.log` and `.agent-benchmark/linux-ci/hosted-fa4ba7d-job.log`. Earlier commit `6ae8b7c` exposed a Windows false rejection from early lexical containment, documented and fixed in the engineering notes. Human Windows Terminal/Linux input matrix and continuous TUI video remain pending. |

更早的 946a、eff97d、0db2ec7a、01372678、c3e044f5、b2ea6ca1、eb941e32、8171b1cd、`e34d0393` 与 `49dd8d0d` 候选报告保留在各自历史路径；它们不是当前增量候选的精确哈希证据。旧 WSL Linux 日志使用 Windows `node.exe`，现已排除；e34 的 native Linux 报告明确由 Ubuntu Node 24.14.1 生成。当前 Windows protocol JSON 的 `candidateWorktreeHash` 为 `a857d20f…c4ae15`，Linux protocol 汇总对应前一候选 `e34d0393…cc03`。所有 deterministic 报告只验 harness/runtime contract，不代表真实模型质量。
