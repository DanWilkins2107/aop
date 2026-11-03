import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";
import { ConfigError } from "../../src/server/errors.js";
import { aopHome, dbPath } from "../../src/server/paths.js";
import { CONFIG_YAML, makeHome, writeFiles, STAGES_YAML } from "./helpers.js";

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
      sandboxed_command: "sandboxed-claude",
      non_sandboxed_command: "claude",
      agent_args: "-p",
      sandbox: true,
      open_from: ".",
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
    const home = makeHome({ "config.yaml": `sandboxed_command: s\nstages: ${JSON.stringify(join(shared, "stages.yaml"))}\n` });
    const config = loadConfig(home);
    expect(config.stagesPath).toBe(join(shared, "stages.yaml"));
    expect(config.graph.stages.get("awaiting_agent_breakdown")?.prompt).toBe(join(shared, "prompts", "awaiting_agent_breakdown.md"));
  });

  it("defaults the optional keys", () => {
    const home = makeHome({ "config.yaml": `sandboxed_command: s\n${ONLY_STAGES}` });
    expect(loadConfig(home)).toMatchObject({ agent_args: "", sandbox: true, open_from: ".", agent_timeout_minutes: 60 });
  });

  it("requires sandboxed_command unless sandbox is false", () => {
    expect(problemsOf(makeHome({ "config.yaml": ONLY_STAGES })).join()).toContain("sandboxed_command: required");
    expect(problemsOf(makeHome({ "config.yaml": `sandbox: true\n${ONLY_STAGES}` })).join()).toContain("sandboxed_command: required");
    expect(problemsOf(makeHome({ "config.yaml": `sandbox: false\nnon_sandboxed_command: c\n${ONLY_STAGES}` }))).toEqual([]);
  });

  it("requires non_sandboxed_command when sandbox is false, which has nothing else to launch", () => {
    const home = makeHome({ "config.yaml": `sandbox: false\nsandboxed_command: s\n${ONLY_STAGES}` });
    expect(problemsOf(home).join()).toContain("non_sandboxed_command: required");
  });

  it("no longer accepts the old keys", () => {
    const home = makeHome({ "config.yaml": `${CONFIG_YAML}agent_command: x\nmax_agents: 3\n` });
    const problems = problemsOf(home).join();
    expect(problems).toContain("agent_command");
    expect(problems).toContain("max_agents");
  });

  it("checks each key's value", () => {
    const home = makeHome({
      "config.yaml": `
sandboxed_command: "  "
non_sandboxed_command: 3
agent_args: [a]
sandbox: "no"
open_from: ${JSON.stringify(resolve("/somewhere"))}
agent_timeout_minutes: 0
${ONLY_STAGES}`,
    });
    const problems = problemsOf(home).join("\n");
    for (const key of ["sandboxed_command", "non_sandboxed_command", "agent_args", "sandbox", "open_from", "agent_timeout_minutes"]) {
      expect(problems).toContain(`${key}:`);
    }
  });

  it("says what file to create when config.yaml is missing", () => {
    const home = mkdtempSync(join(aopHome(), "empty-"));
    const [problem] = problemsOf(home);
    expect(problem).toContain(join(home, "config.yaml"));
    expect(problem).toContain("Create it");
    expect(problem).toContain("sandboxed_command");
    expect(problem).toContain("stages: ./stages.yaml");
  });

  it("says what file to create when the stages file is missing", () => {
    const home = makeHome({ "config.yaml": `sandboxed_command: s\nstages: ./nope.yaml\n` });
    const [problem] = problemsOf(home);
    expect(problem).toContain(join(home, "nope.yaml"));
    expect(problem).toContain("Create it");
  });

  it("requires a stages link", () => {
    expect(problemsOf(makeHome({ "config.yaml": "sandboxed_command: s\n" })).join()).toContain("stages");
  });

  it("reports config problems together with stages problems", () => {
    const home = makeHome({
      "config.yaml": `${ONLY_STAGES}agent_timeout_minutes: 0\nsurprise: 1\n`,
      "stages.yaml": `${pool}\ntypes: { t: { start: missing, stages: {} } }\n`,
    });
    const problems = problemsOf(home).join("\n");
    expect(problems).toContain("sandboxed_command");
    expect(problems).toContain("agent_timeout_minutes");
    expect(problems).toContain("surprise");
    expect(problems).toContain('start "missing"');
  });

  it("reports YAML syntax errors", () => {
    expect(stagesProblems("stages: [unclosed").length).toBeGreaterThan(0);
    expect(problemsOf(makeHome({ "config.yaml": "- a\n- b\n" })).join()).toContain("mapping");
  });

  it("ignores any .aop folder or config.local.yaml", () => {
    const home = makeHome({ "config.local.yaml": "sandboxed_command: other\n", ".aop/config.yaml": "nonsense: 1\n" });
    expect(loadConfig(home).sandboxed_command).toBe("sandboxed-claude");
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
