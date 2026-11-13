import { exec } from "herdr";

// Resolve inherited history on the machine that owns the terminal. Byte bounds
// come from Codex metadata and apply before decoding JSONL records.
export const HISTORY_PY = `
import json, pathlib, sys
codex_home = pathlib.Path.home() / ".codex"
roots = [p for p in (codex_home / "sessions", codex_home / "archived_sessions") if p.exists()]
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 4 * 1024 * 1024
skip_tail = int(sys.argv[3]) if len(sys.argv) > 3 else 0
if limit <= 0 or skip_tail < 0: raise ValueError("Invalid history limit")
seen = set()
index = None
def inherited(path, bound=None):
    global index
    path = path.resolve()
    if path in seen: raise RuntimeError("Cycle in Codex fork history")
    seen.add(path)
    with path.open("rb") as stream:
        header = stream.readline()
        meta = json.loads(header).get("payload", {})
        size = path.stat().st_size
        end = min(size, bound) if bound is not None else size
        base = meta.get("history_base")
        segments = []
        if base:
            parent_id = base.get("thread_id")
            offset = base.get("end_byte_offset")
            if not isinstance(parent_id, str) or not isinstance(offset, int) or offset < 0:
                raise RuntimeError("Invalid Codex inherited history boundary")
            if index is None:
                index = {}
                for root in roots:
                    for candidate in root.rglob("rollout-*.jsonl"):
                        key = candidate.name[-42:-6]
                        index.setdefault(key, []).append(candidate)
            matches = index.get(parent_id, [])
            if len(matches) != 1: raise RuntimeError("Parent Codex conversation is missing or ambiguous")
            parent = matches[0]
            if parent.stat().st_size < offset: raise RuntimeError("Parent Codex conversation is truncated")
            segments = inherited(parent, offset)
        start = len(header)
        if end > start: segments.append((path, start, end))
        return segments
leaf = pathlib.Path(sys.argv[1])
# Snapshot the last complete record. Later appends remain for Tail.read().
with leaf.open("rb") as stream:
    position = leaf.stat().st_size
    offset = 0
    while position > 0:
        start = max(0, position - 65536)
        stream.seek(start)
        chunk = stream.read(position - start)
        newline = chunk.rfind(b"\\n")
        if newline >= 0:
            offset = start + newline + 1
            break
        position = start
segments = inherited(leaf, offset)
# Keep a bounded suffix of the combined inherited history, as the normal reader
# does for long conversations. Always discard an incomplete first JSONL record.
remaining = limit
to_skip = skip_tail
chunks = []
truncated = False
for path, start, end in reversed(segments):
    seg_len = end - start
    if to_skip >= seg_len:
        to_skip -= seg_len
        continue
    eff_end = end - to_skip
    to_skip = 0
    if remaining <= 0:
        truncated = True
        break
    length = eff_end - start
    take = min(length, remaining)
    with path.open("rb") as stream:
        if take < length:
            stream.seek(eff_end - take - 1)
            prev = stream.read(1)
            data = stream.read(take)
            if prev != b"\\n":
                data = data.partition(b"\\n")[2]
            truncated = True
        else:
            stream.seek(start)
            data = stream.read(take)
    chunks.append(data)
    remaining -= take
consumed = sum(len(c) for c in chunks)
print(json.dumps({"lines": b"".join(reversed(chunks)).decode("utf-8", errors="replace").splitlines(),
                  "offset": offset,
                  "truncated": truncated,
                  "nextSkip": skip_tail + consumed}))
`;

const HISTORY_WINDOW = 3 * 1024 * 1024;

export async function inheritedHistory(file, on, bytes = 4 * 1024 * 1024) {
  const batches = [];
  let remaining = bytes, skip = 0, leafOffset = 0, truncated = false;
  while (remaining > 0) {
    const step = Math.min(remaining, HISTORY_WINDOW);
    const args = skip > 0 ? ["-c", HISTORY_PY, file, String(step), String(skip)] : ["-c", HISTORY_PY, file, String(step)];
    const result = await exec("python3", args, { on });
    if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not read inherited conversation");
    const page = JSON.parse(result.stdout);
    if (skip === 0) leafOffset = page.offset;
    batches.push(page.lines);
    truncated = Boolean(page.truncated);
    const consumed = (page.nextSkip ?? skip) - skip;
    if (!truncated || consumed <= 0) break;
    skip = page.nextSkip;
    remaining -= consumed;
  }
  return { lines: batches.reverse().flat(), offset: leafOffset, truncated };
}

// Rebuilding a larger log suffix must retain existing message/tool anchors.
// Match from the newest entry backwards so duplicate short messages ("ok",
// "Worked for 2s") align to the recent suffix rather than older prepended turns.
export function rebaseHistory(previous, next, pending, generation) {
  const signature = entry => JSON.stringify([entry.kind, entry.text, entry.items?.map(item => item.id)]);
  const positions = new Map();
  next.entries.forEach((entry, index) => {
    const key = signature(entry);
    if (!positions.has(key)) positions.set(key, []);
    positions.get(key).push(index);
    entry.key = `history-${generation}-${index}`;
  });
  const isUser = item => item.kind === "user" && !item.command;
  const usersBefore = new Array(previous.entries.length);
  let count = 0;
  for (let i = 0; i < previous.entries.length; i++) {
    usersBefore[i] = count;
    if (isUser(previous.entries[i])) count++;
  }
  let upper = next.entries.length, earliestMatch = null;
  for (let i = previous.entries.length - 1; i >= 0; i--) {
    const entry = previous.entries[i];
    const candidates = positions.get(signature(entry));
    while (candidates?.length && candidates[candidates.length - 1] >= upper) candidates.pop();
    if (!candidates?.length) continue;
    const index = candidates.pop();
    next.entries[index].key = entry.key;
    upper = index;
    earliestMatch = { index, before: usersBefore[i] };
  }
  const prefixUsers = earliestMatch
    ? Math.max(0, next.entries.slice(0, earliestMatch.index).filter(isUser).length - earliestMatch.before)
    : 0;
  for (const message of pending) message.users += prefixUsers;
  next.breakAfter = previous.breakAfter;
}
