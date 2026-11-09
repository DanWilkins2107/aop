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
- Agents act on AOP only through its MCP server (port 4319). Its tools are the agent's side of a stage and nothing more: read a node, search, post messages, add links, create and edit nodes, add and remove blocks, split, move their stage on (`next`, `ask`, `fail`), and propose, list, withdraw and apply improvements.
- The `aop` CLI and the web app (port 4317) are for you. They can do things agents can't, such as force a stage, claim or release a node, or stop a run.
- Each tool names the node it acts on, and writes also name the agent's run. AOP refuses writes from a run that has ended, so anything left over from it can't act on the board. A session you open with `aop steer` acts under your claim on that node instead.
- An agent can still post on or edit other nodes, and every change is recorded as the agent's in the node's history.
- When a run ends or is stopped, AOP tries to kill the agent's processes as well.

## Sandboxing
- AOP provides the necessary configuration to allow you to have sandboxed sessions, but does not enforce this. 
- In a sandbox, allow agents to reach `127.0.0.1:4319` and not `4317` (the API and web app). That keeps them to the MCP tools.
- It's recommended to use sandboxing so that AOP agents cannot get around your process, but also cannot edit percieved history.
- As everything is stored locally, access to AOP config would allow your agents to create their own process. Again this arguably isn't much more of a risk compared to an existing setup where an agent can spawn infinite subagents, but it's worth considering. 
