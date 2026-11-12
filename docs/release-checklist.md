# Herdr Chat Plus release checklist

## Ready in the current checkout

- The five mods, layout, icons, themes, installer, recipe, original MIT license, and original-author credit are present.
- Fresh install, file-only update with backups, and read-only diagnosis have dedicated installer modes.
- The current Mini installation runs the Chat layout with no app errors. Codex and Claude Code are the supported transcript providers.

## Before publishing a separate repository

1. **Replace the gallery image.** `preview.png` and most files in `screenshots/` show the old side-by-side Chat pane. Capture a representative Chat/TUI view using a disposable conversation with no private content. Update the layout preview and README illustration together.
2. **Decide the repository and layout identity.** The installed layout and mod names are still `chat` and `chat-*`. Keeping those names makes updating existing installations straightforward but conflicts with another `chat` layout. A distinct `chat-plus` namespace would require changing layout references, mod imports, installer paths, keys, and documentation as one migration. Choose this before the public release.
3. **Validate the release install on a clean app home and another Mac.** Check both fresh install and update paths, remote aliases, Chat/TUI switching, Codex resume/fork, queue delivery, and image preview. The installer does not migrate old sessions.
4. **Set release metadata.** Create the new repository, update clone links and source references, add a version tag and changelog, and document the tested Herdr App and Codex versions. There is no confirmed built-in automatic update channel for third-party layouts.
5. **Review all asset attribution.** naruse's MIT notice and Catppuccin's palette MIT notice are included. Check any new preview or screenshot assets before publishing.

## Follow-up work after an initial release

- Add adapters for other agents, starting with Grok only after establishing reliable session identity, transcript events, input and permission handling. Paseo's ACP integration is a useful reference, but an ACP session does not automatically attach to an existing TUI.
- Investigate transient duplication of a previous assistant reply in the screen-based live preview. The likely path is a missed Codex prompt boundary followed by cross-turn screen text being treated as new streaming text.
- Keep terminal rendering and scrolling performance separate from layout claims; native terminal work belongs in Herdr App/Core.
