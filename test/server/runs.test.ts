import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentToolFor, HEADLESS_AGENT_FLAGS, readableLines, StreamJsonUsage } from "../../src/server/agentOutput.js";
import { aopHome } from "../../src/server/paths.js";
import type { LogTail, RunView } from "../../src/shared/api.js";
import { directives, until, world, type World } from "./agents.helpers.js";

const TIMEOUT = { timeout: 90_000 };

describe("which tool a command runs", () => {
  it("reads Claude Code from the program's name, wrappers included", () => {
    expect(agentToolFor("claude")).toBe("claude");
    expect(agentToolFor("sandboxed-claude")).toBe("claude");
    expect(agentToolFor("/usr/local/bin/claude --model opus")).toBe("claude");
    expect(agentToolFor('"C:\\Program Files\\Claude\\claude.exe"')).toBe("claude");
    expect(agentToolFor("FOO=1 npx claude")).toBe("claude");
    expect(agentToolFor('node "C:\\tools\\fake-claude.mjs"')).toBe("claude");
  });

  it("never from arguments or folders, and anything else gets plain -p", () => {
    expect(agentToolFor("copilot --model claude-sonnet-4")).toBe("other");
    expect(agentToolFor('node "C:\\Users\\me\\.claude\\worktrees\\x\\fake-agent.mjs"')).toBe("other");
    expect(agentToolFor("codex")).toBe("other");
    expect(agentToolFor("")).toBe("other");
    expect(HEADLESS_AGENT_FLAGS.other).toBe("-p");
    expect(HEADLESS_AGENT_FLAGS.claude).toBe("-p --output-format stream-json --verbose");
  });
});

const assistant = (id: string, usage: Record<string, number>, content: unknown[], parent: string | null = null) =>
  JSON.stringify({ type: "assistant", message: { id, role: "assistant", content, usage }, parent_tool_use_id: parent, session_id: "s" });

describe("reading stream-json", () => {
  it("takes context from the latest main turn, ignoring subagents, and counts output once per message", () => {
    const usage = new StreamJsonUsage();
    const turn1 = { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 30 };
    const turn2 = { input_tokens: 2, cache_read_input_tokens: 1500, cache_creation_input_tokens: 10, output_tokens: 12 };
    const text = [
      assistant("m1", turn1, [{ type: "text", text: "hi" }]),
      assistant("m1", turn1, [{ type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } }]),
      assistant("m2", turn2, [{ type: "text", text: "done" }]),
      assistant("sub", { input_tokens: 1, cache_read_input_tokens: 99_000, output_tokens: 5 }, [{ type: "text", text: "x" }], "t"),
    ].join("\n");
    // Split mid-line, as output arrives.
    usage.write(text.slice(0, 40));
    usage.write(`${text.slice(40)}\n`);
    expect(usage.usage).toEqual({ context: 1512, output: 42 });

    usage.write(`${JSON.stringify({ type: "result", subtype: "success", result: "ok", usage: { output_tokens: 50 } })}\n`);
    expect(usage.usage).toEqual({ context: 1512, output: 50 });
  });

  it("has nothing to say about output that isn't stream-json", () => {
    const usage = new StreamJsonUsage();
    expect(usage.write("plain text\n{not json}\n")).toBe(false);
    expect(usage.usage).toEqual({ context: null, output: null });
  });

  it("turns events into readable lines: text, tool calls in brief, errors and the result", () => {
    const lines = [
      "[aop] run r on node n",
      JSON.stringify({ type: "system", subtype: "init", model: "claude-x" }),
      assistant("m1", {}, [{ type: "text", text: "Looking.\n\nAt the code." }]),
      assistant("m1", {}, [{ type: "tool_use", id: "t", name: "Bash", input: { command: "npm test", description: "Run tests" } }]),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "big output", is_error: false }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "boom", is_error: true }] } }),
      assistant("s", {}, [{ type: "text", text: "subagent chatter" }, { type: "tool_use", name: "Read", input: { file_path: "a.ts" } }], "t"),
      JSON.stringify({ type: "stream_event", event: {} }),
      JSON.stringify({ type: "result", subtype: "success", result: "All done." }),
      JSON.stringify({ type: "result", subtype: "error_max_turns", errors: ["too many"] }),
    ];
    expect(readableLines(lines, "stream-json")).toEqual([
      "[aop] run r on node n",
      "Session started, claude-x",
      "Looking.",
      "At the code.",
      "→ Bash: npm test",
      "✗ boom",
      "  → Read: a.ts",
      "Result:",
      "All done.",
      "Ended: error_max_turns, too many",
    ]);
    expect(readableLines(["one", "", "two\r"], "text")).toEqual(["one", "two"]);
  });
});

// world() closes itself when each test finishes.
let w: World | undefined;

const runsOf = async (nodeId: string) => (await w!.call<RunView[]>("GET", `/nodes/${nodeId}/runs`)).body;
const tailOf = (runId: string, query = "") => w!.call<LogTail>("GET", `/runs/${runId}/tail${query}`);

/** `until`, for a check that has to ask the server. */
async function eventually<T>(what: string, check: () => Promise<T | null | false>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

describe("runs on a node", () => {
  it("Claude Code gets stream-json, and its runs show context consumed and a readable tail", TIMEOUT, async () => {
    w = await world({ claude: true });
    const node = await w.create(
      directives(`record ${w.file("r.json")}`, "say Reading the code.", "subagent busy elsewhere", "usage 7 30000 500 90", "say Fixed it.", 'aop ["next","fixed"]'),
    );
    await w.atStage(node.id, "done");
    const seen = JSON.parse(readFileSync(w.file("r.json"), "utf8")) as { argv: string[] };
    expect(seen.argv).toEqual(HEADLESS_AGENT_FLAGS.claude.split(" "));

    const [run] = await w.runsEnded(node.id);
    expect(run).toMatchObject({ output_format: "stream-json" });
    // The aop call is the latest main turn, with the usage set before it. The subagent's is ignored.
    const runs = await eventually("usage to be recorded", async () => {
      const found = await runsOf(node.id);
      return found[0]?.output_tokens === 41 + 90 + 90 ? found : null;
    });
    expect(runs).toEqual([
      expect.objectContaining({ id: run!.id, stage: "implement", ending: "exited", context_tokens: 7 + 30000 + 500, output_tokens: 221 }),
    ]);
    expect(runs[0]?.ended_at).not.toBeNull();

    const tail = await tailOf(run!.id);
    expect(tail.status).toBe(200);
    expect(tail.body.running).toBe(false);
    expect(tail.body.lines).toEqual(
      expect.arrayContaining(["Session started, claude-fake-1", "Reading the code.", "Fixed it.", "Running aop next.", "Result:"]),
    );
    expect(tail.body.lines.some((line) => line.startsWith('→ Bash: aop "next" "fixed"'))).toBe(true);
    expect(tail.body.lines.join("\n")).not.toContain("busy elsewhere");
    expect(tail.body.lines.every((line) => !line.startsWith("{"))).toBe(true);
    // The log itself keeps the raw stream.
    expect((await w.call<string>("GET", `/runs/${run!.id}/log`)).body).toContain('"type":"result"');
  });

  it("other tools get plain -p, no usage, and their own lines, newest run first", TIMEOUT, async () => {
    w = await world();
    const lines = Array.from({ length: 30 }, (_, i) => `say line ${i + 1}`);
    const node = await w.create(directives(...lines, "exit 1"));
    await w.atStage(node.id, "failed");
    const [first] = await w.runsEnded(node.id);
    await w.call("POST", `/nodes/${node.id}/retry`);
    await until("a second run", () => w!.runs(node.id).length === 2);
    await w.runsEnded(node.id, 2);

    const runs = await runsOf(node.id);
    expect(runs.map((run) => run.ending)).toEqual(["failed", "failed"]);
    expect(runs[1]?.id).toBe(first!.id);
    expect(runs[0]).toMatchObject({ context_tokens: null, output_tokens: null });

    const tail = await eventually("the log to close", async () => {
      const found = (await tailOf(first!.id)).body;
      return found.lines.at(-1)?.startsWith("[aop] exited") ? found : null;
    });
    expect(tail.lines).toHaveLength(20);
    expect(tail.lines.slice(0, 2)).toEqual(["line 12", "line 13"]);
    expect((await tailOf(first!.id, "?lines=3")).body.lines).toEqual(["line 29", "line 30", "[aop] exited, code 1"]);
    expect((await tailOf(first!.id, "?lines=0")).status).toBe(400);
  });

  it("a running run's tail says so and updates as the log grows", TIMEOUT, async () => {
    w = await world({ claude: true });
    const node = await w.create(directives("say first", "sleep 1500", "say second", "hang"));
    const run = await w.runStarted(node.id);
    const early = await eventually("the first line", async () => {
      const found = (await tailOf(run.id)).body;
      return found.lines.includes("first") ? found : null;
    });
    expect(early.running).toBe(true);
    expect(early.lines).not.toContain("second");
    await eventually("the second line", async () => (await tailOf(run.id)).body.lines.includes("second"));
    const [view] = await runsOf(node.id);
    expect(view).toMatchObject({ ending: "running", ended_at: null });
    expect(view?.context_tokens).toBeGreaterThan(0);
  });

  it("never reads a file outside AOP_HOME/logs", TIMEOUT, async () => {
    w = await world();
    const node = await w.create(directives("exit 1"));
    await w.atStage(node.id, "failed");
    const [run] = await w.runsEnded(node.id);
    const secret = join(mkdtempSync(join(aopHome(), "elsewhere-")), "secret.log");
    writeFileSync(secret, "top secret\n");
    for (const path of [secret, join(aopHome(), "logs", "..", "config.yaml"), join(aopHome(), "logs", "..", "elsewhere.log")]) {
      w.db.prepare("UPDATE runs SET log_path = ? WHERE id = ?").run(path, run!.id);
      const tail = await tailOf(run!.id);
      expect(tail.status).toBe(409);
      expect(JSON.stringify(tail.body)).not.toContain("top secret");
      expect((await w.call("GET", `/runs/${run!.id}/log`)).status).toBe(409);
    }
    expect((await w.call("GET", "/nodes/no-such-node/runs")).status).toBe(404);
    expect((await w.call("GET", "/runs/no-such-run/tail")).status).toBe(404);
  });
});
