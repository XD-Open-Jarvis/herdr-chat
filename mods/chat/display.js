// Presentation-only projections: keep the source transcript and its keys intact.
const SETTING = /^\/(effort|model|fast|permissions|config|settings|vim|theme|output-style|color)(?:\s|$)/;
export function compactSettings(entries) {
  const result = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.command && SETTING.test(entry.text ?? "")) {
      const next = entries[index + 1];
      const success = next?.kind === "notice" && next.event === "settings_changed";
      const cancelled = next?.kind === "output" && /^cancelled\.?$/i.test(next.text.trim());
      const match = success && /^Set effort level to (\S+)/i.exec(next.text);
      const text = match ? `Effort · ${match[1]}` : cancelled ? `${entry.text} · cancelled`
        : success ? next.text : entry.text;
      result.push({ ...entry, kind: "notice", event: "settings_changed", text,
        detail: [entry.text, next && (success || cancelled) ? next.detail ?? next.text : null].filter(Boolean).join("\n"),
        aliasKeys: success || cancelled ? [entry.key, next.key] : [entry.key] });
      if (success || cancelled) index++;
      continue;
    }
    result.push(entry);
  }
  return result;
}
// GPUI truncates horizontal overflow but still honors embedded newlines.
export const summaryLine = text => String(text ?? "").split(/\r?\n/).find(line => line.trim())?.trim() ?? "";
export function toolSummary(items, running = false) {
  const active = running && items.find(item => item.result === null);
  if (active || items.length === 1) {
    const item = active || items[0];
    const summary = summaryLine(item.summary);
    return `${item.name}${summary ? " · " + summary : ""}`;
  }
  const groups = new Map(), edited = new Set();
  for (const item of items) {
    const name = item.name.toLowerCase();
    const category = /^(edit|write|multiedit|apply_patch|file_change)$/.test(name) ? "edits"
      : /^(read|read_file|file_read)$/.test(name) ? "reads"
      : /^(grep|glob|search|file_search)$/.test(name) ? "searches"
      : /^(bash|shell|exec_command|write_stdin|command_execution)$/.test(name) ? "commands"
      : /^(web|websearch|webfetch|web_search|web_fetch)$/.test(name) ? "web calls"
      : /^(task|agent|spawn_agent)$/.test(name) ? "agents" : item.name;
    if (category === "edits" && item.changes?.length) {
      if (item.commands?.length) groups.set("commands", (groups.get("commands") ?? 0) + item.commands.length);
      for (const file of item.changes) {
        if (edited.has(file.path)) continue;
        edited.add(file.path);
        groups.set(category, (groups.get(category) ?? 0) + 1);
      }
      continue;
    }
    if (category === "edits") {
      let input = item.input;
      if (typeof input === "string") { try { input = JSON.parse(input); } catch {} }
      const path = input?.file_path ?? input?.path;
      if (path && edited.has(path)) continue;
      if (path) edited.add(path);
    }
    groups.set(category, (groups.get(category) ?? 0) + 1);
  }
  const labels = {edits:["edit","edits"],reads:["read","reads"],searches:["search","searches"],commands:["command","commands"],"web calls":["web call","web calls"],agents:["agent","agents"]};
  return [...groups].map(([category,count]) => `${count} ${labels[category]?.[count === 1 ? 0 : 1] ?? category}`).join(" · ");
}
