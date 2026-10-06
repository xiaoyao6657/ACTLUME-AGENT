# actlume

`actlume` 是一个 TypeScript 本地 Coding Agent。Pi 提供模型循环、会话 transcript 和终端 TUI；Actlume 承担项目上下文、工具权限、记忆生命周期、工作流状态与验证证据。

## 当前能力

- 无参数启动进入 Pi TUI；TTY 中的位置任务作为首条消息进入 TUI，脚本和管道环境通过 Pi RPC 执行。
- Actlume 的本地工具通过 Pi 工具接口注册，保留参数校验、结构化错误和现有 MCP 配置。
- 加载 `ACTLUME.md` / `CLAUDE.md` 与 `.actlume/rules/*.md`；记忆带类型、作用域、来源、状态和可选文件指纹。
- 新记忆默认为候选项；旧格式记忆会标记为待复核。用户可在 TUI 用 `/actlume-memory promote <filename>` 显式启用记忆。
- 权限钩子覆盖只读限制、工具 allow/deny、shell 风险与敏感路径；需要确认但没有交互 UI 时会拒绝执行。
- Pi 路径按 run 隔离 workflow plan 与工具历史，执行探索预算和重复失败策略；有变更而缺少当前通过的验证时，会要求继续验证或明确报告未验证。
- 结构化事件关联 session、run、agent 和 tool call；只有匹配 `.actlume/checks.json` 中 `CheckSpec` 的命令，才会建立绑定工作区、环境和任务的检查证据。通过检查仅代表对应范围和指纹下的命令成功，不代表独立需求验收通过。
- `/actlume-memory`、`/actlume-context`、`/actlume-changes`、`/actlume-verify`、`/actlume-result` 和 `/actlume-doctor` 提供记忆、上下文、改动、验证及运行结果查看。旧 JSON 会话可由 `/actlume-legacy` 浏览，并用 `/actlume-import <id>` 显式导入为带来源的历史文本。
- 实验性 `scopedResearch` 允许最多三个并行只读子任务，使用独立 Pi session、工具 allowlist、步数/超时预算和父任务取消传播。它限制子任务可调用的工具，不是操作系统或逐路径文件沙箱；本地事件可选导出为带失败诊断的 OTLP/HTTP spans。

## 环境与安装

- Node.js `>=22.19.0`
- npm
- OpenAI 或 OpenAI-compatible API Key

```bash
npm install
```

创建 `.env`：

```powershell
Copy-Item .env.example .env
```

示例配置：

```env
OPENAI_API_KEY=your_api_key_here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4.1-mini
AGENT_MAX_STEPS=10
AGENT_MEMORY_DIR=.agent-memory
# Optional OTLP/HTTP trace export. Add collector authentication with
# ACTLUME_OTEL_EXPORTER_OTLP_HEADERS when required; never commit credentials.
ACTLUME_OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example/otel
ACTLUME_OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20your-token
```

启动：

```bash
npm start
npm start -- --cwd D:\workspace\my-app
```

通过 `npm link` 可注册全局命令：

```bash
actlume "分析这个项目的主要风险"
actlume --plan
actlume --readonly
actlume --yes "修复一个小问题并运行检查"
```

检查本地环境可使用 `actlume --doctor`。它会检查 Node/Pi CLI、shell 启动、数据目录读写、provider 配置和 MCP 连接状态，不会调用模型 API。只有明确运行 `actlume --doctor --probe-provider` 时，才向配置的 OpenAI-compatible endpoint 发送一次最小请求，最多请求 1 个输出 token。

交互式位置任务在 Pi TUI 中运行。非交互环境遇到需要人工审批的动作会阻止该动作；`--yes` 明确启用 bypass 权限。

## 会话与兼容路径

Pi 会话保存在 `.agent-memory/pi-sessions`，事件和验证记录分别保存在 `.agent-memory/events` 与 `.agent-memory/verification`。`--resume` 只接受 Actlume 记录过的 Pi session：

```bash
actlume --resume
actlume --resume <pi-session-id> "继续这个任务"
```

旧 Actlume JSON transcript 不会伪装成 Pi transcript，可通过兼容界面恢复：

```bash
actlume --legacy --resume <old-session-id>
```

旧 ReAct Runtime、旧 session snapshot 和工作流 Guardrails 保留在 `--legacy` 路径中；Pi 主路径使用 Pi 会话，不读写旧版 transcript。

## 开发验证

```bash
npm run typecheck
npm test
npm run benchmark
npm run ci
npm run smoke:package
npm run eval:summary -- evals/runs.jsonl actlume-control=actlume-full
```

`npm run ci` 运行类型检查、测试和确定性 benchmark。`npm run smoke:package` 将 npm tarball 安装到唯一临时 consumer，检查生产入口、headless mock、resume、Pi 工具注册和独立 oracle；报告写入忽略目录 `.agent-benchmark/package-smoke`。Benchmark 在唯一临时目录中建立仓库夹具，清理时只删除本次创建的路径，不会清空仓库里的 `.agent-benchmark`。基础测试、包 smoke 和 Eval protocol cards 使用本地 deterministic provider，不调用真实模型。九张核心卡在 Windows 与 Ubuntu 24.04 WSL2（原生 Linux Node）均通过 protocol/oracle；这些结果只验运行/故障/记录契约。真实模型阶段在 `eb941e32` 源码候选完成 24 次 development 和 8 次 post-freeze confirmation，usage 均完整；当前验收代码 `fa4ba7d` 与实验候选有 4 个 production-input 差异，没有在当前代码上重跑真实模型 campaign。oracle 结果混合、provider revision/sampling 未知，confirmation 还复用了早期任务卡；没有可报告的策略收益或未见任务泛化结论。更早候选的两次 campaign 曾因 usage unknown 提前停止，详见[第二轮实验报告](docs/ACTLUME-ROUND-2-EXPERIMENT-REPORT.md)。运行方式和限制另见 [`evals/README.md`](evals/README.md) 和[架构图](docs/ACTLUME-ARCHITECTURE.md)。

## 主要模块

```text
src/main.ts              CLI 入口与 Pi/兼容路径路由
src/pi-runtime.ts        Pi CLI/RPC、工具适配、审批和扩展策略
src/pi-extension.ts      Pi 加载的 Actlume 扩展入口
src/pi-workflow.ts       run-local workflow state 与探索/失败 Guardrails
src/runtime-events.ts    结构化 session/run/agent/toolCall 事件
src/otel-exporter.ts     可选 OTLP/HTTP trace 映射与导出
src/verification.ts      Git 基线、检查记录和任务证据评估
src/context-budget.ts    项目指令与检索记忆的注入预算
src/memory.ts            版本化记忆、状态、来源和适用性指纹
src/security.ts          权限模式、shell 风险、敏感路径判断
src/agent.ts             旧 ReAct Runtime（仅 --legacy）
src/workflow-guard.ts    旧 Runtime 的编辑工作流 Guardrails
src/mcp-client.ts        旧 MCP 管理器与共享配置读取
src/tools/               Actlume 本地工具
```

## 当前限制

- Pi 的 RPC 和 TUI 已统一使用 Actlume 工具适配，并关闭 Pi 扩展自动发现；Actlume 与 Pi MCP 扩展显式加载。Pi 路径不执行 MCP 配置中的 `startupTimeoutMs` 与自定义 `toolPrefix`，`/actlume-doctor` 会显示迁移诊断；旧 Runtime 仍按旧字段连接。
- Pi 路径仍使用关键词、CJK bigram/trigram 和 substring 记忆召回，没有语义检索；冲突保留待复核，不自动判断真假。
- `AGENT_MAX_STEPS` 在 Pi 路径限制模型回合数。运行状态 settled 只说明 Runtime 停止；任务结果仍需结合改动和对应指纹的验证记录判断。
- 只读 `scopedResearch` 目前最多三项并行研究任务，不提供并行写工作树，也不形成 OS/逐路径隔离；子 Agent 结果仍需父任务核验。
- OTLP exporter 是轻量 OTLP/HTTP spans 序列化器，不是 OpenTelemetry SDK 自动埋点；HTTP/network/timeout 丢失会累计并在 TUI/doctor 显示，本地 JSONL 是事实记录。真实 Langfuse/托管 collector 尚未验收。
- MCP 配置中的 `startupTimeoutMs` 与 `toolPrefix` 暂无 Pi 等价映射；远端副作用 exactly-once 恢复与独立需求验收尚未实现。
- 已运行真实模型 smoke、开发集尝试和 holdout，但 provider revision/sampling 未知、确认集复用任务卡，不能声称 Resolve Rate、记忆收益、策略消融或成本指标已验证。协议卡和汇总器只验运行契约/计算已给定结果，不构成模型收益结果。Windows 与 Ubuntu 24.04 WSL2 原生 Linux已验证进程树取消，并保存了 CLI/PTTY 中断恢复 transcript；托管 GitHub CI、人工 TUI 矩阵和交互 TUI 视频仍待验收。
