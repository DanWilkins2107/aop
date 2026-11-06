# Improvements

Improvements change how agents work: your skills and your stage prompts. A human captures one from any message, an agent drafts the change, a human reviews the diff, and only then does an agent save it locally or raise a PR.

## Capture
- A quiet **+** next to every message opens a text box with Confirm. After confirming, "Go to improvement" and "Close" are offered equally. Close leaves you on the node.
- The Improvements tab has a quiet "New improvement" for one with no source.
- The text becomes the body, and its first line, cut to 80 characters, the title.
- An agent starts at once: the improvement enters the start of the improvement pipeline like any new node.

## Storage
- Improvements are nodes with `kind = 'improvement'`, so stages, messages, claims, runs and history work as they do anywhere else. They belong to the machine, not a project: they sit in a reserved project, `improvements`, that the projects list and project routes never show. Edges can't join them to project nodes.
- An `improvements` row links each one to its source message and node. It keeps a copy of the message text and the node's title, so the link still reads after the source project is deleted, which clears the IDs.
- `proposals` holds the proposed contents of each file, one row per improvement and path. Real files are untouched until the change is applied.
- Each proposal also records its base: a hash of the real file when it was last saved, `absent` if there was no file, or `unknown` for proposals saved before bases were recorded.

## Pipeline
`config.yaml` links to it the same way it links to `stages.yaml`:

```yaml
improvement_stages: ./improvement_stages.yaml   # without it, improvements are off
improvements_path: ./skills                      # the default, which is ~/.aop/skills
```

```yaml
start: improvement
stages:
  draft_change:  { turn: agent, prompt: ./prompts/draft_change.md }
  review_change: { turn: human }
  raise_pr:      { turn: agent, prompt: ./prompts/raise_pr.md }
  save_locally:  { turn: agent, prompt: ./prompts/save_locally.md }
types:
  improvement:
    start: draft_change
    stages:
      draft_change:  { next: { drafted: review_change } }
      review_change: { next: { raise_pr: raise_pr, save_locally: save_locally, redraft: draft_change } }
      raise_pr:      { next: { done: done } }
      save_locally:  { next: { done: done } }
```

- Same format and validation as [stages.md](stages.md). Problems name `improvement_stages.yaml`.
- Two stage names mean something here. `save_locally` is the only stage where `aop apply` writes real files, and `raise_pr` the only one where `aop apply --into` does.
- An outcome that leads to `raise_pr` is hidden, and refused, unless `improvements_path` is inside a git repo.

## What can change
- Files inside `improvements_path`, and the prompt files of agent stages in `stages.yaml` and `improvement_stages.yaml`.
- Never `config.yaml`, `stages.yaml`, `improvement_stages.yaml`, the database or the logs, even when they sit inside `improvements_path`. `improvements_path` can't be AOP_HOME or hold it.
- The server checks every path on each proposal and apply, after resolving symlinks.
- Agents on an improvement start in `improvements_path`, never in a project's path.

## Proposing
```
aop propose <path> [--from <file>]   # stores the proposed contents, read from the file or stdin
aop propose <path> --withdraw
aop proposals [--show <path>]
```
- A relative path starts from where the command runs. The draft file should live outside `improvements_path`, so drafting changes nothing real.
- Agents propose only on agent stages. Humans edit on the node page. Nothing can change once the improvement is `done` or `invalidated`.

## Applying
- `aop apply` at `save_locally` writes every proposal to its real path, creating folders, and records an event listing them.
- `aop apply --into <checkout>` at `raise_pr` writes each proposal to the same place relative to the repo's root inside another checkout of it, such as a git worktree. The repo's own checkout is refused, and files outside the repo are skipped and listed. The agent then commits, pushes, opens the PR and links it.
- A proposal is stale when its real file no longer matches its base, such as after a hand edit or another improvement applied first. If any is stale, apply writes nothing and refuses with 409, naming the stale files. An `unknown` base is never stale. With `--into`, the base is checked against the real file.
- Each file is written beside its target first, then moved into place. If one can't be written, no real file changes. In a checkout given to `--into`, a path that a link leads out of it is refused.

## UI
- **Improvements tab:** beside Projects, at the same level. A plain list, newest first, of each title, stage and source, with a quiet "New improvement". No graph.
- **Node page:** the normal node page, with "Improvements" in the breadcrumb and "From: <message>" under the title, linking back to the message.
- **Proposed changes card:** after the description. Per file, its path and a line diff against the current file; a new file shows every line added. On human stages each file has a quiet Edit, which opens the proposed side in a text box with Save and Cancel. Every save, by agent or human, re-bases the proposal on the current file.
- A stale file says so in plain text, with no colour or badge: "Changed since drafted" by its stats, and a line saying nothing can be applied until it's updated, with Redraft, or Edit and save, as the way forward. Its diff is against the file as it is now.
- **AOP settings** shows Improvement stages and Improvements path. The **process page** draws the improvement pipeline under its own heading.
