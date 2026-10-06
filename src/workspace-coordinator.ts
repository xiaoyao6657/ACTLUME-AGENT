import { resolve } from "node:path";

const workspaceQueues = new Map<string, Promise<void>>();

/** Serializes Actlume writes and checks in one Pi process so evidence has a stable execution window. */
export async function withWorkspaceMutation<T>(workspace: string, operation: () => Promise<T>): Promise<T> {
  const release = await acquireWorkspaceMutation(workspace);
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function acquireWorkspaceMutation(workspace: string): Promise<() => void> {
  const key = resolve(workspace);
  const previous = workspaceQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const queued = previous.then(() => gate);
  workspaceQueues.set(key, queued);
  await previous;
  return () => {
    release();
    if (workspaceQueues.get(key) === queued) workspaceQueues.delete(key);
  };
}
