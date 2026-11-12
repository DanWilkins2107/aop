import { describe, expect, it } from "vitest";
import type { EventView } from "../../shared/api.js";
import { mcpHarness, resultText } from "../shared/mcpHarness.helpers.js";

describe("the fail tool", () => {
  it("marks the node failed and posts the reason, as the agent", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev");
    const run_id = await m.run(node.id);
    expect(await m.text("fail", { node_id: node.id, run_id, reason: "The repo is gone" })).toBe(`${node.id} is now at failed`);
    expect(await m.node(node.id)).toMatchObject({ stage: "failed", return_stage: "write_spec" });
    const messages = (await m.call<{ author: string; body: string; stage: string }[]>("GET", `/api/nodes/${node.id}/messages`)).body;
    expect(messages.map((msg) => [msg.author, msg.body, msg.stage])).toEqual([["agent", "The repo is gone", "failed"]]);
    const events = (await m.call<EventView[]>("GET", `/api/nodes/${node.id}/events`)).body;
    expect(events.find((e) => e.kind === "stage_changed")).toMatchObject({ actor: "agent", data: { via: "fail", reason: "The repo is gone" } });
  });

  it("fails with the API's message from a human stage", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev");
    await m.post(node.id, "next", { outcome: "done" });
    const result = await m.tool("fail", { node_id: node.id, run_id: await m.run(node.id), reason: "Stuck" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/Can't fail: stage "spec_review" is not an agent stage/);
    expect((await m.node(node.id)).stage).toBe("spec_review");
  });

  it("fails for an unknown node", async () => {
    const m = await mcpHarness();
    const result = await m.tool("fail", { node_id: "no-such-node", run_id: await m.run(), reason: "Stuck" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/no-such-node/);
  });

  it("is listed, with node_id, run_id and reason required", async () => {
    const m = await mcpHarness();
    const tool = (await m.tools()).find((t) => t.name === "fail");
    expect(tool?.description).toMatch(/failed/);
    expect(tool?.description).toMatch(/asking a human won't help/);
    expect(tool?.description).toMatch(/ends your turn/);
    expect([...(tool?.inputSchema.required ?? [])].sort()).toEqual(["node_id", "reason", "run_id"]);
  });
});
