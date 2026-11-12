# Herdr Chat Plus

A personal [Herdr](https://herdr.dev) layout for Claude Code and Codex. Chat and TUI are two views of the same terminal: switch with the **Chat / TUI** control in the conversation header. TUI keeps Herdr’s normal split panes; Chat fills the tab locally without creating another shared pane.

Based on [naruse/herdr-chat](https://github.com/naruse/herdr-chat), with the original MIT license and attribution retained. The current development branch is `customized` in the [XD-Open-Jarvis fork](https://github.com/XD-Open-Jarvis/herdr-chat/tree/customized). A separate Herdr Chat Plus repository has not been published yet.

## Highlights

- Catppuccin Latte and Mocha themes; the layout follows the system light/dark setting.
- Conversation header with space name, terminal address, conversation title, agent status, search, and Chat / TUI switch.
- Formatted replies, tool activity, image previews in a Herdr window, attachments, search, slash commands, and model controls.
- A local follow-up queue. Pending messages survive layout reloads; delivery failures stay visible for manual retry. **Instant** sends a selected item immediately.
- Codex fork history and conservative session binding. New Codex sessions launched from Chat include a terminal-title thread ID. Existing sessions use screen evidence or a visible `/status` panel when needed. See [identity details](docs/codex-title-identity.md).
- Remote terminals resolve through their owning pane and tab, so connection aliases can differ between clients.
- Read-only file sidebar: click a Markdown file link or a changed filename to open Markdown Preview / Source or Diff / File, with per-tab state and remote file reads.
- Bounded file watching and suspended Chat work while TUI or another tab is visible.

## Install

Requires Herdr App with the APIs used by this layout, Python 3, and Claude Code or Codex on the machine running the agent. The current development installation has been checked with Herdr App 0.1.15 on macOS. Other versions and platforms need release validation.

Read `~/.config/herdr-app/AGENTS.md` on the target machine. For a new installation:

```sh
git clone --depth 1 --branch customized https://github.com/XD-Open-Jarvis/herdr-chat.git
cd herdr-chat
python3 scripts/install.py --install
```

For an existing installation, update the checkout and run `python3 scripts/install.py --update`. The installer validates the six mods first, backs up files it replaces under `~/.config/herdr-app/backups/`, merges a nonconflicting New Chat shortcut, and selects the Chat layout. It does not migrate sessions or change core documents. A second Mac must connect to the target machine separately.

To inspect an installation without changing it, run `python3 scripts/install.py --diagnose`. `HERDR_APP_HOME` or `--home` selects another app home.

## How it works

Chat is a local presentation of the original terminal pane. Switching to Chat does not split, zoom, park, or close that pane. Other clients, including mobile, continue to see the terminal. The left sidebar has separate **New Chat** and **New Space** buttons. Images open in an internal Herdr window with zoom, pan, and Escape to close.

The six mods are `chat`, `chat-file`, `chat-preview`, `chat-pane`, `chat-tabs`, and `spaces-chat`. See [RECIPE.md](RECIPE.md) for the layout contract. The package includes `layouts/chat.json`, `layouts/chat.svg`, two theme files, and a keybinding recipe.

## Current limitations

- ChatUI currently supports Claude Code and Codex transcripts. Other agents, including Grok, need a provider adapter.
- An existing Codex session may require opening `/status` in TUI to establish its exact identity. The layout does not guess from the newest log file.
- The queue is local to this Chat client. Automatic delivery requires Herdr to remain running; other clients have separate queues.
- File previews are read-only and refresh on request. Diff shows recorded patch fragments; File shows current disk contents. Source previews are limited to 400,000 characters, and link line numbers are displayed in the path but do not yet move the editor cursor.
- Color alpha values are supported by the layout, but the current Herdr desktop window does not provide true desktop-through transparency.

## Development and attribution

The original Herdr Chat source is by naruse under [MIT](LICENSE). Catppuccin palette values are from [Catppuccin](https://github.com/catppuccin/palette), whose [MIT notice](docs/CATPPUCCIN-LICENSE) is included. The pre-customization README is [archived here](docs/upstream-original.md). For the release work still pending, see [the release checklist](docs/release-checklist.md).
