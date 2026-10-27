# pi-refusals

A Pi extension that refuses selected agent actions before their tools run.

Current rules:

- The `write` tool can create a file, but it cannot replace an existing path.
- The `bash` tool cannot run commands that use `sed` or `awk`.

## Install

```sh
pi install git:github.com/Distortedlogic/pi-refusals
```
