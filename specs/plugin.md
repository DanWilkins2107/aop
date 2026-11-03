# Plugin

AOP relies on its plugin for how agents behave. Stage prompts say what to do at a stage, and the plugin says how to behave at every stage.

## Skills
Plain `SKILL.md` files in `plugin/skills/`, shared across agent tools.
- `aop-context`: what AOP, nodes, stages and types are, and how to use the `aop` CLI.
- `aop-rulebook`: rules for every stage. Report exactly one outcome, use `aop ask` rather than guessing, attach PR and ticket links, run `aop search` before starting.
- `aop-brevity`: a general writing style that keeps agent output short. The rulebook applies it on every stage.

## Agent tools
Claude Code and GitHub Copilot are supported first. Each tool gets a thin manifest beside the shared skills and its own install step, as superpowers does.

## Without the plugin
The server still enforces the process: an agent can't take an outcome that isn't in `next`. Only the agent's behaviour rules are lost, so `aop init` should check the plugin is installed.

## Extra rules
A project's own rules go in its stage prompts. AOP has no separate rules feature.

## Sources
Adapted and cut down from the AgentJira plugin skills. The default `assess` prompt holds the whole routing rule: one PR goes to `dev`, bigger work is split, and work an agent can't do goes to `human_only_action`. Defaults only need to be reasonable.
