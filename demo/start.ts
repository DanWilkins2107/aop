import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/server/api.js";
import { loadConfig } from "../src/server/config.js";
import { openDb } from "../src/server/db.js";
import { aopHome } from "../src/server/paths.js";
import { addProject } from "../src/server/projects.js";
import { HOSTNAME, startServer } from "../src/server/server.js";
import { seed } from "./seed.js";

const DEFAULT_PORT = 4317;

// Set before anything reads it. The state lasts as long as this process, so each start is fresh.
const home = mkdtempSync(join(tmpdir(), "aop-demo-"));
process.env["AOP_HOME"] = home;
if (resolve(aopHome()) === resolve(homedir(), ".aop")) throw new Error("The demo must not use the real ~/.aop");

const here = dirname(fileURLToPath(import.meta.url));
cpSync(join(here, "config"), home, { recursive: true });
loadConfig();

const db = openDb();
const project = addProject(db, here, "Demo project");
await seed(createApp(db), db, project.id);

const server = await startServer(db, Number(process.env["AOP_PORT"] ?? DEFAULT_PORT));
console.log(`AOP demo on http://${HOSTNAME}:${server.port}`);
console.log(`Throwaway state in ${home}, deleted on exit. Press Ctrl+C to stop.`);

const shutdown = () => {
  void server.close().finally(() => {
    db.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    process.exit(0);
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
