# AOP plugin

Skills that teach an agent how to behave on any AOP stage. Stage prompts say what to do; these say how.

| Skill | What it covers |
|---|---|
| `aop-context` | What nodes, stages and types are, and every agent-facing `aop` command |
| `aop-rulebook` | Rules for every stage, including keeping AOP out of repos |
| `aop-brevity` | Writing style and length budgets |

The skills are plain `SKILL.md` files in `skills/`, shared by every tool. Each tool gets a thin manifest beside them. Agents also need `aop` on `PATH`.

## Claude Code
```
/plugin marketplace add /path/to/aop/plugin
/plugin install aop@aop
```
Or for one session: `claude --plugin-dir /path/to/aop/plugin`.

## GitHub Copilot CLI
```
copilot plugin install /path/to/aop/plugin
```
Untested: the manifest in `.github/plugin/plugin.json` follows GitHub's plugin reference, but hasn't been tried with `copilot`.

## Changing the rules
Edit the skills here, or put project-specific rules in your stage prompts.
