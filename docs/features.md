# AOP Features
- For installing AOP and creating your first node, see [setup.md](setup.md).
- If you need further information on a specific feature, feel free to ask Dan or point your agent of choice at the repo (also let Dan know in this case that the docs need an update!).

## Projects
- Projects are a way of organising different bits of work done with AOP into logical groups.
- Some config can be set per-project, but also can have fallbacks.

## Graph View
- The main view you'll be in is your per-project graph view.
- This will be where you oversee all the work taking place in that project, and where you see what needs you next.

## Nodes
- Nodes are what appear on your graph page.
- Each node is a bit of work that follows your process.
- Lines join parents to children, and illustrate blockers.
- When you click into a node, you'll then see more information.
- The graph updates live, as does every other page.

### The node page
- When you click into a node, you can see the "node page".
- Some especially notable parts of the page:
  - Force stage: Move the node to any stage. This is helpful if your process doesn't yet account for a specific transition that you realise you need.
  - Invalidate or externally block: See "Built-in Stages".
  - Messages are for how you communicate with agents.

### Manually claiming a node
- Nodes in an agent step are always claimed by agents, however there may be cases where you don't want this.
- There is a "Claim" section on the individual node page that stops it being picked up by an agent.
- If you want closer supervision over a session, you can use `aop steer <nodeid>` to run it yourself, in your own agent session.
- If you use sandboxing but want to run an individual session outside of the sandbox with supervision, use `aop steer <nodeid> --no-sandbox`.
- Make sure you release your claim over the node once done so agents can pick it up in a future stage.

### Node Stages and Types
- Your process is defined in stages.yaml files.
- Stages are the pool of steps. Each has a `turn`, `agent` or `human`, and a `color`. Agent stages have a `prompt` file telling the agent what to do there.
- Types are small graphs of stages, each with a `start` stage. Essentially you can break down an overly complex set of stages into "types".

#### Built-in Stages
- AOP comes with some built in stages that work slightly differently to any that you'll put in your config.
- Their names are reserved, so none of your stages or types can use them.
- The stages:
  - `done` means the node is finished
  - `broken_down` means the node is finished, with the work carrying on in its children.
  - `ask_human_question` is for when the agent needs to ask a question but none of the transitions it can make fits - an escape hatch. Answering returns to the prior stage.
  - `failed` means the agent failed, exited without finishing or timed out.
  - `invalidated` means the work is no longer wanted. This will also invalidate all child nodes.
  - `externally_blocked` means waiting on something that isn't in AOP - e.g. a client decision.
  - `splitting`: holds children while an agent creates them, so none start until the split finishes.
  - `scheduled`: the node creates a new child each time its schedule fires.

#### The default process
- AOP comes with a built-in default process. Feel free to use this as a starting point, or start from scratch.

## Improvements
- Improvements give a semi-automated pipeline to create new skills, rules, etc.
- If you notice your agent go wrong in a session, you can click the + button next to the message to create an improvement.
- You can then go to the "Improvements" page, and here you'll use your improvement pipeline that you create to save that improvement to your config (either your AOP config or for whatever harness that underlies AOP)
- The defaults come with a default config.

## Other pages
- Linked from the top bar:
  - Process: a read-only drawing of each type in `stages.yaml`, and of the improvement pipeline. Edit the file to change it.
  - AOP settings: a read-only view of `~/.aop/config.yaml`, with a line on what each setting does. Edit the file to change it.
  - Roadmap: what's planned for AOP.
