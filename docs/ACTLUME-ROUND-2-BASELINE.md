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

## 最终第二轮候选验证（2026-10-06）

| 字段 | 值 |
| --- | --- |
| 候选 manifest SHA-256 | `1897300da47ce4047a5cddbb0af6b4e1efb3dc3862e7c05ddd22e1145e59677f` |
| 覆盖的变更生产输入 | 126 |
| Git HEAD / 分支 | `256e476ef5bdd624526c1ea306c755fd4ad354e7` / `codex/actlume-pi-migration` |
| Windows/Linux 本地 release dry-run | 当前候选 Windows 和 Ubuntu 24.04 WSL2/ext4 原生 Linux 均通过 typecheck、191/191 tests、16/16 benchmarks、npm pack 116 文件；最新 Windows log `.agent-benchmark/windows-ci/release-dry-1897300d-current-final.log`，native Linux log `.agent-benchmark/linux-ci/release-dry-1897300d-native-ext4.log`。Windows dry pack 中未包含 `docs/support` 人工/PTY 验收脚本 |
| Windows/Linux deterministic protocol | 九张卡两端均在当前候选下通过独立 oracle 9/9；Windows 报告前缀 `.agent-benchmark/protocol-runs/final-1897300d-`，汇总 `.agent-benchmark/protocol-runs/summary-1897300d.json`；Linux 报告前缀 `.agent-benchmark/linux-ci/protocol-runs/final-1897300d-native-`，汇总 `.agent-benchmark/linux-ci/protocol-runs/summary-1897300d-native.json`；数据类别 `protocol-validation-only` |
| Windows/Linux package smoke | 当前候选的 Windows 与 Ubuntu 24.04 WSL2/ext4 原生 Linux均通过 production-only 安装、CLI help、mock 任务、resume 和打包 protocol/oracle；报告分别为 `.agent-benchmark/windows-ci/package-smoke-1897300d.json` 和 `.agent-benchmark/linux-ci/package-smoke-1897300d-native-ext4.json` |
| Fixture/oracle preflight | 当前候选两端对 15 张任务 fixture 完成 unchanged baseline/positive-reference 校准；不运行 Agent、不测任务质量。Windows `.agent-benchmark/windows-ci/fixture-preflight-1897300d.json` 与 Linux `.agent-benchmark/linux-ci/fixture-preflight-1897300d-native.json`。此前由 Windows Node 运行的 WSL preflight 不计为 Linux 证据 |
| Windows/Linux TUI smoke | Windows PowerShell 与 Linux 80×24 启动、扩展、Unicode/多行粘贴、Ctrl+C/Ctrl+D exit 0 的观察来自 README-only 前一版 `8171…e831`：`.agent-benchmark/windows-ci/tui-matrix-8171.{json,log}` 与 `.agent-benchmark/linux-ci/tui-matrix-8171-native.{json,log}`。最终候选 `189…677f` 另通过原生 Linux 自动 PTY 80×24→120×40、Unicode/emoji 多行 paste、Ctrl+C/Ctrl+D、exit 0 和 terminal mode 恢复（`docs/support/tui-pty-smoke.py`），以及 deterministic provider 审批拒绝测试（`docs/support/tui-approval-pty-smoke.py`；No 拒绝、command 未执行、exit 0）。报告/raw transcript 分别在 `.agent-benchmark/demo/tui-pty-matrix-1897300d-native/`、`.agent-benchmark/demo/tui-approval-pty-1897300d-native/`。这些不验证真人 OS IME、审批焦点体验、长历史、视觉渲染或视频 |
| 真实模型 campaign | bounded provider smoke、development `round2-core-dev-eb941e32` 的 24/24 与 post-freeze confirmation `round2-holdout-eb941e32` 的 8/8 均在候选 `eb941e32…36c4ca` 上运行，usage 完整。该候选和当前 `189…677f` 的生产输入清单仅 `README.md` 与 `README.en.md` 不同。结果混合，provider revision/sampling unknown，确认卡片复用此前实验，没有策略收益结论。此前 `c3e044f5` campaign 在 4 次后因 1 个 usage unknown 停止，20 次未启动、174,281 known tokens；更早 `01372678…2580` 在 6 次后停止，18 次未启动、279,106 known tokens |
| Hosted CI / 人工矩阵 | workflow 只响应 push main/PR main；本地分支未推送，远端分支枚举只有 main，故 GitHub Actions 未运行。Windows Terminal/Linux 的完整人工输入矩阵及交互 TUI 视频仍 pending；自动 PTY 部分记录见上行 |

更早的 946a、eff97d、0db2ec7a、01372678、c3e044f5、b2ea6ca1、eb941e32 与 8171b1cd 候选报告保留在各自历史路径；它们不是当前候选的精确哈希证据。旧 WSL Linux 日志使用 Windows `node.exe`，现已排除；当前的 native Linux 报告明确由 Ubuntu Node 24.14.1 生成。当前候选的 Windows/Linux 九卡 JSON `candidateWorktreeHash` 均与本表 hash 一致。所有 deterministic 报告只验 harness/runtime contract，不代表真实模型质量。
