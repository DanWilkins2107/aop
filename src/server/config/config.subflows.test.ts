import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { ConfigError } from "../shared/errors.js";
import { describeStages } from "../stages/stages.js";
import { makeHome } from "../../../test-shared/harness.js";

const PROMPTS = ["implement", "review_tests", "review_style", "decide"];

/** A process whose `types` section is `types`, over a pool of agent stages and one human stage. */
function home(types: string): string {
  const yaml = `
start: dev
stages:
  implement:    { turn: agent, prompt: ./prompts/implement.md }
  review_tests: { turn: agent, prompt: ./prompts/review_tests.md }
  review_style: { turn: agent, prompt: ./prompts/review_style.md }
  decide:       { turn: agent, prompt: ./prompts/decide.md }
  pr_review:    { turn: human }
types:
${types}
`;
  return makeHome({ "stages.yaml": yaml, ...Object.fromEntries(PROMPTS.map((p) => [`prompts/${p}.md`, `Do ${p}.`])) });
}

function problems(types: string): string[] {
  try {
    loadConfig(home(types));
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

/** The outer type, running `build_and_review`. */
const DEV = `
  dev:
    start: build
    stages:
      build:     { subflow: build_and_review, next: { done: pr_review } }
      pr_review: { next: { approved: done } }
`;

const BUILD_AND_REVIEW = `
  build_and_review:
    start: implement
    stages:
      implement: { next: { done: reviews, give_up: done } }
      reviews:
        parallel: [review_tests, review_style]
        gate: all_pass
        max_loops: 3
        next: { pass: done, fail: implement }
`;

describe("sub-workflows in stages.yaml", () => {
  it("accepts subflow, parallel, gate and max_loops, and marks the types run inside a node", () => {
    const config = loadConfig(home(DEV + BUILD_AND_REVIEW));
    const inner = config.graph.types.get("build_and_review")!;
    expect(inner.isSubflow).toBe(true);
    expect(config.graph.types.get("dev")!.isSubflow).toBe(false);
    expect(config.graph.types.get("dev")!.subflows.get("build")).toBe("build_and_review");
    expect(inner.parallel.get("reviews")).toEqual({ branches: ["review_tests", "review_style"], gate: "all_pass" });
    expect(inner.maxLoops.get("reviews")).toBe(3);

    const view = describeStages(config.graph).types.find((type) => type.name === "build_and_review")!;
    expect(view.stages).toEqual([
      {
        name: "implement",
        next: [
          { outcome: "done", target: "reviews" },
          { outcome: "give_up", target: "done" },
        ],
      },
      {
        name: "reviews",
        next: [
          { outcome: "pass", target: "done" },
          { outcome: "fail", target: "implement" },
        ],
        parallel: ["review_tests", "review_style"],
        gate: "all_pass",
        max_loops: 3,
      },
    ]);
  });

  it("lets a parallel group run whole types, and without a gate end with done", () => {
    const types = `
  dev:
    start: checks
    stages:
      checks:    { parallel: [review_tests, nested], next: { done: decide } }
      decide:    { next: { ok: pr_review } }
      pr_review: { next: { approved: done } }
  nested:
    start: review_style
    stages:
      review_style: { next: { done: deeper } }
      deeper:       { parallel: [review_tests, leaf], gate: all_pass, next: { pass: done, fail: review_style } }
  leaf:
    start: review_tests
    stages:
      review_tests: { next: { done: done } }
`;
    expect(problems(types)).toEqual([]);
  });

  it("checks a parallel group's branches and outcomes", () => {
    const found = problems(`
  dev:
    start: a
    stages:
      a: { parallel: [review_tests, review_tests, pr_review, nope], next: { pass: done } }
      b: { parallel: [implement], gate: all_pass, next: { pass: done, maybe: done } }
      implement: { gate: all_pass, next: { done: done } }
`).join("\n");
    expect(found).toContain('branch "review_tests" is listed twice');
    expect(found).toContain('branch "pr_review" is not an agent stage');
    expect(found).toContain('branch "nope" is not a stage in the pool or a type');
    expect(found).toContain('stage "a": next must map "done"');
    expect(found).toContain('stage "a": "pass" is not an outcome of this group, which ends with done');
    expect(found).toContain('stage "b": next must map "fail"');
    expect(found).toContain('stage "b": "maybe" is not an outcome');
    expect(found).toContain('stage "implement": gate needs parallel');
  });

  it("refuses a bad gate, a bad max_loops, an empty group and subflow with parallel", () => {
    const found = problems(`
  dev:
    start: a
    stages:
      a: { parallel: [implement], gate: any_pass, next: { done: done } }
      b: { parallel: [], next: { done: done } }
      c: { subflow: fix, parallel: [implement], next: { done: done } }
      implement: { max_loops: 0, next: { done: done } }
  fix:
    start: implement
    stages:
      implement: { next: { done: done } }
`).join("\n");
    expect(found).toContain('stage "a".gate');
    expect(found).toContain('stage "b".parallel');
    expect(found).toContain('stage "c": can\'t have both subflow and parallel');
    expect(found).toContain('stage "implement".max_loops');
  });

  it("refuses a step named like a pool stage, a type or a built-in", () => {
    const found = problems(`
  dev:
    start: implement
    stages:
      implement: { parallel: [review_tests], next: { done: done } }
      fix:       { parallel: [review_tests], next: { done: done } }
      done:      { parallel: [review_tests], next: { done: implement } }
  fix:
    start: implement
    stages:
      implement: { next: { done: done } }
`).join("\n");
    expect(found).toContain('type "dev", stage "implement": a stage in the pool has the same name');
    expect(found).toContain('type "dev", stage "fix": a type has the same name');
    expect(found).toContain('type "dev", stage "done": "done" is a reserved built-in');
  });

  it("makes a subflow stage map exactly done", () => {
    const found = problems(`
  dev:
    start: build
    stages:
      build:     { subflow: build_and_review, next: { done: pr_review } }
      other:     { subflow: fix, next: { done: pr_review, exhausted: pr_review } }
      missing:   { subflow: nope, next: { done: pr_review } }
      pr_review: { next: { approved: done } }
  fix:
    start: implement
    stages:
      implement: { next: { done: done } }
${BUILD_AND_REVIEW}`).join("\n");
    expect(found).toContain('stage "other": "exhausted" is not an outcome of subflow "fix", which ends with done');
    expect(found).toContain('stage "missing": subflow "nope" is not a type');
  });

  it("needs a way on once a max_loops stage can't be entered again", () => {
    const found = problems(`
  dev:
    start: build
    stages:
      build:     { subflow: inner, next: { done: pr_review } }
      pr_review: { next: { approved: done } }
  inner:
    start: implement
    stages:
      implement: { next: { done: reviews } }
      reviews:   { parallel: [review_tests], gate: all_pass, max_loops: 2, next: { pass: done, fail: decide } }
      decide:    { max_loops: 2, next: { done: reviews, skip: done } }
`).join("\n");
    expect(found).toContain('type "inner", stage "implement": every outcome targets a stage with max_loops');
    expect(found).toContain('type "inner", stage "reviews": outcome "fail" targets "decide", which has max_loops');
    expect(found).not.toContain('stage "decide"');
  });

  it("keeps sub-workflows to agent stages, their own targets and done, and out of a node's types", () => {
    const found = problems(`
  dev:
    start: build
    stages:
      build:     { subflow: inner, next: { done: pr_review } }
      pr_review: { next: { approved: done, again: inner } }
  inner:
    start: implement
    stages:
      implement: { next: { done: pr_review, up: dev, split: broken_down } }
      pr_review: { next: { approved: implement } }
`).join("\n");
    expect(found).toContain('type "inner", stage "pr_review": a sub-workflow can only have agent stages');
    expect(found).toContain('type "inner", stage "implement": outcome "up" targets "dev", but a sub-workflow can only target its own stages or done');
    expect(found).toContain('outcome "split" targets "broken_down"');
    expect(found).toContain('type "inner": runs as a sub-workflow, so some outcome must target done');
    expect(found).toContain('type "dev", stage "pr_review": outcome "again" targets "inner", which runs as a sub-workflow');
  });

  it("refuses a sub-workflow as the top-level start, and max_loops outside one", () => {
    const yamlStart = problems(`
  dev:
    start: implement
    stages:
      implement: { max_loops: 2, next: { done: done } }
      loop:      { subflow: dev, next: { done: done } }
`).join("\n");
    expect(yamlStart).toContain('type "dev": runs as a sub-workflow, so it can\'t be the top-level start');

    const found = problems(`
  dev:
    start: implement
    stages:
      implement: { max_loops: 2, next: { done: done } }
`).join("\n");
    expect(found).toContain('type "dev", stage "implement": max_loops only works in a type run as a sub-workflow');
  });

  it("refuses a type that runs itself, however deep", () => {
    const found = problems(`
  dev:
    start: build
    stages:
      build: { subflow: a, next: { done: done } }
  a:
    start: implement
    stages:
      implement: { next: { done: step } }
      step:      { parallel: [review_tests, b], next: { done: done } }
  b:
    start: implement
    stages:
      implement: { next: { done: step } }
      step:      { subflow: a, next: { done: done } }
  self:
    start: step
    stages:
      step: { subflow: self, next: { done: done } }
`);
    const cycles = found.filter((problem) => problem.includes("runs itself"));
    expect(cycles).toEqual([
      'type "a": runs itself as a sub-workflow (a → b → a)',
      'type "self": runs itself as a sub-workflow (self → self)',
    ]);
  });
});
