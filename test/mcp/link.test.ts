import { describe, expect, it } from "vitest";
import type { EventView, LinkRow } from "../../src/shared/api.js";
import { mcpHarness, resultText } from "./helpers.js";

describe("the link tool", () => {
  it("attaches the link to the node, as the agent", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev");
    const url = "https://github.com/acme/app/pull/7";
    expect(await m.text("link", { node_id: node.id, kind: "pr", url })).toBe(`Linked pr ${url}`);
    const links = (await m.call<LinkRow[]>("GET", `/api/nodes/${node.id}/links`)).body;
    expect(links.map((l) => [l.kind, l.url])).toEqual([["pr", url]]);
    const events = (await m.call<EventView[]>("GET", `/api/nodes/${node.id}/events`)).body;
    expect(events.find((e) => e.kind === "link_added")).toMatchObject({ actor: "agent", data: { kind: "pr", url } });
  });

  it("fails with the API's message for a URL that isn't http(s)", async () => {
    const m = await mcpHarness();
    const node = await m.create("dev");
    const result = await m.tool("link", { node_id: node.id, kind: "ticket", url: "ftp://example.com/1" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/must start with http:\/\/ or https:\/\//);
    expect((await m.call<LinkRow[]>("GET", `/api/nodes/${node.id}/links`)).body).toEqual([]);
  });

  it("fails for an unknown node", async () => {
    const m = await mcpHarness();
    const result = await m.tool("link", { node_id: "no-such-node", kind: "pr", url: "https://example.com/1" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/no-such-node/);
  });

  it("is listed, with node_id, kind and url required", async () => {
    const m = await mcpHarness();
    const tool = (await m.tools()).find((t) => t.name === "link");
    expect(tool?.description).toMatch(/PR or ticket link/);
    expect([...(tool?.inputSchema.required ?? [])].sort()).toEqual(["kind", "node_id", "url"]);
  });
});
