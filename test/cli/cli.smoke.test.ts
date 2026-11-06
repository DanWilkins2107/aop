// The real `aop` entry point, each call in its own process. `cli.test.ts` covers the commands in-process;
// these check what only a real process shows: its exit code, its output streams, and no stack traces.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { world } from "../server/agents.helpers.js";
import { aopSpawned as aop } from "./cli.helpers.js";

describe("the aop entry point", () => {
  it("prints the help, and a usage error is exit code 2 with no stack trace", async () => {
    const help = await aop(["help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("\n  aop next <outcome>\n");
    for (const args of [["next"], ["nonsense"]]) {
      const res = await aop(args);
      expect(res.code, args.join(" ")).toBe(2);
      expect(res.stderr).toContain("aop ");
      expect(res.stderr).not.toContain("    at ");
    }
  });

  it("says when the server can't be reached", async () => {
    const res = await aop(["context", "x"], { AOP_URL: "http://127.0.0.1:1" });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("aop serve");
    expect(res.stderr).not.toContain("    at ");
  });

  it("reads its node from the environment, and passes on a steered session's exit code", async () => {
    const w = await world();
    const node = await w.create("", { stage: "pr_review", type: "dev", title: "The node" });
    const context = await aop(["context"], { AOP_URL: w.url, AOP_NODE_ID: node.id });
    expect(context.code).toBe(0);
    expect(context.stdout).toContain("The node");

    // Stands in for the interactive tool, and never is one.
    const session = `${JSON.stringify(process.execPath)} -e "process.exit(7)"`;
    writeFileSync(join(w.home, "config.yaml"), `agent_session_command: ${JSON.stringify(session)}\nstages: ./stages.yaml\n`);
    expect((await aop(["steer", node.id], { AOP_URL: w.url })).code).toBe(7);
  });
});
