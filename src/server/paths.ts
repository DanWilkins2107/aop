import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

/** Whether `path` is `folder` or inside it. Both absolute. Case follows the platform's own paths. */
export function isWithin(path: string, folder: string): boolean {
  const rel = relative(folder, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The git repo holding `path`, if any, found by looking for `.git` in it and each folder above it. */
export function repoAround(path: string): string | null {
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return null;
  }
}
