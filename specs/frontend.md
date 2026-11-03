# Frontend

Vite and React, served by the AOP server with live updates. Built for desktop browsers, but must look fine in a small window.

## Graph view (main view)
One graph per project, using React Flow with auto-layout. Coloured cards mean a human needs to act, and agent cards are white with a coloured accent. Colours come from `stages.yaml`. Blocked, held and `done` cards grey out with no badge, and `broken_down` and invalidated cards fade further, so it's clear none of them are for picking up. A "Hide invalidated" toggle hides nodes that are invalidated or invalidated by a parent.

## Node page
One column at every screen size, in a few broad card sections with smaller parts inside. It must look fine on a small screen.
1. **Header card:** title, type, current stage, `ticket` and `pr` links (agents attach them, so the UI can't add them) and moving-on buttons. A collapsible pipeline graph of the current type sits inside. On a global stage, its note that global stages live outside the pipeline goes in that dropdown too.
2. **Description card.**
3. **Messages card:** the one message box comes first, then messages newest first. Agent messages have a light blue background, human messages are white, and each shows the stage it was written in. There is never a second box: on `ask_human_question`, the same box takes the answer.
4. **Details card:** always visible, with small separate collapsibles inside for edges, history, claim, invalidate or block, and moving by hand.

`externally_blocked`, `ask_human_question` and `failed` default to returning to the original stage.

## Emphasis
Colour is for what needs attention, and most of the page should be neutral.
The top bar is black, and the logo is the original thin-line version.
- A bold filled colour on a graph card means a human needs to act. Agent cards are white with a clear stage colour accent. No shadows on cards.
- A claim is a small dot with the holder or run ID next to it, not a sentence. The dot is green on graph cards.
- `invalidated` and `broken_down` cards are clearly faded back. Cards for work in progress or waiting on a human have a clearly visible border.
- Each node page has one primary button. Other actions are neutral.
- Avoid badges and pills unless they are really needed, and keep any that remain neutral.
- No animations, including zooming in when a project opens.
- The graph header stays quiet: no node count, and a low-emphasis "New node" button.

## Process page
View-only drawing of each type's graph from `stages.yaml`, with a note that global stages live outside it. The file is the only place to edit the process.

## Not included
A legend, phone-specific features, a "needs me" list, a canvas and progress on `broken_down` nodes.

## Projects page
A list of projects with a low-emphasis "Add project". Adding needs only a name; the path is optional.

## Project settings
Each project has a settings page for its name, optional path and delete, instead of buttons on the list. Delete is permanent, requires typing the project's name, stops its agents first, and never touches the repo.

## AOP settings
A read-only view of `config.yaml`, with a note to edit `~/.aop/config.yaml` to change it. Agents can reach the API, so nothing in the UI can change commands or the sandbox.
