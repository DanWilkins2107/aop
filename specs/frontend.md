# Frontend

Vite and React, served by the AOP server with live updates. Built for desktop browsers, but must look fine in a small window.

## Graph view (main view)
One graph per project, using React Flow with auto-layout. Unconnected nodes extend in one horizontal row, and depth only comes from edges. The first view starts at the top, zoomed between 50% and 100%; the fit button shows everything. Coloured cards mean a human needs to act, and agent cards are white with a coloured accent. Colours come from `stages.yaml`. Blocked, held and `done` cards grey out with no badge, and `broken_down` and invalidated cards fade further, so it's clear none of them are for picking up. A "Hide invalidated" toggle hides nodes that are invalidated or invalidated by a parent. Only first paint and the fit button change the zoom. Nodes stay in the same place: hiding them, or changing their stage, never moves other nodes, and new unconnected nodes appear at the right end.

## Node page
One column at every screen size, in a few broad card sections with smaller parts inside. It must look fine on a small screen.
1. **Header card:** a band in the current stage's colour showing the stage name and, only when the node is claimed, a green dot with the holder or run ID. Then the title with a quiet "Copy ID" beside it, for `aop steer` and the other node commands, Ticket and PR links (agents attach them, so the UI can't add them) and moving-on buttons. A collapsible, colourless pipeline graph of the current type sits inside, with the current stage in a heavier outline. Beside it, also collapsed: force stage, invalidate or block, and claim (open by default). On a global stage, its note that global stages live outside the pipeline goes in that dropdown too.
2. **Description card.**
3. **Messages card:** the send box first, then an inner card for each continuous visit to a stage, newest first, titled with that stage. Going back and forth between stages makes separate inner cards. Messages inside are newest first; agent messages have a light blue background and human messages are white. There is never a second box: on `ask_human_question`, the same box takes the answer.
4. **Details card:** at the bottom. Small collapsibles for edges and history, then a runs table: each agent run's stage, start, duration, how it ended and context consumed. The latest run shows the last 20 lines of its headless session log, updating live while it runs.

`externally_blocked`, `ask_human_question` and `failed` default to returning to the original stage.

## Emphasis
Colour is for what needs attention, and most of the page should be neutral.
The top bar is black, and the logo is the original thin-line version.
- A bold filled colour on a graph card means a human needs to act. Agent cards are white with a clear stage colour accent. No shadows on cards.
- A claim is a small dot with the holder or run ID next to it, not a sentence. The dot is green on graph cards.
- `invalidated` and `broken_down` cards are clearly faded back. Cards for work in progress or waiting on a human have a clearly visible border.
- All stage-move options look the same, with none encouraged over another. The UI should not nudge work down the pipeline.
- Avoid badges and pills unless they are really needed, and keep any that remain neutral.
- No animations, including zooming in when a project opens.
- The graph header stays quiet: no node count, and a low-emphasis "New node" button.

## Process page
View-only drawing of each type's graph from `stages.yaml`, with a note that global stages live outside it. The file is the only place to edit the process.

## Not included
A legend, phone-specific features, a "needs me" list, a canvas and progress on `broken_down` nodes.

## Roadmap page
Shows `docs/roadmap.md`, bundled at build time, from a quiet link in the top bar. The human edits the file, and a rebuild updates the page.

## Projects page
Two tabs at the top, Projects and Improvements. Projects is a list of projects with a low-emphasis "Add project". Adding needs only a name; the path is optional. The Improvements tab, and the + beside each message, are in [improvements.md](improvements.md).

## Project settings
Each project has a settings page for its name, optional path and delete. Delete is permanent, requires typing the project's name, stops its agents first, and never touches the repo.

## AOP settings
A read-only view of `config.yaml`, with a note to edit `~/.aop/config.yaml` to change it. Agents can reach the API, so nothing in the UI can change commands. Each setting has a line of description under it:
- **Agent session command:** This is the session your agents are starting in. Strongly consider having this command start sessions inside a sandbox.
- **Out of sandbox command:** Sometimes you may need to run and supervise a session that runs outside of a sandbox (using `aop steer --no-sandbox`). Not needed if you're not running sessions sandboxed.
- **Open from:** Where sessions start for projects with no path.
- **Agent timeout:** How long an agent can run before it's stopped and its node goes to `failed`.
- **Stages:** The file that defines your process.
- **Improvement stages:** The pipeline that drafts, reviews and applies improvements to your skills and stage prompts.
- **Improvements path:** The folder improvements may change, along with your stage prompts. Raise PR needs it inside a git repo.