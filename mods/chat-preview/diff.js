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
