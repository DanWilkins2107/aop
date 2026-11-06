# Server and data

One TypeScript Node process per machine serves the API and the built Vite app, on localhost only.

- `~/.aop/aop.db` holds all state, accessed with `better-sqlite3` (Node's built-in SQLite has no full-text search).
- A project is a name and an optional repo path. Improvements live in one reserved project that is never listed: see [improvements.md](improvements.md). Agents start in the project path if it has one, otherwise in `open_from`. AOP never writes to the repo.
- The `aop` CLI only talks to the server over HTTP. Every stage change is checked there against `stages.yaml`.
- `actor` on API calls is self-reported for now.
- A node on a stage that no longer exists in `stages.yaml` is flagged for a human to move.

## Schema
Every table has `id TEXT PRIMARY KEY` and `created_at TEXT NOT NULL`. All foreign keys are `NOT NULL` except `spawned_by`, with deletes restricted.

| Table | Columns and constraints |
|---|---|
| `projects` | `name` NOT NULL; `repo_path` nullable, UNIQUE when set |
| `nodes` | `project_id` FK; `title` NOT NULL, 1-200 chars; `body` NOT NULL DEFAULT ''; `type` NOT NULL; `stage` NOT NULL; `cron` required when `stage = 'scheduled'`; `invalidation_reason` required when `stage = 'invalidated'`; `return_stage` required when `stage` is `ask_human_question`, `failed`, `externally_blocked` or `splitting`; `spawned_by` FK to `nodes`, nullable (`scheduled` runs); `claimed_by` nullable, CHECK in `human`, `agent`; `kind` CHECK in `work`, `improvement`, and `improvement` exactly when the project is the reserved `improvements` |
| `edges` | `source_id`, `target_id` FK to `nodes`, must differ and share a project (trigger); `kind` CHECK in `subtask`, `blocks`; `removed_at` nullable; UNIQUE on source, target and kind while not removed |
| `links` | `node_id` FK; `kind` CHECK in `ticket`, `pr`; `url` NOT NULL, must start `http://` or `https://`; UNIQUE on node and url |
| `messages` | `node_id` FK; `stage` NOT NULL; `author` CHECK in `human`, `agent`, `system`; `body` NOT NULL, not empty |
| `events` | `node_id` FK; `actor` CHECK in `human`, `agent`, `system`; `kind` NOT NULL; `data` JSON NOT NULL. Append-only: triggers reject UPDATE and DELETE |
| `improvements` | `node_id` FK, UNIQUE, an improvement node; `source_node_id`, `source_message_id` FK, nullable, cleared when the source's project is deleted, and the message must be on that node; `source_excerpt` and `source_node_title` copies, required with a source. Never deleted |
| `proposals` | `node_id` FK to an improvement; `path` NOT NULL, absolute, 1-4096 chars; `content` NOT NULL, at most 1,000,000 chars; `updated_at` NOT NULL; `updated_by` CHECK in `human`, `agent`; UNIQUE on node and path |
| `runs` | `node_id` FK; `stage` NOT NULL; `status` CHECK in `running`, `exited`; `pid` nullable; `exit_code` nullable; `log_path` NOT NULL; `ended_at` nullable; `left_via`, `left_at` nullable, set when the node moves on while the run is going; `left_actor` nullable, CHECK in `human`, `agent`, `system`; `end_reason` nullable, CHECK in `reported`, `failed`, `stopped`, `held`, `shutdown`; `shutting_down` NOT NULL, CHECK in 0, 1, set when a clean shutdown starts stopping the run, so a run that outlives it is requeued on the next start rather than failed; only one `running` row per node (partial UNIQUE index) |
| `agent_processes` | Every process AOP started, until it knows the process is gone. `node_id` NOT NULL with no FK, so a row outlives its run, node and project for `aop reap`; `pid` NOT NULL, > 0; `process_start` nullable; `children` nullable JSON; `command` NOT NULL |

`type` and `stage` are plain text because they come from config. Nodes and messages are never deleted, except when their whole project is deleted.

## Edges
- `subtask`: parent to child.
- `blocks`: AOP won't start an agent on a node while a node blocking it is unfinished. An edge that would create a `blocks` cycle is refused. `done` counts as finished. An `invalidated` blocker still blocks, so a human has to decide what to do.

## Search
`aop search <query>` is how agents find related work. It uses SQLite full-text search over node titles, bodies, messages and invalidation reasons. It covers the current project, or all of them with `--all`. Results show each node's stage, and invalidated nodes are included.
