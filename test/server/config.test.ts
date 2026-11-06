import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, withConfigSnapshot } from "../../src/server/config.js";
import { ConfigError } from "../../src/server/errors.js";
import { aopHome, dbPath } from "../../src/server/paths.js";
import { CONFIG_YAML, makeHome, PROMPTS, writeFiles, STAGES_YAML } from "./helpers.js";

function problemsOf(home: string): string[] {
  try {
    loadConfig(home);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

function stagesProblems(yaml: string, extra: Record<string, string> = {}): string[] {
  return problemsOf(makeHome({ "stages.yaml": yaml, ...extra }));
}

const pool = `
start: t
stages:
  a: { turn: human }
  b: { turn: human }
`;

describe("paths", () => {
  it("builds state paths from AOP_HOME, which tests point at a temp dir", () => {
    expect(aopHome().startsWith(resolve(tmpdir()))).toBe(true);
    expect(aopHome().startsWith(resolve(homedir(), ".aop"))).toBe(false);
    expect(dbPath()).toBe(join(aopHome(), "aop.db"));
  });

  it("defaults to ~/.aop", () => {
    const saved = process.env["AOP_HOME"];
    delete process.env["AOP_HOME"];
    try {
      expect(aopHome()).toBe(join(homedir(), ".aop"));
    } finally {
      process.env["AOP_HOME"] = saved;
    }
  });
});

const ONLY_STAGES = "stages: ./stages.yaml\n";

describe("config loading", () => {
  it("loads every key and resolves stages and prompts", () => {
    const home = makeHome();
    const config = loadConfig(home);
    expect(config).toMatchObject({
      agent_session_command: "sandboxed-claude",
      out_of_sandbox_command: "claude",
      open_from: "~/code",
      agent_timeout_minutes: 30,
      stagesPath: join(home, "stages.yaml"),
    });
    expect(config.graph.types.get("triage")?.start).toBe("awaiting_agent_breakdown");
    expect(config.graph.stages.get("awaiting_agent_breakdown")?.prompt).toBe(join(home, "prompts", "awaiting_agent_breakdown.md"));
  });

  it("reads AOP_HOME by default", () => {
    const home = makeHome();
    const saved = process.env["AOP_HOME"];
    process.env["AOP_HOME"] = home;
    try {
      expect(loadConfig().stagesPath).toBe(join(home, "stages.yaml"));
    } finally {
      process.env["AOP_HOME"] = saved;
    }
  });

  it("follows an absolute stages link, with prompts relative to that file", () => {
    const shared = makeHome();
    const home = makeHome({ "config.yaml": `agent_session_command: s\nstages: ${JSON.stringify(join(shared, "stages.yaml"))}\n` });
    const config = loadConfig(home);
    expect(config.stagesPath).toBe(join(shared, "stages.yaml"));
    expect(config.graph.stages.get("awaiting_agent_breakdown")?.prompt).toBe(join(shared, "prompts", "awaiting_agent_breakdown.md"));
  });

  it("defaults the optional keys", () => {
    const home = makeHome({ "config.yaml": `agent_session_command: s\n${ONLY_STAGES}` });
    expect(loadConfig(home)).toMatchObject({ open_from: "~/code", agent_timeout_minutes: 60 });
    expect(loadConfig(home).out_of_sandbox_command).toBeUndefined();
  });

  it("requires agent_session_command, even with an out-of-sandbox command", () => {
    expect(problemsOf(makeHome({ "config.yaml": ONLY_STAGES })).join()).toContain("agent_session_command: required");
    const other = makeHome({ "config.yaml": `out_of_sandbox_command: c\n${ONLY_STAGES}` });
    expect(problemsOf(other).join()).toContain("agent_session_command: required");
  });

  it("refuses the settings AOP now controls itself", () => {
    for (const old of ["sandboxed_command: s", "non_sandboxed_command: c", "agent_args: -p", "sandbox: false"]) {
      const home = makeHome({ "config.yaml": `${CONFIG_YAML}${old}\n` });
      expect(problemsOf(home).join()).toContain(old.split(":")[0]);
    }
  });

  it("rejects unknown keys such as agent_command and max_agents", () => {
    const home = makeHome({ "config.yaml": `${CONFIG_YAML}agent_command: x\nmax_agents: 3\n` });
    const problems = problemsOf(home).join();
    expect(problems).toContain("agent_command");
    expect(problems).toContain("max_agents");
  });

  it("checks each key's value", () => {
    const home = makeHome({
      "config.yaml": `
agent_session_command: "  "
out_of_sandbox_command: 3
open_from: ""
agent_timeout_minutes: 0
${ONLY_STAGES}`,
    });
    const problems = problemsOf(home).join("\n");
    for (const key of ["agent_session_command", "out_of_sandbox_command", "open_from", "agent_timeout_minutes"]) {
      expect(problems).toContain(`${key}:`);
    }
  });

  it("says what file to create when config.yaml is missing", () => {
    const home = mkdtempSync(join(aopHome(), "empty-"));
    const [problem] = problemsOf(home);
    expect(problem).toContain(join(home, "config.yaml"));
    expect(problem).toContain("Create it");
    expect(problem).toContain("agent_session_command");
    expect(problem).toContain("stages: ./stages.yaml");
  });

  it("says what file to create when the stages file is missing", () => {
    const home = makeHome({ "config.yaml": `agent_session_command: s\nstages: ./nope.yaml\n` });
    const [problem] = problemsOf(home);
    expect(problem).toContain(join(home, "nope.yaml"));
    expect(problem).toContain("Create it");
  });

  it("requires a stages link", () => {
    expect(problemsOf(makeHome({ "config.yaml": "agent_session_command: s\n" })).join()).toContain("stages");
  });

  it("reports config problems together with stages problems", () => {
    const home = makeHome({
      "config.yaml": `${ONLY_STAGES}agent_timeout_minutes: 0\nsurprise: 1\n`,
      "stages.yaml": `${pool}\ntypes: { t: { start: missing, stages: {} } }\n`,
    });
    const problems = problemsOf(home).join("\n");
    expect(problems).toContain("agent_session_command");
    expect(problems).toContain("agent_timeout_minutes");
    expect(problems).toContain("surprise");
    expect(problems).toContain('start "missing"');
  });

  it("reports YAML syntax errors", () => {
    expect(stagesProblems("stages: [unclosed").length).toBeGreaterThan(0);
    expect(problemsOf(makeHome({ "config.yaml": "- a\n- b\n" })).join()).toContain("mapping");
  });

  it("ignores any .aop folder or config.local.yaml", () => {
    const home = makeHome({ "config.local.yaml": "agent_session_command: other\n", ".aop/config.yaml": "nonsense: 1\n" });
    expect(loadConfig(home).agent_session_command).toBe("sandboxed-claude");
  });
});

describe("stages.yaml validation", () => {
  it("accepts the process from the spec", () => {
    expect(stagesProblems(STAGES_YAML)).toEqual([]);
  });

  it("refuses a stage and a type with the same name", () => {
    const problems = stagesProblems(`${pool}\ntypes: { a: { start: b, stages: { b: { next: {} } } } }\n`);
    expect(problems.join()).toContain('stage "a": a type has the same name');
  });

  it("refuses a stage using a built-in name", () => {
    for (const name of ["done", "broken_down", "invalidated", "scheduled", "ask_human_question", "failed", "externally_blocked", "splitting"]) {
      const problems = stagesProblems(`stages: { ${name}: { turn: human } }\ntypes: {}\n`);
      expect(problems.join()).toContain(`"${name}" is a reserved built-in`);
    }
  });

  it("refuses a type using a built-in name", () => {
    const problems = stagesProblems(`${pool}\ntypes: { done: { start: a, stages: { a: { next: {} } } } }\n`);
    expect(problems.join()).toContain('type "done": "done" is a reserved built-in');
  });

  it("refuses a next target that doesn't exist", () => {
    const problems = stagesProblems(`${pool}\ntypes: { t: { start: a, stages: { a: { next: { go: nowhere } } } } }\n`);
    expect(problems.join()).toContain('outcome "go" targets "nowhere"');
  });

  it("refuses a next target that's in the pool but not in the type", () => {
    const problems = stagesProblems(`${pool}\ntypes: { t: { start: a, stages: { a: { next: { go: b } } } } }\n`);
    expect(problems.join()).toContain('outcome "go" targets "b"');
  });

  it("accepts next targets of another type, done and broken_down", () => {
    const problems = stagesProblems(`${pool}
types:
  t: { start: a, stages: { a: { next: { to_u: u, end: done, split: broken_down } } } }
  u: { start: b, stages: { b: { next: {} } } }
`);
    expect(problems).toEqual([]);
  });

  it("refuses next targeting any other built-in", () => {
    for (const target of ["invalidated", "scheduled", "ask_human_question", "failed", "externally_blocked", "splitting"]) {
      const problems = stagesProblems(`${pool}\ntypes: { t: { start: a, stages: { a: { next: { go: ${target} } } } } }\n`);
      expect(problems.join()).toContain(`targets "${target}", but done and broken_down are the only built-ins`);
    }
  });

  it("refuses next targeting scheduled even when the type lists it", () => {
    const problems = stagesProblems(`${pool}
types:
  t: { start: a, stages: { a: { next: { go: scheduled } }, scheduled: { next: { fire: t } } } }
`);
    expect(problems.join()).toContain('targets "scheduled", but done and broken_down');
  });

  it("requires a top-level start, which must name a type", () => {
    const type = "types: { t: { start: a, stages: { a: { next: {} } } } }\n";
    const stagesOnly = "stages: { a: { turn: human } }\n";
    expect(stagesProblems(`${stagesOnly}${type}`)).toEqual(['stages.yaml: the top-level "start" is missing']);
    expect(stagesProblems(`start: nope\n${stagesOnly}${type}`).join()).toContain('start "nope" is not a type');
    expect(stagesProblems(`start: a\n${stagesOnly}${type}`).join()).toContain('start "a" is not a type');
    expect(stagesProblems(`start: t\n${stagesOnly}${type}`)).toEqual([]);
  });

  it("reports a missing start alongside other problems", () => {
    const text = stagesProblems(`stages: { a: { turn: agent } }\ntypes: {}\n`).join("\n");
    expect(text).toContain('"start" is missing');
    expect(text).toContain("agent stage has no prompt");
  });

  it("refuses a start that doesn't exist or isn't in the type", () => {
    expect(stagesProblems(`${pool}\ntypes: { t: { start: nope, stages: { a: { next: {} } } } }\n`).join()).toContain(
      'start "nope"',
    );
    expect(stagesProblems(`${pool}\ntypes: { t: { start: b, stages: { a: { next: {} } } } }\n`).join()).toContain(
      'start "b"',
    );
  });

  it("refuses a type using a stage that isn't in the pool", () => {
    const problems = stagesProblems(`${pool}\ntypes: { t: { start: a, stages: { a: { next: {} }, ghost: { next: {} } } } }\n`);
    expect(problems.join()).toContain('stage "ghost": not in the stage pool');
  });

  it("only lets a type list scheduled out of the built-ins", () => {
    const problems = stagesProblems(`${pool}\ntypes: { t: { start: a, stages: { a: { next: {} }, done: { next: {} } } } }\n`);
    expect(problems.join()).toContain('stage "done": not in the stage pool');
  });

  it("requires scheduled to be declared by the type, with one outcome", () => {
    expect(stagesProblems(`${pool}\ntypes: { t: { start: a, stages: { a: { next: { s: scheduled } } } } }\n`).join()).toContain(
      'targets "scheduled"',
    );
    expect(stagesProblems(`${pool}\ntypes: { t: { start: scheduled, stages: { scheduled: { next: {} } } } }\n`).join()).toContain(
      "exactly one outcome",
    );
  });

  it("refuses an agent stage with no prompt", () => {
    const problems = stagesProblems(`stages: { a: { turn: agent } }\ntypes: {}\n`);
    expect(problems.join()).toContain('stage "a": agent stage has no prompt');
  });

  it("refuses an agent stage whose prompt file is missing or isn't a file", () => {
    const missing = stagesProblems(`stages: { a: { turn: agent, prompt: ./prompts/none.md } }\ntypes: {}\n`);
    expect(missing.join()).toContain("prompt file not found");
    const directory = stagesProblems(`stages: { a: { turn: agent, prompt: ./prompts } }\ntypes: {}\n`);
    expect(directory.join()).toContain("prompt file not found");
  });

  it("refuses a prompt outside the stages file's folder, however it gets there", () => {
    const outside = mkdtempSync(join(tmpdir(), "aop-secret-"));
    writeFileSync(join(outside, "id_rsa"), "secret");
    const absolute = stagesProblems(`stages: { a: { turn: agent, prompt: ${JSON.stringify(join(outside, "id_rsa"))} } }\ntypes: {}\n`);
    expect(absolute.join()).toContain("prompt must be in the stages file's folder");
    const home = makeHome();
    const climbing = relative(home, join(outside, "id_rsa"));
    expect(stagesProblems(`stages: { a: { turn: agent, prompt: ${JSON.stringify(climbing)} } }\ntypes: {}\n`).join()).toContain(
      "prompt must be in the stages file's folder",
    );
    // A symlink inside the folder, as a downloaded process could ship, is followed before checking.
    const linked = makeHome();
    let canLink = true;
    try {
      symlinkSync(join(outside, "id_rsa"), join(linked, "prompts", "link.md"), "file");
    } catch {
      canLink = false; // Windows without symlink rights.
    }
    if (canLink) {
      writeFiles(linked, { "stages.yaml": `stages: { a: { turn: agent, prompt: ./prompts/link.md } }\ntypes: {}\n` });
      expect(problemsOf(linked).join()).toContain("prompt must be in the stages file's folder");
    }
    // A prompt in a subfolder whose name starts with dots is still inside.
    expect(stagesProblems(`stages: { a: { turn: agent, prompt: ./..notes.md } }\ntypes: {}\n`, { "..notes.md": "x" }).join()).not.toContain(
      "must be in",
    );
  });

  it("ignores a prompt on a human stage", () => {
    const yaml = `start: t\nstages: { a: { turn: human, prompt: ./none.md } }\ntypes: { t: { start: a, stages: { a: { next: {} } } } }\n`;
    expect(stagesProblems(yaml)).toEqual([]);
  });

  it("refuses a bad turn, a bad colour, unknown keys and missing sections", () => {
    const problems = stagesProblems(`stages: { a: { turn: robot, color: red, nope: 1 } }\ntypes: {}\n`).join("\n");
    expect(problems).toContain('stage "a".turn');
    expect(problems).toContain('stage "a".color');
    expect(problems).toContain("nope");
    expect(stagesProblems("stages: {}\n").join()).toContain("types");
    expect(stagesProblems("types: {}\n").join()).toContain("stages");
  });

  it("isn't fooled by names on Object.prototype", () => {
    const problems = stagesProblems(`${pool}\ntypes: { t: { start: constructor, stages: { a: { next: { go: toString } } } } }\n`);
    expect(problems.join("\n")).toContain('start "constructor"');
    expect(problems.join("\n")).toContain('targets "toString"');
  });

  it("reports every problem at once", () => {
    const problems = stagesProblems(`
stages:
  dup: { turn: human }
  done: { turn: human }
  no_prompt: { turn: agent }
  bad_prompt: { turn: agent, prompt: ./missing.md }
  bad_turn: { turn: robot }
types:
  dup: { start: ghost, stages: { ghost: { next: { go: nowhere } } } }
  broken: { start: 12, stages: {} }
  failed: { start: dup, stages: { no_prompt: { next: {} } } }
`);
    const text = problems.join("\n");
    for (const expected of [
      'stage "dup": a type has the same name',
      '"done" is a reserved built-in',
      "agent stage has no prompt",
      "prompt file not found",
      'stage "bad_turn".turn',
      'stage "ghost": not in the stage pool',
      'targets "nowhere"',
      'type "broken".start',
      'type "failed": "failed" is a reserved built-in',
      'type "failed": start "dup"',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it("re-reads the file each time, so fixing it takes effect", () => {
    const home = makeHome({ "stages.yaml": "stages: {}\n" });
    expect(problemsOf(home).length).toBeGreaterThan(0);
    writeFiles(home, { "stages.yaml": STAGES_YAML });
    expect(problemsOf(home)).toEqual([]);
  });
});

describe("config cache", () => {
  const FILES = ["config.yaml", "stages.yaml", ...PROMPTS.map((p) => `prompts/${p}.md`)];
  /** Makes files look long settled, as a config nobody has touched today is. */
  function age(home: string, ...paths: string[]): void {
    const old = new Date(Date.now() - 60 * 60_000);
    for (const path of paths) utimesSync(join(home, path), old, old);
  }
  const timeout = (minutes: number) => CONFIG_YAML.replace("agent_timeout_minutes: 30", `agent_timeout_minutes: ${minutes}`);

  it("reads the files once while nothing changes", () => {
    const home = makeHome();
    age(home, ...FILES);
    const first = loadConfig(home);
    expect(loadConfig(home)).toBe(first);
  });

  it("picks up an edit to stages.yaml straight away, even one of the same size", () => {
    const home = makeHome();
    age(home, ...FILES);
    const first = loadConfig(home);
    expect(first.graph.types.has("hotfix")).toBe(true);
    // The same length, so only the modification time tells.
    writeFiles(home, { "stages.yaml": STAGES_YAML.replaceAll("hotfix", "hotfux") });
    expect(statSync(join(home, "stages.yaml")).size).toBe(Buffer.byteLength(STAGES_YAML));
    const second = loadConfig(home);
    expect(second.graph.types.has("hotfux")).toBe(true);
    expect(second.graph.types.has("hotfix")).toBe(false);
  });

  it("picks up an edit with an old timestamp, by its size", () => {
    const home = makeHome();
    age(home, ...FILES);
    expect(problemsOf(home)).toEqual([]);
    writeFiles(home, { "stages.yaml": "stages: {}\n" });
    age(home, "stages.yaml");
    expect(problemsOf(home).length).toBeGreaterThan(0);
  });

  it("picks up config.yaml edits, and a prompt file going and coming back", () => {
    const home = makeHome();
    age(home, ...FILES);
    expect(loadConfig(home).agent_timeout_minutes).toBe(30);
    writeFiles(home, { "config.yaml": timeout(45) });
    expect(loadConfig(home).agent_timeout_minutes).toBe(45);
    age(home, "config.yaml");
    expect(loadConfig(home).agent_timeout_minutes).toBe(45);
    rmSync(join(home, "prompts", "implement.md"));
    expect(problemsOf(home).join("\n")).toContain("prompt file not found");
    writeFiles(home, { "prompts/implement.md": "Do implement." });
    age(home, "prompts/implement.md");
    expect(problemsOf(home)).toEqual([]);
  });

  it("keeps an invalid config's problems until the file is fixed", () => {
    const home = makeHome({ "stages.yaml": "stages: {}\n" });
    age(home, ...FILES.slice(0, 2));
    const problems = problemsOf(home);
    expect(problems.length).toBeGreaterThan(0);
    expect(problemsOf(home)).toEqual(problems);
    writeFiles(home, { "stages.yaml": STAGES_YAML });
    expect(problemsOf(home)).toEqual([]);
  });

  it("gives an operation one config, even across an await, and the next one the edit", async () => {
    const home = makeHome();
    const [before, after] = await withConfigSnapshot(async () => {
      const first = loadConfig(home);
      writeFiles(home, { "config.yaml": timeout(45) });
      await new Promise((wait) => setTimeout(wait, 5));
      return [first, loadConfig(home)];
    });
    expect(after).toBe(before);
    expect(loadConfig(home).agent_timeout_minutes).toBe(45);
  });

  it("lets nothing that outlives an operation keep its config", () => {
    const home = makeHome();
    let later = () => 0;
    withConfigSnapshot(() => {
      loadConfig(home);
      later = () => loadConfig(home).agent_timeout_minutes;
    });
    writeFiles(home, { "config.yaml": timeout(45) });
    expect(later()).toBe(45);
  });

  it("picks up an edit to improvement_stages.yaml, and a git repo appearing around improvements_path", () => {
    const pipeline = readFileSync(resolve(import.meta.dirname, "../../defaults/improvement_stages.yaml"), "utf8");
    const home = makeHome({
      "config.yaml": `${CONFIG_YAML}improvement_stages: ./improvement_stages.yaml\n`,
      "improvement_stages.yaml": pipeline,
      "prompts/draft_change.md": "Draft it.",
      "prompts/save_locally.md": "Save it.",
      "prompts/raise_pr.md": "Raise it.",
      "skills/README.md": "Skills.",
    });
    const files = [...FILES, "improvement_stages.yaml", "prompts/draft_change.md", "prompts/save_locally.md", "prompts/raise_pr.md"];
    age(home, ...files);
    const first = loadConfig(home);
    expect(loadConfig(home)).toBe(first);
    expect(first.improvementsRepo).toBeNull();

    writeFiles(home, { "improvement_stages.yaml": pipeline.replaceAll("draft_change", "draft_chanje") });
    expect(problemsOf(home).join("\n")).toContain("draft_chanje.md");
    writeFiles(home, { "improvement_stages.yaml": pipeline });
    age(home, "improvement_stages.yaml");
    expect(problemsOf(home)).toEqual([]);

    mkdirSync(join(home, "skills", ".git"));
    expect(loadConfig(home).improvementsRepo).toBe(join(home, "skills"));
  });
});
