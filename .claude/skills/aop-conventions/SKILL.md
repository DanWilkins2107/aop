---
name: aop-conventions
description: Where files go in this repo, folder by folder, and what each folder may import. Use before adding, moving or renaming a file under `src/`.
---

# AOP conventions

The gates in `meta/` enforce these: `npx vitest run meta`. Each folder's rules are in the `meta/*.meta.test.ts` files. Change a rule and this skill together.

A test sits beside the file it tests, as `<name>.test.ts`. A helper only tests use is `<name>.helpers.ts`: nothing but tests and other helpers may import it, and the import rules below don't apply to either.

A helper that tests in two or more folders use goes in a `test-shared/` folder, which only tests may import. Otherwise it stays beside its tests.

`npm run typecheck` also runs oxlint and knip (unused files, exports and dependencies). They cover a folder once its layout is settled: take the folder out of `ignorePatterns` in `.oxlintrc.json` and `ignore` in `knip.json`, and fix what they find.

## src/shared
What two or more of `src/server`, `src/cli`, `src/mcp` and `web/src` use. Tests don't count.

- One folder per concept: `nodes/`, `stages/`, `runs/`, `schedule/`... Nothing at the root. A concept can nest its own folders.
- Each folder's types all go in its `types.ts`. Every other file exports one value, named as the file (`isBuiltIn.ts` exports `isBuiltIn`).
- Import from it by name: no `import *` and no re-exports.
- An export only one side uses moves to that side, unless other shared code is built from it. One no side uses is deleted.
- Request types (`*Request`) are the API's contract and live here, hand-written. The server's zod schemas, in `src/server/requests.ts`, are checked against them with `bodyOf<T>()`.
- It imports nothing outside itself, not even a package, so the browser can load all of it.

## src/mcp
The agents' MCP server.

- `server.ts`: the only file at the root, with its test. The only file that imports `src/server`.
- `tools/`: one file per tool, named as the tool, plus `registry.ts`, the `TOOLS` list. A tool stays one file until it alone needs a second, then becomes `tools/<name>/`.
- `shared/`: what two or more files of `src/mcp` use, such as `defineTool`. Code two tools share goes here, never in one tool's file.
- A tool imports `shared/` and `src/shared` only. It reaches the board through `ToolApi`, never the server's code.
- Outside `src/mcp`, only `server.ts` and `tools/registry.ts` may be imported, by tests too.
