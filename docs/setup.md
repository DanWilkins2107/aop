# AOP Setup

## Install
- You need Node 22 or newer.
- Run:

```
git clone https://github.com/DanWilkins2107/aop.git
cd aop
npm run setup
```

- This builds AOP, puts `aop` on your PATH and runs `aop init`, which creates `~/.aop` and asks for:
  - Agent session command: what starts an agent. Defaults to `claude --permission-mode auto`. Agents run headless, so keep auto mode or an equivalent. To sandbox agents, put the sandbox in this command: see [security](security.md).
  - Out of sandbox command (optional): what `aop steer <node> --no-sandbox` runs.
  - Open from: where agents start by default.
  - Agent timeout: minutes before an agent is stopped and its node fails. Defaults to 60.
  - Process: the default, or your own `stages.yaml`.
- Change settings later in `~/.aop/config.yaml`.
- To update AOP, `git pull` and restart `aop serve`.

## Connect agents to AOP
- Agents use AOP's MCP server, not the `aop` CLI.
- `aop serve` runs it at http://127.0.0.1:4319/mcp.
- Add it once, before your first node. In Claude Code:

```
claude mcp add --scope user --transport http aop http://127.0.0.1:4319/mcp
```

- In other harnesses, add an HTTP MCP server at the same URL, named `aop` to match the plugin.

## Install the plugin
- The plugin teaches agents how to work AOP stages.
- In Claude Code, from the AOP clone:

```
/plugin marketplace add ./plugin
/plugin install aop@aop
```

- Then turn on auto-update for the marketplace in `/plugin` → Marketplaces.

## Your first node
1. Run `aop serve` in its own terminal and open http://127.0.0.1:4317.
2. Add a project, with a repo path if it has one.
3. Open the project, create a node and describe the work.
4. An agent picks it up. The node page shows anything it needs from you, such as a question or a proposed split.

## Working with agents
- Stopping `aop serve` stops every agent. They pick up again when it restarts.
- `aop steer <node>` claims a node and opens your own agent session in the project's folder. Agents leave the node alone until you release it, from the node page or with `aop release <node>`.

## Customising your process
- Your process is `~/.aop/stages.yaml`, with each agent stage's prompt in `~/.aop/prompts`.
- Edit a prompt to change what that agent does.
- Changes apply without a restart, and the Process page shows the result and any errors.
- Built-in stages such as `done`, `failed` and `ask_human_question` can't be changed. See [features](features.md) for more information on this.
