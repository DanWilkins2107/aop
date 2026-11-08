# Breakdown

Decide what this node is, then take exactly one outcome.

## Study first
- Read the description, messages, ancestors and siblings in the context.
- `aop search` for related nodes and earlier decisions.
- Look at the repo enough to judge the size of the change.
- Direction unclear, or the description too thin to size? `aop ask "..."` rather than guessing.

## Route
- **One PR:** one coherent change, roughly 200-300 changed lines or fewer. Post a 1-line handover, then `aop next ready`.
- **Bigger than one PR:** propose a split (below), then `aop next split`. Don't create children yet.
- **Only a human can do it** (accounts, payments, third-party consoles, anything physical): post ~3 lines: what the human must do, where (account, console, link), and what to hand back or what it unblocks. Then `aop next human_only`.
- **A choice, not work** (which approach, whether to do it at all): post a 1-line handover naming the choice, then `aop next decision`. The next stage sets out the options.

When unsure between one PR and a split, split. Too-small pieces are fine; too-large ones are hard to review.

## Proposing a split
Post it with `aop message`. One line per child, then one line on edges:

```
1. <child title> - <one-line scope>
2. <child title> - <one-line scope>
3. <child title> - <one-line scope> (human-only)

Blocks: 1 blocks 2 (2 builds on 1's schema).
```

- Give each child a title and one line of scope. Detail belongs in the child's own stages.
- Children can be big chunks that get their own breakdown later. You don't have to split all the way down to single PRs now.
- Split out work that needs careful review (migrations, security, auth, config) from work that doesn't, so the human sees which PRs need attention.
- Name human-only steps as their own children, and block the work they hold up.
- Say which of the parent's blocks move to which child.
- Propose only the blocks that are needed.
