export type AgentActionOutput = {
  type: "action";
  thought: string;
  tool: string;
  input: unknown;
};

export type AgentFinalOutput = {
  type: "final";
  answer: string;
};

export type AgentOutput = AgentActionOutput | AgentFinalOutput;

export type ToolContext = {
  cwd: string;
  memoryDir: string;
  readonly: boolean;
  runId: string;
  securityPolicy: SecurityPolicy;
};

export type ToolSideEffect = "read" | "write" | "execute";

export type SecurityPolicy = {
  allowedTools?: string[];
  deniedTools?: string[];
  shellAllowlist?: string[];
  shellDenylist?: string[];
  allowHighRiskShell?: boolean;
};

export type ToolResult =
  | {
      ok: true;
      content: string;
      metadata?: unknown;
    }
  | {
      ok: false;
      content: string;
      errorCode: string;
      retryable: boolean;
      metadata?: unknown;
    };

export type ToolDefinition = {
  name: string;
  description: string;
  sideEffect: ToolSideEffect;
  source?: "local" | "mcp";
  parameters: unknown;
  run: (input: unknown, ctx: ToolContext) => Promise<ToolResult>;
};

export type ToolConfirmationRequest = {
  toolName: string;
  sideEffect: ToolSideEffect;
  input: unknown;
  preview?: string;
};

export type ActionRecord = {
  id: string;
  timestamp: string;
  thought?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: ToolResult;
  observation?: string;
  summary?: string;
};

export type AgentHistoryItem = {
  thought: string;
  action: AgentActionOutput;
  observation: string;
};

export type ShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type SearchResult = {
  file: string;
  line: number;
  text: string;
};

export type Session = {
  id: string;
  startedAt: string;
  endedAt?: string;
  userTask: string;
  status: "running" | "completed" | "failed";
};

export type TaskItem = {
  id: string;
  title: string;
  status: "todo" | "doing" | "done" | "blocked";
};
