# Orchestrator

The server starts agents. No agent or LLM decides what runs next.

```yaml
# .aop/config.yaml
sandboxed_command: sandboxed-claude
non_sandboxed_command: claude
agent_args: -p "{{prompt}}"     # added when AOP launches an agent
# sandbox: false                # launch agents with non_sandboxed_command instead
open_from: .                    # where launched agents and aop steer start, relative to the repo root
stages: ./stages.yaml
max_agents: 3
```

Launched agents run `sandboxed_command` plus `agent_args`. AOP won't launch agents if `sandboxed_command` is missing, unless `sandbox: false` opts out explicitly. AOP doesn't ship a sandbox or check that the command is one.

`.aop/config.local.yaml` overrides any of these for one person. `aop init` gitignores it.

## Running a stage
1. A node entering an agent stage is queued.
2. It starts once it's unclaimed, no `blocks` edge holds it and a `max_agents` slot is free.
3. Each stage is a fresh process, started in `open_from`. Its prompt is built from a short instruction to load the plugin's `aop-context` and `aop-rulebook` skills, the stage's prompt file, the node's description and its messages.
4. The agent finishes with `aop next <outcome>`, `aop ask "..."` or by exiting. Only outcomes in that stage's `next` are accepted.
5. Exiting without either moves the node to `failed`. Nothing retries automatically.

## Claims
- A node has at most one claim, by an agent run or a human. No agent starts on a claimed node.
- An agent run claims its node when it starts and releases it when it ends.
- `aop steer` claims the node for the human, and errors if an agent run holds it. Steering a node you already hold is fine, so a session can be reopened.
- A human claim survives the session ending and any stage change. The human releases it in the UI.

## Stopping agents
- The UI can stop an agent run and change a node's stage at any time.
- Any stage change stops the agent running on that node. The one exception is `aop split start`, because that agent carries on working. An agent that reports `aop next` or `aop ask` is expected to exit, and is stopped if it doesn't.
- A run stopped by a human doesn't count as `failed`.

## Workspaces
AOP has no workspace feature and doesn't require git. Where an agent works is up to the human, through their commands and prompts.

## Trust
AOP asks for approval before running any of these commands in a repo for the first time, and again whenever one changes. Approvals are stored per machine in `aop.db`.
