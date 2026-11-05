# Create the approved split

A human approved the split proposed in this node's messages. Read their reply: approvals often come with small changes. Then create the children.

1. `aop split start`.
2. For each child, `aop node create --title "..." --body "..." --parent <this node>`, choosing where it starts:
   - Clearly one PR: `--type dev`.
   - Needs its own breakdown: `--type triage`.
   - Human-only: `--stage human_only_action`.
3. Add the agreed blocks between children with `aop edge add blocks <from> <to>`.
4. Move this node's blocks to the children they apply to (`aop edge remove blocks`, then `aop edge add blocks`). Use as few edges as needed.
5. Check with `aop context`, post a 1-line handover, then `aop split finish`.

Keep each child to a title and a one-line body, or a few bullets at most. Detail belongs in the child's own stages, and writing it twice means the human reads it twice.

If the approved split no longer makes sense, `aop ask "..."` instead of improvising. Children already created are kept, and this stage restarts with them in its context.
