import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EdgeRow, EventView, LinkRow, MessageRow } from "../../src/shared/api.js";
import { directives, fakeCommand, nodeArgs, world, type World } from "./agents.helpers.js";

const TIMEOUT = { timeout: 90_000 };
let w: World;

beforeEach(async () => {
  // A one-line script as the interactive session, so `steer` launches no agent tool.
  w = await world({ config: `out_of_sandbox_command: ${JSON.stringify(fakeCommand + " --out")}\n` });
});
afterEach(async () => {
  await w.close();
});

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** The real CLI, in its own process, as an agent on a node would run it. */
function aop(args: string[], options: { node?: string; env?: Record<string, string> } = {}): Promise<Result> {
  const { AOP_NODE_ID: _unused, ...env } = process.env;
  const child = spawn(process.execPath, [...nodeArgs("src/cli/main.ts"), ...args], {
    env: { ...env, AOP_URL: w.url, ...(options.node ? { AOP_NODE_ID: options.node } : {}), ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((done) => child.once("close", (code) => done({ code, stdout, stderr })));
}

const parked = (extra: Record<string, unknown> = {}) => w.create("", { type: "dev", stage: "pr_review", ...extra });
const eventsOf = async (id: string) => (await w.call<EventView[]>("GET", `/nodes/${id}/events`)).body;

describe("the agent commands", () => {
  it("context prints the node's place in the tree, its messages, links and outcomes", TIMEOUT, async () => {
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

  it("next, ask and split need a node from the environment", TIMEOUT, async () => {
    for (const args of [["next", "x"], ["ask", "x"], ["split", "start"], ["split", "finish"], ["context"]]) {
      const res = await aop(args);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain("AOP_NODE_ID");
    }
  });

  it("agent commands are refused on human stages", TIMEOUT, async () => {
    const node = await parked();
    const res = await aop(["next", "merged"], { node: node.id });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("human turn");
    expect(w.node(node.id).stage).toBe("pr_review");
    expect((await aop(["ask", "?"], { node: node.id })).code).toBe(1);
  });

  it("an unavailable outcome lists the ones that are", TIMEOUT, async () => {
    const node = await w.create(directives("hang"));
    await w.runStarted(node.id);
    const res = await aop(["next", "nonsense"], { node: node.id });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("fixed");
  });

  it("everything it writes says actor agent", TIMEOUT, async () => {
    const node = await parked();
    const other = await parked();
    await aop(["message", "from the agent"], { node: node.id });
    await aop(["message", "to another", "--node", other.id], { node: node.id });
    await aop(["link", "pr", "https://example.com/pr"], { node: node.id });
    await aop(["link", "ticket", "https://example.com/ticket"], { node: node.id });
    await aop(["node", "edit", "--title", "New title", "--body", "New body"], { node: node.id });
    await aop(["node", "edit", other.id, "--title", "Other title"], { node: node.id });
    await aop(["edge", "add", "blocks", node.id, other.id], { node: node.id });
    await aop(["edge", "remove", "blocks", node.id, other.id], { node: node.id });

    expect(w.node(node.id)).toMatchObject({ title: "New title", body: "New body" });
    expect(w.node(other.id).title).toBe("Other title");
    const messages = (await w.call<MessageRow[]>("GET", `/nodes/${other.id}/messages`)).body;
    expect(messages.map((m) => [m.author, m.body])).toEqual([["agent", "to another"]]);
    const links = (await w.call<LinkRow[]>("GET", `/nodes/${node.id}/links`)).body;
    expect(links.map((l) => l.kind)).toEqual(["pr", "ticket"]);
    expect((await w.call<EdgeRow[]>("GET", `/nodes/${node.id}/edges`)).body).toEqual([]);

    const written = (await eventsOf(node.id)).filter((event) => event.kind !== "node_created");
    expect(written.map((event) => event.kind)).toEqual(
      expect.arrayContaining(["message_added", "link_added", "title_edited", "description_edited", "edge_added", "edge_removed"]),
    );
    expect(new Set(written.map((event) => event.actor))).toEqual(new Set(["agent"]));
  });

  it("node create goes in the session's project, with a parent, type and stage", TIMEOUT, async () => {
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

  it("a new child can't start before its parent holds it", TIMEOUT, async () => {
    const parent = await w.create(directives('ifnot Stage: splitting :: aop ["split","start"]', "hang"), { type: "triage", stage: "split_approved" });
    await w.atStage(parent.id, "splitting");
    const made = await aop(["node", "create", "--title", "Held", "--type", "hotfix", "--parent", parent.id]);
    const id = /^Created (\S+)/.exec(made.stdout)?.[1] as string;
    await new Promise((done) => setTimeout(done, 1_500));
    expect(w.runs(id)).toEqual([]);
  });

  it("bad usage is a clear message and exit code 2, with no stack trace", TIMEOUT, async () => {
    const bad = [["next"], ["node", "create"], ["edge", "add", "subtask", "a", "b"], ["link", "x", "y"], ["nonsense"], ["next", "--bad"], ["search"], ["ps", "x"], ["reap", "--bad"]];
    for (const args of bad) {
      const res = await aop(args, { node: "n" });
      expect(res.code, args.join(" ")).toBe(2);
      expect(res.stderr).not.toContain("    at ");
    }
    // Usage comes before the node, so it's the usage that's reported without one.
    for (const args of [["next"], ["ask", "a", "b"], ["split", "sideways"]]) {
      const res = await aop(args);
      expect(res.code, args.join(" ")).toBe(2);
      expect(res.stderr).toContain("Usage: aop ");
    }
  });

  it("a usage error shows that command's usage, as the help lists it", TIMEOUT, async () => {
    const help = (await aop(["help"])).stdout;
    const option = await aop(["next", "--bad"], { node: "n" });
    expect(option.stderr).toContain("--bad");
    expect(option.stderr).toContain("Usage: aop next <outcome>");
    const edge = await aop(["edge", "add"]);
    expect(edge.stderr).toBe("Usage: aop edge add blocks <from> <to>\n       aop edge remove blocks <from> <to>\n");
    for (const line of ["aop next <outcome>", "aop edge add blocks <from> <to>", "aop edge remove blocks <from> <to>", "aop ps"]) {
      expect(help).toContain(`\n  ${line}\n`);
    }
  });

  it("says when the server can't be reached", TIMEOUT, async () => {
    const res = await aop(["context", "x"], { env: { AOP_URL: "http://127.0.0.1:1" } });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("aop serve");
    expect(res.stderr).not.toContain("    at ");
  });

  it("says when what answers isn't the API, and when an error isn't the API's", TIMEOUT, async () => {
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
  it("project add registers a path", TIMEOUT, async () => {
    const res = await aop(["project", "add", w.home]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Added project");
    expect((await aop(["project", "add", join(w.home, "nope")])).code).toBe(1);
  });

  it("ps and reap talk to the server", TIMEOUT, async () => {
    expect((await aop(["ps"])).stdout).toContain("No agents running");
    const node = await w.create(directives("hang"), { title: "Listed" });
    const run = await w.runStarted(node.id);
    const listed = await aop(["ps"]);
    for (const text of [run.id, node.id, "Listed", "running", String(run.pid)]) expect(listed.stdout).toContain(text);
    expect((await aop(["reap"])).stdout).toContain("Nothing to reap");
    expect(w.runs(node.id)[0]?.status).toBe("running");
  });

  describe("steer", () => {
    /** Writes what the session was given, and exits. Stands in for the interactive tool, and never is one. */
    const session = (name: string, code = 0) =>
      `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({cwd: process.cwd(), node: process.env.AOP_NODE_ID, url: process.env.AOP_URL, args: process.argv.slice(2)})); process.exit(${code})" "${w.file(name)}"`;

    const useCommands = (agent: string, out?: string) =>
      writeFileSync(
        join(w.home, "config.yaml"),
        [`agent_session_command: ${JSON.stringify(agent)}`, ...(out ? [`out_of_sandbox_command: ${JSON.stringify(out)}`] : []), "stages: ./stages.yaml", ""].join("\n"),
      );

    it("claims for the human and runs agent_session_command in the start folder, with no flags", TIMEOUT, async () => {
      const node = await parked();
      useCommands(session("in.json"));
      const res = await aop(["steer", node.id]);
      expect(res.code).toBe(0);
      expect(w.node(node.id).claimed_by).toBe("human");
      const seen = JSON.parse(readFileSync(w.file("in.json"), "utf8")) as { cwd: string; node: string; url: string; args: string[] };
      expect(seen.cwd.toLowerCase()).toBe(w.repo.toLowerCase());
      expect(seen.node).toBe(node.id);
      expect(seen.url).toBe(w.url);
      expect(seen.args).toEqual([]);

      // Reopening a session you hold is fine, and the claim survives its end.
      expect((await aop(["steer", node.id])).code).toBe(0);
      expect(w.node(node.id).claimed_by).toBe("human");
    });

    it("--no-sandbox runs out_of_sandbox_command, and errors clearly if it isn't set", TIMEOUT, async () => {
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

    it("refuses a node an agent run holds, including one on its way out", TIMEOUT, async () => {
      const node = await w.create(directives("hang"));
      await w.runStarted(node.id);
      const res = await aop(["steer", node.id]);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain("agent run");
      expect(w.node(node.id).claimed_by).toBe("agent");
    });

    it("passes on the session's exit code, and a steered session's commands work", TIMEOUT, async () => {
      const node = await w.create("", { stage: "pr_review", type: "dev" });
      useCommands(session("in.json", 7));
      expect((await aop(["steer", node.id])).code).toBe(7);
      // Human stages can only be passed from the UI, even in a steered session.
      const refused = await aop(["next", "merged"], { node: node.id });
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("human turn");
    });

    it("a human claim keeps agents off, and releasing lets them on", TIMEOUT, async () => {
      useCommands(session("in.json"));
      const node = await parked();
      await aop(["steer", node.id]);
      await w.call("POST", `/nodes/${node.id}/move`, { stage: "implement", type: "hotfix" });
      await new Promise((done) => setTimeout(done, 1_000));
      expect(w.runs(node.id)).toEqual([]);
      writeFileSync(join(w.home, "config.yaml"), `agent_session_command: ${JSON.stringify(fakeCommand)}\nstages: ./stages.yaml\n`);
      await w.call("PATCH", `/nodes/${node.id}`, { body: directives('aop ["next","fixed"]') });
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
