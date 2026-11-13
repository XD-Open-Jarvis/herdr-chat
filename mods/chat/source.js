// Finds the session log an agent terminal is writing, and reads it as it grows.
import { exec } from "herdr";

// Start this far from the end of a long log; earlier history is skipped.
const TAIL_BYTES = 4 * 1024 * 1024;
const TAIL_CHUNK_BYTES = 4 * 1024 * 1024;

const sh = (script, args, on) => exec("sh", ["-c", script, "sh", ...args], { on });

export const machineOf = (address) => (address?.includes("/") ? address.split("/")[0] : null);

export function agentKind(term) {
  const argv0 = term?.argv?.[0]?.split("/").pop() ?? "";
  const what = `${term?.report?.app ?? ""} ${term?.foreground?.name ?? ""} ${term?.program?.key ?? ""} ${argv0}`.toLowerCase();
  return what.includes("claude") ? "claude" : what.includes("codex") ? "codex" : null;
}

// Claude Code writes ~/.claude/sessions/<pid>.json with the live session id.
const CLAUDE = `
for p in "$1" $(pgrep -P "$1"); do
  f="$HOME/.claude/sessions/$p.json"
  [ -f "$f" ] || continue
  id=$(sed -n 's/.*"sessionId"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$f")
  [ -n "$id" ] || continue
  log=$(ls "$HOME"/.claude/projects/*/"$id".jsonl 2>/dev/null | head -1)
  [ -n "$log" ] && echo "$log" && exit 0
done`;

// An open rollout is a candidate, not proof after an in-process fork.
const CODEX = `
kids=$(pgrep -P "$1" | tr '\\n' ' ')
grand=$(for k in $kids; do pgrep -P "$k"; done | tr '\\n' ' ')
for p in "$1" $kids $grand; do
  { lsof -nP -p "$p" -Fn 2>/dev/null | sed -n 's/^n//p'; ls -l "/proc/$p/fd" 2>/dev/null | sed 's/.* -> //'; } | grep '/sessions/.*rollout-.*\\.jsonl$'
done | sort -u | { files=$(cat); [ "$(printf '%s\\n' "$files" | grep -c .)" = 1 ] && printf '%s\\n' "$files"; }`;

export async function locate(term, kind) {
  const pid = term?.foreground?.pid;
  if (!pid) return null;
  const on = machineOf(term.address);
  const r = await sh(kind === "codex" ? CODEX : CLAUDE, [String(pid), term.foreground.cwd ?? ""], on);
  return r.stdout.trim().split("\n")[0] || null;
}

// Track raw byte offsets in Python before UTF-8 decoding so splitting a
// multi-byte character at the tail boundary never shifts future offsets, and
// cap each read well below Herdr's 8 MiB exec stdout limit.
export const TAIL_PY = `
import os, sys
path, off, budget, skip, cap = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4] == "1", int(sys.argv[5])
size = os.path.getsize(path)
trunc = False
if off < 0:
    off = max(0, size - budget)
    skip = off > 0
    trunc = skip
elif off > size:
    off = 0
    skip = False
end = min(size, off + cap)
with open(path, "rb") as f:
    f.seek(off)
    data = f.read(max(0, end - off))
    while end < size and b"\\n" not in data and len(data) < 6 * 1024 * 1024:
        extra = f.read(min(1024 * 1024, size - end))
        if not extra: break
        data += extra
        end += len(extra)
cut = data.rfind(b"\\n")
if cut < 0:
    sys.stdout.write(f"{off} {int(trunc)} {int(skip)} {size}\\n")
    sys.exit(0)
chunk = data[:cut + 1]
off += cut + 1
if skip:
    chunk = chunk.split(b"\\n", 1)[1]
    skip = False
sys.stdout.write(f"{off} {int(trunc)} {int(skip)} {size}\\n")
sys.stdout.write(chunk.decode("utf-8", errors="replace"))
`;

// Reads complete new lines from `file` since the last call.
export class Tail {
  constructor(file, on, bytes = TAIL_BYTES) {
    this.bytes = bytes;
    this.file = file;
    this.on = on;
    this.offset = null;
    this.skipFirst = false;
    this.truncated = false;
  }

  async read() {
    const out = [];
    let targetSize = null;
    for (let guard = 0; guard < 64; guard++) {
      const first = this.offset === null;
      const r = await exec("python3", [
        "-c", TAIL_PY, this.file, String(first ? -1 : this.offset),
        String(this.bytes), this.skipFirst ? "1" : "0", String(TAIL_CHUNK_BYTES),
      ], { on: this.on });
      if (r.code !== 0) throw new Error(r.stderr.trim() || "can't read the session log");
      const nl = r.stdout.indexOf("\n");
      const [nextOff, trunc, nextSkip, fileSize] = (nl < 0 ? r.stdout : r.stdout.slice(0, nl)).trim().split(" ").map(Number);
      const prevOff = this.offset;
      this.offset = nextOff;
      if (first) this.truncated = Boolean(trunc);
      this.skipFirst = Boolean(nextSkip);
      if (targetSize === null) targetSize = fileSize;
      const body = nl < 0 ? "" : r.stdout.slice(nl + 1);
      if (body) out.push(...body.split("\n").filter(Boolean));
      if (this.offset >= targetSize || this.offset === prevOff || !body && first) break;
    }
    return out;
  }
}

// Fork candidates are offered explicitly: a sibling branch is not proof of
// which thread the running TUI currently owns.
export async function forkCandidates(file, term) {
  const script = `
import json,pathlib,sys
cwd=sys.argv[2]
root=pathlib.Path.home()/".codex"/"sessions"
found=[]
for path in root.rglob("rollout-*.jsonl"):
    try:
        with path.open() as stream: m=json.loads(stream.readline()).get("payload",{})
        if m.get("cwd")==cwd and m.get("originator")=="codex-tui":
            found.append({"file":str(path),"id":m["id"],"timestamp":m.get("timestamp","")})
    except Exception: pass
print(json.dumps(sorted(found,key=lambda x:x["timestamp"],reverse=True)))
`;
  const result = await exec("python3", ["-c", script, file ?? "", term.foreground?.cwd ?? ""], { on: machineOf(term.address) });
  if (result.code !== 0) return [];
  try { return JSON.parse(result.stdout); } catch { return []; }
}
