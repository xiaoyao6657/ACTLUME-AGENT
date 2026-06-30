import test from "node:test";
import assert from "node:assert/strict";
import {
  answerLooksIncomplete,
  assessFinalCompletion,
  classifyActionIntent,
  findDuplicatePythonTestFunctions,
  formatAllowedIntentsForPrompt,
  formatActionInputForPrompt,
  isCodingChangeTask,
  issueFixPromptHints,
  isShellEnvironmentSetupCommand,
  isShellFileEditCommand,
  isShellFileReadCommand,
  isShellVerificationCommand,
  maybeBlockByStageBudget,
  navigateWorkflow,
  parseAgentOutput,
  shouldRequireEditsBeforeFinal,
  workflowProfileForTask,
  workflowPolicyForNavigation
} from "./agent.js";

test("repairs mixed text plus JSON agent output", () => {
  const parsed = parseAgentOutput('Here is the action: {"type":"final","answer":"done"}');
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.type, "final");
    assert.equal(parsed.value.answer, "done");
  }
});

test("repairs action output with top-level tool arguments", () => {
  const parsed = parseAgentOutput(
    JSON.stringify({
      type: "action",
      thought: "Read a focused range.",
      tool: "readFile",
      path: "src/briefcase/config.py",
      offset: 1333,
      limit: 100
    })
  );

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.type, "action");
    assert.equal(parsed.value.tool, "readFile");
    assert.deepEqual(parsed.value.input, {
      path: "src/briefcase/config.py",
      offset: 1333,
      limit: 100
    });
  }
});

test("repairs action output that uses action as the tool name", () => {
  const parsed = parseAgentOutput(
    '{"type":"action","action":"readFile","path":"src/briefcase/config.py","offset":1400,"limit":80}'
  );

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.type, "action");
    assert.equal(parsed.value.tool, "readFile");
    assert.deepEqual(parsed.value.input, {
      path: "src/briefcase/config.py",
      offset: 1400,
      limit: 80
    });
  }
});

test("normalizes non-English action thoughts to English", () => {
  const parsed = parseAgentOutput(
    '{"type":"action","thought":"需要查看文件内容","tool":"readFile","input":{"path":"src/a.py","startLine":1,"lineCount":20}}'
  );

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.type, "action");
    assert.equal(parsed.value.thought, "Call readFile for the next workflow step.");
  }
});

test("repairs fenced action output without thought", () => {
  const parsed = parseAgentOutput(
    [
      "I'll inspect the file now.",
      "```json",
      "{",
      "  \"type\": \"action\",",
      "  \"tool\": \"readFile\",",
      "  \"input\": {\"path\": \"src/briefcase/config.py\", \"offset\": 1333, \"limit\": 70}",
      "}",
      "```"
    ].join("\n")
  );

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.type, "action");
    assert.equal(parsed.value.thought, "Call readFile for the next workflow step.");
    assert.equal(parsed.value.tool, "readFile");
  }
});

test("repairs final output with raw newlines inside answer string", () => {
  const parsed = parseAgentOutput('{"type":"final","answer":"完成修改：\n1. 已更新 config.py\n2. 已运行 pytest"}');
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.type, "final");
    assert.equal(parsed.value.answer.includes("已运行 pytest"), true);
  }
});

test("repairs unterminated final answer output", () => {
  const parsed = parseAgentOutput('{"type":"final","answer":"## 修复总结\n\n已完成修改并运行 pytest');
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.type, "final");
    assert.equal(parsed.value.answer.includes("pytest"), true);
  }
});

test("repairs top-level numeric action arguments with a stray trailing quote", () => {
  const parsed = parseAgentOutput(
    '{"type":"action","thought":"Read a small range.","tool":"readFile","path":"src/briefcase/config.py","offset":1,"limit":10"}'
  );

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.type, "action");
    assert.deepEqual(parsed.value.input, {
      path: "src/briefcase/config.py",
      offset: 1,
      limit: 10
    });
  }
});

test("rejects invalid agent output", () => {
  const parsed = parseAgentOutput("not json");
  assert.equal(parsed.ok, false);
});

test("detects Chinese and English coding change tasks", () => {
  assert.equal(isCodingChangeTask("\u4fee\u590d Briefcase issue #2864 \u5e76\u8fd0\u884c\u6d4b\u8bd5"), true);
  assert.equal(isCodingChangeTask("\u5b8c\u5584 MCP \u4e0e\u8054\u7f51\u80fd\u529b"), true);
  assert.equal(isCodingChangeTask("fix a bug"), true);
  assert.equal(isCodingChangeTask("\u5206\u6790\u5f53\u524d\u9879\u76ee\u7ed3\u6784"), false);
});

test("requires edits before final for coding change tasks", () => {
  assert.equal(
    shouldRequireEditsBeforeFinal("\u4fee\u590d Briefcase issue #2864 \u5e76\u8fd0\u884c\u6d4b\u8bd5", { changedFiles: [] }),
    true
  );
  assert.equal(
    shouldRequireEditsBeforeFinal("\u4fee\u590d Briefcase issue #2864 \u5e76\u8fd0\u884c\u6d4b\u8bd5", {
      plan: {
        summary: "Fix issue",
        expectedFiles: ["src/a.py"],
        steps: ["Patch code"],
        createdAt: "now"
      },
      changedFiles: []
    }),
    true
  );
  assert.equal(shouldRequireEditsBeforeFinal("\u5206\u6790\u5f53\u524d\u9879\u76ee\u7ed3\u6784", { changedFiles: [] }), false);
  assert.equal(
    shouldRequireEditsBeforeFinal("fix a bug", { changedFiles: [{ path: "src/a.ts", tool: "applyPatch", timestamp: "now" }] }),
    false
  );
});

test("compresses long shell action input for prompts", () => {
  const longCommand = `python -c "${"x".repeat(1500)}"`;
  const formatted = formatActionInputForPrompt({
    type: "action",
    thought: "run script",
    tool: "shell",
    input: { command: longCommand, timeoutMs: 10000 }
  });

  assert.equal(formatted.includes("[command compressed:"), true);
  assert.equal(formatted.length < longCommand.length, true);
});

test("detects shell commands that write files", () => {
  assert.equal(isShellFileEditCommand("python -c \"open('src/a.py', 'w').write('x')\""), true);
  assert.equal(isShellFileEditCommand("Set-Content src/a.py value"), true);
  assert.equal(isShellFileEditCommand("python -m pytest tests/test_a.py -v 2>&1"), false);
});

test("detects shell commands that read files", () => {
  assert.equal(isShellFileReadCommand("Get-Content src/a.py"), true);
  assert.equal(isShellFileReadCommand("python -c \"with open('src/a.py') as f: lines = f.readlines()\""), true);
  assert.equal(isShellFileReadCommand("node -e \"fs.readFileSync('src/a.ts', 'utf8')\""), true);
  assert.equal(isShellFileReadCommand("git status --short"), true);
  assert.equal(isShellFileReadCommand("git grep -n needle -- src tests"), true);
  assert.equal(isShellFileReadCommand("python -m pytest tests/test_a.py -v"), false);
  assert.equal(isShellFileReadCommand("python -c \"open('src/a.py', 'w').write('x')\""), false);
});

test("detects shell environment setup commands", () => {
  assert.equal(isShellEnvironmentSetupCommand("python -m pip install pytest"), true);
  assert.equal(isShellEnvironmentSetupCommand(".venv\\Scripts\\python.exe -m pip install pytest"), true);
  assert.equal(isShellEnvironmentSetupCommand("uv pip install -e ."), true);
  assert.equal(isShellEnvironmentSetupCommand("uv sync"), true);
  assert.equal(isShellEnvironmentSetupCommand("python -m pytest tests/test_a.py"), false);
});

test("detects shell verification commands separately from file reads", () => {
  assert.equal(isShellVerificationCommand("python -m pytest tests/test_a.py -v"), true);
  assert.equal(isShellVerificationCommand(".venv\\Scripts\\python.exe -m pytest tests/test_a.py -v"), true);
  assert.equal(
    isShellVerificationCommand(
      ".venv\\Scripts\\python.exe -m twisted.trial tests.test_crawl.CrawlTestCase.test_start_requests_lazyness"
    ),
    true
  );
  assert.equal(
    isShellVerificationCommand(
      "python -c \"import ast; ast.parse(open('tests/test_a.py', encoding='utf-8').read())\""
    ),
    true
  );
  assert.equal(isShellVerificationCommand("npm run typecheck"), true);
  assert.equal(isShellVerificationCommand("Get-Content src/a.py"), false);
});

test("classifies action intent across direct tools and shell commands", () => {
  assert.equal(
    classifyActionIntent({
      type: "action",
      thought: "Search",
      tool: "shell",
      input: { command: "git status --short" }
    }),
    "inspect"
  );
  assert.equal(
    classifyActionIntent({
      type: "action",
      thought: "Search",
      tool: "shell",
      input: { command: 'findstr /N "needle" src\\a.py' }
    }),
    "inspect"
  );
  assert.equal(
    classifyActionIntent({
      type: "action",
      thought: "Check",
      tool: "shell",
      input: { command: "python -m pip install pytest" }
    }),
    "setup"
  );
  assert.equal(
    classifyActionIntent({
      type: "action",
      thought: "Check",
      tool: "shell",
      input: { command: ".venv\\Scripts\\python.exe -m twisted.trial tests.test_a.Test.test_x" }
    }),
    "verify"
  );
  assert.equal(
    classifyActionIntent({
      type: "action",
      thought: "Check",
      tool: "shell",
      input: { command: "python -m pytest tests/test_a.py -v" }
    }),
    "verify"
  );
  assert.equal(
    classifyActionIntent({
      type: "action",
      thought: "Edit",
      tool: "replaceLines",
      input: { path: "src/a.py", startLine: 1, lineCount: 1, content: "x\n" }
    }),
    "edit"
  );
});

test("workflow policy exposes allowed intents by stage", () => {
  assert.deepEqual(
    workflowPolicyForNavigation({ stage: "edit", reasons: [] }).allowedIntents,
    ["edit", "verify", "setup"]
  );
  assert.deepEqual(
    workflowPolicyForNavigation({ stage: "verify", reasons: [] }).allowedIntents,
    ["edit", "verify", "setup"]
  );
  assert.deepEqual(
    workflowPolicyForNavigation({ stage: "final", reasons: [] }).allowedIntents,
    []
  );
  assert.equal(formatAllowedIntentsForPrompt(["edit", "verify"]), "edit=replaceLines/insertAtLine/replaceText/insertText/applyPatch; verify=pytest/typecheck/py_compile/test command");
  assert.equal(formatAllowedIntentsForPrompt([]), "none; output final instead of calling tools");
});

test("issue-fix workflow profile uses tighter budgets", () => {
  assert.deepEqual(workflowProfileForTask("fix Scrapy issue #5703", 45), {
    kind: "issue-fix",
    explorationBudget: 5,
    postEditExplorationBudget: 2,
    targetMissLimit: 2
  });
  assert.deepEqual(workflowProfileForTask("fix Scrapy issue #5703 after editPlan", 45), {
    kind: "issue-fix",
    explorationBudget: 7,
    postEditExplorationBudget: 2,
    targetMissLimit: 2
  });
  assert.equal(workflowProfileForTask("fix a bug", 45).kind, "generic");
});

test("issue-fix prompt hints include target symbols and pytest candidates", () => {
  assert.deepEqual(
    issueFixPromptHints(
      "fix Scrapy issue #5703 in tests/test_crawl.py CrawlTestCase.test_start_requests_lazyness"
    ),
    [
      "Exact target symbols: CrawlTestCase.test_start_requests_lazyness, test_start_requests_lazyness, CrawlTestCase",
      "Targeted pytest candidate: python -m pytest tests/test_crawl.py::CrawlTestCase::test_start_requests_lazyness -q"
    ]
  );
  assert.deepEqual(issueFixPromptHints("fix Scrapy issue #5703 CrawlTestCase.test_start_requests_lazyness"), [
    "Exact target symbols: CrawlTestCase.test_start_requests_lazyness, test_start_requests_lazyness, CrawlTestCase",
    'Targeted pytest candidate: python -m pytest -k "CrawlTestCase and test_start_requests_lazyness" -q'
  ]);
  assert.deepEqual(issueFixPromptHints("fix a bug"), []);
});

test("detects incomplete final answers", () => {
  assert.equal(answerLooksIncomplete("还有待完成任务，需要手动删除重复代码。"), true);
  assert.equal(answerLooksIncomplete("未能完成：pytest 无法运行。"), true);
  assert.equal(answerLooksIncomplete("由于环境限制未执行 pytest，验证建议如下。"), true);
  assert.equal(answerLooksIncomplete("修复后测试预期通过。"), true);
  assert.equal(answerLooksIncomplete("Done, tests passed."), false);
});

test("assesses final completion from real edits and checks", () => {
  const incomplete = assessFinalCompletion("fix a bug", "部分修改，还需要手动处理", {
    plan: {
      summary: "Fix bug",
      expectedFiles: ["src/a.ts", "src/a.test.ts"],
      steps: ["edit", "test"],
      createdAt: "now"
    },
    changedFiles: [{ path: "src/a.ts", tool: "replaceLines", timestamp: "now" }],
    checks: []
  });
  assert.equal(incomplete.ok, false);
  if (!incomplete.ok) {
    assert.equal(incomplete.reasons.some((reason) => reason.includes("No verification checks")), true);
    assert.equal(incomplete.reasons.some((reason) => reason.includes("final answer")), true);
  }

  const failedCheck = assessFinalCompletion("fix a bug", "Done.", {
    plan: {
      summary: "Fix bug",
      expectedFiles: ["src/a.ts"],
      steps: ["edit", "test"],
      createdAt: "2026-01-01T00:00:00.000Z"
    },
    changedFiles: [{ path: "src/a.ts", tool: "replaceLines", timestamp: "2026-01-01T00:00:00.000Z" }],
    checks: [{ command: "npm test", ok: false, timestamp: "2026-01-01T00:00:01.000Z" }]
  });
  assert.equal(failedCheck.ok, false);
  if (!failedCheck.ok) {
    assert.equal(failedCheck.reasons.some((reason) => reason.includes("No verification checks passed")), true);
  }

  const complete = assessFinalCompletion("fix a bug", "Done.", {
    plan: {
      summary: "Fix bug",
      expectedFiles: ["src/a.ts"],
      steps: ["edit", "test"],
      createdAt: "now"
    },
    changedFiles: [{ path: "src/a.ts", tool: "replaceLines", timestamp: "2026-01-01T00:00:00.000Z" }],
    checks: [{ command: "npm test", ok: true, timestamp: "2026-01-01T00:00:01.000Z" }]
  });
  assert.equal(complete.ok, true);

  const completeWithBroadPlan = assessFinalCompletion("fix a bug", "Done.", {
    plan: {
      summary: "Fix bug",
      expectedFiles: ["src/a.ts", "src/a.test.ts", "src/possible-helper.ts"],
      steps: ["edit", "test"],
      createdAt: "now"
    },
    changedFiles: [{ path: "src/a.ts", tool: "replaceLines", timestamp: "2026-01-01T00:00:00.000Z" }],
    checks: [{ command: "npm test", ok: true, timestamp: "2026-01-01T00:00:01.000Z" }]
  });
  assert.equal(completeWithBroadPlan.ok, true);
});

test("requires a passing pytest check when pytest is explicitly requested", () => {
  const result = assessFinalCompletion("修复 bug，最后运行相关 pytest", "Done.", {
    plan: {
      summary: "Fix bug",
      expectedFiles: ["src/a.py", "tests/test_a.py"],
      steps: ["edit", "pytest"],
      createdAt: "now"
    },
    changedFiles: [
      { path: "src/a.py", tool: "insertText", timestamp: "2026-01-01T00:00:02.000Z" },
      { path: "tests/test_a.py", tool: "replaceLines", timestamp: "2026-01-01T00:00:03.000Z" }
    ],
    checks: [
      {
        command: "python -m pytest tests/test_a.py -x",
        ok: false,
        timestamp: "2026-01-01T00:00:01.000Z"
      },
      {
        command: "python -m py_compile src/a.py tests/test_a.py",
        ok: true,
        timestamp: "2026-01-01T00:00:04.000Z"
      }
    ]
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reasons.some((reason) => reason.includes("No pytest check passed")), true);
  }
});

test("does not count environment setup as a passing pytest verification", () => {
  const result = assessFinalCompletion("fix a bug and run pytest", "Done.", {
    plan: {
      summary: "Fix bug",
      expectedFiles: ["src/a.py"],
      steps: ["edit", "pytest"],
      createdAt: "now"
    },
    changedFiles: [{ path: "src/a.py", tool: "insertText", timestamp: "2026-01-01T00:00:02.000Z" }],
    checks: [
      {
        command: "python -m pip install pytest -q",
        ok: true,
        timestamp: "2026-01-01T00:00:03.000Z"
      }
    ]
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reasons.some((reason) => reason.includes("No verification checks passed")), true);
    assert.equal(result.reasons.some((reason) => reason.includes("No pytest check passed")), true);
  }
});

test("counts expected files already changed in the workspace", () => {
  const result = assessFinalCompletion(
    "修复 bug，最后运行相关 pytest",
    "Done.",
    {
      plan: {
        summary: "Fix bug",
        expectedFiles: ["src/a.py", "tests/test_a.py"],
        steps: ["edit", "pytest"],
        createdAt: "now"
      },
      changedFiles: [{ path: "src/a.py", tool: "insertText", timestamp: "2026-01-01T00:00:02.000Z" }],
      checks: [
        {
          command: "python -m pytest tests/test_a.py -x",
          ok: true,
          timestamp: "2026-01-01T00:00:03.000Z"
        }
      ]
    },
    { workspaceChangedFiles: ["tests/test_a.py"] }
  );

  assert.equal(result.ok, true);
});

test("detects duplicate Python test function definitions", () => {
  const duplicates = findDuplicatePythonTestFunctions(
    "tests/test_example.py",
    [
      "def test_ok():",
      "    pass",
      "",
      "def helper():",
      "    pass",
      "",
      "def test_ok():",
      "    pass"
    ].join("\n")
  );

  assert.deepEqual(duplicates, [{ path: "tests/test_example.py", name: "test_ok", lines: [1, 7] }]);
});

test("rejects final completion when changed Python tests contain duplicate test functions", () => {
  const result = assessFinalCompletion(
    "修复 bug，最后运行相关 pytest",
    "Done.",
    {
      plan: {
        summary: "Fix bug",
        expectedFiles: ["src/a.py", "tests/test_a.py"],
        steps: ["edit", "pytest"],
        createdAt: "now"
      },
      changedFiles: [
        { path: "src/a.py", tool: "insertText", timestamp: "2026-01-01T00:00:01.000Z" },
        { path: "tests/test_a.py", tool: "replaceText", timestamp: "2026-01-01T00:00:02.000Z" }
      ],
      checks: [{ command: "python -m pytest tests/test_a.py", ok: true, timestamp: "2026-01-01T00:00:03.000Z" }]
    },
    {
      duplicateTestFunctions: [{ path: "tests/test_a.py", name: "test_duplicate", lines: [10, 20] }]
    }
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reasons.some((reason) => reason.includes("Duplicate Python test function definitions")), true);
  }
});

test("blocks repeated exploration after an edit plan", () => {
  const history = Array.from({ length: 6 }, (_, index) => ({
    thought: `read ${index}`,
    action: {
      type: "action" as const,
      thought: "read",
      tool: index % 2 === 0 ? "readFile" : "searchText",
      input: { path: "src/a.ts", pattern: "foo" }
    },
    observation: "ok"
  }));

  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "read again",
      tool: "readFile",
      input: { path: "src/a.ts", startLine: 1, lineCount: 20 }
    },
    "fix a bug",
    20,
    50,
    {
      runId: "run",
      plan: {
        summary: "Fix bug",
        expectedFiles: ["src/a.ts"],
        steps: ["edit"],
        createdAt: "now"
      },
      changedFiles: [],
      checks: []
    },
    history
  );

  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.errorCode, "REPEATED_EXPLORATION_BLOCKED");
  }
});

test("blocks repeated shell file-read exploration after an edit plan", () => {
  const history = Array.from({ length: 6 }, (_, index) => ({
    thought: `shell read ${index}`,
    action: {
      type: "action" as const,
      thought: "read",
      tool: "shell",
      input: { command: "python -c \"with open('src/a.py') as f: lines = f.readlines()\"" }
    },
    observation: "ok"
  }));

  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "read again through shell",
      tool: "shell",
      input: { command: "Get-Content src/a.py" }
    },
    "fix a bug",
    20,
    50,
    {
      runId: "run",
      plan: {
        summary: "Fix bug",
        expectedFiles: ["src/a.ts"],
        steps: ["edit"],
        createdAt: "now"
      },
      changedFiles: [],
      checks: []
    },
    history
  );

  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.errorCode, "REPEATED_EXPLORATION_BLOCKED");
  }
});

test("allows one targeted warning convention lookup after pre-edit exploration budget", () => {
  const history = Array.from({ length: 6 }, (_, index) => ({
    thought: `inspect ${index}`,
    action: {
      type: "action" as const,
      thought: "inspect",
      tool: "readFile",
      input: { path: "src/briefcase/config.py", startLine: 1300 + index * 10, lineCount: 20 }
    },
    observation: "ok"
  }));

  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "Find existing warning style.",
      tool: "searchText",
      input: { pattern: "warn", root: "src/briefcase/config.py", maxResults: 20 }
    },
    "请先调用 editPlan，然后修复 Briefcase issue #2864，输出 warning",
    8,
    50,
    {
      runId: "run",
      plan: {
        summary: "Fix warning",
        expectedFiles: ["src/briefcase/config.py", "tests/commands/base/test_parse_config.py"],
        steps: ["edit", "test"],
        createdAt: "now"
      },
      changedFiles: [],
      checks: []
    },
    history
  );

  assert.equal(result, undefined);
});

test("requires editPlan first when the task explicitly asks for it", () => {
  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "inspect first",
      tool: "readFile",
      input: { path: "src/a.ts", startLine: 1, lineCount: 20 }
    },
    "请先调用 editPlan，然后修复 bug",
    1,
    50,
    {
      runId: "run",
      changedFiles: [],
      checks: []
    },
    []
  );

  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.errorCode, "EDIT_PLAN_REQUIRED_FIRST");
  }
});

test("blocks inserting normal Python imports at line one", () => {
  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "Add warnings import.",
      tool: "insertAtLine",
      input: { path: "src/briefcase/config.py", line: 1, content: "import warnings\n" }
    },
    "fix a Python warning behavior",
    12,
    50,
    {
      runId: "run",
      plan: {
        summary: "Fix warning behavior",
        expectedFiles: ["src/briefcase/config.py"],
        steps: ["edit", "test"],
        createdAt: "now"
      },
      changedFiles: [],
      checks: []
    },
    []
  );

  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.errorCode, "PYTHON_TOP_IMPORT_BLOCKED");
  }
});

test("workflow navigation requires editPlan first when requested", () => {
  const navigation = navigateWorkflow(
    "请先调用 editPlan，然后修复 Briefcase issue #2864",
    {
      changedFiles: [],
      checks: []
    },
    [],
    1,
    50
  );

  assert.equal(navigation.stage, "plan");
  assert.equal(navigation.recommendedAction.includes("editPlan"), true);
  assert.equal(navigation.blockedActions.includes("readFile"), true);
});

test("blocks repeated editPlan calls once a plan exists", () => {
  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "replan",
      tool: "editPlan",
      input: { summary: "New plan" }
    },
    "fix a bug",
    20,
    50,
    {
      runId: "run",
      plan: {
        summary: "Fix bug",
        expectedFiles: ["src/a.ts"],
        steps: ["edit"],
        createdAt: "now"
      },
      changedFiles: [{ path: "src/a.ts", tool: "insertText", timestamp: "now" }],
      checks: []
    },
    []
  );

  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.errorCode, "EDIT_PLAN_ALREADY_EXISTS");
  }
});

test("workflow navigation moves from inspection to edit when pre-edit budget is spent", () => {
  const history = Array.from({ length: 6 }, (_, index) => ({
    thought: `inspect ${index}`,
    action: {
      type: "action" as const,
      thought: "inspect",
      tool: "readFile",
      input: { path: "src/briefcase/config.py", startLine: 1300 + index * 10, lineCount: 20 }
    },
    observation: "ok"
  }));

  const navigation = navigateWorkflow(
    "请先调用 editPlan，然后修复 Briefcase issue #2864",
    {
      plan: {
        summary: "Fix issue",
        expectedFiles: ["src/briefcase/config.py"],
        steps: ["edit", "test"],
        createdAt: "now"
      },
      changedFiles: [],
      checks: []
    },
    history,
    12,
    50
  );

  assert.equal(navigation.stage, "edit");
  assert.equal(navigation.recommendedAction.includes("first real planned edit"), true);
});

test("limits post-plan exploration tightly when editPlan was explicitly requested", () => {
  const history = Array.from({ length: 6 }, (_, index) => ({
    thought: `inspect ${index}`,
    action: {
      type: "action" as const,
      thought: "inspect",
      tool: "readFile",
      input: { path: "src/briefcase/config.py", startLine: 1333 + index * 20, lineCount: 40 }
    },
    observation: "ok"
  }));

  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "read one more range",
      tool: "readFile",
      input: { path: "src/briefcase/config.py", startLine: 1435, lineCount: 40 }
    },
    "请先调用 editPlan，然后修复 Briefcase issue #2864",
    10,
    50,
    {
      runId: "run",
      plan: {
        summary: "Fix issue",
        expectedFiles: ["src/briefcase/config.py", "tests/commands/base/test_parse_config.py"],
        steps: ["edit", "test"],
        createdAt: "now"
      },
      changedFiles: [],
      checks: []
    },
    history
  );

  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.errorCode, "PRE_EDIT_EXPLORATION_WINDOW_CLOSED");
  }
});

test("blocks focused exploration after the pre-edit window closes", () => {
  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "read another focused range",
      tool: "readFile",
      input: { path: "src/briefcase/config.py", startLine: 1400, lineCount: 40 }
    },
    "请先调用 editPlan，然后修复 Briefcase issue #2864",
    10,
    50,
    {
      runId: "run",
      plan: {
        summary: "Fix issue",
        expectedFiles: ["src/briefcase/config.py", "tests/commands/base/test_parse_config.py"],
        steps: ["edit", "test"],
        createdAt: "now"
      },
      changedFiles: [],
      checks: []
    },
    []
  );

  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.errorCode, "PRE_EDIT_EXPLORATION_WINDOW_CLOSED");
  }
});

test("workflow navigation pushes edited tasks to verification", () => {
  const history = Array.from({ length: 4 }, (_, index) => ({
    thought: `inspect after edit ${index}`,
    action: {
      type: "action" as const,
      thought: "inspect",
      tool: "searchText",
      input: { path: "src/a.py", pattern: "warning" }
    },
    observation: "ok"
  }));

  const navigation = navigateWorkflow(
    "fix a bug and run pytest",
    {
      plan: {
        summary: "Fix bug",
        expectedFiles: ["src/a.py"],
        steps: ["edit", "pytest"],
        createdAt: "now"
      },
      changedFiles: [{ path: "src/a.py", tool: "insertText", timestamp: "2026-01-01T00:00:00.000Z" }],
      checks: []
    },
    history,
    20,
    50
  );

  assert.equal(navigation.stage, "verify");
  assert.equal(navigation.recommendedAction.includes("check"), true);
});

test("blocks repeated exploration after edits before verification", () => {
  const history = Array.from({ length: 4 }, (_, index) => ({
    thought: `inspect after edit ${index}`,
    action: {
      type: "action" as const,
      thought: "inspect",
      tool: "readFile",
      input: { path: "src/briefcase/config.py", startLine: 1400 + index * 10, lineCount: 20 }
    },
    observation: "ok"
  }));

  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "read again",
      tool: "readFile",
      input: { path: "src/briefcase/config.py", startLine: 1450, lineCount: 20 }
    },
    "fix a bug and run pytest",
    30,
    50,
    {
      runId: "run",
      plan: {
        summary: "Fix bug",
        expectedFiles: ["src/briefcase/config.py"],
        steps: ["edit", "test"],
        createdAt: "now"
      },
      changedFiles: [{ path: "src/briefcase/config.py", tool: "insertText", timestamp: "now" }],
      checks: []
    },
    history
  );

  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.errorCode, "POST_EDIT_EXPLORATION_BLOCKED");
  }
});

test("blocks rerunning the same failed verification without a repair edit", () => {
  const command = "python -m pytest tests/test_a.py -v";
  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "Run pytest again.",
      tool: "shell",
      input: { command }
    },
    "fix a bug and run pytest",
    22,
    50,
    {
      runId: "run",
      plan: {
        summary: "Fix bug",
        expectedFiles: ["src/a.py", "tests/test_a.py"],
        steps: ["edit", "pytest"],
        createdAt: "2026-01-01T00:00:00.000Z"
      },
      changedFiles: [{ path: "tests/test_a.py", tool: "replaceText", timestamp: "2026-01-01T00:00:01.000Z" }],
      checks: [{ command, ok: false, errorCode: "SHELL_EXIT_NONZERO", timestamp: "2026-01-01T00:00:02.000Z" }]
    },
    []
  );

  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.errorCode, "REDUNDANT_FAILED_CHECK_BLOCKED");
  }
});

test("allows rerunning the same failed verification after a repair edit", () => {
  const command = "python -m pytest tests/test_a.py -v";
  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "Run pytest after repair.",
      tool: "shell",
      input: { command }
    },
    "fix a bug and run pytest",
    23,
    50,
    {
      runId: "run",
      plan: {
        summary: "Fix bug",
        expectedFiles: ["src/a.py", "tests/test_a.py"],
        steps: ["edit", "pytest"],
        createdAt: "2026-01-01T00:00:00.000Z"
      },
      changedFiles: [
        { path: "tests/test_a.py", tool: "replaceText", timestamp: "2026-01-01T00:00:01.000Z" },
        { path: "src/a.py", tool: "replaceText", timestamp: "2026-01-01T00:00:03.000Z" }
      ],
      checks: [{ command, ok: false, errorCode: "SHELL_EXIT_NONZERO", timestamp: "2026-01-01T00:00:02.000Z" }]
    },
    []
  );

  assert.equal(result, undefined);
});

test("workflow navigation finishes after a passing check following edits", () => {
  const navigation = navigateWorkflow(
    "fix a bug",
    {
      plan: {
        summary: "Fix bug",
        expectedFiles: ["src/a.ts"],
        steps: ["edit", "test"],
        createdAt: "now"
      },
      changedFiles: [{ path: "src/a.ts", tool: "replaceLines", timestamp: "2026-01-01T00:00:00.000Z" }],
      checks: [{ command: "npm test", ok: true, timestamp: "2026-01-01T00:00:01.000Z" }]
    },
    [],
    10,
    50
  );

  assert.equal(navigation.stage, "final");
  assert.equal(navigation.recommendedAction.includes("final answer"), true);
});

test("blocks dummy edits used to bypass exploration limits", () => {
  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "unblock exploration",
      tool: "appendToFile",
      input: {
        path: "tests/commands/base/test_parse_config.py",
        content: "\n# Dummy comment to unblock exploration\n"
      }
    },
    "请先调用 editPlan，然后修复 Briefcase issue #2864",
    12,
    50,
    {
      runId: "run",
      plan: {
        summary: "Fix issue",
        expectedFiles: ["src/briefcase/config.py", "tests/commands/base/test_parse_config.py"],
        steps: ["edit", "test"],
        createdAt: "now"
      },
      changedFiles: [],
      checks: []
    },
    []
  );

  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.errorCode, "FAKE_PROGRESS_EDIT_BLOCKED");
  }
});

test("blocks weakening test assertions for issue-fix tasks", () => {
  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "Remove flaky assertion from helper spider.",
      tool: "replaceText",
      input: {
        path: "tests/spiders.py",
        search: "        assert self.seedsseen, 'All start requests consumed before any download happened'\n",
        replacement: "        # Laziness is verified elsewhere; no assert needed here.\n"
      }
    },
    "fix Scrapy issue #5703 CrawlTestCase.test_start_requests_lazyness",
    15,
    30,
    {
      runId: "run",
      plan: {
        summary: "Fix issue",
        expectedFiles: ["tests/spiders.py", "scrapy/core/engine.py"],
        steps: ["edit", "pytest"],
        createdAt: "now"
      },
      changedFiles: [],
      checks: []
    },
    []
  );

  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.errorCode, "TEST_ASSERTION_WEAKENING_BLOCKED");
  }
});

test("blocks no-op replaceText before real edits", () => {
  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "touch a file",
      tool: "replaceText",
      input: {
        path: "tests/commands/base/test_parse_config.py",
        search: "def test_empty_config",
        replacement: "def test_empty_config"
      }
    },
    "fix a bug",
    11,
    50,
    {
      runId: "run",
      plan: {
        summary: "Fix bug",
        expectedFiles: ["tests/commands/base/test_parse_config.py"],
        steps: ["edit"],
        createdAt: "now"
      },
      changedFiles: [],
      checks: []
    },
    []
  );

  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.errorCode, "FAKE_PROGRESS_EDIT_BLOCKED");
  }
});

test("blocks high line edits without recent line context", () => {
  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "Guess a high line number.",
      tool: "replaceLines",
      input: { path: "scrapy/core/engine.py", startLine: 420, lineCount: 1, content: "        broken\n" }
    },
    "fix Scrapy issue #5703",
    20,
    30,
    {
      runId: "run",
      plan: {
        summary: "Fix issue",
        expectedFiles: ["scrapy/core/engine.py"],
        steps: ["edit", "pytest"],
        createdAt: "now"
      },
      changedFiles: [],
      checks: []
    },
    []
  );

  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.errorCode, "UNVERIFIED_LINE_EDIT_BLOCKED");
  }
});

test("allows high line edits after reading the nearby range", () => {
  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "Edit observed high line.",
      tool: "replaceLines",
      input: { path: "scrapy/core/engine.py", startLine: 420, lineCount: 1, content: "        fixed\n" }
    },
    "fix Scrapy issue #5703",
    20,
    30,
    {
      runId: "run",
      plan: {
        summary: "Fix issue",
        expectedFiles: ["scrapy/core/engine.py"],
        steps: ["edit", "pytest"],
        createdAt: "now"
      },
      changedFiles: [],
      checks: []
    },
    [
      {
        thought: "Read nearby range.",
        action: {
          type: "action" as const,
          thought: "Read nearby range.",
          tool: "readFile",
          input: { path: "scrapy/core/engine.py", startLine: 418, lineCount: 8 }
        },
        observation: "418: ok\n419: ok\n420: target"
      }
    ]
  );

  assert.equal(result, undefined);
});

test("blocks repeated failed edits until file context is refreshed", () => {
  const history = [
    {
      thought: "Try an exact edit.",
      action: {
        type: "action" as const,
        thought: "Try an exact edit.",
        tool: "replaceText",
        input: { path: "scrapy/core/engine.py", search: "old one", replacement: "new one" }
      },
      observation: "[tool_error]\ncode: TEXT_NOT_FOUND\nmessage:\nSearch text was not found."
    },
    {
      thought: "Try another exact edit.",
      action: {
        type: "action" as const,
        thought: "Try another exact edit.",
        tool: "replaceText",
        input: { path: "scrapy/core/engine.py", search: "old two", replacement: "new two" }
      },
      observation: "[tool_error]\ncode: TEXT_NOT_FOUND\nmessage:\nSearch text was not found."
    }
  ];

  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "Guess a third exact edit.",
      tool: "replaceText",
      input: { path: "scrapy/core/engine.py", search: "old three", replacement: "new three" }
    },
    "fix Scrapy issue #5703",
    18,
    30,
    {
      runId: "run",
      plan: {
        summary: "Fix issue",
        expectedFiles: ["scrapy/core/engine.py"],
        steps: ["edit", "pytest"],
        createdAt: "now"
      },
      changedFiles: [],
      checks: []
    },
    history
  );

  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.errorCode, "EDIT_CONTEXT_REQUIRED");
  }
});

test("allows focused file context recovery after an edit anchor failure", () => {
  const history = [
    {
      thought: "Try exact edit.",
      action: {
        type: "action" as const,
        thought: "Try exact edit.",
        tool: "replaceText",
        input: { path: "scrapy/core/engine.py", search: "old", replacement: "new" }
      },
      observation: "[tool_error]\ncode: TEXT_NOT_FOUND\nmessage:\nSearch text was not found."
    }
  ];

  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "Read the target file range before editing again.",
      tool: "readFile",
      input: { path: "scrapy/core/engine.py", startLine: 400, lineCount: 80 }
    },
    "fix Scrapy issue #5703",
    18,
    30,
    {
      runId: "run",
      plan: {
        summary: "Fix issue",
        expectedFiles: ["scrapy/core/engine.py"],
        steps: ["edit", "pytest"],
        createdAt: "now"
      },
      changedFiles: [],
      checks: []
    },
    history
  );

  assert.equal(result, undefined);
});

// -- helpers for REPLACE_TEXT_REPEATED_FAILURE tests --

function makeFailedReplaceText(
  path: string,
  search: string,
  replacement: string
): {
  thought: string;
  action: { type: "action"; thought: string; tool: string; input: Record<string, unknown> };
  observation: string;
} {
  return {
    thought: `Try replaceText on ${path}.`,
    action: {
      type: "action" as const,
      thought: `Try replaceText on ${path}.`,
      tool: "replaceText",
      input: { path, search, replacement }
    },
    observation: "[tool_error]\ncode: TEXT_NOT_FOUND\nmessage:\nSearch text was not found."
  };
}

function makeReplaceTextAction(
  path: string,
  search: string,
  replacement: string
): {
  type: "action";
  thought: string;
  tool: string;
  input: Record<string, unknown>;
} {
  return {
    type: "action",
    thought: `Try another replaceText on ${path}.`,
    tool: "replaceText",
    input: { path, search, replacement }
  };
}

function makeWorkflowWithPlan(expectedFiles: string[]) {
  return {
    runId: "run",
    plan: {
      summary: "Fix issue",
      expectedFiles,
      steps: ["edit", "pytest"],
      createdAt: "now"
    },
    changedFiles: [] as { path: string; tool: string; timestamp: string }[],
    checks: [] as { command: string; ok: boolean; errorCode?: string; timestamp: string }[]
  };
}

test("blocks replaceText after three TEXT_NOT_FOUND failures on the same file", () => {
  const history = [
    makeFailedReplaceText("scrapy/core/engine.py", "old one", "new one"),
    makeFailedReplaceText("scrapy/core/engine.py", "old two", "new two"),
    {
      thought: "Read target range.",
      action: {
        type: "action" as const,
        thought: "Read target range.",
        tool: "readFile",
        input: { path: "scrapy/core/engine.py", startLine: 400, lineCount: 80 }
      },
      observation: "400: some code\n401: more code"
    },
    makeFailedReplaceText("scrapy/core/engine.py", "old three", "new three")
  ];

  const result = maybeBlockByStageBudget(
    makeReplaceTextAction("scrapy/core/engine.py", "old four", "new four"),
    "fix Scrapy issue #5703",
    22,
    30,
    makeWorkflowWithPlan(["scrapy/core/engine.py"]),
    history
  );

  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.errorCode, "REPLACE_TEXT_REPEATED_FAILURE");
  }
});

test("allows replaceText after only two TEXT_NOT_FOUND failures", () => {
  const history = [
    makeFailedReplaceText("scrapy/core/engine.py", "old one", "new one"),
    makeFailedReplaceText("scrapy/core/engine.py", "old two", "new two"),
    {
      thought: "Read target range.",
      action: {
        type: "action" as const,
        thought: "Read target range.",
        tool: "readFile",
        input: { path: "scrapy/core/engine.py", startLine: 400, lineCount: 80 }
      },
      observation: "400: some code\n401: more code"
    }
  ];

  const result = maybeBlockByStageBudget(
    makeReplaceTextAction("scrapy/core/engine.py", "old three", "new three"),
    "fix Scrapy issue #5703",
    22,
    30,
    makeWorkflowWithPlan(["scrapy/core/engine.py"]),
    history
  );

  assert.equal(result, undefined);
});

test("blocks replaceText after three TEXT_NOT_FOUND failures even with an intervening readFile", () => {
  const history = [
    makeFailedReplaceText("scrapy/core/engine.py", "old one", "new one"),
    makeFailedReplaceText("scrapy/core/engine.py", "old two", "new two"),
    {
      thought: "Read target range.",
      action: {
        type: "action" as const,
        thought: "Read target range.",
        tool: "readFile",
        input: { path: "scrapy/core/engine.py", startLine: 400, lineCount: 80 }
      },
      observation: "400: some code\n401: more code"
    },
    makeFailedReplaceText("scrapy/core/engine.py", "old three", "new three")
  ];

  const result = maybeBlockByStageBudget(
    makeReplaceTextAction("scrapy/core/engine.py", "old four", "new four"),
    "fix Scrapy issue #5703",
    22,
    30,
    makeWorkflowWithPlan(["scrapy/core/engine.py"]),
    history
  );

  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.errorCode, "REPLACE_TEXT_REPEATED_FAILURE");
  }
});

test("allows replaceText on a different file after TEXT_NOT_FOUND on another file", () => {
  const history = [
    makeFailedReplaceText("scrapy/core/engine.py", "old one", "new one"),
    makeFailedReplaceText("scrapy/core/engine.py", "old two", "new two"),
    makeFailedReplaceText("scrapy/core/engine.py", "old three", "new three")
  ];

  const result = maybeBlockByStageBudget(
    makeReplaceTextAction("scrapy/spider.py", "search", "replace"),
    "fix Scrapy issue #5703",
    20,
    30,
    makeWorkflowWithPlan(["scrapy/core/engine.py"]),
    history
  );

  assert.equal(result, undefined);
});

test("allows replaceLines after three replaceText TEXT_NOT_FOUND failures on the same file", () => {
  const history = [
    makeFailedReplaceText("scrapy/core/engine.py", "old one", "new one"),
    makeFailedReplaceText("scrapy/core/engine.py", "old two", "new two"),
    {
      thought: "Read target range.",
      action: {
        type: "action" as const,
        thought: "Read target range.",
        tool: "readFile",
        input: { path: "scrapy/core/engine.py", startLine: 400, lineCount: 80 }
      },
      observation: "400: some code\n401: more code"
    },
    makeFailedReplaceText("scrapy/core/engine.py", "old three", "new three")
  ];

  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "Use replaceLines instead.",
      tool: "replaceLines",
      input: { path: "scrapy/core/engine.py", startLine: 420, lineCount: 1, content: "new code\n" }
    },
    "fix Scrapy issue #5703",
    23,
    30,
    makeWorkflowWithPlan(["scrapy/core/engine.py"]),
    history
  );

  assert.equal(result, undefined);
});

test("allows repeated focused exploration after files have changed", () => {
  const history = Array.from({ length: 4 }, (_, index) => ({
    thought: `read ${index}`,
    action: {
      type: "action" as const,
      thought: "read",
      tool: index % 2 === 0 ? "readFile" : "searchText",
      input: { path: "src/a.ts", pattern: "foo" }
    },
    observation: "ok"
  }));

  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "inspect failure context",
      tool: "readFile",
      input: { path: "tests/a.test.ts", startLine: 1, lineCount: 30 }
    },
    "fix a bug",
    32,
    50,
    {
      runId: "run",
      plan: {
        summary: "Fix bug",
        expectedFiles: ["src/a.ts", "tests/a.test.ts"],
        steps: ["edit", "test"],
        createdAt: "now"
      },
      changedFiles: [{ path: "tests/a.test.ts", tool: "replaceLines", timestamp: "now" }],
      checks: [{ command: "npm test", ok: false, timestamp: "now" }]
    },
    history
  );

  assert.equal(result, undefined);
});

test("allows verification commands even when they read source text", () => {
  const history = Array.from({ length: 4 }, (_, index) => ({
    thought: `read ${index}`,
    action: {
      type: "action" as const,
      thought: "read",
      tool: "readFile",
      input: { path: "tests/a.py", startLine: 1, lineCount: 20 }
    },
    observation: "ok"
  }));

  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "syntax check",
      tool: "shell",
      input: { command: "python -c \"import ast; ast.parse(open('tests/a.py', encoding='utf-8').read())\"" }
    },
    "fix a bug",
    21,
    50,
    {
      runId: "run",
      plan: {
        summary: "Fix bug",
        expectedFiles: ["tests/a.py"],
        steps: ["edit", "test"],
        createdAt: "now"
      },
      changedFiles: [],
      checks: []
    },
    history
  );

  assert.equal(result, undefined);
});

test("treats shell text search as exploration after the pre-edit window", () => {
  const history = Array.from({ length: 6 }, (_, index) => ({
    thought: `inspect ${index}`,
    action: {
      type: "action" as const,
      thought: "inspect",
      tool: index % 2 === 0 ? "readFile" : "searchText",
      input: { path: "src/a.py", pattern: "needle", startLine: 1, lineCount: 20 }
    },
    observation: "ok"
  }));

  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "Use findstr to keep searching.",
      tool: "shell",
      input: { command: 'findstr /N "needle" src\\a.py' }
    },
    "fix a bug",
    13,
    45,
    {
      runId: "run",
      plan: {
        summary: "Fix bug",
        expectedFiles: ["src/a.py"],
        steps: ["edit", "test"],
        createdAt: "now"
      },
      changedFiles: [],
      checks: []
    },
    history
  );

  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.errorCode, "REPEATED_EXPLORATION_BLOCKED");
  }
});

test("blocks extra edits after a passing check following the latest edit", () => {
  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "Add a harmless comment after tests pass.",
      tool: "insertAtLine",
      input: { path: "tests/test_a.py", line: 10, content: "        # covered by test\n" }
    },
    "fix a bug and run pytest",
    41,
    45,
    {
      runId: "run",
      plan: {
        summary: "Fix bug",
        expectedFiles: ["src/a.py", "tests/test_a.py", "src/possible.py"],
        steps: ["edit", "pytest"],
        createdAt: "2026-01-01T00:00:00.000Z"
      },
      changedFiles: [{ path: "src/a.py", tool: "replaceLines", timestamp: "2026-01-01T00:00:01.000Z" }],
      checks: [
        {
          command: "python -m pytest tests/test_a.py -v",
          ok: true,
          timestamp: "2026-01-01T00:00:02.000Z"
        }
      ]
    },
    []
  );

  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.errorCode, "FINAL_READY_EDIT_BLOCKED");
  }
});

test("blocks any extra tool action after final readiness", () => {
  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "Check Python path after tests passed.",
      tool: "shell",
      input: { command: "where python" }
    },
    "fix a bug and run pytest",
    40,
    45,
    {
      runId: "run",
      plan: {
        summary: "Fix bug",
        expectedFiles: ["src/a.py"],
        steps: ["edit", "pytest"],
        createdAt: "2026-01-01T00:00:00.000Z"
      },
      changedFiles: [{ path: "src/a.py", tool: "replaceLines", timestamp: "2026-01-01T00:00:01.000Z" }],
      checks: [{ command: "python -m pytest tests/test_a.py -v", ok: true, timestamp: "2026-01-01T00:00:02.000Z" }]
    },
    []
  );

  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.errorCode, "FINAL_READY_EDIT_BLOCKED");
  }
});

test("blocks repeated issue target searches when the local checkout likely does not match", () => {
  const history = [
    {
      thought: "Search target",
      action: {
        type: "action" as const,
        thought: "Search target",
        tool: "searchText",
        input: { root: "tests", pattern: "test_start_requests_lazyness" }
      },
      observation: "No matches found."
    },
    {
      thought: "Search class",
      action: {
        type: "action" as const,
        thought: "Search class",
        tool: "shell",
        input: { command: 'findstr /N "CrawlTestCase" tests\\test_crawl.py' }
      },
      observation: '{"stdout":"","stderr":"","exitCode":1}'
    },
    {
      thought: "Search spider",
      action: {
        type: "action" as const,
        thought: "Search spider",
        tool: "searchText",
        input: { root: "tests", pattern: "BrokenStartRequestsSpider" }
      },
      observation: "0 results"
    }
  ];

  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "Keep searching for the missing target.",
      tool: "shell",
      input: { command: 'rg "test_start_requests_lazyness|CrawlTestCase" tests scrapy' }
    },
    "请修复 Scrapy issue #5703，定位 CrawlTestCase.test_start_requests_lazyness 和 BrokenStartRequestsSpider",
    9,
    45,
    {
      runId: "run",
      plan: {
        summary: "Fix issue",
        expectedFiles: ["scrapy/core/engine.py", "tests/test_crawl.py"],
        steps: ["locate", "edit", "pytest"],
        createdAt: "now"
      },
      changedFiles: [],
      checks: []
    },
    history
  );

  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.errorCode, "TARGET_NOT_LOCATED_PRECHECK_FAILED");
  }
});

test("issue-fix target preflight stops after two exact misses", () => {
  const history = [
    {
      thought: "Search exact test",
      action: {
        type: "action" as const,
        thought: "Search exact test",
        tool: "searchText",
        input: { root: "tests", pattern: "test_start_requests_lazyness" }
      },
      observation: "No matches found."
    },
    {
      thought: "Search exact class",
      action: {
        type: "action" as const,
        thought: "Search exact class",
        tool: "shell",
        input: { command: 'rg "CrawlTestCase" tests scrapy' }
      },
      observation: '{"stdout":"","stderr":"","exitCode":1}'
    }
  ];

  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "Keep searching broadly.",
      tool: "searchText",
      input: { root: ".", pattern: "start_requests" }
    },
    "fix Scrapy issue #5703 CrawlTestCase.test_start_requests_lazyness",
    6,
    45,
    {
      runId: "run",
      plan: {
        summary: "Fix issue",
        expectedFiles: ["scrapy/core/engine.py", "tests/test_crawl.py"],
        steps: ["locate", "edit", "pytest"],
        createdAt: "now"
      },
      changedFiles: [],
      checks: []
    },
    history
  );

  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.errorCode, "TARGET_NOT_LOCATED_PRECHECK_FAILED");
  }
});

test("blocks unrelated shell actions during inspect stage", () => {
  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "Check interpreter location.",
      tool: "shell",
      input: { command: "where python" }
    },
    "fix a bug",
    3,
    45,
    {
      runId: "run",
      plan: {
        summary: "Fix bug",
        expectedFiles: ["src/a.py"],
        steps: ["inspect", "edit", "test"],
        createdAt: "now"
      },
      changedFiles: [],
      checks: []
    },
    []
  );

  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.errorCode, "STAGE_INTENT_BLOCKED");
  }
});

test("escalates repeated stage intent blocks with a direct recovery instruction", () => {
  const history = [
    {
      thought: "Wrong action",
      action: {
        type: "action" as const,
        thought: "Wrong action",
        tool: "shell",
        input: { command: "where python" }
      },
      observation: "[tool_error]\ncode: STAGE_INTENT_BLOCKED\nmessage:\nUse an allowed intent."
    }
  ];

  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "Try another unrelated shell command.",
      tool: "shell",
      input: { command: "where node" }
    },
    "fix a bug",
    4,
    45,
    {
      runId: "run",
      plan: {
        summary: "Fix bug",
        expectedFiles: ["src/a.py"],
        steps: ["inspect", "edit", "test"],
        createdAt: "now"
      },
      changedFiles: [],
      checks: []
    },
    history
  );

  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.errorCode, "STAGE_INTENT_BLOCKED");
    assert.equal(result.content.includes("violation #2"), true);
    assert.equal(result.content.includes("Allowed action intents now"), true);
  }
});

test("does not enter final navigation when pytest is requested but only py_compile passed", () => {
  const navigation = navigateWorkflow(
    "fix a bug and run pytest",
    {
      plan: {
        summary: "Fix bug",
        expectedFiles: ["src/a.py"],
        steps: ["edit", "pytest"],
        createdAt: "now"
      },
      changedFiles: [{ path: "src/a.py", tool: "replaceLines", timestamp: "2026-01-01T00:00:01.000Z" }],
      checks: [{ command: "python -m py_compile src/a.py", ok: true, timestamp: "2026-01-01T00:00:02.000Z" }]
    },
    [],
    12,
    45
  );

  assert.equal(navigation.stage, "verify");
});

test("blocks more inspection during verify stage", () => {
  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "Read source again instead of running pytest.",
      tool: "readFile",
      input: { path: "src/a.py", startLine: 1, lineCount: 20 }
    },
    "fix a bug and run pytest",
    13,
    45,
    {
      runId: "run",
      plan: {
        summary: "Fix bug",
        expectedFiles: ["src/a.py"],
        steps: ["edit", "pytest"],
        createdAt: "now"
      },
      changedFiles: [{ path: "src/a.py", tool: "replaceLines", timestamp: "2026-01-01T00:00:01.000Z" }],
      checks: [{ command: "python -m py_compile src/a.py", ok: true, timestamp: "2026-01-01T00:00:02.000Z" }]
    },
    []
  );

  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.errorCode, "STAGE_INTENT_BLOCKED");
  }
});

test("blocks environment setup before a missing dependency failure", () => {
  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "Install pytest first.",
      tool: "shell",
      input: { command: "python -m pip install pytest" }
    },
    "fix a bug and run pytest",
    8,
    45,
    {
      runId: "run",
      plan: {
        summary: "Fix bug",
        expectedFiles: ["src/a.py"],
        steps: ["edit", "pytest"],
        createdAt: "now"
      },
      changedFiles: [{ path: "src/a.py", tool: "replaceLines", timestamp: "2026-01-01T00:00:01.000Z" }],
      checks: []
    },
    []
  );

  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.errorCode, "ENV_SETUP_NOT_JUSTIFIED");
  }
});

test("allows environment setup after a missing dependency verification failure", () => {
  const history = [
    {
      thought: "Run pytest",
      action: {
        type: "action" as const,
        thought: "Run pytest",
        tool: "shell",
        input: { command: "python -m pytest tests/test_a.py -v" }
      },
      observation: "ModuleNotFoundError: No module named 'testfixtures'"
    }
  ];

  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "Install the missing dependency.",
      tool: "shell",
      input: { command: "python -m pip install testfixtures" }
    },
    "fix a bug and run pytest",
    12,
    45,
    {
      runId: "run",
      plan: {
        summary: "Fix bug",
        expectedFiles: ["src/a.py"],
        steps: ["edit", "pytest"],
        createdAt: "now"
      },
      changedFiles: [{ path: "src/a.py", tool: "replaceLines", timestamp: "2026-01-01T00:00:01.000Z" }],
      checks: [{ command: "python -m pytest tests/test_a.py -v", ok: false, timestamp: "2026-01-01T00:00:02.000Z" }]
    },
    history
  );

  assert.equal(result, undefined);
});

test("allows setup after missing dependency even with intervening guard blocks", () => {
  const history = [
    {
      thought: "Run pytest",
      action: {
        type: "action" as const,
        thought: "Run pytest",
        tool: "shell",
        input: { command: "python -m pytest tests/test_a.py -v" }
      },
      observation: "No module named pytest"
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      thought: `Blocked ${index}`,
      action: {
        type: "action" as const,
        thought: "Wrong action",
        tool: "shell",
        input: { command: "where python" }
      },
      observation: "[tool_error]\ncode: STAGE_INTENT_BLOCKED\nmessage:\nUse an allowed intent."
    }))
  ];

  const result = maybeBlockByStageBudget(
    {
      type: "action",
      thought: "Install pytest and rerun.",
      tool: "shell",
      input: {
        command: ".venv\\Scripts\\python.exe -m pip install pytest -q && .venv\\Scripts\\python.exe -m pytest tests/test_a.py -q"
      }
    },
    "fix a bug and run pytest",
    18,
    30,
    {
      runId: "run",
      plan: {
        summary: "Fix bug",
        expectedFiles: ["src/a.py"],
        steps: ["edit", "pytest"],
        createdAt: "now"
      },
      changedFiles: [{ path: "src/a.py", tool: "replaceLines", timestamp: "2026-01-01T00:00:01.000Z" }],
      checks: [{ command: "python -m pytest tests/test_a.py -v", ok: false, timestamp: "2026-01-01T00:00:02.000Z" }]
    },
    history
  );

  assert.equal(result, undefined);
});
