/**
 * For tests only, never documented: moves the MCP server off `MCP_PORT`, so AOP's own tests can run
 * while a real AOP, perhaps the one developing it, holds that port.
 */
export const TEST_MCP_PORT_ENV = "AOP_TEST_MCP_PORT";
