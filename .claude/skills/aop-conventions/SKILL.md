---
name: aop-conventions
description: Where files go in this repo, folder by folder, and what each folder may import. Use before adding, moving or renaming a file under `src/`.
---

# AOP conventions

The gates in `meta/` enforce these: `npx vitest run meta`. Each folder's rules are in the `meta/*.meta.test.ts` files. Change a rule and this skill together.

A test sits beside the file it tests, as `<name>.test.ts`. A helper only tests use is `<name>.helpers.ts`: nothing but tests and other helpers may import it, and the import rules below don't apply to either.

A helper that tests in two or more folders use goes in a `test-shared/` folder, which only tests may import: `src/mcp/test-shared/` for tests within `src/mcp`, the repo root's for tests across sides. Otherwise it stays beside its tests.

`npm run typecheck` also runs oxlint and knip (unused files, exports and dependencies). They cover a folder once its layout is settled: take the folder out of `ignorePatterns` in `.oxlintrc.json` and `ignore` in `knip.json`, and fix what they find.

Lint caps size and complexity everywhere, the ignored folders included: 300 lines a file, 60 a function, complexity 10, depth 3, 4 parameters. `.tsx` functions get 100 lines; tests get 500 a file and no function cap. They live in `.oxlintrc.caps.json`. `migrations.ts` has no file cap: it's append-only, so it only grows. Files that were already over a cap are parked there at their size then: lower a parked number when the file shrinks, and never raise one or park a new file. Split code that breaks a limit rather than loosening it.

Every `UPDATE` to a column with an owner goes through its owning file, such as `nodes.claimed_by` through `claims.ts`. `meta/columnOwnerGate.meta.test.ts` lists the owners.

## src/shared
What two or more of `src/server`, `src/cli`, `src/mcp` and `web/src` use. Tests don't count.

- One folder per concept: `nodes/`, `stages/`, `runs/`, `schedule/`... Nothing at the root. A concept can nest its own folders.
- Each folder's types all go in its `types.ts`. Every other file exports one value, named as the file (`isBuiltIn.ts` exports `isBuiltIn`).
- Import from it by name: no `import *` and no re-exports.
- An export only one side uses moves to that side, unless other shared code is built from it. One no side uses is deleted.
- Request types (`*Request`) are the API's contract and live here, hand-written. The server's zod schemas, in `src/server/http/requests.ts`, are checked against them with `bodyOf<T>()`.
- It imports nothing outside itself, not even a package, so the browser can load all of it.

## src/cli
The `aop` command, for humans.

- `main.ts`: the bin, on the real process. For `serve`, it rebuilds the checkout with its extensions before any command loads.
- `cli.ts`: finds the command in the registry and runs it, and turns failures into exit codes (2 usage, 1 failure). Help, `<command> --help` and `--version` come from here, built from the commands' usage and `help`.
- `commands/`: one file per command, named as the command, exporting a `Command` (name, usage, run), plus `registry.ts`, the `COMMANDS` list. A command stays one file until it alone needs a second, then becomes `commands/<name>/`, with `<name>.ts` as its entry. Keep the entry thin, and load heavy work inside `run`.
- `shared/`: what two or more files of `src/cli` use: the API client, argument reading, errors, the `Command` type. Each export needs two importing files; tests don't count.
- `test-shared/`: the helpers tests in two or more of its folders use.
- A command imports `shared/` and `src/shared` only, and reaches the board over HTTP. Only `commands/init/` and `commands/serve/` may import `src/server`.
- Outside `src/cli`, only `main.ts` and `commands/registry.ts` may be imported, by tests too.

## src/mcp
The agents' MCP server.

- `server.ts`: the only file at the root, with its test. The only file that imports `src/server`.
- `tools/`: one file per tool, named as the tool, plus `registry.ts`, the `REGISTRY` list. A tool stays one file until it alone needs a second, then becomes `tools/<name>/`.
- `shared/`: what two or more files of `src/mcp` use, such as `defineTool`. Code two tools share goes here, never in one tool's file. Each export needs two importing files; tests don't count. Unlike `src/shared`, it may use Node.
- `test-shared/`: the helpers tests in two or more of its folders use, such as `mcpHarness`.
- A tool imports `shared/` and `src/shared` only. It reaches the board through `ToolApi`, never the server's code.
- Outside `src/mcp`, only `server.ts` and `tools/registry.ts` may be imported, by tests too.

## src/server
The board: the API, the database, and the loops that run agents.

- `main.ts` (the entry) and `serve.ts` (which starts the API, the MCP server and the loops) at the root, with `testMcpPortEnv.ts` for the tests' port override. Nothing else.
- A folder per concept: `nodes/`, `stages/`, `runs/`, `schedule/`, `improvements/`, `projects/`, `config/`. One level, no deeper.
- Platform folders below them: `http/` (the app, and a routes file per concept), `db/` (connection, migrations, records), `os/` (processes and the server lock), and `shared/`, what two or more folders use.
- Folders import only downward: `http`, then `runs`, `improvements` and `schedule`, then `nodes` and `projects`, then `config` and `stages`, then `db`, `os` and `shared`. A lower folder never imports a higher one: make the call from the higher folder.
- `shared/` imports nothing else of the server's.
- `db/migrations.ts` is append-only: move it whole, never split or edit a step.
