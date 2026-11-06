// What an agent is doing right now, read off its terminal: the reply it's
// writing, or the command or tool it's running and its output so far. The
// terminal draws both as they happen; the log only gets them once done.

// Claude Code: a reply is a "⏺ " line and the lines indented under it. One
// whose first words name a tool ("⏺ Bash(…)") is a tool call, its output
// under "⎿"; a "! " line is a shell command typed into it. Codex: the same
// with "• ", its tool lines naming what it does, output under "└".
const CLAUDE = { mark: "⏺ ", prompt: /^❯ \S/, run: /^! \S/, tool: /^⏺ [\w.:-]+\(|^⏺ (Read|Searched|Listed|Wrote|Updated|Edited|Fetched|Ran|Called|Found)\b.*\b(file|files|pattern|patterns|lines?|director(y|ies)|command|tools?)\b/ };
const CODEX = { mark: "• ", prompt: /^› \S/, run: /^\$ \S/, tool: /^• (Running|Ran|Explored|Exploring|Edited|Editing|Read|Reading|Searched|Searching|Called|Calling|Updated Plan|Added|Deleted|Listed|Viewed|Applied|Proposed)\b/ };
const STATUS = /^• (Working|Waiting|Interrupted)\b/;

// { kind: "text", text } | { kind: "run", title, out: [lines], time } | null
export function live(screen, kind) {
  const k = kind === "codex" ? CODEX : CLAUDE;
  const lines = (screen ?? "").split("\n").filter((l) => !l.startsWith("[hc]"));
  // The message box at the bottom: its rule line (Claude) or its prompt (Codex).
  let end = lines.length;
  if (kind === "codex") { for (let i = lines.length - 1; i >= 0; i--) if (/^› /.test(lines[i])) { end = i; break; } }
  else for (let i = lines.length - 1; i > 0; i--) if (/^─{10,}/.test(lines[i]) && /^❯/.test(lines[i + 1] ?? "")) { end = i; break; }
  // This turn: after the last message sent.
  let from = 0;
  for (let i = end - 1; i >= 0; i--) if (k.prompt.test(lines[i])) { from = i + 1; break; }
  // The last block in it: a reply, a tool call or a shell command.
  let at = -1;
  for (let i = end - 1; i >= from; i--) {
    const l = lines[i];
    if (l.startsWith(k.mark) && !STATUS.test(l)) { at = i; break; }
    if (k.run.test(l)) { at = i; break; }
  }
  if (at < 0) return null;
  const head = lines[at];
  const body = [];
  for (let i = at + 1; i < end; i++) {
    const l = lines[i];
    if ((l && !l.startsWith(" ")) || /^\s*Worked for \d/.test(l)) break;
    body.push(l);
  }
  if (k.run.test(head) || k.tool.test(head) || body.some((l) => /^\s*[⎿└]/.test(l))) {
    let time = null;
    const out = [];
    for (const l of body) {
      const t = l.replace(/^\s*[⎿└]\s?/, "").replace(/^\s{2,}/, "").trimEnd();
      if (/^\(ctrl\+\w+ to .*\)$|^\(esc to .*\)$/i.test(t.trim())) continue;
      const m = /^\((\d+[hms](?: \d+[ms])*)\)$/.exec(t.trim());
      if (m) { time = m[1]; continue; }
      out.push(t);
    }
    while (out.length && !out[out.length - 1].trim()) out.pop();
    const indent = Math.min(...out.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length), 99);
    if (indent < 99) for (let i = 0; i < out.length; i++) out[i] = out[i].slice(indent);
    const title = k.run.test(head) ? `$ ${head.slice(2)}` : head.slice(k.mark.length);
    return { kind: "run", title: title.trim(), out, time };
  }
  // A reply: wrapped lines back into paragraphs; blank lines, lists and code stay.
  const block = [head.slice(k.mark.length), ...body.map((l) => l.slice(2))];
  const out = [];
  for (const l of block) {
    const prev = out[out.length - 1];
    const starts = /^\s*([-*•]|\d+[.)]|#|>|```|\|)/.test(l);
    if (prev && prev.trim() && l.trim() && !starts && !/^\s{2,}/.test(l)) out[out.length - 1] = `${prev} ${l.trim()}`;
    else out.push(l);
  }
  const text = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return text ? { kind: "text", text } : null;
}

export const streaming = (screen, kind) => {
  const x = live(screen, kind);
  return x?.kind === "text" ? x.text : null;
};
