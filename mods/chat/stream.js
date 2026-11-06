// The reply an agent is writing right now, read off its terminal: the
// terminal draws it as it arrives, while the log only gets it once it's done.

// Claude Code: a reply is a "⏺ " line and the lines indented under it. One
// whose first words name a tool ("⏺ Bash(…)") or that a "⎿" result follows
// is a tool call. Codex: the same with "• ", its tool lines naming what it did.
const CLAUDE = { mark: "⏺ ", prompt: /^❯ \S/, tool: /^⏺ [\w.:-]+\(|^⏺ (Read|Searched|Listed|Wrote|Updated|Edited|Fetched|Ran|Called|Found)\b.*\b(file|files|pattern|patterns|lines?|director(y|ies)|command|tools?)\b/ };
const CODEX = { mark: "• ", prompt: /^› \S/, tool: /^• (Working|Ran|Explored|Edited|Read|Searched|Called|Updated Plan|Waited|Added|Deleted|Listed|Viewed|Applied|Proposed|Interrupted|Waiting)\b/ };

export function streaming(screen, kind) {
  const k = kind === "codex" ? CODEX : CLAUDE;
  const lines = (screen ?? "").split("\n").filter((l) => !l.startsWith("[hc]"));
  // The message box at the bottom: its rule line (Claude) or its prompt (Codex).
  let end = lines.length;
  if (kind === "codex") { for (let i = lines.length - 1; i >= 0; i--) if (k.prompt.test(lines[i]) || /^› /.test(lines[i])) { end = i; break; } }
  else for (let i = lines.length - 1; i > 0; i--) if (/^─{10,}/.test(lines[i]) && /^❯/.test(lines[i + 1] ?? "")) { end = i; break; }
  // This turn: after the last message sent.
  let from = 0;
  for (let i = end - 1; i >= 0; i--) if (k.prompt.test(lines[i])) { from = i + 1; break; }
  // The last reply block in it.
  let at = -1;
  for (let i = end - 1; i >= from; i--) if (lines[i].startsWith(k.mark)) { at = i; break; }
  if (at < 0 || k.tool.test(lines[at])) return null;
  const block = [lines[at].slice(k.mark.length)];
  for (let i = at + 1; i < end; i++) {
    const l = lines[i];
    if ((l && !l.startsWith("  ")) || /^\s*Worked for \d/.test(l)) break;
    if (/^\s*⎿/.test(l)) return null;
    block.push(l.slice(2));
  }
  // Wrapped lines back into paragraphs; blank lines, lists and code stay.
  const out = [];
  for (const l of block) {
    const prev = out[out.length - 1];
    const starts = /^\s*([-*•]|\d+[.)]|#|>|```|\|)/.test(l);
    if (prev && prev.trim() && l.trim() && !starts && !/^\s{2,}/.test(l)) out[out.length - 1] = `${prev} ${l.trim()}`;
    else out.push(l);
  }
  const text = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return text || null;
}
