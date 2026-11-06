// A node's one claim, taken and released by a human or an agent. A stage change drops an agent's
// claim in `applyStageChange`, and `beginRun` takes one with its run.

import type { Db } from "./db.js";
import { refused } from "./errors.js";
import type { NodeView } from "../shared/api.js";
import { appendEvent } from "./records.js";
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
