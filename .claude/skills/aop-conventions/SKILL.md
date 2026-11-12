---
name: aop-conventions
description: Where files go in this repo, folder by folder, and what each folder may import. Use before adding, moving or renaming a file under `src/`.
---

# AOP conventions

The gates in `meta/` enforce these: `npx vitest run meta`. Each folder's rules are in `meta/placementGate.meta.test.ts` and `meta/importBoundaryGate.meta.test.ts`. Change a rule and this skill together.

A test sits beside the file it tests, as `<name>.test.ts`.

## src/shared
What the server, the CLI, the MCP server and the browser all need.

- `api/`: the HTTP API's contract. Request schemas, the shapes it accepts and returns, its paths and its ports.
- `domain/`: facts and pure functions about AOP's own concepts, such as stages and schedules, that don't depend on the API.
- No files at the root, and no deeper folders.
- The browser loads it, so it imports only itself and `zod`: nothing from Node, and no Node globals such as `process`.
- `zod` is for `api/requests.ts`. The browser imports only types from there, which keeps zod out of its bundle.
