// Split ordinary Markdown around GitHub-style pipe tables. Code fences are
// removed by splitCode before this runs, so their pipes stay literal.
function cells(line) {
  if (/^ {4}|^\t/.test(line)) return null;
  let text = line.trim();
  if (!text.includes("|")) return null;
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const result = [];
  let cell = "", ticks = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "`" && (i === 0 || text[i - 1] !== "\\")) {
      let run = 1;
      while (text[i + run] === "`") run++;
      if (!ticks) ticks = run;
      else if (ticks === run) ticks = 0;
      cell += "`".repeat(run); i += run - 1;
    } else if (char === "|" && !ticks && (i === 0 || text[i - 1] !== "\\")) {
      result.push(cell.trim()); cell = "";
    } else cell += char;
  }
  result.push(cell.trim());
  return result;
}

export function splitMarkdownTables(markdown) {
  const lines = markdown.split("\n"), parts = [];
  let plain = [];
  const flush = () => { if (plain.length) { parts.push({ md: plain.join("\n") }); plain = []; } };
  for (let i = 0; i < lines.length;) {
    const head = cells(lines[i]), rule = cells(lines[i + 1] ?? "");
    if (!head || !rule || head.length !== rule.length || !rule.every(cell => /^:?-{3,}:?$/.test(cell))) {
      plain.push(lines[i++]); continue;
    }
    flush();
    const align = rule.map(cell => cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left");
    const rows = [head];
    i += 2;
    while (i < lines.length) {
      const row = cells(lines[i]);
      if (!row || row.length !== head.length) break;
      rows.push(row); i++;
    }
    parts.push({ table: { rows, align } });
  }
  flush();
  return parts;
}
