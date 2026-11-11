import { exec } from "herdr";

// Resolve inherited history on the machine that owns the terminal. Byte bounds
// come from Codex metadata and apply before decoding JSONL records.
export const HISTORY_PY = `
import json, pathlib, sys
root = pathlib.Path.home() / ".codex" / "sessions"
limit = 4 * 1024 * 1024
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
chunks = []
truncated = False
for path, start, end in reversed(segments):
    if remaining <= 0:
        truncated = True
        break
    length = end - start
    take = min(length, remaining)
    with path.open("rb") as stream:
        stream.seek(end - take)
        data = stream.read(take)
    if take < length:
        data = data.partition(b"\\n")[2]
        truncated = True
    chunks.append(data)
    remaining -= take
print(json.dumps({"lines": b"".join(reversed(chunks)).decode("utf-8").splitlines(),
                  "offset": offset,
                  "truncated": truncated}))
`;

export async function inheritedHistory(file, on) {
  const result = await exec("python3", ["-c", HISTORY_PY, file], { on });
  if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not read inherited conversation");
  return JSON.parse(result.stdout);
}
