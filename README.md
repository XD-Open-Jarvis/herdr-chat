# Herdr Chat

A chat window for [Herdr](https://herdr.dev) that sits over your Claude Code and Codex agents, with the terminal one click away. It works the way the Claude and ChatGPT apps do:
- a `/` command menu;
- a side chat that doesn't interrupt the agent;
- cards for context, usage, memory, MCP servers and settings;
- pickers drawn in the chat;
- replies that stream as they're written;
- Slack-style `:emoji` autocomplete.

![The chat with its / command menu](preview.png)

| | |
|---|---|
| ![Searching commands](screenshots/command-search.png)<br>**Commands** with their descriptions, arguments and aliases | ![Side chat](screenshots/side-chat.png)<br>**Side chat**: ask without interrupting the agent |
| ![A command running](screenshots/live-command.png)<br>**Live progress**: the command running now and its output | ![Context card](screenshots/context-card.png)<br>**Cards** for context, usage, MCP servers, memory |
| ![A terminal picker in the chat](screenshots/terminal-picker.png)<br>**Terminal pickers** as buttons, right in the chat | ![Model picker](screenshots/model-picker.png)<br>**Pick, don't type**: models, sessions, permission modes |
| ![Chat and terminal side by side](screenshots/chat-and-terminal.png)<br>**The terminal** is one click away | ![Emoji](screenshots/emoji.png)<br>**`:emoji`** autocomplete, like Slack |

## What the chat does that the terminal can't

- **Images, shown right in the conversation**:
  - **Yours**: attach them with **+**, drag them onto the chat, or paste a screenshot with ⌘V.
  - **The agent's**: images it reads or makes appear in its tool results, like screenshots it takes or diagrams it renders.
  - Click any image to open it full size.
- **Files by drag and drop**: drop any file on the chat to attach it. On another machine, it's copied there first.
- **Live progress**: while the agent works, its reply appears as it's written. The command or tool it's running shows too, with its output so far and how long it's been running.
- **Formatted replies**: markdown with headings, lists, tables and code blocks, and text you can select and copy. Replies are formatted while they stream, too.
- **Tool calls folded away**: a turn's tool calls collapse into one line ("4 tool calls · Bash, Read, Edit"). Click it to see each call with its output and any images.
- **Questions as buttons**: when the agent asks for permission or asks you something, the choices appear as buttons you click. The same goes for the terminal's own pickers (`/theme`, `/export`, Codex's `/permissions`…).
- **Messages queued, not lost**: what you send while the agent works shows at once as a queued bubble. With Claude you can **Send now** (interrupt) or **Edit** it back into the box.
- **Side questions**: ask about the conversation in the side chat (⌘;) while the agent keeps working. Nothing there is added to its conversation.
- **Cards for the numbers**: context usage as a bar by category, plan limits and spend with progress bars, MCP servers with Reconnect and Disable buttons, memory and settings files that open in an editor.
- **Pick, don't type**: the model and effort from a menu, earlier sessions to resume from a list, the permission mode from a list. Commands come with their descriptions and the arguments they take.
- **A real text box**: multi-line editing, an emoji picker (☺) and `:emoji` autocomplete, and command chips.

## Install

Ask the agent running in your Herdr: *"add the layout from github.com/naruse/herdr-chat"*. Or do it by hand:

```sh
git clone https://github.com/naruse/herdr-chat
cd herdr-chat
cp -R mods/* ~/.config/herdr-app/mods/
cp layouts/chat.json ~/.config/herdr-app/layouts/
herdr-app do layout.switch '{"name":"chat"}'
```

Then merge `keys.json` into `~/.config/herdr-app/keys.json` (it binds ⌘N to New chat).

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
| `mods/chat-tabs` | The tab bar with a **Chat** button |
| `mods/spaces-chat` | The spaces sidebar with **New chat there** |
| `layouts/chat.json` | Herdr's main layout, using the mods above |

## License

MIT, see [LICENSE](LICENSE).
