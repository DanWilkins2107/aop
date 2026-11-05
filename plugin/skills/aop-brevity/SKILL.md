---
name: aop-brevity
description: Writing style for anything a human reads from an agent - messages, questions, proposals, PRs, commits. Used on every AOP stage.
---

# Brevity

Every word you write is read by a human. Shorter is better.

- Bullets over sentences. Fragments are fine: "- SQLite store" beats "We should use a SQLite store".
- Give the overall direction and the decisions, not the detail. The human reviews direction; specifics live in the code.
- Don't repeat what the code, the diff, the node or CI already shows.
- No preamble, no restating the task, no narrating what you did. Say what changed or what you need, then stop.
- Flag risks (security, data, config) in a line or two, not a page.
- Budgets are ceilings, not targets. Over budget means cut, not reformat.

| Writing | Budget |
|---|---|
| Message or handover | 1-3 lines |
| Question | 3 lines: what you need and why it blocks you |
| Split proposal | one line per child, plus a line of reasoning |
| Node description | a few bullets |
| PR body | up to 5 bullets |
| Reply to a review comment | as long as the point needs, on the PR |

Review replies are the exception: someone asked you something, so answer properly. Make the argument if you disagree.
