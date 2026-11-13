import { parseArgs, type ParseArgsConfig } from "node:util";
import type { Usage } from "./command.js";
import { usageError } from "./errors.js";

/** Reads the options of one command. A bad option is a usage error, not a stack trace. */
export function args<T extends NonNullable<ParseArgsConfig["options"]>>(argv: string[], usage: Usage, options: T) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw usageError(usage, (error as Error).message);
  }
}

/** The one value there must be, or else a usage error. */
export function only<T>(values: T[], usage: Usage): T {
  const [value] = values;
  if (value === undefined || values.length !== 1) throw usageError(usage);
  return value;
}

/** For commands that take no arguments at all. */
export function none(argv: string[], usage: Usage): void {
  if (args(argv, usage, {}).positionals.length > 0) throw usageError(usage);
}
