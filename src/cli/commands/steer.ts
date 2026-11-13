import { spawn } from "node:child_process";
import type { SteerRequest, SteerSession } from "../../shared/api.js";
import { apiPaths } from "../../shared/paths.js";
import { send, serverUrl } from "../shared/api.js";
import { args, only } from "../shared/args.js";
import type { Command } from "../shared/command.js";
import { CliFailure } from "../shared/errors.js";

const usage = ["aop steer <node> [--no-sandbox]"];

/** Claims a node for the human, and opens an interactive session on it. Exits with the session's code. */
export const steer: Command = {
  name: "steer",
  usage,
  async run(c, argv) {
    const { values, positionals } = args(argv, usage, { "no-sandbox": { type: "boolean" } });
    const id = only(positionals, usage);
    const session = await send<SteerSession>(c, "POST", apiPaths.nodeAction(id, "steer"), { no_sandbox: values["no-sandbox"] === true } satisfies SteerRequest);
    c.log(`Claimed ${id}. Opening a session in ${session.cwd}. Release the claim in the UI or with \`aop release ${id}\` when you're done.`);
    c.log(`Run ID for this session: ${session.steer_id}. Tell your agent to pass it as run_id, with ${id} as node_id. It works until you release the claim.`);
    // The command is the user's own config string, which may need a shell. No node text goes in it.
    // A steered session is the human's, not an agent run, even when steered from inside one: its run
    // ID is the session's own, tied to the human's claim. AOP_URL is for any `aop` the human runs there.
    const child = spawn(session.command, {
      shell: true,
      cwd: session.cwd,
      stdio: "inherit",
      env: { ...c.env, AOP_URL: serverUrl(c), AOP_RUN_ID: session.steer_id },
    });
    return new Promise<number>((done, fail) => {
      child.once("error", (error) => fail(new CliFailure(`Couldn't open the session: ${error.message}`)));
      child.once("exit", (code) => done(code ?? 1));
    });
  },
};
