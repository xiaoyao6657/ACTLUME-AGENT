# ADR 0002: 通过 Pi 活动分支记录持久化 Actlume 任务状态

- 状态：采纳，需在进程终止与分支夹具中验证。
- 日期：2026-10-05。
- 关联工作：R1。

## 背景

Pi SessionManager 是对话 transcript 和会话树的权威来源；Pi 自己的工具结果、模型消息与分支关系不能由 Actlume 再写一套可编辑 transcript 替代。Actlume 需要额外保存 taskId、baseline、要求 revision、计划、工具意图/结果及检查引用。目前 Pi extension 每次 `before_agent_start` 重置这些字段，因此新一轮 prompt 和恢复会话无法找回任务进度。

当前安装的 Pi 1.0.2 暴露 `ExtensionAPI.appendEntry`，readonly SessionManager 暴露 `getBranch()` 和 `getLeafId()`，并提供 session start/tree hooks。API 形态支持让 Pi 活动分支承载领域事实；同步追加在操作系统进程被强制终止时实际持久化到何种程度，仍须通过固定版本的故障夹具验证。

## 决策

Actlume 领域事实写成带版本的 Pi custom entries。TaskState 是从**当前活动分支**上的领域记录 reducer 投影出来的可重建状态，不作为第二个可以独立修改的 transcript 或 event log。

Pi sessionId 与树 entry ancestry 决定 branch 上下文；taskId 跨多轮保持稳定；每次执行 attempt 有新的 runId。workspace 身份、task ID 和原始 baseline 一起记录。计划、需求变更、工具意图/结果、验证引用和任务状态更新均显式关联来源 entry。工具事件可以并行执行，但产生的领域记录由串行入口按唯一 ID 追加；重复恢复和竞态结果必须可识别。

JSONL runtime 事件与文件缓存只用作诊断或可重建投影。它们不与 Pi custom entries 各自成为可独立修改的事实来源；含原始输出的 artifact 保留 URI/哈希引用。

## 分支、压缩和恢复边界

- `session_start` 和 `session_tree` 从活动分支重建 TaskState；fork 从父 ancestry 初始化，并将子分支后续事实保留在子分支。
- Pi 对话树切换不会恢复或回滚文件系统。当前 Git 工作区和适用环境指纹始终参与检查证据判断。
- 被压缩的对话内容不能替代结构化领域记录。压缩前已有 task checkpoint 仍需从 `getBranch()` 或保留区恢复；如 Pi 改变 ancestry，必须有单独适配。
- schema 无法解析、workspace 不匹配、条目/结果缺失时显式报告恢复不完整。旧 session 只能被标为 unknown，不能推断为 verified。
- 强制终止进程可能丢失末尾记录；恢复最近一次确认状态，并把正在执行的副作用标为 unknown。本 ADR 不声称具备断电持久性或外部操作恰好执行一次的能力。

## 后果

- Pi 保留唯一对话记录，Actlume 只持久化它的业务语义。
- `/result`、`/changes`、`/verify` 与 system context 应从同一 branch projection 读取，不能使用扩展进程内闭包作为恢复后的权威。
- 写 custom entry 与 mutation 必须串行化并带稳定 event ID；将一个状态快照缓存写回磁盘之前，需要检测叶子/版本变化。
- 扩展重载、会话切换、fork、compaction 和 context summary 都成为要覆盖的生命周期边界。
- 发生未知副作用时将用户检查设为恢复步骤，不能自动重试 shell/MCP 写操作。

## 需要证伪或重新评审的条件

- Pi 的 `appendEntry` 在 process kill 后无法达到所需 checkpoint 语义，或活动分支 API 不能正确覆盖 Actlume records。
- compaction/tree traversal 导致合法 task record 被丢弃且没有受支持恢复点。
- custom entry 的 append 高频写入明显损害运行性能。

若出现以上情况，比较一份以 Pi branch entry ID 为父版本的原子 sidecar projection；保留单一权威原则，并为该方案单独增加 ADR 和故障测试。
