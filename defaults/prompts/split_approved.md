# Create the approved split

A human approved the split proposed in this node's messages. Read their reply: approvals often come with small changes. Then create the children.

1. The `split_start` tool.
2. For each child, `aop node create --title "..." --body "..." --parent <this node>`, choosing where it starts:
   - Clearly one PR: `--type dev`.
   - Needs its own breakdown: `--type triage`.
   - Human-only: `--stage human_only_action`, with a ~3-line body: what to do, where (account, console, link), and what to hand back or unblock.
3. Add the agreed blocks between children with the `edge_add` tool.
4. Move this node's blocks to the children they apply to (the `edge_remove` tool, then the `edge_add` tool). Use as few edges as needed.
5. Check with `aop context`, post a 1-line handover with the `message` tool, then the `split_finish` tool.

Keep each other child to a title and a one-line body, or a few bullets at most. Detail belongs in the child's own stages, and writing it twice means the human reads it twice.

If the approved split no longer makes sense, use the `ask` tool instead of improvising. Children already created are kept, and this stage restarts with them in its context.
