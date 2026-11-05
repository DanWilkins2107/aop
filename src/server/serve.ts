import { parseArgs } from "node:util";
import { ChangeFeed } from "./changes.js";
import { loadConfig } from "./config.js";
import { openDb, type Db } from "./db.js";
import { ConfigError } from "./errors.js";
import { Orchestrator } from "./orchestrator.js";
import { configPath, dbPath } from "./paths.js";
import { HOSTNAME, startServer } from "./server.js";
import { acquireServerLock, ServerAlreadyRunning, type ServerLock } from "./serverLock.js";

const DEFAULT_PORT = 4317;

/** Runs the server and its agents in the foreground until it's told to stop. */
export async function runServer(argv: string[], usage: string): Promise<void> {
  let port: number;
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { port: { type: "string" } } });
    if (positionals.length > 0) throw new Error("Unexpected argument");
    const portSetting = values.port ?? process.env["AOP_PORT"] ?? String(DEFAULT_PORT);
    port = Number(portSetting);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error(`Invalid port: ${portSetting}`);
      process.exitCode = 2;
      return;
    }
  } catch {
    console.error(usage);
    process.exitCode = 2;
    return;
  }

  let db: Db | undefined;
  let lock: ServerLock | undefined;
  try {
    // First, because a missing config is how a machine with no AOP_HOME folder stops here.
    loadConfig();
    // Before the database, its migrations and any agent: a second server on this AOP_HOME stops here.
    lock = acquireServerLock();
    db = openDb();
    const changes = new ChangeFeed();
    const orchestrator = new Orchestrator(db, { changes });
    // Binding the port comes before touching any agent, so a second server on this port stops here.
    const server = await startServer(db, port, { changes, orchestrator });
    const url = `http://${HOSTNAME}:${server.port}`;
    lock.setUrl(url);
    console.log(`AOP listening on ${url}`);
    console.log(`Config: ${configPath()}`);
    console.log(`Database: ${dbPath()}`);

    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      console.log("Stopping agents...");
      void orchestrator
        .shutdown()
        .then(() => server.close())
        .catch((error: unknown) => console.error(error))
        .finally(() => {
          db?.close();
          lock?.release();
          // Anything left, such as a stuck pipe to a dead agent, shouldn't hold the terminal.
          process.exit(0);
        });
    };
    // SIGHUP is a closed terminal, and on Windows SIGBREAK is Ctrl+Break.
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) process.on(signal, shutdown);

    await orchestrator.start(url);
  } catch (error) {
    db?.close();
    lock?.release();
    // A bad config or a running server is the expected failure here: say so, without a stack trace.
    console.error(error instanceof ConfigError || error instanceof ServerAlreadyRunning ? error.message : error);
    process.exitCode = 1;
  }
}
