interface Step {
  sql: string;
  /** For rebuilding a table that others point at, which foreign keys would otherwise refuse. */
  foreignKeysOff?: boolean;
}

/**
 * The schema's history, oldest first. A step's version is its place in this list, from 1, and is what
 * the database's `user_version` records. So only ever append: never edit, remove or reorder a step
 * that has shipped. Two branches that each add one get different versions however they merge.
 */
const steps: readonly Step[] = [
  {
    sql: `
CREATE TABLE projects (
  id         TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  name       TEXT NOT NULL,
  repo_path  TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE nodes (
  id                  TEXT PRIMARY KEY NOT NULL,
  created_at          TEXT NOT NULL,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title               TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body                TEXT NOT NULL DEFAULT '',
  type                TEXT NOT NULL,
  stage               TEXT NOT NULL,
  cron                TEXT,
  invalidation_reason TEXT,
  return_stage        TEXT,
  spawned_by          TEXT REFERENCES nodes(id) ON DELETE RESTRICT,
  CONSTRAINT nodes_scheduled_requires_cron
    CHECK (stage <> 'scheduled' OR (cron IS NOT NULL AND length(cron) > 0)),
  CONSTRAINT nodes_invalidated_requires_reason
    CHECK (stage <> 'invalidated' OR (invalidation_reason IS NOT NULL AND length(invalidation_reason) > 0)),
  CONSTRAINT nodes_waiting_requires_return_stage
    CHECK (stage NOT IN ('ask_human_question', 'failed') OR return_stage IS NOT NULL)
) STRICT;
CREATE INDEX nodes_project ON nodes(project_id);

CREATE TRIGGER nodes_no_delete BEFORE DELETE ON nodes
BEGIN SELECT RAISE(ABORT, 'nodes are never deleted'); END;

-- Edges rely on a node's project staying put.
CREATE TRIGGER nodes_project_immutable BEFORE UPDATE OF project_id ON nodes
WHEN NEW.project_id <> OLD.project_id
BEGIN SELECT RAISE(ABORT, 'a node cannot change project'); END;

CREATE TABLE edges (
  id         TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  source_id  TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  target_id  TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  kind       TEXT NOT NULL CHECK (kind IN ('subtask', 'blocks')),
  removed_at TEXT,
  CONSTRAINT edges_no_self_reference CHECK (source_id <> target_id)
) STRICT;
CREATE UNIQUE INDEX edges_unique_active ON edges(source_id, target_id, kind) WHERE removed_at IS NULL;
CREATE INDEX edges_target ON edges(target_id);

CREATE TRIGGER edges_same_project_insert BEFORE INSERT ON edges
WHEN (SELECT project_id FROM nodes WHERE id = NEW.source_id)
  IS NOT (SELECT project_id FROM nodes WHERE id = NEW.target_id)
BEGIN SELECT RAISE(ABORT, 'edge endpoints must share a project'); END;

CREATE TRIGGER edges_same_project_update BEFORE UPDATE OF source_id, target_id ON edges
WHEN (SELECT project_id FROM nodes WHERE id = NEW.source_id)
  IS NOT (SELECT project_id FROM nodes WHERE id = NEW.target_id)
BEGIN SELECT RAISE(ABORT, 'edge endpoints must share a project'); END;

CREATE TABLE links (
  id         TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  kind       TEXT NOT NULL CHECK (kind IN ('ticket', 'pr')),
  url        TEXT NOT NULL CHECK (url GLOB 'http://*' OR url GLOB 'https://*'),
  UNIQUE (node_id, url)
) STRICT;

CREATE TABLE messages (
  id         TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  stage      TEXT NOT NULL,
  author     TEXT NOT NULL CHECK (author IN ('human', 'agent', 'system')),
  body       TEXT NOT NULL CHECK (length(body) > 0)
) STRICT;
CREATE INDEX messages_node ON messages(node_id);

CREATE TRIGGER messages_no_delete BEFORE DELETE ON messages
BEGIN SELECT RAISE(ABORT, 'messages are never deleted'); END;

CREATE TABLE events (
  id         TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  actor      TEXT NOT NULL CHECK (actor IN ('human', 'agent', 'system')),
  kind       TEXT NOT NULL,
  data       TEXT NOT NULL CHECK (json_valid(data))
) STRICT;
CREATE INDEX events_node ON events(node_id);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE runs (
  id         TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  stage      TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('running', 'exited')),
  pid        INTEGER,
  exit_code  INTEGER,
  log_path   TEXT NOT NULL,
  ended_at   TEXT
) STRICT;
CREATE UNIQUE INDEX runs_one_running_per_node ON runs(node_id) WHERE status = 'running';
`,
  },
  {
    // SQLite can't add a table CHECK without rebuilding the table, which the foreign keys into
    // `nodes` make awkward. A column's CHECK can read other columns, so the new column carries the
    // return_stage rule for the two stages the first migration left out.
    sql: `
ALTER TABLE nodes ADD COLUMN claimed_by TEXT
  CONSTRAINT nodes_claimed_by_known CHECK (claimed_by IN ('human', 'agent'))
  CONSTRAINT nodes_held_stages_require_return_stage
    CHECK (stage NOT IN ('externally_blocked', 'splitting') OR return_stage IS NOT NULL);
`,
  },
  {
    // Deleting a whole project is the one exception to these guards. The function is registered on
    // each connection by `openDb` and only `allowProjectDeletion` can make it return anything, so
    // no SQL can open the guards: to plain SQL they still refuse every row.
    sql: `
DROP TRIGGER nodes_no_delete;
CREATE TRIGGER nodes_no_delete BEFORE DELETE ON nodes
WHEN OLD.project_id IS NOT aop_project_being_deleted()
BEGIN SELECT RAISE(ABORT, 'nodes are never deleted'); END;

DROP TRIGGER messages_no_delete;
CREATE TRIGGER messages_no_delete BEFORE DELETE ON messages
WHEN (SELECT project_id FROM nodes WHERE id = OLD.node_id) IS NOT aop_project_being_deleted()
BEGIN SELECT RAISE(ABORT, 'messages are never deleted'); END;

DROP TRIGGER events_no_delete;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
WHEN (SELECT project_id FROM nodes WHERE id = OLD.node_id) IS NOT aop_project_being_deleted()
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
`,
  },
  {
    // A project needs only a name. UNIQUE still applies to paths that are set, because SQLite treats
    // each NULL as distinct. Copying the rowid keeps the order projects are listed in.
    foreignKeysOff: true,
    sql: `
CREATE TABLE projects_new (
  id         TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  name       TEXT NOT NULL,
  repo_path  TEXT UNIQUE CHECK (repo_path IS NULL OR length(repo_path) > 0)
) STRICT;
INSERT INTO projects_new (rowid, id, created_at, name, repo_path)
  SELECT rowid, id, created_at, name, repo_path FROM projects;
DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;
`,
  },
  {
    // How a run ended, and when its node moved on while it was still running. `agent_processes` is
    // every process AOP may need to find again. It has no foreign keys because it has to outlive the
    // run and the node: a process whose project was deleted is exactly what `aop reap` looks for.
    sql: `
ALTER TABLE runs ADD COLUMN left_via TEXT;
ALTER TABLE runs ADD COLUMN left_actor TEXT
  CONSTRAINT runs_left_actor_known CHECK (left_actor IS NULL OR left_actor IN ('human', 'agent', 'system'));
ALTER TABLE runs ADD COLUMN left_at TEXT;
ALTER TABLE runs ADD COLUMN end_reason TEXT
  CONSTRAINT runs_end_reason_known
    CHECK (end_reason IS NULL OR end_reason IN ('reported', 'failed', 'stopped', 'held', 'shutdown'));

CREATE TABLE agent_processes (
  id            TEXT PRIMARY KEY NOT NULL,
  created_at    TEXT NOT NULL,
  node_id       TEXT NOT NULL,
  pid           INTEGER NOT NULL CHECK (pid > 0),
  process_start TEXT,
  children      TEXT CHECK (children IS NULL OR json_valid(children)),
  command       TEXT NOT NULL
) STRICT;
`,
  },
  {
    // Triggers keep these in step with every write, whichever code makes it. They key on rowid, which
    // only VACUUM could renumber, and AOP never runs that. The WHEN clause matters: every stage change
    // writes invalidation_reason, usually with the value it already had.
    sql: `
CREATE VIRTUAL TABLE nodes_fts USING fts5(title, body, invalidation_reason, tokenize = 'porter unicode61');
CREATE VIRTUAL TABLE messages_fts USING fts5(body, tokenize = 'porter unicode61');

INSERT INTO nodes_fts (rowid, title, body, invalidation_reason)
  SELECT rowid, title, body, coalesce(invalidation_reason, '') FROM nodes;
INSERT INTO messages_fts (rowid, body) SELECT rowid, body FROM messages;

CREATE TRIGGER nodes_fts_insert AFTER INSERT ON nodes
BEGIN
  INSERT INTO nodes_fts (rowid, title, body, invalidation_reason)
    VALUES (NEW.rowid, NEW.title, NEW.body, coalesce(NEW.invalidation_reason, ''));
END;

CREATE TRIGGER nodes_fts_update AFTER UPDATE OF title, body, invalidation_reason ON nodes
WHEN OLD.title IS NOT NEW.title OR OLD.body IS NOT NEW.body
  OR OLD.invalidation_reason IS NOT NEW.invalidation_reason
BEGIN
  DELETE FROM nodes_fts WHERE rowid = OLD.rowid;
  INSERT INTO nodes_fts (rowid, title, body, invalidation_reason)
    VALUES (NEW.rowid, NEW.title, NEW.body, coalesce(NEW.invalidation_reason, ''));
END;

CREATE TRIGGER nodes_fts_delete AFTER DELETE ON nodes
BEGIN DELETE FROM nodes_fts WHERE rowid = OLD.rowid; END;

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages
BEGIN INSERT INTO messages_fts (rowid, body) VALUES (NEW.rowid, NEW.body); END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages
BEGIN DELETE FROM messages_fts WHERE rowid = OLD.rowid; END;
`,
  },
  {
    // What each run used, for the node page's runs table. Added columns keep every existing run, which
    // reads as plain text with no usage. A timeout stays a `failed` end, so it gets a flag of its own
    // rather than a rebuild of the end_reason CHECK.
    sql: `
ALTER TABLE runs ADD COLUMN output_format TEXT NOT NULL DEFAULT 'text'
  CONSTRAINT runs_output_format_known CHECK (output_format IN ('text', 'stream-json'));
ALTER TABLE runs ADD COLUMN context_tokens INTEGER
  CONSTRAINT runs_context_tokens_counted CHECK (context_tokens IS NULL OR context_tokens >= 0);
ALTER TABLE runs ADD COLUMN output_tokens INTEGER
  CONSTRAINT runs_output_tokens_counted CHECK (output_tokens IS NULL OR output_tokens >= 0);
ALTER TABLE runs ADD COLUMN timed_out INTEGER NOT NULL DEFAULT 0
  CONSTRAINT runs_timed_out_flag CHECK (timed_out IN (0, 1))
  CONSTRAINT runs_timed_out_failed CHECK (timed_out = 0 OR end_reason = 'failed');
`,
  },
  {
    // Lookups made for every node on every read of a project, and on every scheduler pass, which
    // otherwise scan the whole table: a node's latest run, and a scheduled node's latest child.
    sql: `
CREATE INDEX runs_node ON runs(node_id);
CREATE INDEX nodes_spawned_by ON nodes(spawned_by) WHERE spawned_by IS NOT NULL;
`,
  },
  {
    // Set on a run a clean shutdown is stopping, before it kills the process. A run whose process
    // outlives the shutdown's wait keeps its `running` row, and this tells the next start that it
    // wasn't a crash, so its node goes back in the queue rather than to failed.
    sql: `
ALTER TABLE runs ADD COLUMN shutting_down INTEGER NOT NULL DEFAULT 0
  CONSTRAINT runs_shutting_down_flag CHECK (shutting_down IN (0, 1));
`,
  },
  {
    // Improvements are nodes of their own kind. They belong to the machine rather than a project, so
    // they sit in one reserved project, `improvements`, that the projects list never shows. That keeps
    // every rule about nodes as it is, including edges staying inside a project. The first improvement
    // creates the project's row. Existing nodes are all work.
    sql: `
ALTER TABLE nodes ADD COLUMN kind TEXT NOT NULL DEFAULT 'work'
  CONSTRAINT nodes_kind_known CHECK (kind IN ('work', 'improvement'))
  CONSTRAINT nodes_improvements_in_their_project CHECK ((kind = 'improvement') = (project_id = 'improvements'));

CREATE TABLE improvements (
  id                TEXT PRIMARY KEY NOT NULL,
  created_at        TEXT NOT NULL,
  node_id           TEXT NOT NULL UNIQUE REFERENCES nodes(id) ON DELETE RESTRICT,
  -- Cleared when the source's project is deleted. The copies below keep the link readable.
  source_node_id    TEXT REFERENCES nodes(id) ON DELETE RESTRICT,
  source_message_id TEXT REFERENCES messages(id) ON DELETE RESTRICT,
  source_excerpt    TEXT,
  source_node_title TEXT,
  CONSTRAINT improvements_message_needs_node CHECK (source_message_id IS NULL OR source_node_id IS NOT NULL),
  CONSTRAINT improvements_source_copied
    CHECK (source_node_id IS NULL OR (source_excerpt IS NOT NULL AND source_node_title IS NOT NULL))
) STRICT;

CREATE TRIGGER improvements_node_kind BEFORE INSERT ON improvements
WHEN (SELECT kind FROM nodes WHERE id = NEW.node_id) IS NOT 'improvement'
  OR (NEW.source_node_id IS NOT NULL AND (SELECT kind FROM nodes WHERE id = NEW.source_node_id) IS NOT 'work')
  OR (NEW.source_message_id IS NOT NULL
      AND (SELECT node_id FROM messages WHERE id = NEW.source_message_id) IS NOT NEW.source_node_id)
BEGIN SELECT RAISE(ABORT, 'an improvement must be an improvement node, sourced from a message on a work node'); END;

CREATE TRIGGER improvements_no_delete BEFORE DELETE ON improvements
BEGIN SELECT RAISE(ABORT, 'improvements are never deleted'); END;

-- What an improvement would write to each file. Real files are untouched until it's applied.
CREATE TABLE proposals (
  id         TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  path       TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 4096),
  content    TEXT NOT NULL CHECK (length(content) <= 1000000),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL CHECK (updated_by IN ('human', 'agent')),
  UNIQUE (node_id, path)
) STRICT;

CREATE TRIGGER proposals_on_improvements BEFORE INSERT ON proposals
WHEN (SELECT kind FROM nodes WHERE id = NEW.node_id) IS NOT 'improvement'
BEGIN SELECT RAISE(ABORT, 'only improvements have proposals'); END;
`,
  },
  {
    // What the real file held when each proposal was last saved: `sha256:<hex>` of its bytes, or
    // `absent` when it didn't exist. Applying refuses when a file has changed since. Proposals saved
    // before this was recorded are `unknown`, and never count as changed.
    sql: `
ALTER TABLE proposals ADD COLUMN base TEXT NOT NULL DEFAULT 'unknown'
  CONSTRAINT proposals_base_known CHECK (
    base IN ('unknown', 'absent')
    OR (length(base) = 71 AND substr(base, 1, 7) = 'sha256:' AND substr(base, 8) NOT GLOB '*[^0-9a-f]*')
  );
`,
  },
  {
    // A scheduled node can have no schedule, and then doesn't fire, so the cron CHECK goes. Dropping a
    // table CHECK means rebuilding `nodes`, with its indexes and triggers, keeping each rowid for the
    // search index. Triggers on other tables name `nodes`, which doesn't exist between the drop and the
    // rename, so the rename runs with the legacy behaviour that doesn't re-check them.
    foreignKeysOff: true,
    sql: `
CREATE TABLE nodes_new (
  id                  TEXT PRIMARY KEY NOT NULL,
  created_at          TEXT NOT NULL,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title               TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body                TEXT NOT NULL DEFAULT '',
  type                TEXT NOT NULL,
  stage               TEXT NOT NULL,
  cron                TEXT CONSTRAINT nodes_cron_not_blank CHECK (cron IS NULL OR length(cron) > 0),
  invalidation_reason TEXT,
  return_stage        TEXT,
  spawned_by          TEXT REFERENCES nodes(id) ON DELETE RESTRICT,
  claimed_by          TEXT
    CONSTRAINT nodes_claimed_by_known CHECK (claimed_by IN ('human', 'agent'))
    CONSTRAINT nodes_held_stages_require_return_stage
      CHECK (stage NOT IN ('externally_blocked', 'splitting') OR return_stage IS NOT NULL),
  kind                TEXT NOT NULL DEFAULT 'work'
    CONSTRAINT nodes_kind_known CHECK (kind IN ('work', 'improvement'))
    CONSTRAINT nodes_improvements_in_their_project CHECK ((kind = 'improvement') = (project_id = 'improvements')),
  CONSTRAINT nodes_invalidated_requires_reason
    CHECK (stage <> 'invalidated' OR (invalidation_reason IS NOT NULL AND length(invalidation_reason) > 0)),
  CONSTRAINT nodes_waiting_requires_return_stage
    CHECK (stage NOT IN ('ask_human_question', 'failed') OR return_stage IS NOT NULL)
) STRICT;
INSERT INTO nodes_new (rowid, id, created_at, project_id, title, body, type, stage, cron, invalidation_reason,
                       return_stage, spawned_by, claimed_by, kind)
  SELECT rowid, id, created_at, project_id, title, body, type, stage, nullif(cron, ''), invalidation_reason,
         return_stage, spawned_by, claimed_by, kind FROM nodes;
DROP TABLE nodes;
PRAGMA legacy_alter_table = ON;
ALTER TABLE nodes_new RENAME TO nodes;
PRAGMA legacy_alter_table = OFF;

CREATE INDEX nodes_project ON nodes(project_id);
CREATE INDEX nodes_spawned_by ON nodes(spawned_by) WHERE spawned_by IS NOT NULL;

CREATE TRIGGER nodes_no_delete BEFORE DELETE ON nodes
WHEN OLD.project_id IS NOT aop_project_being_deleted()
BEGIN SELECT RAISE(ABORT, 'nodes are never deleted'); END;

CREATE TRIGGER nodes_project_immutable BEFORE UPDATE OF project_id ON nodes
WHEN NEW.project_id <> OLD.project_id
BEGIN SELECT RAISE(ABORT, 'a node cannot change project'); END;

CREATE TRIGGER nodes_fts_insert AFTER INSERT ON nodes
BEGIN
  INSERT INTO nodes_fts (rowid, title, body, invalidation_reason)
    VALUES (NEW.rowid, NEW.title, NEW.body, coalesce(NEW.invalidation_reason, ''));
END;

CREATE TRIGGER nodes_fts_update AFTER UPDATE OF title, body, invalidation_reason ON nodes
WHEN OLD.title IS NOT NEW.title OR OLD.body IS NOT NEW.body
  OR OLD.invalidation_reason IS NOT NEW.invalidation_reason
BEGIN
  DELETE FROM nodes_fts WHERE rowid = OLD.rowid;
  INSERT INTO nodes_fts (rowid, title, body, invalidation_reason)
    VALUES (NEW.rowid, NEW.title, NEW.body, coalesce(NEW.invalidation_reason, ''));
END;

CREATE TRIGGER nodes_fts_delete AFTER DELETE ON nodes
BEGIN DELETE FROM nodes_fts WHERE rowid = OLD.rowid; END;
`,
  },
  {
    // A steered session's ID, which its tools send as their run ID. It's open only while the human's
    // claim on its node holds: the triggers refuse one without that claim, and end it with the claim.
    sql: `
CREATE TABLE steer_sessions (
  id         TEXT PRIMARY KEY NOT NULL
    CONSTRAINT steer_sessions_id_not_blank CHECK (length(id) > 0),
  created_at TEXT NOT NULL,
  node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  ended_at   TEXT
) STRICT;
CREATE UNIQUE INDEX steer_sessions_one_open_per_node ON steer_sessions(node_id) WHERE ended_at IS NULL;

CREATE TRIGGER steer_sessions_need_human_claim BEFORE INSERT ON steer_sessions
WHEN NEW.ended_at IS NULL AND (SELECT claimed_by FROM nodes WHERE id = NEW.node_id) IS NOT 'human'
BEGIN SELECT RAISE(ABORT, 'a steered session needs the human''s claim on its node'); END;

CREATE TRIGGER steer_sessions_reopen_never BEFORE UPDATE OF ended_at ON steer_sessions
WHEN OLD.ended_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a steered session never reopens'); END;

CREATE TRIGGER steer_sessions_end_with_claim AFTER UPDATE OF claimed_by ON nodes
WHEN NEW.claimed_by IS NOT 'human'
BEGIN
  UPDATE steer_sessions SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE node_id = NEW.id AND ended_at IS NULL;
END;
`,
  },
];

export interface Migration extends Step {
  version: number;
}

export const migrations: readonly Migration[] = steps.map((step, index) => ({ ...step, version: index + 1 }));
