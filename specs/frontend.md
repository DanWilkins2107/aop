# Frontend

Vite and React, desktop only, served by the AOP server with live updates.

## Graph view (main view)
One graph per project, using React Flow with auto-layout. Coloured cards mean a human needs to act, and agent cards are white with a coloured accent. Colours come from `stages.yaml`. A "Hide invalidated" toggle hides nodes that are invalidated or invalidated by a parent.

## Node page
- **Pipeline** near the top: drawn from the node's current type, showing where it has been and where it is now.
- Description, messages, history and links.
- Outcome buttons for the current stage, taken from `next`. This is the only way past a human stage.
- Who holds the claim, with controls to stop an agent run, release a human claim and change the stage.

## Process page
View-only drawing of each type's graph from `stages.yaml`. The file is the only place to edit the process.

## Not included
A legend, phone support, a "needs me" list, a canvas and progress on `broken_down` nodes.

## Projects page
Add a project by repo path, rename it, change its path, and delete it. Delete is permanent, requires typing the project's name, stops its agents first, and never touches the repo.
