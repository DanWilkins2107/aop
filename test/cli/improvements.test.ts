import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { aopHome } from "../../src/server/paths.js";
import { startServer } from "../../src/server/server.js";
import type { ImprovementView, ProposalView } from "../../src/shared/api.js";
import { CONFIG_YAML, harness, type Harness } from "../server/helpers.js";
import { aopInProcess, type CliResult } from "./cli.helpers.js";

const ROOT = resolve(import.meta.dirname, "../..");

let h: Harness;
let url: string;

beforeEach(async () => {
  h = harness({
    "config.yaml": `${CONFIG_YAML}improvement_stages: ./improvement_stages.yaml\n`,
    "improvement_stages.yaml": readFileSync(join(ROOT, "defaults", "improvement_stages.yaml"), "utf8"),
    "prompts/draft_change.md": "Draft it.",
    "prompts/save_locally.md": "Save it.",
    "prompts/raise_pr.md": "Raise it.",
    "skills/write-tests/SKILL.md": "Old skill.\n",
  });
  // No orchestrator, so no agent starts on the improvement, and any free port.
  const server = await startServer(h.db, 0);
  onTestFinished(() => server.close());
  url = `http://127.0.0.1:${server.port}`;
});

/** The CLI as an improvement's agent runs it: in the improvements folder, on its node. */
const aop = (args: string[], node: string): Promise<CliResult> =>
  aopInProcess(args, { AOP_URL: url, AOP_NODE_ID: node }, { cwd: join(aopHome(), "skills") });

/** Stores a proposal through the API, as the `propose` tool does. */
async function propose(id: string, path: string, content: string): Promise<void> {
  const res = await h.call("PUT", `/api/improvements/${id}/proposals`, { path, content, actor: "agent" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

describe("aop apply", () => {
  it("writes the proposals once the stage allows it", async () => {
    const { node } = (await h.call<ImprovementView>("POST", "/api/improvements", { body: "Better tests" })).body;
    const skill = join(aopHome(), "skills", "write-tests", "SKILL.md");
    await propose(node.id, skill, "New skill.\n");
    await propose(node.id, join(aopHome(), "skills", "other", "SKILL.md"), "Another.\n");

    expect((await aop(["apply"], node.id)).code).toBe(1);

    await h.post(node.id, "next", { outcome: "drafted", actor: "agent" });
    await h.post(node.id, "next", { outcome: "save_locally" });
    const applied = await aop(["apply"], node.id);
    expect(applied.stdout).toContain(`Wrote ${skill}`);
    expect(readFileSync(skill, "utf8")).toBe("New skill.\n");
    const proposals = (await h.call<ProposalView[]>("GET", `/api/improvements/${node.id}/proposals`)).body;
    expect(proposals.map((p) => p.display_path).sort()).toEqual(["other/SKILL.md", "write-tests/SKILL.md"]);
  });
});
