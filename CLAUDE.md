# AOP: notes for coding agents

Read the code for the area you change. `docs/` is written by humans: don't edit it unless asked.

## Rules
- Imports use `.js` suffixes on `.ts` files (NodeNext).
- `src/shared/` is imported by the browser, so nothing in it may need Node.
- Migrations are append-only: add a step to the end of the list in `migrations.ts`, and never edit, remove or reorder one.
- Agents can reach the API, so no route may change commands or `config.yaml`.
- The server never writes to a project's path.
- Every stage change goes through `applyStageChange`. Node routes don't start or stop agents: the orchestrator reconciles them to the database after each write.
- The dev machine is Windows: keep scripts and paths cross-platform.
- A new API route: zod body and route in `api.ts`, response type in `src/shared/api.ts`, client call in `web/src/lib/api.ts`, and a CLI command in `src/cli/cli.ts` if agents need it.
- A new event kind: `appendEvent` in the same transaction as the change, and its wording in `web/src/lib/eventText.ts`.

## Testing
- `npm run typecheck`, then `npx vitest run <file> [-t "name"]`. Don't run the whole suite unless asked.
- Never run `npm start`, `npm run demo`, `npm run dev:web` or `aop serve`. Never bind 4317 or 4318, never touch the real `~/.aop`, and never launch real `claude` or `copilot` (agents are `test/fixtures/fake-agent.mjs`).
- `harness()` is the app in-process, for API and node rules. `world()` is a real server with fake agents, only for launching, stopping and recovering them; wait with `until()` or `expect.poll`. `aopInProcess()` is the CLI.
- A new test file that spawns processes goes in the `integration` list in `vitest.config.ts`.

## Files kept in step by tests
- Every `` `aop ...` `` in `plugin/` and `defaults/prompts/` must be in `AGENT_COMMANDS` or `HUMAN_COMMANDS` in `src/cli/cli.ts`.
- `defaults/prompts/` has one file per agent stage in `defaults/stages.yaml`.
- Stage colours pass the contrast checks in `test/web/lib.test.ts`.
