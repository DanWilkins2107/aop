// A stand-in for a real agent tool, which tests must never launch. It reads its prompt from stdin, as
// a real one does, and follows any lines there that start with "@@", from the node's description or
// the stage's prompt:
//
//   @@record <file>                JSON of the stdin, argv, cwd and AOP_* environment it was given
//   @@aop ["next","ready"]         runs the real `aop` CLI from PATH. "$NODE" is this node's ID, and
//                                  "$LAST" and "$PREV" are the last two IDs it created
//   @@sleep <ms>
//   @@hang                         never exits by itself
//   @@exit <code>
//   @@child <pidfile>              starts a long-running child and writes its process ID
//   @@grandchild <pidfile>         starts a child that starts a long-running grandchild, writes the
//                                  grandchild's process ID and exits, leaving the grandchild orphaned
//   @@pid <pidfile>                writes this process's own ID
//   @@ignore-term                  on macOS and Linux, survives SIGTERM
//   @@say <text>                   prints to stdout, which is the run's log
//   @@if <text> :: <directive>     runs the directive if the prompt contains the text, on a line
//   @@ifnot <text> :: <directive>  that isn't itself a directive. Runs it if it doesn't
//
// Given `--output-format stream-json`, as AOP passes to Claude Code, it writes what Claude Code does:
// one JSON event per line, from a `system` init event to a `result` event, with `say` as assistant
// text and `aop` as a Bash tool call and its result. Each assistant turn reports usage, which grows
// turn by turn unless set:
//
//   @@usage <input> <cache_read> <cache_creation> <output>   the usage the next turns report
//   @@subagent <text>              an assistant turn from a subagent, with its own, larger usage
//   @@raw <text>                   prints a line that isn't an event, as stderr noise would be
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const stdin = await new Promise((done) => {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (text += chunk));
  process.stdin.on("end", () => done(text));
});

const streamJson = process.argv.slice(2).join(" ").includes("--output-format stream-json");
const sessionId = "00000000-0000-4000-8000-000000000001";
let turn = 0;
let fixedUsage = null;
let lastText = "";
let outputTotal = 0;
let ids = 0;
const nextId = (prefix) => `${prefix}_fake${String(++ids).padStart(4, "0")}`;
const emit = (event) => process.stdout.write(`${JSON.stringify({ ...event, session_id: sessionId, uuid: nextId("uuid") })}\n`);

function usageForTurn() {
  turn += 1;
  const [input, cacheRead, cacheCreation, output] = fixedUsage ?? [3 + turn, 12_000 + 500 * turn, 200, 40 + turn];
  return { input_tokens: input, cache_creation_input_tokens: cacheCreation, cache_read_input_tokens: cacheRead, output_tokens: output, service_tier: "standard" };
}

/** One API turn. Claude Code streams a turn with several blocks as several events sharing a message ID and usage. */
function assistantTurn(blocks, parentToolUseId = null, usage = usageForTurn()) {
  const id = nextId("msg");
  if (parentToolUseId === null) outputTotal += usage.output_tokens;
  for (const block of blocks) {
    emit({
      type: "assistant",
      message: { id, type: "message", role: "assistant", model: "claude-fake-1", content: [block], stop_reason: null, stop_sequence: null, usage },
      parent_tool_use_id: parentToolUseId,
    });
  }
}

function toolResult(toolUseId, content, isError) {
  emit({
    type: "user",
    message: { role: "user", content: [{ tool_use_id: toolUseId, type: "tool_result", content, is_error: isError }] },
    parent_tool_use_id: null,
  });
}

function finish() {
  if (!streamJson) return;
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1234,
    duration_api_ms: 1000,
    num_turns: turn,
    result: lastText,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: { input_tokens: 3 * turn, cache_creation_input_tokens: 200, cache_read_input_tokens: 12_000 * turn, output_tokens: outputTotal },
    modelUsage: {},
    permission_denials: [],
  });
}

if (streamJson) {
  emit({ type: "system", subtype: "init", cwd: process.cwd(), tools: ["Bash", "Read"], mcp_servers: [], model: "claude-fake-1", permissionMode: "default", apiKeySource: "none" });
}

let lastCreated = "";
let previousCreated = "";
const prose = stdin
  .split(/\r?\n/)
  .filter((line) => !line.startsWith("@@"))
  .join("\n");

function runAop(args) {
  const quoted = args
    .map((arg) => arg.replaceAll("$LAST", lastCreated).replaceAll("$PREV", previousCreated).replaceAll("$NODE", process.env["AOP_NODE_ID"] ?? ""))
    .map((arg) => `"${arg.replaceAll('"', '\\"')}"`).join(" ");
  const toolUseId = nextId("toolu");
  if (streamJson) {
    assistantTurn([
      { type: "text", text: `Running aop ${args[0] ?? ""}.` },
      { type: "tool_use", id: toolUseId, name: "Bash", input: { command: `aop ${quoted}`, description: "Report to AOP" } },
    ]);
  }
  const result = spawnSync(`aop ${quoted}`, { shell: true, encoding: "utf8" });
  if (streamJson) toolResult(toolUseId, `[fake] aop ${quoted} -> ${result.status}\n${result.stdout}${result.stderr}`, result.status !== 0);
  else process.stdout.write(`[fake] aop ${quoted} -> ${result.status}\n${result.stdout}${result.stderr}`);
  const created = /^Created (\S+)/m.exec(result.stdout ?? "");
  if (created) {
    previousCreated = lastCreated;
    lastCreated = created[1];
  }
}

async function perform(directive) {
  const [, name, rest = ""] = /^(\S+)\s*(.*)$/s.exec(directive) ?? [];
  switch (name) {
    case "record":
      writeFileSync(
        rest,
        JSON.stringify({
          stdin,
          argv: process.argv.slice(2),
          cwd: process.cwd(),
          env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("AOP_"))),
        }),
      );
      return;
    case "aop":
      runAop(JSON.parse(rest));
      return;
    case "sleep":
      await new Promise((done) => setTimeout(done, Number(rest)));
      return;
    case "hang":
      setInterval(() => {}, 60_000);
      await new Promise(() => {});
      return;
    case "exit":
      finish();
      process.exit(Number(rest));
      return;
    case "child": {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" });
      child.unref();
      writeFileSync(rest, String(child.pid));
      return;
    }
    case "grandchild": {
      // A child that starts a long-running child of its own and then exits, so the grandchild's
      // parent link leads nowhere. Detached on Windows, because Node there ends a process's other
      // children when it exits, through a job object. Elsewhere it stays in the agent's group.
      const script = `const { spawn } = require("node:child_process");
        const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"],
          { stdio: "ignore", windowsHide: true, detached: process.platform === "win32" });
        grandchild.unref();
        require("node:fs").writeFileSync(${JSON.stringify(rest)}, String(grandchild.pid));`;
      spawnSync(process.execPath, ["-e", script], { stdio: "ignore" });
      return;
    }
    case "pid":
      writeFileSync(rest, String(process.pid));
      return;
    case "ignore-term":
      process.on("SIGTERM", () => {});
      return;
    case "say":
      if (streamJson) {
        lastText = rest;
        assistantTurn([{ type: "text", text: rest }]);
      } else console.log(rest);
      return;
    case "usage":
      fixedUsage = rest.split(/\s+/).map(Number);
      return;
    case "subagent":
      assistantTurn([{ type: "text", text: rest }], "toolu_subagent", {
        input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 90_000, output_tokens: 7, service_tier: "standard",
      });
      return;
    case "raw":
      console.log(rest);
      return;
    case "if":
    case "ifnot": {
      const split = rest.indexOf(" :: ");
      if (prose.includes(rest.slice(0, split)) === (name === "if")) await perform(rest.slice(split + 4));
      return;
    }
    default:
      console.log(`[fake] unknown directive: ${directive}`);
  }
}

for (const line of stdin.split(/\r?\n/)) {
  if (line.startsWith("@@")) await perform(line.slice(2));
}
finish();
