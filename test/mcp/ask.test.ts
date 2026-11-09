import { describe, expect, it } from "vitest";
import type { EventView } from "../../src/shared/api.js";
import { mcpHarness, resultText } from "./helpers.js";

describe("the ask tool", () => {
  it("moves the node to wait on a human and posts the question, as the agent", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev");
    expect(await m.text("ask", { node_id: node.id, question: "Which DB?" })).toBe(`${node.id} is now at ask_human_question`);
    expect(await m.node(node.id)).toMatchObject({ stage: "ask_human_question", return_stage: "write_spec" });
    const messages = (await m.call<{ author: string; body: string; stage: string }[]>("GET", `/api/nodes/${node.id}/messages`)).body;
    expect(messages.map((msg) => [msg.author, msg.body, msg.stage])).toEqual([["agent", "Which DB?", "ask_human_question"]]);
    const events = (await m.call<EventView[]>("GET", `/api/nodes/${node.id}/events`)).body;
    expect(events.find((e) => e.kind === "stage_changed")).toMatchObject({ actor: "agent", data: { via: "ask" } });
  });

  it("fails with the API's message from a human stage", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev");
    await m.post(node.id, "next", { outcome: "done" });
    const result = await m.tool("ask", { node_id: node.id, question: "?" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/Can't ask: stage "spec_review" is not an agent stage/);
    expect((await m.node(node.id)).stage).toBe("spec_review");
  });

  it("fails for an unknown node", async () => {
    const m = await mcpHarness();
    const result = await m.tool("ask", { node_id: "no-such-node", question: "?" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/no-such-node/);
  });

  it("is listed, with node_id and question required", async () => {
    const m = await mcpHarness();
    const tool = (await m.tools()).find((t) => t.name === "ask");
    expect(tool?.description).toMatch(/human/);
    expect(tool?.description).toMatch(/ends your turn/);
    expect([...(tool?.inputSchema.required ?? [])].sort()).toEqual(["node_id", "question"]);
  });
});
