# pi-refusals

A Pi extension that refuses selected agent actions before their tools run.

Current rule: the `write` tool can create a file, but it cannot replace an existing path. The refusal tells the agent to use `edit` for an existing file.

## Install

```sh
pi install git:github.com/Distortedlogic/pi-refusals
```
