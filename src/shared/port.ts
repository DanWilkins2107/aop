// Where AOP listens when AOP_PORT and --port don't say. Shared by the server, the CLI and the web dev
// server, so they can't disagree. Plain data, because the web build may import it.

export const DEFAULT_PORT = 4317;
