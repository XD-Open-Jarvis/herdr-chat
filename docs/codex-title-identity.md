# Codex terminal-title identity

New Codex sessions created by this layout receive a **per-launch** override:

```sh
codex -c 'tui.terminal_title=["app-name","thread-title","project-name","thread-id"]'
```

The layout does not edit global Codex configuration, install shell wrappers,
change hooks, or restart existing sessions. Manually launched/pre-existing
terminals without this override keep the screen-matching and `/status` fallback.

## What was verified

Controlled Herdr terminals running Codex 0.167.1 with the default shared daemon:

- A named thread's final `thread-id` title component is **truncated**, not a full
  UUID: 29 characters followed by `...`. The initial `thread-title` component
  may itself be a complete UUID before the conversation is named; do not
  confuse that fallback with the identity component.
- In-place `/fork` changes that component with the same PID, even before any
  new message is sent. It resolves to the child log, including bounded inherited
  history. `/resume` restores the parent component and log.
- Two terminals in the same directory remain distinguishable. A terminal
  launched with `resume <parent>` and then forked still reports the child in its
  title, while its startup arguments continue to reference the parent.
- `/new` can expose a new identity before a rollout file exists. Chat displays
  an empty conversation and permits the first message while awaiting that log;
  it does not continue displaying the previous session.
- Exiting the controlled TUI cleared its title. The parser also rejects
  finished terminals, shells and terminals without a live Codex report.

These observations do not establish behavior for every Codex version, terminal
multiplexer, external title writer, or remote installation. Remote address
routing is preserved and covered by identity tests; the new title path has not
been exercised on a second physical machine.

## Binding rules

Accept only the final component of an explicitly configured foreground Codex
TUI's title, with a live Codex report. Resolve a complete ID or its sufficiently
long canonical prefix against session metadata on **that terminal's machine**.
Require exactly one matching log, including metadata validation. A collision or
unavailable new log must not fall back to an old text/cwd match. Never fabricate
missing UUID digits or choose a matching file by modification time.

When the title changes, immediately hide a mismatched old transcript and reject
sending from that old view while identification runs. Async results are checked
against both process identity and the current title. The raw transport suffix is
removed only from the Chat/TUI presentation header, not from core terminal data.

Without a recognizable configured title, use the existing conservative fallback.
Titles are not an authenticated channel and other programs can overwrite OSC
0/2; this is not a claim of universal or zero-configuration identity discovery.
A dedicated TUI-originated session field in the status protocol remains a
possible upstream improvement.
