# Frontend

Vite and React, served by the AOP server with live updates. Built for desktop browsers, but must look fine in a small window.

## Graph view (main view)
One graph per project, using React Flow with auto-layout. Coloured cards mean a human needs to act, and agent cards are white with a coloured accent. Colours come from `stages.yaml`. Blocked, held, `done` and `broken_down` cards are all greyed out to the same opacity with no badge, so it's clear they aren't for picking up. A "Hide invalidated" toggle hides nodes that are invalidated or invalidated by a parent.

## Node page
One column at every screen size, with nothing side by side, and it must look fine on a small screen. From top to bottom:
1. **Meta:** title, type, current stage and links. A node on a global stage shows a note that global stages live outside the pipeline.
2. **Links:** shown as plain links named `ticket` and `pr`. Agents attach them, so the UI has no way to add them.
3. **Moving on:** buttons for the current stage. `externally_blocked`, `ask_human_question` and `failed` default to returning to the original stage.
4. **Pipeline:** collapsed. A graph of the stages of the node's current type, with the current stage highlighted.
5. **Description** and **messages:** always open.
6. **Admin:** collapsed, at the bottom. Edges, history, claim controls, invalidate and moving by hand.

## Emphasis
Colour is for what needs attention, and most of the page should be neutral.
- A bold filled colour on a graph card means a human needs to act. Agent cards are white with a clear stage colour accent. No shadows on cards.
- A claim is a small dot with the holder or run ID next to it, not a sentence.
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
