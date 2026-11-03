import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectConfig } from "../../src/server/config.js";
import { ConfigError } from "../../src/server/errors.js";
import { aopHome, dbPath } from "../../src/server/paths.js";
import { makeRepo, writeFiles, STAGES_YAML } from "./helpers.js";

function problemsOf(repo: string): string[] {
  try {
    loadProjectConfig(repo);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

function stagesProblems(yaml: string, extra: Record<string, string> = {}): string[] {
  return problemsOf(makeRepo({ ".aop/stages.yaml": yaml, ...extra }));
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

describe("config loading", () => {
  it("loads config and resolves stages relative to .aop", () => {
    const repo = makeRepo();
    const config = loadProjectConfig(repo);
    expect(config.max_agents).toBe(3);
    expect(config.agent_command).toContain("{{prompt}}");
    expect(config.stagesPath).toBe(join(repo, ".aop", "stages.yaml"));
    expect(config.graph.types.get("triage")?.start).toBe("assess");
    expect(config.graph.stages.get("assess")?.prompt).toBe(join(repo, ".aop", "prompts", "assess.md"));
  });

  it("lets config.local.yaml override key by key", () => {
    const repo = makeRepo({ ".aop/config.local.yaml": "max_agents: 9\n" });
    const config = loadProjectConfig(repo);
    expect(config.max_agents).toBe(9);
    expect(config.agent_command).toContain("{{prompt}}");
  });

  it("resolves a stages path set in config.local.yaml relative to .aop", () => {
    const repo = makeRepo({
      ".aop/config.local.yaml": "stages: ./custom/process.yaml\n",
      ".aop/custom/process.yaml": `start: t\nstages: { a: { turn: human } }\ntypes: { t: { start: a, stages: { a: { next: { ok: done } } } } }\n`,
    });
    expect(loadProjectConfig(repo).stagesPath).toBe(join(repo, ".aop", "custom", "process.yaml"));
  });

  it("reports a missing config.yaml", () => {
    const repo = makeRepo();
    expect(problemsOf(join(repo, "no-such-dir")).join()).toContain("file not found");
  });

  it("reports config problems together with stages problems", () => {
    const repo = makeRepo({
      ".aop/config.yaml": "stages: ./stages.yaml\nmax_agents: 0\nsurprise: 1\n",
      ".aop/stages.yaml": `${pool}\ntypes: { t: { start: missing, stages: {} } }\n`,
    });
    const problems = problemsOf(repo).join("\n");
    expect(problems).toContain("agent_command");
    expect(problems).toContain("max_agents");
    expect(problems).toContain("surprise");
    expect(problems).toContain('start "missing"');
  });

  it("reports YAML syntax errors", () => {
    expect(stagesProblems("stages: [unclosed").length).toBeGreaterThan(0);
    expect(problemsOf(makeRepo({ ".aop/config.local.yaml": "- a\n- b\n" })).join()).toContain("mapping");
  });

  it("reports a missing stages file", () => {
    const repo = makeRepo({ ".aop/config.local.yaml": "stages: ./nope.yaml\n" });
    expect(problemsOf(repo).join()).toContain("file not found");
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
    const repo = makeRepo({ ".aop/stages.yaml": "stages: {}\n" });
    expect(problemsOf(repo).length).toBeGreaterThan(0);
    writeFiles(repo, { ".aop/stages.yaml": STAGES_YAML });
    expect(problemsOf(repo)).toEqual([]);
  });
});
