import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { aopHome } from "../../src/server/paths.js";
import type { StagesView } from "../../src/shared/api.js";
import { makeHome } from "./helpers.js";

const ROOT = resolve(import.meta.dirname, "../..");
const running: ChildProcess[] = [];

afterEach(() => {
  for (const child of running.splice(0)) child.kill();
});

/** A home folder standing in for the user's, so the real `~/.aop` can't be reached. */
function fakeUser(): { home: string; env: NodeJS.ProcessEnv } {
  const home = mkdtempSync(join(aopHome(), "user-"));
  const temp = join(home, "temp");
  mkdirSync(temp);
  const { AOP_HOME: _unused, ...env } = process.env;
  return { home, env: { ...env, HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, TMPDIR: temp, AOP_PORT: "0" } };
}

function run(script: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", "tsx", script, ...args], { cwd: ROOT, env });
  running.push(child);
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
  const exited = new Promise<number | null>((done) => child.on("exit", done));
  return { output: () => out, exited };
}

async function urlFrom(output: () => string, exited: Promise<number | null>): Promise<string> {
  const stopped = exited.then((code) => {
    throw new Error(`exited ${code}: ${output()}`);
  });
  const found = expect
    .poll(() => /http:\/\/127\.0\.0\.1:\d+/.exec(output())?.[0], { timeout: 40_000, interval: 100 })
    .toBeDefined();
  await Promise.race([found, stopped]);
  return /http:\/\/127\.0\.0\.1:\d+/.exec(output())![0];
}

describe("starting the server", () => {
  it("with no config says what to create, and creates nothing", { timeout: 40_000 }, async () => {
    const { home, env } = fakeUser();
    const { output, exited } = run("src/server/main.ts", [], env);
    expect(await exited).toBe(1);
    expect(output()).toContain(join(home, ".aop", "config.yaml"));
    expect(output()).toContain("Create it");
    expect(output()).not.toContain("    at "); // no stack trace
    expect(existsSync(join(home, ".aop"))).toBe(false);
  });

  it("with an empty AOP_HOME says the same, and doesn't create the database", { timeout: 40_000 }, async () => {
    const { home, env } = fakeUser();
    const { output, exited } = run("src/server/main.ts", [], { ...env, AOP_HOME: home });
    expect(await exited).toBe(1);
    expect(output()).toContain(join(home, "config.yaml"));
    expect(existsSync(join(home, "aop.db"))).toBe(false);
  });

  it("with a bad stages file lists the problems", { timeout: 40_000 }, async () => {
    const { env } = fakeUser();
    const home = makeHome({ "stages.yaml": "stages: { a: { turn: agent } }\ntypes: {}\n" });
    const { output, exited } = run("src/server/main.ts", [], { ...env, AOP_HOME: home });
    expect(await exited).toBe(1);
    expect(output()).toContain("agent stage has no prompt");
  });

  it("refuses a repo argument", { timeout: 40_000 }, async () => {
    const { env } = fakeUser();
    const { output, exited } = run("src/server/main.ts", ["some/repo"], { ...env, AOP_HOME: makeHome() });
    expect(await exited).toBe(2);
    expect(output()).toContain("Usage");
  });

  it("with a valid config runs with no projects", { timeout: 40_000 }, async () => {
    const { env } = fakeUser();
    const { output, exited } = run("src/server/main.ts", [], { ...env, AOP_HOME: makeHome() });
    const url = await urlFrom(output, exited);
    expect(await (await fetch(`${url}/api/projects`)).json()).toEqual([]);
    expect(((await (await fetch(`${url}/api/stages`)).json()) as StagesView).start).toBe("triage");
  });
});
