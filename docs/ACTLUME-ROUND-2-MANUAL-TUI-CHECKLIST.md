# 第二轮人工 TUI 验收记录

本表用于完成 R6-09/G6 的人工终端验收。当前自动 PTY 报告只证明程序收到按键、处理尺寸变化、退出并恢复终端模式；它们不能证明真人输入法、屏幕布局、焦点提示或可读性。

## 当前候选

- 被测代码提交：`fa4ba7d7b99818778616579e72992b6393d8fa5e`；测试 checkout 为 `fdb62942a971a79c806cde6052d1db26d9168e9d`，两者的 `src/` 完全相同，后者仅增加文档记录。
- Node：24.14.1；Pi：1.0.2
- Linux 自动输入/尺寸/退出记录：`.agent-benchmark/demo/tui-pty-matrix-fdb6294-native/tui-pty-smoke.json`；原始 transcript 同目录的 `tui-pty-smoke.typescript`，SHA-256 `782659eda558cf1f69cc4928ba9d39b5a8dc6ba6081994356bd3a634977f32ab`。
- Linux 自动审批拒绝记录：`.agent-benchmark/demo/tui-approval-pty-fdb6294-native/tui-approval-smoke.json`；原始 transcript 同目录的 `tui-approval-smoke.typescript`，SHA-256 `02d88c8f518eef56b26c9f3ad8b3c06b106f9abf05baacf2ebb3d3d073d212a9`。
- 两组报告的来源、完整哈希和人工验收边界汇总：`.agent-benchmark/demo/tui-matrix-fdb6294-summary.json`。
- 两份报告中的 `candidateSha256=e3b0…b855` 表示测试时 checkout 没有未提交的 production-input 变更（`changedProductionInputs=0`），不是完整源码提交的内容哈希；源码身份由上述 Git commit 和 `src/` 一致性检查说明。
- 自动化通过不预填下面任何人工结果。

## 真人验收启动步骤

此流程让真人直接操作实际 TUI，同时用 loopback mock 避免 API 费用、外网请求和用户级 MCP 配置干扰。mock 只监听 `127.0.0.1`，不连接上游、不启动 Actlume、不发送按键；默认审批命令只输出固定 marker。必须在 Windows 和 Linux 各自的终端中实际检查界面并填写下方矩阵。

先在第一个终端自检并启动 mock provider。Windows 原生终端在项目根目录运行：

```sh
python docs/support/tui-manual-provider.py --self-test
python docs/support/tui-manual-provider.py --port 8765
```

Linux 原生 checkout 同样运行 `python3 docs/support/tui-manual-provider.py --port 8765`。若在 WSL 使用本机的 ext4 测试 checkout，provider 脚本可从 Windows 工作树路径启动：`python3 /mnt/d/workspace/actlume-agent/docs/support/tui-manual-provider.py --port 8765`；TUI 本身应从包含已验收源码的 ext4 checkout 启动，避免在 `/mnt/d` 上运行 Node/esbuild。

第二条命令保持运行。在第二个终端同样进入项目根目录，设置隔离配置后启动 TUI。

PowerShell：

```powershell
$manualRoot = Join-Path $env:TEMP 'actlume-tui-manual'
New-Item -ItemType Directory -Force -Path $manualRoot | Out-Null
$env:ACTLUME_HOME = Join-Path $manualRoot 'home'
$env:AGENT_MEMORY_DIR = Join-Path $manualRoot 'memory'
$env:PI_CODING_AGENT_DIR = Join-Path $manualRoot 'pi'
$env:AGENT_MCP_CONFIG = Join-Path $manualRoot 'mcp-empty.json'
New-Item -ItemType Directory -Force -Path $env:ACTLUME_HOME,$env:AGENT_MEMORY_DIR,$env:PI_CODING_AGENT_DIR | Out-Null
[IO.File]::WriteAllText($env:AGENT_MCP_CONFIG, '{"servers":{}}', [Text.UTF8Encoding]::new($false))
$env:OPENAI_API_KEY = 'local-only'
$env:OPENAI_BASE_URL = 'http://127.0.0.1:8765/v1'
$env:OPENAI_MODEL = 'gpt-4.1-mini'
$env:PI_OFFLINE = '1'
$env:AGENT_PERMISSION_MODE = 'default'
npm run dev
```

Bash (在项目根目录运行；WSL 下先切到包含已验收源码的 ext4 checkout):

```bash
manual_root="$(mktemp -d)"
export ACTLUME_HOME="$manual_root/home"
export AGENT_MEMORY_DIR="$manual_root/memory"
export PI_CODING_AGENT_DIR="$manual_root/pi"
export AGENT_MCP_CONFIG="$manual_root/mcp-empty.json"
mkdir -p "$ACTLUME_HOME" "$AGENT_MEMORY_DIR" "$PI_CODING_AGENT_DIR"
printf '%s' '{"servers":{}}' > "$AGENT_MCP_CONFIG"
export OPENAI_API_KEY='local-only'
export OPENAI_BASE_URL='http://127.0.0.1:8765/v1'
export OPENAI_MODEL='gpt-4.1-mini'
export PI_OFFLINE=1
export AGENT_PERMISSION_MODE=default
npm run dev
```

在 TUI 中提交任意新 prompt，默认 provider 会提出固定的 `echo ACTLUME_MANUAL_APPROVAL_MARKER` shell 请求。拒绝时应看到拒绝结果且 marker 不出现；若选择批准，该命令也只会输出 marker。其他矩阵项按以下方式准备：

- 长工具输出：停止 provider，重启 `python docs/support/tui-manual-provider.py --port 8765 --scenario long-output`；新开 TUI turn 并批准请求，只运行 Node 打印 80 行 marker，不写文件。
- 运行中取消/排队输入：停止 provider，重启 `python docs/support/tui-manual-provider.py --port 8765 --delay-first-seconds 20`；提交 prompt 后在等待期间实际试用补充输入或 Ctrl+C，再检查 UI 状态与恢复结果。provider 只延迟首个本地响应。
- 录制短演示：使用默认 approval scenario，连续录下启动、中文/emoji 输入、审批拒绝、最终回复和 Ctrl+D 退出；录屏不可包含私人路径或其他窗口中的敏感信息。

每次切换 scenario 前先停止旧 provider。测试结束在两个终端分别 Ctrl+C / Ctrl+D 退出，并在对应列记录终端名称、版本、尺寸、结果及缺陷；运行 `--self-test` 通过只证明 mock 协议可用，不代表任何人工验收项通过。

## 运行环境记录

| 字段 | Windows | Linux |
| --- | --- | --- |
| 日期/操作者 | 待填写 | 待填写 |
| 系统版本 | 待填写 | 待填写 |
| 终端与版本 | Windows Terminal / PowerShell，待填写版本 | 终端模拟器 / shell，待填写版本 |
| 候选 manifest | 待填写 | 待填写 |
| 终端尺寸 | 80×24 与 120×40 | 80×24 与 120×40 |
| 模型/provider | 待填写；是否使用本地 mock | 待填写；是否使用本地 mock |
| 原始视频/文件 | 待填写 | 待填写 |

## 人工操作矩阵

每项填写 `pass`、`fail`、`not run`，并在失败时写明复现步骤。录屏应覆盖完整 TUI 窗口和输入过程，不包含 API key、私人路径或项目机密。

| 检查项 | Windows | Linux | 观察重点 |
| --- | --- | --- | --- |
| 80×24 启动与扩展显示 | not run | not run | Banner、Actlume 扩展、状态栏没有乱码或遮挡 |
| 中文 IME 组合输入 | not run | not run | 输入法候选窗跟随插入点；确认文本后光标位置正确 |
| Emoji/宽字符 | not run | not run | 光标列、边框和状态栏保持对齐 |
| 多行代码/文本粘贴 | not run | not run | 换行、空格、反引号和长行未被截断或误提交 |
| 长历史滚动 | not run | not run | 向上滚动阅读后能回到底部，输入焦点不丢失 |
| 80×24 ↔ 120×40 缩放 | not run | not run | 中途 resize 后重绘完整，无残影或错位 |
| 长工具输出展开/折叠 | not run | not run | 快捷键操作反馈清晰，滚动/焦点状态正确 |
| 审批弹窗焦点 | not run | not run | Yes/No 当前选项清楚；拒绝后副作用未执行；不误选默认 Yes |
| 运行中追加消息 | not run | not run | 补充意图不会覆盖或伪装成新 task |
| 运行中取消 | not run | not run | 状态显示 cancelling/unknown；退出后可正常恢复和检查 |
| Ctrl+D 退出与终端恢复 | not run | not run | shell 返回提示符；输入回显、光标和按键恢复正常 |
| 连续短演示录屏 | not run | not run | 启动 → 输入 → 工具/审批 → 取消或拒绝 → 退出，全程可读 |

## 结果与缺陷

- Windows 总体结果：not run
- Linux 总体结果：not run
- 失败项/复现步骤：待填写
- 视频位置：待填写
- 观察到的显示或焦点问题：待填写
- 验收人确认：待填写

## 相关自动证据

- [`tui-pty-smoke.py`](support/tui-pty-smoke.py)：原生 Linux PTY 尺寸、Unicode 多行输入、退出和 termios 恢复。
- [`tui-approval-pty-smoke.py`](support/tui-approval-pty-smoke.py)：本地确定性 provider、审批弹窗与键盘拒绝路径。
- [`tui-manual-provider.py`](support/tui-manual-provider.py)：loopback-only mock provider，为真人 TUI 检查提供安全审批、长输出和延迟场景；`--self-test` 不启动或控制 TUI。
- `.agent-benchmark/demo/tui-manual-provider-integration.json`：该 mock 与 Actlume/Pi headless JSON 路径的本地拒绝集成证据；`manualTuiInteraction=false`，不计入人工结果。
- 两个自动 smoke 均不计作人工 IME/视觉验收或视频录屏。
