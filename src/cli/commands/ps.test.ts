import { beforeEach, expect, it } from "vitest";
import { directives, type World } from "../../../test/server/agents.helpers.js";
import { aopOn, cliWorld } from "../shared/cli.helpers.js";

let w: World;
beforeEach(async () => {
  w = await cliWorld();
});

it("ps lists the running agents", async () => {
  expect((await aopOn(w, ["ps"])).stdout).toContain("No agents running");
  const node = await w.create(directives("hang"), { title: "Listed" });
  const run = await w.runStarted(node.id);
  const listed = await aopOn(w, ["ps"]);
  for (const text of [run.id, node.id, "Listed", "running", String(run.pid)]) expect(listed.stdout).toContain(text);
});
