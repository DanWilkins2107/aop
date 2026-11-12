import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ApplyResult } from "../shared/api/types.js";
import { isBuiltIn } from "../shared/domain/builtInStages.js";
import { type AopConfig, loadConfig } from "./config.js";
import type { Db } from "./db.js";
import { type ApiError, refused } from "./errors.js";
import { allowedTarget, isStale, proposalRows, revisionOf } from "./improvements.js";
import { getNodeRow, graphFor, graphsOf, markSavedLocally, turnOf } from "./nodes.js";
import { appendEvent, newId, type Actor } from "./records.js";

/**
 * Saves an improvement's proposals to their real files and finishes it, as one action a human takes
 * from a human stage of the improvement pipeline. Agents can't change proposals at a human stage, and
 * no agent runs between the review and the write, so what is written is what the human reviewed.
 * `reviewed` is what their page showed, and the proposals must still match it. Every path is checked
 * again first, and nothing is written if any check fails.
 */
export function applyProposals(
  db: Db,
  nodeId: string,
  input: { reviewed: { path: string; revision: string }[]; actor: Actor },
  config: AopConfig = loadConfig(),
): ApplyResult {
  if (input.actor !== "human") throw refused("Only a human can save an improvement's proposals to their real files");
  let failure: ApiError | undefined;
  // Immediate, so the database is already held for writing when the files are written.
  const written = db
    .transaction(() => {
      const node = getNodeRow(db, nodeId);
      if (node.kind !== "improvement") throw refused("Only improvements can be saved locally");
      if (isBuiltIn(node.stage) || turnOf(graphFor(graphsOf(config), node), node) !== "human") {
        throw refused(
          `Proposals are saved from a human stage of the improvement pipeline, and this improvement is at ${node.stage}`,
        );
      }
      const proposals = proposalRows(db, nodeId);
      if (proposals.length === 0) throw refused("Nothing to save: this improvement has no proposals");
      const seen = new Map(input.reviewed.map(({ path, revision }) => [path, revision]));
      if (seen.size !== proposals.length || proposals.some((proposal) => seen.get(proposal.path) !== revisionOf(proposal))) {
        throw refused("The proposals have changed since they were shown. Nothing was written. Review them again, then save");
      }
      // Writing a proposal over a file that changed since it was drafted would silently undo that change.
      const stale = proposals.filter(isStale).map((proposal) => proposal.path);
      if (stale.length > 0) {
        throw refused(
          `Changed since the proposal was drafted: ${stale.join(", ")}. Nothing was written. Redraft, or save the proposal again, against the current file`,
          { stale },
        );
      }

      const plan = proposals.map((proposal) => ({ target: allowedTarget(config, proposal.path), content: proposal.content }));
      const result = writeAll(plan);
      // The event and the move to done are recorded together. Files written before a failure are
      // still recorded, on a node that stays where it was.
      if (result.written.length > 0) appendEvent(db, nodeId, "human", "proposals_applied", { written: result.written });
      if (result.failure === undefined) markSavedLocally(db, node);
      failure = result.failure;
      return result.written;
    })
    .immediate();
  if (failure !== undefined) throw failure;
  return { written };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Writes every file in the plan. Each is written beside its target first, so a failure there, such
 * as a file where a folder should be, a full disk or no permission, leaves every real file as it
 * was, and is thrown. Only the renames after that can fail part way, and then the failure is returned
 * with what they did write, for the caller to record.
 */
function writeAll(plan: { target: string; content: string }[]): { written: string[]; failure?: ApiError } {
  const staged: { temp: string; target: string }[] = [];
  const discard = () => {
    for (const { temp } of staged) rmSync(temp, { force: true });
  };
  for (const { target, content } of plan) {
    const temp = `${target}.aop-${newId()}.tmp`;
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(temp, content, { flag: "wx" });
    } catch (error) {
      rmSync(temp, { force: true });
      discard();
      throw refused(`Couldn't write ${target}: ${errorText(error)}. Nothing was written`);
    }
    staged.push({ temp, target });
  }

  const written: string[] = [];
  for (const [i, { temp, target }] of staged.entries()) {
    try {
      renameSync(temp, target);
    } catch (error) {
      staged.splice(0, i);
      discard();
      const failure = refused(`Couldn't write ${target}: ${errorText(error)}. Written before it: ${written.join(", ") || "nothing"}`, {
        written,
      });
      return { written, failure };
    }
    written.push(target);
  }
  return { written };
}
