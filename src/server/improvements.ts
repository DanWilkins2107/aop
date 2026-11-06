import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  ImprovementDetail,
  ImprovementSource,
  ImprovementsList,
  ImprovementView,
  MessageRow,
  NodeRow,
  ProposalView,
} from "../shared/api.js";
import { type AopConfig, loadConfig } from "./config.js";
import type { Db } from "./db.js";
import { ApiError, badRequest, notFound, refused } from "./errors.js";
import { createNode, getNode, getNodeRow, viewsOf } from "./nodes.js";
import { aopHome, configPath, dbPath, isWithin } from "./paths.js";
import { ensureImprovementsProject, IMPROVEMENTS_PROJECT_ID } from "./projects.js";
import { appendEvent, newId, now, type Actor } from "./records.js";
import { promptFiles } from "./stages.js";

const TITLE_LENGTH = 80;
const EXCERPT_LENGTH = 2000;

/** Stages where an improvement is finished, so its proposals can't change. */
const CLOSED_STAGES = ["done", "invalidated"];

interface ImprovementRow {
  id: string;
  created_at: string;
  node_id: string;
  source_node_id: string | null;
  source_message_id: string | null;
  source_excerpt: string | null;
  source_node_title: string | null;
}

interface ProposalRow {
  id: string;
  created_at: string;
  node_id: string;
  path: string;
  content: string;
  updated_at: string;
  updated_by: "human" | "agent";
}

/** The first line, cut to fit a title. */
export function titleFrom(text: string): string {
  const first = text.trim().split(/\r?\n/)[0]?.trim() ?? "";
  const chars = [...first];
  return chars.length <= TITLE_LENGTH ? first : `${chars.slice(0, TITLE_LENGTH - 1).join("").trimEnd()}…`;
}

const cut = (text: string, length: number) => {
  const chars = [...text];
  return chars.length <= length ? text : `${chars.slice(0, length - 1).join("")}…`;
};

/** Captures an improvement, from a message or from nothing. It enters the improvement pipeline at its start. */
export function createImprovement(
  db: Db,
  input: { body: string; source_message_id?: string | undefined; actor: Actor },
): ImprovementView {
  const body = input.body.trim();
  if (body === "") throw badRequest("An improvement needs some text");

  let source: { message: MessageRow; node: NodeRow } | null = null;
  if (input.source_message_id !== undefined) {
    const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(input.source_message_id) as MessageRow | undefined;
    if (!message) throw notFound(`No message ${input.source_message_id}`);
    const node = getNodeRow(db, message.node_id);
    if (node.kind !== "work") throw refused("Improvements come from messages on project nodes, not on other improvements");
    source = { message, node };
  }

  const nodeId = db.transaction(() => {
    ensureImprovementsProject(db);
    const node = createNode(db, IMPROVEMENTS_PROJECT_ID, { title: titleFrom(body), body, actor: input.actor }, "improvement");
    db.prepare(
      `INSERT INTO improvements (id, created_at, node_id, source_node_id, source_message_id, source_excerpt, source_node_title)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId(),
      now(),
      node.id,
      source?.node.id ?? null,
      source?.message.id ?? null,
      source === null ? null : cut(source.message.body, EXCERPT_LENGTH),
      source?.node.title ?? null,
    );
    if (source !== null) {
      appendEvent(db, node.id, input.actor, "improvement_sourced", {
        node_id: source.node.id,
        message_id: source.message.id,
      });
      appendEvent(db, source.node.id, input.actor, "improvement_captured", {
        improvement_id: node.id,
        message_id: source.message.id,
      });
    }
    return node.id;
  })();
  return improvementView(db, nodeId);
}

function improvementRow(db: Db, nodeId: string): ImprovementRow {
  const row = db.prepare("SELECT * FROM improvements WHERE node_id = ?").get(nodeId) as ImprovementRow | undefined;
  if (!row) throw notFound(`No improvement ${nodeId}`);
  return row;
}

function sourceOf(db: Db, row: ImprovementRow): ImprovementSource | null {
  if (row.source_excerpt === null || row.source_node_title === null) return null;
  const project =
    row.source_node_id === null
      ? undefined
      : (db
          .prepare("SELECT p.id, p.name FROM nodes n JOIN projects p ON p.id = n.project_id WHERE n.id = ?")
          .get(row.source_node_id) as { id: string; name: string } | undefined);
  return {
    node_id: row.source_node_id,
    message_id: row.source_message_id,
    project_id: project?.id ?? null,
    excerpt: row.source_excerpt,
    node_title: row.source_node_title,
    project_name: project?.name ?? null,
  };
}

const proposalCount = (db: Db, nodeId: string) =>
  (db.prepare("SELECT count(*) AS n FROM proposals WHERE node_id = ?").get(nodeId) as { n: number }).n;

function improvementView(db: Db, nodeId: string): ImprovementView {
  const row = improvementRow(db, nodeId);
  return { node: getNode(db, nodeId), source: sourceOf(db, row), proposal_count: proposalCount(db, nodeId) };
}

/** The Improvements tab: every improvement, newest first. */
export function listImprovements(db: Db, config: AopConfig = loadConfig()): ImprovementsList {
  const rows = db.prepare("SELECT * FROM improvements ORDER BY rowid DESC").all() as ImprovementRow[];
  const nodes = viewsOf(
    db,
    rows.map((row) => getNodeRow(db, row.node_id)),
  );
  return {
    enabled: config.improvementGraph !== null,
    note:
      config.improvementGraph === null
        ? 'Improvements are off. Add "improvement_stages: ./improvement_stages.yaml" to config.yaml; `aop init --fill-missing` copies the default file.'
        : null,
    improvements: rows.map((row, i) => ({
      node: nodes[i]!,
      source: sourceOf(db, row),
      proposal_count: proposalCount(db, row.node_id),
    })),
  };
}

export function getImprovement(db: Db, nodeId: string, config: AopConfig = loadConfig()): ImprovementDetail {
  return {
    ...improvementView(db, nodeId),
    improvements_dir: config.improvementsDir,
    raise_pr_available: config.improvementsRepo !== null,
  };
}

/** A path with symlinks resolved, including for a file that doesn't exist yet. */
export function canonicalPath(path: string): string {
  let dir = resolve(path);
  const rest: string[] = [];
  while (!existsSync(dir)) {
    const up = dirname(dir);
    if (up === dir) break;
    rest.unshift(basename(dir));
    dir = up;
  }
  try {
    return join(realpathSync.native(dir), ...rest);
  } catch {
    return resolve(path);
  }
}

export const notAllowed = (message: string) => new ApiError(400, "path_not_allowed", message);

/** Refuses AOP's own config, process files, database and logs, wherever they are. `target` must be canonical. */
export function assertNotAopState(config: AopConfig, target: string): void {
  const home = aopHome();
  const forbidden = [configPath(home), config.stagesPath, config.improvementStagesPath, dbPath(), `${dbPath()}-wal`, `${dbPath()}-shm`]
    .filter((file): file is string => file !== null)
    .map(canonicalPath);
  if (forbidden.some((file) => isWithin(target, file)) || isWithin(target, canonicalPath(join(home, "logs")))) {
    throw notAllowed(`Improvements can never change ${target}: it's AOP's own config or state`);
  }
}

/**
 * Checks a file an improvement may change, returning it with symlinks resolved. Allowed: files inside
 * `improvements_path`, and the agent stages' prompt files. Never AOP's own config, process files,
 * database or logs, wherever they are.
 */
export function allowedTarget(config: AopConfig, path: string): string {
  if (!isAbsolute(path)) throw notAllowed(`The path must be a full path: ${path}`);
  const target = canonicalPath(path);
  assertNotAopState(config, target);
  if (existsSync(target) && !statSync(target).isFile()) throw notAllowed(`${target} isn't a file`);

  const prompts = [...promptFiles(config.graph), ...(config.improvementGraph ? promptFiles(config.improvementGraph) : [])].map(
    canonicalPath,
  );
  if (prompts.includes(target)) return target;
  const folder = canonicalPath(config.improvementsDir);
  if (target !== folder && isWithin(target, folder)) return target;
  throw notAllowed(`${target} is outside ${config.improvementsDir}, and isn't a stage prompt. Improvements can only change those`);
}

function displayPath(config: AopConfig, path: string): string {
  const folder = canonicalPath(config.improvementsDir);
  return isWithin(path, folder) ? relative(folder, path).replaceAll("\\", "/") : path;
}

function readCurrent(path: string): string | null {
  try {
    return statSync(path).isFile() ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

export function proposalRows(db: Db, nodeId: string): ProposalRow[] {
  return db.prepare("SELECT * FROM proposals WHERE node_id = ? ORDER BY path").all(nodeId) as ProposalRow[];
}

/** Every proposed file, with what's in the real file now. */
export function listProposals(db: Db, nodeId: string, config: AopConfig = loadConfig()): ProposalView[] {
  improvementRow(db, nodeId);
  return proposalRows(db, nodeId).map((row) => ({
    id: row.id,
    path: row.path,
    display_path: displayPath(config, row.path),
    proposed: row.content,
    current: readCurrent(row.path),
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  }));
}

/** An improvement whose proposals can change now, by this actor. */
function assertCanPropose(db: Db, nodeId: string, actor: Actor): NodeRow {
  const node = getNodeRow(db, nodeId);
  if (node.kind !== "improvement") throw refused("Only improvements have proposals");
  if (CLOSED_STAGES.includes(node.stage)) throw refused(`Can't change proposals: the improvement is ${node.stage}`);
  if (actor === "agent" && getNode(db, nodeId).turn !== "agent") {
    throw refused(`Stage "${node.stage}" is a human turn, so an agent can't change the proposals`);
  }
  return node;
}

/** Stores what a file should become. Never touches the file itself. */
export function propose(
  db: Db,
  nodeId: string,
  input: { path: string; content: string; actor: Actor },
  config: AopConfig = loadConfig(),
): ProposalView {
  const actor = input.actor === "agent" ? "agent" : "human";
  const path = allowedTarget(config, input.path);
  db.transaction(() => {
    assertCanPropose(db, nodeId, input.actor);
    const at = now();
    db.prepare(
      `INSERT INTO proposals (id, created_at, node_id, path, content, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (node_id, path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    ).run(newId(), at, nodeId, path, input.content, at, actor);
    appendEvent(db, nodeId, input.actor, "proposal_saved", { path });
  })();
  const saved = listProposals(db, nodeId, config).find((proposal) => proposal.path === path);
  if (!saved) throw new Error(`Proposal for ${path} wasn't saved`);
  return saved;
}

export function withdraw(db: Db, nodeId: string, input: { path: string; actor: Actor }): { path: string } {
  if (!isAbsolute(input.path)) throw notAllowed(`The path must be a full path: ${input.path}`);
  const path = canonicalPath(input.path);
  db.transaction(() => {
    assertCanPropose(db, nodeId, input.actor);
    const removed = db.prepare("DELETE FROM proposals WHERE node_id = ? AND path = ?").run(nodeId, path);
    if (removed.changes === 0) throw notFound(`No proposal for ${path}`);
    appendEvent(db, nodeId, input.actor, "proposal_withdrawn", { path });
  })();
  return { path };
}
