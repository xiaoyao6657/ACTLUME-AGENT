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

## 最新第二轮候选验证（2026-10-07）

| 字段 | 值 |
| --- | --- |
| 候选 manifest SHA-256 | `e34d0393be5931f6de41c029c46139f3ae493c8a2f54afc2be805c9a9fddcc03` |
| 覆盖的变更生产输入 | 4（相对基线 HEAD） |
| Candidate base HEAD / branch | `0829c3a543a67f82065b8d5f6051693f59ad8261` / `codex/actlume-pi-migration` |
| Windows/Linux 本地 release dry-run | Current candidate `sha256:e34d0393be5931f6de41c029c46139f3ae493c8a2f54afc2be805c9a9fddcc03` passes Windows and Ubuntu 24.04 WSL2/ext4 native Linux typecheck, 192/192 tests, 16/16 benchmarks, and npm pack (116 files). Logs: `.agent-benchmark/windows-ci/ci-final-e34d0393.log` and `.agent-benchmark/linux-ci/release-dry-final-e34d0393-native.log`. |
| Windows/Linux deterministic protocol | Nine cards pass independent oracles on both platforms for current candidate `e34d0393…cc03`; Windows summary `.agent-benchmark/protocol-runs/summary-final-e34d0393-windows.json`, Linux summary `.agent-benchmark/linux-ci/protocol-runs/summary-final-e34d0393-native.json`. These validate harness/runtime contracts only. |
| Windows/Linux package smoke | Production-only package smoke passes on both platforms for candidate `e34d0393…cc03`; logs `.agent-benchmark/windows-ci/package-smoke-final-e34d0393.log` and `.agent-benchmark/linux-ci/package-smoke-final-e34d0393-native.log`. |
| Fixture/oracle preflight | Windows and native Linux preflight 15 fixture/baseline-oracle pairs for `e34d0393…cc03`; no Agent task quality is measured. Reports `.agent-benchmark/windows-ci/fixture-preflight-final-e34d0393.json` and `.agent-benchmark/linux-ci/fixture-preflight-final-e34d0393-native.json`. |
| Windows/Linux TUI smoke | Current candidate `e34d0393…cc03` passes native-Linux PTY input/resize/exit, deterministic-provider approval denial, and interruption/recovery transcript; reports under `.agent-benchmark/demo/tui-pty-matrix-e34d0393-native/`, `.agent-benchmark/demo/tui-approval-pty-e34d0393-native/`, and `.agent-benchmark/demo/interrupt-recovery-e34d0393-native.*`. Drivers isolate Pi configuration and MCP. Human Windows/Linux IME, focus, long-history, visual checks and continuous recording are pending. |
| 真实模型 campaign | Bounded provider smoke, development 24/24 and post-freeze confirmation 8/8 ran on `eb941e32…36c4ca`, not the current `e34d0393…cc03` source (four production-input changes since the campaign). Usage was complete, but outcomes were mixed, provider revision/sampling unknown, and confirmation cards reused; no strategy-benefit conclusion follows. |
| Hosted CI / 人工矩阵 | PR #1 previous run: Ubuntu passed; Windows failed on artifact path canonicalization. The fix is in `e34d0393…cc03`; latest PR hosted rerun is pending. Human Windows Terminal/Linux input matrix and continuous TUI video remain pending; automated Linux PTY evidence is above. |

更早的 946a、eff97d、0db2ec7a、01372678、c3e044f5、b2ea6ca1、eb941e32 与 8171b1cd 候选报告保留在各自历史路径；它们不是当前候选的精确哈希证据。旧 WSL Linux 日志使用 Windows `node.exe`，现已排除；当前的 native Linux 报告明确由 Ubuntu Node 24.14.1 生成。当前候选的 Windows/Linux 九卡 JSON `candidateWorktreeHash` 均与本表 hash 一致。所有 deterministic 报告只验 harness/runtime contract，不代表真实模型质量。
