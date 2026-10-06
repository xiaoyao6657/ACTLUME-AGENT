# Actlume 改造验收评估（2026-10-05）

## 结论与评估范围

**当前没有达到 `ACTLUME-REFACTOR-PLAN.md` 第 16 节定义的 M0–M5 第一版完成标准。** 已完成 Pi 主链路接入，并形成有测试支撑的工具、记忆、验证和事件原型；尚未形成经过生命周期、真实任务对照与产品验收的完整交付。

这不是要求推翻现有架构。Pi CLI/RPC + Actlume extension 的分工可以保留，下一步应补齐状态、取消和证据契约，再建立可执行评测。继续增加可选 Trace、多 Agent 或更多记忆层次不能替代这些工作。

本评估审查当前工作区源码、测试、计划和评测目录。HEAD 为 `256e476ef5bdd624526c1ea306c755fd4ad354e7`，工作区存在未提交修改与新增文件；结论针对这些修改在内的当前源码，不代表该提交单独包含全部功能。本次没有调用真实模型，没有更改业务实现，仅新增本评估记录。

此前“可独立推进的工作已完成”的表述过宽：下面的状态恢复、取消传播、回放处理、评测夹具和配置对照等仍属于可在本地继续完成的工作，并非都受外部服务阻断。

## 本轮验证证据

重新执行 `npm run ci`，退出码 0：

- TypeScript 类型检查通过。
- 128/128 项测试通过，无跳过。
- 16/16 项确定性功能 smoke 通过。

这些测试包含旧 Runtime 的解析器、工具和 Guardrails 测试，也包括 Pi 入口与 mock-provider 集成测试。不能把全部 128 项视为新 Runtime 的端到端验收，更不能当成真实模型任务成功率。

另外通过本地函数及工具适配器探针确认了三项未覆盖的问题：

| 探针 | 实際观察 | 证明的范围 |
| --- | --- | --- |
| 空检查分类 | `classifyVerificationCommand('echo npm test')` 返回 `test`；向判定器提供退出码 0、匹配指纹的记录后返回 `verified` | 命令文本匹配与当前证据判定可把未执行测试的命令当作通过检查；不是一次真实模型任务 |
| 配对实验条件不一致 | 同一 task/repeat 的两条记录使用不同 model/revision、commit、environment、promptHash，仍得到 `paired: 1`、`candidateWins: 1`、`resolveRateDelta: 1` | 汇总器未验证控制变量，不能直接保证消融归因有效 |
| shell 取消 | 调用真实 Pi 工具适配器执行 `node -e "setTimeout(console.log, 800, 42)"`，50ms 后中止传入 signal；约 1182ms 后仍输出 `42`，`isError: false`、退出码 0 | 本地 shell 路径没有响应传入的取消信号；未覆盖整套 TUI、OS 强制终止或 Windows 后代进程树 |

## 各阶段判定

| 阶段 | 判定 | 已有成果 | 阻止完整验收的主要事项 |
| --- | --- | --- | --- |
| M0 基线与接入 | 部分达到 | Pi 1.0.2 固定、入口和 mock-provider 夹具、包产物 | 干净生产安装后启动、真实 API smoke 未证实 |
| M1 Runtime 与会话 | 部分达到 | TUI/RPC 统一执行层、工具适配、事件和历史文本导入 | 领域状态未按会话活动分支恢复；每次 prompt 重建 plan/history/baseline；取消未贯通本地工具 |
| M2 终端产品 | 部分达到 | Pi 原生 TUI、审批入口、Actlume 命令与状态 | 取消契约仍有代码缺口；IME/粘贴/焦点/尺寸人工矩阵、进程树回收与演示未验收 |
| M3 验证与策略 | 部分达到 | Git 指纹、检查记录、过期检测、单次补验提示、旧策略适配 | 检查真实性/覆盖范围不足；策略未形成独立配置对照；旧回放仍假定缺失结果成功 |
| M4 记忆与上下文 | 部分达到 | 来源元数据、候选/激活/复核、文件哈希失效、关键词召回、注入预算、artifact 回读 | task/worktree scope 尚未实现适用召回；分支与需求修订隔离、冲突/替代关系和跨任务收益未验收；预算仅覆盖注入层 |
| M5 评测与发布 | 未达到 | JSONL 汇总器、10 张场景卡、本地 CI、Windows workflow 配置 | 没有可执行任务夹具、独立 oracle、runner、策略开关、重复模型运行及报告；配对条件校验缺失 |
| M6 可选协作 | 原型 | 独立只读 Pi 子 session、工具过滤、预算与结构化返回 | 未证明协作收益；工具 allowlist 与 Pi 自动扩展加载之间的边界需要封闭和测试 |
| M7 可选 Trace | 原型 | 本地事件、OTLP JSON 导出、mock collector 测试 | 非 OTel SDK instrumentation；远端接收、退出 flush、丢失/HTTP 错误观测与因果链未验收 |

M6、M7 为可选扩展，Worktree 写任务属于后续范围。它们未完成本身不应作为 M0–M5 第一版失败的理由；核心缺口已经足以说明目前未通过验收。

## 具体缺口与后果

### 1. P0：恢复的是 transcript，尚未恢复任务领域状态

[pi-runtime.ts:273](D:/workspace/actlume-agent/src/pi-runtime.ts:273) 在 `before_agent_start` 无条件新建 run ID、清空 assessment、重建 `PiRunWorkflow`，并在第 286 行重新捕获工作区基线。[pi-workflow.ts:15](D:/workspace/actlume-agent/src/pi-workflow.ts:15) 的 plan、变更和检查历史驻留内存。

[pi-runtime.ts:550](D:/workspace/actlume-agent/src/pi-runtime.ts:550) 的 `session_start` 检查未结束 run 并记录 interrupted、提示核验副作用，但没有从活动会话分支恢复这些状态。结果命令也读取当前闭包里的 assessment，而非重建持久化状态。

后果：

- 在上一轮写出的计划可能仍在磁盘，但下一轮使用新 run ID 访问另一份 plan 文件，不能据此宣称计划连续恢复。
- 中断前已经做出的修改，在恢复后被纳入新 baseline，可能不再计入该次任务变更及补验要求。
- Pi 对话分支、需求修订与 verification 的归属没有统一的活动分支重建协议。
- 启动时知道“有过中断”不等于恢复到最近确定任务状态。

应实现带 schema 版本的 task/run/branch checkpoint 或可重建的领域事件，区分一次模型运行与跨多轮任务，保留原始 baseline，并对分支切换重建约束、计划和证据。验收必须包括重启前后结果一致和真实进程中断。

### 2. P0：取消没有贯通本地 shell

[pi-runtime.ts:799](D:/workspace/actlume-agent/src/pi-runtime.ts:799) 的本地工具 `execute(toolCallId, args)` 未接收/传递 Pi signal；[shell.ts:64](D:/workspace/actlume-agent/src/tools/shell.ts:64) 仅配置命令 timeout，没有取消信号或进程树终止协议。

本轮真实工具适配器探针证实，中止 signal 后命令仍成功完成。不能把 Pi 宿主提供取消交互等同于 Actlume 工具已经停止。文件或外部操作仍在进行时，需要区分 cancelling、cancelled 和 unknown。

应把 signal 贯通 ToolContext 与工具执行，针对 shell 实现并验证 Windows/Linux 进程回收；副作用不明时保留 unknown，不能自动重新执行。需要有“取消后不会继续写受控标记文件”的纵向测试，以及 Windows 后代进程测试。

### 3. P0：通过某条检查不足以判定任务满足要求

[verification.ts:87](D:/workspace/actlume-agent/src/verification.ts:87) 用正则搜索命令文本判断检查类型。`echo npm test` 等仅打印关键词的命令会被识别为测试。[verification.ts:163](D:/workspace/actlume-agent/src/verification.ts:163) 接受当前 run 任意一个成功、指纹一致的检查，因此可以进入 `verified`。

还存在计划要求尚未覆盖的证据字段和语义：

- syntax/lint/build/test 的适用范围不能互相替代，但当前成功记录选择未检查任务所需检查集合。
- 没有任务需求、检查覆盖范围和测试环境指纹参与 outcome。
- [pi-runtime.ts:837](D:/workspace/actlume-agent/src/pi-runtime.ts:837) 记录的 cwd 固定为 workspace，而 shell 支持独立 `args.cwd`，可能记错真实检查目录。
- VerificationRecord 没有直接绑定 stdout/stderr artifact 引用。
- 检查后才捕获版本；并发编辑和检查间的一致性还需要专门验收。

应明确区分“当前版本有检查通过”与“任务已由验收条件确认”，配置任务需要的检查及范围，并使用独立 oracle 评估任务正确率。不要把增加更复杂的正则当作独立验收器的替代。

### 4. P1：旧回放仍把缺失结果当作成功

[replay-run.ts:139](D:/workspace/actlume-agent/scripts/replay-run.ts:139) 仍返回：

```ts
{ ok: true, content: "Replay assumed success because no tool_result was found." }
```

这是计划明确要求改成 unknown、但尚未完成的内部任务。它位于旧轨迹回放路径，不等于所有 Pi 实时工具都假报成功；然而会污染历史行为分析，尤其是中断轨迹和旧策略收益解释。应在回放状态中保留 unknown，禁止产生成功编辑/通过检查证据。

### 5. P1：Eval 目前是汇总器与设计卡，没有可执行实验

[dev-v1.md:3](D:/workspace/actlume-agent/evals/tasks/dev-v1.md:3) 明确写着 frozen task cards、not executed。`evals` 只有 README 和场景卡，没有 fixtures、oracles、runners 或结果报告。

[eval-harness.ts:152](D:/workspace/actlume-agent/src/eval-harness.ts:152) 配对仅依据 taskId/repeatIndex；本轮探针证实不同模型、commit、环境和 prompt 仍被比较。当前 bridge config 也没有供同一宿主独立启停 Guardrails、记忆和压缩策略的配置。

应先物化确定性夹具与隐藏 oracle，建立隔离 runner、事件到结果的自动转换、条件开关和控制变量校验，再运行固定真实模型的交错重复实验。报告必须保留失败、未知 verdict/usage、样本分母、额外成本和误拦截。没有这些产物，就不能使用 Resolve Rate、消融收益或恢复成功率的简历结果。

### 6. P1：记忆 scope 元数据尚未形成完整作用域协议

[memory.ts:108](D:/workspace/actlume-agent/src/memory.ts:108) 直接排除 task/worktree 记忆，不能针对当前 task/worktree 召回；结构中也没有相应身份或活动会话分支引用。`supersedes` 有序列化字段，但没有据此使被替代记忆退出召回的处理。

已实现的文件哈希失效有价值，应保留。缺口集中在需求修改、分支 A/B 和新旧结论冲突等计划验收场景，而不是必须新增向量数据库或更多“记忆层”。

[context-budget.ts:27](D:/workspace/actlume-agent/src/context-budget.ts:27) 只限制项目指令与检索记忆的注入层，Token 按字符/4 估计。不能将它描述成对近期消息、当前约束、任务状态和工具证据的完整上下文分配；长会话压缩目前主要依赖 Pi 原生机制。

### 7. P1：产品与发布仍缺验收

目前 `/actlume-doctor` 展示配置字符串和注册工具数量，[pi-runtime.ts:774](D:/workspace/actlume-agent/src/pi-runtime.ts:774) 没有检查模型、shell、MCP、数据目录的实际可用能力。

计划记录 npm 生产安装受 registry TLS 主机名错误阻断，本轮没有重新尝试，不能把它判断为确定的产品安装缺陷，也不能认为干净安装已经通过。Windows workflow 文件存在不等于远端 runner 已成功；工作区测试的 `--help` 不等于临时目录里生产安装后的包入口验收。

`package.json` 仍有多个运行时依赖使用 `latest`。仓库 `npm ci` 可以使用 lockfile，但发布包的消费者不会因此自动得到同一套依赖，应建立明确的发布依赖与升级策略。

还需完成终端验收矩阵、生产产物安装后 help/非交互/入口 smoke、真实模型 smoke 与可复现演示。

### 8. P2：可选协作与 Trace 还需收敛边界

`allowedTools` 过滤 Actlume 注册工具，但 [pi-runtime.ts:85](D:/workspace/actlume-agent/src/pi-runtime.ts:85) 没有禁用其他 Pi 扩展自动发现或设置全部工具的最终 allowlist。已安装 Pi 的 resource-loader 在默认模式下合并显式与发现的扩展路径。这意味着子 Agent 的工具边界仍依赖外部 Pi 配置，需要封闭后增加第三方扩展场景测试；本轮未用第三方扩展复现绕过。

[otel-exporter.ts:44](D:/workspace/actlume-agent/src/otel-exporter.ts:44) 忽略 HTTP response 状态，[runtime-events.ts:101](D:/workspace/actlume-agent/src/runtime-events.ts:101) 异步 fire-and-forget，没有显式 flush/丢失统计。Span 支持 run、tool、child 关联，但不能据此宣称托管 Langfuse 中完整的 Agent → LLM → Tool 因果链已验收。

## 第一版完成标准逐项核对

| 计划第 16 节标准 | 当前结果 |
| --- | --- |
| 干净环境能安装并进入终端主屏 | 未证实；本地入口已测试，生产安装验收受阻 |
| 持续多轮、证据、审批、取消并正确恢复 | 部分实现；领域恢复与本地工具取消不满足 |
| 真实跨任务经验复用，前提变化后重新验证 | 机制测试部分通过，真实跨会话任务未验证 |
| 完成状态、界面、持久化和评测含义一致 | 未通过；恢复重置、检查语义与评测连接仍有缺口 |
| 原生 Pi 基线下单独开关策略并展示收益或局限 | 未完成开关与可执行对照实验 |
| 功能和简历结果对应实现、测试或实验产物 | 部分可对应；真实收益与完整验收不能声称 |

## 建议补齐顺序

1. **先修生命周期契约**：跨多轮 task 身份、活动分支领域状态、原始 baseline、恢复结果与工具取消。用真实进程中断和受控副作用验证，不仅模拟 handler。
2. **修证据与状态语义**：实际 cwd/检查范围、任务所需检查、独立 outcome、unknown 回放，以及 UI/JSONL/退出状态的一致性。
3. **实现可执行 Eval**：先选少量核心场景跑通 runner 与 oracle；增加策略独立开关、严格控制变量配对，然后覆盖 10 张卡并建立保留任务。
4. **完成记忆作用域与失效场景**：需求修订、分支隔离、替代关系和跨会话经验复用，纳入上述 Eval。
5. **完成产品/发布验收和真实实验**：干净包安装、Windows 进程回收与 TUI 矩阵、重复真实模型运行、原始轨迹与公开报告。
6. **最后按收益决定 M6/M7 投入**：可选协作和远端 Trace 不抢占核心状态与评测工作。

## 当前可以支持的简历表达

可以准确描述：基于 Pi CLI/RPC 接入终端交互与模型执行；开发 Actlume 工具/权限适配、结构化事件、文件哈希驱动的记忆复核和代码指纹关联的检查记录；128 项测试与 16 项确定性功能 smoke 通过。需要说明测试总数包含旧模块，并明确 TUI/基础 session 能力复用 Pi。

暂不能描述为已完成：可靠的跨分支任务状态恢复、完整上下文治理、真实 GitHub Issue Eval Harness、消融证明的收益、写任务 Worktree 协作，或已验收的 OpenTelemetry + Langfuse 全链路追踪。

项目价值需要通过“实际失败 → 机制改进 → 固定条件下效果及代价”的证据链来建立。当前已经有可用的机制起点，尚缺这个证据闭环。
