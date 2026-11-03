import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The state directory. Every path under it must be built from this function. */
export function aopHome(): string {
  const fromEnv = process.env["AOP_HOME"];
  return fromEnv ? resolve(fromEnv) : join(homedir(), ".aop");
}

export function configPath(home: string = aopHome()): string {
  return join(home, "config.yaml");
}

/** Resolves a path written in `config.yaml`: `~` is the user's home, and relative paths start at `home`. */
export function resolveConfigPath(home: string, path: string): string {
  const fromUserHome = /^~(?:[\\/](.*))?$/.exec(path);
  return fromUserHome ? resolve(join(homedir(), fromUserHome[1] ?? "")) : resolve(home, path);
}

export function dbPath(): string {
  return join(aopHome(), "aop.db");
}
