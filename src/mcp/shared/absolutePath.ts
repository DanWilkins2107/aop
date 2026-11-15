import { isAbsolute, resolve } from "node:path";
import { ApiFailure } from "./ApiFailure.js";

/** The MCP server has no working directory, so a relative path has nothing to start from. */
export function absolutePath(path: string): string {
  if (!isAbsolute(path)) throw new ApiFailure(`Give an absolute path, not ${path}`);
  return resolve(path);
}
