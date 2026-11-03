# stages.yaml

Defines the whole process in one file. `.aop/config.yaml` points to it.

```yaml
stages:                       # pool of every stage
  assess:         { turn: agent, color: "#5c7cfa", prompt: ./prompts/assess.md }
  split_proposed: { turn: human, color: "#ffc107" }
  split_approved: { turn: agent, color: "#4263eb", prompt: ./prompts/split_approved.md }
  write_spec:  { turn: agent, color: "#22b8cf", prompt: ./prompts/write_spec.md }
  spec_review: { turn: human, color: "#cddc39" }
  implement:   { turn: agent, color: "#12b886", prompt: ./prompts/implement.md }
  pr_review:   { turn: human, color: "#9775fa" }

types:                        # a mini graph for each part of the workflow
  triage:
    start: assess
    stages:
      assess:         { next: { ready: dev, split: split_proposed, reject: invalidated } }
      split_proposed: { next: { approve: split_approved, reject: assess } }
      split_approved: { next: { done: broken_down } }
  dev:
    start: write_spec
    stages:
      write_spec:  { next: { done: spec_review } }
      spec_review: { next: { approve: implement, reject: write_spec } }
      implement:   { next: { pr_raised: pr_review } }
      pr_review:   { next: { merged: done, changes: implement } }
  nightly:
    start: scheduled
    stages:
      scheduled:   { next: { fire: triage } }
```

## Stages
- `turn` is `agent` or `human`.
- `prompt` is required on agent stages and not used on human stages.
- `color` sets how the stage appears in the graph.
- `next` lives on the type, so one stage can be reused in several types.

## `next`
- Each key is an outcome: a button for humans, reported through the CLI by agents.
- Each target is a stage in the same type, another type (entering at its `start`), or a built-in.
- `next` always moves the same node. Types only split a large graph into chunks that are easier to reason about, so a node carries on through them with one history.

## Built-in stages
Reserved names with AOP-defined behaviour. They have no `turn` and aren't in the pool.
- `done`: terminal.
- `broken_down`: terminal. The work continues in the node's children, and this node shows no progress from them. AOP refuses the move if the node has no children.
- `invalidated`: reachable from any stage without a `next` entry. Descendants read as stale.
- `ask_human_question`: human turn, reachable from any agent stage without a `next` entry. The agent runs `aop ask "..."`, the question is posted to the node, and the process exits. Once a human answers, the node returns to the stage it came from and that stage starts again with the answer in its messages.
- `failed`: human turn. AOP moves a node here when its agent exits without reporting an outcome, or when the server restarts and finds the agent dead. The node shows a link to the log. A human can retry, which returns it to the stage it came from, or move it to another stage.
- `scheduled`: a node that stays here and creates a child node each time it fires. The child carries out the task described on this node. `next` says where the child starts.
  - The cron schedule is set on the node, so nodes of one type can run at different times.
  - The child gets a copy of the description.
  - A run is skipped and logged if the previous child hasn't finished.

## Splitting
Splitting is built from normal stages, and the defaults include it. An agent proposes a split, a human approves it, then an agent creates the child nodes through the CLI, choosing a type for each, and moves the parent to `broken_down`.

## Validation
AOP refuses to start if:
- a stage and a type share a name, or either uses a built-in name
- a `next` target or `start` doesn't exist
- a type uses a stage that isn't in the pool
- an agent stage has no `prompt`
