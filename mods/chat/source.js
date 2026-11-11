// Finds the session log an agent terminal is writing, and reads it as it grows.
import { exec } from "herdr";
import { Buffer } from "buffer";

// Start this far from the end of a long log; earlier history is skipped.
const TAIL_BYTES = 4 * 1024 * 1024;

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
  id=$(sed -n 's/.*"sessionId":"\\([^"]*\\)".*/\\1/p' "$f")
  [ -n "$id" ] || continue
  log=$(ls "$HOME"/.claude/projects/*/"$id".jsonl 2>/dev/null | head -1)
  [ -n "$log" ] && echo "$log" && exit 0
done`;

// Codex keeps its rollout file open; fall back to the newest one for this folder.
const CODEX = `
kids=$(pgrep -P "$1" | tr '\\n' ' ')
grand=$(for k in $kids; do pgrep -P "$k"; done | tr '\\n' ' ')
for p in "$1" $kids $grand; do
  { lsof -p "$p" -Fn 2>/dev/null | sed -n 's/^n//p'; ls -l "/proc/$p/fd" 2>/dev/null | sed 's/.* -> //'; } | grep '/sessions/.*rollout-.*\\.jsonl$'
done | sort -u | { files=$(cat); [ "$(printf '%s\\n' "$files" | grep -c .)" = 1 ] && printf '%s\\n' "$files"; }`;

export async function locate(term, kind) {
  const pid = term?.foreground?.pid;
  if (!pid) return null;
  if (kind === "codex") {
    const argv = term.foreground?.argv ?? [];
    const resume = argv.indexOf("resume");
    const explicit = resume >= 0 && /^[0-9a-f-]{36}$/.test(argv[resume + 1] ?? "") ? argv[resume + 1] : null;
    const labeled = term.labels?.["chat.session.pid"] === String(pid) ? term.labels?.["chat.session.id"] : null;
    const id = explicit ?? labeled;
    if (id && /^[0-9a-f-]{36}$/.test(id)) {
      const script = `import pathlib,json,sys
matches=list((pathlib.Path.home()/".codex/sessions").rglob("rollout-*"+sys.argv[1]+".jsonl"))
if len(matches)==1:
    with matches[0].open() as f: meta=json.loads(f.readline()).get("payload",{})
    if meta.get("id")==sys.argv[1]: print(matches[0])`;
      const result = await exec("python3", ["-c", script, id], { on: machineOf(term.address) });
      return result.code === 0 ? result.stdout.trim() || null : null;
    }
  }
  const on = machineOf(term.address);
  const r = await sh(kind === "codex" ? CODEX : CLAUDE, [String(pid), term.foreground.cwd ?? ""], on);
  return r.stdout.trim().split("\n")[0] || null;
}

// Reads complete new lines from `file` since the last call.
export class Tail {
  constructor(file, on) {
    this.file = file;
    this.on = on;
    this.offset = null;
  }

  async read() {
    let skipFirst = false;
    if (this.offset === null) {
      const r = await sh('wc -c < "$1"', [this.file], this.on);
      const size = parseInt(r.stdout.trim(), 10) || 0;
      this.offset = Math.max(0, size - TAIL_BYTES);
      skipFirst = this.offset > 0;
      this.truncated = skipFirst;
    }
    const r = await exec("tail", ["-c", `+${this.offset + 1}`, this.file], { on: this.on });
    if (r.code !== 0) throw new Error(r.stderr.trim() || "can't read the session log");
    const s = r.stdout;
    const cut = s.lastIndexOf("\n");
    if (cut < 0) return [];
    const chunk = s.slice(0, cut + 1);
    this.offset += Buffer.from(chunk, "utf8").length;
    const lines = chunk.split("\n").filter(Boolean);
    if (skipFirst) lines.shift();
    return lines;
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
