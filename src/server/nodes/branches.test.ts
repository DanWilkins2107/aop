import { beforeEach, describe, expect, it } from "vitest";
import { listBranches, startableBranches } from "./branches.js";
import { currentGraphs } from "./nodeCore.js";
import { getNodeRow, markFailed, next, retry, startableNodes, type NodeView } from "./nodes.js";
import { beginBranchRun, closeRun, getRun, otherRunningRuns, releaseAgentClaim } from "../runs/runs.js";
import { harness, type Harness } from "../../../test-shared/harness.js";

const PROMPTS = ["implement", "review_tests", "review_style"];

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
  checks:
    start: run_checks
    stages:
      run_checks: { parallel: [review_tests, quick_fix], next: { done: pr_review } }
      pr_review: { next: { approved: done } }
  quick_fix:
    start: implement
    stages:
      implement: { next: { done: done } }
`;

let h: Harness;
/** Each running branch's run, by branch path. */
let runs: Map<string, string>;
let launched = 0;

beforeEach(() => {
  h = harness({ "stages.yaml": STAGES, ...Object.fromEntries(PROMPTS.map((p) => [`prompts/${p}.md`, `Do ${p}.`])) });
  runs = new Map();
});

/** Opens a run on every branch that's ready, as the orchestrator does. Returns their paths. */
function launch(): string[] {
  const started: string[] = [];
  for (const { node, branch } of startableBranches(h.db, currentGraphs())) {
    const id = `run-${++launched}`;
    beginBranchRun(h.db, node, { id, branchId: branch.id, branch: branch.path, stage: branch.stage, logPath: `${id}.log` });
    runs.set(branch.path, id);
    started.push(branch.path);
  }
  return started.sort();
}

/** A branch's run reports its outcome, then exits. */
function report(nodeId: string, path: string, outcome: string): NodeView {
  const runId = runs.get(path);
  if (runId === undefined) throw new Error(`No run on ${path}`);
  next(h.db, nodeId, { outcome, actor: "agent", runId });
  exit(runId, "reported");
  runs.delete(path);
  return { ...getNodeRow(h.db, nodeId) } as NodeView;
}

/** A run's process ending. The last of a node's branch runs gives up its claim, as the orchestrator does. */
function exit(runId: string, reason: "reported" | "failed"): void {
  const run = getRun(h.db, runId)!;
  closeRun(h.db, run, reason, 0);
  if (otherRunningRuns(h.db, run.node_id, run.id).length === 0) releaseAgentClaim(h.db, run.node_id, "next");
}

const branchesOf = (nodeId: string) =>
  Object.fromEntries(listBranches(h.db, nodeId).map((b) => [b.path, { stage: b.stage, outcome: b.outcome, loops: JSON.parse(b.loops) as unknown }]));

describe("a sub-workflow with a gated parallel group", () => {
  it("runs the sequence, then the group, then moves the node on with the sub-workflow's outcome", async () => {
    const node = await h.create("dev");
    expect(node).toMatchObject({ stage: "build", turn: "agent" });
    // The node's own stage runs no agent: its branches do.
    expect(startableNodes(h.db, currentGraphs()).map((n) => n.id)).not.toContain(node.id);

    expect(launch()).toEqual(["build/implement"]);
    expect(branchesOf(node.id)).toEqual({
      build: { stage: "implement", outcome: null, loops: { implement: 1 } },
      "build/implement": { stage: "implement", outcome: null, loops: {} },
    });
    expect(getNodeRow(h.db, node.id).claimed_by).toBe("agent");

    report(node.id, "build/implement", "done");
    expect(launch()).toEqual(["build/reviews/review_style", "build/reviews/review_tests"]);
    expect(branchesOf(node.id)["build"]).toMatchObject({ stage: "reviews", loops: { implement: 1, reviews: 1 } });

    // One branch finishing leaves the others running.
    expect(report(node.id, "build/reviews/review_tests", "pass").stage).toBe("build");
    expect(getRun(h.db, runs.get("build/reviews/review_style")!)?.left_via).toBeNull();
    expect(launch()).toEqual([]);

    const done = report(node.id, "build/reviews/review_style", "pass");
    expect(done.stage).toBe("pr_review");
    expect(listBranches(h.db, node.id)).toEqual([]);
  });

  it("loops back on a failed gate, and ends exhausted past max_loops", async () => {
    const node = await h.create("dev");
    const round = (outcomes: [string, string]) => {
      launch();
      report(node.id, "build/implement", "done");
      launch();
      report(node.id, "build/reviews/review_tests", outcomes[0]);
      return report(node.id, "build/reviews/review_style", outcomes[1]);
    };

    expect(round(["pass", "fail"]).stage).toBe("build");
    expect(branchesOf(node.id)["build"]).toMatchObject({ stage: "implement", loops: { implement: 2, reviews: 1 } });
    // The third entry to reviews is past its max_loops of 2.
    expect(round(["fail", "pass"]).stage).toBe("build");
    launch();
    const exhausted = report(node.id, "build/implement", "done");
    expect(exhausted.stage).toBe("stuck");
  });

  it("refuses an outcome the branch can't end with", async () => {
    const node = await h.create("dev");
    launch();
    report(node.id, "build/implement", "done");
    launch();
    expect(() => next(h.db, node.id, { outcome: "done", actor: "agent", runId: runs.get("build/reviews/review_tests")! })).toThrow(
      /isn't available on branch build\/reviews\/review_tests/,
    );
  });
});

describe("a parallel group without a gate", () => {
  it("finishes with done once every branch has, a type branch running its whole sub-workflow", async () => {
    const node = await h.create("checks");
    expect(launch()).toEqual(["run_checks/quick_fix/implement", "run_checks/review_tests"]);
    expect(report(node.id, "run_checks/quick_fix/implement", "done").stage).toBe("run_checks");
    expect(branchesOf(node.id)["run_checks/quick_fix"]).toMatchObject({ outcome: "done" });
    expect(report(node.id, "run_checks/review_tests", "done").stage).toBe("pr_review");
  });
});

describe("when a branch goes wrong", () => {
  it("keeps the branches through failed, and a retry restarts only the unfinished ones", async () => {
    const node = await h.create("checks");
    launch();
    report(node.id, "run_checks/review_tests", "done");
    const crashed = runs.get("run_checks/quick_fix/implement")!;
    h.db.transaction(() => {
      exit(crashed, "failed");
      markFailed(h.db, getNodeRow(h.db, node.id), { reason: "Branch run_checks/quick_fix/implement: crashed", runId: crashed });
    })();
    runs.clear();
    expect(getNodeRow(h.db, node.id)).toMatchObject({ stage: "failed", return_stage: "run_checks" });
    expect(launch()).toEqual([]);

    retry(h.db, node.id);
    expect(launch()).toEqual(["run_checks/quick_fix/implement"]);
    expect(report(node.id, "run_checks/quick_fix/implement", "done").stage).toBe("pr_review");
  });

  it("starts afresh when a human moves the node", async () => {
    const node = await h.create("checks");
    launch();
    report(node.id, "run_checks/review_tests", "done");
    await h.post(node.id, "move", { stage: "pr_review" });
    expect(listBranches(h.db, node.id)).toEqual([]);
    await h.post(node.id, "move", { stage: "run_checks" });
    expect(launch()).toEqual(["run_checks/quick_fix/implement", "run_checks/review_tests"]);
  });

  it("doesn't start branches on a node a human holds", async () => {
    const node = await h.create("checks");
    await h.post(node.id, "claim", { actor: "human" });
    expect(launch()).toEqual([]);
  });
});
