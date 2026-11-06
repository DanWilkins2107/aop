# AOP Setup
To get started with aop clone the repo as follows:

```
git clone https://github.com/DanWilkins2107/aop.git
cd aop
npm install
npm run build
npm link
```

You need Node 22 or newer. `npm link` puts `aop` on your PATH. Agents need it there too, since they report back through the `aop` command.

To update later, stop `aop serve`, then `git pull`, `npm install` and `npm run build` again.

## One-time setup
Then run `aop init` once to set up aop on your machine. This creates a `.aop` folder in your home directory holding your config and database. Nothing is ever added to the repos you work in.

It asks for:
1. **Agent session command** (required). What AOP runs to start an agent, such as `claude`. AOP adds `-p` and sends the prompt on stdin. AOP doesn't ship a sandbox, so point this at your own sandboxed wrapper before letting agents run unattended. Agents run headless, so they can't ask you to approve commands or edits, and anything not already allowed is refused. Run them in Claude Code's auto mode, or an equivalent permission setting: add `--permission-mode auto` to this command, or set `"defaultMode": "auto"` under `permissions` in `~/.claude/settings.json`. Set it there rather than in a repo. AOP adds no permission flags itself.
2. **Out of sandbox command** (optional). Sometimes you may want to run an AOP-driven session outside a sandbox yourself. Only used by `aop steer <node> --no-sandbox`. Leave it blank if you don't sandbox.
3. **Open from.** Where sessions start for projects with no path. Defaults to `~/code`, and offers to create it.
4. **Agent timeout.** Minutes before a running agent is stopped and its node goes to `failed`. Defaults to 60.
5. **Process.** Use the default process, or give the path to your own `stages.yaml`.

`aop init --yes --agent-session-command <cmd>` skips the questions and uses defaults for the rest. `aop init --help` lists every flag.

Afterwards `~/.aop` holds:
- `config.yaml`: the settings above.
- `stages.yaml` and `prompts/`: your process, if you took the default.
- `aop.db`: all state, created by `aop serve`.
- `logs/`: one log per agent run.

`aop init` won't overwrite an existing config. Edit `~/.aop/config.yaml` by hand, or run `aop init --fill-missing` to add back any default files you deleted. Set `AOP_HOME` to keep everything somewhere other than `~/.aop`.

## Install the plugin
The plugin teaches agents how to behave on AOP stages. `aop init` prints these steps with your clone's real path.

**Claude Code**, inside a `claude` session:
```
/plugin marketplace add /path/to/aop/plugin
/plugin install aop@aop
```
Or for one session: `claude --plugin-dir /path/to/aop/plugin`.

**GitHub Copilot CLI** (untested):
```
copilot plugin install /path/to/aop/plugin
```

## Tutorial: your first node
1. Start the server and leave it running in its own terminal:
   ```
   aop serve
   ```
   It prints its address, `http://127.0.0.1:4317`, and where your config and database are. Use `aop serve --port <port>` to pick another port.
2. Open that address. Click **Add project**, give it a name and, optionally, the path to a repo. Agents start in that path, or in `open_from` if there isn't one. You can also add one from the terminal with `aop project add <path>`.
3. Open the project and click **New node**. Give it a title and a description of the work, leave **Starts in** on the default and click **Create node**.
4. The node starts in triage, at `awaiting_agent_breakdown`, and an agent starts on it straight away. Click the node to see its page. Under **Details** the runs table shows the agent's log as it works. The agent then does one of these:
   - **Asks a question.** The node goes to `ask_human_question`. Type your reply in the message box and click **Answer**. The agent starts again with your answer.
   - **Proposes a split.** The node goes to `split_proposed`, with the proposed children in its messages. Click **Approve** or **Reject**, and add a message first if you want changes. Once approved, an agent creates the children and the node becomes `broken_down`. Each child then goes through its own stages.
   - **Says it's ready.** The node moves to `dev`, and an agent implements it.
   - **Says only a human can do it.** It goes to `human_only_action`. Do the work, then click **Done**.
5. When the implement agent raises a PR, the link appears at the top of the node page and the node goes to `pr_review`. Review the PR, then click **Approve**, or **Changes** to send it back to the agent. Leave your comments on the PR or in the node's messages.
6. At `second_human_review`, merge the PR and click **Merged**. The node is `done`.

### Taking over a session
To work on a node yourself, click **Copy ID** next to its title on the node page (it's also in the address, `/n/<id>`) and run:
```
aop steer <node>
```
This claims the node and opens your agent session command in the project's folder, with the node set so `aop` commands work inside it. Use `--no-sandbox` to use your out of sandbox command instead. It's refused while an agent run holds the node, so stop the run first. Your claim stays until you click **Release claim** on the node page or run `aop release <node>`, and no agent starts on the node until then.

### Seeing and stopping agents
- `aop ps` lists every running agent and its node.
- To stop one, open its node and click **Stop run** under **Details**, or run `aop stop <node>`. The node stays on its stage, claimed by you. Release the claim to start the stage again.
- To stop working on a node for good, use **Invalidate or block** at the top of the node page. Invalidating stops agents on it and everything under it.
- Stopping `aop serve` with Ctrl+C stops every agent and queues their nodes. They start again on the next `aop serve`.
- `aop reap` kills any agent process that shouldn't still be running.

### Logs and settings
- Each run's log is in `~/.aop/logs`. The node page shows the latest run's log, and a failed node links to its full log. `aop logs <node> [--lines N]` prints the end of the latest run's log in the terminal. Click **Retry** to run the stage again.
- The **AOP settings** page shows your config. It's read-only: edit `~/.aop/config.yaml` to change it. Changes apply to the next agent that starts.

## Customising your process
Your process lives in `~/.aop/stages.yaml`, and each agent stage's prompt is a file in `~/.aop/prompts`. To change it:
- **Change what an agent does:** edit its prompt file. Project-specific rules go here too.
- **Add or change stages:** add a stage to the `stages` pool, then use it in a type's `next`. Agent stages need a `prompt`.
- **Use your own file:** point `stages` in `config.yaml` at it. It can live anywhere.

You don't need to restart `aop serve`. AOP checks the file, and if it's invalid it shows the problems in the UI and starts no new agents until it's fixed. The **Process** page draws each type so you can check the result. The rules for how agents behave on every stage are the plugin's skills, in `plugin/skills`.

See [features.md](features.md) for how nodes, stages and types work.
