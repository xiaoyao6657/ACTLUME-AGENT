# Actlume 第二轮工作规划

日期：2026-10-07。最新验收代码提交为 `fa4ba7d7b99818778616579e72992b6393d8fa5e`；checkout 当前位于 `fdb62942a971a79c806cde6052d1db26d9168e9d`，这是只更新验收文档的后续提交，`src/` 与代码提交完全一致。增量候选 `sha256:a857d20fa11ac35e72eea8105bdd145733e2782f750d6532291867bc8fc4ae15` 相对 base commit `6ae8b7c46cb30089b576f08370c7a0de4779d3ba` 含 1 个 production input（artifact path implementation）。Windows 本机通过 `npm run ci`（192/192 tests、16/16 benchmarks）、`npm run smoke:package`、九卡 protocol/oracle 与 15 卡 fixture preflight；GitHub Actions run [37503514367](https://github.com/xiaoyao6657/ACTLUME-AGENT/actions/runs/37503514367) 验证 `fa4ba7d` 的 Ubuntu/Windows 完整 CI 与生产包 smoke。最新文档提交 `fdb6294` 的 Windows/Ubuntu CI 也通过 run [37504629728](https://github.com/xiaoyao6657/ACTLUME-AGENT/actions/runs/37504629728)。Linux 原生 Node 24.14.1、Pi 1.0.2 下已在干净 checkout 重跑 PTY 输入/resize/退出和确定性审批拒绝；报告见 `.agent-benchmark/demo/tui-pty-matrix-fdb6294-native/`、`.agent-benchmark/demo/tui-approval-pty-fdb6294-native/`。它们的 worktree delta hash `e3b0…b855` 表示零个未提交 production input，不是完整源码哈希；人工 IME/视觉矩阵仍未执行。真实模型 campaigns 在 `eb941e32…36c4ca` 上运行；与最新代码仍有 4 个 production-input 差异，不声称当前代码收益。证据见[任务追踪表](D:/workspace/actlume-agent/docs/ACTLUME-ROUND-2-TASK-TRACKER.md)、[源码基线](D:/workspace/actlume-agent/docs/ACTLUME-ROUND-2-BASELINE.md)、[实验报告](D:/workspace/actlume-agent/docs/ACTLUME-ROUND-2-EXPERIMENT-REPORT.md)和[工程难题记录](D:/workspace/actlume-agent/docs/ACTLUME-ROUND-2-ENGINEERING-NOTES.md)。

依据：[原改造计划](D:/workspace/actlume-agent/docs/ACTLUME-REFACTOR-PLAN.md)、[本轮验收评估](D:/workspace/actlume-agent/docs/ACTLUME-REFACTOR-ASSESSMENT-2026-10-05.md)、[Pi 宿主架构决策](D:/workspace/actlume-agent/docs/adr/0001-pi-cli-runtime.md)。

## 1. 本轮目标与范围

本轮目标是完成原计划 M0–M5 的第一版验收：任务跨多轮和中断后有连续状态，取消有实际执行效果，完成结果有明确证据，记忆有可执行的适用范围，策略效果有可复现实验，普通用户可以从生产包进入终端工作台。

保留 Pi CLI/RPC + Actlume extension 架构。Pi 负责模型循环、唯一 transcript、原生压缩和 TUI；Actlume 负责任务领域状态、执行权限、记忆适用性、检查证据和实验协议。

本轮采用以下范围约束：

- 用确定性故障夹具先证明工程契约，再使用真实模型验证收益。
- 记忆先实现来源、身份、失效、替代和必要的检索；向量数据库不是验收前提。
- 上下文先保留任务约束与证据引用，复用 Pi 压缩；只有实验需要时才增加自定义压缩策略。
- M6 写任务 Worktree、扩大 Agent 数量、托管 Langfuse 接入放在后续可选批次。
- 已开放的只读子任务与 Trace 原型仍需处理边界和错误语义；暂不能完成验收的能力需明确标为实验性。
- 模块拆分服务于状态所有权和独立测试，不进行整个目录结构的机械重写。

## 2. 工作阶段、依赖与交付

| 阶段 | 优先级 | 目标 | 依赖 | 必须留下的交付物 |
| --- | --- | --- | --- | --- |
| R0 | P0 | 固定当前基线、状态和验收契约 | 无 | 基线清单、失败回归用例、状态 ADR、任务追踪表 |
| R1 | P0 | task/run/活动分支的连续状态与恢复 | R0 | 版本化领域记录、恢复投影、多轮/分支/崩溃验收 |
| R2 | P0 | 工具取消、进程回收和 unknown 结果 | R0；集成依赖 R1 | signal 链路、受控副作用夹具、Windows/Linux 取消证据 |
| R3 | P0 | 检查证据、任务结果和回放语义 | R1、R2 | 检查契约、统一结果投影、空检查/过期/回放回归 |
| R4 | P1 | 可执行 Eval 与独立策略配置 | R0；完整运行依赖 R1–R3 | runner、首批 oracle、manifest、策略开关、严格配对 |
| R5 | P1 | 记忆作用域、替代和压缩后连续性 | R1、R3；用 R4 验收 | memory schema 迁移、解释性召回、跨会话/压缩夹具 |
| R6 | P1 | TUI、doctor、生产包与 CI 验收 | R1–R5 | 生产安装 smoke、终端验收矩阵、演示和兼容说明 |
| R7 | P1 | 真实模型重复实验与最终交付报告 | R4–R6 | 冻结任务、原始记录、对照报告、失败案例、简历材料 |
| R8 | P2 | 已有协作与 Trace 原型收尾 | 核心完成后；权限边界提前处理 | 原型验收或明确降级；可选 collector 证据 |

实施以验收门槛推进。夹具和实验协议从 R0/R4 开始建设，不等功能全部实现再设计评测。文档、夹具准备可以提前进行；涉及同一状态存储或事件协议的修改必须按依赖顺序集成。

不沿用原来的 18–26 个有效开发日作为本轮承诺。恢复与 Windows 进程回收的首个纵向原型通过后，再根据实际剩余任务更新工作量；实现、真实实验和人工产品验收分别记录耗时。

## 3. R0：基线、契约与失败回归

### 工作

- [x] R0-01 记录包含未提交修改的候选源码快照、Node/Pi/依赖版本、现有命令和测试；不能仅用旧 HEAD 标识候选版本。
- [x] R0-02 将本轮三个探针变成回归测试：取消 signal 被忽略、空命令检查、不同控制变量的错误配对。
- [x] R0-03 增加多轮计划丢失、恢复后 baseline 重置、缺失工具结果的回放用例。
- [x] R0-04 写领域状态 ADR，明确 source of truth、task/run 生命周期、分支恢复和持久化边界。
- [x] R0-05 给事件、验证记录、memory 和 Eval schema 列出版本迁移规则；旧数据信息不足时保持 unknown/needs_review。
- [x] R0-06 为每项任务建立状态：todo / implementing / implemented / verified / externally_blocked。implemented 不等于 verified。

### 验收

失败用例应在当前实现上稳定暴露对应问题，修复后同一用例通过。已有 128 项测试和 16 项功能 smoke 保持可运行，并分别标记旧协议、策略单测、Pi 集成与模型实验的用途。

测试必须检验外部行为或数据契约，不通过简单复制实现得到“预期结果”。失败用例作为开发检查运行；未修复前不把它们伪装为通过的发布门槛。

## 4. R1：跨多轮 task、会话分支与领域状态恢复

### 4.1 身份与状态所有权

| 身份 | 含义 | 生命周期 |
| --- | --- | --- |
| workspaceId | 规范化工作区身份，另记录 repo/worktree 信息 | 切换工作区必须隔离 |
| sessionId | Pi 对话树 | 由 Pi 管理 |
| taskId | 一项跨多轮用户目标 | 用户开启新任务或明确关闭时切换 |
| runId | 一次执行 attempt，可有多个模型 turn | 每次 attempt 新建，不替换 task baseline |
| entryId / parentId | Pi 树中领域记录的位置与祖先关系 | 按活动分支重建 |
| agentId / toolCallId | 执行者和具体工具调用 | 用于结果及副作用归属 |

定义 TaskState：schemaVersion、taskId、workspace/session/agent 身份、原始 baseline、当前要求及 revision、计划和进度、检查引用、未决工具、最近 outcome、关联来源 entryId。

明确输入语义：steering 补充当前任务；普通继续输入属于尚未关闭的当前任务；提供显式新任务/关闭命令，排队消息携带继续或新任务意图。不能依赖模型自行猜测 task 边界，也不能每个 prompt 都自动丢弃旧状态。最终命令名和兼容映射在本阶段确定，并同步帮助信息。

### 4.2 存储选择

采用 **Pi 活动分支中的版本化 custom entries 作为领域事实源**。当前固定版本公开提供 extension `appendEntry` 及只读 SessionManager 的 `getBranch`、`getLeafId`；实际持久化时机仍必须通过进程终止夹具验证。

- 将原始 baseline、要求修订、计划变更、工具意图/结果、验证引用和任务结束写入领域记录。
- 使用 reducer 重建活动分支 TaskState；事件 JSONL 和快速缓存仅作为可重建投影，带来源 entryId/领域事件 ID。
- 工具并行执行可以保留，但领域事实由单一串行所有者追加，使用单调 sequence 和调用身份处理乱序结束。
- 大输出保留 artifact，记录保存 ID、路径和哈希引用，避免复制整个工具结果。
- 恢复时检查 schema、工作区身份、源记录完整性和未决工具；存储损坏给出明确状态，不能悄悄重置为成功。
- 进程强制终止可能产生未完整落盘记录：恢复到最近确定 checkpoint，受影响副作用为 unknown。验证进程崩溃语义，不承诺断电后的任意 fsync 持久性。

### 4.3 会话树与文件系统的关系

在 session_start、活动树切换和 fork 后重建领域状态；分支定位使用 entry ancestry，不能只按 sessionId 扫描整个历史。fork 继承祖先约束和计划，后续记录由新 session/attempt 归属。

**Pi 对话分支切换不会自动回滚磁盘文件。** 新活动分支的验证记录必须和当前真实工作区及环境比较，不因切换回旧对话分支恢复“通过”状态。Git checkout 与 Pi 对话树分别处理和展示。

### 工作

- [x] R1-01 引入 task 状态 reducer、领域 schema 与唯一写入入口。
- [x] R1-02 移除 before_agent_start 对 task baseline/plan 的无条件清空；仅新建 run。
- [x] R1-03 plan 文件按 task/branch 身份关联，迁移 writePlan/readPlan/updatePlan。
- [x] R1-04 检查 task tracker 的作用域与并发写入，不让无关 session 互相修改执行进度。
- [x] R1-05 接通启动、树切换、fork、重启和未决工具恢复。
- [x] R1-06 result/changes/verify 命令从统一活动投影读取，而非临时闭包。

### 验收

| 场景 | 必须观察到的结果 |
| --- | --- |
| 两轮完成同一任务 | 原计划、要求和 baseline 保留，runId 不同、taskId 相同 |
| 正常退出后恢复 | task 投影与退出前一致，验证按当前版本重新判断 |
| 修改后、验证前强制终止 | 修改仍属于原 task，恢复后必须显示尚未验证 |
| 分支 A/B 有冲突要求 | 活动投影仅采用当前 ancestry，废弃分支要求不注入 |
| 对话树切换但磁盘已变 | 旧验证过期，明确显示磁盘与历史证据差异 |
| workspace/session/agent 切换 | 无关任务的计划、检查和未决工具不串入 |

## 5. R2：取消与副作用协调

### 工作

- [x] R2-01 将 AbortSignal、task/session/call 身份贯通 Pi adapter → ToolContext → 工具执行。
- [x] R2-02 shell 区分正常退出、超时、取消和启动失败；记录实际 shell/cwd，避免取消被编码成普通可重试失败。
- [x] R2-03 实现平台对应的进程树终止和退出确认。Windows 子进程树夹具通过；Ubuntu 24.04 WSL2 原生 Linux 在候选 `e34d0393…cc03` 下 protocol `interrupt-recovery-01` 确认受控进程停止、同一 session/task 恢复且没有重放写入。当前候选 `a857d20f…c4ae15` 的 Windows 九卡协议也通过；Linux 最新 hosted runner 由 R6-07 验证。
- [x] R2-04 文件工具在执行前检查取消；已经执行的写入保留真实结果，不因 signal 到来假称撤销。
- [x] R2-05 检查 Pi MCP 的取消支持与实际副作用；远端确认不足时记录 unknown。
- [x] R2-06 父取消传给只读子任务；不确定的执行结果不得自动重试或写入长期有效记忆。
- [x] R2-07 审批等待期间取消应关闭交互、拒绝执行并记录真实状态。

Runtime 状态约束：收到请求后进入 cancelling；确认本地执行停止后才能进入 cancelled。unknown 是工具结果确定性维度，可以与 cancelled/interrupted runtime 同时存在，不混成一个布尔值。

### 验收

真实启动受控子进程：在取消后等待超过其预定写入时间，标记文件仍未产生；父子进程均已退出。真实终止 runtime 后恢复会话，已经存在的受控副作用不会被无条件执行第二次。

覆盖已取消 signal、执行中取消、审批中取消、超时、子进程再派生进程、远端响应不明。Windows 与 Linux 均提供日志/PID/结果证据；不能只在函数内 throw 或手动调用 session_start。

## 6. R3：检查证据、结果语义与回放

### 6.1 三类结果分开

| 维度 | 示例 | 判定依据 |
| --- | --- | --- |
| RuntimeStatus | completed / cancelled / interrupted / failed / budget_exhausted | 宿主与实际执行状态 |
| EvidenceStatus | unchecked / checks_passed / checks_failed / stale / unknown | 指定范围和版本的检查记录 |
| TaskVerdict | accepted / rejected / unjudged | 明确验收器或人类验收，记录来源 |

模型结束输出只能说明执行结束。普通开发场景通过配置检查后显示 checks_passed；没有需求验收依据时，TaskVerdict 仍为 unjudged。Eval 的 hidden oracle 在模型运行结束后独立执行。

旧 `verified` 数据保留原语义及 schema，不自动升级为 accepted。UI、JSONL、恢复投影和 Eval 对这些状态使用同一份定义。

### 工作

- [x] R3-01 增加 CheckSpec：ID、执行 argv/脚本、真实 cwd、检查类型/范围、所需文件和环境条件；自由 shell 文本分类仅作标签提示。
- [x] R3-02 配置 requiredChecks；任务需要的 test 不能被 syntax/lint/build 或其他子目录的成功命令替代。
- [x] R3-03 保存检查前后工作区指纹、环境 manifest、退出原因、stdout/stderr artifact 引用。
- [x] R3-04 解决检查与编辑的竞争：同一任务检查窗口内协调写工具，并检测外部变更；发现不一致时证据 unknown/stale。环境身份记录 runtime、依赖锁和检查配置，不能仅用 Git HEAD。
- [x] R3-05 把未修改任务、已有脏文件、Agent 新提交、Git 分支切换纳入变更归属；不靠“必须有修改”判断成功。
- [x] R3-06 补验提示与 EvidenceStatus 分离，防止不断自动续跑；检查通过后的要求修改触发重新验收。
- [x] R3-07 回放缺失结果变为 unknown，不产生通过检查、成功编辑或策略收益结论。
- [x] R3-08 headless 提供结构化结果。约定退出码：0 表示执行正常结束，不自动表示任务 accepted；1 执行/检查失败；2 预算耗尽；3 审批被拒或需要交互；取消使用平台约定并在 JSONL 保留状态。最终兼容决策写 ADR 和 CLI 文档。
- [x] R3-09 “声明完成”单独记录为模型声明，给出检测依据；含糊文本无法判断时为 unknown，由 Eval 单独计分。

### 验收

`echo npm test`、包含测试关键词的注释/打印、未执行分支、不相关目录检查均不能形成可信测试证据。检查前后编辑、配置变化、需求 revision 变化导致证据失效。旧回放缺结果保留 unknown。运行停止、证据通过和任务验收能够同时呈现不同结果。

## 7. R4：可执行 Eval 与策略对照

### 7.1 对照定义

原生 Pi 参考和因果对照分开记录：

| 配置 | 目的 | 控制条件 |
| --- | --- | --- |
| pi-native（参考） | 展示上游体验和任务表现 | 原生工具/配置如实记录；工具不同的结果不能直接归因为 Actlume 策略 |
| actlume-control | 相同 Pi 宿主和 Actlume 工具下的对照 | 原生会话/压缩、相同权限和证据观察，关闭自研可选策略 |
| actlume-memory | 测量记忆策略增量 | control + 记忆候选/召回/失效策略 |
| actlume-guardrails | 测量效率策略增量 | control + 预先冻结的效率规则集 |
| actlume-full | 观察组合和交互 | memory + guardrails，其他条件一致 |

权限、只读和数据完整性约束始终保持。检查记录和 hidden oracle 对所有条件一致；补验提示、任务专用规则、压缩策略作为明确的独立选项。评价其中一项时只改变这一项；不能把关闭安全边界当作对照。

每条规则具有独立 policyId/version、类别、输入证据、allow/warn/block 和恢复建议。任务专用规则按 manifest 加载，不强加给全部任务。开关由配置显式给出并写入运行 manifest。

### 7.2 首批可执行任务

优先物化原任务卡中的五项：short-regression、verification-claim、interrupt-recovery、memory-transfer、stale-memory。前两项先验证 runner 与 oracle，恢复和记忆任务随 R1/R5 接通。再补 long-context、artifact-recall、requirement-revision、guardrail-retry；parallel-research 作为独立可选协作评测，不阻塞核心九项。截至 2026-10-06，九张核心 fixture/oracle 均在最终候选上通过 Windows 与 Ubuntu 24.04 WSL deterministic Pi RPC protocol；interrupt-recovery 使用外部 runner 强杀进程树并以同一 session/task 恢复。首轮四张 holdout 卡及两张 separately reported supplement 也有独立 oracle；最终候选的 15 张 fixture baseline/reference preflight 通过。此证据只验协议、oracle 与 fixture contract，不代表策略收益；托管 CI 和重复开发集结果分别跟踪。

任务 manifest 包含 fixture revision/hash、完整任务输入、任务 hash、运行序列、约束、检查、hidden oracle、学习/后续阶段、故障 checkpoint 和资源预算。验收器放在 Agent 可访问工作区外，通过外部 runner 注入/执行；真实攻击隔离不作无证据承诺。

每个 attempt 使用唯一临时工作区、session 和 memory store；删除仅限 runner 创建且归属可确认的目录。多会话记忆任务在同一 attempt 内保留学习产物，不跨条件或重复次数共享。

### 工作

- [x] R4-01 引入 PolicyConfig 与规则 ID/版本，完成效率/任务策略分层。
- [x] R4-02 增加 task manifest、fixture materializer 和独立 oracle。
- [x] R4-03 实现 runner：准备 → 执行/故障注入 → 等待结束 → 外部验收 → 采集 → 保存原始结果；九卡 protocol/oracle 在 Windows 当前候选 `a857d20f…c4ae15` 下全部通过，Ubuntu 原生 Linux在前一候选 `e34d0393…cc03` 下 9/9 通过。Windows 报告 `.agent-benchmark/protocol-runs/candidate-a857-<task>.json`；Linux 汇总 `.agent-benchmark/linux-ci/protocol-runs/summary-final-e34d0393-native.json`。这些报告只验证 harness/runtime contract。
- [x] R4-04 事件自动生成 Eval 记录；模型请求、工具请求/实际执行/拦截、重试、usage、压缩辅助调用分别计数。
- [x] R4-05 paired comparison 校验全部不变量：候选代码、任务/fixture、输入 hash、模型/provider/revision、采样参数、权限/工具集、环境、预算与中断协议。
- [x] R4-06 task 输入 hash 与策略/最终 system context hash 分开；记忆注入是预定 treatment，不能因它改变 system prompt 就误判任务不一致，也不能漏记该变化。
- [x] R4-07 model revision 无法固定时如实记 unknown、运行时间/指纹，交错条件，限制结论；未知信息不能伪装为“已固定”。
- [x] R4-08 oracle 未启动或环境失败时 verdict unknown；报告 attempted/judged/pass/fail/unknown，既报告有效样本率，也保留全体尝试的保守结果。
- [x] R4-09 对 unknown 声明、恢复条件和过期记忆暴露分别定义分母；错误完成率不能把未验收样本静默当作正确完成。
- [x] R4-10 使用 deterministic provider 校验 runner 和故障协议，不把 mock 输出算入模型质量数据。

### 验收

从一条命令可运行首批夹具并得到可追溯 JSONL/报告。故意改 model/commit/environment/budget/task hash 后汇总拒绝配对。相同 seed 只能帮助复现，不声称保证模型行为相同。重复 attempt 不污染记忆和文件；中断由真实 OS 进程终止实现。

建议新增命令（实现前不可当作现有功能）：`eval:protocol`、`eval:run`、`eval:report`。将已有 `eval:summary` 保留为汇总入口或给出迁移说明。

## 8. R5：有身份的记忆与上下文连续性

### 工作

- [x] R5-01 memory schema 增加 repository/worktree/task/session/branch applicability 的身份字段；定义用户级记忆存储和同意范围，避免简单混合不同工作区。
- [x] R5-02 task/worktree 记忆按当前身份召回，不再直接排除；没有可判定身份的旧条目保持待复核。
- [x] R5-03 supersedes 真正影响旧条目召回；原子更新状态/索引，冲突保留来源并提出复核，不按时间戳直接决定真假。
- [x] R5-04 要求 revision 变化时撤销依赖旧要求的候选/决策；区分会话分支决策与可跨任务复用的项目经验。
- [x] R5-05 记录 selected/rejected/invalidated 的具体原因；包括 scope_mismatch、stale_file、superseded、needs_review、rank_limit，而非统一标为召回排名低。
- [x] R5-06 根据已确认的检查或用户反馈提出候选，保持候选到 active 的明确信任转换，不凭模型口头成功自动晋升。
- [x] R5-07 在上下文注入中优先保留当前目标、约束 revision、未决工具、计划与证据引用；结构化字段按项保留，不从中间截断关键规则。
- [x] R5-08 压缩后从活动领域记录重建必要状态，artifact 有可调用回读路径；不重新执行历史工具。
- [x] R5-09 /context 区分 Actlume 注入层估计、Pi 会话用量和 provider usage；有模型元数据时按对应限制配置预算，没有 tokenizer 时明确估计及余量。

### 验收

固定学习任务的测试命令能在新 session 的未见任务中召回；相关配置改变后被拒用并重新验证。分支 A 的临时决策不主导分支 B；已被替代的记忆不继续注入。多次压缩后最新要求、计划和未决副作用仍存在，大输出中的指定证据可回读。

任务结束时的候选提议、人工激活和自动适用性判断分别计入实验条件及介入次数。记忆正确率/代价用 R4 oracle 检验，不仅测试字段是否写入。

## 9. R6：终端、诊断与生产发布

### 工作

- [x] R6-01 TUI 的任务、审批、工具、检查和结果视图统一订阅领域投影；重启或切换 session 不显示旧闭包结果。
- [x] R6-02 显示真实任务边界、补充/排队意图、cancelling/unknown、验证过期原因和恢复前待核验事项。
- [x] R6-03 /doctor 检查 Node/Pi 版本、shell 启动、数据读写、MCP 配置/受控连接状态与 provider 配置；真实 API 探针单独显式运行，配置存在与连接成功分开。
- [x] R6-04 关闭未经控制的扩展自动加载，明确接入需要的 Pi 内置扩展（含 MCP）；设置最终工具 allowlist，测试本机/项目额外扩展不能扩大只读子任务工具集。
- [x] R6-05 更新依赖版本与发布策略，移除运行时 latest；先完成生产依赖入口，若编译 dist 会破坏 Pi extension 加载则保留明确的 TS/tsx 运行时方案并验收。
- [x] R6-06 在唯一临时目录安装 npm pack 产物和生产依赖，运行 help、非交互 mock 任务、工具加载、resume 和入口启动。
- [x] R6-07 CI 在 Windows/Linux 执行关键生命周期、进程取消和产物安装 smoke；真实模型实验独立于无密钥 CI。当前提交 `fa4ba7d` 的 hosted [Windows](https://github.com/xiaoyao6657/ACTLUME-AGENT/actions/runs/37503514367/job/112406234554) 与 [Ubuntu](https://github.com/xiaoyao6657/ACTLUME-AGENT/actions/runs/37503514367/job/112406234243) jobs 均通过完整 `npm run ci` 与 `npm run smoke:package`。本地增量候选 `a857d20f…c4ae15` 另通过九卡 protocol/oracle、15 卡 fixture preflight；前一候选 `e34d0393…cc03` 的 Ubuntu 原生 Linux release/package 也已通过。日志保存在 `.agent-benchmark/windows-ci/hosted-fa4ba7d-job.log` 和 `.agent-benchmark/linux-ci/hosted-fa4ba7d-job.log`。
- [x] R6-08 对 MCP startupTimeout/toolPrefix 等旧配置给出迁移诊断，不能静默声称行为等价。
- [ ] R6-09 完成终端矩阵和短演示，同步 README/CHANGELOG/命令帮助/兼容说明。文档/help 已同步。当前代码提交 `fa4ba7d`（文档 checkout `fdb6294`，`src/` 完全一致）已在 Ubuntu 原生 Linux Node 24.14.1/Pi 1.0.2 下重跑自动尺寸/Unicode 多行输入/退出恢复和确定性 provider 审批拒绝，报告与 transcript 在 `.agent-benchmark/demo/tui-pty-matrix-fdb6294-native/`、`.agent-benchmark/demo/tui-approval-pty-fdb6294-native/`。此前中断恢复 PTY transcript/oracle 在 `.agent-benchmark/demo/interrupt-recovery-e34d0393-native.{typescript,json}`；Windows 当前候选 `a857d20f…c4ae15` 的 interrupt-recovery protocol/oracle 已通过。自动 PTY 不等同真人视觉/IME验收或录屏；Windows/Linux 中文 IME、长历史、人工审批焦点和视觉复核、连续交互录屏仍待人工执行，因此 R6-09 保持未完成。

### 终端矩阵

Windows Terminal + PowerShell 和 Linux 终端；80×24 与 120×40；中文 IME、emoji、多行粘贴、长历史滚动、窗口缩放、工具展开、审批焦点、运行中补充、取消及退出后终端恢复。

自动验证状态和执行契约；输入法及渲染体验保留人工记录。远端 workflow 配置、远端实际运行、人工验收分别标记，不互相替代。

人工结果使用[终端验收记录表](D:/workspace/actlume-agent/docs/ACTLUME-ROUND-2-MANUAL-TUI-CHECKLIST.md)登记；当前所有人工字段保持 `not run`，自动 smoke 不会自动改写这些结果。

当前 Linux 自动 PTY smoke 可在 WSL2 原生 Linux Node 与干净 ext4 checkout 上复跑（测试源码是 `fa4ba7d`，checkout `fdb6294` 的 `src/` 相同；路径按本机调整）：

```sh
python3 /mnt/d/workspace/actlume-agent/docs/support/tui-pty-smoke.py \
  --workspace /root/actlume-r6-09-fdb6294-ext4 \
  --expected-candidate e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 \
  --node /root/.local/actlume-node-v24.14.1/bin/node \
  --path-prefix /root/.cache/actlume-pi-cli-test-8171/bin \
  --output-dir /root/actlume-r6-09-fdb6294-ext4/.agent-benchmark/demo/tui-pty-matrix-fdb6294-native
```

网络/TLS 或外部 runner 不可用时保存精确日志和待执行命令，继续其他本地任务；对应 gate 保持未通过，不能将其变成“整体完成”。

## 10. R7：真实实验和最终交付

### 实验步骤

1. 冻结已验收的候选源码、开发 fixture、条件 manifest 与 oracle；真实模型 smoke 先确认 provider、工具和 usage。
2. 先跑少量任务检查成本与失败分类，再运行核心开发集。建议每个适用条件每项任务先做 3 次交错重复，定位为探索性结果；方差明显或结论不稳定时按剩余预算增加，不将 3 次等同充分统计证据。
3. 记忆任务固定学习阶段和未见后续任务，记录人工激活成本，不跨条件共享答案或记忆产物。
4. 策略调优只使用开发集；保留集在最终配置冻结后执行，数量覆盖主要机制，至少准备 4 项独立任务并说明规模局限。
5. 汇总正确率、错误完成声明、恢复、过期记忆误用、误拦截、工具/模型调用、usage 和耗时。按任务重复的相关性报告区间，不把同一任务的多次尝试当作独立任务。
6. 模型/provider 不上报 usage 时为 unknown，估计单列；价格无可靠来源时不报告伪精确金额。所有失败、预算耗尽和不完整样本进入原始报告。
7. 可以得到“没有改善”或“某类任务更差”的结果；据此删减或默认关闭策略，不以正向收益作为交付门槛。

配置记录模型请求/Token、单 attempt 耗时和全实验上限；runner 达到上限停止新任务并保存部分结果，不能无限重试。真实模型可用性或预算不足时，确定性工程验收可以完成，实验 gate 保持 pending。

### 工作与产物

- [x] R7-01 保存冻结配置、任务版本、执行顺序、原始事件/patch/artifact/oracle 输出；旧 `round2-core-dev` 保留 1/24，候选 `round2-core-dev-01372678` 保留 6/24 与 18 条未启动，候选 `round2-core-dev-c3e044f5` 保留 4/24 与 20 条未启动；源码候选 `eb941e32` 的 `round2-core-dev` 完成 24/24，`round2-holdout-eb941e32` 保存 post-freeze confirmation 8 次执行及每 attempt 结果。当前源码候选 e34 与实验候选有 4 个 production-input 差异，详见 R7-02/G7 和剩余清单。
- [x] R7-02 形成实验报告，包含分母、条件、未知量、失败归因、效果与代价。报告记录源码候选 `eb941e32` 的 development 24/24、post-freeze confirmation 8/8、分条件 oracle/runtime 结果、usage/token 分母、复用卡片与未知 revision/sampling 限制；不声称策略收益。实验候选和当前 `e34d0393…cc03` 有 4 个 production-input 差异，因此报告是已运行候选的有效历史结果，不是当前源码的精确复现实验。
- [x] R7-03 提炼至少两个真实失败案例：现象、根因、方案、替代方案、验证和局限。
- [x] R7-04 更新架构图，清楚区分 Pi 复用能力与 Actlume 自研机制。
- [x] R7-05 录制连续任务 → 中断/取消 → 恢复 → 检查或记忆失效 → 正确处理的演示。前一候选 Ubuntu 原生 Linux PTY capture `.agent-benchmark/demo/interrupt-recovery-e34d0393-native.typescript` 与结构化报告 `.agent-benchmark/demo/interrupt-recovery-e34d0393-native.json` 显示 phase 1 `interrupted/unknown`、phase 2 同 session/task `completed/checks_passed`、进程已终止、无重复编辑、required check 通过、独立 oracle pass。当前候选 `a857d20f…c4ae15` 的 Windows `interrupt-recovery-01` protocol/oracle 也通过。Linux PTY 是文本录制，不是交互 TUI 视频；真人矩阵仍列在 R6-09/G6。
- [x] R7-06 简历每项能力和数字关联到产物；未经验证的恢复、协作收益与 Trace 仍保持限定表达。

## 11. R8：已有可选原型的收尾

只读子任务先在 R6 封闭最终工具边界；后续补父取消、共享记忆只读、证据有效性、总预算和串行/并行比较。task scope 是提示约束还是文件访问限制必须明确，不能只写了 prompt 就声称访问范围强制隔离。

Trace 增加 HTTP 状态处理、可观测的丢失计数、受限队列、退出 drain/flush 和超时。模型调用与工具建立真实关联，不根据时间邻近伪造父子关系。托管 collector/Langfuse 成功接收另行验证；自制 OTLP exporter 如实描述，不自动改称 OTel SDK instrumentation。

- [x] R8-01 可选子任务故障和权限边界验收，或明确标记/关闭未验收能力。
- [x] R8-02 HTTP 401/500、网络超时、退出前尾部 span 的测试与状态展示。
- [x] R8-03 依据核心实验结果决定是否继续 Worktree 写任务或托管 Trace，不预设必须增加这些功能；当前开发集不足以判断收益，决定暂不增加并行写 Worktree 或托管 Trace，保留为待证假设。

## 12. 建议代码落点

以下是职责建议，只在实施时创建需要的模块。

| 现有入口 | 本轮处理 | 建议新增职责 |
| --- | --- | --- |
| pi-runtime.ts / pi-workflow.ts | 保留 Pi 适配，抽走领域事实与投影 | task-state、domain-records、branch-projection |
| runtime-events.ts | 记录相关身份与来源，作为观测投影 | schema-migration、事件到结果转换 |
| types.ts / tools/shell.ts / tool-scheduler.ts | signal、结果确定性和取消协议 | process-supervisor、platform adapters |
| verification.ts | CheckSpec、范围、环境、检查前后指纹 | checks、task-assessment |
| plan-mode.ts / task-tracker.ts | 按 task/branch 归属并协调并发 | plan projection |
| workflow-guard.ts | 独立规则 ID/version、类别与开关 | policy-config、policy-registry |
| memory.ts / context-budget.ts | 身份、替代、解释性召回与结构化预算 | applicability、context-pack |
| eval-harness.ts / evals | 从汇总扩为可执行协议 | manifests、fixtures、oracles、runners、reports |
| main.ts / package.json / CI | 输入与输出契约、生产验收 | packaged-smoke、doctor |
| replay-run.ts / otel-exporter.ts | unknown 语义与可选导出可靠性 | 回归测试和明确的原型状态 |

## 13. 最终验收门槛

| Gate | 完成条件 | 对应阶段 | 当前状态 |
| --- | --- | --- | --- |
| G1 连续性 | 多轮、活动分支和真实进程重启恢复通过，原 task baseline 不丢失 | R1 | 本地通过；Windows 强制中断/恢复已有独立 Eval 证据 |
| G2 取消 | Windows/Linux 受控进程树取消通过，未决副作用保留 unknown | R2 | Windows 当前候选 `a857d20f…c4ae15` 与 Ubuntu 原生 Linux前一候选 `e34d0393…cc03` 的中断恢复协议通过；Linux oracle 确认进程树停止、同一 session/task 恢复且没有重放写入。当前 Linux hosted job 待 R6-07。 |
| G3 证据 | 空检查不能冒充验证，版本/范围/要求变化使证据失效，UI/JSONL/回放语义一致 | R3 | Windows 当前候选 `a857d20f…c4ae15` 全量 `npm run ci` 192/192 tests、16/16 benchmarks 通过；Ubuntu 原生 Linux前一候选 `e34d0393…cc03` 同样通过。最新双平台 hosted CI 由 G6 跟踪。 |
| G4 评测协议 | 核心九张卡可执行，独立 oracle、隔离 attempt、策略开关和严格配对通过 | R4、R5 | Windows 当前候选 `a857d20f…c4ae15` 九卡 oracle 9/9；Ubuntu 原生 Linux前一候选 `e34d0393…cc03` 九卡 9/9。protocol reports 只验协议和 validator，不代表模型质量。 |
| G5 记忆/上下文 | 未见跨会话任务、过期配置、替代、分支及压缩连续性通过 | R5 | 本地通过；新增 Pi SessionManager 三次 compaction + reopen 集成回归并验证 artifact 回读 |
| G6 产品交付 | 干净生产安装、远端双平台 CI、终端矩阵及演示有实际证据 | R6 | `fa4ba7d` hosted Windows/Ubuntu CI 与 package smoke 均通过（run `37503514367`）；人工 OS IME、真人审批焦点、长历史矩阵、人工视觉复核及交互 TUI 连续录屏仍待验。 |
| G7 真实实验 | 固定/如实记录模型条件，重复与保留任务结果、失败和局限可复现 | R7 | 实验 campaign 与报告对源码候选 `eb941e32…36c4ca` 已完成：bounded smoke 5/5 usage-known；development 24/24、1,340,985 tokens；post-freeze confirmation 8/8、456,249 tokens。当前候选 `a857d20f…c4ae15` 相对实验候选有 4 个生产输入差异；实验是历史候选证据、非当前源码精确复验。holdout 卡曾复用，provider revision/sampling unknown，不推断策略收益或价格。 |

全部 G1–G7 通过，才可宣布原计划 M0–M5 第一版改造完成。收益不显著不算未完成，但没有运行实验、外部 gate 未验收或测试被跳过不能算通过。R8 单独报告，不作为原核心版本的替代证据。

每次交付更新任务复选框、状态、验证命令和证据路径；implemented 状态不能直接勾选 verified gate。不要以测试数量、代码行数或目录数量折算完成百分比。

## 14. 剩余执行清单

当前实现、确定性验证和托管双平台 CI 已通过。尚未完成的外部/人工验收及结论边界如下：

1. 完成 Windows Terminal 与 Linux 的人工终端矩阵和连续屏幕演示，记录中文 IME 组合、缩放、审批焦点和终端恢复；自动 PTY 已覆盖 Linux 80×24→120×40、Unicode 多行输入、Ctrl+C/Ctrl+D、termios 恢复及 deterministic provider 审批拒绝，但不替代真人 IME/焦点/视觉验收或交互录屏。
2. 真实模型 bounded smoke、development 24/24 及 post-freeze confirmation 8/8 使用 `eb941e32…36c4ca` 源码候选；当前 `a857d20f…c4ae15` 与其有 4 个 production-input 差异，因此这些实验是历史候选证据，不是当前源码精确复现实验。旧实验 usage 完整，但 provider revision/sampling unknown、确认集复用卡片，不能由此推断当前候选策略收益。
3. 当前没有可归因的并行写/托管 Trace 收益，R8-03 已决定暂缓新功能；若后续获得可靠核心实验，再重新开范围决策。

## 15. 难题记录规范

沿用用户要求记录有价值的难题，持续更新 [`docs/ACTLUME-ROUND-2-ENGINEERING-NOTES.md`](D:/workspace/actlume-agent/docs/ACTLUME-ROUND-2-ENGINEERING-NOTES.md)。每条包括：

- 场景及原始失败证据；复现命令和候选版本。
- 问题根因：Pi API/持久化、状态所有权、进程树、检查范围、记忆适用性或实验混杂。
- 采用方案与至少一个替代方案；选择原因和代价。
- 验证结果、仍未覆盖的边界、对应任务 ID。
- 若实验无收益或有退化，如实记录配置和原始样本。

优先记录跨分支领域状态、取消后的副作用、检查期间版本竞争、策略对照中的混杂、记忆失效与误拒用。只有计划或推测的难题标为待验证，不写成已经解决的经验。
