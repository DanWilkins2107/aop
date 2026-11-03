import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll } from "vitest";

// Runs before each test file, so nothing can reach the real ~/.aop even by accident.
const home = mkdtempSync(join(tmpdir(), "aop-test-"));
process.env["AOP_HOME"] = home;

if (resolve(home).startsWith(resolve(homedir(), ".aop"))) {
  throw new Error("Tests must not run against the real ~/.aop");
}

afterAll(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
