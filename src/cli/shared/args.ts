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

/** `--json`: print what the server answered, as JSON, instead of a summary. */
export const JSON_OPTION = { json: { type: "boolean" } } as const;

/** The one value there must be, or else a usage error. */
export function only<T>(values: T[], usage: Usage): T {
  const [value] = values;
  if (value === undefined || values.length !== 1) throw usageError(usage);
  return value;
}

/** For commands that take no arguments but `--json`. Gives whether it was given. */
export function onlyJson(argv: string[], usage: Usage): boolean {
  const { values, positionals } = args(argv, usage, JSON_OPTION);
  if (positionals.length > 0) throw usageError(usage);
  return values.json === true;
}
