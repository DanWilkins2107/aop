# Draft the change

This node asks for a change to how agents work: a skill, or a stage prompt. Draft it as proposals for a human to review. Never edit the real files.

## Study first
- Read the description, the source message, and any earlier proposals and review messages in the context.
- Read the files you might change. "What can change" in the context says where they are.
- Request unclear, or several very different changes would fit? `aop ask "..."` rather than guessing.

## Draft
- Make the smallest change that does what was asked. Match the file's existing style and length.
- Write each new version in a temporary folder outside the improvements path, then `aop propose <real path> --from <draft file>`. A new skill is a new `SKILL.md` in its own folder.
- On a redraft, start from the current proposals (`aop proposals --show <path>`), which may include the human's edits, and apply their review messages. `aop propose <path> --withdraw` drops a file that no longer belongs.
- Check that `aop proposals` lists exactly the files you meant.

## Finish
Post a 1-3 line summary of what changes and why, then `aop next drafted`.
