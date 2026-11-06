# Architecture

Where each part of the specs lives in the code, and how one request moves through it. The other specs say what AOP does. This one says where to look.

## Layout
| Folder | What's there |
|---|---|
| `src/server/` | The one server process: HTTP API, state machine, agents, scheduler, SQLite |
| `src/shared/` | What the server and clients share, so nothing that needs Node. `api.ts`: types for everything the API returns and accepts, and plain constants such as `RUN_ID_HEADER`. `requests.ts`: the zod schemas for request bodies, which the browser only imports types from. `paths.ts`: every API path, for the router and the clients. `builtInStages.ts`: the built-in stage names and sets |
| `src/cli/` | `aop`: `cli.ts` turns commands into HTTP calls, `main.ts` runs it on the real process, `init.ts` is `aop init`, `selfBuild.ts` rebuilds a stale checkout before `aop serve` |
| `web/src/` | The React app. `pages/` per route, `components/` shared UI, `lib/` data and maths, `styles/` one stylesheet per part of the UI |
| `plugin/` | The skills agents load. See [plugin.md](plugin.md) |
| `defaults/` | The `config.yaml`, `stages.yaml` and prompts `aop init` copies into `~/.aop` |
| `demo/` | A throwaway server with seeded data and no agents |
| `test/` | Vitest. `test/server/` covers the server, `test/cli/` the `aop` command, `test/shared/` `src/shared/`, `test/defaults/` the shipped defaults, `test/web/` the browser's `lib/` |

## Server modules
`src/server/` is flat. Grouped by job:

| Job | Files |
|---|---|
| Startup | `main.ts` (`npm start`) and `aop serve` both call `serve.ts`, which wires everything below. `server.ts` binds the port. `serverLock.ts` stops a second server |
| HTTP | `api.ts`: every route, body validation against `src/shared/requests.ts`, error rendering, and the change notice after each write |
| Nodes and stages | `nodes.ts` re-exports the node modules as one, so `api.ts` calls `nodes.*`, and reads events. `stageMachine.ts`: `applyStageChange`, creating and editing nodes, and every stage action. `claims.ts`: claims. `messages.ts`: messages and links. `edges.ts`: edges. `nodeViews.ts`: `toView`, `holdersOf`, `holdersIn`, `listNodes`, `viewsOf` and `startableNodes`. `nodeCore.ts`: what they share, such as `getNodeRow`, the graphs a node follows and `turnOf` |
| Process definition | `stages.ts` parses and validates `stages.yaml`. `config.ts` loads `config.yaml` and the stages it links to. `processView.ts` is the process page's view of both |
| Agent text | `context.ts`: `aop context` output and every agent's prompt |
| Agents | `orchestrator.ts` decides what runs and handles each run's end. `runs.ts` holds the `runs` and `agent_processes` rows. `osProcesses.ts` is OS process handling: start times, children, killing. `runLog.ts` writes logs |
| Scheduling | `scheduler.ts` fires `scheduled` nodes. `cron.ts` parses cron |
| Humans | `steer.ts` (`aop steer`), `projects.ts`, `search.ts` |
| Storage | `db.ts` opens SQLite and runs `migrations.ts`. `records.ts` makes IDs, timestamps and events. `paths.ts` finds `~/.aop`. `fsUtil.ts` has small file checks |
| Errors | `errors.ts`: `ApiError` for refusals, `ConfigError` for a bad config |

## One request
A human clicks an outcome on the node page:
1. `web/src/pages/node/MovingOn.tsx` calls `api.next` in `web/src/lib/api.ts`, which posts `/api/nodes/:id/next`.
2. `api.ts` validates the body with its zod schema from `src/shared/requests.ts`. No `actor` means `human`.
3. `nodes.next` reads `stages.yaml` (see the config below), checks the outcome, and calls `applyStageChange` in one transaction. That's the only place a stage changes: it updates `nodes`, appends a `stage_changed` event, drops an agent's claim, and marks any running run with `left_via`.
4. The route returns the new `NodeView`. `toView` derives everything not stored: turn, outcomes, holders, invalidated by a parent. `listNodes` derives the same for a whole project from a few queries, through `holdersIn`, and `test/server/views.test.ts` checks the two agree.
5. The write middleware in `api.ts` calls `ChangeFeed.notify()` (`changes.ts`) with what the route touched: the node's project and the node, or both ends of an edge. A route that says nothing counts as touching everything.
6. The feed gathers a burst of notices for 40 ms and hands them on merged. Two things are listening:
   - `/api/events` sends one `change` per burst to every open page, with the project and node IDs as its data. `useLiveData` in `web/src/lib/live.ts` refetches a page only if the change `affects` it: the graph page its project, the node page its project, plus its own messages, events, edges and links only when the change names the node. Improvements sit in the reserved `improvements` project, so the Improvements tab and an improvement's page refetch on any change there, or to a project an improvement was captured from. Capturing one names the improvement and its source node; applying one names nothing, since it can change prompt files.
   - The orchestrator's `kick` runs a reconcile: `checkActiveRuns` stops any run whose node moved on, and `startQueuedNodes` launches agents on `startableNodes`.

An agent's `aop next` is the same request from `src/cli/cli.ts`, with `actor: agent`, the node from `AOP_NODE_ID`, and its run from `AOP_RUN_ID` in the `RUN_ID_HEADER` header, which the server checks so that a process left over from an ended run can't act. Nothing calls the orchestrator directly: routes change the database, and the orchestrator makes the running agents match it.

## Stages and nodes in the code
- **Process:** `stages.ts` turns `stages.yaml` into a `StageGraph`: a pool of `StageDef`s and a `TypeDef` per type, each mapping stage to outcome to target. `config.ts` loads it, once per operation: `withConfigSnapshot` gives each request, reconcile and scheduler wake one reading. Between operations the result is cached until `config.yaml`, `stages.yaml`, `improvement_stages.yaml`, a prompt file or a `.git` around `improvements_path` changes modification time or size, so edits apply without a restart.
- **Built-ins:** named in `src/shared/builtInStages.ts`, with the global, finished and human-turn sets, so the server and web app share one list. Their behaviour is the action functions in `stageMachine.ts`: `ask`, `answer`, `fail`, `retry`, `invalidate`, `restore`, `block`, `unblock`, `splitStart`, `splitFinish`. `scheduled` lives in `scheduler.ts`.
- **Stored:** a node row holds `type`, `stage`, `return_stage` for stages that go back, and `claimed_by`. Where it came from is in its `stage_changed` events, which `restore` and `unblock` read.
- **Derived:** `holdersOf` in `nodeViews.ts` is everything stopping an agent starting: `blocks` edges, a splitting parent, an invalidated ancestor. `turnOf` in `nodeCore.ts` says whose move it is.
- **Runs:** `beginRun` takes the claim and opens the run together. A run ends in `Orchestrator.finish`, which reads the stop reason and `left_via` to decide between `failed`, stopped and reported.

## Web app
- `App.tsx` lists the routes. Each page loads with `useLiveData`, so every page is live the same way.
- `GraphPage.tsx` draws a project with `lib/layout.ts`. `NodePage.tsx` is the node page, with one file per card in `pages/node/`. `ProcessPage.tsx` and `components/PipelineGraph.tsx` draw types with `lib/stageGraph.ts`.
- Stage colours and emphasis are in `lib/stageStyle.ts`, and the colour maths in `lib/color.ts`.

## Data
`migrations.ts` is the schema, as a list of SQL steps whose versions are their places in it. [server.md](server.md) has the tables. Constraints and triggers enforce the rules there, so the database refuses a bad row whichever code writes it.
