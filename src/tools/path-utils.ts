import { resolve, relative, isAbsolute } from "node:path";

export function resolveInsideCwd(cwd: string, inputPath: string): string {
  const base = resolve(cwd);
  const candidate = isAbsolute(inputPath) ? resolve(inputPath) : resolve(base, inputPath);
  const rel = relative(base, candidate);

  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return candidate;
  }

  throw new Error(`Path escapes project root: ${inputPath}`);
}

export function toProjectRelative(cwd: string, absolutePath: string): string {
  const rel = relative(resolve(cwd), absolutePath);
  return rel === "" ? "." : rel.replaceAll("\\", "/");
}
