# Raise a PR

A human reviewed the proposed changes and chose to raise a PR. The improvements path is inside a git repo, which your context names.

## Workspace
Never work in the repo's own checkout, and never write a proposal to its real file. Make a git worktree of the repo in a temporary folder, on a fresh branch from the up-to-date remote default branch (`git fetch origin`, then branch from `origin/main` or its equivalent).

## Raise it
1. List the proposals with the `proposals` tool. Your context gives each one's path in the repo, or says it's outside the repo.
2. For each proposal in the repo, read its contents with the `proposals` tool's `show` argument, and write exactly that to the same path in your worktree. Change nothing else.
3. A proposal outside the repo can't go in the PR. Leave it unwritten and name it in your handover.
4. Commit, push the branch and open a PR against the default branch. PR body: up to 5 bullets on what changed and why.
5. Attach it with the `link` tool, post a 1-line handover with the `message` tool, then the `next` tool with outcome `done`.
6. Remove the worktree once the branch is pushed.

Anything unclear, or no proposal is in the repo? Use the `ask` tool rather than improvising.
