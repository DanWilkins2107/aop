// Where AOP listens when AOP_PORT and --port don't say. Shared by the server, the CLI and the web dev
// server, so they can't disagree. Plain data, because the web build may import it.

export const DEFAULT_PORT = 4317;

/** Where the agents' MCP server always listens, so a sandbox can allow exactly this port. */
export const MCP_PORT = 4319;

/**
 * For tests only, never documented: moves the MCP server off `MCP_PORT`, so AOP's own tests can run
 * while a real AOP, perhaps the one developing it, holds that port.
 */
export const TEST_MCP_PORT_ENV = "AOP_TEST_MCP_PORT";
