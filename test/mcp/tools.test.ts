import { describe, expect, it } from "vitest";
import { TOOLS } from "../../src/mcp/tools/index.js";
import { AGENT_COMMANDS, HUMAN_COMMANDS } from "../../src/cli/cli.js";

/** The agent command each tool stands for. Agents get only these, never a human command. */
const COMMAND_OF_TOOL: Record<string, keyof typeof AGENT_COMMANDS> = {
  context: "context",
  next: "next",
  ask: "ask",
  fail: "fail",
  message: "message",
  link: "link",
  search: "search",
  node_create: "node create",
  node_edit: "node edit",
  edge_add: "edge",
  edge_remove: "edge",
  split_start: "split",
  split_finish: "split",
  propose: "propose",
  withdraw_proposal: "propose",
  proposals: "proposals",
  apply: "apply",
};

describe("the MCP tools", () => {
  it("have unique snake_case names", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it("are each an agent command, and never a human one", () => {
    for (const { name } of TOOLS) {
      const command = COMMAND_OF_TOOL[name];
      expect(command, `${name} isn't mapped to an agent command`).toBeDefined();
      expect(Object.keys(AGENT_COMMANDS)).toContain(command);
      expect(Object.keys(HUMAN_COMMANDS)).not.toContain(command);
      expect(Object.keys(HUMAN_COMMANDS)).not.toContain(name);
    }
  });
});
