# What is AOP
AOP is an agent orchestration platform. It provides the building blocks for you to create a deterministic process in which probabalistic agents act, as well as some other nice-to-have features.

## Other Pages
- See [docs/setup.md](docs/setup.md) for the setup process for aop.
- See [docs/contributions.md](docs/contributions.md) if you'd like to contribute to AOP
- See [docs/features.md](docs/features.md) for how AOP works
- See [docs/security.md](docs/security.md) for AOP's security posture.

## Why would you use an orchestration layer
Claude Code + similar tools take a lot of configuration to be fit for multi-agent orchestration across a range of tasks.

An initial problem a lot of people run into is that running lots of different terminal sessions gets messy. You need to run a side investigation? New terminal. You need to add a skill based on something that went wrong? New terminal. Tools such as TMUX bridge this gap to start with, but quickly the job becomes keeping your terminals organised, and managing your context across sessions, instead of what's important: making good development decisions.

## What makes aop different from other orchestration layers
Many orchestration layers are great for spawning lots of agents, in such a way that large tasks can get done quickly. However that does have a downside. More agents often means more work to verify, and more complexity in understanding why a decision has been made. It's also hard to make changes to fix problems. Sometimes your process needs a wider-scale change than "just add a skill", and this is what AOP aims to give you.

Additionally, many of these still require you to focus on context engineering. AOP focuses on taking away context engineering as a problem as much as possible by creating a process that means work is automatically split into small enough problems, and manages handovers between agents atuomatically.

