# stages.yaml

Defines the whole process in one file, shared by all projects. `~/.aop/config.yaml` links to it, and it can live anywhere.

```yaml
start: triage                 # the type new nodes start in

stages:                       # pool of every stage
  awaiting_agent_breakdown: { turn: agent, color: "#5c7cfa", prompt: ./prompts/awaiting_agent_breakdown.md }
  split_proposed: { turn: human, color: "#ffc107" }
  split_approved: { turn: agent, color: "#4263eb", prompt: ./prompts/split_approved.md }
  human_only_action: { turn: human, color: "#ff9800" }
  implement:      { turn: agent, color: "#12b886", prompt: ./prompts/implement.md }
  pr_review:      { turn: human, color: "#9775fa" }
  second_human_review: { turn: human, color: "#e91e63" }

types:                        # a mini graph for each part of the workflow
  triage:
    start: awaiting_agent_breakdown
    stages:
      awaiting_agent_breakdown: { next: { ready: dev, split: split_proposed, human_only: human_only_action } }
      human_only_action: { next: { done: done } }
      split_proposed: { next: { approve: split_approved, reject: awaiting_agent_breakdown } }
      split_approved: { next: { done: broken_down } }
  dev:
    start: implement
    stages:
      implement:           { next: { pr_raised: pr_review } }
      pr_review:           { next: { approve: second_human_review, changes: implement } }
      second_human_review: { next: { merged: done, changes: implement } }
```

## New nodes
- New nodes enter the top-level `start` type at that type's `start`.
- A human or agent creating a node can instead choose any type or stage for it. Agents use this to set where each child starts.

## Stages
- `turn` is `agent` or `human`.
- `prompt` is required on agent stages and not used on human stages.
- `color` sets how the stage appears in the graph.
- `next` lives on the type, so one stage can be reused in several types.

## `next`
- Each key is an outcome: a button for humans, reported through the CLI by agents.
- Each target is a stage in the same type, another type (entering at its `start`), `done` or `broken_down`.
- `split_approved` still lists `broken_down` so the pipeline shows where it ends. An agent using `aop split start` reaches it through `aop split finish`.
- `next` always moves the same node. Types only split a large graph into chunks that are easier to reason about, so a node carries on through them with one history.

## Built-in stages
See [built-in-stages.md](built-in-stages.md).

## Validation
AOP won't start if the file is invalid. If it becomes invalid while running, the UI shows the problems and no new agents start until it's fixed. It's invalid if:
- a stage and a type share a name, or either uses a built-in name
- a `next` target or `start` doesn't exist, or the top-level `start` is missing
- `next` targets a built-in other than `done` or `broken_down`
- a type uses a stage that isn't in the pool
- an agent stage has no `prompt`
