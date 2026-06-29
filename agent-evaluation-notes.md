# ACTLUME-Agent Briefcase 评估复盘

本文记录最近几轮使用 ACTLUME-Agent 修复 Briefcase issue #2864 时暴露的问题、根因和已做修复。测试任务核心为：

- 必须先调用 `editPlan`。
- 修改 `src/briefcase/config.py::parse_config()`。
- 当 app `description` 超过 80 字符时输出 warning，提示迁移到 `long_description`。
- 在 `tests/commands/base/test_parse_config.py` 添加测试。
- 运行相关 pytest。
- 最终中文总结。

## 总体结论

Agent 已经从早期的 40+ 步失败、假完成、重复探索，逐步改善到 22 步左右可以完成任务。当前主要问题不再是“能否完成”，而是：

- 前期探索仍偶尔偏多。
- 测试失败后有时会为脆弱测试改生产实现。
- 对某些质量问题仍需要 final quality gate 拦回修复。

22 步完成且 diff 干净、pytest 通过时，已属于可接受范围；理想区间约为 16-20 步。

## 三项目评估进度

当前评估目录：

| 项目 | 路径 | 状态 | 结论 |
| --- | --- | --- | --- |
| Briefcase | `D:\workspace\agent-evals\briefcase` | 已完成第一项 | 可进入下一项目 |
| Scrapy | `D:\workspace\agent-evals\scrapy` | 待测 | 建议作为第二项继续 |
| sentry-python | `D:\workspace\agent-evals\sentry-python` | 待测 | 第三项 |

Briefcase 第一项结果：

- 最近稳定完成结果为 22 步左右。
- `status = completed`。
- 目标源码和测试文件均有合理 diff。
- latest edit 后相关 pytest 通过。
- 未再出现重复测试函数、import 拼接语法错误、重复 pytest 误拦截、final JSON 重试等严重问题。
- 剩余风险主要是：前期探索仍可能多 2-4 步；测试失败后偶尔会为脆弱断言修改生产文案。

是否继续第二项：

- **建议继续 Scrapy 测试。**
- Briefcase 已经覆盖并修复了代码修改 agent 的核心基础能力：计划、探索预算、编辑工具、pytest 验证、final 完成判定和质量门。
- 继续 Scrapy 可以验证这些能力是否只对 Briefcase 有效，还是能泛化到另一个真实 Python 项目。
- 暂不建议继续围绕 Briefcase 小幅调参，除非 Scrapy 暴露同类问题再次复现。

进入第二项前置条件：

```powershell
cd /d D:\workspace\agent-evals\scrapy
git status --short
Remove-Item .agent-memory -Recurse -Force -ErrorAction SilentlyContinue
```

如果 `git status --short` 显示已有源码改动，应先确认是否为上一轮残留；若是评估残留，先 `git restore -- <path>` 清理后再开始。

## 主要失败与浪费原因

### 1. 假完成

现象：
- final 声称已完成，但没有真实代码改动。
- workflow summary 显示 `Changed files: none` 或 `Checks: none run`。

根因：
- 早期完成判定只相信模型 final，没有强制检查真实 diff、expected files 和测试结果。

已修复：
- `assessFinalCompletion()` 检查：
  - 是否有真实 changed files。
  - plan 中 expected files 是否被覆盖。
  - 编辑后是否有通过的 check。
  - final answer 是否包含未完成信号。
- 对明确要求 pytest 的任务，要求 latest edit 之后有通过的 pytest。

### 2. 探索过多

现象：
- editPlan 后仍连续 `readFile/searchText`。
- 简单任务跑到 30-50 步，主要消耗在确认已知信息。

根因：
- 只有 `maxSteps`，缺少按阶段推进的预算。
- 早期护栏只拦截宽泛探索，不拦截连续的聚焦探索。

已修复：
- 增加 `WorkflowNavigator`，识别 `plan / inspect / edit / repair-or-verify / verify / final`。
- `maybeBlockByStageBudget()` 增加：
  - editPlan 后探索预算。
  - 连续探索拦截。
  - post-edit 探索拦截。
  - pre-edit window 关闭后强制进入真实编辑。
- prompt 中输出当前 workflow stage、推荐下一步和应避免动作。

仍需关注：
- 某些 run 仍会在前期多花 2-4 步做重复确认。

### 3. 脏工作区导致误判

现象：
- 已删除 `.agent-memory`，但后续 run 仍检测到重复测试函数。

根因：
- `.agent-memory` 只保存日志/记忆，不会还原源码。
- 只执行 `git restore src/briefcase/config.py`，没有还原 `tests/commands/base/test_parse_config.py`。

建议清理命令：

```powershell
cd /d D:\workspace\agent-evals\briefcase
git restore -- src/briefcase/config.py tests/commands/base/test_parse_config.py
Remove-Item .agent-memory -Recurse -Force -ErrorAction SilentlyContinue
git status --short
```

已修复：
- final quality gate 扫描 changed Python test files。
- 如果出现重复顶层 `def test_*`，即使 pytest 通过也不允许 completed，会拦回继续修。

### 4. 重复测试函数被 pytest 静默覆盖

现象：
- 测试文件出现两个同名 `test_long_description_warning`。
- pytest 只收集后一个，显示通过，但前一个测试实际被覆盖。

根因：
- Python 允许后定义覆盖前定义。
- 早期只看 pytest 通过，不扫描测试文件结构问题。

已修复：
- `findDuplicatePythonTestFunctions()` 检测重复测试函数。
- final assessment 发现重复测试函数时拦截 final。
- 拦截信息提示保留一个定义，删除较早重复定义。

### 5. 编辑工具使用问题

现象：
- 手写 patch 损坏。
- `replaceText` 大段精确匹配失败。
- `insertText` 在 import 后插入新 import 时生成 `create_filefrom unittest...`。

根因：
- 模型手写 diff 或长 exact snippet 容易受空格、换行、CRLF 影响。
- anchored insertion 没有自动处理 Python import 后换行。

已修复：
- 增加并优先使用：
  - `replaceLines`
  - `insertAtLine`
  - `appendToFile`
  - `readTail`
- `replaceText` 大段失败时提示改用 `readFile` + `replaceLines`。
- `insertText` 在 Python import 行后插入另一个 import 时自动补换行。

### 6. shell 绕过 workflow

现象：
- 模型用 shell/Python 脚本写文件。
- git diff 有变化，但 workflow changedFiles 没记录。

根因：
- shell 既能测试也能写文件，早期 workflow 无法可靠追踪 shell 写入。

已修复：
- 代码修改任务中阻止 shell 写 workspace 文件。
- 引导使用专用编辑工具。
- shell 文件读取也计入 exploration，避免绕过探索预算。

### 7. Windows 命令兼容性

现象：
- 模型使用 `tail`、PowerShell-only/cmd-incompatible 命令导致失败。

根因：
- prompt 对 Windows shell 说明不足。
- shell 工具未提前识别常见不兼容命令。

已修复：
- `src/tools/shell.ts` 增加 Windows 兼容性检查。
- prompt 明确当前 shell 是 Windows/cmd 语义，避免 Unix-only 命令。

### 8. Python 检查与 pytest 选择

现象：
- Python 语法错误被 pytest 或环境依赖噪声掩盖。
- `.venv` 中缺 pytest 时浪费步骤。

根因：
- 早期只依赖项目建议命令，没有低成本语法检查。
- 没有提示在 Windows 上尝试可用 Python 解释器。

已修复：
- Python 文件变更后优先可自动运行 `python -m py_compile ...`。
- prompt 提示若 `.venv` 缺 pytest，可尝试 `py -m pytest` 或其他已有解释器。

### 9. 解析和输出格式问题

现象：
- 模型输出 top-level tool args，而不是放入 `input`。
- 使用 `action` 字段代替 `tool`。
- JSON 中出现原始换行、标量后多余引号、final JSON 缺失结尾。
- action thought 中英混杂。

已修复：
- `parseAgentOutput()` 支持：
  - fenced JSON。
  - top-level tool args 自动归入 `input`。
  - `action` alias。
  - 字符串内原始换行修复。
  - 数字/布尔/null 后多余引号修复。
  - 未闭合 final answer 的轻量修复。
- action thought 若缺失或包含中文，归一为英文。
- prompt 要求过程 thought 用英文，final answer 用用户要求语言。

### 10. 重复验证与误拦截

现象：
- pytest 失败后，模型原样重跑同一命令。
- 后来护栏过强：即使已经修复，也误挡同一 pytest。

根因：
- 早期无法区分“失败后无修复重跑”和“失败后已修复再验证”。
- changedFiles 曾按 `path + tool` 去重，同一文件同一工具的第二次编辑没有更新时间线。

已修复：
- 同一失败 check 在无新编辑时会被 `REDUNDANT_FAILED_CHECK_BLOCKED` 拦截。
- 修复后允许重跑同一 check。
- `recordChangedFiles()` 不再按 `path + tool` 去重，每次成功编辑都记录时间戳。

### 11. 测试牵引生产实现

现象：
- 某次 run 中，初始实现已输出合理 warning。
- 测试额外断言输出包含字面量 `"WARNING"`。
- Agent 为了过测给生产文案加了 `"WARNING:"` 前缀。

根因：
- 模型看到测试失败后默认修改实现，而不是判断测试断言是否过度约束。

当前状态：
- 尚未专门修复。

后续方向：
- 测试失败后增加质量判断：优先区分“实现不符合需求”与“测试断言过脆”。
- 对 warning/logging 文案类测试，建议断言核心语义：app 名、长度、`long_description`，避免强制无关前缀。

## 当前已验证

最近一轮本项目验证：

```powershell
npm run typecheck
npx tsx --test src/agent-output.test.ts
npm test
npm run benchmark
```

结果：
- typecheck 通过。
- agent-output 单测通过。
- 全量测试通过。
- benchmark 通过。

## 后续优先级

1. 减少前期探索冗余  
   目标是在 Briefcase 类任务中稳定压到 16-20 步。

2. 增强测试失败后的判断  
   不要盲目为测试修改生产实现，尤其是文案、warning、logging 断言。

3. 保持 final quality gate  
   继续检查 expected files、passing checks、重复测试函数、未完成 final 文本。

4. 保持干净评估环境  
   每轮 eval 前同时 restore 源文件和测试文件，并删除 `.agent-memory`。

## 简短评估标准

一次 Briefcase run 可视为合格，需要同时满足：

- `status = completed`
- 目标源码和测试文件都有合理 diff
- 没有重复测试函数
- latest edit 后有通过的相关 pytest
- final answer 没有未完成/需要手动处理表述
- 步数约 16-22 为优秀/可接受，23-28 可接受但应复盘，超过 30 需要分析浪费点
