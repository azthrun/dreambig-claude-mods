# claude-mods

Local Claude Code plugin marketplace for personal mods.

| Mod | What it does |
| --- | --- |
| [subagent-monitor](mods/subagent-monitor) | Opens a side panel when subagents spawn. Top: Cost / Tokens / Time tiles. Then Running and (foldable) Finished groups of cards, each with its own pixel-Claude figure and color tone, effort tag, model, steps + last tool, ctx / tokens / time, progress bar and status. Collapse hides task text. `/subagents` reopens it. |

## Install

```bash
claude plugin marketplace add /Users/zchen7/Desktop/GitHub/claude-mods
```

```bash
claude plugin install subagent-monitor@claude-mods
```

New sessions load it. The marketplace is a folder, so the installed plugin is read from `mods/<mod>` directly: edit there, then `/reload-plugins`.

## Develop

```bash
claude plugin validate mods/subagent-monitor
```

```bash
claude plugin test mods/subagent-monitor
```
