import type { AddProjectRequest, ProjectRow } from "../../shared/projects/types.js";
import { apiPaths } from "../../shared/http/apiPaths.js";
import { send } from "../shared/api.js";
import { args } from "../shared/args.js";
import type { Command } from "../shared/command.js";
import { usageError } from "../shared/errors.js";

const usage = ["aop project add <path>"];

/** Registers a repo as a project. */
export const project: Command = {
  name: "project",
  usage,
  async run(c, argv) {
    const [action, path, ...extra] = args(argv, usage, {}).positionals;
    if (action !== "add" || path === undefined || extra.length > 0) throw usageError(usage);
    const added = await send<ProjectRow>(c, "POST", apiPaths.projects, { repo_path: path } satisfies AddProjectRequest);
    c.log(`Added project "${added.name}" (${added.id})`);
  },
};
