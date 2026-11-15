import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { directives, fakeCommand, settle, toolCall, type World } from "../../../test-shared/agents.js";
import { aopOn, cliWorld, parked } from "../shared/cli.helpers.js";

let w: World;
beforeEach(async () => {
  w = await cliWorld();
});

/** Writes what the session was given, and exits. Stands in for the interactive tool, and never is one. */
const session = (name: string, code = 0) =>
  `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({cwd: process.cwd(), node: process.env.AOP_NODE_ID, url: process.env.AOP_URL, run: process.env.AOP_RUN_ID, args: process.argv.slice(2)})); process.exit(${code})" "${w.file(name)}"`;

const Seen = z.object({ cwd: z.string(), node: z.string().optional(), url: z.string(), run: z.string(), args: z.array(z.string()) });

/** What the session written as `name` was given. */
const seenBy = (name: string) => Seen.parse(JSON.parse(readFileSync(w.file(name), "utf8")));

/** The ID of the node's open steer session. */
const steerId = (node: string) =>
  z.object({ id: z.string() }).parse(w.db.prepare("SELECT id FROM steer_sessions WHERE node_id = ? AND ended_at IS NULL").get(node)).id;

function useCommands(agent: string, out?: string): void {
  const outLine = out === undefined ? [] : [`out_of_sandbox_command: ${JSON.stringify(out)}`];
  writeFileSync(join(w.home, "config.yaml"), [`agent_session_command: ${JSON.stringify(agent)}`, ...outLine, "stages: ./stages.yaml", ""].join("\n"));
}

describe("steer", () => {
  it("claims for the human and runs agent_session_command in the start folder, with no flags", async () => {
    const node = await parked(w);
    useCommands(session("in.json"));
    const res = await aopOn(w, ["steer", node.id]);
    expect(res.code).toBe(0);
    expect(w.node(node.id).claimed_by).toBe("human");
    const seen = seenBy("in.json");
    expect(seen.cwd.toLowerCase()).toBe(w.repo.toLowerCase());
    // The node's ID is in the steer output, not the environment.
    expect(seen.node).toBeUndefined();
    expect(res.stdout).toContain(node.id);
    expect(seen.url).toBe(w.url);
    expect(seen.args).toEqual([]);
    // The session's own run ID, tied to the claim, printed for the human to pass on.
    const run = steerId(node.id);
    expect(seen.run).toBe(run);
    expect(res.stdout).toContain(run);

    // Reopening a session you hold is fine, keeps its run ID, and the claim survives its end.
    expect((await aopOn(w, ["steer", node.id])).code).toBe(0);
    expect(w.node(node.id).claimed_by).toBe("human");
    expect(seenBy("in.json").run).toBe(run);
  });

  it("--no-sandbox runs out_of_sandbox_command, and errors clearly if it isn't set", async () => {
    const node = await parked(w);
    useCommands(session("in.json", 1), session("out.json"));
    expect((await aopOn(w, ["steer", node.id, "--no-sandbox"])).code).toBe(0);
    expect(existsSync(w.file("out.json"))).toBe(true);
    expect(existsSync(w.file("in.json"))).toBe(false);
    expect(seenBy("out.json").run).toBe(steerId(node.id));

    const other = await parked(w);
    useCommands(session("in.json"));
    const res = await aopOn(w, ["steer", other.id, "--no-sandbox"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("out_of_sandbox_command");
    expect(existsSync(w.file("in.json"))).toBe(false);
    expect(w.node(other.id).claimed_by).toBeNull();
  });

  it("refuses a node an agent run holds, including one on its way out", async () => {
    const node = await w.create(directives("hang"));
    await w.runStarted(node.id);
    const res = await aopOn(w, ["steer", node.id]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("agent run");
    expect(w.node(node.id).claimed_by).toBe("agent");
  });

  it("passes on the session's exit code, and the commands are the human's, not the session's", async () => {
    const node = await w.create("", { stage: "pr_review", type: "dev" });
    useCommands(session("in.json", 7));
    expect((await aopOn(w, ["steer", node.id])).code).toBe(7);
    const { run } = seenBy("in.json");
    // Run in the session, even after its claim is released, they don't send its run ID, so aren't refused.
    const inSession = { node: node.id, env: { AOP_RUN_ID: run } };
    expect((await aopOn(w, ["release", node.id], inSession)).code).toBe(0);
    const added = await aopOn(w, ["project", "add", w.home], inSession);
    expect(added.stderr).toBe("");
    expect(added.code).toBe(0);
  });

  it("a human claim keeps agents off, and releasing lets them on", async () => {
    useCommands(session("in.json"));
    const node = await parked(w);
    await aopOn(w, ["steer", node.id]);
    await w.call("POST", `/nodes/${node.id}/move`, { stage: "implement", type: "hotfix" });
    await settle(1_000);
    expect(w.runs(node.id)).toEqual([]);
    writeFileSync(join(w.home, "config.yaml"), `agent_session_command: ${JSON.stringify(fakeCommand)}\nstages: ./stages.yaml\n`);
    await w.call("PATCH", `/nodes/${node.id}`, { body: directives(toolCall("next", { outcome: "fixed" })) });
    await w.call("POST", `/nodes/${node.id}/release`);
    await w.atStage(node.id, "done");
  });
});
