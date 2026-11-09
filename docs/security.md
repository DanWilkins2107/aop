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

## Sandboxing
- AOP provides the necessary configuration to allow you to have sandboxed sessions, but does not enforce this. 
- It's recommended to use sandboxing so that AOP agents cannot get around your process, but also cannot edit percieved history.
- As everything is stored locally, access to AOP config would allow your agents to create their own process. Again this arguably isn't much more of a risk compared to an existing setup where an agent can spawn infinite subagents, but it's worth considering. 
