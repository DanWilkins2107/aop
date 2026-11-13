/** What a run of the CLI reads and writes, instead of the process's own. */
export interface CliIo {
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** Called once, with the exit code, when the command has finished. */
  exit: (code: number) => void;
  /** Where relative paths start. The process's own working directory if left out. */
  cwd?: string;
}

/** One run: its environment, and where it prints. */
export interface Ctx {
  env: NodeJS.ProcessEnv;
  io: CliIo;
  log: (text: string) => void;
}

/** How a command is used, one line per form. The help and the command's own usage errors both show it. */
export type Usage = readonly string[];

/** One `aop` command: its name, its usage, and what it does with the arguments after its name. */
export interface Command {
  name: string;
  usage: Usage;
  /** Runs the command, and gives its exit code when it isn't 0. */
  run: (c: Ctx, argv: string[]) => Promise<number | void>;
}
