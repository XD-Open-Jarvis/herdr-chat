// Format recorded changes only; never reconstruct old code from today's files.
export function diffLines(file) {
  const raw = (file.diff ?? "").replace(/\r\n/g, "\n");
  const path = value => String(value).replace(/^[/\\]+/, "").replace(/\\/g, "/");
  const before = path(file.oldPath ?? file.path), after = path(file.path);
  let lines = raw ? raw.split("\n") : [];
  if (lines.at(-1) === "") lines.pop();
  if (!/^diff --git /m.test(raw)) {
    const header = [`diff --git a/${before} b/${after}`];
    if (file.oldPath) header.push(`rename from ${file.oldPath}`, `rename to ${file.path}`);
    header.push(`--- ${file.operation === "add" ? "/dev/null" : `a/${before}`}`,
      `+++ ${file.operation === "delete" ? "/dev/null" : `b/${after}`}`);
    // The patch API often omits original line numbers. Preserve those hunks
    // as @@ rather than fabricate line positions in the repository.
    if (lines.length && !lines[0].startsWith("@@")) {
      header.push(file.operation === "add" ? `@@ -0,0 +1,${lines.filter(line => line.startsWith("+")).length} @@` : "@@");
    }
    lines = [...header, ...lines];
    if (!raw) lines.push("Contents were not recorded in this tool call.");
  }
  return lines.map(text => ({text, kind: /^diff --git |^index |^--- |^\+\+\+ |^(?:new|deleted) file mode |^rename (?:from|to) /.test(text) ? "header"
    : text.startsWith("@@") ? "hunk" : text.startsWith("+") ? "added" : text.startsWith("-") ? "removed" : "context"}));
}
export function diffGroups(lines) {
  const groups=[];
  for (const line of lines) {
    const previous=groups.at(-1);
    if (previous?.kind===line.kind) previous.text+='\n'+line.text;
    else groups.push({...line});
  }
  return groups;
}

// Keep line numbers from recorded hunk headers. Some tool records omit them;
// those rows deliberately show an empty gutter instead of guessed numbers.
export function diffBlocks(file) {
  let before = null, after = null;
  const blocks = [];
  for (const line of diffLines(file)) {
    if (line.kind === "header") continue;
    if (line.kind === "hunk") {
      const match = /^@@ -([0-9]+)(?:,[0-9]+)? \+([0-9]+)(?:,[0-9]+)? @@/.exec(line.text);
      if (match) { before = Number(match[1]); after = Number(match[2]); continue; }
    }
    const kind = line.kind;
    const number = kind === "removed" ? before : after;
    if (kind === "removed" && before != null) before++;
    else if (kind === "added" && after != null) after++;
    else if (kind === "context" && line.text.startsWith(" ")) {
      if (before != null) before++;
      if (after != null) after++;
    }
    const code = ["added", "removed"].includes(kind) || (kind === "context" && line.text.startsWith(" "))
      ? line.text.slice(1) : line.text;
    const block = blocks.at(-1);
    if (block?.kind === kind) { block.numbers.push(number == null ? "" : String(number)); block.code.push(code); }
    else blocks.push({ kind, numbers: [number == null ? "" : String(number)], code: [code] });
  }
  return blocks;
}
