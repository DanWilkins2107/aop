import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { ApplyResult } from "../shared/api.js";
import { type AopConfig, loadConfig } from "./config.js";
import type { Db } from "./db.js";
import { badRequest, refused } from "./errors.js";
import { allowedTarget, canonicalPath, proposalRows } from "./improvements.js";
import { getNodeRow, RAISE_PR_STAGE } from "./nodes.js";
import { isWithin } from "./paths.js";
import { appendEvent, type Actor } from "./records.js";

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
      plan.push({ target: join(into, relative(repo, real)), content: proposal.content });
    }
  }

  for (const { target, content } of plan) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const written = plan.map(({ target }) => target);
  db.transaction(() =>
    appendEvent(db, nodeId, input.actor, "proposals_applied", { written, skipped, into: input.into ?? null }),
  )();
  return { written, skipped };
}
