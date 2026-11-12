# AOP: notes for coding agents

Read the code for the area you change: it shows the conventions.

- `docs/` is written by humans: don't edit it unless asked.
- Migrations are append-only: never edit, remove or reorder a step.
- Agents can reach the API and the MCP tools, so no route or tool may change commands or `config.yaml`.
- The server never writes to a project's path.
- The dev machine is Windows: keep scripts and paths cross-platform.
- Run `npm run typecheck`, then `npx vitest run <file>`. Don't run the whole suite unless asked.
- Never run `npm start`, `npm run dev:web` or `aop serve`. Never bind 4317 or 4319, never touch the real `~/.aop`, and never launch real `claude` or `copilot`.
