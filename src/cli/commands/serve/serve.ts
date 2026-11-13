import type { Command } from "../../shared/command.js";
import { usageError } from "../../shared/errors.js";

const usage = ["aop serve [--port <port>]"];

/** Runs the server in this process. Before any command loads, `main.ts` rebuilds it if its sources are newer, with `selfBuild.ts`. */
export const serve: Command = {
  name: "serve",
  usage,
  async run(_c, argv) {
    // Loaded here because every other command only talks HTTP, and shouldn't need the database's native module.
    const { runServer } = await import("../../../server/serve.js");
    // The server belongs to the process, so it prints, and sets the exit code, there.
    await runServer(argv, usageError(usage).message);
    return Number(process.exitCode ?? 0);
  },
};
