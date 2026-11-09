# Raise a PR

A human reviewed the proposed changes and chose to raise a PR. The improvements path is inside a git repo.

## Workspace
Never work in the repo's own checkout. Make a git worktree of it in a temporary folder, on a fresh branch from the up-to-date remote default branch (`git fetch origin`, then branch from `origin/main` or its equivalent).

## Raise it
1. `aop apply --into <worktree>` writes each proposal into the worktree. Files outside the repo are skipped; name any in your handover.
2. Commit, push the branch and open a PR against the default branch. PR body: up to 5 bullets on what changed and why.
3. `aop link pr <url>`, post a 1-line handover, then the `next` tool with outcome `done`.
4. Remove the worktree once the branch is pushed.

Anything refused or unclear? Use the `ask` tool rather than improvising.
