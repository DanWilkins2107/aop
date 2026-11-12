import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.join(import.meta.dirname, "..");

/** Every file under `folders` that git tracks or would track, as repo-relative paths with `/`. */
export function repoFiles(...folders: string[]): string[] {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...folders], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter((file) => file !== "");
}

/** The text of each of those files that still exists, by path. */
export function repoSources(...folders: string[]): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const file of repoFiles(...folders)) {
    try {
      sources[file] = readFileSync(path.join(repoRoot, file), "utf8");
    } catch {
      // Deleted, but the deletion isn't staged yet.
    }
  }
  return sources;
}
