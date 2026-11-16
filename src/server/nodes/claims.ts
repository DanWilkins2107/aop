// A node's one claim, taken and released by a human or an agent, and the agent turn it holds. This is
// the one file that writes `nodes.claimed_by` and a run's `left_*` columns: see columnOwnerGate.

import type { Db } from "../db/db.js";
import { refused } from "../shared/errors.js";
import type { EventDataByKind } from "../../shared/events/types.js";
import type { NodeView } from "../../shared/nodes/types.js";
import type { StageChangeVia } from "../../shared/stages/types.js";
import { appendEvent, newId, now, type Actor } from "../db/records.js";
import { currentGraphs, getNodeRow } from "./nodeCore.js";
import { viewOf } from "./nodeViews.js";

const holderName = (holder: "human" | "agent") => (holder === "agent" ? "an agent run" : "a human");

/**
 * Takes the node's one claim. A human can claim again, so that a session can be reopened, but
 * neither side can take a claim the other holds, and only one agent run can hold it.
 */
export function claim(db: Db, nodeId: string, input: { actor: "human" | "agent" }): NodeView {
  const graphs = currentGraphs();
  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    if (node.claimed_by === "human" && input.actor === "human") return;
    if (node.claimed_by !== null) throw refused(`Can't claim: ${holderName(node.claimed_by)} holds this node`);
    db.prepare("UPDATE nodes SET claimed_by = ? WHERE id = ?").run(input.actor, nodeId);
    appendEvent(db, nodeId, input.actor, "claim_taken", { holder: input.actor });
  })();
  return viewOf(db, graphs, nodeId);
}

/**
 * The open steered session on a node the human has claimed, started if there isn't one, so a reopened
 * session keeps its ID. Releasing the claim ends it: see the `steer_sessions` triggers.
 */
export function steerSessionFor(db: Db, nodeId: string): string {
  return db.transaction(() => {
    const open = db.prepare("SELECT id FROM steer_sessions WHERE node_id = ? AND ended_at IS NULL").get(nodeId) as
      | { id: string }
      | undefined;
    if (open) return open.id;
    const id = newId();
    db.prepare("INSERT INTO steer_sessions (id, created_at, node_id) VALUES (?, ?, ?)").run(id, now(), nodeId);
    return id;
  })();
}

/** The node of an open steered session, whose ID a caller sent as its run ID. */
export function openSteerSessionNode(db: Db, id: string): string | undefined {
  const row = db.prepare("SELECT node_id FROM steer_sessions WHERE id = ? AND ended_at IS NULL").get(id) as
    | { node_id: string }
    | undefined;
  return row?.node_id;
}

/** Each side releases its own claim. A human ends an agent's by stopping its run, not here. */
export function releaseClaim(db: Db, nodeId: string, input: { actor: "human" | "agent" }): NodeView {
  const graphs = currentGraphs();
  db.transaction(() => {
    const node = getNodeRow(db, nodeId);
    if (node.claimed_by === null) throw refused("Can't release: the node isn't claimed");
    if (node.claimed_by !== input.actor) {
      throw refused(`Can't release: the claim belongs to ${holderName(node.claimed_by)}`);
    }
    db.prepare("UPDATE nodes SET claimed_by = NULL WHERE id = ?").run(nodeId);
    appendEvent(db, nodeId, input.actor, "claim_released", { holder: input.actor });
  })();
  return viewOf(db, graphs, nodeId);
}

/** Takes the claim for an agent run. Refused, with nothing written, if anything holds it. */
export function takeAgentClaim(db: Db, nodeId: string, runId: string): void {
  const claimed = db.prepare("UPDATE nodes SET claimed_by = 'agent' WHERE id = ? AND claimed_by IS NULL").run(nodeId);
  if (claimed.changes !== 1) throw refused(`Node ${nodeId} is already claimed, so no run can start on it`);
  appendEvent(db, nodeId, "system", "claim_taken", { holder: "agent", run_id: runId });
}

/** Gives up an agent's claim, leaving the node where it is. */
export function releaseAgentClaim(
  db: Db,
  nodeId: string,
  via: NonNullable<EventDataByKind["claim_released"]["via"]>,
): void {
  const released = db.prepare("UPDATE nodes SET claimed_by = NULL WHERE id = ? AND claimed_by = 'agent'").run(nodeId);
  if (released.changes > 0) appendEvent(db, nodeId, "system", "claim_released", { holder: "agent", via });
}

/**
 * A run a human stopped hands them the node. The node stays on its stage and isn't queued, because
 * the human's claim holds it, until they release that claim to start the stage again.
 */
export function handClaimToHuman(db: Db, nodeId: string): void {
  releaseAgentClaim(db, nodeId, "stop");
  db.prepare("UPDATE nodes SET claimed_by = 'human' WHERE id = ? AND claimed_by IS NULL").run(nodeId);
  appendEvent(db, nodeId, "human", "claim_taken", { holder: "human", via: "stop" });
}

/**
 * A stage change ends the agent's turn on the node: its claim goes, and its running runs are marked
 * as having left, which is how the orchestrator finds out. Call in the stage change's transaction.
 */
export function endAgentTurn(db: Db, nodeId: string, via: StageChangeVia, actor: Actor): void {
  releaseAgentClaim(db, nodeId, via);
  db.prepare(
    `UPDATE runs SET left_via = ?, left_actor = ?, left_at = ?
      WHERE node_id = ? AND status = 'running' AND left_via IS NULL`,
  ).run(via, actor, now(), nodeId);
}

/** One branch's run reported its outcome and leaves. The node's claim stays with its other branches. */
export function endBranchTurn(db: Db, runId: string): void {
  db.prepare("UPDATE runs SET left_via = 'next', left_actor = 'agent', left_at = ? WHERE id = ?").run(now(), runId);
}
