// `aop serve` from a git checkout rebuilds itself, with the extensions `config.yaml` lists compiled
// in, every time, so updating AOP or an extension is a restart. An installed package has no sources,
// so it can't, and refuses to serve extensions.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { aopHome } from "../../../server/shared/paths.js";
import { noCwdLookupEnv } from "../../../shared/os/noCwdLookupEnv.js";
import { buildExtensions } from "./extensionBuild.js";
import { readExtensions } from "./extensions.js";

/** Set in the re-run process, so it serves instead of checking again. */
const SELF_BUILT_ENV = "AOP_SELF_BUILT";

/** The checkout `main.js` was built from, or null if it isn't running from a checkout's `dist/`. */
export function sourceCheckout(mainFile: string): string | null {
  const dist = dirname(dirname(mainFile));
  if (basename(dist) !== "dist") return null;
  const root = dirname(dist);
  return existsSync(join(root, "src")) && existsSync(join(root, ".git")) ? root : null;
}

interface Locked {
  version: unknown;
  optional: unknown;
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;

/** A lockfile's packages by path, or undefined if it can't be read. */
function lockedPackages(file: string): Map<string, Locked> | undefined {
  let lock: unknown;
  try {
    lock = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  const packages = field(lock, "packages");
  const paths = typeof packages === "object" && packages !== null ? Object.keys(packages) : [];
  return new Map(
    paths.map((path) => {
      const entry = field(packages, path);
      return [path, { version: field(entry, "version"), optional: field(entry, "optional") }];
    }),
  );
}

/** Whether `node_modules` has every package `package-lock.json` asks for, at its version. */
export function installed(root: string): boolean {
  const lock = lockedPackages(join(root, "package-lock.json"));
  // No lockfile to compare against.
  if (lock === undefined) return true;
  const have = lockedPackages(join(root, "node_modules", ".package-lock.json"));
  if (have === undefined) return false;
  for (const [path, entry] of lock) {
    if (path === "") continue;
    const got = have.get(path);
    // Optional packages for other platforms are never installed.
    if (got === undefined ? entry.optional !== true : got.version !== entry.version) return false;
  }
  return true;
}

function npm(root: string, args: string[]): boolean {
  // npm is `npm.cmd` on Windows, which only runs through a shell.
  const result = spawnSync("npm", args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...noCwdLookupEnv },
  });
  return result.status === 0;
}

/**
 * Before `aop serve`: rebuild the checkout with its extensions, then re-run the fresh build, since
 * this process has already loaded the old one. Returns true if it took over (the caller must do
 * nothing more).
 */
export async function serveFreshBuild(mainFile: string, argv: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  if (env[SELF_BUILT_ENV] !== undefined) return false;
  const listed = readExtensions(aopHome(env));
  if (!listed.ok) return fail(["AOP won't serve, as its extensions have problems:", ...listed.problems].join("
"));
  const root = sourceCheckout(mainFile);
  if (root === null) {
    return listed.extensions.length > 0 ? fail("Extensions are compiled into AOP, so it must run from a git checkout to use them.") : false;
  }

  console.error("Building AOP…");
  if (!installed(root) && !npm(root, ["install"])) return fail("`npm install` failed, so AOP wasn't rebuilt.");
  const problems = buildExtensions(root, listed.extensions, (line) => console.error(line));
  if (problems.length > 0) return fail([...problems, "AOP won't serve without them. Fix it, or take it out of extensions: in config.yaml."].join("
"));
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
    child.on("exit", (status) => {
      resolve(status ?? 1);
    });
  });
  process.exitCode = code;
  return true;
}

function fail(message: string): true {
  console.error(message);
  process.exitCode = 1;
  return true;
}
