# CLI

`aop` talks to the server over HTTP. The plugin teaches agents to use it.

## Agents
AOP sets `AOP_NODE_ID` when it launches an agent, so commands act on that agent's node without an ID.

```
aop context [<id>]          # where the node sits in the tree, its description, messages, links and outcomes
aop next <outcome>
aop ask "..."
aop message "..." [--node <id>]
aop link pr|ticket <url>
aop search <query>
aop node create --title ... [--body ...] [--parent ...] [--type ... | --stage ...]
aop node edit [<id>] [--title ...] [--body ...]
aop edge add blocks <from> <to>
aop edge remove blocks <from> <to>
aop split start
aop split finish
```

- An agent can only move its own node. `next`, `ask` and the split commands take no ID.
- Reading other nodes, messaging them, and editing titles and bodies are allowed. Agents are trusted to behave on the board, and every edit is recorded in `events`.
- During `split_approved`, the agent chooses each child's type or stage with `aop node create`.

## Humans
```
aop init                        # one-time machine setup: commands, sandbox, plugin, ~/.aop
aop project add <path>
aop serve
aop steer <node>                # runs sandboxed_command
aop steer <node> --no-sandbox   # runs non_sandboxed_command
```

- `aop steer` opens your own session on a node, in the project's path or `open_from`, with `AOP_NODE_ID` set so the commands above work. It claims the node for you, and errors if an agent run holds it. See claims in [orchestrator.md](orchestrator.md).
- Human stages can only be passed from the UI. `aop next` is refused on them, including in a steered session.
