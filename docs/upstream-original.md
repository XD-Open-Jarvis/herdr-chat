# Upstream README archive

The following text came from the original Herdr Chat README and documents its earlier split-pane design. The current layout is described in the repository README.

# Upstream Herdr Chat

A chat window for [Herdr](https://herdr.dev) that sits over your Claude Code and Codex agents, with the terminal one click away. It works the way the Claude and ChatGPT apps do:
- a `/` command menu;
- a side chat that doesn't interrupt the agent;
- cards for context, usage, memory, MCP servers and settings;
- pickers drawn in the chat;
- replies that stream as they're written;
- Slack-style `:emoji` autocomplete.

![Herdr with the chat beside its agent's terminal](screenshots/herdr-with-chat.png)

*Herdr with the chat open: the spaces and agents on the left, and the chat beside its agent's terminal.*

| | |
|---|---|
| ![New chat](screenshots/new-chat.png)<br>**New chat** (⌘⇧N, or Ctrl+Shift+N on Linux and Windows): pick the agent, machine, folder, model and effort | ![The / menu](screenshots/command-menu.png)<br>**The `/` menu**: skills, the model and all commands |
| ![Searching commands](screenshots/command-search.png)<br>**Commands** with their descriptions, arguments and aliases | ![Side chat](screenshots/side-chat.png)<br>**Side chat**: ask without interrupting the agent |
| ![A command running](screenshots/live-command.png)<br>**Live progress**: the command running now and its output | ![Context card](screenshots/context-card.png)<br>**Cards** for context, usage, MCP servers, memory |
| ![A terminal picker in the chat](screenshots/terminal-picker.png)<br>**Terminal pickers** as buttons, right in the chat | ![Model picker](screenshots/model-picker.png)<br>**Pick, don't type**: models, sessions, permission modes |
| ![Emoji](screenshots/emoji.png)<br>**`:emoji`** autocomplete, like Slack | |

## What the chat does that the terminal can't

- **Images, shown right in the conversation**:
  - **Yours**: attach them with **+**, drag them onto the chat, or paste a screenshot with ⌘V.
  - **The agent's**: images it reads or makes appear in its tool results, like screenshots it takes or diagrams it renders.
  - Click any image to open it full size.
- **Files by drag and drop**: drop any file on the chat to attach it. On another machine, it's copied there first.
- **Live progress**: while the agent works, its reply appears as it's written. The command or tool it's running shows too, with its output so far and how long it's been running.
- **Formatted replies**: markdown with headings, lists, tables and code blocks, and text you can select and copy. Replies are formatted while they stream, too.
- **Code blocks you can use**: every code block has **Copy** and **Play** buttons. With a terminal split beside the chat, Play runs shell code there (the one you clicked last); otherwise it puts the code in the message box, so a suggested command is one Enter away.
- **Tool calls folded away**: a turn's tool calls collapse into one line ("4 tool calls · Bash, Read, Edit"). Click it to see each call with its output and any images.
- **Questions as buttons**: when the agent asks for permission or asks you something, the choices appear as buttons you click. The same goes for the terminal's own pickers (`/theme`, `/export`, Codex's `/permissions`…).
- **Follow-up queue**: messages sent while the agent works wait in one collapsible panel above the composer. It starts collapsed with the queue count; expand it to see right-aligned messages, oldest first. Hover a message to reveal **Instant** and remove actions. Chat sends one per completed turn; **Instant** sends an individual item immediately, and × removes it. Text and attachments survive layout reloads on this client. Session changes pause old items; delivery failures stay visible for manual retry. This queue belongs to the desktop Chat client, so automatic delivery needs Herdr running; terminal-native queues and other clients are separate.
- **Side questions**: ask about the conversation in the side chat (⌘;) while the agent keeps working. Nothing there is added to its conversation.
- **Cards for the numbers**: context usage as a bar by category, plan limits and spend with progress bars, MCP servers with Reconnect and Disable buttons, memory and settings files that open in an editor.
- **Pick, don't type**: the model and effort from a menu, earlier sessions to resume from a list, the permission mode from a list. Commands come with their descriptions and the arguments they take.
- **A real text box**: multi-line editing, an emoji picker (☺) and `:emoji` autocomplete, and command chips.
- **`@` file mentions**: type `@` and part of a name to pick a file or folder from the agent's project.
- **Copy and edit messages**: hover a reply to copy it, or one of your messages to copy it or put it back in the box to change and send again.
- **Search the conversation**: ⌘F (Ctrl+F on Linux and Windows), or the search icon in the header, shows only the messages that match.
- **Permissions from the message box**: Claude's modes (Ask before edits, Accept edits, Plan, Auto, Bypass) or Codex's (Ask for approval, Approve for me, Full Access, Read Only), next to the model.
- **Move to chat**: a Claude or Codex terminal you started yourself gets a **Move to chat** button in the tab bar that opens it as a chat.

## Install

Ask the agent running in your Herdr: *"add the layout from github.com/XD-Open-Jarvis/herdr-chat/tree/customized"*. Or do it by hand:

```sh
git clone --branch customized https://github.com/XD-Open-Jarvis/herdr-chat
cd herdr-chat
cp -R mods/* ~/.config/herdr-app/mods/
cp layouts/chat.json ~/.config/herdr-app/layouts/
herdr-app do layout.switch '{"name":"chat"}'
```

Then merge `keys.json` into `~/.config/herdr-app/keys.json`. Its `secondary-shift-n` is New chat on ⌘⇧N on macOS and Ctrl+Shift+N on Linux and Windows. Existing Ctrl+N shell bindings are preserved.

**Requirements:**
- `python3`, and `claude` and/or `codex`, on the machine where the agents run.
- On Linux:
  - `kdialog` or `zenity` for the **+** file picker.
  - `wl-clipboard` or `xclip` (or KDE's Klipper) for `/copy` and pasting images.

To keep your own layout instead, point its pane header at `chat-pane` and its tab bar at `chat-tabs`. Optionally, point its spaces sidebar at `spaces-chat`. See [RECIPE.md](RECIPE.md) for how it all works.

## What's in it

| Folder | What it is |
|---|---|
| `mods/chat` | The chat itself |
| `mods/chat-file` | The editor dialog behind `/memory`, `/hooks` and `/config` |
| `mods/chat-pane` | The pane header: closing a chat or an agent's terminal asks first |
| `mods/chat-tabs` | The tab bar with a **Move to chat** button |
| `mods/spaces-chat` | The spaces sidebar with **New chat there** |
| `layouts/chat.json` | Herdr's main layout, using the mods above |
| `keys.json` | New chat on ⌘⇧N (macOS) or Ctrl+Shift+N (Linux and Windows), through `secondary-shift-n` |

## License

MIT, see [LICENSE](LICENSE).

### Codex conversation identification

Chat checks the terminal's current screen against structured user/assistant
messages in candidate logs. A match requires two distinct messages in screen
order with evidence unique to one candidate. Inherited fork history is read at
its recorded byte boundary and cannot distinguish parent and child by itself.
Startup arguments, modification times and old manual selections are not treated
as the current session identity.

If identification is uncertain, Chat hides the transcript and asks you to open
TUI, run `/status`, leave the status panel visible, and return to **Check again**.
Chat reads the displayed Session ID; it never sends `/status` automatically or
requires a Codex configuration change. Matching is conservative and bounded
(40 same-directory candidates, 4 MiB of combined history per candidate), so long
histories, insufficient visible text or unreadable logs can require this step.

Once verified, a Codex binding is persisted for its owning tab/pane/terminal
and checked against the foreground PID plus process start time. A later screen
with insufficient matching text does not revoke it. Mod/app reloads restore a
binding only after verifying that process identity. Explicit new session
identity replaces it; a displayed status for an unavailable session invalidates
it. In-place session changes still require new identity evidence: process
continuity alone cannot prove that no external `/fork` or `/resume` occurred.

Chat also follows Herdr's shared `herdr.seen=<turn>` read-state contract. A
foreground, visible Chat with a loaded conversation acknowledges completed
turns once. Hidden/background views and unresolved sessions do not mark them
read, and continuous polling does not override another client's mark-unread
until the conversation is viewed again.

Note that `terminals().status` is the raw agent phase (often `idle` after
completion), whereas the sidebar's `done` is derived from unread turns. Chat
acknowledges raw `idle` as well as `done`, and handles the status event arriving
before the incremented turn event.

New Chat-created Codex terminals now opt into terminal-title identity using a
per-launch `tui.terminal_title` override. This avoids log-text guessing across
in-place forks/resumes for the tested Codex 0.167.1. The emitted ID is truncated,
so the layout validates its prefix against metadata and requires a unique match.
Existing terminals and global Codex configuration are unchanged. See
[the verification and limitations](docs/codex-title-identity.md).
