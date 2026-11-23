// `aop serve` and `npm start`: loads the config, takes the lock, opens the database, and starts the
// API, the agents' MCP server, the orchestrator and the scheduler in that order. Also owns clean shutdown.

import { parseArgs } from "node:util";
import { ChangeFeed } from "./db/changes.js";
import { loadConfig } from "./config/config.js";
import { openDb, type Db } from "./db/db.js";
import { ConfigError } from "./shared/errors.js";
import { Orchestrator } from "./runs/orchestrator.js";
import { configPath, dbPath } from "./shared/paths.js";
import { Scheduler } from "./schedule/scheduler.js";
import { HOSTNAME, startServer, type RunningServer } from "./http/server.js";
import { MCP_PATH, startMcpServer } from "../mcp/server.js";
import { TEST_MCP_PORT_ENV } from "./testMcpPortEnv.js";
import { DEFAULT_PORT } from "../shared/http/defaultPort.js";
import { MCP_PORT } from "../shared/http/mcpPort.js";
import { acquireServerLock, ServerAlreadyRunning, type ServerLock } from "./os/serverLock.js";

/** The MCP server's fixed port is taken, most likely by another AOP with a different AOP_HOME. */
class McpPortInUse extends Error {
  constructor(port: number) {
    super(`MCP port ${port} is in use. Is another AOP running?`);
    this.name = "McpPortInUse";
  }
}

interface ServeOptions {
  port: number;
  /** The most agents to run at once, or null for no limit. The UI can change it while the server runs. */
  agentLimit: number | null;
}

/** The options, or null after saying what's wrong with them. */
function readOptions(argv: string[], usage: string): ServeOptions | null {
  let values: { port?: string; agents?: string };
  try {
    const parsed = parseArgs({ args: argv, allowPositionals: true, options: { port: { type: "string" }, agents: { type: "string" } } });
    if (parsed.positionals.length > 0) throw new Error("Unexpected argument");
    values = parsed.values;
  } catch {
    console.error(usage);
    return null;
  }
  const portSetting = values.port ?? process.env["AOP_PORT"] ?? String(DEFAULT_PORT);
  const port = Number(portSetting);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid port: ${portSetting}`);
    return null;
  }
  const agentLimit = values.agents === undefined ? null : Number(values.agents);
  if (agentLimit !== null && (!Number.isInteger(agentLimit) || agentLimit < 0)) {
    console.error(`Invalid agent limit: ${values.agents}. Give a whole number, 0 or more.`);
    return null;
  }
  return { port, agentLimit };
}

/** Runs the server and its agents in the foreground until it's told to stop. */
export async function runServer(argv: string[], usage: string): Promise<void> {
  const options = readOptions(argv, usage);
  if (options === null) {
    process.exitCode = 2;
    return;
  }
  const { port, agentLimit } = options;

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
    const orchestrator = new Orchestrator(db, { changes, agentLimit });
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
    console.log(`Agent limit: ${agentLimit ?? "none"}`);
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
