// Turns Claude Code and Codex session logs (JSONL) into chat entries:
// { kind: "user" | "assistant" | "tools" | "note", key, text, images, items }.
// Images come out as { data (base64) | path, ext } for the view to cache.

// hc delivers user text in an envelope. Unwrap only this transport tag;
// keep filtering internal task/environment blocks as before.
export function hcMessage(text) {
  const match = /^\s*<hc(?:\s+([^>]*))?>([\s\S]*?)<\/hc>\s*$/.exec(text ?? "");
  if (!match) return { text: text ?? "", from: null };
  const from = /\bfrom\s*=\s*["']([^"']*)["']/.exec(match[1] ?? "")?.[1] ?? "hc";
  return { text: match[2].trim(), from };
}

// hc prepends file descriptors to the person's text. Consume only valid
// leading transport records; JSON examples in prose/code remain untouched.
const SHELL_ESCAPED_PATH = /^\s*(?:'((?:[^']|'\\'')*)'|"([^"]+)"|((?:\\[ \\'"()&;$`!*?[\]{}<>|#~]|[^\s'"])+))/;

const INTERNAL_ENVELOPE_TAGS = new Set([
  "environment_context", "task-notification", "subagent_notification", "teammate-message",
  "ide_opened_file", "ide_selection", "user-prompt-submit-hook", "command-message",
  "local-command-caveat", "permissions", "collaboration_mode", "app-context",
  "turn_aborted", "user_shell_command", "instructions", "user_instructions",
  "developer_instructions", "skill", "context", "fast_mode_info",
]);

export function isInternalEnvelope(text) {
  const m = /^<([a-z][a-z0-9_-]*)(?:\s[^>]*)?>([\s\S]*)<\/\1>$/.exec(text);
  if (!m || !INTERNAL_ENVELOPE_TAGS.has(m[1])) return false;
  const tag = m[1], inner = m[2];
  const token = new RegExp(`<(\\/?)${tag}(?:\\s[^>]*)?>`, "g");
  let depth = 1, hit;
  while ((hit = token.exec(inner))) {
    depth += hit[1] ? -1 : 1;
    if (depth <= 0) return false;
  }
  return depth === 1;
}

export function userAttachments(text) {
  const files = [];
  for (;;) {
    const match = /^\s*((?:\\)*\{[^\r\n]*?(?:\\)*\})/.exec(text);
    if (!match) {
      // The composer sends cached attachment paths as shell-quoted or
      // backslash-escaped tokens. Recognize Herdr-managed file locations only.
      const token = SHELL_ESCAPED_PATH.exec(text);
      const path = token?.[1] != null ? token[1].replace(/'\\''/g, "'")
        : token?.[2] != null ? token[2]
        : (token?.[3] ?? "").replace(/\\([ \\'"()&;$`!*?[\]{}<>|#~])/g, "$1");
      if (!/(?:^|\/)(?:(?:herdr[^/]*\/)?data\/chat\/files|herdr-core\/[^/]+\/files)\//i.test(path)
        || !/^(?:\/|[A-Za-z]:[\\/])/.test(path)) break;
      files.push({ path, bytes: null, name: path.split(/[\\/]/).pop() });
      text = text.slice(token[0].length).trimStart();
      continue;
    }
    let file, record = match[1];
    // Transport can escape braces only, or escape the complete record more
    // than once. Always try valid JSON first so Windows paths and filenames
    // retain their own JSON escapes.
    for (let layer = 0; layer < 5 && !file; layer++) {
      for (const candidate of [record, record.replace(/\\([{}])/g, "$1")]) {
        try { file = JSON.parse(candidate); break; } catch {}
      }
      record = record.replace(/\\([\\{}"])/g, "$1");
    }
    if (!file) break;
    if (!file || typeof file.path !== "string" || !/^(?:\/|[A-Za-z]:[\\/])/.test(file.path)
      || !Number.isFinite(file.bytes) || file.bytes < 0
      || Object.keys(file).some(key => !["path", "bytes", "name", "mime", "type"].includes(key))) break;
    files.push({ path: file.path, bytes: file.bytes, name: file.name || file.path.split(/[\\/]/).pop() });
    text = text.slice(match[0].length).trimStart();
  }
  return { text: text.trim(), files };
}

// Decode only recognizable execution-transport records, never arbitrary JSON
// printed by the user's command. Format before applying the output size limit.
export function toolOutput(raw) {
  let text = raw;
  const header = /^(?:Script completed|Script running with cell ID[^\n]*|Chunk ID:[^\n]*)[\s\S]*?^Output:\r?\n/m.exec(text);
  if (header?.index === 0 && header[0].length < 1000 && /Wall time/i.test(header[0])) text = text.slice(header[0].length).replace(/^\r?\n(?=\{)/, "");
  let exitCode = null, sessionId = null;
  const records = [];
  text = text.split("\n").map(line => {
    let record;
    try { record = JSON.parse(line); } catch { return line; }
    if (!record || typeof record.output !== "string" || !("chunk_id" in record || "wall_time_seconds" in record)) return line;
    records.push(record);
    return record.output.replace(/\n$/, "");
  }).join("\n");
  if (records.length) {
    const codes = records.filter(record => Number.isInteger(record.exit_code)).map(record => record.exit_code);
    exitCode = codes.find(code => code !== 0) ?? codes.at(-1) ?? null;
    const sessions = [...new Set(records.map(record => record.session_id).filter(id => id != null))];
    if (sessions.length === 1) sessionId = sessions[0];
  }
  return {text, exitCode, sessionId};
}

const MAX_RESULT = 6000;

const stripAnsi = (s) => s.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, "");

// Anything content-like (string, [{text}], {output}) as plain text.
export function toText(x) {
  if (x == null) return "";
  if (typeof x === "string") return x;
  if (Array.isArray(x)) return x.map(toText).filter(Boolean).join("\n");
  if (typeof x === "object") {
    if (typeof x.text === "string") return x.text;
    if (x.output != null) return toText(x.output);
    if (x.content != null) return toText(x.content);
  }
  return "";
}

const extOf = (media) => ({ "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp" })[media] ?? "png";

function fromDataUrl(url) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url ?? "");
  return m ? { data: m[2], ext: extOf(m[1]) } : null;
}

// A one-line description of a tool call's input.
export function summarize(input) {
  let v = input;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return v.split("\n")[0]; } }
  if (v && typeof v === "object") {
    for (const k of ["description", "command", "cmd", "file_path", "path", "pattern", "url", "query", "prompt", "name"]) {
      const x = v[k];
      if (typeof x === "string" && x) return x.split("\n")[0];
      if (Array.isArray(x) && x.length) return x.join(" ").split("\n")[0];
    }
    if (v.action) return summarize(v.action);
    const first = Object.values(v).find((x) => typeof x === "string");
    if (first) return first.split("\n")[0];
  }
  return "";
}

export class Transcript {
  constructor(kind) {
    this.kind = kind;
    this.entries = [];
    this.tools = new Map();
    this.next = 0;
    this.revision = 0;
    this.issue = null;
    this.turnId = null;
    this.title = null;
    // Messages waiting in Claude Code's own queue (sent while it worked), as its
    // queue operations record them: taken in order, absorbed mid-turn, or popped
    // back into its input.
    this.queue = [];
    // What the log says the session runs on (Claude doesn't log its effort).
    this.model = null;
    this.effort = null;
    // Tokens the session used, per model, from its replies (each counted once).
    this.tokens = {};
    this.counted = new Map();
  }

  push(entry) {
    entry.key = `e${this.next++}`;
    this.entries.push(entry);
    return entry;
  }

  last() { return this.entries[this.entries.length - 1]; }

  note(text) { if (text) this.push({ kind: "note", text }); }

  user(text, images = []) {
    const incoming = hcMessage(text);
    text = incoming.text;
    let prev;
    do {
      prev = text;
      text = text.replace(/<system-reminder>(?:(?!<system-reminder>)[\s\S])*?<\/system-reminder>/g, "");
    } while (text !== prev);
    text = text.trim();
    // Slash commands and their output, as Claude Code records them.
    const cmd = /<command-name>([^<]*)<\/command-name>/.exec(text);
    if (cmd) {
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
      // /compact is logged again after the compaction: shown once, before it.
      const [before, note] = this.entries.slice(-2);
      if (note?.compact && before?.kind === "user" && before.text === `${cmd[1].trim()}${args ? " " + args : ""}`) return;
      return this.push({ kind: "user", command: true, text: `${cmd[1].trim()}${args ? " " + args : ""}`, images: [] });
    }
    const out = /<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/.exec(text);
    if (out) {
      const o = stripAnsi(out[1]).trim();
      if (/^Compacted\b/.test(o) && this.entries.some((e) => e.compact)) return;
      if (o) {
        const command = this.last();
        const settings = command?.command && /^\/(?:effort|model|fast|permissions|config|settings|vim|theme|output-style|color)(?:\s|$)/.test(command.text);
        const failure = /<local-command-stderr>/.test(text) || /\b(error|failed|invalid|unknown|unsupported|unable|cannot|couldn't|warning)\b/i.test(o);
        if (settings && !failure && o.split("\n").length <= 2) {
          const effort = /^(Set effort level to \S+(?:\s+\([^)]*\))?)(?::|$)/.exec(o);
          this.push({ kind: "notice", event: "settings_changed", text: effort?.[1] ?? o, detail: o });
        } else this.push({ kind: "output", text: o, error: failure });
      }
      return;
    }
    if (/^<local-command-caveat>/.test(text)) return;
    const bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(text);
    if (bash) text = "! " + bash[1];
    const stdout = /<bash-stdout>([\s\S]*?)<\/bash-stdout>/.exec(text);
    if (stdout) return this.note(stripAnsi(stdout[1]).trim().split("\n").slice(-6).join("\n"));
    if (/^\[Request interrupted/.test(text)) return this.note("Interrupted");
    // Other tag-wrapped injections (task notifications, environment context).
    if (isInternalEnvelope(text)) return;
    const attached = userAttachments(text);
    text = attached.text;
    const files = [];
    images = [...images];
    const describedImages = attached.files.filter(file => /\.(png|jpe?g|gif|webp|bmp|tiff?|heic)$/i.test(file.path));
    // Codex may supply both the hc descriptor and the same ordered image
    // blocks. Prefer those blocks (also usable remotely) instead of doubling.
    const alreadyEmbedded = images.length === describedImages.length && images.every(image => image.data);
    for (const file of attached.files) {
      if (/\.(png|jpe?g|gif|webp|bmp|tiff?|heic)$/i.test(file.path)) {
        if (!alreadyEmbedded && !images.some(image => image.path === file.path)) images.push(file);
      } else if (!files.some(existing => existing.path === file.path)) files.push(file);
    }
    if (!text && !images.length && !files.length) return;
    if (this.kind !== "codex") {
      this.turnId = `turn-${this.next}`;
      this.issue = null;
    }
    this.push({ kind: "user", text, images, files, ...(incoming.from ? { from: incoming.from } : {}) });
  }

  modelSettings(model, effort) {
    const before = this.model;
    const changed = before && ((model && model !== before) || (effort != null && effort !== this.effort));
    this.model = model ?? this.model;
    this.effort = effort ?? this.effort;
    if (changed) this.push({ kind: "notice", event: "model_changed",
      text: `Model changed to ${[this.model, this.effort].filter(Boolean).join(" · ")}` });
  }

  completed(duration, timestamp, id) {
    if (!Number.isFinite(duration) || duration < 0) return;
    this.completedTurns ??= new Set();
    if (id && this.completedTurns.has(id)) return;
    if (id) this.completedTurns.add(id);
    const seconds = Math.floor(duration / 1000), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
    const elapsed = hours ? `${hours}h ${minutes % 60}m ${seconds % 60}s` : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
    this.push({ kind: "notice", event: "completed", text: `Worked for ${elapsed}`, timestamp });
  }

  // The context card, in place of the terminal's drawing of the same numbers.
  contextCard(md) {
    const tokens = /\*\*Tokens:\*\*\s*([\d.]+[km]?)\s*\/\s*([\d.]+[km]?)\s*\((\d+)%\)/i.exec(md);
    const table = /### Estimated usage by category\s*\n([\s\S]*?)(?:\n\s*\n|\n###|$)/.exec(md)?.[1] ?? "";
    const cats = table.split("\n").slice(2).map((l) => l.split("|").map((x) => x.trim()).filter(Boolean))
      .filter((c) => c.length >= 3).map(([name, tokens, pct]) => ({ name, tokens, pct: parseFloat(pct) || 0 }));
    const win = { k: 1e3, m: 1e6 };
    const max = /([\d.]+)([km]?)$/.exec(tokens?.[2] ?? "");
    const size = (v) => { const m = /([\d.]+)([km]?)$/.exec(v ?? ""); return m ? parseFloat(m[1]) * (win[m[2]] ?? 1) : null; };
    if (max) this.context = { used: size(tokens[1]) ?? this.context?.used ?? 0, window: size(tokens[2]) };
    const card = { kind: "card", card: "context", model: /\*\*Model:\*\*\s*(\S+)/.exec(md)?.[1] ?? null,
      used: tokens?.[1], max: tokens?.[2], pct: tokens ? Number(tokens[3]) : null, cats };
    const prev = this.last();
    if (prev?.kind === "output") { Object.keys(prev).forEach((k) => k !== "key" && delete prev[k]); Object.assign(prev, card); }
    else this.push(card);
  }

  // An optimistic user message is already visible, even if its log record is
  // delayed. New output must not merge into the group above that message.
  markInput() { this.breakAfter = this.last()?.key; }

  assistant(text) {
    if (!text?.trim()) return;
    const prev = this.last();
    if (prev?.kind === "assistant" && prev.key !== this.breakAfter) prev.text += "\n\n" + text;
    else this.push({ kind: "assistant", text });
  }

  toolUse(id, name, input) {
    let group = this.last();
    if (group?.kind !== "tools" || group.key === this.breakAfter) group = this.push({ kind: "tools", items: [] });
    let args = input;
    if (typeof args === "string") { try { args = JSON.parse(args); } catch {} }
    const item = { id, name, summary: summarize(input), input: args, result: null, error: false, images: [] };
    group.items.push(item);
    this.revision++;
    if (id) this.tools.set(id, item);
  }

  toolResult(id, content, error) {
    const item = this.tools.get(id);
    if (!item) return;
    const parts = Array.isArray(content) ? content : [content];
    for (const p of parts) {
      if (p?.type === "image" && p.source?.data) item.images.push({ data: p.source.data, ext: extOf(p.source.media_type) });
      if (p?.type === "input_image") { const img = fromDataUrl(p.image_url); if (img) item.images.push(img); }
    }
    const output = toolOutput(stripAnsi(toText(content)));
    const text = stripAnsi(output.text);
    item.exitCode = output.exitCode;
    item.sessionId = output.sessionId;
    item.result = text.length > MAX_RESULT ? text.slice(0, MAX_RESULT) + "\n…" : text;
    item.error = Boolean(error) || (output.exitCode != null && output.exitCode !== 0);
    this.revision++;
  }

  feed(line) {
    let d;
    try { d = JSON.parse(line); } catch { return; }
    try {
      if (this.kind === "codex") this.codex(d);
      else this.claude(d);
    } catch {}
  }

  claude(d) {
    if (d.isSidechain) return;
    if (d.type === "system" && d.subtype === "turn_duration")
      return this.completed(d.durationMs, d.timestamp, d.uuid);
    if (d.type === "system" && d.subtype === "api_error")
      return this.agentError(d.error ?? d.content ?? d, d.timestamp, this.turnId ?? d.uuid);
    if (d.type === "queue-operation") {
      const text = typeof d.content === "string" ? d.content : toText(d.content);
      if (d.operation === "enqueue") this.queue.push(text);
      else if (d.operation === "dequeue") this.queue.shift();
      else if (d.operation === "remove") { const i = this.queue.indexOf(text); if (i >= 0) this.queue.splice(i, 1); }
      else if (d.operation === "popAll") this.queue = [];
      return;
    }
    if (d.type === "custom-title" && d.customTitle) this.title = d.customTitle;
    else if (d.type === "ai-title" && d.aiTitle) this.title = d.aiTitle;
    // Each message logs the permission mode it was sent in.
    if (d.type === "user" && d.permissionMode) this.mode = d.permissionMode;
    if (d.type === "system" && d.subtype === "compact_boundary") {
      // Until the next reply says exactly, the summary plus what every request carries.
      // Never more than before compacting.
      const after = d.compactMetadata?.postTokens, before = d.compactMetadata?.preTokens ?? Infinity;
      if (after != null) this.context = { used: Math.min(after + (this.base ?? 0), before), window: this.context?.window ?? null };
      return this.push({ kind: "note", text: "Conversation compacted", compact: true });
    }
    // Slash commands and what they print, in newer versions of Claude Code.
    if (d.type === "system" && d.subtype === "local_command" && typeof d.content === "string") return this.user(d.content);
    // A message sent while the agent worked and taken into that turn is logged
    // as an attachment, not a user message. Only the person's own.
    const q = d.attachment;
    if (q?.type === "queued_command" && (q.origin?.kind ?? "human") === "human" && (q.commandMode ?? "prompt") === "prompt") {
      if (typeof q.prompt === "string") return this.user(q.prompt);
      const blocks = Array.isArray(q.prompt) ? q.prompt : [];
      const images = blocks.filter((b) => b.type === "image" && b.source?.data).map((b) => ({ data: b.source.data, ext: extOf(b.source.media_type) }));
      return this.user(blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n"), images);
    }
    if (d.type === "user") {
      // /context also logs its numbers as markdown: they become a card.
      const meta = d.message?.content;
      if (d.isMeta && typeof meta === "string" && meta.startsWith("## Context Usage")) return this.contextCard(meta);
      if (d.isCompactSummary && typeof meta === "string") {
        const note = [...this.entries].reverse().find((e) => e.compact);
        // Without the note to Claude at its end ("If you need specific details…").
        if (note) note.summary = meta.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
          .replace(/\n+If you need specific details from before compaction[\s\S]*$/, "").trim();
        return;
      }
      if (d.isMeta || d.isCompactSummary || d.isVisibleInTranscriptOnly) return;
      const c = d.message?.content;
      if (typeof c === "string") return this.user(c);
      if (!Array.isArray(c)) return;
      const texts = [], images = [];
      for (const b of c) {
        if (b.type === "text") texts.push(b.text);
        else if (b.type === "image" && b.source?.data) images.push({ data: b.source.data, ext: extOf(b.source.media_type) });
        else if (b.type === "tool_result") this.toolResult(b.tool_use_id, b.content, b.is_error);
      }
      if (texts.length || images.length) this.user(texts.join("\n"), images);
    } else if (d.type === "assistant") {
      if (d.isApiErrorMessage) {
        this.agentError({ message: toText(d.message?.content), code: d.error }, d.timestamp, this.turnId ?? d.uuid);
        return;
      }
      if (d.message?.model && !d.message.model.startsWith("<")) this.model = d.message.model;
      const u = d.message?.usage, id = d.message?.id;
      // How full the context is: what the latest reply was sent and wrote.
      if (u && !d.message.model?.startsWith("<")) {
        if (this.base == null) this.base = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        this.context = { used: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0), window: this.context?.window ?? null };
      }
      if (u && id && !d.message.model?.startsWith("<")) {
        const m = (this.tokens[d.message.model] ??= { input: 0, output: 0 });
        const prev = this.counted.get(id);
        if (!prev) {
          const out = u.output_tokens ?? 0;
          m.input += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          m.output += out;
          this.counted.set(id, { output: out });
        } else if ((u.output_tokens ?? 0) > prev.output) {
          m.output += (u.output_tokens ?? 0) - prev.output;
          prev.output = u.output_tokens ?? 0;
        }
      }
      for (const b of d.message?.content ?? []) {
        if (b?.type === "text") this.assistant(b.text);
        else if (b?.type === "tool_use") this.toolUse(b.id, b.name, b.input);
      }
    }
  }

  agentError(error, timestamp, turn = this.turnId) {
    const message = typeof error === "string" ? error : error?.message ?? toText(error);
    if (!message?.trim()) return;
    const code = typeof error?.codex_error_info === "string" ? error.codex_error_info
      : typeof error?.code === "string" ? error.code : null;
    const usage = /usage_limit|rate_limit/i.test(code ?? "")
      || /hit your (?:usage )?limit|usage limit (?:reached|exceeded)|out of extra usage/i.test(message);
    if (this.issue?.turn === turn && this.issue.message === message) return;
    this.issue = {message, code, usage, turn};
    this.push({kind:"error", event:"agent_error", text:message, code, usage, timestamp});
  }

  codex(d) {
    const p = d.payload ?? {};
    if (d.type === "compacted") return this.note("Conversation compacted");
    if (d.type === "event_msg" && p.type === "task_started") {
      this.turnId = p.turn_id ?? p.root_turn_id ?? null;
      this.issue = null;
      return;
    }
    if (d.type === "event_msg" && p.type === "error") {
      this.agentError(p.error ?? p, d.timestamp, p.turn_id ?? this.turnId);
      return;
    }
    if (d.type === "turn_context") {
      this.modelSettings(p.model, p.effort ?? p.collaboration_mode?.settings?.reasoning_effort);
      // Which of /permissions' presets this turn ran with.
      const box = p.sandbox_policy?.type;
      if (box) this.mode = box === "read-only" ? "read" : box === "danger-full-access" ? "full" : p.approvals_reviewer === "auto_review" ? "auto" : "ask";
      return;
    }
    if (d.type === "event_msg" && p.type === "thread_settings_applied") {
      const settings = p.thread_settings ?? {};
      this.modelSettings(settings.model, settings.reasoning_effort ?? settings.collaboration_mode?.settings?.reasoning_effort);
      return;
    }
    if (d.type === "event_msg" && p.type === "task_complete") {
      if (p.error) this.agentError(p.error, d.timestamp, p.turn_id ?? p.root_turn_id ?? this.turnId);
      const duration = p.duration_ms ?? (Number.isFinite(p.started_at) && Number.isFinite(p.completed_at)
        ? (p.completed_at - p.started_at) * 1000 : null);
      return this.completed(duration, d.timestamp, p.turn_id ?? p.root_turn_id ?? d.timestamp);
    }
    if (d.type === "event_msg" && p.type === "turn_aborted") return this.note("Interrupted");
    // Codex's running totals: tokens, how full the context is, and its limits.
    if (d.type === "event_msg" && p.type === "token_count") {
      const total = p.info?.total_token_usage;
      if (total) this.tokens = { [this.model ?? "codex"]: { input: total.input_tokens ?? 0, output: (total.output_tokens ?? 0) + (total.reasoning_output_tokens ?? 0) } };
      if (p.info) this.context = { used: p.info.last_token_usage?.total_tokens ?? 0, window: p.info.model_context_window ?? null };
      if (p.rate_limits) this.limits = p.rate_limits;
      return;
    }
    if (d.type !== "response_item") return;
    if (p.type === "message") {
      if (p.role === "assistant") return this.assistant(toText((p.content ?? []).filter((c) => c?.type === "output_text")));
      if (p.role !== "user") return;
      const texts = [], images = [];
      for (const c of p.content ?? []) {
        if (!c) continue;
        if (c.type === "input_image") { const img = fromDataUrl(c.image_url); if (img) images.push(img); continue; }
        let t = (c.text ?? "").trim();
        if (!t || /^<\/?image\b/.test(t) || (isInternalEnvelope(t) && !/^<hc(?:\s|>)/.test(t)) || /^# AGENTS\.md/.test(t)) continue;
        // The desktop app lists attachments, then "## My request:".
        const req = t.indexOf("## My request:");
        if (t.startsWith("# Files mentioned by the user:")) t = req >= 0 ? t.slice(req + 14).trim() : "";
        if (t) texts.push(t);
      }
      if (texts.length || images.length) this.user(texts.join("\n"), images);
    } else if (/_call$/.test(p.type)) {
      const id = p.call_id ?? p.id ?? `call-${this.next}-${this.revision}`;
      this.toolUse(id, p.name ?? p.type.replace(/_call$/, ""), p.arguments ?? p.input ?? p.action);
      if (p.type === "web_search_call" && p.status && p.status !== "in_progress") {
        this.toolResult(id, p.action?.query ? `Searched: ${p.action.query}` : "Completed", p.status === "failed");
      }
    } else if (/_call_output$/.test(p.type)) {
      this.toolResult(p.call_id, p.output, p.status === "failed");
    }
  }
}
