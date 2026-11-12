import { exec } from "herdr";
import { HISTORY_PY } from "./history.js";
import { machineOf } from "./source.js";
import { codexTitleIdentity } from "./title.js";

// Match only structured conversation bodies, never tool output. Shared fork
// history is deliberately present in every candidate so it cannot break ties.
export const SESSION_PY = `
import json, pathlib, sys, re, io, contextlib
screen, cwd, hint, history, *extra = json.loads(sys.argv[1])
identity = extra[0] if extra else None
root = pathlib.Path.home()/".codex"/"sessions"
# The terminal supplied this identity. Never replace it with a cwd/text guess
# while its new log is being created or when the prefix is ambiguous.
if identity:
    prefix = identity.get("prefix", "")
    if not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{5,12}", prefix):
        raise RuntimeError("Invalid terminal title identity")
    matches = []
    for path in root.rglob("rollout-*" + prefix + "*.jsonl"):
        try:
            with path.open() as stream: meta = json.loads(stream.readline()).get("payload", {})
            ident = meta.get("id", "")
            if ident.startswith(prefix) and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", ident):
                if identity.get("complete") and ident != prefix: continue
                matches.append((str(path), ident))
        except Exception: pass
    found = matches[0] if len(matches) == 1 else (None, None)
    print(json.dumps({"file":found[0], "sessionId":found[1], "evidence":"title", "matchCount":len(matches)})); sys.exit()
def norm(s):
    s = re.sub(r"\\x1b\\[[0-?]*[ -/]*[@-~]", "", s)
    return re.sub(r"[\\W_]+", "", s).casefold()
found = []
all_sessions = []
for path in root.rglob("rollout-*.jsonl"):
    try:
        with path.open() as stream: meta = json.loads(stream.readline()).get("payload", {})
        all_sessions.append((str(path), meta.get("id")))
        if meta.get("cwd") == cwd: found.append((str(path), meta.get("id")))
    except Exception: pass
# Only a visible status panel can provide an exact identity. UUIDs in ordinary
# conversation text, command examples or scrollback are not identity evidence.
ids = re.findall(r"(?mi)^\\s*[│┃]?\\s*Session(?: ID)?\\s*:\\s*([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\\s*[│┃]?\\s*$", screen)
status = bool(re.search(r"(?i)context window\\s*:", screen) and re.search(r"(?i)(model|directory)\\s*:", screen))
if status and len(set(ids)) == 1:
    matches = [p for p, ident in all_sessions if ident == ids[0]]
    print(json.dumps({"file":matches[0] if len(matches)==1 else None,"evidence":"status"})); sys.exit()
# Bound the work. Never discard older candidates and select a newer one instead.
if len(found) > 40:
    print(json.dumps({"file":None,"evidence":"too-many-candidates"})); sys.exit()
anchors = []
for line in screen.splitlines():
    line = re.sub(r"^\\s*[›❯•●│┃]+\\s*", "", line)
    if re.search(r"(?i)context left|shortcuts|esc to|tokens? used|gpt-|codex |session:|https?://|^[-+>$]|^\\s*\\d+[:|]", line): continue
    text = norm(line)
    if len(text) >= 24 and text not in anchors: anchors.append(text)
anchors = anchors[-24:]
scores = []
failed = False
for path, ident in found:
    try:
        output = io.StringIO()
        saved = sys.argv
        sys.argv = ["history", path]
        with contextlib.redirect_stdout(output): exec(history, {})
        sys.argv = saved
        records = json.loads(output.getvalue())["lines"]
        bodies = []
        for line in records:
            item = json.loads(line); p = item.get("payload", {})
            if item.get("type") == "event_msg" and p.get("type") in ("user_message", "agent_message"):
                bodies.append(norm(p.get("message", "")))
            elif item.get("type") == "response_item" and p.get("type") == "message" and p.get("role") in ("user", "assistant"):
                bodies.append(norm("".join(c.get("text", "") for c in p.get("content", []) if c.get("type") in ("input_text", "output_text"))))
        bodies = list(dict.fromkeys(bodies))
        positions = {i: next((j for j, body in enumerate(bodies) if a in body), -1) for i, a in enumerate(anchors)}
        hits = {i for i, j in positions.items() if j >= 0}
        scores.append((path, hits, positions))
    except Exception:
        sys.argv = saved; failed = True
winners = []
for path, hits, positions in scores:
    others = set().union(*(h for p, h, _ in scores if p != path))
    unique = sorted(hits - others)
    # Two lines of one message are insufficient. Require two distinct messages
    # appearing in terminal order, not two duplicated event/response records.
    ordered = any(positions[a] < positions[b] for a in unique for b in unique if a < b)
    if ordered: winners.append(path)
file = winners[0] if len(winners)==1 and not failed else None
print(json.dumps({"file":file,"evidence":"text" if file else "ambiguous"}))
`;

export async function resolveSession(term, screen, hint) {
  const result = await exec("python3", ["-c", SESSION_PY, JSON.stringify([screen, term.foreground?.cwd ?? "", hint, HISTORY_PY, codexTitleIdentity(term)])], { on: machineOf(term.address), timeout: 30000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not identify the conversation");
  return JSON.parse(result.stdout);
}
