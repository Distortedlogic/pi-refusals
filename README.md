# pi-refusals

A Pi extension that refuses selected agent actions before their tools run.

Current rules:

- The `write` tool can create a file, but it cannot replace an existing path.
- The `bash` tool cannot run commands that use `sed`, `awk`, `rg`, or `grep`.
- The `grep` tool is blocked.
- Prelude imports in complete `.rs` writes and edit results must use `::prelude::*`.

## Install

```sh
pi install git:github.com/Distortedlogic/pi-refusals
```
