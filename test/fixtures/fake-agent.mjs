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
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const stdin = await new Promise((done) => {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (text += chunk));
  process.stdin.on("end", () => done(text));
});

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
  const result = spawnSync(`aop ${quoted}`, { shell: true, encoding: "utf8" });
  process.stdout.write(`[fake] aop ${quoted} -> ${result.status}\n${result.stdout}${result.stderr}`);
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
