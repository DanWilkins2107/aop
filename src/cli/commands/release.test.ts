import { beforeEach, expect, it } from "vitest";
import { directives, type World } from "../../../test/server/agents.helpers.js";
import { aopOn, cliWorld, parked } from "../shared/cli.helpers.js";

let w: World;
beforeEach(async () => {
  w = await cliWorld();
});

// Releasing a claim `stop` left is in `stop.test.ts`.
it("release only releases a human claim, and says why not", async () => {
  const unclaimed = await parked(w);
  const res = await aopOn(w, ["release", unclaimed.id]);
  expect(res.code).toBe(1);
  expect(res.stderr).toContain("isn't claimed");

  const node = await w.create(directives("hang"));
  await w.runStarted(node.id);
  const held = await aopOn(w, ["release", node.id]);
  expect(held.code).toBe(1);
  expect(held.stderr).toContain("belongs to");
  expect(w.node(node.id).claimed_by).toBe("agent");
  expect((await aopOn(w, ["release"], { node: node.id })).code).toBe(2);
});
