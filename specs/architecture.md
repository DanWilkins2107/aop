# Architecture

Where each part of the specs lives in the code, and how one request moves through it. The other specs say what AOP does. This one says where to look.

## Layout
| Folder | What's there |
|---|---|
| `src/server/` | The one server process: HTTP API, state machine, agents, scheduler, SQLite |
| `src/shared/api.ts` | Types for everything the API returns. Types only, so the browser imports it too |
| `src/cli/` | `aop`: `main.ts` turns commands into HTTP calls, `init.ts` is `aop init` |
| `web/src/` | The React app. `pages/` per route, `components/` shared UI, `lib/` data and maths |
| `plugin/` | The skills agents load. See [plugin.md](plugin.md) |
| `defaults/` | The `config.yaml`, `stages.yaml` and prompts `aop init` copies into `~/.aop` |
| `demo/` | A throwaway server with seeded data and no agents |
| `test/` | Vitest. `test/server/` covers the server and CLI, `test/web/` the browser's `lib/` |

## Server modules
`src/server/` is flat. Grouped by job:

| Job | Files |
|---|---|
| Startup | `main.ts` (`npm start`) and `aop serve` both call `serve.ts`, which wires everything below. `server.ts` binds the port. `serverLock.ts` stops a second server |
| HTTP | `api.ts`: every route, body validation, error rendering, and the change notice after each write |
| Nodes and stages | `nodes.ts`: every stage change, claims, messages, links, edges and events |
| Process definition | `stages.ts` parses and validates `stages.yaml`. `config.ts` loads `config.yaml` and the stages it links to. `process.ts` is the process page's view of both |
| Agent text | `context.ts`: `aop context` output and every agent's prompt |
| Agents | `orchestrator.ts` decides what runs and handles each run's end. `runs.ts` holds the `runs` and `agent_processes` rows. `processes.ts` is OS process handling: start times, children, killing. `runLog.ts` writes logs |
| Scheduling | `scheduler.ts` fires `scheduled` nodes. `cron.ts` parses cron |
| Humans | `steer.ts` (`aop steer`), `projects.ts`, `search.ts` |
| Storage | `db.ts` opens SQLite and runs `migrations.ts`. `records.ts` makes IDs, timestamps and events. `paths.ts` finds `~/.aop` |
| Errors | `errors.ts`: `ApiError` for refusals, `ConfigError` for a bad config |

`process.ts` is about the process in `stages.yaml`. `processes.ts` is about operating system processes.

## One request
A human clicks an outcome on the node page:
1. `web/src/pages/node/MovingOn.tsx` calls `api.next` in `web/src/lib/api.ts`, which posts `/api/nodes/:id/next`.
2. `api.ts` validates the body with zod. No `actor` means `human`.
3. `nodes.next` reads `stages.yaml` fresh, checks the outcome, and calls `applyStageChange` in one transaction. That's the only place a stage changes: it updates `nodes`, appends a `stage_changed` event, drops an agent's claim, and marks any running run with `left_via`.
4. The route returns the new `NodeView`. `toView` derives everything not stored: turn, outcomes, holders, invalidated by a parent. `listNodes` derives the same for a whole project from a few queries, through `holdersIn`, and `test/server/views.test.ts` checks the two agree.
5. The write middleware in `api.ts` calls `ChangeFeed.notify()` (`changes.ts`) with what the route touched: the node's project and the node, or both ends of an edge. A route that says nothing counts as touching everything.
6. The feed gathers a burst of notices for 40 ms and hands them on merged. Two things are listening:
   - `/api/events` sends one `change` per burst to every open page, with the project and node IDs as its data. `useLiveData` in `web/src/lib/live.ts` refetches a page only if the change `affects` it: the graph page its project, the node page its project, plus its own messages, events, edges and links only when the change names the node.
   - The orchestrator's `kick` runs a reconcile: `checkActiveRuns` stops any run whose node moved on, and `startQueuedNodes` launches agents on `startableNodes`.

An agent's `aop next` is the same request from `src/cli/main.ts`, with `actor: agent` and the node from `AOP_NODE_ID`. Nothing calls the orchestrator directly: routes change the database, and the orchestrator makes the running agents match it.

## Stages and nodes in the code
- **Process:** `stages.ts` turns `stages.yaml` into a `StageGraph`: a pool of `StageDef`s and a `TypeDef` per type, each mapping stage to outcome to target. `config.ts` loads it on every call, so edits apply without a restart.
- **Built-ins:** named in `BUILT_IN_STAGES` in `stages.ts`. Their behaviour is the action functions in `nodes.ts`: `ask`, `answer`, `fail`, `retry`, `invalidate`, `restore`, `block`, `unblock`, `splitStart`, `splitFinish`. `scheduled` lives in `scheduler.ts`. The web app has its own lists in `web/src/lib/stageStyle.ts`.
- **Stored:** a node row holds `type`, `stage`, `return_stage` for stages that go back, and `claimed_by`. Where it came from is in its `stage_changed` events, which `restore` and `unblock` read.
- **Derived:** `holdersOf` in `nodes.ts` is everything stopping an agent starting: `blocks` edges, a splitting parent, an invalidated ancestor. `turnOf` says whose move it is.
- **Runs:** `beginRun` takes the claim and opens the run together. A run ends in `Orchestrator.finish`, which reads the stop reason and `left_via` to decide between `failed`, stopped and reported.

## Web app
- `App.tsx` lists the routes. Each page loads with `useLiveData`, so every page is live the same way.
- `GraphPage.tsx` draws a project with `lib/layout.ts`. `NodePage.tsx` is the node page, with one file per card in `pages/node/`. `ProcessPage.tsx` and `components/PipelineGraph.tsx` draw types with `lib/stageGraph.ts`.
- Stage colours and emphasis are in `lib/stageStyle.ts`, and the colour maths in `lib/color.ts`.

## Data
`migrations.ts` is the schema, as numbered SQL. [server.md](server.md) has the tables. Constraints and triggers enforce the rules there, so the database refuses a bad row whichever code writes it.
