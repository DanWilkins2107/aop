import { describe, expect, it } from "vitest";
import type { EventView } from "../../shared/events/types.js";
import { directives, toolCall, until, world, type World } from "../../../test-shared/agents.js";

const TIMEOUT = { timeout: 90_000 };

const STAGES = `
start: dev
stages:
  implement:    { turn: agent, prompt: ./prompts/implement.md }
  review_tests: { turn: agent, prompt: ./prompts/review_tests.md }
  review_style: { turn: agent, prompt: ./prompts/review_style.md }
  pr_review:    { turn: human }
  stuck:        { turn: human }
types:
  dev:
    start: build
    stages:
      build:     { subflow: build_and_review, next: { done: pr_review, exhausted: stuck } }
      pr_review: { next: { approved: done } }
      stuck:     { next: { retry: build } }
  build_and_review:
    start: implement
    stages:
      implement: { next: { done: reviews } }
      reviews:
        parallel: [review_tests, review_style]
        gate: all_pass
        max_loops: 2
        next: { pass: done, fail: implement }
`;

/** A world whose stage prompts are these directives. */
function branchWorld(prompts: Record<string, string>): Promise<World> {
  const files = Object.fromEntries(Object.entries(prompts).map(([stage, body]) => [`prompts/${stage}.md`, `Do ${stage}.\n${body}`]));
  return world({ home: { "stages.yaml": STAGES, ...files } });
}

const events = async (w: World, id: string) => (await w.call<EventView[]>("GET", `/nodes/${id}/events`)).body;

describe("running branches", () => {
  it("runs a sub-workflow's sequence and parallel group, one run per branch", TIMEOUT, async () => {
    const pass = directives(toolCall("next", { outcome: "pass" }));
    const w = await branchWorld({ implement: directives(toolCall("next", { outcome: "done" })), review_tests: pass, review_style: pass });
    const node = await w.create("", { type: "dev" });
    await w.atStage(node.id, "pr_review");

    const runs = (await w.runsEnded(node.id, 3)).map((run) => ({ stage: run.stage, branch: run.branch, end: run.end_reason }));
    expect(runs.slice().sort((a, b) => (a.branch ?? "").localeCompare(b.branch ?? ""))).toEqual([
      { stage: "implement", branch: "build/implement", end: "reported" },
      { stage: "review_style", branch: "build/reviews/review_style", end: "reported" },
      { stage: "review_tests", branch: "build/reviews/review_tests", end: "reported" },
    ]);
    await until("the claim to go", () => w.node(node.id).claimed_by === null);
    const finished = (await events(w, node.id)).filter((e) => e.kind === "branch_finished").map((e) => e.data);
    expect(finished).toHaveLength(3);
  });

  it("fails the node, naming the branch, and stops the others when one crashes", TIMEOUT, async () => {
    const w = await branchWorld({
      implement: directives(toolCall("next", { outcome: "done" })),
      review_tests: directives("hang"),
      review_style: directives("sleep 300", "exit 3"),
    });
    const node = await w.create("", { type: "dev" });
    const failed = await w.atStage(node.id, "failed");
    expect(failed.return_stage).toBe("build");

    const change = (await events(w, node.id)).findLast((e) => e.kind === "stage_changed")?.data as { reason?: string };
    expect(change.reason).toBe("Branch build/reviews/review_style: The agent exited without reporting an outcome (exit code 3).");
    const runs = await w.runsEnded(node.id, 3);
    expect(runs.find((run) => run.branch === "build/reviews/review_tests")?.end_reason).toBe("stopped");
  });
});
