<!-- The human edits this file by hand; the web app's Roadmap page shows it after a rebuild. -->
# Roadmap
- These are changes I'm planning on making at some point - not a detailed order!

## Next
- Sub-workflows + parallelisation within a node. Fan-out of agents is necessary sometimes, currently AOP doesn't allow for it due to the "one node = one bit of work" rule (which is something that will be kept). Sub-workflows will be the paradigm that allows for this to be smoother. I've implemented this on project recently and as a result will add it in here soon.
- Some sort of versioning system
- Some sort of support for extensions. AOP should remain minimal by default, but others should be able to build on top of it. 
- Further per-project config
- Better support + other harnesses (e.g. Copilot, Codex). There's no reason why these won't work, I've just not tested these yet! (Same thing for any non-windows tooling)
- Better default setups for a given harness (e.g. Claude Code)
- Permission requesting mid-run for cases where that's wanted

## Contributing
- If you'd like to contribute to AOP, please let Dan know first instead of just raising a PR. I'm not concerned about the difficulty to build it, more whether it's the right thing to add on (as mentioned above I'm going to look at adding extensions so that this becomes less of an issue).
- AOP has a lot of room to grow, but it should also remain minimal enough as a default for it to be easy to pick up!