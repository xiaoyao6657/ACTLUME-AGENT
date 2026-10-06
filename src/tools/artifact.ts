import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { toolSuccess, toolFailure } from "../tool-result.js";
import type { ToolDefinition } from "../types.js";

const artifactSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(30_000).default(20_000)
});

/** Reads only files created under this runtime's artifacts directory. */
export const readArtifactTool: ToolDefinition = {
  name: "readArtifact",
  description: "Read a previously referenced large tool-output artifact in bounded chunks. Pass its artifact path exactly as returned, then use offset for later chunks.",
  sideEffect: "read",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Artifact path previously returned by Actlume." },
      offset: { type: "number", minimum: 0, default: 0 },
      limit: { type: "number", minimum: 1, maximum: 30000, default: 20000 }
    },
    required: ["path"]
  },
  async run(input, ctx) {
    const args = artifactSchema.parse(input);
    let root: string;
    try {
      root = await realpath(resolve(ctx.memoryDir, "artifacts"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return toolFailure({ content: "No Actlume artifacts exist for this workspace.", errorCode: "ARTIFACT_NOT_FOUND", retryable: false });
      }
      throw error;
    }
    const candidate = resolve(args.path);
    const requestedRelative = relative(root, candidate);
    const requestedOutsideRoot = isOutsideRoot(requestedRelative);
    try {
      const actualPath = await realpath(candidate);
      const actualRelative = relative(root, actualPath);
      if (isOutsideRoot(actualRelative)) {
        return toolFailure({
          content: requestedOutsideRoot
            ? "Artifact path must be inside this Actlume memory directory's artifacts folder."
            : "Artifact symlinks outside the artifacts folder are not allowed.",
          errorCode: requestedOutsideRoot ? "ARTIFACT_PATH_OUTSIDE_ROOT" : "ARTIFACT_SYMLINK_OUTSIDE_ROOT",
          retryable: false
        });
      }
      const content = await readFile(actualPath, "utf8");
      const chunk = content.slice(args.offset, args.offset + args.limit);
      const nextOffset = args.offset + chunk.length < content.length ? args.offset + chunk.length : undefined;
      const header = "Artifact " + actualPath + " · chars " + args.offset + "–" + (args.offset + chunk.length) + " of " + content.length
        + (nextOffset === undefined ? " · end" : " · next offset " + nextOffset);
      return toolSuccess(header + "\n" + chunk, { path: actualPath, chars: content.length, offset: args.offset, nextOffset });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const outsideRoot = code === "ENOENT" && requestedOutsideRoot;
      return toolFailure({
        content: outsideRoot
          ? "Artifact path must be inside this Actlume memory directory's artifacts folder."
          : code === "ENOENT" ? "Artifact does not exist." : "Unable to read artifact: " + (error as Error).message,
        errorCode: outsideRoot ? "ARTIFACT_PATH_OUTSIDE_ROOT" : code === "ENOENT" ? "ARTIFACT_NOT_FOUND" : "ARTIFACT_READ_FAILED",
        retryable: code !== "ENOENT"
      });
    }
  }
};

function isOutsideRoot(path: string): boolean {
  return isAbsolute(path) || path === ".." || path.startsWith(".." + sep);
}
