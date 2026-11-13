import type { Usage } from "./command.js";

/** The command was used wrongly. Exit code 2. */
export class UsageError extends Error {}

/** The command was used rightly, but failed. Exit code 1. */
export class CliFailure extends Error {}

/** A usage error that shows how the command is used, after what was wrong with it if there's more to say. */
export const usageError = (usage: Usage, problem?: string) =>
  new UsageError(`${problem === undefined ? "" : `${problem}\n`}Usage: ${usage.join("\n       ")}`);
