import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The state directory. Every path under it must be built from this function. A relative AOP_HOME starts at `cwd`. */
export function aopHome(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const fromEnv = env["AOP_HOME"];
  return fromEnv ? resolve(cwd, fromEnv) : join(homedir(), ".aop");
}

export function configPath(home: string = aopHome()): string {
  return join(home, "config.yaml");
}

const FROM_USER_HOME = /^~(?:[\\/](.*))?$/;

/** Whether `path` is written from the user's home, as `~` or `~/x`. */
export function isFromUserHome(path: string): boolean {
  return FROM_USER_HOME.test(path);
}

/**
 * Resolves a path as a user writes one, in `config.yaml` or to `aop init`: `~` and `~/x` are the
 * user's home, and other relative paths start at `base`, which for `config.yaml` is AOP_HOME.
 */
export function resolveConfigPath(base: string, path: string): string {
  const fromUserHome = FROM_USER_HOME.exec(path);
  return fromUserHome ? resolve(join(homedir(), fromUserHome[1] ?? "")) : resolve(base, path);
}

export function dbPath(): string {
  return join(aopHome(), "aop.db");
}
