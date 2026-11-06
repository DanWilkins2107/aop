# Orchestrator

The server starts agents. No agent or LLM decides what runs next.

```yaml
# ~/.aop/config.yaml, one config shared by all projects
agent_session_command: sandboxed-claude   # required
out_of_sandbox_command: claude            # optional, only for aop steer --no-sandbox
open_from: ~/code                         # where sessions start for projects with no path
agent_timeout_minutes: 60
stages: ./stages.yaml                     # link to the stages config, which can be anywhere
improvement_stages: ./improvement_stages.yaml   # optional: see improvements.md
improvements_path: ./skills               # what improvements may change, with the stage prompts
```

Launched agents run `agent_session_command`, and AOP adds what it needs to run without a terminal: `-p`, with the prompt on stdin. For Claude Code it also asks for streamed JSON output, so it can record context consumed per run and show a readable log. Other tools show what AOP can read. AOP doesn't ship a sandbox or check that the command is one. AOP adds no permission flags either: the user configures permissions, such as Claude Code's auto mode, in `agent_session_command` or their user-level settings.


## Running a stage
1. A node entering an agent stage is queued.
2. It starts once it's unclaimed, no `blocks` edge holds it and it isn't invalidated by a parent. There is no limit on how many agents run at once.
3. Each stage is a fresh process, started in the project's path, or `open_from` if it has none. Improvements start in `improvements_path`. Its prompt goes in on stdin, built from a short instruction to load the plugin's `aop-context` and `aop-rulebook` skills, the output of `aop context` for the node, and the stage's prompt file. AOP generates that output itself, so an agent always knows where it is in the tree.
4. The agent finishes with `aop next <outcome>`, `aop ask "..."`, `aop fail "<reason>"` or by exiting. Only outcomes in that stage's `next` are accepted.
5. Exiting without either, or running past `agent_timeout_minutes`, moves the node to `failed`. Nothing retries automatically.

## Server lifecycle
- `aop serve` runs in the foreground in a terminal and only uses build files, so it can be closed to update AOP.
- Closing it cleanly stops all agents and puts their nodes back in the queue, and they start again on the next `aop serve`. Only a crash leads to `failed`.

## Claims
- A node has at most one claim, by an agent run or a human. No agent starts on a claimed node.
- An agent run claims its node when it starts and releases it when it ends, unless a human stops it.
- A human claims a node in the UI or with `aop steer`, and either errors if an agent run holds it. Claiming a node you already hold is fine, so a session can be reopened.
- A human claim survives the session ending and any stage change. The human releases it in the UI or with `aop release`. Each side releases only its own claim.

## Tracking agents
- `aop ps` lists every agent process and the node it belongs to. `aop reap` kills any that shouldn't exist: its node was deleted, moved on or is invalidated by a parent, or it has no `running` row.
- The server does the same check on startup and on a timer.
- Before killing, AOP confirms the process is the one it started, so a reused process ID can't kill something unrelated. Kills include child processes.

## Stopping agents
- A human can stop an agent run, in the UI or with `aop stop`, and change a node's stage at any time.
- Stopping a run leaves the node on its stage and hands its claim to the human, so the stage doesn't start again until they release it.
- Invalidating a node stops agents on every descendant, without moving them. Restoring it lets them carry on.
- Any stage change stops the agent running on that node. The one exception is `aop split start`, because that agent carries on working. An agent that reports `aop next`, `aop ask` or `aop fail` is expected to exit, and is stopped if it doesn't.
- A run stopped by a human doesn't count as `failed`.

## Workspaces
AOP has no workspace feature and doesn't require git. Where an agent works is up to the human, through their commands and prompts.

