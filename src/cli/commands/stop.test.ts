import { beforeEach, expect, it } from "vitest";
import { directives, settle, type World } from "../../../test/server/agents.helpers.js";
import { aopOn, cliWorld } from "../shared/cli.helpers.js";

let w: World;
beforeEach(async () => {
  w = await cliWorld();
});

it("stop leaves the node on its stage, claimed by the human, and release lets the agent start again", async () => {
  const node = await w.create(directives("hang"));
  const run = await w.runStarted(node.id);
  // The human commands name their node, and never act on the session's.
  const fromEnv = await aopOn(w, ["stop"], { node: node.id });
  expect(fromEnv.code).toBe(2);
  expect(w.runs(node.id)[0]?.status).toBe("running");

  const stopped = await aopOn(w, ["stop", node.id]);
  expect(stopped.code).toBe(0);
  expect(stopped.stdout).toContain(run.id);
  expect(w.node(node.id)).toMatchObject({ stage: "implement", claimed_by: "human" });
  expect(w.runs(node.id)[0]).toMatchObject({ end_reason: "stopped", status: "exited" });

  const again = await aopOn(w, ["stop", node.id]);
  expect(again.code).toBe(1);
  expect(again.stderr).toContain("No agent is running");

  await settle();
  expect(w.runs(node.id)).toHaveLength(1);
  const released = await aopOn(w, ["release", node.id]);
  expect(released.code).toBe(0);
  expect(released.stdout).toContain(`Released ${node.id}`);
  await w.runStarted(node.id, 2);
});
