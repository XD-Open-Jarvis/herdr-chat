# Herdr Chat

Chat is a personal layout presentation, not a core mod pane. The local
`conversation-view` stack switches between `main` (the real tab split tree)
and `conversation-page` (a 44 px chat-pane header plus the Chat body).

Use the identical `presentation.js` helpers in chat/chat-pane/chat-tabs to open
Chat. Save only terminal-local IDs in layout props: `terminal`, `owner_tab`,
`owner_pane` refer to the ORIGINAL TERMINAL pane, never a new Chat pane.
Resolve the exact owner among live terminal panes, then use its tab's current
client alias. Reject missing/ambiguous matches. Do not use the active machine
or global bare terminal matches to guess identity.

Opening Chat changes only the personal layout; it must never call pane.split,
pane.zoom, terminal.park, or core doc.set. Returning to TUI selects `main` and
focuses the original terminal without changing split proportions or zoom.
Switching tabs/spaces leaves Chat mode. Chat has no split UI and consumes pane
structure keyboard shortcuts. Other layouts and mobile keep native terminals.
Old Chat panes and terminal labels are not automatically migrated or deleted.
The new-chat dialog starts one real terminal, then selects the local Chat view.

The installer only copies layout/mod files and merges a non-conflicting shortcut.
Use `--install` for a fresh installation, `--update` for file backups and updates,
and `--diagnose` to verify file/header/stack routing. Never migrate sessions.

User bubbles wrap actual content up to 70% of the conversation content width.
Base text is 15 px. Image limits: messages/expanded tools 420x300, collapsed tools
312x215, attachments 144x108. Preserve image aspect ratios without upscaling.
Unwrap hc user transport envelopes and retain sender labels; filter internal
system envelopes. Hidden Chat copies skip expensive rendering, session discovery,
log polling and terminal scraping. Resume when the view becomes visible.

Keep the shared conversation header with workspace, terminal address, title,
status, search and Chat / TUI. Preserve native terminal split behavior in TUI.
Use neutral focus borders with a single visible pane; accent for multiple panes.
Do not resend pending layout.set updates on every redraw. Never let border
reconciliation overwrite a pending Chat selection. Preserve existing shortcuts;
new Chat uses Cmd+Shift+N / Ctrl+Shift+N.

Use folderPoll for local log waits: one pending watch across fallback timeouts;
cancel the losing timer. Promise.race alone does not cancel a pending watch.
