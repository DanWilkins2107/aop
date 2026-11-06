---
name: aop-context
description: What AOP (agent orchestration platform) is and how to drive it with the `aop` CLI. Use whenever a prompt says you're working an AOP node, or AOP_NODE_ID is set.
---

# AOP context

AOP is a board of task **nodes** shared by humans and agents. It launched you on one node, at one **stage**, and you only work that node's current stage.

- **Node:** a piece of work with a title, description, messages, links and edges. Nodes form a tree (parent to children) and can block each other.
- **Stage:** where a node is. Each stage is a human's turn or an agent's turn. Your stage prompt says what to do here.
- **Type:** a small graph of stages, such as `triage` or `dev`. The node carries on through types with one history.
- **Outcome:** how you leave a stage. Only the outcomes listed under "Moving on" in `aop context` are accepted.

## Start here
Run `aop context` first. It shows the node's ancestors, children, siblings, blocks, description, messages, links and outcomes. Your prompt already includes a copy, but run it again after a split or a long task.

## Commands
Commands act on your own node (`AOP_NODE_ID`) unless they take an ID. You can only move your own node.

| Command | Use |
|---|---|
| `aop context [<id>]` | Read a node. Without an ID, your own |
| `aop search <query> [--all]` | Search this project's nodes, or every project with `--all` |
| `aop message "..." [--node <id>]` | Post a message, on your node or another |
| `aop link pr\|ticket <url>` | Attach a PR or ticket link to your node |
| `aop ask "..."` | Ask a human. The node waits, and this stage restarts with the answer. Then exit |
| `aop fail "<reason>"` | Mark your node failed, only when the work can't be done and asking won't help. Then exit |
| `aop next <outcome>` | Finish the stage with one outcome. Then exit |
| `aop node create --title ... [--body ...] [--parent <id>] [--project ...] [--type ... \| --stage ...]` | Create a node. `--type` starts it at that type's first stage; `--stage` starts it exactly there |
| `aop node edit [<id>] [--title ...] [--body ...]` | Edit a title or description |
| `aop edge add blocks <from> <to>` | `<from>` must finish before `<to>` starts |
| `aop edge remove blocks <from> <to>` | Remove that block |
| `aop split start` | Begin a split. Children you create are held until it finishes |
| `aop split finish` | End the split. Your node becomes `broken_down` and the children start |

### Improvements
An **improvement** is a node that changes how agents work: a skill or a stage prompt. It belongs to no project. You start in the improvements folder, and you never edit real files: you propose their new contents, a human reviews the diff, and a later stage applies it.

| Command | Use |
|---|---|
| `aop propose <path> [--from <file>]` | Store a file's proposed contents, from a draft file or stdin. The real file is unchanged |
| `aop propose <path> --withdraw` | Drop that proposal |
| `aop proposals [--show <path>]` | List the proposals, or print one |
| `aop apply [--into <checkout>]` | Write the proposals: to the real files at `save_locally`, or into a worktree at `raise_pr` |

## Notes
- Your node's ID is on the `Node:` line of `aop context`.
- `aop next`, `aop ask` and `aop fail` end your turn. Stop working once you've run one.
- Exiting without `aop next` or `aop ask` marks the node failed, so always finish with one.
- Every edit is recorded, so act on other nodes only when your stage needs it.
