# actlume

`actlume` 是一个 TypeScript 本地代码 Agent CLI，参考 Claude Code / claude-code-from-scratch 的模块化思路实现。它面向真实开发工作流：能读项目、做计划、改文件、跑命令、恢复会话、接入 MCP，并用权限系统控制高风险操作。

## 核心亮点

- **ReAct Agent 主循环**：`Reason -> Act -> Observe -> Final`，支持工具调用、任务状态追踪和最终总结。
- **Claude Code 风格工作流**：Session Resume、Plan Mode、Permission Mode、Skills、Sub-Agent、Typed Memory、workspace instructions。
- **可靠的代码编辑闭环**：内置探索预算、编辑计划、diff 预览、fake edit detection、修改后验证提示。
- **安全权限系统**：写文件、patch、shell、MCP 写操作默认确认；支持敏感文件保护、删除命令识别、只读模式和自动确认模式。
- **上下文工程**：自动注入 `ACTLUME.md` / `CLAUDE.md`、`.actlume/rules/*.md`、git 状态、环境信息；大 observation 会落盘为 artifact，避免挤爆上下文。
- **可扩展工具层**：内置文件读写、搜索、glob、patch、shell、memory、plan、skill、sub-agent 等工具，并可通过 `.agent-mcp.json` 接入外部 MCP 工具。
- **LLM 兼容与稳定性**：支持 OpenAI-compatible Chat Completions（OpenAI、DeepSeek、Ollama 等），带限流/5xx/网络错误指数退避重试。
- **流式与并行能力**：支持 `--stream` 实时预览 thought/answer；read-only 工具具备并行 batcher 基础。
- **工程化验证**：覆盖 CLI、MCP、Session、Security、Plan、Skills、Sub-Agent、Memory、Context、Streaming 等测试。

## 快速开始

环境要求：

- Node.js >= 22
- npm
- OpenAI 或 OpenAI-compatible API Key

安装依赖：

```bash
npm install
```

创建 `.env`：

```powershell
Copy-Item .env.example .env
```

最小配置：

```env
OPENAI_API_KEY=your_api_key_here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4.1-mini
AGENT_MAX_STEPS=10
AGENT_MEMORY_DIR=.agent-memory
```

运行：

```bash
npm start -- "阅读当前项目并总结架构"
npm start
```

可选注册全局命令：

```bash
npm link
actlume "分析这个项目的主要风险"
ma --plan "先制定重构计划，不要修改文件"
```

## 常用命令

```bash
actlume "修复一个小问题并运行检查"
actlume --cwd D:\workspace\my-app "分析这个项目"
actlume --readonly "只读分析，不修改文件"
actlume --plan "进入计划模式"
actlume --accept-edits "自动批准普通编辑"
actlume --dont-ask "自动拒绝需要确认的操作"
actlume --yolo "绕过确认提示"
actlume --stream "开启流式输出"
actlume --resume "恢复最近一次会话"
actlume --resume <session-id> "恢复指定会话"
```

交互式命令：

```text
/help          查看帮助
/status        查看工作区、模型、权限和记忆目录
/tools         列出工具
/mcp           查看 MCP 状态
/mcp tools     查看 MCP 工具
/memory        查看记忆统计
/sessions      列出可恢复会话
/resume [id]   恢复会话
/plan on       开启 Plan Mode
/plan approve  批准计划
/plan execute  批准并执行计划
/skills        列出 Skills
/doctor        检查本地环境
/compact       刷新项目摘要和索引
/model <name>  切换模型
/permission <default|plan|acceptEdits|dontAsk|bypassPermissions>
/readonly on   开启只读模式
/yes on        开启自动确认
/exit          退出
```

## 配置

配置优先级从高到低：

1. CLI 参数
2. 项目级 `.actlume/config.json`
3. 用户级 `~/.actlume/config.json`
4. 环境变量 / `.env`
5. 默认值

可以从示例开始：

```powershell
Copy-Item .actlume/config.example.json .actlume/config.json
```

MCP 示例文件：

```text
.agent-mcp.example.json
```

安全策略示例：

```text
.agent-security.example.json
```

## 关键模块

```text
src/main.ts              CLI 入口、交互命令、session resume
src/agent.ts             Agent 主循环和工具调度入口
src/workflow-guard.ts    编辑工作流护栏和探索预算
src/output-parser.ts     模型输出解析
src/security.ts          权限模式、风险识别、敏感文件保护
src/session.ts           会话快照和恢复
src/prompt.ts            workspace prompt builder
src/plan-mode.ts         Plan Mode 状态和计划文件
src/skills.ts            Skills 发现与渲染
src/subagent.ts          只读 Sub-Agent 执行
src/memory.ts            类型化记忆和召回
src/context-artifacts.ts 大 observation 落盘和引用
src/tool-batcher.ts      read-only 工具并行调度基础
src/llm.ts               OpenAI-compatible 调用、重试、流式输出
src/tools/               本地工具实现
src/mcp-client.ts        MCP server 加载和工具桥接
```

## 验证

```bash
npm run typecheck
npm test
npm run benchmark
```

## 运行数据

以下目录是本地运行产物，默认不提交：

```text
.agent-memory/      session、run log、memory、artifact
.agent-benchmark/   benchmark 沙盒
node_modules/        npm 依赖
```

## 当前边界

- 主循环仍保持单步 JSON ReAct 协议；`tool-batcher` 已具备并行基础，后续可迁移到原生 multi-tool-call 协议。
- Memory 当前以关键词、CJK bigram/trigram 和 substring 召回为主，后续可增加可选语义召回。
- Sub-Agent 默认只读，避免子任务直接修改 workspace。
