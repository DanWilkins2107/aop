import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The state directory. Every path under it must be built from this function. */
export function aopHome(): string {
  const fromEnv = process.env["AOP_HOME"];
  return fromEnv ? resolve(fromEnv) : join(homedir(), ".aop");
}

export function dbPath(): string {
  return join(aopHome(), "aop.db");
}
