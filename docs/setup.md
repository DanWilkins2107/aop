# AOP Setup

## Quick start
You need Node 22 or newer.

1. **Install.**
   ```
   git clone https://github.com/DanWilkins2107/aop.git
   cd aop
   npm run setup
   ```
   This installs, builds and runs `npm link`, which puts `aop` on your PATH. Agents need it there too: they report back through the `aop` command. It then runs `aop init`, so answer its questions (see [aop init](#aop-init)). Re-running it is safe: once you're set up, it skips `aop init`.
2. **Install the plugin** in your agent tool (see [The plugin](#the-plugin)).
3. **Start the server.** Run `aop serve` and leave it running in its own terminal.
4. **Open http://127.0.0.1:4317** and follow [Your first node](#your-first-node).

To update, run `git pull` in the clone and restart `aop serve`. It rebuilds itself when the sources have changed.

## aop init
`aop init` creates `~/.aop`, which holds your config and database. It asks for:

1. **Agent session command** (required). What AOP runs to start an agent. AOP adds `-p` and sends the prompt on stdin. Defaults to `claude --permission-mode auto`, or `copilot` if that's the only tool you have.
   - AOP doesn't ship a sandbox. Point this at your own sandboxed wrapper before you let agents run unattended.
   - Agents run headless, so they can't ask you to approve commands or edits, and anything not already allowed is refused. That's why the default uses Claude Code's auto mode. If you change the command, keep auto mode or an equivalent.
2. **Out of sandbox command** (optional). Sometimes you may want to run an AOP-driven session outside a sandbox yourself. This is the command `aop steer <node> --no-sandbox` runs. Leave it blank if you don't sandbox.
3. **Open from.** Where sessions start for projects with no path. Defaults to `~/code`, and offers to create it.
4. **Agent timeout.** Minutes before a running agent is stopped and its node goes to `failed`. Defaults to 60.
5. **Process.** Start with the default setup, or give the path to your own `stages.yaml`.

Other ways to run it:
- `aop init --yes --agent-session-command <cmd>` skips the questions and uses defaults for everything else.
- `aop init --fill-missing` adds back any default files you've deleted. It never overwrites.
- `aop init --help` lists every flag.

`aop init` won't overwrite an existing config. To change a setting later, edit `~/.aop/config.yaml`.

Set `AOP_HOME` to keep everything somewhere other than `~/.aop`.

### What's in ~/.aop
- `config.yaml`: your settings.
- `stages.yaml` and `prompts/`: your process, if you took the default.
- `improvement_stages.yaml` and `skills/`: the improvements pipeline and the folder it may change.
- `aop.db`: all state, created by `aop serve`.
- `logs/`: one log per agent run.

## The plugin
The plugin teaches agents how to behave on AOP stages. Use `./plugin` if you're running the tool from inside your AOP clone, or the clone's full path otherwise.

**Claude Code**, inside a `claude` session:
```
/plugin marketplace add ./plugin
/plugin install aop@aop
```
From anywhere else: `/plugin marketplace add /path/to/aop/plugin`.

Turn on auto-update for the aop marketplace (`/plugin` → Marketplaces) so agents get plugin updates.

Or for one session only: `claude --plugin-dir ./plugin`, or `claude --plugin-dir /path/to/aop/plugin`.

**GitHub Copilot CLI** (untested):
```
copilot plugin install ./plugin
```
From anywhere else: `copilot plugin install /path/to/aop/plugin`.

## Your first node
For what nodes, stages and types are, see [features.md](features.md).

1. Run `aop serve`. It prints its address and where your config and database are. Use `aop serve --port <port>` for another port.
2. Open the address and click **Add project**. Give it a name and, optionally, a repo path. Agents start in that path, or in `open_from` if there isn't one. From the terminal: `aop project add <path>`.
3. Open the project, click **New node**, give it a title and a description of the work, leave **Starts in** on the default and click **Create node**.
4. The node starts at `awaiting_agent_breakdown` and an agent starts on it straight away. Click the node to open its page. The runs table under **Details** shows the agent's log as it works. The agent then does one of these:
   - **Asks a question:** the node goes to `ask_human_question`. Type your reply in the message box and click **Answer**. The agent starts again with your answer.
   - **Proposes a split:** the node goes to `split_proposed`, with the proposed children in its messages. Click **Approve** or **Reject**, adding a message first if you want changes. Once approved, an agent creates the children and the node becomes `broken_down`. Each child goes through its own stages.
   - **Says it's ready:** the node moves to `dev` and an agent implements it.
   - **Says only a human can do it:** the node goes to `human_only_action`. Do the work, then click **Done**. To ask about it first, type your question in the message box and click **Clarify**: an agent answers in the messages and the node comes back to you.
5. When the agent raises a PR, the link appears at the top of the node page and the node goes to `pr_review`. Review the PR, then click **Approve**, or **Changes** to send it back. Leave comments on the PR or in the node's messages.
6. At `second_human_review`, merge the PR and click **Merged**. The node is `done`.

## Working with agents
### Taking over a node
Click **Copy ID** next to the node's title (the ID is also in the address, `/n/<id>`), then run:
```
aop steer <node>
```
- This claims the node and opens your agent session command in the project's folder, with the node set so `aop` commands work inside it.
- `--no-sandbox` uses your out of sandbox command instead.
- It's refused while an agent run holds the node. Stop the run first.
- No agent starts on the node until you release it: click **Release claim** on the node page, or run `aop release <node>`.

### Seeing and stopping agents
- `aop ps` lists every running agent and its node.
- **Stop run** under **Details**, or `aop stop <node>`, stops one. The node stays on its stage, claimed by you. Release the claim to start the stage again.
- **Invalidate or block**, at the top of the node page, stops work on a node for good. Invalidating stops agents on it and everything under it.
- Ctrl+C on `aop serve` stops every agent and queues their nodes. They start again on the next `aop serve`.
- `aop reap` kills any agent process that shouldn't still be running.

### Logs
- Each run's log is in `~/.aop/logs`. The node page shows the latest run's log, and a failed node links to its full log.
- `aop logs <node> [--lines N]` prints the end of the latest run's log.
- **Retry** runs the stage again.

### Settings
The **AOP settings** page shows your config. It's read-only: edit `~/.aop/config.yaml` to change it. Changes apply to the next agent that starts.

## Customising your process
Your process is `~/.aop/stages.yaml`, and each agent stage's prompt is a file in `~/.aop/prompts`.
- **Change what an agent does:** edit its prompt file. Project-specific rules go here too.
- **Add or change stages:** add a stage to the `stages` pool, then use it in a type's `next`. Agent stages need a `prompt`.
- **Use your own file:** point `stages` in `config.yaml` at it. It can live anywhere.

### Built-in stages
Every process has these, whatever your `stages.yaml` says. You don't define them, and you can't remove them, rename them or change their colour. Their names are reserved, so no stage or type of yours can use one.
- `done` and `broken_down` finish a node. They're the only built-ins a `next` can lead to.
- `ask_human_question`, `failed`, `externally_blocked` and `invalidated` can be reached from any stage, through asking, failing, blocking and invalidating. They don't appear in types.
- `splitting` holds the children an agent is creating until the split finishes.
- `scheduled` is the only one you list in a type, with exactly one outcome, saying where its children start. See [Scheduled nodes](features.md#scheduled-nodes).

You don't need to restart `aop serve`. If the file is invalid, AOP shows the problems in the UI and starts no new agents until it's fixed. The **Process** page draws each type so you can check the result. The rules agents follow on every stage are the plugin's skills, in `plugin/skills`.
