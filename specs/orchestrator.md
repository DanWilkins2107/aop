# Orchestrator

The server starts agents. No agent or LLM decides what runs next.

```yaml
# .aop/config.yaml
agent_command: claude -p "{{prompt}}"
stages: ./stages.yaml
max_agents: 3
```

`.aop/config.local.yaml` overrides any of these for one person. `aop init` gitignores it.

## Running a stage
1. A node entering an agent stage is queued.
2. It starts once no `blocks` edge holds it and a `max_agents` slot is free.
3. Each stage is a fresh process, started in the repo root. Its prompt is built from the stage's prompt file, the node's description, its messages and how to use the CLI.
4. The agent finishes with `aop next <outcome>`, `aop ask "..."` or by exiting. Only outcomes in that stage's `next` are accepted.
5. Exiting without either moves the node to `failed`. Nothing retries automatically.

## Workspaces
AOP has no workspace feature and doesn't require git. Where an agent works is up to the human, through `agent_command` and their prompts.

## Trust
AOP asks for approval before running `agent_command` in a repo for the first time, and again whenever it changes. Approvals are stored per machine in `aop.db`.
