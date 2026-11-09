import { describe, expect, it } from "vitest";
import { TOOLS } from "../../src/mcp/tools/index.js";
import { HUMAN_COMMANDS } from "../../src/cli/cli.js";

/** Every tool an agent is designed to use. The server offers these and nothing else, though not all exist yet. */
const AGENT_TOOLS = [
  "context",
  "next",
  "ask",
  "fail",
  "message",
  "link",
  "search",
  "node_create",
  "node_edit",
  "edge_add",
  "edge_remove",
  "split_start",
  "split_finish",
  "propose",
  "withdraw_proposal",
  "proposals",
  "apply",
];

describe("the MCP tools", () => {
  it("have unique snake_case names", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it("are each one of the agent tools", () => {
    for (const { name } of TOOLS) expect(AGENT_TOOLS, `${name} isn't an agent tool`).toContain(name);
  });

  it("never share a name with a human command", () => {
    const human = Object.keys(HUMAN_COMMANDS).map((command) => command.replaceAll(" ", "_"));
    for (const name of AGENT_TOOLS) expect(human, `${name} is a human command`).not.toContain(name);
  });
});
