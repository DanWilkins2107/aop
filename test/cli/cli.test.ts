import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { EdgeRow, EventView, LinkRow, MessageRow } from "../../src/shared/api.js";
import { directives, fakeCommand, settle, toolCall, until, world, type World } from "../server/agents.helpers.js";
import { makeRepo } from "../server/helpers.js";
import { aopInProcess } from "./cli.helpers.js";

let w: World;

beforeEach(async () => {
  // A one-line script as the interactive session, so `steer` launches no agent tool.
  w = await world({ config: `out_of_sandbox_command: ${JSON.stringify(fakeCommand + " --out")}\n` });
});

/** The CLI in-process, as an agent on a node would run it. `cli.smoke.test.ts` runs the real entry point. */
const aop = (args: string[], options: { node?: string; env?: Record<string, string> } = {}) =>
  aopInProcess(args, { AOP_URL: w.url, ...(options.node ? { AOP_NODE_ID: options.node } : {}), ...options.env });

const parked = (extra: Record<string, unknown> = {}) => w.create("", { type: "dev", stage: "pr_review", ...extra });
const eventsOf = async (id: string) => (await w.call<EventView[]>("GET", `/nodes/${id}/events`)).body;

describe("the agent commands", () => {
  it("context prints the node's place in the tree, its messages, links and outcomes", async () => {
    const parent = await parked({ title: "The parent" });
    const node = await parked({ title: "The child", parent_id: parent.id, body: "The description" });
    const sibling = await parked({ title: "The sibling", parent_id: parent.id });
    const blocker = await parked({ title: "The blocker" });
    await w.call("POST", `/nodes/${blocker.id}/edges`, { target_id: node.id, kind: "blocks" });
    await w.call("POST", `/nodes/${node.id}/messages`, { body: "A human message" });
    await w.call("POST", `/nodes/${node.id}/links`, { kind: "pr", url: "https://example.com/1" });

    const fromEnv = await aop(["context"], { node: node.id });
    expect(fromEnv.code).toBe(0);
    for (const text of [node.id, "The child", "The parent", "The sibling", "The blocker", "The description", "A human message", "https://example.com/1", "Type: dev", "Stage: pr_review"]) {
      expect(fromEnv.stdout).toContain(text);
    }
    expect(sibling.id).toBeTruthy();
    expect((await aop(["context", node.id])).stdout).toBe(fromEnv.stdout);
  });

  it("split needs a node from the environment", async () => {
    for (const args of [["split", "start"], ["split", "finish"], ["context"]]) {
      const res = await aop(args);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain("AOP_NODE_ID");
    }
  });

  it("agent commands are refused on human stages", async () => {
    const node = await parked();
    const res = await aop(["split", "start"], { node: node.id });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("not an agent stage");
    expect(w.node(node.id).stage).toBe("pr_review");
  });

  it("everything it writes says actor agent", async () => {
    const node = await parked();
    const other = await parked();
    await aop(["link", "pr", "https://example.com/pr"], { node: node.id });
    await aop(["link", "ticket", "https://example.com/ticket"], { node: node.id });
    await aop(["edge", "add", "blocks", node.id, other.id], { node: node.id });
    await aop(["edge", "remove", "blocks", node.id, other.id], { node: node.id });

    const links = (await w.call<LinkRow[]>("GET", `/nodes/${node.id}/links`)).body;
    expect(links.map((l) => l.kind)).toEqual(["pr", "ticket"]);
    expect((await w.call<EdgeRow[]>("GET", `/nodes/${node.id}/edges`)).body).toEqual([]);

    const written = (await eventsOf(node.id)).filter((event) => event.kind !== "node_created");
    expect(written.map((event) => event.kind)).toEqual(
      expect.arrayContaining(["link_added", "edge_added", "edge_removed"]),
    );
    expect(new Set(written.map((event) => event.actor))).toEqual(new Set(["agent"]));
  });

  it("node create goes in the session's project, with a parent, type and stage", async () => {
    const parent = await parked();
    const made = await aop(["node", "create", "--title", "A child", "--body", "b", "--parent", parent.id, "--type", "dev", "--stage", "pr_review"], {
      node: parent.id,
    });
    expect(made.code).toBe(0);
    const id = /^Created (\S+) at pr_review/.exec(made.stdout)?.[1] as string;
    expect(w.node(id)).toMatchObject({ title: "A child", body: "b", type: "dev", stage: "pr_review", project_id: w.projectId });
    expect((await eventsOf(id))[0]).toMatchObject({ actor: "agent", kind: "node_created" });
    const edges = (await w.call<EdgeRow[]>("GET", `/nodes/${id}/edges`)).body;
    expect(edges).toMatchObject([{ source_id: parent.id, target_id: id, kind: "subtask" }]);

    const bare = await aop(["node", "create", "--title", "x"]);
    expect(bare.code).toBe(1);
    expect(bare.stderr).toContain("--project");
    const named = await aop(["node", "create", "--title", "x", "--project", w.projectId, "--stage", "pr_review"]);
    expect(named.code).toBe(0);
  });

  it("node create's --project takes a name", async () => {
    const added = await aop(["project", "add", makeRepo()]);
    const otherName = /^Added project "(.+)"/.exec(added.stdout)?.[1] as string;
    const there = await aop(["node", "create", "--title", "Elsewhere", "--project", otherName, "--stage", "pr_review"]);
    expect(there.code).toBe(0);

    const unknown = await aop(["node", "create", "--title", "x", "--project", "no-such-project"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('No project "no-such-project"');
  });

  it("edge remove says when there's no such edge", async () => {
    const [a, b] = [await parked(), await parked()];
    const res = await aop(["edge", "remove", "blocks", a.id, b.id]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(`${a.id} doesn't block ${b.id}`);
  });

  it("a new child can't start before its parent holds it", async () => {
    const parent = await w.create(directives('ifnot Stage: splitting :: aop ["split","start"]', "hang"), { type: "triage", stage: "split_approved" });
    await w.atStage(parent.id, "splitting");
    const made = await aop(["node", "create", "--title", "Held", "--type", "hotfix", "--parent", parent.id]);
    const id = /^Created (\S+)/.exec(made.stdout)?.[1] as string;
    await settle();
    expect(w.runs(id)).toEqual([]);
  });

  it("bad usage is a clear message and exit code 2, with no stack trace", async () => {
    const bad = [["logs"], ["node", "create"], ["edge", "add", "subtask", "a", "b"], ["link", "x", "y"], ["nonsense"], ["logs", "x", "--bad"],["ps", "x"], ["reap", "--bad"]];
    for (const args of bad) {
      const res = await aop(args, { node: "n" });
      expect(res.code, args.join(" ")).toBe(2);
      expect(res.stderr).not.toContain("    at ");
    }
    // Usage comes before the node, so it's the usage that's reported without one.
    for (const args of [["logs"], ["logs", "a", "b"], ["split", "sideways"]]) {
      const res = await aop(args);
      expect(res.code, args.join(" ")).toBe(2);
      expect(res.stderr).toContain("Usage: aop ");
    }
  });

  it("a usage error shows that command's usage, as the help lists it", async () => {
    const help = (await aop(["help"])).stdout;
    const option = await aop(["logs", "x", "--bad"], { node: "n" });
    expect(option.stderr).toContain("--bad");
    expect(option.stderr).toContain("Usage: aop logs <node> [--lines N]");
    const edge = await aop(["edge", "add"]);
    expect(edge.stderr).toBe("Usage: aop edge add blocks <from> <to>\n       aop edge remove blocks <from> <to>\n");
    for (const line of ["aop logs <node> [--lines N]", "aop edge add blocks <from> <to>", "aop edge remove blocks <from> <to>", "aop ps"]) {
      expect(help).toContain(`\n  ${line}\n`);
    }
  });

  it("says when the server can't be reached", async () => {
    const res = await aop(["context", "x"], { env: { AOP_URL: "http://127.0.0.1:1" } });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("aop serve");
    expect(res.stderr).not.toContain("    at ");
  });

  it("says when what answers isn't the API, and when an error isn't the API's", async () => {
    // Stands in for something else on the port, such as the UI's dev server, which answers every path with a page.
    const stub = (status: number, type: string, body: string) =>
      new Promise<Server>((done) => {
        const server = createServer((_req, res) => res.writeHead(status, { "content-type": type }).end(body));
        server.listen(0, "127.0.0.1", () => done(server));
      });
    const urlOf = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const page = await stub(200, "text/html", "<!doctype html><title>Not AOP</title>");
    const badJson = await stub(200, "application/json", "{not json");
    const oddError = await stub(500, "application/json", JSON.stringify({ error: "a string, not the API's shape" }));
    try {
      for (const [server, args] of [[page, ["context", "x"]], [page, ["ps"]], [page, ["node", "create", "--title", "x", "--project", "p"]], [badJson, ["ps"]]] as const) {
        const res = await aop([...args], { env: { AOP_URL: urlOf(server) } });
        expect(res.code, args.join(" ")).toBe(1);
        expect(res.stderr).toContain("isn't the AOP server's API");
        expect(res.stderr).not.toContain("    at ");
      }
      const odd = await aop(["ps"], { env: { AOP_URL: urlOf(oddError) } });
      expect(odd.code).toBe(1);
      expect(odd.stderr).toBe("The server answered 500\n");
    } finally {
      for (const server of [page, badJson, oddError]) server.close();
    }
  });
});

describe("the human commands", () => {
  it("project add registers a path", async () => {
    const res = await aop(["project", "add", w.home]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Added project");
    expect((await aop(["project", "add", join(w.home, "nope")])).code).toBe(1);
  });

  it("ps and reap talk to the server", async () => {
    expect((await aop(["ps"])).stdout).toContain("No agents running");
    const node = await w.create(directives("hang"), { title: "Listed" });
    const run = await w.runStarted(node.id);
    const listed = await aop(["ps"]);
    for (const text of [run.id, node.id, "Listed", "running", String(run.pid)]) expect(listed.stdout).toContain(text);
    expect((await aop(["reap"])).stdout).toContain("Nothing to reap");
    expect(w.runs(node.id)[0]?.status).toBe("running");
  });

  it("stop leaves the node on its stage, claimed by the human, and release lets the agent start again", async () => {
    const node = await w.create(directives("hang"));
    const run = await w.runStarted(node.id);
    // The human commands name their node, and never act on the session's.
    const fromEnv = await aop(["stop"], { node: node.id });
    expect(fromEnv.code).toBe(2);
    expect(w.runs(node.id)[0]?.status).toBe("running");

    const stopped = await aop(["stop", node.id]);
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toContain(run.id);
    expect(w.node(node.id)).toMatchObject({ stage: "implement", claimed_by: "human" });
    expect(w.runs(node.id)[0]).toMatchObject({ end_reason: "stopped", status: "exited" });

    const again = await aop(["stop", node.id]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("No agent is running");

    await settle();
    expect(w.runs(node.id)).toHaveLength(1);
    const released = await aop(["release", node.id]);
    expect(released.code).toBe(0);
    expect(released.stdout).toContain(`Released ${node.id}`);
    await w.runStarted(node.id, 2);
  });

  it("release only releases a human claim, and says why not", async () => {
    const unclaimed = await parked();
    const res = await aop(["release", unclaimed.id]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("isn't claimed");

    const node = await w.create(directives("hang"));
    await w.runStarted(node.id);
    const held = await aop(["release", node.id]);
    expect(held.code).toBe(1);
    expect(held.stderr).toContain("belongs to");
    expect(w.node(node.id).claimed_by).toBe("agent");
    expect((await aop(["release"], { node: node.id })).code).toBe(2);
  });

  it("logs prints the end of the latest run's log", async () => {
    const fresh = await parked();
    const none = await aop(["logs", fresh.id]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("no runs yet");

    const node = await w.create(directives(...Array.from({ length: 60 }, (_, i) => `say line ${i + 1}`), "hang"));
    await w.runStarted(node.id);
    await until("the log is written", () => (readFileSync(w.runs(node.id)[0]!.log_path, "utf8").includes("line 60") ? true : null));

    const defaults = await aop(["logs", node.id]);
    expect(defaults.code).toBe(0);
    expect(defaults.stdout).toContain("line 60");
    expect(defaults.stdout).toContain("line 11\n");
    expect(defaults.stdout).not.toContain("line 10\n");

    const three = await aop(["logs", node.id, "--lines", "3"]);
    expect(three.stdout.trimEnd().split(/\r?\n/)).toEqual(["line 58", "line 59", "line 60"]);

    for (const bad of ["0", "-2", "x", "1.5"]) {
      const res = await aop(["logs", node.id, "--lines", bad]);
      expect(res.code).toBe(2);
      expect(res.stderr).toContain("--lines");
    }
    expect((await aop(["logs"], { node: node.id })).code).toBe(2);
  });

  it("the plugin's skills never tell agents about the human commands", () => {
    for (const skill of ["aop-context", "aop-rulebook", "aop-brevity"]) {
      const text = readFileSync(join("plugin", "skills", skill, "SKILL.md"), "utf8");
      for (const command of ["aop stop", "aop release", "aop logs"]) expect(text).not.toContain(command);
    }
  });

  describe("steer", () => {
    /** Writes what the session was given, and exits. Stands in for the interactive tool, and never is one. */
    const session = (name: string, code = 0) =>
      `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({cwd: process.cwd(), node: process.env.AOP_NODE_ID, url: process.env.AOP_URL, run: process.env.AOP_RUN_ID, args: process.argv.slice(2)})); process.exit(${code})" "${w.file(name)}"`;

    const useCommands = (agent: string, out?: string) =>
      writeFileSync(
        join(w.home, "config.yaml"),
        [`agent_session_command: ${JSON.stringify(agent)}`, ...(out ? [`out_of_sandbox_command: ${JSON.stringify(out)}`] : []), "stages: ./stages.yaml", ""].join("\n"),
      );

    it("claims for the human and runs agent_session_command in the start folder, with no flags", async () => {
      const node = await parked();
      useCommands(session("in.json"));
      const res = await aop(["steer", node.id]);
      expect(res.code).toBe(0);
      expect(w.node(node.id).claimed_by).toBe("human");
      const seen = JSON.parse(readFileSync(w.file("in.json"), "utf8")) as { cwd: string; node: string; url: string; run: string; args: string[] };
      expect(seen.cwd.toLowerCase()).toBe(w.repo.toLowerCase());
      expect(seen.node).toBe(node.id);
      expect(seen.url).toBe(w.url);
      expect(seen.args).toEqual([]);
      // The session's own run ID, tied to the claim, printed for the human to pass on.
      const steerRow = w.db.prepare("SELECT id FROM steer_sessions WHERE node_id = ? AND ended_at IS NULL").get(node.id) as { id: string };
      expect(seen.run).toBe(steerRow.id);
      expect(res.stdout).toContain(steerRow.id);

      // Reopening a session you hold is fine, keeps its run ID, and the claim survives its end.
      expect((await aop(["steer", node.id])).code).toBe(0);
      expect(w.node(node.id).claimed_by).toBe("human");
      expect((JSON.parse(readFileSync(w.file("in.json"), "utf8")) as { run: string }).run).toBe(steerRow.id);
    });

    it("--no-sandbox runs out_of_sandbox_command, and errors clearly if it isn't set", async () => {
      const node = await parked();
      useCommands(session("in.json", 1), session("out.json"));
      expect((await aop(["steer", node.id, "--no-sandbox"])).code).toBe(0);
      expect(existsSync(w.file("out.json"))).toBe(true);
      expect(existsSync(w.file("in.json"))).toBe(false);
      expect(readFileSync(w.file("out.json"), "utf8")).toContain(node.id);

      const other = await parked();
      useCommands(session("in.json"));
      const res = await aop(["steer", other.id, "--no-sandbox"]);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain("out_of_sandbox_command");
      expect(existsSync(w.file("in.json"))).toBe(false);
      expect(w.node(other.id).claimed_by).toBeNull();
    });

    it("refuses a node an agent run holds, including one on its way out", async () => {
      const node = await w.create(directives("hang"));
      await w.runStarted(node.id);
      const res = await aop(["steer", node.id]);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain("agent run");
      expect(w.node(node.id).claimed_by).toBe("agent");
    });

    it("passes on the session's exit code, and a steered session's commands work", async () => {
      const node = await w.create("", { stage: "pr_review", type: "dev" });
      useCommands(session("in.json", 7));
      expect((await aop(["steer", node.id])).code).toBe(7);
      // Human stages can only be passed from the UI, even in a steered session.
      const refused = await aop(["split", "start"], { node: node.id });
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("not an agent stage");
    });

    it("a human claim keeps agents off, and releasing lets them on", async () => {
      useCommands(session("in.json"));
      const node = await parked();
      await aop(["steer", node.id]);
      await w.call("POST", `/nodes/${node.id}/move`, { stage: "implement", type: "hotfix" });
      await settle(1_000);
      expect(w.runs(node.id)).toEqual([]);
      writeFileSync(join(w.home, "config.yaml"), `agent_session_command: ${JSON.stringify(fakeCommand)}\nstages: ./stages.yaml\n`);
      await w.call("PATCH", `/nodes/${node.id}`, { body: directives(toolCall("next", { outcome: "fixed" })) });
      await w.call("POST", `/nodes/${node.id}/release`);
      await w.atStage(node.id, "done");
    });
  });
});

describe("the bin entry", () => {
  it("points at a built file", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { bin: Record<string, string> };
    expect(pkg.bin).toEqual({ aop: "dist/cli/main.js" });
    expect(readFileSync("src/cli/main.ts", "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  });
});
