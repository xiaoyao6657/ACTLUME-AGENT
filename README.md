# actlume

`actlume` 是一个用 TypeScript 编写的本地 ReAct Agent CLI。它用于学习和验证一个轻量代码助手如何完成 `Reason -> Act -> Observe -> Final` 循环，并逐步扩展为可用原型。

它目前适合做：项目结构阅读、文件检索、代码小修改、运行检查命令、记录任务状态，以及通过 MCP 接入外部工具。

## Demo

建议将演示视频放在 `assets/demo/` 目录下，并使用英文文件名，避免 GitHub Markdown 链接中出现空格、中文或转义问题。

| Demo | 内容 | 视频 |
| --- | --- | --- |
| demo1 | 基础 CLI 工作流：启动 CLI、执行简单任务、展示工具调用与 `.agent-memory` 记录 | [demo1-cli-workflow.mp4](assets/demo/demo1-cli-workflow.mp4) |
| demo2 | 代码任务修复演示：展示 `editPlan -> inspect -> edit -> verify -> final` 的完整闭环 | [demo2-code-repair.mp4](assets/demo/demo2-code-repair.mp4) |
| demo3 | MCP 接入演示：展示 `.agent-mcp.json`、`/mcp`、`/mcp tools` 与外部工具加载 | [demo3-mcp-integration.mp4](assets/demo/demo3-mcp-integration.mp4) |
| demo4 | 真实项目评测结果：展示 Briefcase、Scrapy、Sentry、js-utils 等任务的评测结果与步数 | [demo4-evaluation-results.mp4](assets/demo/demo4-evaluation-results.mp4) |

## 当前能力

- OpenAI-compatible Chat Completions：支持 OpenAI、DeepSeek 等兼容接口。
- 本地工具：项目扫描、编辑计划、目录树、文本搜索、文件读写、patch、受控 shell、历史回忆、任务追踪。
- 交互式 CLI：支持一次性任务和持续会话。
- CLI 体验：支持命令历史、多行输入、彩色输出、diff 高亮和常用辅助命令。
- 安全控制：写入、patch、shell 和非只读 MCP 工具默认需要确认；支持 `--readonly`、`--yes` 和 `.agent-security.json`。
- 配置系统：支持 CLI 参数、项目配置、用户配置、环境变量和默认值的优先级合并。
- MCP 扩展：可通过 `.agent-mcp.json` 接入搜索、浏览器、数据库、GitHub 等外部工具。
- 运行日志与记忆：工具调用、任务状态和每次 run 会写入 `.agent-memory`。
- 代码修改工作流：写入前需要 `editPlan`，写入后自动记录变更摘要，并可自动运行建议检查命令。
- 模型适配和诊断：识别 OpenAI、DeepSeek、Ollama 和通用 OpenAI-compatible 服务，提供更清晰的认证、网关、限流和协议错误提示。
- 测试与发布：提供单元测试、CLI 集成测试、MCP mock server 测试、GitHub Actions、CI 脚本和 npm dry-run 发布脚本。
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

## 配置系统

配置优先级从高到低：

1. CLI 参数
2. 项目级 `.actlume/config.json`
3. 用户级 `~/.actlume/config.json`
4. 环境变量 / `.env`
5. 默认值

可以从示例文件开始：

```powershell
Copy-Item .actlume/config.example.json .actlume/config.json
```

支持的字段：

```json
{
  "workspace": ".",
  "memoryDir": ".agent-memory",
  "readonly": false,
  "maxSteps": 10,
  "model": "gpt-4.1-mini",
  "baseURL": "https://api.openai.com/v1",
  "mcpConfigPath": ".agent-mcp.json",
  "yes": false
}
```

`apiKey` 也可以放入配置文件，但更推荐继续使用 `.env` 或系统环境变量。

## 使用方式

在项目内运行：

```bash
npm start -- "查看当前项目结构并总结"
npm start
npm run typecheck
npm run test
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
/mcp tools     查看 MCP 工具和 schema
/mcp reload    重新加载 MCP server
/memory        查看记忆统计
/init          初始化当前 workspace 配置文件
/doctor        检查本地环境和配置
/compact       刷新项目摘要和索引缓存
/clear         清屏
/model <name>  切换模型
/readonly on   开启只读模式
/readonly off  关闭只读模式
/yes on        开启自动确认
/yes off       关闭自动确认
/exit          退出
```

多行输入可以用行尾反斜杠继续：

```text
请分析这个问题，\
然后给出修改建议
```

交互式命令历史会保存到 `~/.actlume/history`。

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
      "toolPrefix": "mcp_search",
      "startupTimeoutMs": 15000,
      "toolTimeoutMs": 60000
    }
  }
}
```

`/mcp` 会展示 server 连接状态、禁用/失败原因和工具数量；`/mcp tools` 会展示 MCP 工具名称、读写/执行类型和 input schema。

注意：项目本体没有内置联网搜索。实时信息、新闻、比分、网页内容等能力应通过 MCP 接入 web search、browser 或 fetch 工具。Agent 会识别这类任务；如果没有可用搜索类 MCP 工具，会直接提示需要先配置网络搜索，而不是凭空回答。

## 安全策略

默认情况下，文件写入和 patch 会被限制在当前 workspace 内，危险 shell 命令会被拦截。可以从示例文件开始：

```powershell
Copy-Item .agent-security.example.json .agent-security.json
```

支持的策略项：

- `allowedTools` / `deniedTools`：工具 allowlist / denylist，支持精确名称和 `*` 通配。
- `shellAllowlist` / `shellDenylist`：shell 命令正则 allowlist / denylist。
- `allowHighRiskShell`：是否允许 `git reset --hard`、`npm publish` 等高风险命令。

也可以用环境变量覆盖：`AGENT_ALLOWED_TOOLS`、`AGENT_DENIED_TOOLS`、`AGENT_SHELL_ALLOWLIST`、`AGENT_SHELL_DENYLIST`、`AGENT_ALLOW_HIGH_RISK_SHELL`。

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
|   |-- model-adapter.ts 模型适配和错误诊断
|   |-- project-scan.ts  项目扫描
|   |-- mcp-client.ts    MCP 桥接
|   |-- tools/           本地工具
|   |-- test-fixtures/   测试夹具
|   `-- benchmark.ts     benchmark runner
|-- .github/workflows/   CI workflow
|-- CHANGELOG.md
|-- README.md
|-- README.en.md
|-- .actlume/config.example.json
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
- [x] 权限和安全系统
  - [x] 增加命令风险识别。
  - [x] 默认限制写入当前 workspace。
  - [x] 支持工具权限配置和命令 allowlist / denylist。
- [x] 配置系统
  - [x] 支持项目级 `.actlume/config.json`。
  - [x] 支持用户级 `~/.actlume/config.json`。
  - [x] 明确 CLI 参数、项目配置、用户配置、环境变量和默认值的优先级。
- [x] MCP 与联网能力
  - [x] 完善 MCP 状态、工具展示、超时和错误诊断。
  - [x] 提供 web search MCP 示例配置。
  - [x] 对实时信息问题要求先调用搜索工具。
- [x] 交互式 CLI 体验
  - [x] 命令历史和多行输入。
  - [x] 彩色输出、Markdown 渲染和 diff 高亮。
  - [x] `/init`、`/doctor`、`/compact`、`/clear` 等辅助命令。
- [x] 模型适配和错误诊断
  - [x] 标准化不同 OpenAI-compatible 服务的异常提示。
  - [x] 增加模型能力声明和 JSON 修复重试策略。
- [x] 测试、CI 和发布
  - [x] 增加单元测试与 CLI 集成测试。
  - [x] 增加 MCP mock server 测试。
  - [x] 配置 GitHub Actions。
  - [x] 准备 npm 发布脚本和 changelog。

## 开发验证

```bash
npm run typecheck
npm run test
npm run benchmark
npm run ci
npm run release:dry
```

当前 benchmark 覆盖文件读取、搜索、项目扫描、编辑计划、CLI 体验辅助函数、只读保护、patch、shell、安全策略、配置优先级、MCP 状态、实时信息 guard、任务追踪和非法工具输入。`npm test` 覆盖模型诊断、JSON 修复、CLI 集成和 MCP mock server。

## 安全说明

- 建议先在 Git 仓库或测试目录中使用。
- 不加 `--yes` 时，写入和执行类工具会请求确认。
- `--readonly` 会阻止写入和执行类工具。
- `.env`、`.agent-mcp.json`、`.agent-security.json`、`.actlume/config.json` 和 `.agent-memory/` 不应提交到仓库。

## 当前限制

actlume 是学习型原型项目，以下限制在使用和评估时应了解：

**模型适配**
- 仅正式测试过 DeepSeek (deepseek-v4-pro)，OpenAI 和 Ollama 兼容接口理论上可用但未充分验证。
- Agent 行为高度依赖模型能力。换模型后，步数、编辑成功率、护栏拦截次数可能有显著差异。

**代码修改能力**
- 评估覆盖场景有限：4 个项目均为 "fix bug + add test + run check" 模式，缺少大规模重构、多文件联动、前端 UI 修改等场景。
- 目前只在 Python 和 JavaScript 上完成过验证，其他语言未经测试。
- 默认 `maxSteps=10` 对代码任务通常不足，需手动 `--max-steps` 调高。

**MCP 与联网**
- MCP 客户端已实现，但目前仅验证过 filesystem 和 DuckDuckGo web search 两种 server。README 中提及的数据库、浏览器、GitHub 等 MCP server 未经实测。
- 免费 web search（DuckDuckGo）对中文新闻索引时效性有限，搜索结果可能滞后。

**Windows 兼容**
- Shell 在 Windows 上通过 cmd.exe 执行，部分 Unix 命令（`tail`、`grep` 等）不可用。
- 部分 Python 测试工具（`pytest-cov`、`pytest-forked`）在 Windows 下有兼容问题。

**已知架构限制**
- 不提供流式输出（streaming），响应为完整批次。
- 每次 `run` 独立执行，不支持从上次中断处恢复。
- 非代码任务缺少探索预算控制，可能在搜索类任务中消耗过多步数。
- 无 RAG / 向量检索能力，代码检索依赖 `searchText`（正则匹配）+ `readFile`（行号读取）。
- Agent 不会主动安装缺失的依赖包，需手动提前配置好环境。

**基准与测试**
- Benchmark 为 16 个内部单元级测试，不代表真实场景表现。评估结果来自 4 个外部项目约 5 轮 runs。
- 无并发、安全渗透、大规模代码库压力测试。
