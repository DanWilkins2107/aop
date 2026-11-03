# Orchestrator

The server starts agents. No agent or LLM decides what runs next.

```yaml
# ~/.aop/config.yaml, one config shared by all projects
sandboxed_command: sandboxed-claude
non_sandboxed_command: claude
agent_args: -p                  # added when AOP launches an agent; the prompt arrives on stdin
# sandbox: false                # launch agents with non_sandboxed_command instead
open_from: ~/code              # default place to open agents and aop steer, for projects with no path
agent_timeout_minutes: 60
stages: ./stages.yaml           # link to the stages config, which can be anywhere
```

Launched agents run `sandboxed_command` plus `agent_args`. AOP won't launch agents if `sandboxed_command` is missing, unless `sandbox: false` opts out explicitly. AOP doesn't ship a sandbox or check that the command is one.


## Running a stage
1. A node entering an agent stage is queued.
2. It starts once it's unclaimed, no `blocks` edge holds it and it isn't invalidated by a parent. There is no limit on how many agents run at once.
3. Each stage is a fresh process, started in `open_from`. Its prompt goes in on stdin, built from a short instruction to load the plugin's `aop-context` and `aop-rulebook` skills, the output of `aop context` for the node, and the stage's prompt file. AOP generates that output itself, so an agent always knows where it is in the tree.
4. The agent finishes with `aop next <outcome>`, `aop ask "..."` or by exiting. Only outcomes in that stage's `next` are accepted.
5. Exiting without either, or running past `agent_timeout_minutes`, moves the node to `failed`. Nothing retries automatically.

## Server lifecycle
- `aop serve` runs in the foreground in a terminal and only uses build files, so it can be closed to update AOP.
- Closing it cleanly stops all agents and puts their nodes back in the queue, and they start again on the next `aop serve`. Only a crash leads to `failed`.

## Claims
- A node has at most one claim, by an agent run or a human. No agent starts on a claimed node.
- An agent run claims its node when it starts and releases it when it ends.
- `aop steer` claims the node for the human, and errors if an agent run holds it. Steering a node you already hold is fine, so a session can be reopened.
- A human claim survives the session ending and any stage change. The human releases it in the UI.

## Tracking agents
- `aop ps` lists every agent process and the node it belongs to. `aop reap` kills any that shouldn't exist: its node was deleted or moved on, or it has no `running` row.
- The server does the same check on startup and on a timer.
- Before killing, AOP confirms the process is the one it started, so a reused process ID can't kill something unrelated. Kills include child processes.

## Stopping agents
- The UI can stop an agent run and change a node's stage at any time.
- Invalidating a node stops agents on every descendant, without moving them. Restoring it lets them carry on.
- Any stage change stops the agent running on that node. The one exception is `aop split start`, because that agent carries on working. An agent that reports `aop next` or `aop ask` is expected to exit, and is stopped if it doesn't.
- A run stopped by a human doesn't count as `failed`.

## Workspaces
AOP has no workspace feature and doesn't require git. Where an agent works is up to the human, through their commands and prompts.

