# Actlume 第二轮工程难题记录

本文件只记录已经观察或复现的事实。每项任务关联第二轮工作规划的 R ID。假设和计划中的风险标为待验证，不能写成已解决难题。

## 2026-10-05：Pi 工具适配没有传递取消信号

- 关联：R0-02、R2-01～R2-03。
- 触发：通过注册的 Pi `shell` tool definition 传入 AbortSignal；50ms 后 abort，一段约 800ms 的本地 Node 命令仍运行完并输出 `42`。
- 观察：工具适配函数只取 `(toolCallId, args)`，底层 `exec` 只有固定 timeout；它既不知道取消请求，也无法报告进程树停止。
- 结果：约 1182ms 返回 `isError:false` 和 exitCode 0。这说明 UI/runtime 取消不等于 shell 已停，当前实现可能把迟到的成功误认为已取消后的有效任务结果。
- 决策：将 signal 贯通至 ToolContext 与子进程 supervisor；增加受控标记文件和父子 PID 夹具。取消、超时和 unknown 独立表达。先修单进程，再验证 Windows/Linux 派生进程回收。
- 未知项：Windows `child_process.exec` 子 shell 对终止的具体行为及后代进程能否回收尚未实现/验证。Pi SDK 的 RPC 子进程取消与其不同，需要独立测量。

## 2026-10-05：命令分类不是检查证据

- 关联：R0-02、R3-01～R3-04。
- 触发：检查 `classifyVerificationCommand('echo npm test')`，分类为 `test`；给当前判定器一条退出码为 0、指纹匹配的该命令记录，得到 `verified`。
- 根因：当前代码用原始 shell 字符串关键词推导检查类型，又将同 run 任意一个通过检查等同于本任务完成验证。
- 决策：命令分类仅用于展示辅助信息。可信检查来自已配置 CheckSpec、真实 cwd、exit code、代码/环境指纹和任务要求集合；任务验收单独由独立 oracle 或人类给出。
- 结果：本探针证明当前规则存在误判路径，不表示真实模型已经利用它，也不推断所有测试结果均无效。

## 2026-10-05：Eval 中“成对”记录不一定是可比实验

- 关联：R0-02、R4-05～R4-09。
- 触发：向现有比较函数传入同一 task/repeat 的 baseline 和 candidate，故意改动模型版本、提交、环境、prompt hash。汇总器仍返回 `paired:1` 和 `resolveRateDelta:1`。
- 根因：pair key 仅含 taskId 与 repeatIndex，validator 只确认若干字符串字段有类型，没有验证控制变量。
- 决策：manifest 记录任务输入、代码/夹具、模型/provider、采样、权限/工具、预算、环境和中断方案；比较前验证预先声明的 invariants。策略处理不同是 treatment，task 输入 hash 仍须匹配。
- 结果：当前汇总器可作格式/指标计算原型，不能单独为消融归因背书。

## 2026-10-06：Pi 项目扩展自动发现会扩大 Actlume 的工具边界

- 关联：R6-04、R8-01。
- 触发：检查已安装 Pi CLI 的选项后确认，Pi 默认会发现用户级和项目级扩展；Actlume 虽然显式注册本地工具和 scopedResearch 的 allowlist，却没有在启动参数中关闭这些额外扩展。
- 风险：工作区 `.pi/extensions` 中的代码可在 Pi 进程内执行并注册额外工具，破坏 Actlume 对 scoped child 工具集的闭合假设。
- 决策：所有 Actlume 启动都使用 `--no-extensions`，再显式加载 Actlume extension 和 Pi 内置 MCP extension。子任务沿用同一参数构造器，并继续以 Actlume `allowedTools` 过滤本地工具、关闭 MCP。
- 验证：Pi CLI smoke 在临时 workspace 放入会写 marker 的自动发现扩展；Actlume provider 仍正常注册，marker 未生成。`src/pi-runtime.test.ts` scopedResearch 用例继续验证 child tool list。
- 边界：这是对 Pi extension discovery 的限制，不是进程沙箱；Actlume 扩展本身仍有宿主进程权限。
- 状态：已修复待整轮验收。

## 2026-10-06：headless RPC 入口遗漏了已加载的策略 treatment

- 关联：R4-01、R4-06、R6-06。
- 触发：检查两条 Pi 入口发现 TUI 在 bridge config 中传入 `.actlume/policies.json`，`runPiTaskDetailed` headless 路径却使用默认策略。
- 影响：同一个记录了 treatment hash 的评测任务可能实际运行默认策略，导致策略对照记录与执行不一致。
- 决策：headless bridge 与 TUI 一样显式传递已加载的 policy config；回归测试用关闭效率策略、observe 任务规则的配置，检查 run-start event 中记录的规则模式。
- 验证：针对性 Pi RPC mock 用例待本轮再次执行；历史测试只验证 TUI/extension 路径，不覆盖这个遗漏。
- 边界：这验证配置确实进入 runtime 并留痕，不证明任何策略的任务收益。
- 状态：已修复待验。

## 2026-10-06：Windows npm shim 不可直接作为 execFile 程序

- 关联：R6-06、R6-07。
- 触发：首次运行包 smoke 时用 `execFile("npm", ...)` 建立 consumer，Windows 返回 `spawn npm ENOENT`；系统的 npm 入口是命令 shim，不是 `execFile` 可直接启动的原生程序。
- 决策：在 npm script 环境读取 `npm_execpath`，并通过当前 Node 可执行文件启动该 JS CLI。这样不经过 shell，也不依赖路径 quoting。
- 验证：后续 package smoke 能完成 tarball pack 和 `npm install --omit=dev`，并继续验证 CLI、resume 与 oracle。最终完整 smoke 报告保存在 `.agent-benchmark/package-smoke/`。
- 边界：该方式要求通过 npm script 启动，脚本对缺少 `npm_execpath` 的直接调用会明确报错。
- 状态：已验收。

## 2026-10-06：CLI help 不应为读取参数而启动整个 Pi runtime

- 关联：R6-05、R6-06。
- 触发：首个安装包 smoke 的冷启动 `actlume --help` 超过 30 秒超时；同一条命令提高至 60 秒后成功。入口在处理 `--help` 前静态加载了 Pi runtime 和整套上游模块。
- 决策：将 Pi runtime 改为仅在进入 Pi 路径或显式运行 doctor 时动态加载。help 和旧 Runtime 路径不需要启动 Pi 依赖图。
- 验证：改动后需通过完整 CI 和安装包 smoke 复核；已通过的安装包证据对应动态加载改动前的候选版本，不能替代最终复核。
- 边界：首次真实 Pi 任务仍需加载 Pi runtime；优化只针对不需要 Pi 的 CLI 路径。
- 状态：已修复待验。

## 2026-10-06：只读记忆工具被工作流阶段分类为非工作流操作

- 关联：R4-03、R5-02、R5-05。
- 触发：运行 `memory-transfer-01` 两阶段 deterministic Pi RPC protocol；第二阶段先记录 `editPlan`，随后请求 `memoryRecall`。工具虽为只读，却返回 `STAGE_INTENT_BLOCKED`，自动注入记忆仍然成功，因此 oracle 曾在没有显式 recall 成功的情况下通过。
- 根因：工作流 intent classifier 的 exploration allowlist 包含普通文件读取和旧 `recall`，遗漏 `memoryList`、`memoryRecall`；它们被归为 `other`，而 plan 后阶段不允许 `other`。
- 决策：将两项记忆读取加入只读 exploration 工具集合，并增加 Pi workflow 回归测试，分别断言 intent 为 `inspect` 且 plan 后可调用。
- 验证：`npx tsx --test src/pi-workflow.test.ts` 通过 6 项；memory-transfer protocol 二次运行显示 `[tool] memoryRecall` 且 oracle pass。完整 typecheck 在修正测试构造字段后通过。
- 边界：这验证工具能进入 workflow 和该固定记忆场景可运行，不表示记忆策略提高真实任务成功率。
- 状态：已验收。

## 2026-10-06：中断恢复必须从 runtime 外部杀进程才能验证

- 关联：R1-05、R2-03、R4-03、R4-10。
- 触发：原中断卡只有 task/oracle fixture，没有实际 runner；在 agent 进程内调用 session-start 或抛异常都无法证明持久化和 OS 进程死亡。
- 决策：为 Eval 新增独立 worker 进程。runner 等待指定文件实际改变及 `writeFile` 完成事件后，在 Windows 使用 `taskkill.exe /T /F` 结束 worker 和 Pi 子进程树，再用相同 session ID 发起第二阶段；恢复阶段运行 fixture 配置的 required `npm test` CheckSpec。first phase 的 provider 响应被挂起，避免在检查前自然完成。
- 验证：`interrupt-recovery-01` protocol report 为 pass；阶段 1 `interrupted/unknown`、阶段 2 `completed/checks_passed`，同 session 和 task，`runtimeTerminated=true`、`duplicateEdits=0`、检查通过。报告在 `.agent-benchmark/protocol-runs/interrupt-recovery-01-1791223748091.json`。
- 边界：此轮只在 Windows 执行了 taskkill 树终止。Linux detached process-group 路径尚待 Linux CI 实测；不能据当前结果宣称跨平台进程树行为已验收。
- 状态：Windows protocol 已验收，Linux 待外部验证。

## 2026-10-06：确定性长上下文夹具不需要把大文本签入仓库

- 关联：R4-02、R4-03。
- 触发：`long-context-01` 需要大量无关内容与诱饵字符串；签入大块重复文本会污染 diff、增加维护负担，且难以明确控制字节规模。
- 决策：fixture manifest 固定 pattern 和 repetition 数，materializer 在 runner 创建的唯一临时工作区生成文件；fixture hash 仍覆盖生成规则，report 标记真实 candidate manifest。
- 验证：fixture preflight 安全物化全部九张核心卡；`long-context-01` protocol 读取目标配置、完成修改并通过独立 oracle。
- 边界：重复文本只模拟上下文体量和噪声，不代表真实仓库复杂性，也不用于模型质量结论。
- 状态：已验收。

## 2026-10-06：OTLP fetch 成功不代表 collector 接收了 span

- 关联：R8-02。
- 触发：审计 exporter 时发现它只 catch 网络异常，没有检查 `Response.ok`；HTTP 401/500 会作为 fetch 成功静默丢失。runtime event 调用又是 fire-and-forget，退出前没有明确 drain，网络故障没有可读的丢失计数。
- 决策：将 span batch 放入有 128 项上限的队列；检查 HTTP 状态，单独累计 HTTP 错误、timeout、network error 和 dropped batch；暴露 flush 与诊断快照。Pi 的每次 settled 会 flush，TUI 对新增丢失发警告，`/actlume-doctor` 展示累计错误与队列状态。无论 exporter 结果如何，本地 JSONL 仍先落盘并保持权威。
- 验证：`src/otel-exporter.test.ts` 针对 HTTP 401/500、队列上限与 drain、尾部 run span 的 timeout 增加测试；五项 exporter 用例和 typecheck 通过。
- 边界：没有连接真实托管 collector；diagnostics 只在当前 Pi runtime 进程内累计，不重试丢失 batch，也不宣称 exactly-once 传输。
- 状态：本地 exporter 合同已验收；外部 collector 未验证。

## 2026-10-06：取消 MCP 请求无法证明远端副作用已回滚

- 关联：R2-05。
- 触发：检查 MCP SDK `Client.callTool` 签名发现其第三个参数接受 `AbortSignal`，Actlume adapter 原本没有把 Pi tool signal 传进去，也将超时/异常返回为可重试失败。
- 根因：本地 promise 停止等待和远端 server 停止执行是两件事。即使协议通知了对端，server handler 也可能忽略取消并完成写操作。
- 决策：将 tool `AbortSignal` 传给 MCP request；取消、timeout 和不确定 transport error 一律记录为 `unknown` 且不可自动重试。Pi runtime 另写 `mcp-result-v1` unknown policy event，提示先检查状态。
- 验证：stdio mock MCP server 在客户端取消后继续完成 delayed write。回归测试观察到本地结果 `MCP_OUTCOME_UNKNOWN_AFTER_CANCEL`、`retryable=false`，随后远端 marker 仍实际产生。
- 边界：传输层发出取消不保证任意第三方 server handler 遵守取消；需要 server 侧查询或人工核对副作用。Pi event 中的 unknown 表示不确定，不表示远端一定已执行。
- 状态：本地 cancellation contract 已验收。

## 2026-10-06：九张 Eval 卡的协议证据与质量结果必须分开

- 关联：R4-02～R4-10、R7-01～R7-02。
- 触发：当 deterministic provider 覆盖 memory、stale-memory、revision、verification、artifact、guardrail、long-context 和 interruption 场景后，protocol 输出都是 `protocol-validation-only`，而模型请求及结果由预写脚本提供。
- 决策：九张核心卡的固定夹具、独立 oracle 和 protocol runner 可以作为运行/故障/记录契约验收；这些产物排除在真实 Eval 分母之外。真实 provider/model 的重复对照、保留集和策略收益仍单独待执行。
- 验证：九张卡本地运行均为 `protocolValidated=true` 且独立 oracle `pass`；独立 `http-500` 故障运行保留 runtime `failed`、oracle `unknown`。报告位于 `.agent-benchmark/protocol-runs/`。
- 边界：进程树强杀路径在 Windows 已执行，Linux CI 尚未触发；deterministic provider 不提供任何编码质量或策略收益结论。
- 状态：Windows 协议验收通过，Linux 与真实模型实验待外部条件。

## 2026-10-06：子任务取消可能以“正常 RPC 返回”结束

- 关联：R2-06、R4-03。
- 触发：新增 delayed-provider 集成测试，在 `scopedResearch` 子进程已经发出模型请求后取消父 signal。测试发现子 Pi 进程会把取消作为 `run_finished: cancelled` 正常结束 RPC，因此 `promptAndWait()` 可以 resolve，child answer 为空，而不是走 catch 分支。
- 根因：以 RPC Promise resolve/reject 推断取消结果不可靠；Pi 将 cancellation 作为 runtime status，而非必然的传输异常。
- 决策：`promptAndWait()` 返回后再次检查父 signal。若已取消，返回明确 `cancelled` 状态和 unresolved 说明，保留已经发生的 tool-call 计数，不把空文本误判为结构化 JSON 格式错误，也不自动重试。
- 验证：`npx tsx --test --test-name-pattern="scopedResearch parent" src/pi-runtime.test.ts` 通过；断言 child agent event 为 cancelled、结果标记 unresolved。
- 边界：该 fixture 验证父进程到本地只读 Pi 子进程；它不验证子任务故障隔离、文件系统 sandbox 或远端副作用回滚。
- 状态：已验收。

## 2026-10-06：Eval 的正常阶段身份被 interruption 默认投影覆盖

- 关联：R4-03、R5-04。
- 触发：按最终候选重跑 `requirement-revision-01`；工作区已满足修订 oracle，两个 `run_finished` 事件也具有同一 taskId、sessionId，并记录 revision 2，但 oracle 返回 `unknown: same-task requirement revision evidence is required`。
- 根因：报告构造将 `...interruptionEvidence` 放在通用 `sameTask` 计算之后；普通两阶段卡的 interruption 默认值 `false` 覆盖了已计算的同任务证据。
- 决策：每个 phase 通过其 `run_finished` event 与 runId 关联并提取 taskId；生成 normal protocol evidence 后，再按卡类型写入同任务结论。interruption 卡沿用由强制进程终止/恢复过程取得的身份判定。
- 验证：修复前原始 report 保留 oracle unknown 和相同 run event identity；修复后 `requirement-revision-01` 独立 oracle pass，九张最终候选卡 9/9 protocolValidated 且 oracle 9/9 pass。所有报告使用 `sha256:87b1525ff6651c809872dfde88bfc6322a451d95bef29cecf8a962bae8c1939f`。
- 边界：九卡仍是 deterministic protocol validation，不是模型成功率或策略增益。
- 状态：已验收。

## 2026-10-06：协议 runner 必须从 npm script 启动

- 关联：R4-03、R6-06。
- 触发：为固定候选序列首次用 `node_modules/.bin/tsx scripts/eval-protocol-smoke.ts` 直接启动；`memory-transfer-01` 在独立 promotion check 返回 exit 1，fixture 命令 runner 报告 `npm_execpath is unavailable; invoke the protocol runner through npm.`。该 fixture 有合法的 package/test 文件，问题来自宿主脚本调用契约。
- 决策：按 runner 文档化路径执行 `npm run eval:protocol-smoke -- --task <id>`，使 npm 注入 `npm_execpath`；保留第一次失败日志并重新跑全部卡片，不只重跑失败任务。
- 验证：最终九卡均通过；memory-transfer 两阶段包含显式 memoryRecall、promotion test 和独立 oracle。
- 边界：直接调用 TSX CLI 时 runner 会因缺少 npm 环境变量失败；这是显式限制，不能把裸 TSX 调用描述成支持的命令。
- 状态：已验收。

## 2026-10-06：Pi 的三次压缩会把原始对话移出模型上下文

- 关联：R5-08、R1-05。
- 触发：构造真实 `SessionManager` session，加入 task prompt、workflow snapshot、pending tool、interrupted event，再 append 三个 Pi compaction entries；每次压缩后写新消息、重新打开 session 并触发 extension 恢复。
- 观察：`buildSessionContext()` 已不含原始目标文本，Pi compaction summary 也不承诺保留任务字段；branch 的 append-only custom domain entries 仍可供 reducer 投影，extension 重新注入完整目标、revision、计划、检查结果和恢复警告。
- 决策：继续复用 Pi 的对话压缩；任务连续性从 session branch 的活动领域记录构建。artifact 仍由受限 `readArtifact` 工具按路径回读，不通过重放历史工具恢复。
- 验证：`task requirements, plan, unresolved side effects, and artifact access survive repeated Pi compaction and reopen` 集成测试通过，三次 compaction、三次 reopen、revision 5、failed npm test 和 artifact sentinel 均被断言。
- 边界：使用 Pi SessionManager append API 构造 compaction tree，没有启动真实长上下文 LLM 来自动触发 compaction；人工确认多种 summary 内容和 UI 的压缩体验仍待验。
- 状态：本地连续性验收通过。

## 2026-10-06：审批取消测试需要等待确认界面真正打开

- 关联：R2-07、R6-09。
- 触发：首版集成断言立刻 abort，但 `tool_call` hook 在写入请求事件时先 await；abort 发生在 policy gate 前，于是只测到“执行前已取消”，没有覆盖等待中的确认对话框。
- 决策：fake UI 在 `confirm()` 被调用时释放 `approvalReady` barrier；测试收到 barrier 后才 abort，再检查对话框 signal、拒绝结果和文件不存在。
- 验证：审批中的取消 integration test pass，记录 `APPROVAL_CANCELLED` block；目标文件未创建。
- 边界：UI 行为用 Pi extension UI contract mock 验证，真实 Windows/Linux TUI 的按键焦点和 redraw 仍在终端矩阵中。
- 状态：extension contract 已验收，真实终端矩阵待验。

## 2026-10-06：TUI smoke 必须显式隔离用户 MCP 配置

- 关联：R6-03、R6-09。
- 触发：使用临时 `--workspace` 启动 TUI 时 Pi 仍尝试连接用户配置里的 `web_search` MCP server，并在 30 秒后提示 timeout；这说明临时工作目录本身不是关闭用户级 MCP 的证据。
- 决策：创建临时空 MCP JSON，通过 `--mcp-config <temp>/empty-mcp.json` 重跑；不运行模型 prompt，只观察界面、Actlume extension/status area，并用 Ctrl-D 退出。
- 验证：80×24 PTY 显示 Pi v1.0.2、Actlume extension 与 status，Ctrl-D 后 Pi 恢复终端并以 exit 0 退出。测试 workspace 位于系统 temp；用户根目录 `.agent-mcp.json` 与 `.agent-memory` 未修改。未指定空 MCP 时，Pi 的启动日志显示它尝试连接用户配置中的 web_search，随后超时。
- 边界：这是启动/渲染/退出烟测；未验 IME、resize、长历史、多行 paste、审批焦点、Linux 和连续屏幕录制。Pi 启动时显示上游有更新可用提示，不在本次 smoke 自动更新。
- 状态：基础 smoke 已通过，完整矩阵待验。

## 2026-10-06：本机没有 Linux runner

- 关联：R2-03、R6-07。
- 检查：`wsl.exe -l -q` 只列出 `docker-desktop`；`docker version --format '{{.Server.Version}} / {{.Client.Version}}'` 因 `dockerDesktopLinuxEngine` named pipe 不存在而失败。
- 决策：不把 Windows 的 `taskkill /T /F` 结果外推为 Linux 进程组验证；Linux test 和远端 workflow 证据继续 pending。
- 边界：未推送分支或触发外部 GitHub workflow；恢复 Docker Linux engine 或使用 Linux CI runner 后按计划命令复跑。
- 状态：外部执行器阻塞。

## 2026-10-06：Pi 的 maxSteps 不是 provider 请求硬上限

- 关联：R7-01、R7-02。
- 触发：首次真实模型 smoke 配置 `maxSteps=4`，但实际记录到 5 个模型响应/usage 事件；该设置无法作为外部账单请求额度使用。
- 根因：`maxSteps` 是 Pi runtime/workflow 的步骤保护。它不在 provider HTTP 边界计数，也不约束 SDK 在 runtime 失败后的重试。
- 决策：真实模型 smoke 走 loopback OpenAI-compatible proxy；代理独立限制上游请求数、每次输出 token、报告 usage 后的累计 token 门槛，并只把随机本地 key 交给 worker。墙钟超时终止 worker 进程树。代理只转发 chat completion，不记录授权头或请求正文。
- 验证：代理测试确认每次输出被压到 64-token 测试限额、累计 usage 到阈值后拒绝新的上游请求；provider 不报 usage 时仍由请求硬上限停止。真实 smoke-v1 转发 4 个上游请求，另阻止 4 个本地重试；smoke-v2 转发 7 个请求、每个 usage 可读，另阻止 3 个本地重试。
- 边界：累计 token 只能在响应完成后确认；smoke-v1 的 20,000 门槛实际到 20,101，smoke-v2 的 35,000 门槛实际到 39,704。逐响应 output cap 和请求数仍有效；未报告价格，也未声称达到美元硬上限。
- 状态：代理限额本地测试通过；完整重复实验待配置冻结。

## 2026-10-06：真实 smoke 要区分 oracle 正确与 runtime 完成

- 关联：R3-01、R3-02、R4-08、R7-01、R7-02。
- 触发：smoke-v1 工作区没有 required CheckSpec，Pi 以 failed/unchecked 结束；独立 oracle 仍对未修改 parser 判 fail。随后 smoke-v2 加入公开的任务专属 CheckSpec overlay，模型只改了 parser regex，独立 oracle 5 项全部 pass，但 Pi 在 headless `acceptEdits` 模式下因 shell 工具需要交互审批而退出码 3，runtime evidence 仍 unchecked。
- 根因：独立 oracle 能判代码结果，但不能替代 runtime 对 required CheckSpec 的执行记录；headless permission mode 又不能交互批准该 shell 命令。
- 决策：smoke report 分开保存 runtime status、completion claim、CheckSpec evidence 和独立 oracle verdict。overlay 只针对 `short-regression-01`，固定检查输入边界，不复用到其它 fixture；本次 oracle pass 不计作完整 Agent 成功或 guardrail 收益。
- 验证：overlay 回归测试断言 unchanged baseline 失败、参考修复通过，且任务外的 fixture 不会得到该 CheckSpec。真实 smoke-v2 原始 patch 是单行正则变化，独立 oracle pass；runtime 请求/审批事件保留在原始 event log。
- 边界：真实 smoke 尚未验证 TUI 审批流程，也没有安全的 headless exact-check 授权协议；当前报告不计算配对收益、false-completion 或成功率。
- 状态：问题已复现并被准确分类；headless 验收路径待处理。

## 2026-10-06：策略对照组原先无法关闭记忆处理

- 关联：R4-01、R4-05、R7-01。
- 触发：准备形成 `actlume-control` 与 `actlume-memory` 配对时检查 Pi adapter；PolicyConfig 能关闭两条 workflow rule，但 `before_agent_start` 无条件召回项目记忆、注入记忆指导和上下文，记忆工具也始终可写。
- 根因：此前运行配置只暴露 workflow policy toggles；记忆是 runtime 固定行为，因此所谓“control”仍接受 Actlume 记忆处理，因果比较会把处理差异藏在默认值里。
- 决策：增加内部 Eval `memoryEnabled` treatment。禁用时不读取/注入记忆，不运行 recall/list/save 工具副作用，记录 disabled 状态及 treatment hash；保留同一组工具 schema，让 paired toolset 不变。新增条件 design 将 `pi-native-reference` 限定为描述性参考，并验证 control/memory/guardrails/full 四组只改变声明因子。
- 替代方案：移除 control 的 memory tools 会让工具集 hash 改变，违反严格配对不变量；直接沿用现状则 control 仍暴露处理。选择固定 schema 加明确、无副作用的 disabled 响应。
- 验证：`npm run typecheck` 与 `npx tsx --test src/eval-conditions.test.ts src/pi-runtime.test.ts` 通过，22 项通过；测试确保隐藏 sentinel 不进入 system context，disabled `memorySave` 不写入候选，并拒绝误标的 treatment/comparison。
- 边界：真实模型 core/holdout 条件尚未执行；disabled-memory 错误响应本身属于预定 treatment 体验，后续报告须保存模型是否尝试调用 memory tool。`pi-native` 仍需独立 runner 才能得到参考数据。
- 状态：本地 treatment/profile 验收通过；严格对照实验仍待冻结与执行。

## 2026-10-06：Headless Eval 需要精确 CheckSpec 放行边界

- 关联：R3-08、R4-03、R7-01～R7-02。
- 触发：真实 smoke-v2 产生正确 parser patch，独立 oracle 5/5 pass，但 Pi RPC 在运行可见 `CheckSpec` 时因 `acceptEdits` 需要交互审批，以 exit 3 / `unchecked` 结束。
- 根因：Headless adapter 必须拒绝一般 shell 审批；原实现没有区分 agent 任意选择的 shell 命令与 harness 预先固定的精确验证命令。改成 `bypassPermissions` 会同时打开任务工作区内所有 agent 命令，不满足最小权限要求。
- 决策：增加仅由 Eval worker 传入的 `allowHeadlessCheckSpec` 内部选项。先应用既有 shell deny policy，再要求 command 与 cwd 完全匹配已加载的 CheckSpec；精确匹配才放行，并记录 rule ID、CheckSpec ID 和 command hash。该 flag 不由用户配置/CLI 暴露；默认关闭，TUI 仍走人工确认，任何追加命令都继续拒绝。
- 验证：集成测试证明精确命令只有显式 opt-in 时通过，追加 `&& node -v` 被拒，未启用 flag 的普通 headless 任务仍被拒。Smoke-v3 的 `actlume-control` condition 完成运行，CheckSpec `checks_passed`、独立 oracle pass、请求和工具调用均有事件证据。
- 附带发现：v3 原始报告把 `SHA256(JSON.stringify(PolicyConfig))` 标成 canonical `policyConfigHash`。原始报告保持不变，索引 manifest 标出错误值并采用 `run_started` 事件中由 runtime 生成的规范 hash；producer 已改用同一 helper，并加回归断言。v3 的单个在途响应使累计 usage 越过 20k 阈值到 25,563，这仍是响应后才可确认 usage 的硬边界。
- 边界：该权限路径只在本地短任务 fixture 上验证；完整核心任务/holdout 条件尚未执行。provider revision、sampling 和美元成本仍未知，v3 不构成质量或策略收益样本。
- 状态：精确 CheckSpec headless 路径已本地验证；R7 配对和 holdout 仍待验。

## 2026-10-06：单任务四条件 pilot 被预算和策略干预共同截断

- 关联：R7-01、R7-02、R8-03。
- 候选与冻结输入：candidate manifest `sha256:cf780c607c82fd473437f0fe4edd883330bf55fe3fb8d3462b724c3c4ea1d70f`；冻结顺序、fixture/oracle hash、permission、CheckSpec 放行边界及 20,000 tokens/attempt 限额见 `evals/experiments/core-v1-smoke-pilot-freeze.json`。外部 lock 与逐 attempt 结果保存在被忽略的 `.agent-benchmark/frozen-experiments/`。
- 触发：在 `short-regression-01` 上按 `full → control → memory → guardrails` 各跑一次同一条件集。四次共 18 个 provider 请求、91,025 reported tokens，耗时约 107 秒；模型 revision 和 sampling 仍为 unknown。80,000 tokens 是“达到后不启动下一 attempt”的门槛，第四个 attempt 启动时累计为 71,004，完成后增加至 91,025。
- 观察：runtime 仅 control 1/4 completed；memory 1/4 虽 CheckSpec pass，最终 runtime 仍因 provider token gate 失败；full 与 guardrails 有 `STAGE_INTENT_BLOCKED`，未形成通过的 CheckSpec 证据。独立 oracle 3/4 pass、1/4 fail；四个 task verdict 均为 unjudged。四次都超过 20,000 per-attempt reported-token 门槛，因为当前代理只能在一个响应结束、usage 返回后阻止后续请求。该任务没有候选历史记忆，也未发生 memory tool 调用，因此 memory 因子在此 fixture 上实际没有暴露。
- 根因/限制：单次 smoke 的 token 门槛不是 provider-side dollar hard cap；可变的缓存输入 usage 使一次在途响应跨过门槛。策略干预也会新增决策轮次，所以用同一较紧门槛比较“是否完成”会把策略效果与预算截断混在一起。单个短任务且 revision/sampling 未知，无法估计策略收益。
- 决策：保留四份原始 report、事件、patch 和 oracle 结果；全部归为 integration-and-cost-pilot，不并入 `eval:summary` 任务质量分母，也不调大预算后在同一冻结 candidate 上重跑。后续需先固定任务相关的 memory treatment、给足且一致的 attempt 预算，再冻结多任务/holdout manifest；美元成本仍待可信价格来源。
- 替代方案与代价：直接把 3/4 oracle pass 称为 75% resolve rate 会把同一 fixture 的一轮样本、失败 runtime 和未激活 memory 因子误当成完整任务成功；立即调宽 token gate 重试会改变预算并消耗额外额度。当前取舍是只报告观察到的计数，保留结论为不可归因。
- 验证命令：`powershell -ExecutionPolicy Bypass -File .agent-benchmark/frozen-experiments/run-actlume-core-v1-smoke-pilot.ps1`；随后 `npm run ci` 通过 typecheck、182 tests 和 16 benchmarks。冻结 candidate 在四次运行前后均一致。
- 状态：pilot 已完成并复核；核心重复实验、策略收益及至少四项 holdout 仍未验收。

## 2026-10-06：阶段式真实模型 campaign 揭示冻结器、报告解析和检查范围缺陷

- 关联：R4-03、R5-02、R7-01～R7-02。
- 候选与冻结输入：校准 freeze `memory-transfer-calibration-v2` 固定候选 `sha256:33df0b2e40631fa33b1dd59f5f675e76fc6996dbead43b28b8fd0c158e4d6948`；运行索引 `.agent-benchmark/frozen-experiments/memory-transfer-calibration-v2-results.json`，逐 attempt 原始结果、事件、记忆与 patch 位于 `.agent-benchmark/real-model-smoke/`。
- 触发：首次 freeze 因 ESM 顶层 await 在任务 allowlist `const` 初始化前执行而报 TDZ；修复后执行 control/memory 两条件，共 15 个上游请求、73,661 reported tokens。另一早期单次校准中，阶段 runner 正常通过了 learning 与 fresh-session 阶段，但 campaign 索引没有解析 pretty-printed 多行 JSON，错误地把已有 smoke report 标成缺失、累计 usage 标为 unknown。
- 观察：在候选 `33df…6948` 上，memory-transfer control 两个阶段均运行，但 validator 将 `test.mjs` 判为 CheckSpec scope 外文件；memory-treatment 尝试保存记忆，却把命名保存为 `verified-test-command`，而 transition 要求的 `Verified tag test command` 未在用户任务提示中声明，导致 harness 没有晋升候选并停止在学习阶段。两次因此都不能作为记忆收益或任务质量样本。
- 根因：真实模型 fixture 的 CheckSpec 只把生产源文件纳入 scope，尽管任务明确要求修改回归测试；transition 用精确名称校验模型未被告知的内部标签；campaign 解析器把完整 JSON 文档误当成单行 JSON。
- 决策：将 fixture `test.mjs` 纳入 scope；在 memory fixture 的 learning prompt 中显式指定准确记忆名；campaign 解析 worker 的整段 JSON stdout，并在任务元数据分别记录声明阶段数和完成阶段数。真实模型子进程及 fixture 检查命令从父环境移除 provider secrets；campaign 在未知 usage 时停止后续请求。
- 替代方案与代价：放宽候选校验为“任意包含命令的候选”可能晋升错误或无关记忆；调大 token 限额但不修复任务证据，则只会让错误实验多花预算。选择修正冻结任务契约和独立检查范围，旧 attempt 保留为 harness shakedown。
- 验证：候选 `2f15a9cdfb7d2a82c8720fad83e9447b0a761170220f3967d35b63b33e1ba1e5` 的完整 CI 为 185 tests、16 benchmarks；后续 runner parser 与 CheckSpec scope/prompt 修复后的候选 `df52a1f6d9d03de969a64ee5d72c1af7f4eac59029c4751d2280c4c47e4c18d8` 已通过 typecheck、campaign reserve/provider-secret isolation/overlay 针对测试共 5 项，完整 CI 尚未复跑。
- 边界：该校准只用于检验真实模型 runner 和 fixture，不进入策略成功率；模型 revision/sampling 未知。新的固定任务和预算应另建 manifest，不修改旧运行记录。
- 状态：故障已复现并修复，修复后候选需再验；阶段式模型校准待按新 manifest 重跑。

## 2026-10-06：usage unknown 必须停止跨 attempt 聚合

- 关联：R4-07、R4-08、R7-01、R7-02。
- 候选与冻结输入：`round2-core-dev.json` 冻结 candidate `sha256:17ed5f57c94f856f2e00c7c4451c5d29eeb27ce6046f1ac4fd1620e9ace4e9a1`、24 个交错 attempt 和 2,000,000-token aggregate ceiling。首条 raw report：`.agent-benchmark/real-model-smoke/memory-transfer-01-dd973784-125b-45ea-8d6f-b472a6b5ab32/report.json`；campaign index：`.agent-benchmark/frozen-experiments/round2-core-dev-results.json`。
- 触发/观察：control 的 memory-transfer task 有 12 个 forwarded requests，其中 10 个可解析 usage，累计 51,296 tokens；另 2 个 response 没有 usage。Proxy 没记录 upstream HTTP error，但请求上限触发了后续 block。代码和回归测试改好，CheckSpec 与独立 oracle 通过，但 runtime 因继续请求在限制后失败，task verdict `unjudged`，completion claim `unknown`。Campaign 将累计 usage 标成不完整并停止，23 条后续 attempt 没有启动。
- 根因：流量代理只能根据真实 provider response 计量；HTTP 成功不能证明该响应 usage 可读。把缺失值当 0 会低估总用量，继续跑也会让后续样本额度不可追踪。
- 决策与替代方案：保留每次 attempt 已知 token 和 unknown response 数，campaign 在任何 forwarded request usage 不完整时停止。没有用估算补齐或在同一锁定 campaign 自动重试；新 provider/config 需新 manifest。
- 验证/边界：campaign outcome JSON 和 raw report 保留 `usageKnownRequests=10`、`usageUnknownRequests=2`，stop reason 为 `usage-unknown-or-report-missing`；没有推测模型端是否计费。模型 revision 与 sampling 仍 unknown。
- 状态：停止与保留证据机制已验证；重复开发实验被 provider usage 可追踪性阻塞。

## 2026-10-06：跨 session fixture 同时受阶段检查和 headless 命令边界约束

- 关联：R3-01、R3-08、R4-03、R5-02、R7-01～R7-02。
- 候选与证据：初始四卡 holdout `round2-holdout-v1` 在 candidate `sha256:17ed5f57…e9a1` 运行 8 次、425,239 reported tokens；stale-memory 卡两种 condition 都只有 1/2 phase，required CheckSpec 未运行，因此不能解释为 memory treatment 的 stale-rejection 成败。Supplement v2 `round2-holdout-v2-supplement` 的结果另存，Supplement v3 使用新的 `holdout-stale-config-01` fixture 和新候选 `sha256:eff97d8790ae82f732f3316b6ba1fbe7ddd856b2dc58e29b541eca93ae59226a`。
- 触发/观察：v1 learning prompt 要求运行 `node publish-v1.mjs` 并保存记忆，却没有提到 runtime 每个阶段都要求 `npm test`；phase 0 检查未执行时，runner 会在 transition 前将 phase 标失败。v2 明确加了 `npm test`，但 build script 不在自动批准白名单内，headless worker 正确拒绝了任意 shell 命令。不能通过给所有 fixture 放开 shell 来“修复”测试，因为那会扩大权限并改变实验条件。
- 决策：v1/v2 原始结果保留并单独标记为 fixture/permission-contract 失败，不事后改写。v3 使用不需要额外 shell 命令的文件产物任务：两阶段唯一 shell 验证都是 exact CheckSpec `npm test`，产物由 file tool 更新。v3 memory attempt 观察到旧记录被判 stale、未选用且 v2 artifact 与独立 oracle 匹配；但 runtime 没完成最终 CheckSpec，仍不算完整任务通过。
- 替代方案与代价：放宽 headless shell allowlist 会牺牲 least-privilege；修改已运行的 v1/v2 task 后重跑会把同一任务暴露后的修订混入旧 holdout。选择保留旧版本证据，并把新 fixture/manifest/results 单独标为 supplemental。
- 验证：`npm run eval:fixture-preflight` 对 15 张卡均确认 baseline fail/unknown、reference pass。v3 supplemental 的 2 次 request usage 都可读、共 121,529 tokens；control 未完成第二阶段，memory condition stale metrics 为 exposed/rejected/not-used，但 CheckSpec unchecked。
- 未覆盖：one-shot supplement 不是盲法独立策略评估，provider revision/sampling unknown；original stale fixture 的机制分母为 0。
- 状态：阶段和权限边界问题已复现并记录；fixture contract 已有受限 supplement，策略收益仍未验证。

## 2026-10-06：关闭 memory treatment 不能阻止模型手工仿造文件记忆

- 关联：R4-01、R4-05、R5-06、R7-01～R7-02。
- 证据：initial `holdout-memory-transfer-01` 的 control report `.agent-benchmark/real-model-smoke/holdout-memory-transfer-01-22d56873-fccd-4a1a-b88b-00269571eeff/report.json`。
- 触发/观察：`actlume-control` 中内置 memorySave 没有 side effect，但模型在项目 workspace 内手动创建 `.actlume/memory/candidates/Verified cache test command.md`。这个路径在 CheckSpec 允许变更范围外，verification 停止，follow-up 没有运行。相同任务的 `actlume-memory` attempt 通过 memory API 建立有 provenance 的候选、转换为 verified，再由 fresh session 召回并完成缓存键修复。
- 决策：保留相同工具 schema 与 control no-op，不将模拟文件晋升为真实 memory；报告把 workspace 文件写入记为 out-of-scope failure。未来需要隔离记忆存储的写入域或更严格阻止 `.actlume` 假记忆，但这必须是新的 runtime 设计与配对实验。
- 替代方案与代价：从 tool list 移除 memorySave 会改变 pair tool schema；当前仅关闭 API side effect 仍允许模型借通用 file tool 构造替代品。选择把它作为实测边界而不在 holdout 后临时改变策略。
- 验证/边界：memory treatment 任务 oracle pass，metrics `verifiedMemoryProvenance=true` 与 `memorySelectedInFreshSession=true`；control oracle fail，runtime scope 检查失败。单次任务不证明 memory treatment 普遍有益。
- 状态：失败已复现，暂未改 runtime；作为控制组可能被 workspace imitation 绕过的设计风险保留。

## 2026-10-06：在 WSL 补齐 Linux runner 时遇到网络、包缓存和跨平台候选哈希问题

- 关联：R2-03、R4-03、R6-06～R6-09。
- 触发/观察：最初只有 `docker-desktop` WSL，没有可运行项目的 Linux 用户发行版；安装 Ubuntu 24.04 后，WSL NAT 无法访问 Windows localhost proxy。离线 `npm ci` 还因 Windows npm cache 缺少 `@esbuild/linux-x64` 可选二进制而无法运行 package smoke。第一次 Linux runtime 测试的临时目录没有 `.git`，导致 workspace fingerprint 为 unavailable，并让一条明确断言证据状态的测试失败；原始 Windows 结果并不能覆盖 Linux 进程组行为。
- 根因：WSL 不会自动继承 Windows Node 安装；项目 package script 需 Linux esbuild native binary；测试期望必须提供其真实前置条件（Git 工作区），不能用无 Git 的目录来代表产品 workspace。候选 manifest 对每个文件的原始字节做 hash，单独复制 `README.md` 而漏掉 `README.en.md` 时，两个平台虽同有 126 个输入仍得到不同 candidate hash。
- 采用方案与替代方案：安装 Ubuntu 24.04 WSL2；从 Node 官方分发下载 Node 24.14.1 并验证 `SHASUMS256`（`84d38715d449447117d05c3e71acd78daa49d5b1bfa8aacf610303920c3322be`）；将 Linux esbuild tarball 纳入 npm cache，按 lockfile integrity 校验（`sha512-4xTZr1FUmSoQW4XIWmit3tzQrUTZM+N3P0XV8xROKYF50XfI7xeO90+1bZvNwxIufQ9hDQVRJH5YhgPVF8A/HQ==`），没有关闭 TLS 验证。给临时 Linux checkout 提供与项目一致的 Git 状态、显式 Linux PATH 和离线 npm 配置；逐路径比较 manifest，修正遗漏的 README 同步。
- 另一处 runner 契约：直接 `tsx` 启动 protocol script 时没有 `npm_execpath`，跨阶段 memory fixture 的 `npm test` transition 会在报告前失败。按项目入口 `npm run eval:protocol-smoke -- --task ...` 执行后 transition 工作正常，因此 Linux 九卡 runner 和 protocol 脚本均通过 npm script 启动。
- 验证：最终候选 `sha256:0137267884b19f6e1944f2e2d1ae9a2569e8fb002fd92c754ea9acb98b7d2580` 在 Windows 与 Ubuntu 24.04 WSL 均通过 187 tests、16 benchmarks、116-file release pack；双平台九卡独立 oracle 9/9、包 smoke 通过。Linux interrupt card 确认进程树终止、同一 session/task 恢复且无重复写。80×24 Linux TUI 启停 transcript 退出码为 0。
- 未覆盖：这不是托管 GitHub Actions 运行；WSL TUI smoke 不覆盖中文 IME、实际 resize/粘贴、审批焦点或长历史可用性，也不是视频录屏。
- 状态：本地 Linux 路径已验收；远端 CI 和人工 TUI/录屏仍 pending。

## 2026-10-06：一次 usage 完整的 smoke 不能证明整组 campaign 可计量

- 关联：R4-07、R4-08、R7-01～R7-02。
- 触发/观察：最终候选 `sha256:0137267884b19f6e1944f2e2d1ae9a2569e8fb002fd92c754ea9acb98b7d2580` 的 `actlume-control` short-regression smoke 获得 5/5 usage-known response、独立 oracle pass。依此按工作计划冻结新的 24-attempt campaign 后，前五次 attempt 的 50 个 response 均有 usage，第六次 guardrail-treatment attempt 的 10 个 response 有 1 个缺失 usage。Campaign index 只累计 279,106 known tokens，将 usage 标为 incomplete 并停止，18 个 attempt 未启动。
- 根因/限制：单次 smoke 只能验证当前请求链路，不足以保证后续每个 provider response 都含 usage。未知 response 的 body 未保存，现有证据无法判断是 provider 返回体缺字段、流式 usage 形态还是代理解析差异；不得猜测缺失量，也不能把 279,106 称为总 usage。
- 决策与替代方案：保留一条 usage-unknown 记录并停止 campaign，不将当前 attempt 重试后覆盖原结果，也不把旧 candidate 的 holdout 或 smoke 拼接进新 manifest。可用 provider 若能稳定暴露 usage，需创建新 freeze；如决定改代理解析，应先用受控响应回归并在新候选上重新冻结。
- 验证证据：`.agent-benchmark/frozen-experiments/round2-core-dev-01372678.json` 与 `round2-core-dev-01372678-results.json`；逐 attempt raw reports 在 `.agent-benchmark/real-model-smoke/`。模型 `deepseek-v4-pro`，revision/sampling unknown。结果仅有首个 repeat，不能做严格配对或策略收益估计。
- 状态：usage-unknown stop 已验证；provider usage 一致性仍未解决，G7 pending。

## 2026-10-06：usage-unknown 需要保留可诊断的响应结构

- 关联：R4-03、R4-07～R4-08、R7-01～R7-02。
- 触发/观察：最终候选 `sha256:0137267884b19f6e1944f2e2d1ae9a2569e8fb002fd92c754ea9acb98b7d2580` 的 development campaign 有一条 HTTP 200 response 未返回可解析 usage。旧代理只留下 aggregate unknown 计数；raw body 未保留，因此不能事后区分缺少 `usage` 字段、`usage: null`、字段格式不兼容或流解析问题。
- 决策：在候选 `sha256:c3e044f564b2850a1bd2f64b4cf661bb2eb7a28c487e966b2cce67a39c326c70` 中增加限量 safe observation：HTTP status、content type、response bytes、请求是否要求 stream、SSE data/JSON/usage 计数、`[DONE]` 是否出现及 missing/null/invalid reason。最多保留 16 条 unknown observation；不持久化 prompt、response body 或 header secrets，也不更改缺失 usage 的停止规则。
- 替代方案与代价：保存完整 response 可帮助事后重放，但会持久化用户提示和模型输出并扩大数据保留范围；只记计数仍不能诊断，继续按未知 usage 计量会使预算失去可追踪性。采用无正文结构计数，后续若仍无法定位，再增加明确脱敏后的字段而非默认落盘正文。
- 验证：`src/eval-provider-proxy.test.ts` 的 5 项代理测试通过，覆盖有 usage、字段缺失、usage null、格式错误和请求失败；`npm run typecheck` 通过。新候选 Windows/Ubuntu 的完整 release/protocol/package 验收及 provider bounded probe 尚待执行。
- 未覆盖：原始 unknown response 无法追溯分类；新 observation 只能作用于后续运行。DeepSeek 官方接口说明流式 usage 位于结束前的 chunk，但这不能证明此前那条响应的真实形态。
- 状态：代理诊断实现已完成、定向测试通过；双平台候选验收和后续 usage 稳定性验证待执行。

## 2026-10-06：第一版 usage 诊断漏掉了代理异常路径

- 关联：R4-03、R4-07～R4-08、R7-01～R7-02。
- 候选与证据：候选 `sha256:c3e044f564b2850a1bd2f64b4cf661bb2eb7a28c487e966b2cce67a39c326c70` 的新 freeze `.agent-benchmark/frozen-experiments/round2-core-dev-c3e044f5.json`。Campaign index `.agent-benchmark/frozen-experiments/round2-core-dev-c3e044f5-results.json` 在 4/24 次 attempt 后停止，20 次未启动，保留 174,281 known tokens；第 4 次 attempt 有 1 个 unknown usage。
- 触发/观察：unknown attempt 的 raw report `.agent-benchmark/real-model-smoke/stale-memory-01-36b57bb6-68f5-443a-8dff-edae42547c42/report.json` 显示 `usageUnknownRequests=1`、`usageUnknownObservations=[]`、`upstreamHttpErrors=0`。这是代理计数器的异常分支绕过了正常 response observer；根据当时的代码路径，这是 request/stream 处理抛错后的 catch 路径，而不是已证实 provider 返回缺少 `usage` 字段。错误原文没有保留，无法进一步归因。
- 根因：第一版只在 `forwardAndReadUsage()` 正常结束且没有 usage 时追加 observation。fetch 或 response-stream 中途抛错时，catch 仅增加 unknown 汇总计数，因此新 campaign 虽然有诊断字段，仍未能记录这条关键请求的状态码、字节数和流进度。
- 采用方案与替代方案：扩展 observation reason 为 upstream-request-error / response-stream-error / request-aborted，并在读流异常时回传截至失败时的计数；catch 不保存异常消息或正文。相较保存原始错误正文，结构化原因避免保存可能包含 endpoint/body 的任意字符串；相较忽略 catch observation，它保留了后续归因所需的 HTTP/流状态。
- 验证：`npm run typecheck` 与六项 `src/eval-provider-proxy.test.ts` 通过，新增网络失败和中途 stream error 受控回归，并确认报告不含错误正文。修复后的候选双平台完整验收和新 campaign 尚未运行。
- 未覆盖：当前候选的旧 unknown 请求无法追溯；新观察能够区分网络发起失败、响应流异常和本地请求取消，但仍不能解释 provider 内部错误，也不会补齐 token 数。
- 状态：漏记路径已定位并修复，定向测试通过，候选全量验收待进行。

## 2026-10-06：SSE 已发出 `[DONE]` 后的取消被误记为传输失败

- 关联：R4-03、R4-07～R4-08、R6-07、R7-01～R7-02。
- 触发/观察：诊断候选 `sha256:b2ea6ca1cce786db73992160729261b2087e067eedc5160b8ae6718081911baf` 的 bounded smoke 报告 `.agent-benchmark/real-model-smoke/short-regression-01-e9d8e404-20af-4603-8d0a-3400e6ef9b4d/report.json` 中，未知请求为 HTTP 200 `text/event-stream`，收到 19 个 SSE data event、18 个 JSON event 和 `[DONE]`；18 个 usage 字段事件中 17 个是 null、0 个格式错误，但 `requestAborted=true`，旧分类给出 `request-aborted`。这说明协议终止标记已到达后仍观察到取消；不能仅凭它断定是哪一端先关闭连接。
- 根因：代理把上游自然 EOF 当成唯一的流成功条件。客户端读到 SSE `[DONE]` 后结束响应体时，代理仍在等 EOF；若此时 abort，catch 会优先记作 request-aborted，掩盖了“协议已结束但 usage 缺失”的事实。
- 采用方案与替代方案：在候选 `sha256:eb941e32dedaa14457832fead79d1c2233348f7efc695f67bfaa94b7cf36c4ca` 中，只有当 signal 已 abort 且 `[DONE]` 已解析时，才按协议完成响应分类，并继续按 missing/null/invalid 记录 usage；仍保存 `requestAborted` 元数据，因此不会把 usage 缺失变成零，也不会放宽计量预算。替代方案是保存完整响应正文（会持久化提示和模型输出）或忽略未知量（会使预算不可审计）。
- 验证：新增受控回归覆盖 `[DONE]` 后代理关闭/消费者取消，确认 observation 保留 abort 标志、reason 为 `usage-null-only`；代理定向测试 7/7、typecheck 通过。候选 `eb941e32` 在 Windows 与 Ubuntu 24.04 WSL 各通过 191/191 tests、16/16 benchmarks、116-file package；双平台九卡协议 9/9、package smoke、15 项 fixture preflight 和 80×24 TUI startup/exit smoke 通过。新 bounded smoke 为 5/5 usage-known 且 oracle pass；24 次策略对照 campaign 仍在运行。
- 未覆盖：原始 unknown response 不包含正文，无法重放或补回 token 数；本次观测仍无法辨别 provider 是否在 `[DONE]` 后保持连接。修复只处理已收到终止标记后的取消，不改变未知 usage 的保守计数策略。
- 状态：代理误分类已修复并在当前候选验证；后续 bounded smoke 5/5 usage-known，development campaign 24/24 与 post-freeze confirmation 8/8 均完整计量。实验报告已经记录混合 oracle 结果和模型 metadata 缺失；不据此声称策略收益。

## 2026-10-06：WSL PATH 与挂载层会把 Windows 通过误标成 Linux 验收

- 关联：R0-01、R2-03、R4-03、R6-06～R6-07。
- 触发/观察：复核 WSL 的早期 CI 日志时，`npm` 实际解析到 Windows `node.exe`，发行的 Linux Node 尚未安装。日志中的 `D:\...` 路径、Node 平台标记与 Pi 子进程行为均不符合 Linux 原生运行；因此此前 `.agent-benchmark/linux-ci/` 下经 Windows Node 生成的 release、package、protocol、fixture-preflight 与 TUI 记录撤销为 Linux 证据。之后即便切到原生 Linux Node，直接从 `/mnt/d` 加载候选源码仍出现 Node/esbuild 进程处于不可中断 I/O 等待，协议卡超时。
- 根因：WSL 会把 Windows PATH 追加到 Linux PATH，不能只根据执行入口是 `wsl.exe` 判断运行平台。`/mnt/d` 的跨系统文件访问也不能等同于 Linux ext4 文件访问。另一个复现陷阱是 protocol memory-transition oracle 依赖 `npm_execpath`；直接调用 `node --import tsx` 会绕过 runner 约定，使独立 `npm test` 复验失败。
- 采用方案与替代方案：安装经官方 SHA-256 校验的 Node 24.14.1 Linux x64；固定干净 Linux PATH，逐次记录 `process.platform`/`process.arch`；将候选副本放进 WSL ext4，并运行 `npm run eval:protocol-smoke` 而非直接执行 Node。通过 worktree manifest 复核 ext4 副本候选仍为 `8171b1cde5c1cda556a42654702f597362db419a10370261d9f5c7a25ec4e831`。从 Windows 复制依赖时 Linux 可执行位丢失，需在隔离副本恢复 esbuild 与 `.bin` 权限。替代方案是只依赖托管 Linux CI；本地 ext4 副本保留了更快的故障定位，但增加了复制和平台身份验证工作。
- 验证证据：Ubuntu 24.04 WSL2 原生 Linux Node 24.14.1 下初版候选 `8171…e831` 的 `release:dry`、九张 protocol、package smoke 和 15 卡 preflight 均通过；之后 README 校正形成最终候选 `1897300d…e59677f`，Windows 与 ext4 manifest 一致，并重跑 Linux `release:dry`、9/9 protocol、package smoke 和 15 卡 preflight。最终报告分别见 `.agent-benchmark/linux-ci/release-dry-1897300d-native-ext4.log`、`protocol-runs/summary-1897300d-native.json`、`package-smoke-1897300d-native-ext4.json` 与 `fixture-preflight-1897300d-native.json`。
- 未覆盖边界：WSL 是 Linux 内核上的本地运行，但仍不是 GitHub-hosted runner；因此仍需 hosted CI 确认 workflow 和 runner 行为。旧 WSL 日志保留作审计，不用于 Linux 通过率。
- 状态：平台误标已修正；当前候选 native Linux 本地检查已验收，托管 Linux runner 仍待验证。

## 2026-10-06：PTY 驱动把正常退出码 0 误判成仍在运行

- 关联：R6-09、R7-05。
- 触发/观察：为最终候选增加可复现的 Linux PTY 尺寸/输入 smoke 时，raw transcript 已显示 Pi TUI 收到 bracketed Unicode 多行粘贴、清空输入并退出，但第一版结构化报告给出 `exitCode=null`，驱动还尝试执行超时清理。
- 根因：POSIX `waitpid(pid, WNOHANG)` 返回 `(pid, 0)` 表示子进程以退出码 0 正常结束；只有返回 `(0, 0)` 才表示仍在运行。驱动只看第二项并把 0 当作未结束，因此把成功退出误标成 timeout。它是测试驱动问题，不是 Pi/Actlume 退出失败。
- 采用方案与替代方案：检查 `waitpid` 返回的 PID，再单独解码状态；保存原始 PTY transcript，并在子进程退出后读取 canonical/echo/signal 模式。替代方案是只记录键已发送或根据 screen hint 推断退出，这不能证明实际退出状态。
- 验证证据：`docs/support/tui-pty-smoke.py` 在 Ubuntu 24.04 WSL2 原生 Node 24.14.1/Pi 1.0.2 下以当前候选 `sha256:1897300d…e59677f` 运行成功。报告 `.agent-benchmark/demo/tui-pty-matrix-1897300d-native/tui-pty-smoke.json` 记录 80×24 启动、120×40 resize、Unicode/emoji 多行 paste 可见、Ctrl+C/Ctrl+D、exit code 0 和三种终端模式恢复；raw transcript 同目录的 `.typescript` SHA-256 为 `9f4eef5d3b4e3f2d755ad9f722c9b64854a060fda217ccfec6b8c942fc60ebcb`。
- 未覆盖边界：PTY 注入不模拟操作系统 IME 组合、不验证真人终端渲染/审批焦点/长历史，也不构成视频录屏。R6-09 仍等待 Windows/Linux 人工矩阵和交互演示。
- 状态：驱动误判已修复并通过最终候选复验；完整人工终端验收仍待执行。

## 2026-10-06：审批 smoke 把字母 `n` 当成 No，确认了默认 Yes

- 关联：R2-07、R6-09。
- 触发/观察：确定性 provider 返回 `shell` tool call 后，Pi TUI 正常显示 Actlume permission dialog。第一版驱动发送字母 `n`，但没有观察弹窗的导航说明；随后它以 Enter 确认了仍处于选中状态的默认 Yes，安全的 `echo ACTLUME_APPROVAL_SMOKE_EXECUTED` 被执行。此轮仅在隔离 ext4 副本运行，无文件写入。
- 根因：Pi 的 Yes/No dialog 不是按 `y`/`n` 字符快捷键选择，而是方向键移动、Enter 确认；“按下 n 就代表拒绝”的假设来自测试驱动，不是应用契约。自动化只断言对话框标题可见，未检查 provider 返回的 tool result，因此一度未发现误批准。
- 采用方案与替代方案：使用 dialog 明示的 Down+Enter 导航到 No；启动时显式设置 `AGENT_PERMISSION_MODE=default`，避免继承开发机权限模式；再检查 provider 收到 `User rejected shell.`、tool reply 不含 echo 输出、最终 TUI exit 0。替代方案是仅按标题可见或只发一个字母，这无法证明焦点和最终选择。
- 验证证据：`docs/support/tui-approval-pty-smoke.py` 在 Ubuntu 24.04 WSL2 原生 Linux Node 24.14.1/Pi 1.0.2 下使用进程内本地 OpenAI-compatible provider、最终候选 `sha256:1897300d…e59677f` 通过。报告 `.agent-benchmark/demo/tui-approval-pty-1897300d-native/tui-approval-smoke.json` 记录审批弹窗可见、Down+Enter、tool reply `User rejected shell.`、`commandOutputAppearedInToolReply=false`、provider errors 0、exit code 0；raw transcript 同目录 `.typescript` SHA-256 为 `416123211abcfc88c0c44d30df63038a891b9553dc1d1d0a42992fdb94e7989f`。
- 未覆盖边界：驱动验证 Linux PTY 的键盘路由和拒绝结果，不评估真人对审批焦点、按钮强调、可读性或屏幕渲染的体验；Windows 与人工完整矩阵/录屏仍待验收。
- 状态：自动审批拒绝 smoke 已修复并通过；人工终端验收仍待执行。

## 2026-10-07：Windows 扩展路径命名空间让合法 artifact 被误判为越界

- 关联：R5-08、R6-07。
- 触发/观察：PR #1 的 Windows hosted job 在 `src/tools/artifact.test.ts` 中失败；相同候选的 Ubuntu job 通过。Windows 失败发生在 `readArtifact` 读取 memory artifact，调用方使用的是有效文件路径。
- 根因：Windows 可以用 `\\?\\` 扩展长度命名空间表示同一文件。实现先对 `resolve(candidate)` 与普通 workspace root 做词法 `relative()` 比较，两个等价路径的拼写不同，因而在验证 canonical path 前就拒绝了合法文件。
- 采用方案与替代方案：保留请求路径的越界判断，先对候选文件执行 `realpath()`，再比较 canonical path，并将真正的符号链接逃逸与请求路径越界区分。增加 Windows 回归测试，直接用 `\\?\\` 路径读取同一 artifact。替代方案是删除 Windows 路径输入或忽略 hosted job；前者不符合本机路径语义，后者会留下跨平台回归。
- 验证证据：候选 `sha256:e34d0393be5931f6de41c029c46139f3ae493c8a2f54afc2be805c9a9fddcc03` 的 Windows `npm run ci` 通过 192/192 tests、16/16 benchmarks；原生 Linux `release:dry` 也通过。定向 Windows artifact/runtime 测试 22/22 通过。修复已进入 PR #1，最新 hosted rerun 尚待确认。
- 未覆盖边界：WSL2/ext4 Linux 本地通过不等同 hosted Linux runner；最新 PR 双平台 job 仍须通过。
- 状态：修复已验收本地；托管复验待执行。

## 2026-10-07：dotenv 覆盖与全局 Pi/MCP 配置污染测试边界

- 关联：R6-03、R6-09。
- 触发/观察：审批 PTY smoke 初版中，测试显式配置的 localhost provider 没有收到请求（本地 mock `providerRequestCount=0`），TUI 却显示了另一模型配置并提示发现额外 MCP server，随后出现 shell 拒绝流程。该运行无法证明请求始终留在本地；当时没有记录实际请求的最终 endpoint 或完整 payload，因此不能确定是否触达配置中的外部 provider，也不能把该次记录算作有效 smoke。此前发送字符 `n` 的审批尝试也曾误选默认 Yes，单独在隔离临时仓库运行且已在历史条目中记为无效。
- 根因：`src/main.ts` 用 `dotenv.config({ override: true })` 让项目 `.env` 覆盖了测试进程显式传入的 endpoint/model；PTY 子进程又继承开发机 Pi 配置和 MCP 设置。测试 server 的计数为零只证明请求没有到该 localhost server，不能据此宣称没有其他请求。
- 采用方案与替代方案：改为 dotenv 仅补充缺失环境变量，显式进程配置保持优先；新增 `/doctor` 子进程集成回归验证 endpoint/model 优先级和 key 不回显。PTY smoke 为每次运行创建独立 `PI_CODING_AGENT_DIR`、设置 `PI_OFFLINE=1`、写入空 MCP 配置，并使用本地 deterministic provider。审批选择按弹窗指引使用 Down+Enter 到 No，然后检查 provider tool reply、无命令输出和退出码。替代方案是只检查弹窗文本，无法验证实际请求目标、选择结果和副作用。
- 验证证据：候选 `sha256:e34d0393be5931f6de41c029c46139f3ae493c8a2f54afc2be805c9a9fddcc03` 中 `/doctor` dotenv 回归通过；隔离 Linux PTY 审批报告 `.agent-benchmark/demo/tui-approval-pty-e34d0393-native/tui-approval-smoke.json` 记录 `providerRequestCount=2`、无 provider errors、弹窗可见、No 已发送、`User rejected shell.`、命令输出未进入 tool reply、exit 0。
- 未覆盖边界：初版污染运行的 endpoint 与 payload 无法从已保存证据还原，故保持未知并排除，不推断“已发送”或“没有发送”。用户原有本地配置未修改；仅清理了本轮创建的临时 WSL 副本。确定性 mock 验证隔离路径，不代替真实 provider 的独立显式探针。
- 状态：隔离缺陷和回归已修复并在当前候选通过；初版 smoke 永久不计为通过证据。

## 2026-10-07：整树复制 Windows checkout 造成 ext4 候选出现 CRLF 噪声

- 关联：R0-01、R4-03、R6-07。
- 触发/观察：为用 WSL2 原生 Linux 复验 Windows 工作区的最后几处修改，将整个 Windows checkout 覆盖到既有 ext4 副本后，manifest 报出 172 个文件变化，而真实候选仅包含少量有意修改。
- 根因：全树复制经过 Windows/WSL 文本换行处理，CRLF/LF 差异把未修改文件也标成 dirty；若直接对该副本跑验收，会让候选哈希与 Windows 工作区不一致。
- 采用方案与替代方案：重置隔离 ext4 clone，只复制六个明确修改过的源码/驱动文件，再运行相同 manifest。Windows 与 Linux manifest 最终都得到 `e34d0393…cc03`、4 个 production inputs。替代方案是继续使用全树复制，但会污染候选身份；只依赖托管 Linux CI 则不能在本地快速定位复制层错误。
- 验证证据：`.agent-benchmark/windows-ci/manifest-final-after-dotenv-isolation.json` 与 `.agent-benchmark/linux-ci/manifest-final-e34d0393-native.json` 的候选 SHA、Node 版本和 4 个输入哈希一致；两端 release dry 均通过。
- 未覆盖边界：这解决的是本地快照一致性；托管 CI 仍用独立 checkout 和平台 runner 验证。
- 状态：候选副本已清理并复验一致。

## 2026-10-07：Windows runner 上不存在的 artifact 被扩展路径前缀误报为越界

- 关联：R5-08、R6-07。
- 触发/观察：PR #1 commit `9d4d6a7` 的 hosted Windows job 第二次运行时，原先的 extended-length 已存在文件读取回归通过，但同一测试中仓库内缺失文件的断言失败：期望 `ARTIFACT_NOT_FOUND`，实际返回 `ARTIFACT_PATH_OUTSIDE_ROOT`。Ubuntu job 通过。日志见 `https://github.com/xiaoyao6657/ACTLUME-AGENT/actions/runs/37497953580/job/112387247780`。
- 根因：Windows runner 的 `realpath()` 返回路径与 `resolve()` 得到的普通/扩展路径格式不一致。已有文件的 `realpath()` 会让路径比较成功，但在文件不存在时只能比较尚未 canonicalize 的路径；`relative()` 把等价的 drive root 当成不相容路径，进而误判越界。本地 Windows runner 的临时路径格式没有触发这个差异。
- 采用方案与替代方案：在执行相对路径包含检查前，统一比较路径表示：Windows 下将 `\\?\\` drive 前缀去除，并把 `\\?\\UNC\\` 转回普通 UNC；然后仍对现存目标执行 `realpath()`，单独拒绝真正的 symlink escape。测试覆盖普通路径与 `\\?\\` 路径下的缺失 artifact 都返回 `ARTIFACT_NOT_FOUND`，并覆盖已有扩展路径读取与 outside-root 拒绝。替代方案是仅在本机通过后忽略 hosted failure，或把一切 `ENOENT` 都当作 not-found；前者遗漏平台差异，后者会混淆目录外缺失请求。
- 验证证据：增量候选 `sha256:49dd8d0d7958685aafa453b9628b4c7d99b7ce8033eb66d877648ec988c095e3`（相对 base `9d4d6a75…`）的 Windows `npm run ci` 通过 192/192 tests、16/16 benchmarks；`npm run smoke:package` 通过；九张 Windows protocol/oracle 均通过，15 张 fixture preflight 完成且 `qualityClaim=false`。最新 hosted PR rerun 仍待执行。
- 未覆盖边界：本地 Windows 全量通过不能代替 hosted Windows runner；当前还需由 PR 最新 commit 的两端 Actions 验证。
- 状态：实现和本地回归已验收；最新 hosted 复验待执行。

## 2026-10-07：Windows hosted runner 将有效 artifact 读取误判为越界

- 关联：R5-08、R6-07。
- 触发/观察：PR #1 commit `6ae8b7c` 的 Ubuntu job 通过、Windows job 失败；既有扩展路径 artifact 读取在 `src/tools/artifact.test.ts:29` 失败，Pi compaction/reopen 集成测试中的普通 artifact 回读也在 `src/pi-runtime.test.ts:556` 失败。日志：<https://github.com/xiaoyao6657/ACTLUME-AGENT/actions/runs/37501138407/job/112398139390>。
- 根因：上一修复在访问目标前，将 `realpath()` 得到的 canonical artifact root 与尚未 canonicalize 的输入路径做 containment 比较并立即拒绝。GitHub Windows runner 上等价路径表示不同，导致 `relative()` 产出跨根路径；已有文件本应先 `realpath(candidate)` 再作最终物理边界检查。相同表示差异也会影响 `ENOENT` 请求分类。
- 采用方案与替代方案：对已存在文件，只依据 canonical root 和 canonical target 判断是否越界；对 `ENOENT`，沿请求路径向上解析最近的现存祖先，再确认该祖先是否属于 artifact root，区分根内缺失和根外请求。若现存目标在物理根外，仍根据请求路径的词法位置区分直接越界与 root 内 symlink escape。替代方案是保留早期词法拒绝，会继续拒绝有效 Windows alias；将所有 `ENOENT` 当作 not-found 则会把 root 外请求混为一类。
- 验证证据：增量候选 `sha256:a857d20fa11ac35e72eea8105bdd145733e2782f750d6532291867bc8fc4ae15`（相对 base `6ae8b7c…`，1 个 production input）本机 Windows `npm run ci` 通过 192/192 tests、16/16 benchmarks；`npm run smoke:package` 通过；九张 deterministic protocol/oracle 全通过；15 张 fixture/oracle preflight 完成且 `qualityClaim=false`。artifact 单测覆盖普通/扩展路径的现存文件读取和缺失文件分类；Pi compaction/reopen artifact 回读集成测试通过。
- 未覆盖边界：本地 Windows 结果不能替代 GitHub hosted runner；修复版本的最新双平台 Actions 尚待提交后运行。fixture preflight 和 deterministic protocol 只验证 harness/runtime contract，不证明真实模型任务质量。
- 状态：代码与本地回归已通过；hosted 复验待执行。

## 难题条目模板

复制此结构并填写，不存在的证据标为未知：

```text
日期 / R ID：
触发场景 / 候选 manifest：
重现命令：
观察到的原始结果：
根因：
采用方案与替代方案：
验证证据：
未覆盖边界：
状态：待验证 / 已复现 / 已修复待验 / 已验收
```
