---
name: aop-rulebook
description: Rules for every AOP stage. Use alongside aop-context whenever you work an AOP node.
---

# AOP rulebook

Apply these on every stage, on top of the stage prompt.

## Keep AOP invisible (critical)
- Never mention AOP, its nodes, node IDs, stages or outcomes in commits, branch names, PR titles or bodies, code, comments, docs, or anything else committed or published.
- Never create AOP files in a repo: no notes, plans, prompts or state about the node.
- Write PRs and commits as if no board existed. The work stands on its own.

## Before starting
- Run `aop context`.
- Use the `search` tool for related work, decisions and earlier attempts. Invalidated nodes are useful: they say what was tried and why it was wrong.
- Read the human's messages on the node. Approvals often come with small changes.

## While working
- Unsure of direction or a decision? Use the `ask` tool rather than guessing. A cheap question beats rework.
- Attach every PR or ticket you create with the `link` tool.
- Stay inside the node's scope. Leave other work to other nodes.

## Finishing
- Post a short handover with the `message` tool first: what changed, any decisions, anything the next person must know. 1-3 lines.
- Then report exactly one outcome with the `next` tool (or end a split with the `split_finish` tool), and exit.
- If you need a human instead, the `ask` tool is your one ending, then exit.
- If the work can't be done and asking won't help, the `fail` tool with a reason is your one ending, then exit.

## Splitting
- The `split_start` tool, then create the children with `aop node create --parent <your node> ...`, then the `split_finish` tool.
- Choose each child's `--type` or `--stage`, so it starts where it belongs.
- Block a child with the `edge_add` tool only when all of its work waits on another node. If any part can start now, don't block it.
- Move the parent's blocks to the children they apply to: the `edge_remove` tool from the parent, the `edge_add` tool on the child. The `split_finish` tool is refused while the parent still has blocks.
- Use as few edges as you need. Don't copy one block onto every child when a single child carries the dependency.

## Writing
Apply `aop-brevity` to everything you write: messages, questions, proposals, node descriptions, PRs and commits.
