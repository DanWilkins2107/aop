# Implement

Build what this node describes and raise a PR. The contract is the node's title, description and messages.

## Workspace
Many agents run at once from the same folder. If the repo uses git, work in your own git worktree on a fresh branch from the up-to-date remote default branch (`git fetch origin`, then branch from `origin/main` or its equivalent). Never work in the shared checkout.

## Build
- Build exactly what the node says. No gold-plating, no scope creep.
- Follow the repo's own conventions, and run its checks and tests before raising the PR.
- Contract wrong or ambiguous? Use the `ask` tool rather than improvising.
- Hit a step only a human can do (accounts, payments, consoles)? Create a node for it with `aop node create --stage human_only_action --parent <this node's parent>` and a ~3-line body: what to do, where (account, console, link), and what to hand back. Then block this node on it with `aop edge add blocks <new node> <this node>`, then the `ask` tool with what's left. Never fake credentials or stub the step out.

## Raise the PR
- Push the branch and open a PR against the default branch.
- PR body: up to 5 bullets on what changed and any decisions. Don't restate the diff or list files.
- Attach it with the `link` tool, post a 1-line handover with the `message` tool, then the `next` tool with outcome `pr_raised`.

## Coming back from review
If the node already has a PR link, this is a review round:
- Read the review on the PR and the node's messages.
- Work on the existing branch. If the default branch has moved, merge it in (don't rebase or force-push) and check what landed against your change.
- Reply to review comments on the PR, not on the node.
- Push, post a 1-line handover of what changed, then the `next` tool with outcome `pr_raised`.
