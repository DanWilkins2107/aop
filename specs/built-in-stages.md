# Built-in stages

Standard statuses with AOP-defined behaviour. They aren't in the pool, and their names are reserved.

| Stage | Who acts | Entered by | Left by |
|---|---|---|---|
| `done` | Nobody | `next` | Invalidating |
| `broken_down` | Nobody | `aop split finish` or `next` | Invalidating |
| `invalidated` | Nobody | Human, from any stage | Human restore |
| `ask_human_question` | Human | `aop ask "..."` from an agent stage | Human answers |
| `failed` | Human | AOP, when an agent dies or exits without finishing | Human retries or moves it |
| `externally_blocked` | Human | Human, from any unfinished stage | Human unblocks |
| `splitting` | Agent | `aop split start` from an agent stage | `aop split finish` |
| `scheduled` | AOP | Listed in a type | Never moves |

Only `done` and `broken_down` can be `next` targets. `scheduled` can be a type's `start`. The rest are entered through their own actions, and the UI offers them at the stages where they apply.

## Behaviour
- **`done`:** finished.
- **`broken_down`:** finished. The work continues in the children, and this node shows no progress from them. Refused if the node has no children.
- **`invalidated`:** requires a reason. Offered at every stage, separately from outcomes. Descendants read as stale.
- **`ask_human_question`:** the question is posted to the node and the agent exits. An answer returns the node to its previous stage, which starts again with the answer in its messages.
- **`failed`:** the node shows a link to the log. Retrying returns it to its previous stage. Nothing retries automatically.
- **`externally_blocked`:** for waiting on something outside AOP. Requires a reason, posted to the node. Human-only, so agents aren't told about it. No agent starts while it's here, and anything it blocks stays blocked. Unblocking returns it to its previous stage.
- **`splitting`:** lets an agent create children and edges without any of them starting early. AOP holds a node while its parent is `splitting`, and `aop split finish` moves the parent to `broken_down`, which releases them together. An `aop ask` or failure during a split keeps the children held, and answering or retrying restarts the agent stage that began the split, with the existing children in its prompt.
- **`scheduled`:** stays here and creates a child node each time it fires. The child carries out the task described on this node, and `next` says where it starts.
  - The cron schedule is set on the node, so nodes of one type can run at different times.
  - The child gets a copy of the description.
  - A run is skipped and logged if the previous child hasn't finished.
