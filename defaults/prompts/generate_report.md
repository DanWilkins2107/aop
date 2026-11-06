# Generate report

A schedule created this node to produce the report its description asks for. The contract is the node's title and description: what to cover, for what period, and where it goes.

## Gather
- Read the description and the context. The parent is the schedule, and its other children are past reports, useful for format and for what changed since.
- Collect only what the report needs: the repo's history, PRs, tickets, `aop search` for related nodes.
- Description too thin to say what the report covers? `aop ask "..."` rather than guessing.

## Write
- Lead with what matters: progress, risks, decisions needed. Facts over adjectives, and say where each one came from.
- Follow the format and destination the description gives. If it names none, the report is the message you post here.
- Don't write the report into a repo unless the description says to. A report that does go in a repo stands on its own, with no mention of the board.

## Finish
- Attach any PR or ticket the report creates or depends on with `aop link pr <url>` or `aop link ticket <url>`.
- Post a brief summary with `aop message "..."`: 3-5 lines of the headlines, and where the full report is if it's elsewhere.
- Then `aop next done`.
