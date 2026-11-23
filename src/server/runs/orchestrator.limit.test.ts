import { describe, expect, it } from "vitest";
import type { AgentLimitView } from "../../shared/runs/types.js";
import { directives, settle, world } from "../../../test-shared/agents.js";

const TIMEOUT = { timeout: 90_000 };

describe("the agent limit", () => {
  it("holds back nodes past it, and starts them as the limit rises or agents finish", TIMEOUT, async () => {
    const w = await world();
    const running = () => w.db.prepare("SELECT count(*) AS n FROM runs WHERE status = 'running'").get() as { n: number };
    expect((await w.call<AgentLimitView>("PUT", "/agents/limit", { limit: 2 })).body).toEqual({ limit: 2, running: 0 });
    const nodes = await Promise.all([1, 2, 3, 4].map(() => w.create(directives("hang"))));
    await expect.poll(running, { timeout: 30_000 }).toEqual({ n: 2 });
    await settle();
    expect(running()).toEqual({ n: 2 });
    expect((await w.call<AgentLimitView>("GET", "/agents/limit")).body).toEqual({ limit: 2, running: 2 });

    await w.call("PUT", "/agents/limit", { limit: 3 });
    await expect.poll(running, { timeout: 30_000 }).toEqual({ n: 3 });

    const started = nodes.find((node) => w.runs(node.id).length > 0)!;
    await w.call("POST", `/runs/${w.runs(started.id)[0]!.id}/stop`);
    await expect.poll(() => nodes.every((node) => w.runs(node.id).length > 0), { timeout: 30_000 }).toBe(true);
    expect(running()).toEqual({ n: 3 });
  });

  it("lowering it stops nothing, and 0 starts nothing until it's lifted", TIMEOUT, async () => {
    const w = await world();
    const first = await w.create(directives("hang"));
    await w.runStarted(first.id);
    expect((await w.call<AgentLimitView>("PUT", "/agents/limit", { limit: 0 })).body).toEqual({ limit: 0, running: 1 });
    const second = await w.create(directives("hang"));
    await settle();
    expect(w.runs(first.id)[0]?.status).toBe("running");
    expect(w.runs(second.id)).toEqual([]);

    await w.call("PUT", "/agents/limit", { limit: null });
    await w.runStarted(second.id);
  });

  it("refuses a limit that isn't a whole number, 0 or more", TIMEOUT, async () => {
    const w = await world();
    for (const limit of [-1, 1.5, "2"]) expect((await w.call("PUT", "/agents/limit", { limit })).status).toBe(400);
    expect((await w.call<AgentLimitView>("GET", "/agents/limit")).body.limit).toBeNull();
  });
});
