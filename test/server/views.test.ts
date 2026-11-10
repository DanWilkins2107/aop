import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";
import { getNode, graphsOf, holdersOf, listNodes, startableNodes, viewsOf, type NodeRow, type NodeView } from "../../src/server/nodes.js";
import { addProject, IMPROVEMENTS_PROJECT_ID } from "../../src/server/projects.js";
import { beginRun, closeRun, releaseAgentClaim } from "../../src/server/runs.js";
import type { ImprovementView } from "../../src/shared/api.js";
import { ROOT } from "./agents.helpers.js";
import { CONFIG_YAML, harness, makeRepo, STAGES_YAML, type Harness } from "./helpers.js";

/** A harness with the default improvement pipeline turned on. */
function withImprovements(): Harness {
  return harness({
    "config.yaml": `${CONFIG_YAML}improvement_stages: ./improvement_stages.yaml\n`,
    "improvement_stages.yaml": readFileSync(join(ROOT, "defaults", "improvement_stages.yaml"), "utf8"),
    "prompts/draft_change.md": "Draft it.",
    "prompts/raise_pr.md": "Raise it.",
  });
}

/** A graph with every kind of holder, and the near misses that aren't holders. */
async function variedGraph(h: Harness) {
  const created = new Map<string, NodeView>();
  const make = async (name: string, type: string, extra: Record<string, unknown> = {}) => {
    const node = await h.create(type, { title: name, ...extra });
    created.set(name, node);
    return node.id;
  };
  const ok = async (id: string, action: string, body?: unknown) => {
    const res = await h.post(id, action, body);
    if (res.status !== 200) throw new Error(`${action} failed: ${JSON.stringify(res.body)}`);
  };
  const edge = async (source: string, target: string, kind: "blocks" | "subtask") => {
    const res = await h.call<{ id: string }>("POST", `/api/nodes/${source}/edges`, { target_id: target, kind });
    if (res.status !== 201) throw new Error(`edge failed: ${JSON.stringify(res.body)}`);
    return res.body.id;
  };

  // Split holders: splitting, asked while splitting, and blocked from a question asked while splitting.
  const splitter = await make("splitter", "triage");
  await ok(splitter, "split/start");
  await make("split child", "dev", { parent_id: splitter });
  await make("split child 2", "hotfix", { parent_id: splitter });
  const asker = await make("asker", "triage");
  await ok(asker, "split/start");
  await make("asker child", "dev", { parent_id: asker });
  await ok(asker, "ask", { question: "Which way?" });
  const blockedSplitter = await make("blocked splitter", "triage");
  await ok(blockedSplitter, "split/start");
  await make("blocked splitter child", "dev", { parent_id: blockedSplitter });
  await ok(blockedSplitter, "ask", { question: "Which way?" });
  await ok(blockedSplitter, "block", { reason: "Waiting on legal" });
  // Blocked from a question that wasn't asked while splitting: no hold.
  const blockedAsker = await make("blocked asker", "dev");
  await ok(blockedAsker, "ask", { question: "Which way?" });
  await ok(blockedAsker, "block", { reason: "Waiting on legal" });
  await edge(blockedAsker, await make("blocked asker child", "dev"), "subtask");
  // Failed while splitting, then blocked.
  const failer = await make("failer", "triage");
  await ok(failer, "split/start");
  await make("failer child", "dev", { parent_id: failer });
  await ok(failer, "fail", { reason: "Crashed" });
  await ok(failer, "block", { reason: "Waiting" });

  // Blocks: one live, one done, one invalidated, one removed.
  const target = await make("blocked target", "dev");
  const liveBlocker = await make("live blocker", "hotfix");
  const doneBlocker = await make("done blocker", "hotfix");
  const invalidBlocker = await make("invalidated blocker", "hotfix");
  const removedBlocker = await make("removed blocker", "hotfix");
  await edge(liveBlocker, target, "blocks");
  await edge(doneBlocker, target, "blocks");
  await edge(invalidBlocker, target, "blocks");
  const removed = await edge(removedBlocker, target, "blocks");
  await h.call("DELETE", `/api/edges/${removed}`, {});
  await ok(doneBlocker, "move", { stage: "done" });
  await ok(invalidBlocker, "invalidate", { reason: "Not needed" });
  await edge(target, await make("downstream", "dev"), "blocks");

  // Invalidated ancestors: two of them over a diamond, made out of rowid order, plus an invalidated node itself.
  const lateGrand = await make("late grandparent", "dev");
  const grand = await make("grandparent", "dev");
  const left = await make("left", "dev", { parent_id: grand });
  const right = await make("right", "dev", { parent_id: grand });
  const leaf = await make("leaf", "dev");
  await edge(right, leaf, "subtask");
  await edge(left, leaf, "subtask");
  await edge(lateGrand, right, "subtask");
  await ok(grand, "invalidate", { reason: "Wrong idea" });
  await ok(lateGrand, "invalidate", { reason: "Also wrong" });
  await ok(left, "invalidate", { reason: "Wrong too" });
  await edge(leaf, await make("blocked by invalidated chain", "dev"), "blocks");

  // Runs: one running, one ended, one ended then running again.
  const running = await make("running", "dev");
  const ended = await make("ended", "dev");
  const again = await make("again", "hotfix");
  const nodeRow = (id: string) => h.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as never;
  beginRun(h.db, nodeRow(running), "run-running", h.repo + "/a.log");
  const end = (id: string, runId: string, log: string) => {
    closeRun(h.db, beginRun(h.db, nodeRow(id), runId, h.repo + log), "reported", 0);
    releaseAgentClaim(h.db, id, "stop");
  };
  end(ended, "run-ended", "/b.log");
  end(again, "run-first", "/c.log");
  beginRun(h.db, nodeRow(again), "run-second", h.repo + "/d.log");

  // Human stages, scheduled, claimed, and a stage the process no longer has.
  await ok(await make("reviewing", "dev"), "move", { stage: "spec_review" });
  const nightly = await make("nightly", "nightly");
  await h.call("PUT", `/api/nodes/${nightly}/schedule`, { time: "03:00", days: [0, 1, 2, 3, 4, 5, 6] });
  await ok(await make("claimed", "dev"), "claim", { actor: "human" });
  const orphan = await make("orphan", "dev");
  await ok(orphan, "move", { stage: "pr_review" });
  h.rewriteStages(
    STAGES_YAML.replace("      pr_review:   { next: { merged: done, changes: implement } }\n", "").replace(
      "pr_raised: pr_review",
      "pr_raised: done",
    ),
  );

  // Another project, whose nodes must not leak in.
  const other = addProject(h.db, { repo_path: makeRepo() });
  const elsewhere = async (title: string) =>
    (await h.call<NodeView>("POST", `/api/projects/${other.id}/nodes`, { type: "dev", title })).body.id;
  const blocker = await elsewhere("elsewhere blocker");
  await edge(blocker, await elsewhere("elsewhere blocked"), "blocks");
  await elsewhere("elsewhere free");

  return { created, otherProjectId: other.id };
}

describe("batched node views", () => {
  it("lists a project's nodes exactly as getNode shows each one", async () => {
    const h = harness();
    await variedGraph(h);
    const listed = listNodes(h.db, h.projectId);
    const ids = (h.db.prepare("SELECT id FROM nodes WHERE project_id = ? ORDER BY rowid").all(h.projectId) as { id: string }[]).map(
      (row) => row.id,
    );
    expect(listed.map((node) => node.id)).toEqual(ids);
    expect(listed).toEqual(ids.map((id) => getNode(h.db, id)));

    // The graph really does have every case in it.
    const byTitle = new Map(listed.map((node) => [node.title, node]));
    const titleOf = (id: string) => listed.find((node) => node.id === id)?.title;
    expect(byTitle.get("split child")?.held_by.map(titleOf)).toEqual(["splitter"]);
    expect(byTitle.get("asker child")?.held).toBe(true);
    expect(byTitle.get("blocked splitter child")?.held).toBe(true);
    expect(byTitle.get("failer child")?.held).toBe(true);
    expect(byTitle.get("blocked asker child")?.held).toBe(false);
    expect(byTitle.get("blocked target")?.blocked_by.map(titleOf)).toEqual(["live blocker"]);
    expect(byTitle.get("leaf")?.invalidated_ancestors.map(titleOf)).toEqual(["late grandparent", "grandparent", "left"]);
    expect(byTitle.get("right")?.invalidated_ancestors.map(titleOf)).toEqual(["late grandparent", "grandparent"]);
    expect(byTitle.get("left")?.invalidated_ancestors.map(titleOf)).toEqual(["grandparent"]);
    expect(byTitle.get("running")?.run_id).toBe("run-running");
    expect(byTitle.get("ended")).toMatchObject({ run_id: null, last_run_id: "run-ended" });
    expect(byTitle.get("again")).toMatchObject({ run_id: "run-second", last_run_id: "run-second" });
    expect(byTitle.get("orphan")).toMatchObject({ stage_exists: false, turn: null });
  });

  it("an empty project lists nothing", () => {
    const h = harness();
    expect(listNodes(h.db, h.projectId)).toEqual([]);
  });

  it("finds the startable nodes that a node-by-node check finds", async () => {
    const h = harness();
    const { otherProjectId } = await variedGraph(h);
    const graphs = graphsOf(loadConfig());
    const all = [...listNodes(h.db, h.projectId), ...listNodes(h.db, otherProjectId)];
    const expected = all
      .filter(
        (node) =>
          node.claimed_by === null &&
          node.run_id === null &&
          node.turn === "agent" &&
          holdersOf(h.db, node.id).length === 0,
      )
      .map((node) => node.id);
    const found = startableNodes(h.db, graphs).map((node) => node.id);
    expect(found).toEqual(
      (h.db.prepare("SELECT id FROM nodes ORDER BY rowid").all() as { id: string }[])
        .map((row) => row.id)
        .filter((id) => expected.includes(id)),
    );
    expect(found.length).toBeGreaterThan(3);
  });

  it("keeps improvements out of a project's list, and shows them as getNode does", async () => {
    const h = withImprovements();
    const work = await h.create("dev", { title: "work" });
    const captured = [];
    for (const body of ["First idea", "Second idea"]) {
      captured.push((await h.call<ImprovementView>("POST", "/api/improvements", { body })).body.node);
    }
    const [first, second] = captured;
    // One moved on to a human stage, one left on its agent stage.
    expect((await h.post(first!.id, "next", { outcome: "drafted", actor: "agent" })).status).toBe(200);

    expect(listNodes(h.db, h.projectId).map((node) => node.id)).toEqual([work.id]);
    const rows = h.db.prepare("SELECT * FROM nodes WHERE kind = 'improvement' ORDER BY rowid").all() as NodeRow[];
    expect(rows.map((row) => row.project_id)).toEqual([IMPROVEMENTS_PROJECT_ID, IMPROVEMENTS_PROJECT_ID]);
    const ids = rows.map((row) => row.id);
    expect(viewsOf(h.db, rows)).toEqual(ids.map((id) => getNode(h.db, id)));
    expect(listNodes(h.db, IMPROVEMENTS_PROJECT_ID)).toEqual(ids.map((id) => getNode(h.db, id)));
    expect(getNode(h.db, first!.id).turn).toBe("human");

    // The agent's turn follows each node's own pipeline.
    const found = startableNodes(h.db, graphsOf(loadConfig())).map((node) => node.id);
    expect(found).toContain(second!.id);
    expect(found).not.toContain(first!.id);
  });
});
