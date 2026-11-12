// `aop serve` and `npm start`: loads the config, takes the lock, opens the database, and starts the
// API, the agents' MCP server, the orchestrator and the scheduler in that order. Also owns clean shutdown.

import { parseArgs } from "node:util";
import { ChangeFeed } from "./changes.js";
import { loadConfig } from "./config.js";
import { openDb, type Db } from "./db.js";
import { ConfigError } from "./errors.js";
import { Orchestrator } from "./orchestrator.js";
import { configPath, dbPath } from "./paths.js";
import { Scheduler } from "./scheduler.js";
import { HOSTNAME, startServer, type RunningServer } from "./server.js";
import { MCP_PATH, startMcpServer } from "../mcp/server.js";
import { DEFAULT_PORT, MCP_PORT, TEST_MCP_PORT_ENV } from "../shared/api/port.js";
import { acquireServerLock, ServerAlreadyRunning, type ServerLock } from "./serverLock.js";

/** The MCP server's fixed port is taken, most likely by another AOP with a different AOP_HOME. */
class McpPortInUse extends Error {
  constructor(port: number) {
    super(`MCP port ${port} is in use. Is another AOP running?`);
    this.name = "McpPortInUse";
  }
}

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
  let api: RunningServer | undefined;
  let mcpServer: RunningServer | undefined;
  try {
    // First, because a missing config is how a machine with no AOP_HOME folder stops here.
    loadConfig();
    // Before the database, its migrations and any agent: a second server on this AOP_HOME stops here.
    lock = acquireServerLock();
    db = openDb();
    const changes = new ChangeFeed();
    const orchestrator = new Orchestrator(db, { changes });
    const scheduler = new Scheduler(db, { changes });
    // Binding the port comes before touching any agent, so a second server on this port stops here.
    const server = await startServer(db, port, { changes, orchestrator });
    api = server;
    const url = `http://${HOSTNAME}:${server.port}`;
    lock.setUrl(url);
    console.log(`AOP listening on ${url}`);
    // Before the agents, which reach AOP through it. Always the same port, so a sandbox can allow just that.
    const mcpPort = Number(process.env[TEST_MCP_PORT_ENV] ?? MCP_PORT);
    const mcp = await startMcpServer(db, mcpPort, { changes, orchestrator }).catch((error: unknown) => {
      if ((error as { code?: string }).code === "EADDRINUSE") throw new McpPortInUse(mcpPort);
      throw error;
    });
    mcpServer = mcp;
    const mcpUrl = `http://${HOSTNAME}:${mcp.port}${MCP_PATH}`;
    lock.setMcpUrl(mcpUrl);
    console.log(`AOP MCP listening on ${mcpUrl}`);
    console.log(`Config: ${configPath()}`);
    console.log(`Database: ${dbPath()}`);

    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      scheduler.stop();
      console.log("Stopping agents...");
      void orchestrator
        .shutdown()
        .then(() => Promise.all([mcp.close(), server.close()]))
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

    await orchestrator.start(mcpUrl);
    // After the orchestrator, so the first children it creates are picked up straight away.
    if (!stopping) scheduler.start();
  } catch (error) {
    // Such as the MCP port being taken: neither port should keep the process alive.
    await Promise.all([api?.close(), mcpServer?.close()]).catch(() => undefined);
    db?.close();
    lock?.release();
    // A bad config, a running server or a taken MCP port is the expected failure here: say so, without a stack trace.
    const expected = error instanceof ConfigError || error instanceof ServerAlreadyRunning || error instanceof McpPortInUse;
    console.error(expected ? error.message : error);
    process.exitCode = 1;
  }
}
