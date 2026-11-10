# Security
- AOP is a tool that aims to help you with spawning agents concurrently and manage context switching.
- On its own, it doesn't provide additional security, but does integrate with sandboxing. 
- This document sets out what AOP's security posture is.

## Agents Spawning Other Agents
- AOP allows agents to spawn other agents. 
- In theory, a poisoned or otherwise sufficiently motivated agent would have the capability to spawn infinite other agents. 
- This is no greater a threat than an agent being able to spawn infinite subagents which other harnesses themselves would allow. 
- AOP provides a "kill switch" in its ability to shut off the running process.

## Permissioning
- It's strongly recommended that you are using some form of LLM-as-judge mode when working with AOP for both security and practical reasons.
- Sessions automatically terminate if you do not have this - if an agent needs a command approval then they will have their headless session end.  
- However it's worth mentioning that you can use the `aop steer` command if you have specific sessions you want to maintain human control over. 

## Sandboxing
- AOP provides the necessary configuration to allow you to have sandboxed sessions, but does not enforce this. 
- In a sandbox, allow agents to reach `127.0.0.1:4319` and not `127.0.0.1:4317` (the API and web app). That limits them to the MCP tools.
- It's recommended to use sandboxing so that AOP agents cannot get around your process, but also cannot edit perceived history.
- As everything is stored locally, access to AOP config would allow your agents to create their own process. Again this arguably isn't much more of a risk compared to an existing setup where an agent can spawn infinite subagents, but it's worth considering.
- See more detail below.

### Sandbox checklist
- Your `agent_session_command` should start the session in a sandbox that does all of these.
- Network:
  - [ ] Allows `127.0.0.1:4319`, AOP's MCP server.
  - [ ] Blocks `127.0.0.1:4317`, the API and web app. Through it an agent could force stages, claim nodes or stop runs.
- Files:
  - [ ] No write access to `~/.aop` (or your `AOP_HOME`). It holds your config, process, prompts and the database, which is the node history. Agents never need to write there: AOP writes improvements itself when they're applied.
  - [ ] No read access to the database, `~/.aop/aop.db`, or the run logs, `~/.aop/logs/` (one file per run). Between them they hold every node, message and run, including other runs' IDs. With `AOP_HOME` set, both are in that folder instead.
  - [ ] If you use improvements, read access to your improvements folder (`improvements_path` in your config). Improvement agents start in the improvements folder and read the files they propose changes to.
  - [ ] Write access to the project folders and worktrees the agents work in.
- Session:
  - [ ] Passes `AOP_RUN_ID` env var through the environment.
  - [ ] Runs headless with no approval prompts (Claude auto mode or an equivalent). A session that stops for approval ends, and its node fails.
- If you need a session outside the sandbox (when you have sandboxing config set up), set `out_of_sandbox_command` and use `aop steer <node> --no-sandbox`. This will allow you to control a session.
