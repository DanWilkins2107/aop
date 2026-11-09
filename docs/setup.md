# AOP Setup

## Install
You need Node 22 or newer.

```
git clone https://github.com/DanWilkins2107/aop.git
cd aop
npm run setup
```

This builds AOP, puts `aop` on your PATH and runs `aop init`, which creates `~/.aop` and asks for:

- Agent session command: what AOP runs to start an agent. Defaults to `claude --permission-mode auto`. Agents run headless, so keep auto mode or an equivalent. AOP has no sandbox of its own, here is where you put the command to start a session in a sandbox if you use one. See the security documentation page for more on this.
- Out of sandbox command (optional): what `aop steer <node> --no-sandbox` runs. Not needed if not using a sandbox. 
- Open from: where agents start from by default
- Agent timeout: minutes before an agent is stopped and its node fails. Defaults to 60.
- Process: the default, or your own `stages.yaml`.

To change a setting later, edit `~/.aop/config.yaml`. To update AOP, `git pull` and restart `aop serve`.

## Install the plugin
The plugin teaches agents how to work on AOP stages. In Claude Code, from the AOP clone:
```
/plugin marketplace add ./plugin
/plugin install aop@aop
```
Then turn on auto-update for the marketplace in `/plugin` → Marketplaces.

## Your first node
1. Run `aop serve` in its own terminal and open http://127.0.0.1:4317.
2. Add a project, with a repo path if it has one.
3. Open the project, create a node and describe the work.
4. An agent picks it up. It may ask you a question, propose splitting the node, hand it to you as human-only work, or start implementing. The node page shows what it needs from you.

## Working with agents
- Stopping `aop serve` stops every agent. They pick up again when it restarts.
- `aop steer <node>` takes a node over and opens your agent session in the project's folder. Agents leave it alone until you release it from the node page or with `aop release <node>`.

## Customising your process
Your process is `~/.aop/stages.yaml`, with each agent stage's prompt in `~/.aop/prompts`. Edit a prompt to change what that agent does, including any project-specific rules. Changes apply without a restart, and the Process page shows the result and any errors.

Built-in stages such as `done`, `failed` and `ask_human_question` are always there and can't be changed.
