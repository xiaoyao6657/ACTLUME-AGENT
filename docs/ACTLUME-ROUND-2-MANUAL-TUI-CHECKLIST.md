# 第二轮人工 TUI 验收记录

本表用于完成 R6-09/G6 的人工终端验收。当前自动 PTY 报告只证明程序收到按键、处理尺寸变化、退出并恢复终端模式；它们不能证明真人输入法、屏幕布局、焦点提示或可读性。

## 当前候选

- 候选 manifest：`sha256:49dd8d0d7958685aafa453b9628b4c7d99b7ce8033eb66d877648ec988c095e3`
- Node：24.14.1；Pi：1.0.2
- 自动输入/尺寸/退出记录：`.agent-benchmark/demo/tui-pty-matrix-e34d0393-native/tui-pty-smoke.json`（生成于前一候选 `e34d0393…cc03`）
- 自动审批拒绝记录：`.agent-benchmark/demo/tui-approval-pty-e34d0393-native/tui-approval-smoke.json`（生成于前一候选 `e34d0393…cc03`）
- 自动化通过不预填下面任何人工结果。

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
- 两个自动 smoke 均不计作人工 IME/视觉验收或视频录屏。
