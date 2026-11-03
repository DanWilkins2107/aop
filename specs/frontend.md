# Frontend

Vite and React, desktop only, served by the AOP server with live updates.

## Graph view (main view)
One graph per project, using React Flow with auto-layout. Bright cards mean a human needs to act. Colours come from `stages.yaml`.

## Node page
- **Pipeline** near the top: drawn from the node's current type, showing where it has been and where it is now.
- Description, messages, history and links.
- Outcome buttons for the current stage, taken from `next`.

## Process page
View-only drawing of each type's graph from `stages.yaml`. The file is the only place to edit the process.

## Not included
Phone support, a "needs me" list, a canvas and progress on `broken_down` nodes.
