# AOP Features
For installing AOP and creating your first node, see [setup.md](setup.md).

## Projects
Projects are a way of organising different bits of work done with aop into logical groups.

- A project needs only a name. A repo path is optional: agents start in it, or in `open_from` from your config if there isn't one.
- Add one with **Add project** on the home page, or `aop project add <path>`.
- Each project has a settings page for its name, path and delete. Deleting is permanent, asks you to type the project's name, stops its agents first and never touches the repo.

## Graph View (main view)
The main view you'll be in is your per-project graph view.
This will be where you oversee all the work taking place in that project, and where you see what needs you next.

- **Cards.** Each node is a card. A bold coloured card means a human needs to act. A white card with a coloured accent is an agent's turn. Colours come from your `stages.yaml`.
- **Greyed cards.** Blocked, held and `done` cards are greyed out. `broken_down` and invalidated cards fade further, so it's clear none of them are for picking up.
- **Claims.** A green dot with a name or run ID shows who holds the node.
- **Edges.** Lines join a parent to its children, and a blocker to what it blocks, which is drawn differently.
- **Layout.** AOP lays the graph out for you. Unconnected nodes sit in one row, and depth only comes from edges. Nodes stay put: changing a stage or hiding nodes never moves the others, and new unconnected nodes appear at the right end.
- **Navigating.** Pan and zoom freely. The fit button shows everything. Click a card to open its node page.
- **Hide invalidated** hides invalidated nodes and anything invalidated by a parent.
- **New node** creates a node. It starts in your process's start type unless you pick another type or stage under **Starts in**.

The graph updates live, as does every other page.

## Nodes
A node is one piece of work. It has a title, a description, a type and a stage. As it moves through stages, agents and humans take turns on it, and it keeps one history throughout.

### The node page
- **Header.** The stage in its colour, the title, **Copy ID** (for `aop steer` and the other commands), any ticket and PR links the agent attached, and a button for each outcome of the current stage. The breadcrumb shows the node's ancestors.
- **Pipeline.** A drawing of the node's current type, with its stage outlined.
- **Force stage.** Move the node to any stage, skipping the outcomes. Use it as an escape hatch.
- **Invalidate or externally block.** See below.
- **Claim.** Claim the node, release your claim, or stop a running agent.
- **Description.** Edit it in place.
- **Messages.** The send box, then the messages grouped by each visit to a stage, newest first. Agent messages have a light blue background.
- **Details.** Edges (add or remove blocks and parent/child links), the node's history, and a table of agent runs: stage, start, duration, how it ended and context used. The latest run shows the last 20 lines of its log, live while it runs.

### Claims
A node has at most one claim, by an agent run or by you. No agent starts on a claimed node.

- An agent claims its node while it runs.
- You claim a node from its page or with `aop steer`. Your claim lasts through stage changes until you release it.
- **Stop run** stops the agent and hands the claim to you, so the stage doesn't start again until you release it. A stopped run doesn't count as failed.

### Steering
`aop steer <node>` opens your own agent session on a node, in the project's folder, with the `aop` commands working on that node. It claims the node for you. `--no-sandbox` uses `out_of_sandbox_command` instead. Human stages can still only be passed from the UI.

### Questions and failures
- An agent that needs you runs `aop ask`. The node goes to `ask_human_question`, and the message box takes your answer. Answering sends the node back to its stage, and the agent starts again with your answer.
- If an agent fails, exits without finishing or runs past `agent_timeout_minutes`, the node goes to `failed`. Read the log in Details, then **Retry** to return it to its stage, or move it yourself. Nothing retries automatically.

### Invalidating and blocking
- **Invalidate** when the work is no longer wanted. It needs a reason. Agents on every descendant stop, and they read as "invalidated by parent". **Restore** brings it back.
- **Mark blocked** when the node is waiting on something outside AOP. It needs a reason. No agent starts on it, and anything it blocks stays blocked. **Unblock** returns it to its stage.

### Blocks
A `blocks` edge stops an agent starting on a node until its blocker is finished. An invalidated blocker still blocks, so you decide what happens. Agents add these when they split work, and you can add them in Details.

### Types of Node
Your process is defined in one `stages.yaml`, shared by all projects. You edit the file by hand, and changes apply without a restart. If it becomes invalid, the UI shows the problems and no new agents start until it's fixed.

- **Stages** are the pool of steps. Each has a `turn`, `agent` or `human`, and a `color`. Agent stages have a `prompt` file telling the agent what to do there.
- **Types** are small graphs of stages, each with a `start` stage. A stage's `next` lists its outcomes and where each leads: another stage in the type, another type, `done` or `broken_down`.
- On an agent stage, the agent picks an outcome with `aop next <outcome>`. On a human stage, the outcomes are buttons on the node page.
- A node stays the same node as it moves between types.

#### The default process
- **triage:** an agent reads the new node at `awaiting_agent_breakdown` and routes it. Work that fits one PR goes to `dev`. Bigger work goes to `split_proposed`, where you approve or reject the proposed split. Once approved, the agent creates the children at `split_approved` and the node becomes `broken_down`. Work an agent can't do goes to `human_only_action`, and a choice for you to make goes to `decisions`.
- **dev:** an agent implements the work and raises a PR, then the node waits at `pr_review` and `second_human_review`. Approve moves it on, changes sends it back to the agent, and merged finishes it.
- **decisions:** an agent sets out the choice at `awaiting_agent_summary`, then you decide at `decision`. Clarify sends it back to the agent for more, and retriage sends it back to `triage`.

#### Built-in stages
These have fixed behaviour and reserved names:
- `done` and `broken_down`: finished. `broken_down` means the work carries on in the children.
- `invalidated`, `externally_blocked`, `ask_human_question` and `failed`: described above. They can be reached from any stage and live outside the pipeline.
- `splitting`: an agent creating children holds them here, so none start until the split finishes.
- `scheduled`: below.

#### Scheduled nodes
A scheduled node stays where it is and creates a new child node each time its schedule fires. The child carries out the task described on the scheduled node. The default stages don't include one, so add the built-in `scheduled` stage to a type in your `stages.yaml` to use it.

- A new scheduled node has no schedule and doesn't fire. On its page, pick a time and the days of the week to fire on, and save. Each node has its own, so nodes of one type can run at different times.
- Times are in the server's time zone. The page shows when the node next fires.
- Clear the schedule to stop it firing. A new schedule fires from the next matching time, with no catch-up.
- A firing is skipped if the previous child hasn't finished.
- Blocking it pauses it. Unblocking resumes from the next slot, with no catch-up.

## Improvements
Improvements change how your agents work: your skills and your stage prompts.

1. Click the quiet **+** next to any message, describe what agents should do differently and confirm. Or use **New improvement** on the Improvements tab.
2. An agent drafts the change.
3. You review it on the improvement's page. The **Proposed changes** card shows a diff per file, and you can edit any file yourself.
4. Choose **save_locally** to write the files, **raise_pr** to have an agent open a PR (offered only when `improvements_path` is inside a git repo), or **redraft**.

- Improvements are listed on the Improvements tab beside Projects, and each one links back to the message it came from.
- Only files inside `improvements_path` and your stage prompts can change, never your config or stages files.
- If a real file changed since it was drafted, the card says "Changed since drafted" and nothing is applied until you redraft or edit and save it.
- The pipeline lives in `improvement_stages.yaml`, in the same format as `stages.yaml`. Leave it out of `config.yaml` to turn improvements off.

## Other pages
Linked from the top bar:
- **Process:** a read-only drawing of each type in `stages.yaml`, and of the improvement pipeline. Edit the file to change it.
- **AOP settings:** a read-only view of `~/.aop/config.yaml`, with a line on what each setting does. Edit the file to change it.
- **Roadmap:** what's planned for AOP.

## The CLI
Agents report back through `aop`, and the plugin teaches them how. The main commands are `aop context`, `aop next`, `aop ask`, `aop fail`, `aop message`, `aop link`, `aop search` and `aop node create`.

The ones you'll use yourself:
- `aop serve`: run the server.
- `aop project add <path>`: add a project.
- `aop steer <node>`: open your own session on a node.
- `aop stop <node>` and `aop release <node>`: stop a run or release your claim, as in the UI.
- `aop logs <node>`: the end of the latest run's log.
- `aop ps` and `aop reap`: list agent processes, and kill any that shouldn't exist.

Run `aop --help` for the full list.
