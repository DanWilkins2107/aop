/** Numbered migrations. Never edit one that has shipped: add the next number instead. */
export const migrations: readonly {
  version: number;
  sql: string;
  /** For rebuilding a table that others point at, which foreign keys would otherwise refuse. */
  foreignKeysOff?: boolean;
}[] = [
  {
    version: 1,
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
    version: 2,
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
    version: 3,
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
    version: 4,
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
    version: 5,
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
    version: 6,
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
    version: 7,
    // Lookups made for every node on every read of a project, and on every scheduler pass, which
    // otherwise scan the whole table: a node's latest run, and a scheduled node's latest child.
    sql: `
CREATE INDEX runs_node ON runs(node_id);
CREATE INDEX nodes_spawned_by ON nodes(spawned_by) WHERE spawned_by IS NOT NULL;
`,
  },
];
