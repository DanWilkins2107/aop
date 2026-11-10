// The text agents read: `aop context` for a node, and the prompt each launched agent gets on stdin.

import { readFileSync } from "node:fs";
import { allPromptFiles, type AopConfig, loadConfig } from "./config.js";
import type { Db } from "./db.js";
import { ConfigError } from "./errors.js";
import { getImprovement, listProposals } from "./improvements.js";
import { getNode, graphFor, graphsOf, listLinks, listMessages, type NodeRow } from "./nodes.js";
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
 * What the `context` tool gives: where a node sits in the tree and what's known about it. The prompt
 * of every launched agent includes the same text, with its run ID, so this is the one place that
 * writes it.
 */
export function nodeContext(db: Db, nodeId: string, runId?: string): string {
  const node = getNode(db, nodeId);
  const where = node.kind === "improvement" ? "none. This is an improvement to how agents work" : getProject(db, node.project_id).name;

  const moves: string[] = [];
  if (node.stage === "splitting") {
    moves.push(
      `A split is in progress, begun from ${node.return_stage}. Don't use the \`split_start\` tool again.`,
      "Any children listed above already exist, so carry on from them rather than recreating them.",
      "Finish with the `split_finish` tool.",
    );
  } else if (node.turn === "agent") {
    moves.push(...node.available_outcomes.map(({ outcome, target }) => `- the \`next\` tool with outcome \`${outcome}\` moves this node to ${target}`));
    moves.push("- the `split_start` tool then the `split_finish` tool holds new children until the split is done");
  } else {
    moves.push(`This node is at ${node.stage}, where no agent tool moves it.`);
  }
  if (node.turn === "agent") {
    moves.push(
      "- the `ask` tool asks a human, and this stage starts again with the answer",
      "- the `fail` tool with a reason marks this node failed, only when the work can't be done and asking won't help",
    );
  }

  const messages = listMessages(db, nodeId).map((m) => `[${m.author}, ${m.stage}, ${m.created_at}]\n${m.body}`);

  return [
    `# ${node.title}`,
    "",
    `Node: ${node.id}`,
    ...(runId !== undefined ? [`Run: ${runId} (your run ID, which every write tool takes as \`run_id\`)`] : []),
    `Project: ${where}`,
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
    ...(node.kind === "improvement" ? improvementSections(db, nodeId) : []),
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

/** Where an improvement came from, what it may change, and what it proposes so far. */
function improvementSections(db: Db, nodeId: string): string[] {
  let config: AopConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) return section("What can change", ["Unknown while the AOP config is invalid."]);
    throw error;
  }
  const improvement = getImprovement(db, nodeId, config);
  const source = improvement.source;
  const prompts = allPromptFiles(config);
  return [
    ...section(
      "Source message",
      source === null
        ? []
        : [
            `From node ${source.node_id ?? "(deleted)"} "${source.node_title}"${source.project_name ? ` in project ${source.project_name}` : ""}:`,
            source.excerpt,
          ],
    ),
    ...section("What can change", [
      `- Files inside ${config.improvementsDir}, where you start`,
      ...prompts.map((path) => `- ${path}`),
      "Never edit them directly: the `propose` tool stores each change for review.",
      config.improvementsRepo === null
        ? "That folder isn't in a git repo, so Raise PR isn't offered."
        : `That folder is in the git repo ${config.improvementsRepo}.`,
    ]),
    ...section(
      "Proposed changes",
      listProposals(db, nodeId, config).map((p) => `- ${p.path} (${p.current === null ? "new file" : "changes the file"}, last by ${p.updated_by})`),
    ),
  ];
}

/** Everything a launched agent gets on stdin. Throws if the stage's prompt can't be read. */
export function buildPrompt(db: Db, config: AopConfig, node: NodeRow, runId: string): string {
  const stage = promptStage(node);
  const promptFile = graphFor(graphsOf(config), node).stages.get(stage)?.prompt;
  if (promptFile === undefined) throw new Error(`Stage "${stage}" has no prompt in its process file`);
  return [LOAD_SKILLS, nodeContext(db, node.id, runId), readFileSync(promptFile, "utf8").trimEnd()].join("\n\n") + "\n";
}
