import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findOnPath, runInit, type InitIo } from "../../src/cli/init.js";
import { loadConfig } from "../../src/server/config.js";
import { aopHome } from "../../src/server/paths.js";
import { nodeArgs, ROOT } from "../server/agents.helpers.js";

const REAL_AOP = join(homedir(), ".aop");

/** What's at the real ~/.aop, to check nothing here touches it. */
function realAopSnapshot(): string {
  if (!existsSync(REAL_AOP)) return "absent";
  return readdirSync(REAL_AOP)
    .map((name) => `${name}:${statSync(join(REAL_AOP, name)).mtimeMs}`)
    .join("|");
}

let before: string;
beforeAll(() => {
  before = realAopSnapshot();
});
afterAll(() => {
  expect(realAopSnapshot()).toBe(before);
});

interface Sandbox {
  root: string;
  home: string;
  bin: string;
  code: string;
}

/** A throwaway AOP home, PATH folder and open_from folder, all under the test AOP_HOME. */
function sandbox(): Sandbox {
  const root = mkdtempSync(join(aopHome(), "init-"));
  const box = { root, home: join(root, "aop-home"), bin: join(root, "bin"), code: join(root, "code") };
  mkdirSync(box.bin);
  mkdirSync(box.code);
  return box;
}

function fakeTool(bin: string, name: string): string {
  const path = join(bin, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(path, "exit 1\n", { mode: 0o755 });
  return path;
}

function collector() {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, done) {
      text += String(chunk);
      done();
    },
  });
  return { stream, text: () => text };
}

async function init(box: Sandbox, argv: string[], answers?: string[]) {
  const out = collector();
  const err = collector();
  const io: Partial<InitIo> = {
    input: Readable.from(answers === undefined ? [] : [answers.map((a) => `${a}\n`).join("")]),
    output: out.stream,
    errors: err.stream,
    env: { AOP_HOME: box.home, PATH: box.bin, PATHEXT: ".EXE;.CMD" },
    cwd: box.root,
  };
  const code = await runInit(argv, io);
  return { code, out: out.text(), err: err.text() };
}

const flags = (box: Sandbox, ...extra: string[]) => [
  "--yes",
  "--agent-session-command",
  "sandboxed-claude --model x",
  "--open-from",
  box.code,
  ...extra,
];

describe("aop init with flags", () => {
  it("sets up a fresh home that the real loader accepts", async () => {
    const box = sandbox();
    fakeTool(box.bin, "claude");
    const result = await init(box, flags(box, "--out-of-sandbox-command", "claude", "--agent-timeout-minutes", "30"));
    expect(result.err).toBe("");
    expect(result.code).toBe(0);

    const config = loadConfig(box.home);
    expect(config.agent_session_command).toBe("sandboxed-claude --model x");
    expect(config.out_of_sandbox_command).toBe("claude");
    expect(config.openFromPath).toBe(box.code);
    expect(config.agent_timeout_minutes).toBe(30);
    expect(config.stagesPath).toBe(join(box.home, "stages.yaml"));
    expect([...config.graph.types.keys()]).toEqual(["triage", "dev", "reports"]);
    expect(readdirSync(join(box.home, "prompts")).sort()).toEqual(readdirSync(join(ROOT, "defaults", "prompts")).sort());

    const text = readFileSync(join(box.home, "config.yaml"), "utf8");
    expect(text.replace(/\r?\n# /g, " ")).toContain(
      "Required. AOP appends `-p` and sends the prompt on stdin. This is the session your agents are starting in. Strongly consider having this command start sessions inside a sandbox.",
    );
    expect(result.out).toContain("The config is valid.");
    expect(result.out).toContain(`/plugin marketplace add ${join(ROOT, "plugin")}`);
    expect(result.out).not.toContain("copilot plugin install");
    expect(result.out).toContain("aop serve");
    expect(result.out).toContain("aop project add <path>");
  });

  it("uses defaults for what the flags leave out", async () => {
    const box = sandbox();
    const result = await init(box, flags(box));
    expect(result.code).toBe(0);
    const config = loadConfig(box.home);
    expect(config.out_of_sandbox_command).toBeUndefined();
    expect(config.agent_timeout_minutes).toBe(60);
    expect(readFileSync(join(box.home, "config.yaml"), "utf8")).toContain("# out_of_sandbox_command: claude");
  });

  it("keeps commands with quotes intact", async () => {
    const box = sandbox();
    const command = `"C:\\Program Files\\node.exe" "a b.mjs" --flag: 'x' # not a comment`;
    expect((await init(box, ["--yes", "--agent-session-command", command, "--open-from", box.code])).code).toBe(0);
    expect(loadConfig(box.home).agent_session_command).toBe(command);
  });

  it("needs the agent session command with --yes", async () => {
    const box = sandbox();
    const result = await init(box, ["--yes", "--open-from", box.code]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("--agent-session-command is required");
    expect(existsSync(box.home)).toBe(false);
  });

  it("rejects a bad timeout and unknown flags", async () => {
    const box = sandbox();
    expect((await init(box, flags(box, "--agent-timeout-minutes", "0"))).code).toBe(1);
    expect((await init(box, flags(box, "--bogus"))).code).toBe(2);
    expect(existsSync(box.home)).toBe(false);
  });

  it("uses your own stages file and doesn't copy the defaults", async () => {
    const box = sandbox();
    const own = join(box.root, "process");
    mkdirSync(join(own, "prompts"), { recursive: true });
    writeFileSync(join(own, "stages.yaml"), readFileSync(join(ROOT, "defaults", "stages.yaml")));
    for (const name of readdirSync(join(ROOT, "defaults", "prompts"))) {
      writeFileSync(join(own, "prompts", name), "Do the work.");
    }
    expect((await init(box, flags(box, "--stages", "process/stages.yaml"))).code).toBe(0);
    expect(loadConfig(box.home).stagesPath).toBe(join(own, "stages.yaml"));
    expect(existsSync(join(box.home, "stages.yaml"))).toBe(false);
  });

  it("refuses a stages file with problems", async () => {
    const box = sandbox();
    writeFileSync(join(box.root, "bad.yaml"), "start: nowhere\n");
    const result = await init(box, flags(box, "--stages", "bad.yaml"));
    expect(result.code).toBe(1);
    expect(existsSync(box.home)).toBe(false);
  });
});

describe("existing config", () => {
  it("refuses to overwrite it", async () => {
    const box = sandbox();
    mkdirSync(box.home);
    writeFileSync(join(box.home, "config.yaml"), "mine: true\n");
    const result = await init(box, flags(box));
    expect(result.code).toBe(1);
    expect(result.err).toContain("already exists");
    expect(result.err).toContain("--fill-missing");
    expect(readFileSync(join(box.home, "config.yaml"), "utf8")).toBe("mine: true\n");
    expect(readdirSync(box.home)).toEqual(["config.yaml"]);
  });

  it("only adds missing files with --fill-missing", async () => {
    const box = sandbox();
    expect((await init(box, flags(box))).code).toBe(0);
    const configBefore = readFileSync(join(box.home, "config.yaml"), "utf8");
    const stages = `${readFileSync(join(box.home, "stages.yaml"), "utf8")}\n# my edit\n`;
    writeFileSync(join(box.home, "stages.yaml"), stages);
    rmSync(join(box.home, "prompts", "implement.md"));

    const result = await init(box, ["--fill-missing", "--agent-session-command", "ignored"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`Wrote ${join(box.home, "prompts", "implement.md")}`);
    expect(result.out).toContain(`Kept ${join(box.home, "stages.yaml")}`);
    expect(readFileSync(join(box.home, "config.yaml"), "utf8")).toBe(configBefore);
    expect(readFileSync(join(box.home, "stages.yaml"), "utf8")).toBe(stages);
    expect(readFileSync(join(box.home, "prompts", "implement.md"), "utf8")).toBe(
      readFileSync(join(ROOT, "defaults", "prompts", "implement.md"), "utf8"),
    );
  });

  it("reports an invalid existing config with --fill-missing", async () => {
    const box = sandbox();
    mkdirSync(box.home);
    writeFileSync(join(box.home, "config.yaml"), "stages: ./stages.yaml\n");
    const result = await init(box, ["--fill-missing"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("agent_session_command");
    expect(existsSync(join(box.home, "stages.yaml"))).toBe(true);
  });

  it("refuses a home inside a git repo", async () => {
    const box = sandbox();
    mkdirSync(join(box.root, "repo", ".git"), { recursive: true });
    const inRepo = { ...box, home: join(box.root, "repo", ".aop") };
    const result = await init(inRepo, flags(box));
    expect(result.code).toBe(1);
    expect(result.err).toContain("never writes to repos");
    expect(existsSync(inRepo.home)).toBe(false);
  });
});

describe("open_from", () => {
  it("must exist", async () => {
    const box = sandbox();
    const result = await init(box, ["--yes", "--agent-session-command", "c", "--open-from", join(box.root, "nope")]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("doesn't exist");
    expect(existsSync(box.home)).toBe(false);
  });

  it("must be a folder", async () => {
    const box = sandbox();
    writeFileSync(join(box.root, "file"), "");
    const result = await init(box, ["--yes", "--agent-session-command", "c", "--open-from", "file"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("isn't a folder");
  });

  it("is created with --create-open-from, and stored absolute", async () => {
    const box = sandbox();
    const result = await init(box, ["--yes", "--agent-session-command", "c", "--open-from", "new/code", "--create-open-from"]);
    expect(result.code).toBe(0);
    expect(statSync(join(box.root, "new", "code")).isDirectory()).toBe(true);
    expect(loadConfig(box.home).open_from).toBe(join(box.root, "new", "code"));
  });
});

describe("asking", () => {
  it("asks for each setting, with detected tools as the suggestion", async () => {
    const box = sandbox();
    fakeTool(box.bin, "claude");
    fakeTool(box.bin, "copilot");
    const result = await init(box, [], ["", "", join(box.root, "missing"), "n", box.code, "soon", "", "y"]);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    for (const prompt of [
      "Agent session command (required). This is the session your agents are starting in. Strongly consider having this command start sessions inside a sandbox.",
      "Command [claude]: ",
      "Command, or blank to skip (e.g. claude): ",
      "Folder [~/code]: ",
      "doesn't exist. Create it? [y/N]: ",
      "Minutes [60]: ",
      "Enter a positive number of minutes.",
      "Use the default process? [Y/n]: ",
    ]) {
      expect(result.out).toContain(prompt);
    }
    const config = loadConfig(box.home);
    expect(config.agent_session_command).toBe("claude");
    expect(config.out_of_sandbox_command).toBeUndefined();
    expect(config.openFromPath).toBe(box.code);
    expect(config.agent_timeout_minutes).toBe(60);
    expect(existsSync(join(box.root, "missing"))).toBe(false);
    expect(result.out).toContain(`/plugin install aop@aop`);
    expect(result.out).toContain("--permission-mode auto");
    expect(result.out).toContain(`copilot plugin install ${join(ROOT, "plugin")}`);
  });

  it("skips prompts the flags answer", async () => {
    const box = sandbox();
    const result = await init(box, ["--agent-session-command", "c", "--open-from", box.code], ["claude", "15", "y"]);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain("Command [");
    expect(result.out).not.toContain("Folder [");
    const config = loadConfig(box.home);
    expect(config.out_of_sandbox_command).toBe("claude");
    expect(config.agent_timeout_minutes).toBe(15);
  });

  it("writes nothing when input ends early", async () => {
    const box = sandbox();
    const result = await init(box, [], ["claude"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("Nothing was written");
    expect(existsSync(box.home)).toBe(false);
  });
});

describe("finding tools", () => {
  it("finds claude and copilot on a fake PATH without running them", () => {
    const box = sandbox();
    const other = join(box.root, "other");
    mkdirSync(other);
    writeFileSync(join(other, "copilot.exe"), "");
    writeFileSync(join(box.bin, "claude.cmd"), "");
    const env = { Path: `${box.bin};${other}`, PATHEXT: ".EXE;.CMD" };
    expect(findOnPath("claude", env, "win32")).toBe(join(box.bin, "claude.cmd"));
    expect(findOnPath("copilot", env, "win32")).toBe(join(other, "copilot.exe"));
    expect(findOnPath("aop", env, "win32")).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("only counts executable files on POSIX", () => {
    const box = sandbox();
    writeFileSync(join(box.bin, "claude"), "", { mode: 0o644 });
    writeFileSync(join(box.bin, "copilot"), "", { mode: 0o755 });
    const env = { PATH: box.bin };
    expect(findOnPath("claude", env, "linux")).toBeUndefined();
    expect(findOnPath("copilot", env, "linux")).toBe(join(box.bin, "copilot"));
  });

  it("prints the plugin steps for both tools when neither is found", async () => {
    const box = sandbox();
    const result = await init(box, flags(box));
    expect(result.out).toContain("Didn't find claude or copilot on PATH.");
    expect(result.out).toContain("copilot plugin install");
    expect(result.out).toContain("/plugin marketplace add");
  });
});

/** The test's environment, with PATH swapped for the fake one. */
function cliEnv(box: Sandbox): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
  return { ...env, AOP_HOME: box.home, PATH: box.bin };
}

describe("aop init from the CLI", () => {
  it("runs through the entry point", () => {
    const box = sandbox();
    const run = spawnSync(process.execPath, [...nodeArgs("src/cli/main.ts"), "init", ...flags(box)], {
      encoding: "utf8",
      env: cliEnv(box),
    });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("The config is valid.");
    loadConfig(box.home);

    const again = spawnSync(process.execPath, [...nodeArgs("src/cli/main.ts"), "init", ...flags(box)], {
      encoding: "utf8",
      env: cliEnv(box),
    });
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("already exists");
  }, 60_000);

  it("shares its usage line with the CLI's help", () => {
    const box = sandbox();
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [...nodeArgs("src/cli/main.ts"), ...args], { encoding: "utf8", env: cliEnv(box) });
    const line = cli("help").stdout.split("\n").find((l) => l.trim().startsWith("aop init"));
    expect(line).toBeDefined();
    const bad = cli("init", "--bogus");
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain(`Usage: ${line!.trim()}`);
    expect(cli("init", "--help").stdout).toContain("--fill-missing       Config exists");
    expect(existsSync(box.home)).toBe(false);
  }, 60_000);
});
