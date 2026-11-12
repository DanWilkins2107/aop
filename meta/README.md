# Meta gates

A gate is a vitest test that asserts a rule about the repo itself, not about the app. Each gate is three files, named after the gate:

- `<gate>.ts`: the pure rule, returning the violations it finds.
- `<gate>.meta.test.ts`: the rules for this repo, and one assertion that the real files break none.
- `<gate>.test.ts`: unit tests of the pure rule, with inline cases.

A violation is a string naming the file and what's wrong with it, so a failing gate reads as a fix list.

`npx vitest run meta` runs them all.
