import { spawn, type ChildProcess } from "node:child_process";

export type SupervisedProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  outcome: "completed" | "failed" | "cancelled" | "timed_out" | "start_failed" | "unknown";
  terminationConfirmed: boolean;
  shell: string;
  cwd: string;
  durationMs: number;
};

export async function runShellCommand(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}): Promise<SupervisedProcessResult> {
  const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : process.env.SHELL || "/bin/sh";
  const startedAt = Date.now();
  if (input.signal?.aborted) {
    return { stdout: "", stderr: "Command cancelled before it started.", exitCode: null, outcome: "cancelled", terminationConfirmed: true, shell, cwd: input.cwd, durationMs: 0 };
  }

  return await new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(input.command, {
        cwd: input.cwd,
        shell,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({ stdout: "", stderr: (error as Error).message, exitCode: null, outcome: "start_failed", terminationConfirmed: true, shell, cwd: input.cwd, durationMs: Date.now() - startedAt });
      return;
    }

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    const maxBytes = input.maxOutputBytes ?? 1024 * 1024;
    let outcome: SupervisedProcessResult["outcome"] = "completed";
    let terminationConfirmed = true;
    let exitCode: number | null = null;
    let settled = false;
    let stopPromise: Promise<void> | undefined;

    const append = (target: "stdout" | "stderr", chunk: Buffer | string) => {
      const text = chunk.toString();
      outputBytes += Buffer.byteLength(text);
      const remaining = maxBytes - Buffer.byteLength(stdout) - Buffer.byteLength(stderr);
      if (remaining <= 0) return;
      const clipped = Buffer.from(text).subarray(0, remaining).toString();
      if (target === "stdout") stdout += clipped;
      else stderr += clipped;
      if (outputBytes > maxBytes && !stderr.includes("[output truncated]")) stderr += "\n[output truncated]";
    };
    child.stdout?.on("data", (chunk: Buffer | string) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => append("stderr", chunk));

    const stop = (reason: "cancelled" | "timed_out") => {
      if (stopPromise) return stopPromise;
      outcome = reason;
      stopPromise = terminateProcessTree(child).then((confirmed) => {
        terminationConfirmed = confirmed;
        if (!confirmed) outcome = "unknown";
      }).catch((error) => {
        terminationConfirmed = false;
        outcome = "unknown";
        stderr += `\nCould not confirm process-tree termination: ${(error as Error).message}`;
      });
      return stopPromise;
    };

    const abortHandler = () => { void stop("cancelled"); };
    input.signal?.addEventListener("abort", abortHandler, { once: true });
    const timer = setTimeout(() => { void stop("timed_out"); }, input.timeoutMs);

    child.once("error", (error) => {
      outcome = "start_failed";
      stderr += error.message;
    });
    child.once("close", (code) => {
      exitCode = code;
      void (async () => {
        if (stopPromise) await stopPromise;
        if (outcome === "completed" && code !== 0) outcome = "failed";
        if (outcome === "completed" && code === null) outcome = "unknown";
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abortHandler);
        resolve({ stdout, stderr, exitCode, outcome, terminationConfirmed, shell, cwd: input.cwd, durationMs: Date.now() - startedAt });
      })();
    });
  });
}

async function terminateProcessTree(child: ChildProcess): Promise<boolean> {
  const pid = child.pid;
  if (!pid) return false;
  if (process.platform === "win32") {
    const result = await new Promise<boolean>((resolve) => {
      const killer = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `taskkill /PID ${pid} /T /F`], {
        windowsHide: true,
        stdio: "ignore"
      });
      const timer = setTimeout(() => {
        killer.kill();
        resolve(false);
      }, 5_000);
      killer.once("error", () => { clearTimeout(timer); resolve(false); });
      killer.once("close", (code) => { clearTimeout(timer); resolve(code === 0); });
    });
    if (!result && child.exitCode === null) child.kill();
    return result;
  }

  try { process.kill(-pid, "SIGTERM"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
  return true;
}
