// A per-launch override, not a change to ~/.codex/config.toml. Keep the ID last
// so it has an unambiguous location independent of the human-readable name.
export const CODEX_TITLE_CONFIG = 'tui.terminal_title=["app-name","thread-title","project-name","thread-id"]';

export function codexTitleIdentity(terminal) {
  if (!terminal || terminal.state !== "live" || terminal.report?.app !== "codex") return null;
  if (!["working", "idle", "done", "blocked", "error"].includes(terminal.report?.state ?? terminal.status)) return null;
  const argv = terminal.foreground?.argv;
  if (!Array.isArray(argv) || !/(?:^|[/\\])codex(?:\.exe)?$/.test(argv[0] ?? "")) return null;
  // Only trust titles from a TUI explicitly launched with a supported profile.
  // An arbitrary UUID in a task name or a leftover shell title is not identity.
  let override = null;
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    const value = ["-c", "--config"].includes(arg) ? argv[++index]
      : arg.startsWith("--config=") ? arg.slice(9) : null;
    if (value?.startsWith("tui.terminal_title=")) override = value;
  }
  if (!override) return null;
  let items;
  try { items = JSON.parse(override.slice(override.indexOf("=") + 1)); } catch { return null; }
  if (!Array.isArray(items) || items.at(-1) !== "thread-id" || !items.every(item => ["app-name", "thread-title", "project-name", "thread-id"].includes(item))) return null;
  const part = terminal.title?.split(" | ").at(-1)?.trim().toLowerCase();
  const full = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  if (full.test(part ?? "")) return { prefix: part, complete: true };
  // Codex 0.167.1 truncates thread-id to 29 characters plus three dots.
  // Resolve this prefix against all log IDs, and reject collisions.
  const truncated = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{5,11})(?:\.\.\.|…)$/.exec(part ?? "");
  return truncated ? { prefix: truncated[1], complete: false } : null;
}

export function titleMatchesFile(identity, file) {
  const id = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i.exec(file ?? "")?.[1];
  return Boolean(id && id.toLowerCase().startsWith(identity.prefix));
}

export function conversationTitle(terminal) {
  const identity = codexTitleIdentity(terminal);
  if (!identity) return terminal?.title ?? "";
  const parts = terminal.title.split(" | ").slice(0, -1);
  if (parts[0] === "codex") parts.shift();
  // A new, unnamed Codex thread uses its full UUID as its title too.
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(parts[0] ?? "")) parts.shift();
  return parts.join(" | ") || "Codex";
}
