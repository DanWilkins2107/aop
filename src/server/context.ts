import { readFileSync } from "node:fs";
import type { AopConfig } from "./config.js";
import type { Db } from "./db.js";
import { getNode, listLinks, listMessages, type NodeRow } from "./nodes.js";
import { getProject } from "./projects.js";

interface Neighbour {
  id: string;
  title: string;
  stage: string;
}

const line = (node: Neighbour) => `- ${node.id} [${node.stage}] ${node.title}`;

function neighbours(db: Db, sql: string, id: string): Neighbour[] {
  return db.prepare(sql).all({ id }) as Neighbour[];
}

const ANCESTORS = `
  WITH RECURSIVE up(id, depth) AS (
    SELECT source_id, 1 FROM edges WHERE target_id = @id AND kind = 'subtask' AND removed_at IS NULL
    UNION
    SELECT e.source_id, u.depth + 1 FROM edges e JOIN up u ON e.target_id = u.id
     WHERE e.kind = 'subtask' AND e.removed_at IS NULL
  )
  SELECT n.id, n.title, n.stage FROM nodes n JOIN up ON up.id = n.id
   GROUP BY n.id ORDER BY max(up.depth) DESC`;

const CHILDREN = `
  SELECT n.id, n.title, n.stage FROM edges e JOIN nodes n ON n.id = e.target_id
   WHERE e.source_id = @id AND e.kind = 'subtask' AND e.removed_at IS NULL ORDER BY e.rowid`;

const SIBLINGS = `
  SELECT DISTINCT n.id, n.title, n.stage FROM edges up
    JOIN edges down ON down.source_id = up.source_id AND down.kind = 'subtask' AND down.removed_at IS NULL
    JOIN nodes n ON n.id = down.target_id
   WHERE up.target_id = @id AND up.kind = 'subtask' AND up.removed_at IS NULL AND n.id <> @id`;

const BLOCKED_BY = `
  SELECT n.id, n.title, n.stage FROM edges e JOIN nodes n ON n.id = e.source_id
   WHERE e.target_id = @id AND e.kind = 'blocks' AND e.removed_at IS NULL ORDER BY e.rowid`;

const BLOCKS = `
  SELECT n.id, n.title, n.stage FROM edges e JOIN nodes n ON n.id = e.target_id
   WHERE e.source_id = @id AND e.kind = 'blocks' AND e.removed_at IS NULL ORDER BY e.rowid`;

function section(title: string, body: string[]): string[] {
  return body.length === 0 ? [] : [`## ${title}`, ...body, ""];
}

/**
 * What `aop context` prints: where a node sits in the tree and what's known about it. The prompt of
 * every launched agent includes the same text, so this is the one place that writes it.
 */
export function nodeContext(db: Db, nodeId: string): string {
  const node = getNode(db, nodeId);
  const project = getProject(db, node.project_id);

  const moves: string[] = [];
  if (node.stage === "splitting") {
    moves.push(
      `A split is in progress, begun from ${node.return_stage}. Don't run \`aop split start\` again.`,
      "Any children listed above already exist, so carry on from them rather than recreating them.",
      "Finish with `aop split finish`.",
    );
  } else if (node.turn === "agent") {
    moves.push(...node.available_outcomes.map(({ outcome, target }) => `- \`aop next ${outcome}\` moves this node to ${target}`));
    moves.push("- `aop split start` then `aop split finish` holds new children until the split is done");
  } else {
    moves.push(`This node is at ${node.stage}, where no agent command moves it.`);
  }
  if (node.turn === "agent") {
    moves.push(
      '- `aop ask "..."` asks a human, and this stage starts again with the answer',
      '- `aop fail "<reason>"` marks this node failed, only when the work can\'t be done and asking won\'t help',
    );
  }

  const messages = listMessages(db, nodeId).map((m) => `[${m.author}, ${m.stage}, ${m.created_at}]\n${m.body}`);

  return [
    `# ${node.title}`,
    "",
    `Node: ${node.id}`,
    `Project: ${project.name}`,
    `Type: ${node.type}`,
    `Stage: ${node.stage}`,
    ...(node.invalidation_reason !== null ? [`Invalidated because: ${node.invalidation_reason}`] : []),
    ...(node.invalidated_by_parent && node.stage !== "invalidated" ? ["Invalidated by a parent."] : []),
    ...(node.held ? ["Held: a parent is still splitting."] : []),
    "",
    ...section("Ancestors, from the root down", neighbours(db, ANCESTORS, nodeId).map(line)),
    ...section("Children", neighbours(db, CHILDREN, nodeId).map(line)),
    ...section("Siblings", neighbours(db, SIBLINGS, nodeId).map(line)),
    ...section("Blocked by", neighbours(db, BLOCKED_BY, nodeId).map(line)),
    ...section("Blocks", neighbours(db, BLOCKS, nodeId).map(line)),
    ...section("Description", node.body === "" ? [] : [node.body]),
    ...section("Messages, oldest first", messages),
    ...section("Links", listLinks(db, nodeId).map((link) => `- ${link.kind}: ${link.url}`)),
    ...section("Moving on", moves),
  ]
    .join("\n")
    .trimEnd();
}

const LOAD_SKILLS =
  "Before doing anything else, load the `aop-context` and `aop-rulebook` skills from the AOP plugin, and follow them.";

/** The stage whose prompt a run on this node uses. A resumed split restarts the stage that began it. */
function promptStage(node: NodeRow): string {
  return node.stage === "splitting" ? (node.return_stage ?? node.stage) : node.stage;
}

/** Everything a launched agent gets on stdin. Throws if the stage's prompt can't be read. */
export function buildPrompt(db: Db, config: Pick<AopConfig, "graph">, node: NodeRow): string {
  const stage = promptStage(node);
  const promptFile = config.graph.stages.get(stage)?.prompt;
  if (promptFile === undefined) throw new Error(`Stage "${stage}" has no prompt in stages.yaml`);
  return [LOAD_SKILLS, nodeContext(db, node.id), readFileSync(promptFile, "utf8").trimEnd()].join("\n\n") + "\n";
}
