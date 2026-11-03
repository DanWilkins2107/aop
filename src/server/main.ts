import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { openDb, type Db } from "./db.js";
import { ConfigError } from "./errors.js";
import { configPath, dbPath } from "./paths.js";
import { HOSTNAME, startServer } from "./server.js";

const DEFAULT_PORT = 4317;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { port: { type: "string" } },
  });
  if (positionals.length > 0) {
    console.error("Usage: npm start -- [--port <port>]");
    process.exitCode = 2;
    return;
  }
  const portSetting = values.port ?? process.env["AOP_PORT"] ?? String(DEFAULT_PORT);
  const port = Number(portSetting);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid port: ${portSetting}`);
    process.exitCode = 2;
    return;
  }

  let db: Db | undefined;
  try {
    // First, because a missing config is how a machine with no AOP_HOME folder stops here.
    loadConfig();
    db = openDb();
    const server = await startServer(db, port);
    console.log(`AOP listening on http://${HOSTNAME}:${server.port}`);
    console.log(`Config: ${configPath()}`);
    console.log(`Database: ${dbPath()}`);

    const shutdown = () => {
      void server.close().finally(() => db?.close());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    db?.close();
    // A bad config is the expected failure here: print its problems, not a stack trace.
    console.error(error instanceof ConfigError ? error.message : error);
    process.exitCode = 1;
  }
}

await main();
