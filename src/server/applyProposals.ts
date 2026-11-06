import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { ApplyResult } from "../shared/api.js";
import { type AopConfig, loadConfig } from "./config.js";
import type { Db } from "./db.js";
import { badRequest, refused } from "./errors.js";
import { allowedTarget, assertNotAopState, canonicalPath, isStale, notAllowed, proposalRows } from "./improvements.js";
import { getNodeRow, RAISE_PR_STAGE } from "./nodes.js";
import { isWithin } from "./paths.js";
import { appendEvent, newId, type Actor } from "./records.js";

/**
 * Checks a file in the other checkout. That checkout is the agent's to set up, so a symlink or
 * junction in it could point anywhere: the path is resolved, and must stay inside it.
 */
function exportTarget(config: AopConfig, into: string, target: string): string {
  const resolved = canonicalPath(target);
  if (!isWithin(resolved, into)) throw notAllowed(`${target} leads outside ${into}, through a link`);
  assertNotAopState(config, resolved);
  if (existsSync(resolved) && !statSync(resolved).isFile()) throw notAllowed(`${resolved} isn't a file`);
  return resolved;
}

/** The one stage where proposals are written to the real files. */
export const SAVE_LOCALLY_STAGE = "save_locally";

/**
 * Writes an improvement's proposals: to their real files at `save_locally`, or with `into`, at
 * `raise_pr`, to the same places in another checkout of the repo that holds `improvements_path`.
 * Every path is checked again first, and nothing is written if any check fails.
 */
export function applyProposals(
  db: Db,
  nodeId: string,
  input: { into?: string | undefined; actor: Actor },
  config: AopConfig = loadConfig(),
): ApplyResult {
  const node = getNodeRow(db, nodeId);
  if (node.kind !== "improvement") throw refused("Only improvements can be applied");
  const proposals = proposalRows(db, nodeId);
  if (proposals.length === 0) throw refused("Nothing to apply: this improvement has no proposals");
  // Writing a proposal over a file that changed since it was drafted would silently undo that change.
  const stale = proposals.filter(isStale).map((proposal) => proposal.path);
  if (stale.length > 0) {
    throw refused(
      `Changed since the proposal was drafted: ${stale.join(", ")}. Nothing was written. Redraft, or save the proposal again, against the current file`,
      { stale },
    );
  }

  const plan: { target: string; content: string }[] = [];
  const skipped: string[] = [];
  if (input.into === undefined) {
    if (node.stage !== SAVE_LOCALLY_STAGE) {
      throw refused(`Real files are written only at ${SAVE_LOCALLY_STAGE}, and this improvement is at ${node.stage}`);
    }
    for (const proposal of proposals) plan.push({ target: allowedTarget(config, proposal.path), content: proposal.content });
  } else {
    if (node.stage !== RAISE_PR_STAGE) {
      throw refused(`apply --into is only for ${RAISE_PR_STAGE}, and this improvement is at ${node.stage}`);
    }
    if (config.improvementsRepo === null) throw refused(`${config.improvementsDir} isn't inside a git repo`);
    if (!isAbsolute(input.into)) throw badRequest(`into must be a full path: ${input.into}`);
    const into = canonicalPath(input.into);
    const repo = canonicalPath(config.improvementsRepo);
    if (!existsSync(into) || !statSync(into).isDirectory() || !existsSync(join(into, ".git"))) {
      throw refused(`${into} isn't a git checkout. Make a worktree of ${repo} first`);
    }
    if (isWithin(into, repo) || isWithin(repo, into)) {
      throw refused(`${into} must be a separate checkout, outside ${repo}, such as a git worktree`);
    }
    for (const proposal of proposals) {
      const real = allowedTarget(config, proposal.path);
      if (!isWithin(real, repo)) {
        skipped.push(real);
        continue;
      }
      plan.push({ target: exportTarget(config, into, join(into, relative(repo, real))), content: proposal.content });
    }
  }

  const record = (written: string[]) =>
    db.transaction(() =>
      appendEvent(db, nodeId, input.actor, "proposals_applied", { written, skipped, into: input.into ?? null }),
    )();
  const written = writeAll(plan, record);
  return { written, skipped };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Writes every file in the plan. Each is written beside its target first, so a failure there, such
 * as a file where a folder should be, a full disk or no permission, leaves every real file as it
 * was. Only the renames after that can fail part way, and then what they did write is still
 * recorded before the failure is reported.
 */
function writeAll(plan: { target: string; content: string }[], record: (written: string[]) => void): string[] {
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
      if (written.length > 0) record(written);
      throw refused(`Couldn't write ${target}: ${errorText(error)}. Written before it: ${written.join(", ") || "nothing"}`, {
        written,
      });
    }
    written.push(target);
  }
  record(written);
  return written;
}
