import { beforeEach, expect, it } from "vitest";
import { directives, type World } from "../../../test/server/agents.helpers.js";
import { aopOn, cliWorld } from "../shared/cli.helpers.js";

let w: World;
beforeEach(async () => {
  w = await cliWorld();
});

it("reap leaves a run the server tracks alone", async () => {
  const node = await w.create(directives("hang"));
  await w.runStarted(node.id);
  expect((await aopOn(w, ["reap"])).stdout).toContain("Nothing to reap");
  expect(w.runs(node.id)[0]?.status).toBe("running");
});
