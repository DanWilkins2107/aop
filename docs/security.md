# Security
AOP is a tool that aims to help you with spawning agents concurrently and manage context switching.

It's not a tool for being more secure, but should be able to work alongisde those. 

This document sets out what is AOP's security posture.

## Agents Spawning Other Agents
- AOP allows agents to spawn other agents. 
- In theory, a poisoned or otherwise sufficiently motivated agent would have the capability to spawn infinite other agents. 
- My (Dan's) personal opinion on this is that this is no greater a threat than an agent being able to spawn infinite subagents which other harnesses themselves would allow. 
- AOP provides a "kill switch" in it's ability to shut off the running process, but generally this isn't a threat model that's considered. 

## Permissioning
- It's strongly recommended that you are using some form of LLM-as-judge mode when working with AOP for both security and practical reasons.
- Sessions automatically terminate if you do not have this - if an agent needs a command approval then they will have their headless session end.  
- However it's worth mentioning that you can use the `aop steer` command if you have specific commands you want to maintain human approval over. 

## What agents can do
- Agents act on AOP only through its MCP server (port 4319). Its tools are the agent's side of a stage and nothing more: read a node, search, post messages, add links, create and edit nodes, add and remove blocks, split, move their stage on (`next`, `ask`, `fail`), and propose, list and withdraw improvements.
- The `aop` CLI and the web app (port 4317) are for you. They can do things agents can't, such as force a stage, claim or release a node, or stop a run.
- Each tool names the node it acts on, and writes also name the agent's run. AOP refuses writes from a run that has ended, so anything left over from it can't act on the board. A session you open with `aop steer` acts under your claim on that node instead.
- An agent can still post on or edit other nodes, and every change is recorded as the agent's in the node's history.
- When a run ends or is stopped, AOP tries to kill the agent's processes as well.

## Sandboxing
- AOP provides the necessary configuration to allow you to have sandboxed sessions, but does not enforce this. 
- In a sandbox, allow agents to reach `127.0.0.1:4319` and not `4317` (the API and web app). That keeps them to the MCP tools.
- It's recommended to use sandboxing so that AOP agents cannot get around your process, but also cannot edit percieved history.
- As everything is stored locally, access to AOP config would allow your agents to create their own process. Again this arguably isn't much more of a risk compared to an existing setup where an agent can spawn infinite subagents, but it's worth considering. 

### Sandbox checklist
Your `agent_session_command` should start the session in a sandbox that does all of these.

Network:
- [ ] Allows `127.0.0.1:4319`, AOP's MCP server.
- [ ] Blocks `127.0.0.1:4317`, the API and web app. Through it an agent could force stages, claim nodes or stop runs.

Files:
- [ ] No write access to `~/.aop` (or your `AOP_HOME`). It holds your config, process, prompts and the database, which is the node history. Agents never need to write there: AOP writes improvements itself when they're applied.
- [ ] No read access to the database, `~/.aop/aop.db`, or the run logs, `~/.aop/logs/` (one file per run). Between them they hold every node, message and run, including other runs' IDs. With `AOP_HOME` set, both are in that folder instead.
- [ ] If you use improvements, read access to your improvements folder and `~/.aop/prompts`. Improvement agents start in the improvements folder and read the files they propose changes to.
- [ ] Write access to the project folders and worktrees the agents work in.

Session:
- [ ] Passes the environment through, in particular `AOP_RUN_ID`. AOP uses it to find and kill everything a run started.
- [ ] Runs headless with no approval prompts (auto mode or an equivalent). A session that stops for approval ends, and its node fails.

If you need a session outside the sandbox, set `out_of_sandbox_command` and use `aop steer <node> --no-sandbox`. That session is yours, not an agent run.
