# Server and data

One TypeScript Node process per machine serves the API and the built Vite app, on localhost only.

- `~/.aop/aop.db` holds all state, accessed with `better-sqlite3` (Node's built-in SQLite has no full-text search). Each repo with a `.aop` folder is a project, registered by `aop init`.
- The `aop` CLI only talks to the server over HTTP. Every stage change is checked there against `stages.yaml`.
- A node on a stage that no longer exists in `stages.yaml` is flagged for a human to move.

## Schema
Every table has `id TEXT PRIMARY KEY` and `created_at TEXT NOT NULL`. All foreign keys are `NOT NULL`, with deletes restricted.

| Table | Columns and constraints |
|---|---|
| `projects` | `name` NOT NULL; `repo_path` NOT NULL UNIQUE |
| `nodes` | `project_id` FK; `title` NOT NULL, 1-200 chars; `body` NOT NULL DEFAULT ''; `type` NOT NULL; `stage` NOT NULL; `cron` required when `stage = 'scheduled'`; `invalidation_reason` required when `stage = 'invalidated'`; `return_stage` required when `stage` is `ask_human_question` or `failed`; `spawned_by` FK to `nodes`, nullable (`scheduled` runs) |
| `edges` | `source_id`, `target_id` FK to `nodes`, must differ and share a project (trigger); `kind` CHECK in `subtask`, `blocks`; `removed_at` nullable; UNIQUE on source, target and kind while not removed |
| `links` | `node_id` FK; `kind` CHECK in `ticket`, `pr`; `url` NOT NULL, must start `http://` or `https://`; UNIQUE on node and url |
| `messages` | `node_id` FK; `stage` NOT NULL; `author` CHECK in `human`, `agent`, `system`; `body` NOT NULL, not empty |
| `events` | `node_id` FK; `actor` CHECK in `human`, `agent`, `system`; `kind` NOT NULL; `data` JSON NOT NULL. Append-only: triggers reject UPDATE and DELETE |
| `runs` | `node_id` FK; `stage` NOT NULL; `status` CHECK in `running`, `exited`; `pid` nullable; `exit_code` nullable; `log_path` NOT NULL; `ended_at` nullable; only one `running` row per node (partial UNIQUE index) |

`type` and `stage` are plain text because they come from config. Nodes and messages are never deleted.

## Edges
- `subtask`: parent to child.
- `blocks`: AOP won't start an agent on a node while a node blocking it is unfinished. `done` and `broken_down` count as finished. An `invalidated` blocker still blocks, so a human has to decide what to do.

## Search
`aop search <query>` is how agents find related work. It uses SQLite full-text search over node titles, bodies, messages and invalidation reasons. It covers the current project, or all of them with `--all`. Results show each node's stage, and invalidated nodes are included.
