import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll } from "vitest";
import { TEST_MCP_PORT_ENV } from "../../src/shared/port.js";

// Runs before each test file, so nothing can reach the real ~/.aop even by accident.
const home = mkdtempSync(join(tmpdir(), "aop-test-"));
process.env["AOP_HOME"] = home;
// Anything that forgets to choose a port gets a free one, and a CLI run that forgets AOP_URL fails
// instead of reaching a real server on 4317.
process.env["AOP_PORT"] = "0";
// The same for the MCP server, whose port is otherwise fixed. Inherited by every server a test spawns.
process.env[TEST_MCP_PORT_ENV] = "0";

if (resolve(home).startsWith(resolve(homedir(), ".aop"))) {
  throw new Error("Tests must not run against the real ~/.aop");
}

afterAll(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
