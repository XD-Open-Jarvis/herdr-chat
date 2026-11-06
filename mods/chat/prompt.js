// Reads a question an agent asks on its terminal screen (a trust or
// permission prompt): the question's text and its choices, if it has any.

const MARKER = /^(\s*)([❯›>])\s+/;
const NUMBER = /^\s*\d+[.)]\s+/;
const HINT = /(Enter to (confirm|select)|Esc to (cancel|exit)|↑\/↓|to navigate)/i;
const RULE = /^\s*[─━—\-▔▁═]{8,}\s*$/;

// { question, options: [text], selected } or null when the screen has no menu.
export function parsePrompt(screen) {
  // A ✔ marks the current choice; read it as an indent, so its line lines up.
  const current = new Set();
  const lines = (screen ?? "").split("\n").map((l, i) => {
    const m = /^(\s*(?:[❯›>]\s+)?)[✔✓]\s/.exec(l);
    if (!m) return l;
    current.add(i);
    return m[1] + "  " + l.slice(m[0].length);
  });
  const at = lines.findLastIndex((l) => MARKER.test(l) && !HINT.test(l));
  if (at < 0) return null;
  // Unselected options sit where the marker's text starts; deeper lines continue one.
  const indent = MARKER.exec(lines[at])[0].length;
  const depth = (l) => l.length - l.trimStart().length;
  const isOption = (l) => MARKER.test(l) || (l.trim() && depth(l) === indent && !HINT.test(l) && !RULE.test(l));
  const continues = (l) => l.trim() && depth(l) > indent && !HINT.test(l) && !RULE.test(l);

  let first = at;
  while (first > 0 && (isOption(lines[first - 1]) || continues(lines[first - 1]))) first--;
  while (first < at && !isOption(lines[first])) first++;
  let last = at;
  while (last + 1 < lines.length && (isOption(lines[last + 1]) || continues(lines[last + 1]))) last++;
  const options = [];
  let selected = 0;
  for (let i = first; i <= last; i++) {
    const l = lines[i];
    const text = l.replace(MARKER, "").replace(NUMBER, "").trim();
    if (!isOption(l)) { options[options.length - 1] += " " + text; continue; }
    if (i === at) selected = options.length;
    options.push(current.has(i) ? `${text} ✓` : text);
  }
  if (options.length < 2) return null;

  // The question: what's above the options, back to the last rule line.
  let top = first;
  while (top > 0 && !RULE.test(lines[top - 1])) top--;
  const question = reflow(lines.slice(top, first));
  return { question, options, selected };
}

// Terminal-wrapped text as paragraphs.
export function reflow(lines) {
  return lines.map((l) => l.trim()).join("\n").replace(/\n{2,}/g, "\u0000").replace(/\n/g, " ")
    .split("\u0000").map((p) => p.trim()).filter(Boolean).join("\n\n");
}

// The keys that move the selection from `from` to `to` and confirm it.
export function choose(from, to) {
  const keys = Array(Math.abs(to - from)).fill(to > from ? "down" : "up");
  return [...keys, "enter"];
}
