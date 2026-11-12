---
name: aop-conventions
description: Where files go in this repo, folder by folder, and what each folder may import. Use before adding, moving or renaming a file under `src/`.
---

# AOP conventions

The gates in `meta/` enforce these: `npx vitest run meta`. Each folder's rules are in the `meta/*.meta.test.ts` files. Change a rule and this skill together.

A test sits beside the file it tests, as `<name>.test.ts`. A helper only tests use is `<name>.helpers.ts`: nothing but tests and other helpers may import it, and the import rules below don't apply to either.

## src/mcp
The agents' MCP server.

- `server.ts`: the only file at the root, with its test. The only file that imports `src/server`.
- `tools/`: one file per tool, named as the tool, plus `registry.ts`, the `TOOLS` list. A tool stays one file until it alone needs a second, then becomes `tools/<name>/`.
- `shared/`: what two or more files of `src/mcp` use, such as `defineTool`. Code two tools share goes here, never in one tool's file.
- A tool imports `shared/` and `src/shared` only. It reaches the board through `ToolApi`, never the server's code.
- Outside `src/mcp`, only `server.ts` and `tools/registry.ts` may be imported, by tests too.
