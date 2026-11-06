# CLI

`aop` talks to the server over HTTP. The plugin teaches agents to use it.

## Agents
AOP sets `AOP_NODE_ID` when it launches an agent, so commands act on that agent's node without an ID.

```
aop context [<id>]          # where the node sits in the tree, its description, messages, links and outcomes
aop next <outcome>
aop ask "..."
aop fail "<reason>"         # only when the work can't be done and asking won't help
aop message "..." [--node <id>]
aop link pr|ticket <url>
aop search <query> [--all]
aop node create --title ... [--body ...] [--parent ...] [--project ...] [--type ... | --stage ...]
aop node edit [<id>] [--title ...] [--body ...]
aop edge add blocks <from> <to>
aop edge remove blocks <from> <to>
aop split start
aop split finish
aop propose <path> [--from <file>]   # improvements only: see improvements.md
aop propose <path> --withdraw
aop proposals [--show <path>]
aop apply [--into <checkout>]
```

- An agent can only move its own node. `next`, `ask`, `fail` and the split commands take no ID.
- Reading other nodes, messaging them, and editing titles and bodies are allowed. Agents are trusted to behave on the board, and every edit is recorded in `events`.
- During `split_approved`, the agent chooses each child's type or stage with `aop node create`.

## Humans
```
aop init                        # one-time machine setup: commands, sandbox, plugin, ~/.aop, improvements
aop project add <path>
aop serve                       # runs the server, rebuilding first if the checkout changed
aop steer <node>                # runs agent_session_command
aop steer <node> --no-sandbox   # runs out_of_sandbox_command
aop ps                          # lists agent processes, see orchestrator.md
aop reap                        # kills agent processes that shouldn't exist
aop stop <node>                 # stops the running agent, like the UI's Stop run
aop release <node>              # releases your claim, like the UI
aop logs <node> [--lines N]     # the end of the latest run's log as the node page shows it, 50 lines by default, at most 200
```

- Setup is `npm run setup` in a clone: `npm install`, `npm run build`, `npm link`, then `node dist/cli/main.js init --if-new`. With a config already there, `--if-new` prints one line and exits 0, so setup can be re-run.
- `aop init` suggests `claude --permission-mode auto` as the agent session command, or `copilot` if that's the only tool on PATH. `--yes` still needs `--agent-session-command`. The closing auto-mode tip is left out when the command already has `--permission-mode`.
- `aop serve` from a git checkout's `dist/` checks the build first, so updating is `git pull` and a restart. If anything in `src/`, `web/`, `package.json`, `package-lock.json`, the tsconfigs, `vite.config.ts` or `docs/roadmap.md` is newer than the oldest of `dist/cli/main.js`, `dist/server/main.js` and `dist/web/index.html`, it prints `Building AOP (sources changed)…`, runs `npm install` if `node_modules/.package-lock.json` lacks a package or version `package-lock.json` asks for, runs `npm run build`, then re-runs itself on the new build with `AOP_SELF_BUILT` set. A failed install or build exits 1 instead of serving the old build. An installed package has no `src/`, and skips all of this.
- `aop steer` opens your own session on a node, in the project's path or `open_from`, with `AOP_NODE_ID` set so the commands above work. It claims the node for you, and errors if an agent run holds it. See claims in [orchestrator.md](orchestrator.md).
- `aop stop`, `aop release` and `aop logs` act as the human and always take a node ID, never `AOP_NODE_ID`. `aop stop` leaves the node on its stage, claimed by the human, as the UI does. They're for humans only, so the plugin's skills don't mention them.
- Human stages can only be passed from the UI. `aop next` is refused on them, including in a steered session.
