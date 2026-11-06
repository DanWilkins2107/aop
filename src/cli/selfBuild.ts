// `aop serve` from a git checkout rebuilds itself when the sources are newer than the build, so
// updating AOP is `git pull` and a restart. An installed package has no sources, and skips all of it.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Set in the re-run process, so it serves instead of checking again. */
export const SELF_BUILT_ENV = "AOP_SELF_BUILT";

/** Everything the build reads, besides `src/` and `web/`. */
const BUILD_INPUTS = ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json", "vite.config.ts", "docs/roadmap.md"];
/** What the build writes. The oldest of them is when the last whole build finished. */
const BUILD_OUTPUTS = ["dist/cli/main.js", "dist/server/main.js", "dist/web/index.html"];

export interface BuildCheck {
  /** `package-lock.json` asks for packages `node_modules` doesn't have. */
  install: boolean;
  /** Why the build is out of date, or null if it isn't. */
  build: string | null;
}

/** The checkout `main.js` was built from, or null if it isn't running from a checkout's `dist/`. */
export function sourceCheckout(mainFile: string): string | null {
  const dist = dirname(dirname(mainFile));
  if (basename(dist) !== "dist") return null;
  const root = dirname(dist);
  return existsSync(join(root, "src")) && existsSync(join(root, ".git")) ? root : null;
}

function mtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** The newest modification time under `dir`, skipping `node_modules`. */
function newestIn(dir: string): number {
  let newest = mtime(dir) ?? 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestIn(path) : (mtime(path) ?? 0));
  }
  return newest;
}

/** Whether `node_modules` has every package `package-lock.json` asks for, at its version. */
function installed(root: string): boolean {
  let lock, hidden;
  try {
    lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  } catch {
    return true; // No lockfile to compare against.
  }
  try {
    hidden = JSON.parse(readFileSync(join(root, "node_modules", ".package-lock.json"), "utf8"));
  } catch {
    return false;
  }
  const have: Record<string, { version?: string }> = hidden.packages ?? {};
  for (const [path, entry] of Object.entries<{ version?: string; optional?: boolean }>(lock.packages ?? {})) {
    if (path === "") continue;
    const got = have[path];
    // Optional packages for other platforms are never installed.
    if (got === undefined ? !entry.optional : got.version !== entry.version) return false;
  }
  return true;
}

/** What `root` needs before its build can be served. */
export function checkBuild(root: string): BuildCheck {
  const install = !installed(root);
  const outputs = BUILD_OUTPUTS.map((file) => mtime(join(root, file)));
  if (outputs.some((time) => time === null)) return { install, build: "no build yet" };
  const built = Math.min(...(outputs as number[]));
  const sources = Math.max(
    newestIn(join(root, "src")),
    newestIn(join(root, "web")),
    ...BUILD_INPUTS.map((file) => mtime(join(root, file)) ?? 0),
  );
  return { install, build: sources > built ? "sources changed" : install ? "packages changed" : null };
}

function npm(root: string, args: string[]): boolean {
  // npm is `npm.cmd` on Windows, which only runs through a shell.
  const result = spawnSync("npm", args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  return result.status === 0;
}

/**
 * Before `aop serve`: rebuild a stale checkout and re-run the fresh build, since this process has
 * already loaded the old one. Returns true if it took over (the caller must do nothing more).
 */
export async function serveFreshBuild(mainFile: string, argv: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  if (env[SELF_BUILT_ENV] !== undefined) return false;
  const root = sourceCheckout(mainFile);
  if (root === null) return false;
  const check = checkBuild(root);
  if (check.build === null) return false;

  console.error(`Building AOP (${check.build})…`);
  if (check.install && !npm(root, ["install"])) return fail("`npm install` failed, so AOP wasn't rebuilt.");
  if (!npm(root, ["run", "build"])) return fail("The build failed, so AOP won't serve the old one. Fix it and run `aop serve` again.");

  const child = spawn(process.execPath, [...process.execArgv, mainFile, ...argv], {
    stdio: "inherit",
    env: { ...env, [SELF_BUILT_ENV]: "1" },
  });
  // A terminal sends Ctrl+C, Ctrl+Break and closing to the child too, so this process only has to
  // stay alive until the child has shut down. Elsewhere, pass signals on. Not on Windows, where
  // `kill` ends the child at once instead of letting it stop its agents.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
    process.on(signal, () => {
      if (process.platform !== "win32") child.kill(signal);
    });
  }
  const code = await new Promise<number>((resolve) => {
    child.on("error", (error) => {
      console.error(error);
      resolve(1);
    });
    child.on("exit", (status) => resolve(status ?? 1));
  });
  process.exitCode = code;
  return true;
}

function fail(message: string): true {
  console.error(message);
  process.exitCode = 1;
  return true;
}
