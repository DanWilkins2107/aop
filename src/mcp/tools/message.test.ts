import { describe, expect, it } from "vitest";
import type { MessageRow } from "../../shared/nodes/types.js";
import { mcpHarness, resultText } from "../shared/mcpHarness.helpers.js";

describe("the message tool", () => {
  it("posts on the given node, as the agent", async () => {
    const m = await mcpHarness();
    const own = await m.create("dev");
    const other = await m.create("hotfix");
    expect(await m.text("message", { node_id: other.id, run_id: await m.run(own.id), body: "Heads up" })).toBe(`Posted to ${other.id}`);
    const messages = (await m.call<MessageRow[]>("GET", `/api/nodes/${other.id}/messages`)).body;
    expect(messages.map((msg) => [msg.author, msg.body, msg.stage])).toEqual([["agent", "Heads up", other.stage]]);
    expect((await m.call<MessageRow[]>("GET", `/api/nodes/${own.id}/messages`)).body).toEqual([]);
  });

  it("fails with the API's message for a blank body", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev");
    const result = await m.tool("message", { node_id: node.id, run_id: await m.run(node.id), body: "   " });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/Invalid request body/);
    expect(resultText(result)).toMatch(/must not be blank/);
    expect((await m.call<MessageRow[]>("GET", `/api/nodes/${node.id}/messages`)).body).toEqual([]);
  });

  it("fails for an unknown node", async () => {
    const m = await mcpHarness();
    const result = await m.tool("message", { node_id: "no-such-node", run_id: await m.run(), body: "Hi" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/no-such-node/);
  });

  it("is listed, with node_id, run_id and body required", async () => {
    const m = await mcpHarness();
    const tool = (await m.tools()).find((t) => t.name === "message");
    expect(tool?.description).toMatch(/Post a message/);
    expect(tool?.annotations).toBeUndefined();
    expect([...(tool?.inputSchema.required ?? [])].sort()).toEqual(["body", "node_id", "run_id"]);
  });
});
