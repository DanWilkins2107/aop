/** Numbered migrations. Never edit one that has shipped: add the next number instead. */
export const migrations: readonly { version: number; sql: string }[] = [
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
];
