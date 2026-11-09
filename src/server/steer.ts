import type { SteerSession } from "../shared/api.js";
import { loadConfig } from "./config.js";
import type { Db } from "./db.js";
import { refused } from "./errors.js";
import { isFolder } from "./fsUtil.js";
import { steerSessionFor } from "./claims.js";
import { claim, getNodeRow } from "./nodes.js";
import { nodeStartPath } from "./projects.js";

/**
 * Claims a node for the human and says what to run. The CLI runs it, because the session belongs in
 * the human's terminal. A claim the human already holds is fine, so a session can be reopened, and
 * keeps its steer ID.
 */
export function prepareSteer(db: Db, nodeId: string, input: { no_sandbox: boolean }): SteerSession {
  const node = getNodeRow(db, nodeId);
  const config = loadConfig();

  const command = input.no_sandbox ? config.out_of_sandbox_command : config.agent_session_command;
  if (command === undefined) {
    throw refused("aop steer --no-sandbox needs out_of_sandbox_command, which isn't set in config.yaml");
  }
  const cwd = nodeStartPath(db, node, config);
  if (!isFolder(cwd)) throw refused(`Can't open a session: the start folder doesn't exist: ${cwd}`);

  // A run on its way out has already given up its claim, but its process is still on the node.
  const run = db.prepare("SELECT id FROM runs WHERE node_id = ? AND status = 'running'").get(nodeId) as { id: string } | undefined;
  if (run) throw refused(`Can't steer: agent run ${run.id} holds this node`);

  const steerId = db.transaction(() => {
    claim(db, nodeId, { actor: "human" });
    return steerSessionFor(db, nodeId);
  })();
  return { node_id: nodeId, command, cwd, steer_id: steerId };
}
