// The real `aop` entry point, each call in its own process. `cli.test.ts` and `commands/` cover the commands in-process;
// these check what only a real process shows: its exit code, its output streams, and no stack traces.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { world } from "../../test/server/agents.helpers.js";
import { aopSpawned as aop } from "./shared/cli.helpers.js";

describe("the aop entry point", () => {
  it("prints the help, and a usage error is exit code 2 with no stack trace", async () => {
    const help = await aop(["help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("\n  aop ps\n");
    for (const args of [["logs"], ["nonsense"]]) {
      const res = await aop(args);
      expect(res.code, args.join(" ")).toBe(2);
      expect(res.stderr).toContain("aop ");
      expect(res.stderr).not.toContain("    at ");
    }
  });

  it("says when the server can't be reached", async () => {
    const res = await aop(["ps"], { AOP_URL: "http://127.0.0.1:1" });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("aop serve");
    expect(res.stderr).not.toContain("    at ");
  });

  it("passes on a steered session's exit code", async () => {
    const w = await world();
    const node = await w.create("", { stage: "pr_review", type: "dev", title: "The node" });
    // Stands in for the interactive tool, and never is one.
    const session = `${JSON.stringify(process.execPath)} -e "process.exit(7)"`;
    writeFileSync(join(w.home, "config.yaml"), `agent_session_command: ${JSON.stringify(session)}\nstages: ./stages.yaml\n`);
    expect((await aop(["steer", node.id], { AOP_URL: w.url })).code).toBe(7);
  });
});

describe("the bin entry", () => {
  it("points at a built file", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { bin: Record<string, string> };
    expect(pkg.bin).toEqual({ aop: "dist/cli/main.js" });
    expect(readFileSync("src/cli/main.ts", "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  });
});
