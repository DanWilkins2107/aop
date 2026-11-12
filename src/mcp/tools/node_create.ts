import { z } from "zod";
import type { CreateNodeRequest, NodeView } from "../../shared/nodes/types.js";
import type { ProjectRow } from "../../shared/projects/types.js";
import { apiPaths } from "../../shared/http/apiPaths.js";
import { ACTOR } from "../shared/actor.js";
import { defineTool } from "../shared/defineTool.js";
import { ApiFailure, type ToolApi } from "../shared/toolApi.js";

/** A project named by ID or name. */
async function resolveProject(api: ToolApi, reference: string): Promise<string> {
  const projects = await api.json<ProjectRow[]>("GET", apiPaths.projects);
  const matches = projects.filter((p) => p.id === reference || p.name === reference);
  const [project] = matches;
  if (project === undefined) throw new ApiFailure(`No project "${reference}"`);
  if (matches.length > 1) throw new ApiFailure(`Several projects are called "${reference}". Use its ID`);
  return project.id;
}

export const nodeCreate = defineTool({
  name: "node_create",
  writes: true,
  description:
    "Create an AOP node. It goes in the named project, or else the parent's, or else your own node's. " +
    "`type` starts it at that type's first stage; `stage` starts it exactly there. With both, `type` says which type's `stage` is meant. " +
    "During a split, children you create are held until the split finishes.",
  input: {
    node_id: z.string().min(1).describe("Your own node's ID, from your prompt. Used only to choose the project when neither project nor parent is given."),
    title: z.string().min(1).describe("The new node's title."),
    body: z.string().optional().describe("The new node's description."),
    parent: z.string().min(1).optional().describe("The ID of the node to create it under."),
    project: z.string().min(1).optional().describe("The project to create it in, by ID or name."),
    type: z.string().min(1).optional().describe("Start it at this type's first stage, or with stage, the type that stage belongs to."),
    stage: z.string().min(1).optional().describe("Start it exactly at this stage."),
  },
  run: async ({ node_id, title, body, parent, project, type, stage }, api) => {
    const projectId =
      project !== undefined ? await resolveProject(api, project) : (await api.json<NodeView>("GET", apiPaths.node(parent ?? node_id))).project_id;
    const node = await api.json<NodeView>("POST", apiPaths.projectAction(projectId, "nodes"), {
      title,
      actor: ACTOR,
      ...(body !== undefined ? { body } : {}),
      ...(parent !== undefined ? { parent_id: parent } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(stage !== undefined ? { stage } : {}),
    } satisfies CreateNodeRequest);
    return `Created ${node.id} at ${node.stage}`;
  },
});
