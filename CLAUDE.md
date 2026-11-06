# AOP: notes for coding agents

`specs/` is the contract. Read the spec for the area you're changing before you change it, and update it in the same change when you change behaviour. `docs/` is written by humans: don't edit it.

## Layout
- `src/server/`: one Node process. `api.ts` has every route and its zod request body. `nodes.ts` has the node and stage rules. `orchestrator.ts` launches agents, `scheduler.ts` fires cron nodes, `processes.ts` finds and kills process trees. `config.ts` and `stages.ts` load and validate `config.yaml` and `stages.yaml`. `context.ts` builds `aop context` and the agent prompt. `migrations.ts` holds the schema.
- `src/shared/api.ts`: the response types shared by the server, the CLI and the web app. Types only, because the browser imports it.
- `src/cli/`: the `aop` command. `cli.ts` has the commands, which only talk HTTP, and `runCli`, which takes its argv, env, output and exit as arguments. `main.ts` is the entry point that runs it on the real process. `init.ts` is `aop init`.
- `web/src/`: the React UI. `lib/` holds the pure helpers, tested in `test/web/`. `styles.css` only imports `styles/*.css`, one file per part of the UI, and their order is the cascade order.
- `defaults/`: what `aop init` installs. `demo/`: the demo's config and seed data. `plugin/`: the agent skills.
- Imports use `.js` suffixes on `.ts` files (NodeNext).

## Commands
- `npm run typecheck`: the server and web projects.
- `npx vitest run test/server/api.test.ts -t "some name"`: one file, or one test in it. Prefer this.
- `npm run test:fast`: the `unit` project, which is everything except the files that spawn processes. `test:server`, `test:web` and `test:cli` split the suite by area.
- `npx vitest related --run web/src/lib/layout.ts`: the tests that import a file. Only useful for leaf modules: the server harness reaches almost every server file.
- `vitest.config.ts` has two projects. `unit` (30s per test) is in-process. `integration` (90s per test) is the files that spawn processes: `orchestrator`, `recovery`, `startup`, `cli.smoke` and `test/cli/init`. A new file that spawns processes goes in its list. Pick one with `--project unit`.
- Don't run the whole suite, or `npm run test:integration`, unless asked. Run the one integration file you need.
- Never run `npm start`, `npm run demo`, `npm run dev:web` or `aop serve`.

## Rules
- Never bind port 4317 (the user's real server) or 4318. Servers in tests use port 0. `test/server/setup.ts` gives every test file a throwaway `AOP_HOME` and `AOP_PORT=0`.
- Never touch the real `~/.aop`. Build every state path from `aopHome()` in `src/server/paths.ts`, and in tests use `makeHome()`, `harness()` or `world()`.
- Never launch real agent tools (`claude`, `copilot`) in tests. Agents are `test/fixtures/fake-agent.mjs`, driven by `@@` lines in the node body or prompt (listed at the top of that file).
- AOP stays invisible in user repos: it never writes to a project's path, and tests check the folder is unchanged. The plugin tells agents never to mention AOP in anything committed or published.
- Agents can reach the API, so no route may change commands or `config.yaml`. `actor` is self-reported.
- Migrations are append-only: add a new version, never edit an old one. If two branches add the same version, renumber one at merge.
- The dev machine is Windows. Keep scripts and paths cross-platform, and expect process lookups to be slow there.

## Tests that tie files together
- The YAML example in `specs/stages.md` must equal `demo/config/stages.yaml` apart from colours (`test/server/settings.test.ts`). Change both together.
- Every `` `aop ...` `` in `plugin/` and `defaults/prompts/` must be a command and flags the CLI's usage lists (`test/defaults/defaults.test.ts`). The usage is `AGENT_COMMANDS` and `HUMAN_COMMANDS` in `src/cli/cli.ts`. Keep `specs/cli.md` in step.
- `defaults/prompts/` has exactly one file per agent stage in `defaults/stages.yaml`.
- Demo and built-in stage colours must pass the contrast checks in `test/web/lib.test.ts`.

## Writing tests
- `harness()` in `test/server/helpers.ts`: the real Hono app in-process, with no ports or processes. Use it for API and node rules.
- `world()` in `test/server/agents.helpers.ts`: a real server on port 0, the orchestrator and fake agents. Only for launching, stopping and recovering agents. Wait with `until()` or `expect.poll`, and use `settle()` only to show something didn't happen.
- `aopInProcess()` in `test/server/cli.helpers.ts`: the CLI in this process, with its own env and output. Use it for CLI tests. `aopSpawned()` runs the real entry point in a process, and only `cli.smoke.test.ts` needs it.

## Adding things
- An API route: the zod body and route in `api.ts`, the logic in the module it belongs to, the response type in `src/shared/api.ts`, the client call in `web/src/lib/api.ts`, and the CLI command in `src/cli/cli.ts` if agents need it. Successful writes notify the UI by themselves.
- An event kind: `appendEvent` in the same transaction as the change, and its wording in `web/src/lib/eventText.ts`.
