# actlume

`actlume` 是一个用 TypeScript 编写的本地 ReAct Agent CLI。它用于学习和验证一个轻量代码助手如何完成 `Reason -> Act -> Observe -> Final` 循环，并逐步扩展为可用原型。

它目前适合做：项目结构阅读、文件检索、代码小修改、运行检查命令、记录任务状态，以及通过 MCP 接入外部工具。

## 当前能力

- OpenAI-compatible Chat Completions：支持 OpenAI、DeepSeek 等兼容接口。
- 本地工具：项目扫描、编辑计划、目录树、文本搜索、文件读写、patch、受控 shell、历史回忆、任务追踪。
- 交互式 CLI：支持一次性任务和持续会话。
- 安全控制：写入、patch、shell 和非只读 MCP 工具默认需要确认；支持 `--readonly` 和 `--yes`。
- MCP 扩展：可通过 `.agent-mcp.json` 接入搜索、浏览器、数据库、GitHub 等外部工具。
- 运行日志与记忆：工具调用、任务状态和每次 run 会写入 `.agent-memory`。
- 代码修改工作流：写入前需要 `editPlan`，写入后自动记录变更摘要，并可自动运行建议检查命令。
- Benchmark：内置固定任务集，用于验证核心工具和控制逻辑。

## 环境要求

- Node.js >= 22
- npm
- OpenAI 或 OpenAI-compatible API Key

## 安装

```bash
npm install
```

复制环境变量示例：

```powershell
Copy-Item .env.example .env
```

编辑 `.env`：

```env
OPENAI_API_KEY=your_api_key_here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4.1-mini
AGENT_MAX_STEPS=10
AGENT_MEMORY_DIR=.agent-memory
AGENT_READONLY=false
AGENT_MCP_CONFIG=
```

DeepSeek 示例：

```env
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_MODEL=deepseek-v4-pro
```

## 使用方式

在项目内运行：

```bash
npm start -- "查看当前项目结构并总结"
npm start
npm run typecheck
npm run benchmark
```

注册全局命令：

```bash
npm link
```

之后可以在任意目录使用：

```powershell
actlume
ma
actlume "查看当前项目结构并总结"
actlume --cwd D:\workspace\my-app "分析这个项目"
actlume --readonly "只读分析项目，不修改文件"
actlume --yes "修复一个小问题并运行检查"
```

常用交互命令：

```text
/help          查看帮助
/cwd           查看当前工作区
/cwd <path>    切换工作区
/status        查看模型、工作区、只读模式和记忆目录
/tools         列出可用工具
/mcp           查看 MCP 状态
/mcp reload    重新加载 MCP server
/memory        查看记忆统计
/model <name>  切换模型
/readonly on   开启只读模式
/readonly off  关闭只读模式
/yes on        开启自动确认
/yes off       关闭自动确认
/exit          退出
```

## MCP 扩展

MCP 是扩展外部能力的推荐方式。配置查找顺序：

1. `--mcp-config <path>`
2. `AGENT_MCP_CONFIG`
3. 当前工作区的 `.agent-mcp.json`
4. actlume 项目目录的 `.agent-mcp.json`

示例：

```powershell
Copy-Item .agent-mcp.example.json .agent-mcp.json
```

配置格式：

```json
{
  "servers": {
    "search": {
      "command": "npx",
      "args": ["-y", "some-search-mcp-server"],
      "env": {
        "SEARCH_API_KEY": "your_key_here"
      },
      "cwd": ".",
      "toolPrefix": "mcp_search"
    }
  }
}
```

注意：项目本体没有内置联网搜索。实时信息、新闻、比分、网页内容等能力应通过 MCP 或后续 web search 工具接入。

## 主要工具

- `projectScan`：生成轻量项目索引、语言分布、关键文件、脚本和建议检查命令，并缓存到 `.agent-memory/project-index.json`。
- `editPlan`：在修改文件前记录计划、预期文件和步骤。
- `listDir` / `tree`：查看目录和目录树。
- `searchText`：使用 JavaScript 正则搜索文本。
- `readFile` / `writeFile` / `appendFile` / `fileExists`：文件操作。
- `applyPatch`：应用 unified diff。
- `shell`：执行受控 shell 命令。
- `recall`：检索历史 action。
- `taskList` / `taskAdd` / `taskUpdate`：任务追踪。

## 项目结构

```text
actlume/
|-- bin/                 全局 CLI 入口
|-- src/
|   |-- main.ts          CLI 入口和交互模式
|   |-- agent.ts         ReAct 主循环
|   |-- llm.ts           LLM 调用封装
|   |-- project-scan.ts  项目扫描
|   |-- mcp-client.ts    MCP 桥接
|   |-- tools/           本地工具
|   `-- benchmark.ts     benchmark runner
|-- README.md
|-- README.en.md
|-- package.json
`-- tsconfig.json
```

## 后续构建 TODO

目标是把 `actlume` 从学习型 MVP 推进到可用原型。

- [x] 项目扫描与上下文索引
  - [x] 新增 `projectScan` 工具。
  - [x] 自动识别项目类型、语言分布、关键文件、package scripts 和建议检查命令。
  - [x] 将轻量项目快照注入 Agent prompt。
  - [x] 将项目摘要持久化到 `.agent-memory/project-summary.md`。
  - [x] 为大仓库增加指纹校验、增量复用和缓存策略。
- [x] 代码修改工作流
  - [x] 修改前生成计划和预期文件列表。
  - [x] 修改后输出 diff 摘要。
  - [x] 自动识别并运行合适的检查命令。
  - [x] 检查失败后支持有限轮自动修复。
- [ ] 权限和安全系统
  - [ ] 增加命令风险识别。
  - [ ] 默认限制写入当前 workspace。
  - [ ] 支持工具权限配置和命令 allowlist / denylist。
- [ ] 配置系统
  - [ ] 支持项目级 `.actlume/config.json`。
  - [ ] 支持用户级 `~/.actlume/config.json`。
  - [ ] 明确 CLI 参数、项目配置、用户配置、环境变量和默认值的优先级。
- [ ] MCP 与联网能力
  - [ ] 完善 MCP 状态、工具展示、超时和错误诊断。
  - [ ] 提供 web search MCP 示例配置。
  - [ ] 对实时信息问题要求先调用搜索工具。
- [ ] 交互式 CLI 体验
  - [ ] 命令历史和多行输入。
  - [ ] 彩色输出、Markdown 渲染和 diff 高亮。
  - [ ] `/init`、`/doctor`、`/compact`、`/clear` 等辅助命令。
- [ ] 模型适配和错误诊断
  - [ ] 标准化不同 OpenAI-compatible 服务的异常提示。
  - [ ] 增加模型能力声明和 JSON 修复重试策略。
- [ ] 测试、CI 和发布
  - [ ] 增加单元测试与 CLI 集成测试。
  - [ ] 增加 MCP mock server 测试。
  - [ ] 配置 GitHub Actions。
  - [ ] 准备 npm 发布脚本和 changelog。

## 开发验证

```bash
npm run typecheck
npm run benchmark
```

当前 benchmark 覆盖文件读取、搜索、项目扫描、编辑计划、只读保护、patch、shell、任务追踪和非法工具输入。

## 安全说明

- 建议先在 Git 仓库或测试目录中使用。
- 不加 `--yes` 时，写入和执行类工具会请求确认。
- `--readonly` 会阻止写入和执行类工具。
- `.env`、`.agent-mcp.json` 和 `.agent-memory/` 不应提交到仓库。
