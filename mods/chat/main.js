// A chat view of an agent terminal (Claude Code or Codex): its session log
// rendered as markdown with images, and a composer that types into it.
// Opened as a dialog (mod.open:chat, Cmd+N) it is the New chat form: it starts
// the agent in a new space and opens its client-local conversation view.
import { View, div, image, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, TextView, TextareaState, Textarea, Popover, HoverCard, InputState, Input } from "gpui-base";
import {
  exec, hc, run, props, terminals, panes, spaces, theme, settings, appHome, home,
  watchFolder, nextCommand, pickFolder, shared, setShared, closeOverlay, machines, openOverlay, notify,
  layout, keys, window as appWindow,
} from "herdr";
import * as fs from "fs/promises";
import { Buffer } from "buffer";
import { createHash } from "crypto";
import { Transcript } from "./parse.js";
import { inheritedHistory, rebaseHistory } from "./history.js";
import { folderPoll } from "./poll.js";
import { ownerPane, qualifyAddress, chatProps } from "./identity.js";
import { openChat as openConversation, showTerminal, presentationPane, presentationVisible, presentationLayoutReady } from "./presentation.js";
import { resolveSession } from "./session.js";
import { codexTitleIdentity, titleMatchesFile } from "./title.js";
import { bindingKey, chooseBinding } from "./binding.js";
import { Tail, locate, agentKind, machineOf } from "./source.js";
import { catalog, launchArgv, modelName, switchModel, CLAUDE_EFFORTS } from "./models.js";
import { emojify, emojiMatches } from "./emoji.js";
import { parsePrompt, choose, toggleChoice, menuAtBottom } from "./prompt.js";
import { loadCommands, matchCommands } from "./commands.js";
import { askSide, sessionOf, control, listSessions, askCodexSide, codexCalls } from "./sdk.js";
import { copyText, pasteImage, pickFiles, imageSize } from "./platform.js";
import { live, liveSnapshot } from "./stream.js";
import { CodexHandoff } from "./handoff.js";
import { HandoffTracer } from "./trace.js";
import { withPending } from "./timeline.js";
import { splitMarkdownTables } from "./table.js";
import { sidebarVisible, hoverGeometry } from "./hover-diff.js";
import { fileLink, previewKey, previewLayout } from "./preview.js";
import { diffLines, diffGroups } from "./diff.js";
import { compactSettings, toolSummary, summaryLine, commandPreview } from "./display.js";
import { toolDetails, withChanges, changeOverview } from "./activity.js";
import { ChatAttention } from "./attention.js";
import { IdentifyFeedback, identifyKey } from "./identify.js";
import { Outbox, outboxScope } from "./outbox.js";
import { herdr, chatTab, away, hide, show, switchView } from "./backstage.js";

const ASK_FIRST = "Answer the question above first.";

const CACHE = "data/chat";
const PAGE = 60;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic)$/i;
const AGENTS = { claude: "Claude Code", codex: "Codex" };

const sleep = (cx, ms) => new Promise((r) => cx.timer.after(ms, () => r()));
const hash = (s) => createHash("sha1").update(s).digest("hex").slice(0, 16);
const shellEscape = (p) => p.replace(/([ \\'"()&;$`!*?[\]{}<>|#~])/g, "\\$1");
const localId = (id) => id?.split("/").pop();
const tilde = (p) => (p?.startsWith(home()) ? "~" + p.slice(home().length) : p);

// The shown space: where a new chat starts by default.
const activeSpace = () => spaces().find((s) => s.active) ?? null;

// Runs independently of the dialog after space.new changes the current space.
const NEW_SPACE = `
json, os, shutil, subprocess, sys, time = map(__import__, ("json", "os", "shutil", "subprocess", "sys", "time"))
spec, tree, extra = map(json.loads, sys.argv[1:4])
cli = next((c for c in (
    shutil.which("herdr-app"),
    os.path.expanduser("~/.local/bin/herdr-app"),
    "/Applications/Herdr.app/Contents/MacOS/Herdr",
    "/Applications/Agents/Herdr.app/Contents/MacOS/Herdr",
) if c and os.access(c, os.X_OK)), "herdr-app")
def call(command, args):
    result = subprocess.run([cli, "do", command, json.dumps(args)], capture_output=True, text=True, check=True)
    reply = json.loads(result.stdout)
    if reply.get("error"): raise RuntimeError(reply["error"])
    return reply
def find(node, id):
    if node.get("id") == id: return node
    for child in node.get("children", []):
        found = find(child, id)
        if found is not None: return found
opened = call("space.new", spec)
for attempt in range(40):
    listing = json.loads(subprocess.check_output([cli, "ls"], text=True))
    targets = [p for s in listing["spaces"] for t in s["tabs"] if t["id"] == opened["tab"]
               for p in t.get("terminals", []) if p["terminal"] == opened["terminal"]]
    if len(targets) == 1: break
    time.sleep(.1)
else: raise RuntimeError("The new terminal pane did not appear")
local = lambda value: value.rsplit("/", 1)[-1]
meta = {**extra, "presentation": True, "terminal": local(opened["terminal"]),
        "owner_tab": local(opened["tab"]), "owner_pane": local(targets[0]["pane"])}
stack = find(tree, "conversation-view")
page = json.loads(json.dumps(find(tree, "conversation-page")))
pane_bg = ((find(tree, "main") or {}).get("content", {}).get("pane", {}) or {}).get("background")
if pane_bg: page["background"] = pane_bg
key = meta["owner_tab"] + "-" + meta["owner_pane"] + "-" + meta["terminal"]
def rename(node):
    node["id"] += "-" + key
    for child in node.get("children", []): rename(child)
rename(page)
for child in page["children"]:
    if child.get("content", {}).get("mod") in ("chat", "chat-pane"):
        child["content"]["props"] = meta
stack["children"].append(page)
stack["active"] = page["id"]
call("layout.set", {"layout": tree})
call("chat.focus", {})
print(json.dumps(opened))
`;


// Claude Code's permission modes, in its shift+tab order, and how its footer names them.
const MODES = [
  { id: "default", label: "Ask before edits", desc: "Claude asks before changing files or running commands" },
  { id: "acceptEdits", label: "Accept edits", desc: "Edits go through; other actions still ask" },
  { id: "plan", label: "Plan mode", desc: "Claude plans and reads, and changes nothing" },
  { id: "auto", label: "Auto mode", desc: "Claude decides what's safe to run without asking" },
  { id: "bypassPermissions", label: "Bypass permissions", desc: "Nothing asks first" },
];
// Codex's /permissions presets, with the names older versions gave them.
const CODEX_MODES = [
  { id: "ask", label: "Ask for approval", desc: "Works in this folder; asks for the internet or anything outside it", match: /^(Ask for approval|Default|Auto)\b/ },
  { id: "auto", label: "Approve for me", desc: "Only asks for actions that look unsafe", match: /^Approve for me\b/ },
  { id: "full", label: "Full Access", desc: "Edits anywhere and uses the internet without asking", match: /^Full Access\b/ },
  { id: "read", label: "Read Only", desc: "Reads files; asks before any edit or the internet", match: /^Read Only\b/ },
];
const modesOf = (kind) => (kind === "codex" ? CODEX_MODES : MODES);
// Shortcuts: ⌘ on macOS, Ctrl on Linux and Windows.
const MAC = (() => { try { return appWindow().platform === "macos"; } catch { return true; } })();
const shortcut = (key) => (MAC ? `⌘${key}` : `Ctrl+${key}`);
const modeOf = (screen) => /accept edits on/i.test(screen) ? "acceptEdits" : /plan mode on/i.test(screen) ? "plan"
  : /auto mode on/i.test(screen) ? "auto" : /bypass permissions on/i.test(screen) ? "bypassPermissions" : "default";

// Normalizes Codex (primary/secondary) and Claude (five_hour/seven_day) rate-limit snapshots.
function normalizeRateLimits(raw) {
  if (!raw || typeof raw !== "object") return null;
  const pick = (w, ...pctKeys) => {
    if (!w || typeof w !== "object") return null;
    let pct = null;
    for (const k of pctKeys) {
      if (typeof w[k] === "number" && Number.isFinite(w[k])) { pct = w[k]; break; }
    }
    if (pct == null) return null;
    const resetsAt = w.resetsAt ?? w.resets_at ?? null;
    return { pct: Math.max(0, Math.min(100, Math.round(pct))), resetsAt: resetsAt ?? null };
  };
  const fiveHour = pick(raw.fiveHour ?? raw.five_hour ?? raw.primary, "pct", "utilization", "usedPercent", "used_percent");
  const sevenDay = pick(raw.sevenDay ?? raw.seven_day ?? raw.secondary, "pct", "utilization", "usedPercent", "used_percent");
  return fiveHour || sevenDay ? { fiveHour, sevenDay } : null;
}

const RING_SIZE = 13;
const RING_STROKE = 1.65;
const RING_PATHS = new Map();
function ringArcPath(pct) {
  const key = Math.max(0, Math.min(100, Math.round(pct)));
  let cached = RING_PATHS.get(key);
  if (cached !== undefined) return cached;
  const c = RING_SIZE / 2;
  const r = c - RING_STROKE / 2 - 0.9;
  const top = c - r;
  if (key === 100) {
    cached = PathBuilder.stroke(RING_STROKE)
      .move_to(c, top)
      .arc_to(r, r, 0, false, true, c, c + r)
      .arc_to(r, r, 0, false, true, c, top)
      .build();
  } else if (key === 0) {
    cached = null;
  } else {
    const a = (key / 100) * 2 * Math.PI - Math.PI / 2;
    const tx = Number((c + r * Math.cos(a)).toFixed(3));
    const ty = Number((c + r * Math.sin(a)).toFixed(3));
    cached = PathBuilder.stroke(RING_STROKE)
      .move_to(c, top)
      .arc_to(r, r, 0, key > 50, true, tx, ty)
      .build();
  }
  RING_PATHS.set(key, cached);
  return cached;
}

function ringIcon(pct, color, trackColor) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  if (typeof PathBuilder === "undefined" || typeof window === "undefined" || typeof window?.paint_path !== "function") {
    return div().size(RING_SIZE).flex_none().rounded_full().border_1().border_color(color);
  }
  const track = ringArcPath(100);
  const arc = clamped > 0 ? ringArcPath(clamped) : null;
  return div().relative().size(RING_SIZE).flex_none()
    .child(window.paint_path(track, trackColor).absolute().inset_0())
    .when(Boolean(arc), (el) => el.child(window.paint_path(arc, color).absolute().inset_0()));
}

// Hints a terminal shows while one of its pickers or panels is open.
const DIALOG = /(esc to (cancel|close|exit|go back|dismiss)|enter to (select|confirm|continue|save|apply)|to navigate|↑\/↓|↑↓|(?<!shift\+)tab to switch|space to (toggle|select)|press esc|esc back|enter continue|\besc close\b)/i;

// Code blocks a shell can run as they are: ▶ runs these in a console beside the chat.
const SHELL_LANGS = new Set(["", "sh", "bash", "zsh", "fish", "shell", "console", "shell-session", "terminal", "powershell", "pwsh", "ps1", "ps", "cmd", "bat", "batch", "nu"]);

// The commands in a shell block, without the "$ " prompts a session transcript shows.
function shellCommands(code) {
  const lines = code.split("\n");
  const prompted = lines.filter((l) => /^\s*[$%>]\s/.test(l));
  // A transcript (prompts and output): only the prompted lines are commands.
  return (prompted.length ? prompted.map((l) => l.replace(/^\s*[$%>]\s/, "")) : lines).join("\n").trim();
}

// A reply cut into markdown and fenced code blocks: [{ md } | { code, lang, fence }].
// Fences may be indented (a block inside a list item); its lines lose that indent.
function splitCode(text) {
  const lines = text.split("\n");
  const out = [];
  let md = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s{0,6})(`{3,}|~{3,})\s*([\w+.-]*)\s*$/.exec(lines[i]);
    if (!open) { md.push(lines[i]); continue; }
    const [, indent, fence, lang] = open;
    let j = i + 1;
    while (j < lines.length && !new RegExp(`^\\s{0,6}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(lines[j])) j++;
    if (j >= lines.length) { md.push(lines[i]); continue; }
    if (md.join("").trim()) out.push({ md: md.join("\n") });
    md = [];
    const code = lines.slice(i + 1, j).map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.trimStart())).join("\n");
    out.push({ code, lang, fence });
    i = j;
  }
  if (md.join("").trim() || !out.length) out.push({ md: md.join("\n") });
  return out;
}

// A Codex rollout file's thread id.
const threadOf = (file) => /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(file ?? "")?.[1] ?? null;

const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

export default class Chat extends View {
  init(_props, cx) {
    // The agent comes in props; localStorage is shared by copies with equal props.
    const p = props() ?? {};
    this.dialog = Boolean(p.overlay);
    this.presentation = Boolean(p.presentation);
    this.terminalId = this.dialog ? null : localId(p.terminal);
    this.owner = { terminal: p.terminal, owner_tab: p.owner_tab, owner_pane: p.owner_pane };
    this.started = Boolean(p.started);
    // What the New chat form launched with; Claude doesn't log its effort.
    if (p.model || p.effort) this.chosen = { model: p.model, effort: p.effort, logged: null };
    if (shared("chat.bind")) setShared("chat.bind", null); // left by an earlier version
    this.gen = 0;
    this.t = null;
    this.activeTail = null;
    this.codexHandoff = new CodexHandoff();
    this.tracer = new HandoffTracer({
      dir: () => `${appHome()}/traces`,
      getId: () => this.terminalId || localId(this.term) || "chat",
      isEnabled: () => Boolean(shared("chat.trace")) || localStorage.getItem("chat.trace") === "1",
    });
    this.limit = PAGE;
    this.open = new Set();
    this.images = {};
    this.attach = [];
    this.loadOutbox();
    this.pending = []; // sent, not yet in the log: { text, files, users } (users: user messages the log had then)
    this.off = 0;
    this.viewH = 0;
    this.contentH = 0;
    this.width = 600;
    this.ticks = 0;
    this.screenSeq = 0;
    this.catalogs = {};
    this.cmds = null; // the / menu's commands for this agent and folder
    // The side chat (/btw): questions about the conversation, answered by a
    // read-only fork of it, so the agent is never interrupted.
    this.side = { open: false, items: [], off: 0, viewH: 0, contentH: 0 };
    this.menuSel = 0;
    const machine = p.machine !== undefined ? p.machine || null : this.dialog ? activeSpace()?.machine || null : null;
    this.cfg = { kind: shared("chat.kind") ?? "claude", machine,
      folder: this.dialog ? p.folder ?? this.defaultFolder(machine) : null, model: null, effort: null };

    this.drafts = {};
    this.historyIdx = null;
    this.historyDraft = "";
    this.input = TextareaState.new({ placeholder: this.dialog ? "What should the agent do? (optional)" : "Ask anything · / for commands" });
    this.input.set_auto_grow(1, 10);
    this.input.on("submit", (e, cx) => { if (!e?.shift) this.send(cx); });
    this.input.on("paste_other", (_e, cx) => this.pasteImage(cx));
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.input.on("change", (_e, cx) => {
      if (!this.settingHistory) this.historyIdx = null;
      this.emojifyInput();
      this.updateEmoji(cx);
      this.updateMention(cx);
      cx.notify();
    });
    if (!this.presentation || this.chatVisible()) this.input.focus();
    this.promptInput = InputState.new({ placeholder: "Type a custom reply and press Enter…" });
    this.promptInput.on("submit", (_e, cx) => {
      const value = this.promptInput.value().trim();
      if (!value) return;
      this.promptInput.set_value("");
      this.submitCustomPrompt(value, cx);
    });
    this.search = InputState.new({ placeholder: "Search this conversation" });
    this.search.on("change", (_e, cx) => { this.off = 0; cx.notify(); });
    this.sideInput = TextareaState.new({ placeholder: "Ask about this conversation…" });
    this.sideInput.set_auto_grow(1, 6);
    this.sideInput.on("submit", (e, cx) => {
      if (e?.shift) return;
      const q = this.sideInput.value().trim();
      this.sideInput.set_value("");
      this.askSideQ(q, cx);
    });
    // The message box keeps ↑/↓ for itself; while the / menu is open (its
    // wrapper is then "ChatMenu") they move the menu's highlight instead.
    try {
      if (this.presentation) {
        const blocked = keys().filter((binding) =>
          /^(pane\.(split|close|zoom|go|swap)|terminal\.(open|keep|park))(?::|$)/.test(binding.action));
        cx.bind_keys(blocked.map((binding) => ({ keystroke: binding.keys, action: "chat_no_split", context: "ChatPresentation" })));
      }
      cx.bind_keys([
        { keystroke: "up", action: "chat_menu_up", context: "ChatMenu > Input" },
        { keystroke: "down", action: "chat_menu_down", context: "ChatMenu > Input" },
        { keystroke: "up", action: "chat_menu_up", context: "ChatMenuNav > Input" },
        { keystroke: "down", action: "chat_menu_down", context: "ChatMenuNav > Input" },
        { keystroke: "left", action: "chat_menu_left", context: "ChatMenuNav > Input" },
        { keystroke: "right", action: "chat_menu_right", context: "ChatMenuNav > Input" },
        { keystroke: MAC ? "cmd-;" : "ctrl-;", action: "chat_side_toggle", context: "ChatRoot" },
        { keystroke: MAC ? "cmd-f" : "ctrl-f", action: "chat_search", context: "ChatRoot" },
        { keystroke: "escape", action: "chat_search_close", context: "ChatSearch" },
        { keystroke: "escape", action: "chat_menu_escape", context: "ChatPanel > Input" },
        { keystroke: "escape", action: "chat_menu_escape", context: "ChatMenu > Input" },
        { keystroke: "escape", action: "chat_menu_escape", context: "ChatMenuNav > Input" },
        { keystroke: "up", action: "chat_menu_up", context: "ChatPanel > Input" },
        { keystroke: "down", action: "chat_menu_down", context: "ChatPanel > Input" },
        { keystroke: "left", action: "chat_menu_left", context: "ChatPanel > Input" },
        { keystroke: "right", action: "chat_menu_right", context: "ChatPanel > Input" },
      ]);
    } catch {}

    cx.spawn(async (cx) => {
      await fs.mkdir(`${appHome()}/${CACHE}`, { recursive: true }).catch(() => {});
      await exec("find", [`${appHome()}/${CACHE}`, "-mtime", "+7", "-type", "f", "-delete"]).catch(() => {});
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (!this.chatVisible()) continue;
        if (c === "focus") this.input.focus();
        if (c === "search") this.openSearch(cx);
        cx.notify();
      }
    });
    if (this.dialog) this.loadCatalog(this.cfg.kind, this.cfg.machine, cx);
    cx.timer.every(2000, (cx) => this.check(cx));
    this.check(cx);
  }

  get term() {
    return qualifyAddress(this.terminalId, this.myPane()?.tab);
  }

  terminal() {
    const address = this.term;
    return address ? terminals().find((x) => x.address === address) ?? null : null;
  }

  label(name) {
    return qualifyAddress(this.terminal()?.labels?.[`herdr.${name}`], this.myPane()?.tab);
  }

  myPane() {
    return this.presentation ? presentationPane(this.owner ?? {}, panes()) : ownerPane(this.owner ?? {}, panes());
  }

  // Hidden copies stay alive in Herdr. Do not rebuild their transcript or
  // scrape a terminal while its TUI (or another tab) is on screen.
  chatVisible() {
    if (this.dialog) return true;
    const mine = this.myPane();
    if (!mine) return false;
    if (this.presentation && !presentationVisible(layout(), this.owner)) return false;
    const active = spaces().find((space) => space.active)?.tabs?.find((tab) => tab.active);
    if (active?.id !== mine.tab) return false;
    if (this.presentation) return true;
    return !panes().some((pane) => pane.tab === mine.tab && pane.zoomed && pane.pane !== mine.pane);
  }

  // Whether the agent's terminal is out of sight: in a tab of its own, or behind the zoomed chat.
  termHidden(mine) {
    return away(this.terminal()) || (mine.zoomed && panes().some((p) => p.terminal === this.term && p.tab === mine.tab));
  }

  // The agent's terminal has ended (its pane was closed, or it was killed).
  // Nothing closes by itself: the chat says so and offers Close chat, since
  // terminals() can briefly miss a terminal that's still running.
  ended(term) {
    if (this.dialog || !this.term || term?.state === "live") return false;
    const m = machineOf(this.term);
    return terminals().length > 0 && (!m || machines().find((x) => x.name === m)?.layout === "ready");
  }

  closeChat() {
    if (this.presentation) return showTerminal(this.myPane());
    const own = panes().find((p) => p.pane === this.pane && p.mod === "chat") ?? panes().find((p) => p.mod === "chat" && p.focused);
    if (!own) return;
    if (panes().some((p) => p.tab === own.tab && p.pane !== own.pane)) run("pane.close", { pane: own.pane });
    else run("tab.close", { id: own.tab, confirmed: true });
  }

  // The agent's commands, once per agent and folder; the last list shows at
  // once while Claude is asked again (it takes a few seconds).
  loadCmds(term, kind, cx) {
    const folder = term?.foreground?.cwd ?? term?.cwd ?? null;
    const key = kind && folder ? `${kind}|${machineOf(this.term) ?? ""}|${folder}` : null;
    if (!key || key === this.cmdKey) return;
    this.cmdKey = key;
    try { ({ list: this.cmds, models: this.models, account: this.account, version: this.version } = JSON.parse(localStorage.getItem(`cmds2:${key}`) ?? "{}")); } catch { this.cmds = null; }
    cx.spawn(async (cx) => {
      try {
        const got = await loadCommands(kind, folder, machineOf(this.term));
        if (this.cmdKey !== key || !got.list.length) return;
        this.cmds = got.list;
        this.models = got.models;
        this.account = got.account;
        this.version = got.version;
        try { localStorage.setItem(`cmds2:${key}`, JSON.stringify(got)); } catch {}
        cx.notify();
      } catch {}
    });
  }

  // Fetches 5h / 7d rate limits for Claude and Codex in the background so the
  // composer footer stays updated without waiting for /usage.
  loadUsageLimits(term, kind, cx, force = false) {
    const folder = term?.foreground?.cwd ?? term?.cwd ?? null;
    const key = kind && folder ? `${kind}|${machineOf(this.term) ?? ""}` : null;
    if (!key) { this.limitsKey = null; this.rateLimits = null; return; }
    if (key !== this.limitsKey) {
      this.limitsKey = key;
      this.limitsAt = 0;
      this.limitsEpoch = 0;
      this.limitsLoading = false;
      try { this.rateLimits = normalizeRateLimits(JSON.parse(localStorage.getItem(`limits1:${key}`) ?? "null")); } catch { this.rateLimits = null; }
    }
    if (kind === "codex" && this.t?.limits) {
      const live = normalizeRateLimits(this.t.limits);
      if (live) {
        this.rateLimits = live;
        try { localStorage.setItem(`limits1:${key}`, JSON.stringify(live)); } catch {}
        if (!force) return;
      }
    }
    const st = this.t?.turnState ?? this.t?.codexTurn;
    const doneEpoch = (st?.stage === "completed" || st?.stage === "idle") ? (st.epoch ?? 0) : 0;
    const stale = !this.limitsAt || Date.now() - this.limitsAt > 180000;
    const turnDone = doneEpoch > 0 && doneEpoch !== this.limitsEpoch;
    if (!force && !stale && !turnDone) return;
    if (this.limitsLoading) return;
    this.limitsLoading = true;
    this.limitsAt = Date.now();
    if (doneEpoch > 0) this.limitsEpoch = doneEpoch;
    cx.spawn(async (cx) => {
      try {
        let raw = null;
        if (kind === "codex") {
          const [limits] = await codexCalls(folder, [["account/rateLimits/read", null]], machineOf(this.term)).catch(() => [null]);
          raw = limits?.rateLimits ?? null;
        } else if (kind === "claude") {
          const [u] = await control(folder, null, [{ subtype: "get_usage" }], { on: machineOf(this.term), timeout: 25 }).catch(() => [null]);
          raw = u?.rate_limits ?? null;
        }
        const norm = normalizeRateLimits(raw);
        if (this.limitsKey === key && norm) {
          this.rateLimits = norm;
          try { localStorage.setItem(`limits1:${key}`, JSON.stringify(norm)); } catch {}
          cx.notify();
        }
      } catch {}
      finally {
        if (this.limitsKey === key) this.limitsLoading = false;
      }
    });
  }

  ensureFollow(kind, cx, graceMs = 1500) {
    if (!kind || !this.chatVisible() || !this.term) return;
    if (kind !== "codex" && kind !== "claude") {
      if (!this.streamLoop && this.terminal()?.status === "working") this.follow(kind, cx);
      return;
    }
    if (this.streamLoop) {
      if (!this.streamLoop.exiting) {
        if (this.streamLoop.kind === kind && graceMs > 0) {
          const until = Date.now() + graceMs;
          if (until > (this.streamLoop.graceUntil ?? 0)) this.streamLoop.graceUntil = until;
        }
        return;
      }
      if (this.codexHandoff?.draining) this.codexHandoff.endDrain();
    }
    this.follow(kind, cx, graceMs);
  }

  codexMinCompletedEpoch() {
    const st = this.t?.turnState ?? this.t?.codexTurn;
    if (!st) return 1;
    const epoch = st.epoch ?? 0;
    if (st.stage === "completed" || st.stage === "idle") return epoch + 1;
    return Math.max(1, epoch);
  }

  beforeCodexPending() {
    const kind = this.t?.kind ?? agentKind(this.terminal());
    if (kind !== "codex" && kind !== "claude") return;
    (this.codexHandoff ??= typeof CodexHandoff === "function" ? new CodexHandoff() : null)?.noteUserSend(this.t?.turnState ?? this.t?.codexTurn ?? null);
    this.stream = null;
    this.running = null;
  }

  afterCodexPending(cx, context, item) {
    const kind = this.t?.kind ?? agentKind(this.terminal());
    if (kind !== "codex" && kind !== "claude") return;
    this.tracer?.record("outbox_claim", {
      id: item?.id ?? null,
      direct: Boolean(item?.direct),
      status: context?.status ?? null,
      len: item?.text?.length ?? 0,
    });
    if ((Object.hasOwn(this, "chatVisible") || typeof ownerPane === "function") && this.chatVisible()) {
      this.ensureFollow(kind, cx, 1800);
    }
  }

  beforeCodexDirectSend(text) {
    const kind = this.t?.kind ?? agentKind(this.terminal());
    if (kind !== "codex" && kind !== "claude") return;
    if (!/^[\/!]/.test(text)) (this.codexHandoff ??= typeof CodexHandoff === "function" ? new CodexHandoff() : null)?.noteUserSend(this.t?.turnState ?? this.t?.codexTurn ?? null);
    this.tracer?.record("send", { direct: true, command: /^[\/!]/.test(text), len: text.length });
  }

  afterCodexDirectSend(text, cx) {
    const kind = this.t?.kind ?? agentKind(this.terminal());
    if (kind !== "codex" && kind !== "claude") return;
    if (!/^[\/!]/.test(text) && (Object.hasOwn(this, "chatVisible") || typeof ownerPane === "function") && this.chatVisible()) {
      this.ensureFollow(kind, cx, 1800);
    }
  }

  // While the agent works: the reply it's writing, read off its terminal a few
  // times a second, until the log has it.
  follow(kind, cx, graceMs = 0) {
    if (kind !== "codex" && kind !== "claude") {
      const loop = (this.streamLoop = {});
      cx.spawn(async (cx) => {
        while (this.streamLoop === loop && this.terminal()?.status === "working" && this.chatVisible()) {
          const r = await hc(["read", this.term, "--lines", "80"]).catch(() => null);
          if (this.streamLoop !== loop || !this.chatVisible()) break;
          const now = r ? live(r.stdout, kind) : null;
          const text = now?.kind === "text" ? now.text : null;
          const fresh = text && !this.logged(text);
          const run = now?.kind === "run" ? now : fresh ? null : this.running;
          if (text !== this.stream || JSON.stringify(run) !== JSON.stringify(this.running)) { this.stream = text; this.running = run; cx.notify(); }
          await sleep(cx, 350);
        }
        if (this.streamLoop === loop) {
          this.streamLoop = null;
          this.stream = null;
          this.running = null;
          if (this.chatVisible()) cx.notify();
        }
      });
      return;
    }

    const turnState = () => this.t?.turnState ?? this.t?.codexTurn ?? null;
    const loop = (this.streamLoop = { kind, exiting: false, graceUntil: graceMs > 0 ? Date.now() + graceMs : 0 });
    cx.spawn(async (cx) => {
      if (this.chatVisible()) {
        this.tracer?.record("follow_start", {
          graceMs,
          status: this.terminal()?.status ?? null,
          stage: turnState()?.stage ?? null,
        });
      }
      const handoffOpts = () => ({
        codexTurn: turnState(),
        pendingCount: this.pending?.length ?? 0,
        termStatus: this.terminal()?.status ?? null,
        hasPriorAssistant: (this.t?.entries ?? []).some((e) => e.kind === "assistant"),
      });
      let lastTailPokeAt = 0;
      while (
        this.streamLoop === loop &&
        this.chatVisible() &&
        (this.terminal()?.status === "working" || Date.now() < loop.graceUntil)
      ) {
        if (this.terminal()?.status === "working") loop.graceUntil = 0;
        if (this.pending?.length > 0 && Date.now() - lastTailPokeAt >= 900) {
          lastTailPokeAt = Date.now();
          await this.readTailOnce(cx);
          if (this.streamLoop !== loop || !this.chatVisible()) break;
        }
        const r = await hc(["read", this.term, "--lines", "80"]).catch(() => null);
        if (this.streamLoop !== loop || !this.chatVisible()) break;
        const handoff = (this.codexHandoff ??= typeof CodexHandoff === "function" ? new CodexHandoff() : null);
        const snap = r ? liveSnapshot(r.stdout, kind) : null;
        if (!handoff) { await sleep(cx, 350); continue; }
        let res = handoff.update(snap, handoffOpts());
        this.tracer?.record("follow_frame", {
          sig: `${res.reason}|${res.shouldDrainBeforeDrop}|${snap?.item?.kind ?? "none"}|${snap?.blockOrdinal ?? 0}|${snap?.workedAfterAt ?? false}|${snap?.statusAfterAt ?? false}|${turnState()?.stage ?? "none"}|${res.streamText?.length ?? 0}`,
          reason: res.reason,
          shouldDrain: res.shouldDrainBeforeDrop,
          itemKind: snap?.item?.kind ?? null,
          blockOrdinal: snap?.blockOrdinal ?? 0,
          workedAfterAt: Boolean(snap?.workedAfterAt),
          statusAfterAt: Boolean(snap?.statusAfterAt),
          stage: turnState()?.stage ?? null,
          streamLen: res.streamText?.length ?? 0,
        });
        if (res.shouldDrainBeforeDrop) {
          this.tracer?.record("follow_drain", { phase: "mid_turn", stage: turnState()?.stage ?? null });
          handoff.beginDrain();
          await this.flushTail(cx);
          if (snap?.workedAfterAt && !machineOf(this.term) && this.streamLoop === loop && this.chatVisible() && handoff.visibleStream(turnState())) {
            await sleep(cx, 100);
            if (this.streamLoop === loop && this.chatVisible()) await this.flushTail(cx);
          }
          if (this.streamLoop !== loop || !this.chatVisible()) {
            handoff.endDrain();
            break;
          }
          handoff.endDrain({ keepRun: true });
          res = handoff.update(snap, handoffOpts());
        }
        const nextStream = handoff.visibleStream(turnState());
        const nextRun = res.running;
        if (nextStream !== this.stream || JSON.stringify(nextRun) !== JSON.stringify(this.running)) {
          this.stream = nextStream;
          this.running = nextRun;
          cx.notify();
        }
        await sleep(cx, 350);
      }
      if (this.streamLoop === loop) {
        loop.exiting = true;
        const st = turnState();
        const stillVisible = this.codexHandoff?.visibleStream(st);
        const needsTailDrain =
          Boolean(stillVisible) ||
          Boolean(this.pending?.length) ||
          st?.stage === "awaiting_text";
        if (needsTailDrain) {
          this.tracer?.record("follow_drain", { phase: "exit", stage: turnState()?.stage ?? null });
          this.codexHandoff?.beginDrain();
          await this.flushTail(cx);
          if (!machineOf(this.term) && (this.pending?.length || turnState()?.stage === "awaiting_text")) {
            await sleep(cx, 120);
            if (this.streamLoop === loop) await this.flushTail(cx);
          }
        }
        if (this.streamLoop === loop) {
          this.codexHandoff?.finishFollow();
          this.tracer?.record("follow_exit", {
            stage: turnState()?.stage ?? null,
            hadStream: Boolean(stillVisible),
          });
          this.streamLoop = null;
          this.stream = null;
          this.running = null;
          if (this.chatVisible()) cx.notify();
        }
      }
    });
  }

  // Copies text and shows a ✓ on the button `id` for a moment.
  copyOut(text, id, cx) {
    cx.spawn(async (cx) => {
      if (!(await copyText(text))) return notify({ title: "No clipboard tool", body: "Install wl-clipboard or xclip to copy", level: "warning", timeout: 4000 });
      this.copied = id;
      cx.notify();
      await exec("sh", ["-c", "sleep 1.5"]);
      if (this.copied === id) { this.copied = null; cx.notify(); }
    });
  }

  hover(key) {
    return (on, cx) => {
      if (on && this.hovered !== key) { this.hovered = key; cx.notify(); }
      else if (!on && this.hovered === key) { this.hovered = null; cx.notify(); }
    };
  }

  tinyButton(id, icon, tip, action, t) {
    return div().id(id).flex_none().size(24).flex().items_center().justify_center().rounded(6).cursor_pointer()
      .bg(t.background).border_1().border_color(t.border).text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action)
      .child(svg(`mods/chat/icons/${icon}.svg`).size(12));
  }

  // A terminal beside the chat that isn't its agent (a shell split next to it):
  // the one focused last, else the first. Shell code blocks run there.
  shellPane() {
    const mine = this.myPane();
    if (!mine) return null;
    const shells = panes().filter((p) => p.tab === mine.tab && p.terminal && p.terminal !== this.term && !p.program?.agent && !p.status);
    const focused = shells.find((p) => p.focused);
    if (focused) this.lastConsole = focused.terminal;
    return shells.find((p) => p.terminal === this.lastConsole) ?? shells[0] ?? null;
  }

  // Runs a code block in the console: pasted and entered, like typing it there.
  runInConsole(con, code, id, cx) {
    this.ran = id;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await hc(["send", con.terminal, shellCommands(code)]);
      if (r.code !== 0) this.error = `Couldn't run it in ${con.terminal}: ${r.stderr.trim() || "hc send failed"}`;
      await exec("sh", ["-c", "sleep 1.5"]);
      if (this.ran === id) this.ran = null;
      cx.notify();
    });
  }

  // A reply: its markdown, with each code block drawn on its own so it gets
  // a Copy button and a Play button: shell code runs in a console beside the
  // chat when one is open; otherwise Play puts the code in the message box.
  reply(e, t) {
    const parts = splitCode(e.text ?? "").flatMap(part => part.md != null ? splitMarkdownTables(part.md) : [part]);
    if (parts.length === 1 && parts[0].md != null) return div().w_full().child(this.markdown(e.key, e.text));
    return v_flex().w_full().gap(8).children(parts.map((p, n) => {
      if (p.md != null) return div().w_full().child(this.markdown(`${e.key}-${n}`, p.md));
      if (p.table) return this.markdownTable(`${e.key}-${n}`, p.table, t);
      const id = `${e.key}-${n}`;
      const done = this.copied === id;
      const con = SHELL_LANGS.has(p.lang.toLowerCase()) ? this.shellPane() : null;
      const conName = con && ((con.program?.shell && con.program.name) || con.title || con.terminal);
      const btn = (name, icon, tip, action) => div().id(`${name}-${id}`).size(26).flex().items_center().justify_center().rounded(6)
        .cursor_pointer().bg(t.background).border_1().border_color(t.border).text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action)
        .child(svg(`mods/chat/icons/${icon}.svg`).size(13));
      return div().w_full().relative()
        .child(this.markdown(id, `${p.fence}\n${p.code}\n${p.fence}`))
        .child(h_flex().absolute().top(5).right(6).gap(4).items_center().px(6).py(2).rounded(6).bg(t.popover).border(0.5).border_color(t.border)
          .when(Boolean(p.lang), (el) => el.child(div().pr(4).text_size(11).text_color(t.dim).child(p.lang)))
          .child(btn("copy", done ? "check" : "copy", done ? "Copied" : "Copy", (_e, cx) => this.copyOut(p.code, id, cx)))
          .child(con
            ? btn("play", this.ran === id ? "check" : "play", this.ran === id ? `Sent to ${conName}` : `Run in ${conName} (${con.terminal})`, (_e, cx) => this.runInConsole(con, p.code, id, cx))
            : btn("play", "play", "Put in the message box", (_e, cx) => {
              this.input.set_value("");
              this.input.replace(p.code);
              this.input.focus();
              cx.notify();
            })));
    }));
  }

  markdownTable(id, table, t) {
    const stroke = settings().dark ? 1 : 0.5;
    return v_flex().w_full().rounded(10).overflow_hidden().border(stroke).border_color(t.border)
      .children(table.rows.map((row, rowIndex) => h_flex().w_full()
        .bg(rowIndex === 0 ? t.surface : t.background)
        .when(rowIndex === 0, el => el.rounded_t(9))
        .when(rowIndex === table.rows.length - 1, el => el.rounded_b(9))
        .when(rowIndex > 0, el => el.border_t(stroke).border_color(t.border))
        .children(row.map((cell, column) => div().flex_1().min_w(0).px(12).py(8).text_size(13)
          .when(column > 0, el => el.border_l(stroke).border_color(t.border))
          .when(rowIndex === 0, el => el.font_semibold())
          .when(table.align[column] === "right", el => el.text_right())
          .when(table.align[column] === "center", el => el.text_center())
          .child(this.markdown(`${id}-${rowIndex}-${column}`, cell || " "))))));
  }

  // The command or tool running now, with its output so far, as the terminal
  // shows it.
  runningView(t) {
    const r = this.running;
    const mono = settings().font_family;
    // Always the same height, its lines never wrapping: the page doesn't move.
    const LINES = 6, LH = 17;
    const out = r.out.slice(-LINES);
    return v_flex().w_full().gap(6).px(12).py(9).rounded(10).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().h(20).gap(8).items_center()
        .child(div().flex_none().text_color(t.working).frames(SPINNER, 90))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_medium().when(Boolean(mono), (d) => d.font_family(mono)).child(r.title))
        .when(Boolean(r.time), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(r.time))))
      .child(v_flex().h(LINES * LH + 12).px(10).py(6).rounded(6).bg(t.background).overflow_hidden().justify_end()
        .text_size(11.5).text_color(t.muted).when(Boolean(mono), (d) => d.font_family(mono))
        .children(out.map((l) => div().h(LH).flex_none().truncate().child(l || " "))));
  }

  // Whether the log already has this reply text (in this turn).
  logged(text) {
    const norm = (x) => (x ?? "").replace(/[\s*_`#>]+/g, " ").trim();
    // The start or the end: a long reply can be partly off the terminal's screen.
    const n = norm(text), head = n.slice(0, 80), tail = n.slice(-80);
    const ents = this.t?.entries ?? [];
    for (let i = ents.length - 1; i >= 0 && ents[i].kind !== "user"; i--) {
      if (ents[i].kind !== "assistant") continue;
      const e = norm(ents[i].text);
      if (e.includes(head) || e.includes(tail)) return true;
    }
    return false;
  }

  // The streamed reply, unless the log already has it.
  streamShown() {
    const kind = this.t?.kind ?? agentKind(this.terminal());
    if ((kind === "codex" || kind === "claude") && this.codexHandoff) {
      return this.codexHandoff.visibleStream(this.t?.turnState ?? this.t?.codexTurn) ?? null;
    }
    return this.stream && !this.logged(this.stream) ? this.stream : null;
  }

  // How often each command was sent here: the menu puts those first.
  get usage() {
    if (!this._usage) { try { this._usage = JSON.parse(localStorage.getItem("cmdUsage") ?? "{}"); } catch { this._usage = {}; } }
    return this._usage;
  }

  used(name) {
    this.usage[name] = (this.usage[name] ?? 0) + 1;
    try { localStorage.setItem("cmdUsage", JSON.stringify(this.usage)); } catch {}
  }

  // The / menu while a command is typed, as the Claude app draws it. With
  // nothing typed after the /: your top skills, then submenus for all skills,
  // the model and all commands. With a word: every command that matches.
  slash() {
    if (this.dialog || !this.cmds) return null;
    // Enter's line break lands in the box (where the cursor is) before the
    // submit that reads it; a command name has none.
    const v = this.input.value().replace(/\n/g, "");
    const m = /^\/(\S*)$/.exec(v);
    if (!m || this.menuClosed === v) return null;
    if (v !== this.menuFor) { this.menuFor = v; this.menuSel = 0; if (m[1]) this.menuSub = null; }
    const cmd = (c) => ({ type: "cmd", c });
    let rows;
    if (m[1]) rows = matchCommands(this.cmds, m[1], this.usage).map(cmd);
    else {
      const skills = this.cmds.filter((c) => c.kind === "skill" || c.kind === "plugin");
      const others = this.cmds.filter((c) => c.kind !== "skill" && c.kind !== "plugin");
      if (this.menuSub === "skills") rows = [{ type: "back", label: "All skills" }, ...skills.map(cmd)];
      else if (this.menuSub === "commands") rows = [{ type: "back", label: "All commands" }, ...others.map(cmd)];
      else if (this.menuSub === "model") rows = [{ type: "back", label: "Model" }, ...(this.models ?? []).map((md) => ({ type: "model", m: md }))];
      else if (this.menuSub === "resume") rows = [{ type: "back", label: "Resume a conversation" },
        ...(this.sessions ?? []).map((x) => ({ type: "session", s: x }))];
      else if (this.menuSub === "permissions") rows = [{ type: "back", label: "Permission mode" }, ...modesOf(this.current().kind).map((x) => ({ type: "mode", mode: x }))];
      else {
        const top = [...skills].sort((x, y) => (this.usage[y.name] ?? 0) - (this.usage[x.name] ?? 0)).slice(0, 3);
        rows = [
          ...(skills.length ? [{ type: "header", label: "Skills" }, ...top.map(cmd)] : []),
          ...(skills.length > 3 ? [{ type: "sub", id: "skills", label: "All skills", icon: "scroll" }] : []),
          { type: "sep" },
          ...(this.models?.length ? [{ type: "sub", id: "model", label: "Model", icon: "model", detail: modelName(this.current().cat?.models, this.current().model) }] : []),
          { type: "sep" },
          { type: "sub", id: "commands", label: "All commands", icon: "terminal" },
        ];
      }
    }
    const pickable = rows.filter((r) => r.type !== "header" && r.type !== "sep" && r.type !== "back");
    if (!pickable.length && this.menuSub !== "resume") return null;
    this.menuSel = Math.min(this.menuSel, pickable.length - 1);
    return { rows, pickable, sel: this.menuSel, nav: !m[1] };
  }

  emojifyInput() {
    const v = this.input.value();
    if (emojify(v) === v) return;
    if (typeof this.input.set_selected_range === "function" && typeof this.input.replace === "function") {
      const tokenRanges = typeof this.input.tokens === "function" ? this.input.tokens().map((t) => t.range) : [];
      const hits = [];
      const re = /:([a-z0-9_+-]+):/g;
      let m;
      while ((m = re.exec(v))) {
        const next = emojify(m[0]);
        const start = m.index, end = start + m[0].length;
        if (next !== m[0] && !tokenRanges.some((r) => start < r.end && end > r.start)) hits.push({ start, end, next });
      }
      for (let i = hits.length - 1; i >= 0; i--) {
        this.input.set_selected_range({ start: hits[i].start, end: hits[i].end });
        this.input.replace(hits[i].next);
      }
    } else {
      this.input.set_value(emojify(v));
    }
  }

  replaceComposerTail(start, inserted) {
    if (typeof this.input.set_selected_range === "function" && typeof this.input.replace === "function") {
      this.input.set_selected_range({ start, end: this.input.value().length });
      this.input.replace(inserted);
    } else {
      const cur = this.input.value();
      this.input.set_value(cur.slice(0, start) + inserted);
    }
  }

  // The : menu, as in Slack: after a colon and two letters, the emoji whose
  // names match, to pick one in place of what's typed.
  updateEmoji(cx) {
    const v = this.input.value().replace(/\r?\n$/, "");
    const m = !this.dialog && !this.slash() && this.emojiClosed !== v ? /(^|\s):([a-z0-9_+\-]{2,})$/i.exec(v) : null;
    if (!m) { this.emoji = null; return; }
    if (this.emoji?.v === v) return;
    const start = m.index + m[1].length;
    cx.spawn(async (cx) => {
      const items = await emojiMatches(m[2], this.emojiUsage);
      if (this.input.value().replace(/\r?\n$/, "") !== v) return;
      this.emoji = items.length ? { v, start, query: m[2], items, sel: 0 } : null;
      cx.notify();
    });
  }

  emojiMenu() {
    const e = this.emoji;
    return e && e.v === this.input.value().replace(/\r?\n$/, "") ? e : null;
  }

  get emojiUsage() {
    if (!this._emojiUsage) { try { this._emojiUsage = JSON.parse(localStorage.getItem("emojiUsage") ?? "{}"); } catch { this._emojiUsage = {}; } }
    return this._emojiUsage;
  }

  pickEmoji(x, cx) {
    const e = this.emojiMenu();
    if (!e || !x) return;
    this.emojiUsage[x.char] = (this.emojiUsage[x.char] ?? 0) + 1;
    try { localStorage.setItem("emojiUsage", JSON.stringify(this.emojiUsage)); } catch {}
    this.emoji = null;
    this.replaceComposerTail(e.start, x.char + " ");
    this.input.focus();
    cx.notify();
  }

  // The @ menu, as in Claude and ChatGPT: after an @, the files and folders
  // of the agent's project whose paths match, to mention one by its path.
  updateMention(cx) {
    const v = this.input.value().replace(/\r?\n$/, "");
    const m = !this.dialog && !this.slash() && this.mentionClosed !== v ? /(^|\s)@([^\s@]*)$/.exec(v) : null;
    if (!m) { this.mention = null; return; }
    const term = this.terminal();
    const folder = term?.foreground?.cwd ?? term?.cwd;
    if (!folder) return;
    const start = m.index + m[1].length;
    const show = () => {
      const q = m[2].toLowerCase();
      const files = this.fileList?.paths ?? [];
      const score = (p) => {
        const l = p.toLowerCase(), base = l.split("/").filter(Boolean).pop() ?? l;
        return !q ? 0 : base.startsWith(q) ? 0 : base.includes(q) ? 1 : l.includes(q) ? 2 : 9;
      };
      const items = files.map((p) => [score(p), p]).filter(([sc]) => sc < 9).sort((a, b) => a[0] - b[0] || a[1].length - b[1].length || a[1].localeCompare(b[1])).slice(0, 50).map(([, p]) => p);
      this.mention = { v, start, query: m[2], items, sel: 0, loading: !this.fileList };
    };
    show();
    // The project's files: git's list (or a walk outside git), every 30 s at most.
    if (this.fileList?.folder !== folder || Date.now() - this.fileList.at > 30000) {
      if (this.listing) return;
      this.listing = true;
      cx.spawn(async (cx) => {
        const r = await exec("sh", ["-c", `cd "$1" 2>/dev/null || exit 0
          { git ls-files -co --exclude-standard 2>/dev/null || find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | sed 's|^./||'; } | head -20000`, "sh", folder], { on: machineOf(this.term) }).catch(() => ({ stdout: "" }));
        const files = r.stdout.split("\n").filter(Boolean);
        const dirs = new Set();
        for (const f of files) { const parts = f.split("/"); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/") + "/"); }
        this.fileList = { folder, at: Date.now(), paths: [...dirs, ...files] };
        this.listing = false;
        if (this.mention) this.updateMention(cx);
        cx.notify();
      });
    }
  }

  mentionMenu() {
    const e = this.mention;
    return e && e.v === this.input.value().replace(/\r?\n$/, "") && (e.items.length || e.loading) ? e : null;
  }

  pickMention(path, cx) {
    const e = this.mentionMenu();
    if (!e || !path) return;
    this.mention = null;
    this.replaceComposerTail(e.start, "@" + path + (path.endsWith("/") ? "" : " "));
    this.input.focus();
    cx.notify();
  }

  mentionView(t) {
    const e = this.mentionMenu();
    const ROWS = 8;
    const start = Math.max(0, Math.min(e.sel - Math.floor(ROWS / 2), e.items.length - ROWS));
    return h_flex().w_full().max_w(900).child(v_flex().id("mention-menu").w(520).p(6).gap(1).rounded(14).border_1().border_color(t.border).bg(t.popover).shadow_md()
      .child(div().px(10).pt(4).pb(4).text_size(11).font_semibold().text_color(t.dim).child(e.loading && !e.items.length ? "Looking for files…" : e.query ? `Files matching "${e.query}"` : "Files in this project"))
      .children(e.items.slice(start, start + ROWS).map((p, n) => {
        const i = start + n, dir = p.endsWith("/");
        const parts = p.replace(/\/$/, "").split("/"), base = parts.pop(), where = parts.join("/");
        return h_flex().id(`men-${i}`).px(10).py(5).gap(8).rounded(8).items_center().cursor_pointer()
          .bg(i === e.sel ? t.selected : t.popover)
          .on_hover((on, cx) => { if (on && e.sel !== i) { e.sel = i; cx.notify(); } })
          .on_mouse_down("left", (_ev, cx) => cx.stop_propagation())
          .on_click((_ev, cx) => this.pickMention(p, cx))
          .child(svg(`mods/files/${dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.dim))
          .child(div().flex_none().text_size(13).text_color(t.foreground).child(base + (dir ? "/" : "")))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(where));
      }))
      .child(div().px(10).pt(4).pb(2).text_size(11).text_color(t.dim).child("↑↓ choose · Tab or Enter pick · Esc close")));
  }

  emojiView(t) {
    const e = this.emojiMenu();
    const ROWS = 8;
    const start = Math.max(0, Math.min(e.sel - Math.floor(ROWS / 2), e.items.length - ROWS));
    return h_flex().w_full().max_w(900).child(v_flex().id("emoji-menu").w(380).p(6).gap(1).rounded(14).border_1().border_color(t.border).bg(t.popover).shadow_md()
      .child(div().px(10).pt(4).pb(4).text_size(11).font_semibold().text_color(t.dim).child(`Emoji matching ":${e.query}"`))
      .children(e.items.slice(start, start + ROWS).map((x, n) => {
        const i = start + n;
        return h_flex().id(`emo-${i}`).px(10).py(5).gap(10).rounded(8).items_center().cursor_pointer()
          .bg(i === e.sel ? t.selected : t.popover)
          .on_hover((on, cx) => { if (on && e.sel !== i) { e.sel = i; cx.notify(); } })
          .on_mouse_down("left", (_ev, cx) => cx.stop_propagation())
          .on_click((_ev, cx) => this.pickEmoji(x, cx))
          .child(div().w(24).flex_none().text_size(18).child(x.char))
          .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(i === e.sel ? t.foreground : t.muted).child(`:${x.name}:`));
      }))
      .child(div().px(10).pt(4).pb(2).text_size(11).text_color(t.dim).child("↑↓ choose · Tab or Enter pick · Esc close")));
  }

  // The panel takes the keys while the message box is empty.
  panelLive() {
    return Boolean(this.panel?.seen) && !this.input.value().replace(/\n/g, "").trim();
  }

  menuKey(e, cx) {
    const mm = this.mentionMenu();
    if (mm) {
      const k = e.keystroke;
      if ((k === "up" || k === "down" || k === "ctrl-p" || k === "ctrl-n") && mm.items.length) mm.sel = (mm.sel + (k === "up" || k === "ctrl-p" ? -1 : 1) + mm.items.length) % mm.items.length;
      else if (k === "tab" || k === "enter") return this.pickMention(mm.items[mm.sel], cx);
      else if (k === "escape") { this.mentionClosed = mm.v; this.mention = null; }
      else return;
      cx.stop_propagation();
      return cx.notify();
    }
    const em = this.emojiMenu();
    if (em) {
      const k = e.keystroke;
      if (k === "up" || k === "down" || k === "ctrl-p" || k === "ctrl-n") em.sel = (em.sel + (k === "up" || k === "ctrl-p" ? -1 : 1) + em.items.length) % em.items.length;
      else if (k === "tab" || k === "enter") return this.pickEmoji(em.items[em.sel], cx);
      else if (k === "escape") { this.emojiClosed = em.v; this.emoji = null; }
      else return;
      cx.stop_propagation();
      return cx.notify();
    }
    if (!this.slash() && this.panelLive()) {
      const map = { up: "up", down: "down", left: "left", right: "right", tab: "tab", escape: "esc" };
      if (map[e.keystroke]) { this.panelKeys(map[e.keystroke]); cx.stop_propagation(); return cx.notify(); }
    }
    const m = this.slash();
    if (!m) {
      const k = e.keystroke;
      if (!this.dialog && (k === "up" || k === "down")) {
        const val = this.input.value();
        if (!val.includes("\n")) {
          const hist = [];
          for (const en of this.t?.entries ?? []) {
            if (en.kind === "user" && !en.command && en.text?.trim() && hist.at(-1) !== en.text) hist.push(en.text);
          }
          if (k === "up" && hist.length) {
            if (this.historyIdx == null) { this.historyDraft = val; this.historyIdx = hist.length - 1; }
            else if (this.historyIdx > 0) this.historyIdx--;
            this.settingHistory = true;
            this.input.set_value(hist[this.historyIdx]);
            this.settingHistory = false;
            cx.stop_propagation();
            return cx.notify();
          }
          if (k === "down" && this.historyIdx != null) {
            this.settingHistory = true;
            if (this.historyIdx + 1 < hist.length) {
              this.historyIdx++;
              this.input.set_value(hist[this.historyIdx]);
            } else {
              this.historyIdx = null;
              this.input.set_value(this.historyDraft ?? "");
            }
            this.settingHistory = false;
            cx.stop_propagation();
            return cx.notify();
          }
        }
      }
      return;
    }
    const k = e.keystroke;
    if (k === "up" || k === "down" || k === "ctrl-p" || k === "ctrl-n") {
      const d = k === "up" || k === "ctrl-p" ? -1 : 1;
      this.menuSel = (m.sel + d + m.pickable.length) % m.pickable.length;
    } else if (k === "tab" || k === "enter") this.choose(m.pickable[m.sel], cx);
    else if (k === "right" && m.pickable[m.sel]?.type === "sub") this.choose(m.pickable[m.sel], cx);
    else if ((k === "left" || k === "escape") && this.menuSub) { this.menuSub = null; this.menuSel = 0; }
    else if (k === "escape") this.menuClosed = this.input.value().replace(/\n/g, "");
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // A pick from the menu. A command goes into the message box as a chip, to
  // add what it takes and send; it isn't sent yet, as in the Claude app.
  choose(row, cx) {
    if (!row) return;
    if (row.type === "sub") { this.menuSub = row.id; this.menuSel = 0; return cx.notify(); }
    if (row.type === "model") { this.input.set_value(""); this.menuSub = null; this.applyModel(row.m.id, null, cx); return cx.notify(); }
    if (row.type === "session") { this.input.set_value(""); this.menuSub = null; this.deliverCommand(`/resume ${row.s.id}`, cx); return cx.notify(); }
    if (row.type === "mode") { this.input.set_value(""); this.menuSub = null; this.setMode(row.mode, cx); return cx.notify(); }
    const c = row.c;
    this.menuSub = null;
    this.input.set_value("");
    this.input.replace_with_token({ id: `cmd:${c.name}`, text: `/${c.name}`, label: `/${c.label ?? c.name}` });
    this.input.replace(" ");
    this.input.focus();
    cx.notify();
  }

  // Commands the chat answers itself, as the Claude app does; false sends it on.
  hostCommand(cmd, args, cx) {
    const clear = () => { this.input.set_value(""); return true; };
    if (cmd.action === "model" && !args && this.models?.length) return this.openSub("model");
    if ((cmd.action === "model" || cmd.action === "effort") && !args) { this.showModels = true; return clear(); }
    if (cmd.action === "status" || cmd.action === "usage") { this.hostCard(cmd.action, cx); return clear(); }
    if (["memory", "hooks", "mcp", "skills", "plugins", "config"].includes(cmd.action) && !args) { this.infoCard(cmd.action, cx, cmd.name); return clear(); }
    if (cmd.action === "help") { this.openSub("commands"); return true; }
    if (cmd.action === "diff") {
      run("layout.select", { stack: "panel-body", child: "changes" });
      run("layout.show", { id: "panel" });
      return clear();
    }
    if (cmd.action === "copy") {
      const n = Number(args) || 1;
      const said = (this.t?.entries ?? []).filter((x) => x.kind === "assistant");
      const text = said[said.length - n]?.text;
      if (text) copyText(text).then((ok) => notify(ok ? { title: "Copied", body: n > 1 ? `Response ${n} from the end` : "Last response", timeout: 2000 }
        : { title: "No clipboard tool", body: "Install wl-clipboard or xclip to copy", level: "warning", timeout: 4000 }));
      else notify({ title: "Nothing to copy yet", timeout: 2000 });
      return clear();
    }
    if (cmd.action === "permissions" && !args && this.current().kind) {
      this.readMode(cx);
      return this.openSub("permissions");
    }
    if (cmd.action === "resume" && !args && this.current().kind) {
      this.sessions = null;
      const term = this.terminal(), mine = sessionOf(this.file) ?? threadOf(this.file);
      const folder = term?.foreground?.cwd ?? term?.cwd ?? "";
      cx.spawn(async (cx) => {
        const list = this.current().kind === "codex"
          ? ((await codexCalls(folder, [["thread/list", { cwd: folder, limit: 40, sourceKinds: ["cli", "vscode", "exec", "appServer"] }]], machineOf(this.term)).catch(() => [null]))[0]?.data ?? [])
            .map((x) => ({ id: x.id, title: (x.name ?? x.preview ?? "").split("\n")[0], at: (x.updatedAt ?? 0) * 1000 }))
          : await listSessions(folder, machineOf(this.term)).catch(() => []);
        this.sessions = list.filter((x) => x.id !== mine).map((x) => ({ ...x, when: ago(x.at) }));
        cx.notify();
      });
      return this.openSub("resume");
    }
    return false;
  }

  // Opens one of the / menu's submenus on its own: /model, /resume, /permissions.
  openSub(id) {
    this.input.set_value("/");
    this.input.set_selected_range({ start: 1, end: 1 });
    this.menuFor = "/";
    this.menuClosed = null;
    this.menuSub = id;
    this.menuSel = 0;
    this.input.focus();
    return true;
  }

  // A command typed for the agent on the user's behalf.
  deliverCommand(text, cx) {
    cx.spawn(async (cx) => this.deliver(text, [], cx));
  }

  // Claude Code shows its permission mode in its footer; Codex's is what the
  // log last said.
  readMode(cx) {
    if (this.current().kind !== "claude") return;
    cx.spawn(async (cx) => {
      const r = await hc(["read", this.term, "--lines", "3"]).catch(() => null);
      if (r) { this.mode = { id: modeOf(r.stdout), logged: this.t?.mode }; cx.notify(); }
    });
  }

  // Claude Code switches permission mode with shift+tab, in a cycle: press it
  // until the terminal's footer shows the mode picked. Codex picks one from its
  // /permissions list, by the number in front of it.
  setMode(mode, cx) {
    const kind = this.current().kind;
    this.mode = { id: mode.id, logged: this.t?.mode };
    cx.spawn(async (cx) => {
      if (kind === "codex") {
        await hc(["send", this.term, "/permissions"]);
        for (let i = 0; i < 15; i++) {
          await sleep(cx, 300);
          const lines = (await hc(["read", this.term, "--lines", "20"])).stdout.split("\n");
          const row = lines.map((l) => /^\s*(?:›\s*)?(\d)\.\s+(.*)$/.exec(l)).find((m) => m && mode.match.test(m[2]));
          if (row) { await hc(["keys", this.term, row[1]]); return cx.notify(); }
        }
        await hc(["keys", this.term, "esc"]);
        this.mode = null;
        notify({ title: `Codex didn't offer ${mode.label}`, body: "Pick it with /permissions in its terminal", level: "warning", timeout: 5000 });
        return cx.notify();
      }
      for (let i = 0; i < 6; i++) {
        const screen = (await hc(["read", this.term, "--lines", "3"])).stdout;
        if (modeOf(screen) === mode.id) break;
        await hc(["keys", this.term, "shift+tab"]);
        await sleep(cx, 350);
      }
      // Not every mode is in the cycle (bypass needs a flag at launch): say where it ended up.
      this.readMode(cx);
    });
  }

  // Opens a file to edit in a dialog (memory files, settings).
  editFile(file, title, on = null) {
    openOverlay({ mod: "chat-file", kind: "dialog", width: 820, height: 600, props: { file, title, on } });
  }

  // The cards for /memory, /hooks, /mcp, /skills, /plugin and /config: what
  // Claude or Codex reports, with what can be done about each.
  infoCard(what, cx, name = what) {
    if (!this.t) return;
    const { kind } = this.current();
    const TITLES = { memory: "Memory", hooks: "Hooks", mcp: "MCP servers", skills: "Skills", plugins: "Plugins", config: "Settings" };
    this.t.push({ kind: "user", command: true, ephemeral: true, text: `/${name}`, images: [] });
    const e = this.t.push({ kind: "card", card: "info", ephemeral: true, title: TITLES[what], loading: true, sections: [], buttons: [] });
    this.off = 0;
    const term = this.terminal();
    const folder = term?.foreground?.cwd ?? term?.cwd ?? "";
    const on = machineOf(this.term);
    const say = (text) => (_e, cx) => { this.deliverCommand(text, cx); this.openPanel(text, cx, true); cx.notify(); };
    const edit = (file, title) => () => this.editFile(file, title, on);
    const sizes = async (files) => {
      const r = await exec("sh", ["-c", 'for f; do [ -f "$f" ] && printf "%s\\t%s\\n" "$f" "$(wc -c < "$f" | tr -d " ")"; done; true', "sh", ...files], { on });
      return Object.fromEntries(r.stdout.split("\n").filter(Boolean).map((l) => l.split("\t")));
    };
    const kb = (n) => (n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} bytes`);
    cx.spawn(async (cx) => {
      try {
        const H = on ? ((await exec("sh", ["-c", 'printf "%s" "$HOME"'], { on }).catch(() => null))?.stdout || home()) : home();
        const ancestors = (f) => { const out = []; let d = f; while (d && d !== "/" && d.startsWith(H) && d !== H) { out.push(d); d = d.replace(/\/[^/]+$/, ""); } return out.reverse(); };
        if (what === "memory") {
          const files = kind === "codex"
            ? [[`${H}/.codex/AGENTS.md`, "Global"], ...ancestors(folder).flatMap((d) => [[`${d}/AGENTS.md`, d === folder ? "This project" : "Parent folder"], [`${d}/AGENTS.override.md`, "Override"]])]
            : [[`${H}/.claude/CLAUDE.md`, "Your memory"], ...ancestors(folder).flatMap((d) => [[`${d}/CLAUDE.md`, d === folder ? "This project" : "Parent folder"], [`${d}/.claude/CLAUDE.md`, "This project"], [`${d}/CLAUDE.local.md`, "Local (not shared)"]]),
              [`${H}/.claude/projects/${folder.replace(/[^A-Za-z0-9-]/g, "-")}/memory/MEMORY.md`, "Auto memory"]];
          const have = await sizes(files.map(([f]) => f));
          e.sections = [{ rows: files.filter(([f]) => have[f]).map(([f, label]) => ({ label, detail: f.replace(H, "~"), status: kb(Number(have[f])), actions: [["Open", edit(f, label)]] })) }];
          if (!e.sections[0].rows.length) e.note = "No memory files yet.";
          const main = `${folder}/${kind === "codex" ? "AGENTS.md" : "CLAUDE.md"}`;
          if (!have[main]) e.buttons.push(["New project memory", edit(main, "This project")]);
          if (kind === "codex") e.buttons.push(["Memory settings", say("/memories")]);
        } else if (what === "hooks") {
          let hooks = [];
          if (kind === "codex") hooks = ((await codexCalls(folder, [["hooks/list", {}]], on))[0]?.data ?? []).flatMap((x) => x.hooks ?? []);
          else hooks = (await control(folder, null, [{ subtype: "get_hooks_listing" }], { on }))[0]?.hooks ?? [];
          e.sections = [{ rows: hooks.map((h) => ({ label: [h.event ?? h.eventName ?? h.hookEventName, h.matcher].filter(Boolean).join(" · ") || "Hook",
            detail: h.command ?? h.hook?.command ?? h.prompt ?? JSON.stringify(h.hooks ?? h), status: h.source ?? h.scope ?? "" })) }];
          if (!hooks.length) e.note = "No hooks set up.";
          e.buttons.push(kind === "codex" ? ["Edit config.toml", edit(`${H}/.codex/config.toml`, "Codex settings")] : ["Edit your settings", edit(`${H}/.claude/settings.json`, "Claude Code settings")]);
          if (kind !== "codex") e.buttons.push(["Edit project settings", edit(`${folder}/.claude/settings.json`, "Project settings")]);
        } else if (what === "mcp") {
          if (kind === "codex") {
            const list = (await codexCalls(folder, [["mcpServerStatus/list", {}]], on))[0]?.data ?? [];
            e.sections = [{ rows: list.map((m) => ({ label: m.name, detail: `${Object.keys(m.tools ?? {}).length} tools${m.toolsError ? ` · ${m.toolsError}` : ""}`,
              status: m.authStatus === "notLoggedIn" ? "needs login" : m.runtimeStatus ?? "",
              actions: m.authStatus === "notLoggedIn" ? [["Log in", say(`/mcp login ${m.name}`)]] : [] })) }];
          } else {
            const list = (await control(folder, null, [{ subtype: "mcp_status" }], { on, delay: 5, timeout: 30 }))[0]?.mcpServers ?? [];
            e.sections = [{ rows: list.map((m) => ({ label: m.name, detail: [m.transport, m.scope, m.urlHost ?? m.config?.command].filter(Boolean).join(" · "),
              status: m.status, actions: [["Reconnect", say(`/mcp reconnect ${m.name}`)], m.status === "disabled" ? ["Enable", say(`/mcp enable ${m.name}`)] : ["Disable", say(`/mcp disable ${m.name}`)]] })) }];
          }
          if (!e.sections[0].rows.length) e.note = "No MCP servers.";
          e.buttons.push(["Open in terminal", say("/mcp")]);
        } else if (what === "skills") {
          const pick = (text) => (_e, cx) => { this.input.set_value(""); this.input.replace(text); this.input.focus(); cx.notify(); };
          if (kind === "codex") {
            const list = ((await codexCalls(folder, [["skills/list", {}]], on))[0]?.data ?? []).flatMap((x) => x.skills ?? []);
            e.sections = [{ rows: list.map((k) => ({ label: k.interface?.displayName ?? k.name, detail: k.interface?.shortDescription ?? k.description, run: pick(`$${k.name} `) })) }];
          } else {
            const list = (this.cmds ?? []).filter((c) => c.kind === "skill" || c.kind === "plugin");
            e.sections = [{ rows: list.map((c) => ({ label: `/${c.name}`, detail: c.desc, run: (_e, cx) => this.choose({ type: "cmd", c }, cx) })) }];
          }
          e.note = "Click one to start a message with it.";
        } else if (what === "plugins") {
          if (kind === "codex") {
            const m = (await codexCalls(folder, [["plugin/list", {}]], on))[0]?.marketplaces ?? [];
            e.sections = m.map((x) => ({ title: x.name, rows: (x.plugins ?? []).filter((q) => q.installed).map((q) => ({ label: q.interface?.displayName ?? q.name,
              detail: q.interface?.shortDescription ?? "", status: q.enabled ? "on" : "off" })) })).filter((x) => x.rows.length);
            e.buttons.push(["Browse plugins", say("/plugins")]);
          } else {
            const [st] = await control(folder, null, [{ subtype: "get_settings" }], { on });
            const raw = await exec("sh", ["-c", 'cat "$HOME/.claude/plugins/installed_plugins.json" 2>/dev/null'], { on });
            let installed = {};
            try { installed = JSON.parse(raw.stdout).plugins ?? {}; } catch {}
            const enabled = st?.effective?.enabledPlugins ?? {};
            e.sections = [{ rows: Object.entries(installed).map(([id, v]) => ({ label: id.split("@")[0], detail: `${id.split("@")[1] ?? ""}${v?.[0]?.version ? ` · ${v[0].version}` : ""}`,
              status: enabled[id] === false ? "off" : "on" })) }];
            e.buttons.push(["Browse plugins", say("/plugin")]);
          }
          if (!e.sections.some((x) => x.rows.length)) e.note = "No plugins installed.";
        } else if (what === "config") {
          const show = (v) => (typeof v === "object" ? JSON.stringify(v) : String(v));
          if (kind === "codex") {
            const c = (await codexCalls(folder, [["config/read", {}]], on))[0]?.config ?? {};
            e.sections = [{ rows: Object.entries(c).filter(([, v]) => v != null && !(typeof v === "object" && !Object.keys(v).length)).map(([k, v]) => ({ label: k, detail: show(v) })) }];
            e.buttons.push(["Edit config.toml", edit(`${H}/.codex/config.toml`, "Codex settings")], ["Open in terminal", say("/settings")]);
          } else {
            const [st] = await control(folder, null, [{ subtype: "get_settings" }], { on });
            e.sections = [{ rows: Object.entries(st?.effective ?? {}).map(([k, v]) => ({ label: k, detail: show(v) })) },
              ...(st?.sources ?? []).length ? [{ title: "From", rows: st.sources.map((x) => ({ label: x.source.replace(/Settings$/, ""), detail: Object.keys(x.settings ?? {}).join(", ") })) }] : []];
            e.buttons.push(["Edit your settings", edit(`${H}/.claude/settings.json`, "Claude Code settings")],
              ["Edit project settings", edit(`${folder}/.claude/settings.json`, "Project settings")], ["Open in terminal", say("/config")]);
          }
        }
      } catch (err) {
        e.error = String(err?.message ?? err);
      }
      e.loading = false;
      cx.notify();
    });
    cx.notify();
  }

  // A card the chat makes itself, shown in the conversation as the command and
  // its answer (not sent to the agent, and gone when the chat reloads).
  hostCard(card, cx) {
    if (!this.t) return;
    this.t.push({ kind: "user", command: true, ephemeral: true, text: `/${card}`, images: [] });
    const e = this.t.push({ kind: "card", card, ephemeral: true, loading: true });
    this.off = 0;
    const term = this.terminal();
    const folder = term?.foreground?.cwd ?? term?.cwd ?? null;
    cx.spawn(async (cx) => {
      const { kind } = this.current();
      if (kind === "codex") {
        const [limits, account] = await codexCalls(folder, [["account/rateLimits/read", null], ["account/read", {}]], machineOf(this.term)).catch(() => [null, null]);
        const { cat, model, effort } = this.current();
        const ctx = this.t?.context;
        if (card === "status") Object.assign(e, { rows: [
          ["Model", [modelName(cat?.models, model), effort].filter(Boolean).join(" · ")],
          ["Folder", folder],
          ["Session", threadOf(this.file)],
          ["Context", ctx?.window ? `${Math.round(100 * ctx.used / ctx.window)}% full · ${ctx.used.toLocaleString()} of ${ctx.window.toLocaleString()} tokens` : null],
          ["Account", [account?.account?.email, limits?.rateLimits?.planType].filter(Boolean).join(" · ")],
        ].filter(([, v]) => v) });
        else {
          const codex = limits?.rateLimits ?? this.t?.limits ?? null;
          Object.assign(e, { codex });
          const norm = normalizeRateLimits(codex);
          if (norm) {
            this.rateLimits = norm;
            const key = `${kind}|${machineOf(this.term) ?? ""}`;
            try { localStorage.setItem(`limits1:${key}`, JSON.stringify(norm)); } catch {}
          }
        }
        e.loading = false;
        return cx.notify();
      }
      if (card === "status") {
        const screen = (await hc(["read", this.term, "--lines", "4"])).stdout;
        const { cat, model, effort } = this.current();
        Object.assign(e, {
          rows: [
            ["Model", [modelName(cat?.models, model), effort].filter(Boolean).join(" · ")],
            ["Mode", /⏵⏵\s*([^(·\n]+?)\s*(?:on)?\s*(?:\(|·|$)/m.exec(screen)?.[1]?.trim() ?? (/plan mode/i.test(screen) ? "plan mode" : "default")],
            ["Folder", folder],
            ["Session", sessionOf(this.file)],
            ["Account", [this.account?.email, this.account?.organization, this.account?.subscriptionType].filter(Boolean).join(" · ")],
            ["Claude Code", this.version],
          ].filter(([, v]) => v),
        });
      } else {
        const [u] = await control(folder, sessionOf(this.file), [{ subtype: "get_usage" }], { on: machineOf(this.term) });
        if (!u || u.error) e.error = u?.error ?? "No answer";
        else {
          Object.assign(e, { usage: u });
          const norm = normalizeRateLimits(u.rate_limits);
          if (norm) {
            this.rateLimits = norm;
            const key = `${kind}|${machineOf(this.term) ?? ""}`;
            try { localStorage.setItem(`limits1:${key}`, JSON.stringify(norm)); } catch {}
          }
        }
      }
      e.loading = false;
      cx.notify();
    });
    cx.notify();
  }

  // The command at the start of the message: a chip, or typed out.
  typedCommand() {
    const name = /^\/(\S+)/.exec(this.input.value().trim())?.[1];
    return name ? (this.cmds ?? []).find((c) => c.name === name || c.aliases.includes(name)) ?? null : null;
  }

  openSide(question, cx) {
    this.side.open = true;
    if (question) this.askSideQ(question, cx);
    this.sideInput.focus();
    cx.notify();
  }

  askSideQ(question, cx) {
    if (!question) return;
    const item = { q: question, a: null, error: null, pending: true, at: Date.now() };
    const history = this.side.items.filter((x) => x.a).map((x) => ({ question: x.q, response: x.a }));
    this.side.items.push(item);
    this.side.off = 0;
    const term = this.terminal();
    const kind = this.current().kind;
    const session = kind === "claude" ? sessionOf(this.file) : kind === "codex" ? this.file : null;
    cx.spawn(async (cx) => {
      if (!session) item.error = kind ? "Send a message in the main chat first: the side chat answers from its conversation." : "Side questions work with Claude Code and Codex agents.";
      else {
        const ask = kind === "codex" ? askCodexSide : askSide;
        const r = await ask(term?.foreground?.cwd ?? term?.cwd ?? null, session, question, history, machineOf(this.term)).catch((e) => ({ error: String(e?.message ?? e) }));
        item.a = r.text ?? null;
        item.error = r.error ?? null;
      }
      item.pending = false;
      cx.notify();
    });
    cx.notify();
  }

  // The side chat pane, beside the conversation.
  sidePane(t) {
    const S = this.side;
    const w = Math.round(Math.min(420, Math.max(300, (this.width + 360) * 0.36)));
    const bubble = (x, i) => v_flex().gap(8)
      .child(h_flex().w_full().justify_end().child(div().max_w(w - 70).px(12).py(8).rounded(14).bg(t.raised).text_size(12.5).child(x.q)))
      .child(x.pending
        ? h_flex().gap(8).items_center().text_size(12).text_color(t.muted).child(div().text_color(t.working).frames(SPINNER, 90)).child("Thinking…")
        : x.error ? div().text_size(12).text_color(t.blocked).child(x.error)
        : div().text_size(12.5).child(this.markdown(`side-${i}`, x.a)));
    const content = v_flex().id("side-content").absolute().left(0).right(0).bottom(-S.off).px(14).py(14).gap(18)
      .on_size_change((size, cx) => { S.contentH = size.height; S.off = Math.max(0, Math.min(S.off, S.contentH - S.viewH)); cx.notify(); })
      .when(S.items.length === 0, (el) => el.child(v_flex().gap(6).py(20).items_center().text_size(12).text_color(t.dim)
        .child("Ask a quick question about this conversation.")
        .child("The agent keeps working; nothing here is added to its chat.")))
      .children(S.items.map(bubble));
    return v_flex().id("side").flex_none().w(w).h_full().border_l(1).border_color(t.border).bg(t.background)
      .child(h_flex().h(34).px(12).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome).text_size(12)
        .child(div().font_semibold().child("Side chat"))
        .child(div().flex_1().text_color(t.dim).child(shortcut(";")))
        .when(S.items.length > 0, (el) => el.child(div().id("side-clear").px(6).py(2).rounded(5).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { S.items = []; S.off = 0; cx.notify(); }).child("Clear")))
        .child(div().id("side-close").px(6).py(2).rounded(5).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { S.open = false; this.input.focus(); cx.notify(); }).child("×")))
      .child(div().id("side-scroll").relative().flex_1().min_h(0).overflow_hidden()
        .on_size_change((size, cx) => { S.viewH = size.height; cx.notify(); })
        .on_scroll_wheel((e, cx) => { S.off = Math.max(0, Math.min(S.off + e.delta.y, S.contentH - S.viewH)); cx.notify(); })
        .child(content))
      .child(div().p(10).child(v_flex().rounded(14).border_1().border_color(t.border).bg(t.background)
        .child(Textarea.new(this.sideInput).w_full().px(12).py(9).border_0().bg(t.background).text_size(12.5).text_color(t.foreground))));
  }

  // The terminal's own picker or panel, shown in the chat while it's open: its
  // choices to click, or its screen, with the keys it takes. `maybe`: a command
  // that may only print; the panel shows only if a picker turns up.
  openPanel(command, cx, maybe = false) {
    const panel = { command, screen: "", q: null, seen: false, gone: 0, maybe, at: Date.now() };
    this.panel = panel;
    cx.spawn(async (cx) => {
      while (this.panel === panel) {
        await sleep(cx, 400);
        if (this.panel !== panel) break;
        const r = await hc(["read", this.term, "--lines", "40"]).catch(() => null);
        const screen = r?.stdout ?? "";
        const tail = screen.split("\n").slice(-30).join("\n");
        const open = DIALOG.test(tail);
        if (open) { panel.seen = true; panel.gone = 0; if (panel.closing && Date.now() - panel.closing > 1500) panel.closing = null; }
        else panel.gone++;
        // Closed once its hints go away, or never opened (the command just ran).
        if ((panel.seen && panel.gone >= (panel.closing ? 1 : 2)) || (!panel.seen && Date.now() - panel.at > (maybe ? 2500 : 6000))) { this.panel = null; cx.notify(); break; }
        panel.screen = screen;
        panel.q = open ? parsePrompt(tail) : null;
        cx.notify();
      }
    });
  }

  panelKeys(...keys) {
    if (this.panel) {
      this.panel.gone = 0; this.panel.at = Date.now();
      this.panel.closing = keys.includes("esc") ? Date.now() : null;
    }
    hc(["keys", this.term, ...keys]);
  }

  submitCustomPrompt(text, cx) {
    const P = this.panel;
    const q = P?.q ?? (this.screen ? parsePrompt(this.screen) : null);
    const customIdx = q?.options?.findIndex((o) => /^(?:type something|other)\b/i.test(o)) ?? -1;
    cx.spawn(async (cx) => {
      if (customIdx >= 0) {
        this.panelKeys(...choose(q.selected, customIdx));
        await sleep(cx, 80);
      }
      await hc(["send", this.term, text]);
      if (!P) { this.screenSeq++; this.screen = this.idleAsk = null; }
      cx.notify();
    });
  }

  // The panel over the message box.
  panelView(t) {
    const P = this.panel;
    // Gone at once on Esc; back if the picker only stepped back a level.
    if (!P || (!P.seen && P.maybe) || (P.closing && Date.now() - P.closing < 1500)) return null;
    const mono = settings().font_family;
    const key = (k, label) => div().id(`pk-${k}`).px(9).py(4).rounded(6).cursor_pointer().bg(t.raised).text_size(12)
      .hover((s) => s.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { this.panelKeys(k); cx.notify(); }).child(label);
    // The dialog's own lines: from the last rule above the bottom of the screen.
    const lines = P.screen.split("\n");
    let end = lines.length;
    while (end > 0 && !lines[end - 1].trim()) end--;
    let top = Math.max(0, end - 26);
    for (let i = end - 2; i > end - 30 && i > 0; i--) if (/^\s*[─━▔▁═]{8,}\s*$/.test(lines[i])) { top = i + 1; break; }
    const shown = lines.slice(top, end).filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim()));
    const q = P.q;
    const hasCustom = Boolean(q?.options?.some((o) => /^(?:type something|other)\b/i.test(o)));
    return h_flex().w_full().justify_center().child(v_flex().id("term-panel").w_full().max_w(900).p(12).gap(10).rounded(14)
      .border_1().border_color(t.accent).bg(t.popover).shadow_md()
      .child(h_flex().gap(8).items_center()
        .child(svg("mods/chat/icons/terminal.svg").size(14).text_color(t.dim))
        .child(div().flex_1().text_size(12.5).font_semibold().child(P.seen ? `${P.command} · in the terminal` : `${P.command} · opening…`))
        .child(this.button("panel-term", "Show terminal", (_e, cx) => this.showTerminal(cx), t))
        .child(this.button("panel-close", "Close", (_e, cx) => { this.panelKeys("esc"); this.panel = null; cx.notify(); }, t)))
      .when(Boolean(q), (el) => el
        .when(Boolean(q.question), (d) => d.child(div().text_size(12.5).child(this.markdown("panel-q", q.question))))
        .child(v_flex().gap(5).children(q.options.map((o, n) =>
          h_flex().id(`po-${n}`).px(12).py(7).gap(10).rounded(8).cursor_pointer().border_1()
            .border_color(n === q.selected ? t.accent : t.border).bg(n === q.selected ? t.selected : t.surface)
            .hover((s) => s.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => {
              if (q.multi && q.boxes?.[n]) {
                this.panelKeys(...toggleChoice(q.selected, n));
                q.selected = n;
                q.checked[n] = !q.checked[n];
              } else {
                this.panelKeys(...choose(q.selected, n));
              }
              cx.notify();
            })
            .when(Boolean(q.multi && q.boxes?.[n]), (row) => row.child(div().flex_none().text_size(13)
              .text_color(q.checked?.[n] ? t.accent : t.dim).child(q.checked?.[n] ? "☑" : "☐")))
            .child(div().flex_1().text_size(12.5).child(o)))))
        .when(hasCustom && Boolean(this.promptInput), (row) => row.child(h_flex().gap(6).items_center()
          .child(div().flex_1().child(Input.new(this.promptInput).text_size(12.5)))
          .child(this.button("po-custom-send", "Send", (_e, cx) => {
            const v = this.promptInput.value().trim();
            if (!v) return;
            this.promptInput.set_value("");
            this.submitCustomPrompt(v, cx);
          }, t)))))
      .when(!q && shown.length > 0, (el) => el.child(div().id("panel-screen").max_h(360).overflow_y_scrollbar().text_size(11.5).text_color(t.foreground)
        .when(Boolean(mono), (d) => d.font_family(mono))
        .child(this.markdown("panel-screen", "~~~~text\n" + shown.join("\n") + "\n~~~~"))))
      .child(h_flex().gap(6).flex_wrap().items_center()
        .child(key("up", "↑")).child(key("down", "↓")).child(key("left", "←")).child(key("right", "→"))
        .child(key("tab", "Tab")).child(key("space", "Space")).child(key("enter", "Enter")).child(key("esc", "Esc"))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child("With the message box empty, arrows, Tab, Enter and Esc go to it"))));
  }

  setTerm(address, cx) {
    const nextId = localId(address);
    const changed = nextId !== this.terminalId;
    if (changed && this.terminalId && this.input) {
      this.drafts ??= {};
      this.drafts[this.terminalId] = { text: this.input.value(), attach: [...(this.attach ?? [])] };
    }
    this.terminalId = nextId;
    if (changed) {
      const saved = (this.drafts ?? {})[nextId];
      if (this.input) {
        this.settingHistory = true;
        this.input.set_value(saved?.text ?? "");
        this.settingHistory = false;
      }
      this.attach = saved?.attach ? [...saved.attach] : [];
      this.historyIdx = null;
      this.historyDraft = "";
      this.frozenStart = null;
      this.loadOutbox();
    }
    this.sig = null;
    this.file = null;
    this.t = null;
    this.activeTail = null;
    this.codexHandoff?.reset();
    this.chosen = null;
    this.side = { open: false, items: [], off: 0, viewH: 0, contentH: 0 };
    this.gen++;
    this.check(cx);
    cx.notify();
  }

  loadCatalog(kind, machine, cx) {
    const key = `${kind}@${machine ?? ""}`;
    if (this.catalogs[key]) return this.catalogs[key];
    this.catalogs[key] = { models: [], loading: true };
    cx.spawn(async (cx) => {
      try { this.catalogs[key] = await catalog(kind, machine); } catch { this.catalogs[key] = { models: [] }; }
      cx.notify();
    });
    return this.catalogs[key];
  }

  // Follows the terminal: which agent runs there, which log it writes, and
  // what it shows while waiting for the person.
  check(cx) {
    const term = this.terminal();
    const mine = this.myPane();
    if (mine && !this.presentation) {
      this.pane = mine.pane;
      const links = shared("chat.panes") ?? {};
      if (links[mine.pane] !== this.terminalId) {
        const live = new Set(panes().filter((p) => p.mod === "chat").map((p) => p.pane));
        setShared("chat.panes", { ...Object.fromEntries(Object.entries(links).filter(([id]) => live.has(id))), [mine.pane]: this.terminalId });
      }
    }
    // The agent's own tab, while it's away from the chat: showing it (from the
    // Agents list) or the agent needing you brings it back; put it away again after.
    const own = !this.presentation && away(term) && spaces().flatMap((s) => s.tabs).find((x) => x.id === this.label("tab"));
    if (own && !own.settled && !own.active && term.status !== "blocked") run("tab.settle", { id: own.id });
    for (const item of this.outbox?.items ?? []) {
      for (const file of item.attachments) if (file.image) this.cache(file.image, cx, null);
    }
    this.pumpOutbox(cx);
    const visible = this.chatVisible();
    if (!visible) {
      this.attention?.update(term, { visible: false }, () => {});
      return;
    }
    this.attention ??= new ChatAttention();
    const identitySource = `${this.term}:${term?.foreground?.pid}`;
    if (this.sourceAddress !== identitySource) {
      const prevAddress = this.sourceAddress;
      this.sourceAddress = identitySource;
      this.sessionResolved = false;
      this.waitingForLog = false;
      this.binding = null;
      this.bindingEpoch = (this.bindingEpoch ?? 0) + 1;
      this.gen++;
      this.file = null;
      this.t = null;
      this.sig = null;
      this.activeTail = null;
      this.streamLoop = null;
      this.stream = null;
      this.running = null;
      this.codexHandoff?.reset();
      if (prevAddress !== undefined) this.side = { open: false, items: [], off: 0, viewH: 0, contentH: 0 };
    }
    const kind = agentKind(term);
    if (kind === "codex" || kind === "claude") {
      if (this.pending?.length && ["working", "blocked"].includes(term?.status)) {
        for (const p of this.pending) if (!p.delivering) p.seenWorking = true;
      }
      if (this.tracer?.isEnabled()) {
        const st = this.t?.turnState ?? this.t?.codexTurn;
        const sig = `${term?.status ?? ""}|${st?.stage ?? ""}|${st?.epoch ?? 0}|${this.pending?.length ?? 0}|${Boolean(this.streamLoop)}|${Boolean(this.file)}`;
        this.tracer.record("check_state", {
          sig,
          status: term?.status ?? null,
          stage: st?.stage ?? null,
          epoch: st?.epoch ?? 0,
          pending: this.pending?.length ?? 0,
          following: Boolean(this.streamLoop),
          hasFile: Boolean(this.file),
        });
      }
    }
    const titleIdentity = kind === "codex" && codexTitleIdentity(term);
    this.identifyFeedback ??= new IdentifyFeedback();
    this.identifyFeedback.begin(identifyKey(term, titleIdentity));
    const seen = this.attention.update(term, { visible, active: appWindow().active,
      ready: Boolean(this.t?.entries.length) && (kind !== "codex" || this.sessionResolved)
        && (!titleIdentity || titleMatchesFile(titleIdentity, this.file)) }, async (address, turn) => {
      const result = await hc(["label", address, `herdr.seen=${turn}`]);
      if (result.code !== 0) throw new Error(result.stderr || "Could not mark the conversation read");
    });
    if (seen) cx.spawn(async cx => { await seen; cx.notify(); });
    this.loadCmds(term, kind, cx);
    this.loadUsageLimits(term, kind, cx);
    if (kind && term?.status === "working") {
      if (kind === "codex" || kind === "claude") this.ensureFollow(kind, cx, 0);
      else if (!this.streamLoop) this.follow(kind, cx);
    }
    const sig = term && kind ? `${kind}:${term.address}:${term.foreground?.pid}` : null;
    this.ticks++;
    const titleChanged = titleIdentity && !titleMatchesFile(titleIdentity, this.file);
    if (sig && !this.locating && (sig !== this.sig || titleChanged || this.ticks % 3 === 0 || !this.file)) {
      this.locating = true;
      const epoch = this.bindingEpoch;
      cx.spawn(async (cx) => {
        const capturedTitle = kind === "codex" ? codexTitleIdentity(term)?.prefix ?? null : null;
        const stillCurrent = () => epoch === this.bindingEpoch
          && `${this.term}:${this.terminal()?.foreground?.pid}` === identitySource
          && (kind !== "codex" || (codexTitleIdentity(this.terminal())?.prefix ?? null) === capturedTitle);
        try {
          let file = null;
          let waitingForLog = false;
          if (kind !== "codex" || !capturedTitle) {
            try { file = await locate(term, kind); }
            catch (error) { if (kind !== "codex") throw error; }
          }
          if (kind === "codex") {
            // PID alone can be reused after an exit/reboot. Match its start
            // time too before restoring a binding after mod/app reload.
            const started = await exec("ps", ["-p", String(term.foreground.pid), "-o", "lstart="], { on: machineOf(term.address) });
            if (started.code !== 0 || !started.stdout.trim()) throw new Error("Could not verify the Codex process");
            const process = `${term.foreground.pid}:${started.stdout.trim()}`;
            const key = bindingKey(this.owner, this.terminalId);
            const saved = key ? (shared("chat.bindings") ?? {})[key] : null;
            const titleIdentity = codexTitleIdentity(term);
            let previous = this.binding?.process === process ? this.binding : saved?.process === process ? saved : null;
            if (titleIdentity && previous && !titleMatchesFile(titleIdentity, previous.file)) previous = null;
            if (!stillCurrent()) return;
            if (titleIdentity && this.file && !titleMatchesFile(titleIdentity, this.file)) {
              this.gen++; this.file = null; this.t = null; this.sessionResolved = false;
              this.activeTail = null; this.streamLoop = null; this.stream = null; this.running = null;
              this.codexHandoff?.reset();
              cx.notify();
            }
            this.binding = previous;
            const screen = titleIdentity ? { stdout: "" } : await hc(["read", term.address]);
            const result = await resolveSession(term, screen.stdout, file, previous?.file);
            if (!stillCurrent()) return;
            waitingForLog = result.evidence === "title" && result.matchCount === 0 && !result.subagent;
            const next = chooseBinding(previous, result, process);
            this.binding = next;
            file = next?.file ?? null;
            if (key && JSON.stringify(saved ?? null) !== JSON.stringify(next)) {
              const records = { ...(shared("chat.bindings") ?? {}) };
              if (next) records[key] = next; else delete records[key];
              setShared("chat.bindings", records);
            }
          }
          if (!stillCurrent()) return;
          this.sig = sig;
          this.waitingForLog = waitingForLog;
          this.sessionResolved = Boolean(file) || waitingForLog;
          this.error = null;
          if (!file && kind === "codex") {
            this.gen++; this.file = null; this.t = null;
            this.activeTail = null; this.streamLoop = null; this.stream = null; this.running = null;
            this.codexHandoff?.reset();
          }
          if (file && file !== this.file) this.start(file, machineOf(this.term), kind, cx);
          this.missing = !file && !this.file;
        } catch (e) {
          if (!stillCurrent()) return;
          // A transient read/probe failure does not invalidate a verified
          // binding in this live process. New instances wait for verification.
          if (kind === "codex" && !this.binding) {
            this.sessionResolved = false;
            this.gen++; this.file = null; this.t = null;
            this.activeTail = null; this.streamLoop = null; this.stream = null; this.running = null;
            this.codexHandoff?.reset();
          }
          this.error = String(e?.message ?? e);
        }
        finally {
          if (stillCurrent()) this.identifyFeedback.finish(this.sessionResolved);
          this.locating = false; cx.notify();
        }
      });
    }
    if (kind) this.loadCatalog(kind, machineOf(this.term), cx);

    // Questions only the terminal shows: a permission prompt, or one asked
    // before the agent reports anything (trusting a new folder). An agent that
    // already reports a status has started: until its log loads, its screen
    // is the conversation, and a numbered list there isn't a question.
    const started = ["working", "idle", "done"].includes(term?.status);
    if (term?.status === "blocked" || (term && !this.t && term.state === "live" && !started)) {
      this.idleAsk = null;
      const seq = ++this.screenSeq;
      cx.spawn(async (cx) => {
        const r = await hc(["read", this.term, "--lines", "40"]);
        if (seq !== this.screenSeq) return;
        this.screen = r.stdout.replace(/\s+$/, "");
        this.trustFolder();
        cx.notify();
      });
    } else if (this.t && ["idle", "done", "error"].includes(term?.status) && !this.panelLive()) {
      // A menu the agent opens on its own once a turn ends (an offer, a setup
      // form) doesn't report "blocked": only the screen shows it.
      const seq = ++this.screenSeq;
      cx.spawn(async (cx) => {
        const r = await hc(["read", this.term, "--lines", "40"]);
        if (seq !== this.screenSeq) return;
        const screen = r.stdout.replace(/\s+$/, "");
        const ask = menuAtBottom(screen);
        if (!ask && !this.idleAsk) return;
        if (!ask && this.error === ASK_FIRST) this.error = null;
        this.idleAsk = ask;
        this.screen = ask ? screen : null;
        cx.notify();
      });
    } else if (this.screen) {
      this.screenSeq++;
      this.screen = null;
      this.idleAsk = null;
      cx.notify();
    }
  }

  // The folder was picked in the New chat form, so trusting it is already
  // decided: answer the agent's trust question for it, once, before it starts.
  // Only a "Yes ... trust" choice; permission prompts are left to the person.
  trustFolder() {
    if (!this.started || this.trusted || this.t) return;
    const q = parsePrompt(this.screen);
    const yes = q ? q.options.findIndex((o) => /^(yes\b.*\btrust|trust and continue)/i.test(o)) : -1;
    if (yes < 0) return;
    this.trusted = true;
    this.screenSeq++;
    this.screen = null;
    hc(["keys", this.term, ...choose(q.selected, yes)]);
  }

  loadEarlier(cx) {
    if (this.historyLoading || !this.file || !this.t) return;
    this.start(this.file, machineOf(this.term), this.t.kind, cx, (this.historyBytes ?? 4 * 1024 * 1024) + 4 * 1024 * 1024);
    cx.notify();
  }

  readTailOnce(cx, state = this.activeTail) {
    if (!state || state.gen !== this.gen || !state.ready) return Promise.resolve(0);
    const run = async () => {
      if (state.gen !== this.gen || !state.ready) return 0;
      try {
        const lines = await state.tail.read();
        if (state.gen !== this.gen) return 0;
        this.truncated = state.tail.truncated;
        if (lines.length) {
          for (const l of lines) this.t.feed(l);
          this.grew = true;
          if (this.chatVisible()) this.cacheShown(cx);
          this.nameSpace();
          if (state.kind === "codex" || state.kind === "claude") {
            const st = this.t?.turnState ?? this.t?.codexTurn;
            this.tracer?.record("tail_batch", {
              count: lines.length,
              stage: st?.stage ?? null,
              epoch: st?.epoch ?? 0,
              assistantCount: st?.assistantCount ?? 0,
              toolCount: st?.toolCount ?? 0,
            });
            if (st?.stage === "awaiting_text" && this.chatVisible()) {
              this.ensureFollow(state.kind, cx, 1800);
            }
          }
          if (this.chatVisible()) cx.notify();
        }
        if (this.error) { this.error = null; cx.notify(); }
        return lines.length;
      } catch (e) {
        if (state.gen === this.gen) {
          this.error = String(e?.message ?? e);
          cx.notify();
        }
        return 0;
      }
    };
    state.chain = state.chain.then(run, run);
    return state.chain;
  }

  async flushTail(cx) {
    const state = this.activeTail;
    if (!state || state.gen !== this.gen || !state.ready) return 0;
    await state.chain;
    if (state.gen !== this.gen || !state.ready) return 0;
    return this.readTailOnce(cx, state);
  }

  start(file, on, kind, cx, moreBytes = null) {
    const gen = ++this.gen;
    const previous = moreBytes ? this.t : null;
    const previousTail = moreBytes && this.historyTail ? new Tail(file, on, this.historyBytes) : null;
    if (previousTail) {
      previousTail.offset = this.historyTail.offset;
      previousTail.truncated = this.historyTail.truncated;
    }
    this.historyLoading = Boolean(moreBytes);
    this.file = file;
    if (!previous) {
      this.t = new Transcript(kind);
      this.codexHandoff?.reset();
      this.limit = PAGE;
      this.off = 0;
      this.frozenStart = null;
      this.historyBytes = 4 * 1024 * 1024;
      this.truncated = false;
    }
    this.error = null;
    let tail = new Tail(file, on, moreBytes ?? this.historyBytes);
    this.historyTail = tail;
    const tailState = { gen, tail, kind, ready: false, chain: Promise.resolve() };
    this.activeTail = tailState;
    const dir = file.slice(0, file.lastIndexOf("/"));
    const waitForChange = folderPoll(watchFolder, cx.timer, dir);
    cx.spawn(async (cx) => {
      try {
        let lines;
        if (kind === "codex") {
          const initial = await inheritedHistory(file, on, moreBytes ?? this.historyBytes);
          if (gen !== this.gen) return;
          tail.offset = initial.offset;
          tail.truncated = initial.truncated;
          lines = initial.lines;
        } else {
          lines = await tail.read();
          if (gen !== this.gen) return;
        }
        const transcript = previous ? new Transcript(kind) : this.t;
        for (const line of lines) transcript.feed(line);
        if (previous) {
          rebaseHistory(previous, transcript, this.pending, gen);
          this.t = transcript;
          this.limit += PAGE;
          this.earlier = true;
          this.historyBytes = moreBytes;
        }
        this.truncated = tail.truncated;
        this.historyLoading = false;
        this.grew = true;
        if (this.chatVisible()) { this.cacheShown(cx); cx.notify(); }
        if (!previous && (kind === "codex" || kind === "claude") && this.term && this.terminal()?.status !== "working" && !this.codexHandoff?.seeded) {
          const term = this.term;
          cx.spawn(async () => {
            try {
              const r = await hc(["read", term, "--lines", "80"]);
              if (gen !== this.gen || this.term !== term || this.terminal()?.status === "working" || this.codexHandoff?.seeded) return;
              if (r?.stdout != null) this.codexHandoff?.seedIdleScreen(liveSnapshot(r.stdout, kind));
            } catch {}
          });
        }
      } catch (error) {
        if (gen !== this.gen) return;
        this.historyLoading = false;
        this.error = String(error?.message ?? error);
        cx.notify();
        if (!previousTail) return;
        tail = previousTail;
        this.historyTail = tail;
        tailState.tail = tail;
      }
      tailState.ready = true;
      while (gen === this.gen) {
        if (!this.chatVisible()) { await sleep(cx, 1000); continue; }
        await this.readTailOnce(cx, tailState);
        if (gen !== this.gen) return;
        if (on) await sleep(cx, 1500);
        else await waitForChange();
      }
    });
  }

  // A space this chat started is named after the conversation.
  nameSpace() {
    if (!this.started || this.named || !this.t?.title) return;
    const id = this.label("space");
    if (!id) return;
    this.named = true;
    if (!spaces().find((s) => s.id === id)?.named) run("space.rename", { id, name: this.t.title.slice(0, 40) });
  }

  queueContext() {
    const term = this.terminal();
    const title = codexTitleIdentity(term);
    const session = title?.prefix ?? sessionOf(this.file);
    const kind = agentKind(term);
    const verified = ["codex", "claude"].includes(kind) && (kind !== "codex" || (this.sessionResolved
      && (!title || !this.file || titleMatchesFile(title, this.file))));
    return { scope: verified ? outboxScope(term, session) : null, status: this.idleAsk ? "blocked" : term?.status, turn: term?.turn };
  }

  loadOutbox() {
    if (this.dialog) { this.outbox = new Outbox(); this.outboxKey = null; return; }
    const key = this.terminalId ? `outbox-v1:${this.terminalId}` : "outbox-v1";
    this.outboxKey = key;
    this.savedOutbox = null;
    try {
      let raw = localStorage.getItem(key);
      if (raw == null && this.terminalId) {
        const legacy = JSON.parse(localStorage.getItem("outbox-v1") ?? "{}");
        const items = (legacy.items ?? []).filter((x) => x.scope?.split(":")[0] === this.terminalId);
        const gate = legacy.gate?.scope?.split(":")[0] === this.terminalId ? legacy.gate : null;
        if (items.length || gate) raw = JSON.stringify({ items, gate });
      }
      this.outbox = new Outbox(JSON.parse(raw ?? "{}"));
    } catch { this.outbox = new Outbox(); }
  }

  saveOutbox() {
    if (!this.outbox.items.length) {
      this.outboxExpanded = null; this.outboxHovered = null; this.outboxHeight = null; this.outboxOffset = 0;
    }
    if (!this.outboxKey) return;
    const value = JSON.stringify(this.outbox);
    if (value !== this.savedOutbox) {
      localStorage.setItem(this.outboxKey, value);
      this.savedOutbox = value;
    }
  }

  pumpOutbox(cx, id = null) {
    if (this.dialog || !this.outbox) return;
    const context = this.queueContext();
    if (!id && this.t?.issue?.usage) return;
    if (id) {
      const reason = this.outbox.retryReason(context, id);
      if (reason) { notify({ title: "Cannot send yet", body: reason, level: "warning" }); return; }
    }
    const item = this.outbox.claim(context, id);
    this.saveOutbox();
    if (!item) return;
    const target = this.term;
    if (["idle", "done"].includes(context.status)) { this.stream = null; this.running = null; }
    this.beforeCodexPending?.(context, item);
    const pending = { ...item, fromQueue: !item.direct, files: item.paths.length, users: this.userCount(),
      afterKey: this.t?.entries.findLast((e) => !e.ephemeral)?.key ?? null, at: Date.now(), delivering: true,
      minCompletedEpoch: this.codexMinCompletedEpoch?.() ?? 1, idleSince: null };
    this.pending.push(pending);
    this.t?.markInput();
    this.afterCodexPending?.(cx, context, item);
    cx.notify();
    cx.spawn(async cx => {
      let error = null, paused = false;
      try {
        const ok = await this.deliver(item.text, item.paths, cx, {
          target, valid: () => this.term === target && this.queueContext().scope === item.scope,
          idleOnly: !id && context.status === "idle", steer: Boolean(id),
        });
        if (!ok) error = this.error || "Message was not sent.";
      } catch (e) { error = String(e?.message ?? e); paused = Boolean(e?.queuePaused); }
      pending.delivering = false;
      pending.at = Date.now();
      this.outbox.finish(item.id, error, paused);
      this.tracer?.record("deliver_done", { id: item.id, error: error ?? null, paused });
      if (error) {
        this.pending = this.pending.filter(message => message !== pending);
        if (!this.pending.length) this.codexHandoff?.cancelUserSend();
        if (!paused && !item.direct) this.outboxExpanded = true;
      }
      this.saveOutbox();
      cx.notify();
    });
  }

  failedSendsView(t) {
    const items = this.outbox.failedItems;
    if (!items.length) return null;
    const context = this.queueContext();
    return h_flex().w_full().justify_center().child(v_flex().w_full().max_w(900).gap(6)
      .children(items.map(item => v_flex().id(`failed-send-${item.id}`).w_full().gap(5).px(12).py(9)
        .rounded(10).border_1().border_color(t.blocked).bg(t.background)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().text_size(12).text_color(t.blocked).child("Failed to send"))
          .child(this.button(`retry-send-${item.id}`, "Retry", (_e, cx) => this.pumpOutbox(cx, item.id), t)
            .when(Boolean(this.outbox.retryReason(context, item.id)), button => button.opacity(0.4)))
          .child(this.button(`remove-failed-${item.id}`, "Remove", (_e, cx) => { this.outbox.remove(item.id); this.saveOutbox(); cx.notify(); }, t)))
        .child(div().truncate().text_size(12.5).text_color(t.foreground).tooltip(item.text).child(summaryLine(item.text)))
        .when(item.attachments.length > 0, row => row.child(div().text_size(11).text_color(t.muted)
          .child(`${item.attachments.length} ${item.attachments.length === 1 ? "attachment" : "attachments"}`)))
        .child(div().text_size(11).text_color(t.muted).child(this.outbox.retryReason(context, item.id) ?? item.error)))));
  }

  outboxView(t, inline = false) {
    const items = this.outbox.visibleItems;
    if (!items.length) return null;
    const context = this.queueContext();
    const hasError = items.some((item) => item.state === "error");
    const expanded = Boolean(this.outboxExpanded ?? hasError);
    const height = Math.min(240, this.outboxHeight ?? items.length * 80);
    const offset = Math.max(0, Math.min(this.outboxOffset ?? 0, (this.outboxHeight ?? height) - height));
    const toggle = h_flex().id("outbox-toggle").px(12).py(inline ? 2 : 9).gap(8).items_center().justify_end()
      .cursor_pointer().text_size(12).text_color(hasError ? t.blocked : t.muted).hover(style => style.text_color(t.foreground))
      .on_click((_e, cx) => { this.outboxExpanded = !expanded; this.outboxHovered = null; cx.notify(); })
      .child(hasError ? `${items.length} queued · delivery failed` : `${items.length} queued`)
      .child(div().text_size(11).child(expanded ? "▴" : "▾"));
    if (inline && !expanded) return toggle.flex_none();
    return h_flex().w_full().justify_center().child(v_flex().id("outbox").w_full().max_w(900)
      .rounded(18).overflow_hidden()
      .child(toggle.w_full())
      .when(expanded, el => el.border_1().border_color(hasError ? t.blocked : t.input).child(div().id("outbox-scroll").w_full()
        .h(height).flex_none().relative().overflow_hidden().border_t(1).border_color(t.border)
        .on_scroll_wheel((e, cx) => {
          this.outboxOffset = Math.max(0, Math.min(offset - e.delta.y, (this.outboxHeight ?? height) - height));
          cx.stop_propagation(); cx.notify();
        })
        .child(v_flex().absolute().left(0).right(0).top(-offset)
          .on_size_change((size, cx) => {
            if (Math.abs(size.height - (this.outboxHeight ?? 0)) > 0.5) {
              this.outboxHeight = size.height; cx.notify();
            }
          })
          .children(items.map((item) => {
            const paused = context.scope !== item.scope;
            const unavailable = paused || !["idle", "done", "working", "error"].includes(context.status);
            const hovered = this.outboxHovered === item.id || item.state === "error";
            return h_flex().id(`outbox-${item.id}`).w_full().min_h(44).flex_none().relative().px(12).py(10).gap(10).items_center()
              .on_hover((on, cx) => {
                if (on) this.outboxHovered = item.id;
                else if (this.outboxHovered === item.id) this.outboxHovered = null;
                cx.notify();
              })
              .child(v_flex().flex_1().min_w(0).items_end().gap(4)
                .when(Boolean(item.text), row => row.child(div().text_right().text_size(13).child(item.text)))
                .when(item.attachments.length > 0, row => row.child(h_flex().gap(6).flex_wrap().justify_end()
                  .children(item.attachments.map(file => file.image ? this.img(file.image.ref, t, 96, 64)
                    : div().text_size(11).text_color(t.muted).child(file.name)))))
                .when(paused || item.state === "sending", row => row.child(div().text_size(11).text_color(t.dim)
                  .child(paused ? "Paused · different session" : "Sending…")))
                .when(Boolean(item.error), row => row.child(div().text_right().text_size(11).text_color(t.blocked).child(item.error))))
              // Reserve the action gutter so hover never reflows the message.
              .child(h_flex().w(90).h(18).flex_none().gap(4).items_center().justify_end()
                .when(hovered && item.state !== "sending", row => row
                  .child(div().id(`outbox-send-${item.id}`).flex_none().h(18).px(8).rounded_full().border_1().border_color(item.state === "error" ? t.blocked : t.input)
                    .flex().items_center().justify_center().cursor_pointer().text_size(10).text_color(t.foreground)
                    .hover(style => style.border_color(t.accent).text_color(t.accent))
                    .on_click((_e, cx) => this.pumpOutbox(cx, item.id)).child(item.state === "error" ? "Retry" : "Instant")
                    .when(unavailable, button => button.opacity(0.4)))
                  .child(div().id(`outbox-remove-${item.id}`).cursor_pointer().px(4).text_color(t.muted)
                    .on_click((_e, cx) => { this.outbox.remove(item.id); this.saveOutbox(); cx.notify(); }).child("×"))));
          }))))));
  }

  userCount() {
    return (this.t?.entries ?? []).filter((e) => e.kind === "user" && !e.command).length;
  }

  // Sent messages leave the queue once the log records them: a user message
  // added since, with the same text (files only: any new one).
  settle() {
    const users = (this.t?.entries ?? []).filter((e) => e.kind === "user" && !e.command);
    // One the log never matched goes once the agent has been idle a while.
    const status = this.terminal()?.status;
    const busy = ["working", "blocked"].includes(status);
    const draining = Boolean(this.codexHandoff?.draining || this.streamLoop?.exiting);
    const managed = ["codex", "claude"].includes(this.t?.kind ?? agentKind(this.terminal()));
    const now = Date.now();
    for (const p of this.pending) {
      if (!p.delivering && busy) {
        p.seenWorking = true;
        p.idleSince = null;
      } else if (!p.delivering && !busy) {
        p.idleSince ??= now;
      }
    }
    const turn = this.t?.turnState ?? this.t?.codexTurn;
    const turnEpoch = turn?.epoch ?? 0;
    const completed = managed && turn?.stage === "completed";
    this.pending = this.pending.filter((p) => {
      if (draining && !p.delivering) return true;
      if (!p.delivering && !busy && completed && p.seenWorking && turnEpoch >= (p.minCompletedEpoch ?? 1)) return false;
      return p.delivering || busy || draining || now - (p.idleSince ?? p.at) < 15000;
    });
    const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();
    const used = new Set();
    this.pending = this.pending.filter((p) => {
      const needle = p.text ? norm(p.text.slice(0, 60)) : "";
      const i = users.findIndex((u, n) => n >= p.users && !used.has(n) && (needle ? norm(u.text).includes(needle) : true));
      if (i < 0) return true;
      used.add(i);
      return false;
    });
  }

  // Whether Claude Code still holds this message in its queue (its log says).
  inQueue(p) {
    return (this.t?.queue ?? []).some((q) => (p.text ? q.includes(p.text.slice(0, 60)) : q !== ""));
  }

  // Claude Code's own queue keys. A queued message steers by itself: Claude
  // reads it at its next step. ctrl+enter stops the turn and sends it now; up
  // takes every queued message back into its input, which is cleared line by
  // line here, and they come back to the message bar to edit.
  sendNow() {
    hc(["keys", this.term, "ctrl+enter"]);
  }

  editQueued() {
    const taken = (this.t?.queue ?? []).filter(Boolean);
    const lines = taken.join("\n").split("\n").length;
    hc(["keys", this.term, "up", ...Array(lines).fill(["ctrl+u", "backspace"]).flat()]);
    this.pending = this.pending.filter((x) => !this.inQueue(x));
    if (this.t) this.t.queue = [];
    const draft = this.input.value().trim();
    this.input.set_value([...taken, draft].filter(Boolean).join("\n"));
    this.input.focus();
  }

  queued(p, i, t) {
    const status = this.terminal()?.status;
    const claude = (this.t?.kind ?? agentKind(this.terminal())) === "claude";
    const waiting = (status === "working" || status === "blocked") && this.inQueue(p);
    const act = (id, label, fn) => div().id(id).px(8).py(2).rounded(6).cursor_pointer().text_color(t.foreground)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { fn(); cx.notify(); }).child(label);
    const attachments = p.attachments ?? [];
    return v_flex().w_full().items_end().gap(4)
      .child(this.entry({ kind: "user", key: `pending-${p.at}-${i}`, text: p.text,
        images: attachments.filter(file => file.image).map(file => file.image),
        files: attachments.filter(file => !file.image).map(file => ({ path: file.path, name: file.name, bytes: null })) }, t, false))
      .child(h_flex().gap(4).items_center().text_size(11.5).text_color(t.dim)
        // Codex doesn't queue: a message sent while it works goes straight into
        // the running turn as guidance, so there's nothing to send now or edit.
        .child(div().pr(4).child(p.delivering
          ? Date.now() - p.at > 3000 ? "Waiting for terminal input…"
          : p.fromQueue ? "Sending queued message…" : "Sending to terminal…"
          : waiting && claude ? "Steering · read at its next step"
          : !claude && (status === "working" || status === "blocked") ? "Steering · added to the running turn"
          : !claude && p.seenWorking ? "Sent" : "Sending…"))
        .when(waiting && claude, (el) => el
          .child(act(`send-now-${i}`, "Send now", () => this.sendNow()))
          .when(Boolean(p.text), (el) => el.child(act(`edit-q-${i}`, "Edit", () => this.editQueued())))));
  }

  shown() {
    const entries = this.t?.entries ?? [];
    // Streaming replies/tools mutate in place; only new entries change the
    // settings projection. Avoid walking the full history on hover or resize.
    if (this.displaySource !== entries || this.displayCount !== entries.length || this.displayRevision !== this.t?.revision) {
      this.displaySource = entries;
      this.displayCount = entries.length;
      this.displayRevision = this.t?.revision;
      this.displayEntries = withChanges(compactSettings(entries));
    }
    let ents = this.displayEntries;
    // Searching: only what matches, the newest 200.
    const q = this.searching ? this.search.value().trim().toLowerCase() : "";
    if (q) {
      const text = (e) => [e.text, e.title, e.detail, ...(e.items ?? []).flatMap((i) => [i.name, i.summary, i.result])].filter(Boolean).join("\n").toLowerCase();
      ents = ents.filter((e) => text(e).includes(q));
      this.matches = ents.length;
      return { start: Math.max(0, ents.length - 200), ents };
    }
    let start = Math.max(0, ents.length - this.limit);
    if (this.off > 24 && !this.earlier && this.frozenStart != null) {
      start = Math.min(this.frozenStart, Math.max(0, ents.length - 1));
    } else {
      this.frozenStart = start;
    }
    return { start, ents };
  }

  openSearch(cx) {
    this.searching = true;
    this.search.focus();
    cx.notify();
  }

  closeSearch(cx) {
    this.searching = false;
    this.search.set_value("");
    this.off = 0;
    this.input.focus();
    cx.notify();
  }

  // Images are drawn from Herdr's folder, so the shown ones are copied there first.
  cacheShown(cx) {
    const { start, ents } = this.shown();
    for (const e of ents.slice(start)) {
      for (const img of [...(e.images ?? []), ...(e.items ?? []).flatMap((i) => i.images)]) this.cache(img, cx);
    }
  }

  cache(img, cx, on = machineOf(this.term)) {
    img.ref ??= img.data ? hash(img.data.slice(0, 8192) + img.data.length) : hash(img.path);
    if (this.images[img.ref]) return;
    this.images[img.ref] = "pending";
    cx.spawn(async (cx) => {
      try {
        const base = (img.path ?? "").split(/[\\/]/).pop() ?? "";
        const ext = img.ext ?? (base.includes(".") ? base.split(".").pop().toLowerCase() : "png");
        const rel = `${CACHE}/${img.ref}.${ext}`, abs = `${appHome()}/${rel}`;
        if (img.data) await fs.writeFile(abs, Buffer.from(img.data, "base64"));
        else if (on) {
          const result = await exec("sh", ["-c", 'base64 < "$1"', "sh", img.path], { on });
          if (result.code !== 0) throw new Error("copy failed");
          await fs.writeFile(abs, Buffer.from(result.stdout, "base64"));
        } else if ((await exec("cp", [img.path, abs])).code !== 0) throw new Error("copy failed");
        const { w, h } = (await imageSize(abs)) ?? { w: 320, h: 240 };
        this.images[img.ref] = { rel, abs, w, h };
      } catch {
        this.images[img.ref] = "failed";
      }
      cx.notify();
    });
  }

  send(cx) {
    if (agentKind(this.terminal()) === "codex") {
      const identity = codexTitleIdentity(this.terminal());
      if (!this.sessionResolved || (identity && this.file && !titleMatchesFile(identity, this.file))) return;
    }
    const menu = this.slash();
    if (menu) return this.choose(menu.pickable[menu.sel], cx);
    const mm = this.mentionMenu();
    if (mm?.items.length) return this.pickMention(mm.items[mm.sel], cx);
    const em = this.emojiMenu();
    if (em) return this.pickEmoji(em.items[em.sel], cx);
    if (this.panelLive()) { this.input.set_value(""); this.panelKeys("enter"); return cx.notify(); }
    const text = emojify(this.input.value().trim());
    const cmd = this.dialog ? null : this.typedCommand();
    if (cmd) this.used(cmd.name);
    // /btw and /side never reach the agent: they open the side chat.
    const aside = !this.dialog && /^\/(?:btw|side)(?:\s+([\s\S]*))?$/.exec(text);
    if (aside) {
      this.input.set_value("");
      this.openSide(aside[1]?.trim() ?? "", cx);
      return cx.notify();
    }
    if (cmd?.action && this.hostCommand(cmd, text.replace(/^\/\S+\s*/, ""), cx)) return cx.notify();
    const files = this.attach.map((a) => a.path);
    if (this.dialog) return this.startChat(text, files, cx);
    if (this.idleAsk) { this.error = ASK_FIRST; return cx.notify(); }
    // A lone "/" would open the terminal's own menu and run its first command.
    if (!this.term || ((!text || text === "/") && !files.length)) { if (!files.length) this.input.set_value(""); return; }
    const context = this.queueContext();
    if (!/^[\/!]/.test(text) && !context.scope && ["working", "blocked"].includes(this.terminal()?.status)) {
      this.error = "Wait for the conversation to be identified before queueing a message.";
      return cx.notify();
    }
    if (!/^[\/!]/.test(text) && this.t?.issue?.usage) {
      this.error = "Usage limit reached. Your draft has been kept; retry after the limit resets or choose another model.";
      return cx.notify();
    }
    const attachments = this.attach.map(attachment => ({ ...attachment }));
    this.input.set_value("");
    this.attach = [];
    this.off = 0;
    // Regular messages wait for a free turn; commands retain their immediate behavior.
    if (!/^[\/!]/.test(text) && context.scope) {
      const direct = this.outbox.canSendDirect(context);
      this.tracer?.record("send", { queued: true, direct, len: text.length });
      this.outbox.enqueue({ text, paths: files, attachments, direct }, context.scope);
      this.saveOutbox();
      this.pumpOutbox(cx);
      return cx.notify();
    }
    // Slash commands and ! lines are logged as notes, not messages: no bubble for them.
    let directPending = null;
    if (!/^[\/!]/.test(text)) {
      directPending = { text, files: files.length, attachments, users: this.userCount(),
        afterKey: this.t?.entries.findLast((e) => !e.ephemeral)?.key ?? null, at: Date.now(), delivering: true,
        minCompletedEpoch: this.codexMinCompletedEpoch?.() ?? 1, idleSince: null };
      this.pending.push(directPending);
      this.t?.markInput();
    }
    this.beforeCodexDirectSend?.(text);
    this.stream = null; this.running = null;
    this.afterCodexDirectSend?.(text, cx);
    cx.spawn(async (cx) => {
      try {
        const ok = await this.deliver(text, files, cx);
        if (directPending) {
          directPending.delivering = false;
          directPending.at = Date.now();
          if (ok === false) {
            this.pending = this.pending.filter((p) => p !== directPending);
            if (!this.pending.length) this.codexHandoff?.cancelUserSend();
          }
        }
      } catch {
        if (directPending) {
          this.pending = this.pending.filter((p) => p !== directPending);
          if (!this.pending.length) this.codexHandoff?.cancelUserSend();
        }
      }
      cx.notify();
    });
    // A command that opens a picker or panel there: show it here, live.
    if (cmd?.picker || /^\/\S+/.test(text)) this.openPanel(text, cx, !cmd?.picker);
    cx.notify();
  }

  async deliver(text, files, cx, options = {}) {
    const target = options.target ?? this.term;
    if (options.valid && !options.valid()) throw new Error("The conversation changed; message remains queued.");
    if (/^\/(?:resume|fork|new|clear|reset)(?:\s|$)/.test(text)) {
      this.side = { open: false, items: [], off: 0, viewH: 0, contentH: 0 };
      if (agentKind(this.terminal()) === "codex") {
        const key = bindingKey(this.owner, this.terminalId);
        const records = { ...(shared("chat.bindings") ?? {}) };
        if (key) { delete records[key]; setShared("chat.bindings", records); }
        this.binding = null; this.sessionResolved = false;
        this.bindingEpoch = (this.bindingEpoch ?? 0) + 1;
        this.gen++; this.file = null; this.t = null; this.sig = null;
        this.activeTail = null; this.streamLoop = null; this.stream = null; this.running = null;
        this.codexHandoff?.reset();
      }
    }
    const paths = [];
    for (const f of files) {
      // An agent on another machine needs the file there.
      if (machineOf(target)) {
        const r = await exec("hc", ["put", target, f], { timeout: 180000 });
        if (options.valid && r.code !== 0) throw new Error(r.stderr.trim() || "Could not upload the attachment.");
        paths.push(r.code === 0 ? r.stdout.trim() : f);
      } else paths.push(f);
    }
    const message = [...paths.map(shellEscape), text].filter(Boolean).join(" ");
    if (!message) return;
    if (options.valid && !options.valid()) throw new Error("The conversation changed; message remains queued.");
    // terminal.send may protect an unfinished TUI draft for 60 seconds.
    // herdr.hc() has a fixed 30-second ceiling; use the configurable exec path.
    if (options.valid) {
      let screen;
      try { screen = await exec("hc", ["read", target, "--lines", "0"], { timeout: 90000 }); }
      catch (error) { throw new Error(`Could not check terminal input before sending: ${error?.message ?? error}`); }
      if (screen.code !== 0) throw new Error(screen.stderr?.trim() || "Could not check terminal input");
      const menu = menuAtBottom(screen.stdout);
      if (menu) {
        this.idleAsk = menu; this.screen = screen.stdout;
        const error = new Error("Waiting for your selection in the terminal prompt.");
        error.queuePaused = true;
        throw error;
      }
      if (!options.valid()) throw new Error("The conversation changed; message remains queued.");
    }
    const r = await exec("hc", ["send", ...(options.idleOnly ? ["--if", "idle"] : []), target, message], { timeout: 180000 });
    this.error = r.code === 0 ? null : r.stderr.trim() || "send failed";
    if (r.code === 0 && options.steer && agentKind(this.terminal()) === "claude"
      && this.terminal()?.status === "working" && options.valid?.()) {
      const now = await hc(["keys", target, "ctrl+enter"]);
      if (now.code !== 0) this.error = "Message reached Claude, but could not be sent immediately. Check TUI.";
      // The text was accepted already. Never duplicate it when the shortcut fails.
    }
    cx.notify();
    return r.code === 0;
  }

  // Starts one terminal in a new space and selects its local Chat view.
  startChat(text, files, cx) {
    const { kind, machine } = this.cfg;
    const cat = this.loadCatalog(kind, machine, cx);
    const model = this.cfg.model ?? cat.model, effort = this.cfg.effort ?? cat.effort;
    const folder = this.cfg.folder || this.defaultFolder(machine);
    if (this.starting) return;
    if (machine && files.length) { this.error = "Attach files once the chat has started"; return cx.notify(); }
    this.starting = true;
    this.error = null;
    cx.spawn(async (cx) => {
      try {
        const task = [...files.map(shellEscape), text].filter(Boolean).join(" ");
        const recent = (shared("chat.recent") ?? []).filter((x) => !(x.folder === folder && x.machine === machine));
        setShared("chat.recent", [{ folder, machine }, ...recent].slice(0, 6));
        setShared("chat.kind", kind);
        const spec = { folder, machine: machine ?? "", argv: launchArgv(kind, model, effort), ...(task ? { task } : {}) };
        const extra = { started: true, model, effort };
        if (!presentationLayoutReady(layout())) throw new Error("Select the updated Chat layout first");
        const r = await exec("python3", ["-c", NEW_SPACE, JSON.stringify(spec), JSON.stringify(layout()), JSON.stringify(extra)]);
        if (r.code !== 0) throw new Error(r.stderr.trim() || "Couldn't start the chat");
        closeOverlay(props().overlay);
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.starting = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  // The shown space's folder when it's on that machine, else the home folder there.
  defaultFolder(machine) {
    const s = activeSpace();
    if (s && (s.machine || null) === (machine || null)) {
      // Match the Spaces sidebar: the first terminal's current directory,
      // falling back to the directory where the space was created.
      const tabs = new Set((s.tabs ?? []).map(tab => tab.id));
      const folder = panes().find(pane => tabs.has(pane.tab) && pane.terminal && pane.cwd)?.cwd || s.folder;
      if (folder) return folder;
    }
    return machine ? "" : home();
  }

  // Opens a local conversation view for an agent already running.
  openBeside(address, cx) {
    cx.spawn(async (cx) => {
      try {
        const target = panes().find((p) => p.terminal === address);
        const pane = target?.pane;
        if (!pane) throw new Error("That agent has no terminal pane");
        run("pane.focus", { pane });
        await openConversation({ pane, tab: target.tab, terminal: address });
        closeOverlay(props().overlay);
      } catch (e) {
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  // Switches the running session's model or effort.
  applyModel(model, effort, cx, term = null) {
    const live = term ?? (() => { try { return this.terminal?.(); } catch { return null; } })();
    const kind = this.t?.kind ?? agentKind(live);
    if (!kind || this.switching) return;
    if (kind === "claude" && ["working", "blocked"].includes(live?.status)) {
      this.error = "Wait for Claude to finish the current turn before switching model or effort.";
      return cx.notify();
    }
    const cur = this.current();
    this.switching = true;
    cx.spawn(async (cx) => {
      try {
        // Claude resets effort to the new model's default; send it too.
        const m = model && model !== cur.model ? model : kind === "codex" ? cur.model : null;
        const e = effort ?? cur.effort;
        await switchModel(this.term, kind, m, e, machineOf(this.term), (ms) => sleep(cx, ms));
        this.chosen = { model: model ?? cur.model, effort: e ?? cur.effort, logged: this.t?.model };
        this.error = null;
      } catch (err) {
        this.error = String(err?.message ?? err);
      }
      this.switching = false;
      cx.notify();
    });
    cx.notify();
  }

  // The running session's model and effort: what was picked here, else what the log says.
  current() {
    const kind = this.t?.kind ?? agentKind(this.terminal());
    const cat = kind ? this.loadCatalogCached(kind, machineOf(this.term)) : null;
    // A model change in the terminal itself shows up in the log and wins.
    if (this.chosen?.logged !== undefined && this.t?.model && this.chosen.logged !== this.t.model
      && !this.t.model.startsWith(this.chosen.model)) this.chosen = null;
    const logged = this.t?.model ? cat?.models.find((m) => this.t.model.startsWith(m.id))?.id ?? this.t.model : null;
    return {
      kind, cat,
      model: this.chosen?.model ?? logged ?? cat?.model,
      effort: this.chosen?.effort ?? this.t?.effort ?? cat?.effort,
      // A pick here holds until the log reports a mode of its own.
      mode: (this.mode && this.mode.logged === this.t?.mode ? this.mode.id : null) ?? this.t?.mode ?? (kind === "claude" ? "default" : null),
    };
  }

  loadCatalogCached(kind, machine) {
    return this.catalogs[`${kind}@${machine ?? ""}`] ?? null;
  }

  // Show the existing terminal in the conversation's area, never beside it.
  showTerminal(cx) {
    const mine = this.myPane();
    if (!mine || this.moving) return;
    this.moving = true;
    cx.spawn(async (cx) => {
      try { if (this.presentation) await showTerminal(mine); else await switchView(mine.pane, this.terminal(), "terminal"); }
      catch (e) { this.error = `Couldn't switch to terminal: ${e?.message ?? e}`; }
      this.moving = false;
      cx.notify();
    });
  }

  // Dropped files are copied first: a screenshot dragged from its corner
  // thumbnail is a temporary file macOS deletes moments later.
  addFiles(paths, cx) {
    this.input.focus();
    cx.spawn(async (cx) => {
      for (const src of paths) {
        const name = src.split("/").pop();
        const path = `${appHome()}/${CACHE}/files/${Date.now()}-${name}`;
        await fs.mkdir(`${appHome()}/${CACHE}/files`, { recursive: true }).catch(() => {});
        if ((await exec("cp", ["-R", src, path])).code !== 0) { this.error = `Couldn't attach ${name}`; continue; }
        const a = { path, name, image: IMAGE_EXT.test(name) ? { path } : null };
        if (a.image) this.cache(a.image, cx, null);
        this.attach.push(a);
      }
      cx.notify();
    });
  }

  // A pasted screenshot: save the clipboard image and attach it.
  pasteImage(cx) {
    cx.spawn(async (cx) => {
      const path = `${appHome()}/${CACHE}/paste-${Date.now()}.png`;
      const got = await pasteImage(path);
      if (got === "missing") notify({ title: "Can't paste images here", body: "Install wl-clipboard (or xclip), or drop the image on the chat", level: "warning", timeout: 5000 });
      else if (got) this.addFiles([path], cx);
    });
  }

  clamp() {
    this.off = Math.max(0, Math.min(this.off, Math.max(0, this.contentH - this.viewH)));
  }

  // ---- drawing ----

  chip(id, label, selected, action, t) {
    return div().id(id).px(10).py(5).rounded(8).cursor_pointer().text_size(12).border_1()
      .border_color(selected ? t.accent : t.border).bg(selected ? t.selected : t.surface)
      .text_color(selected ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).on_click(action).child(label);
  }

  button(id, text, action, t, primary) {
    return div().id(id).flex_none().px(10).py(5).rounded(8).cursor_pointer().text_size(12)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .hover((s) => s.opacity(0.85)).on_click(action).child(text);
  }

  img(ref, t, maxW = 540, maxH = 390) {
    const c = this.images[ref];
    if (!c || typeof c === "string") {
      return div().w(120).h(80).rounded(8).bg(t.raised).flex().items_center().justify_center()
        .text_size(11).text_color(t.dim).child(c === "failed" ? "image" : "…");
    }
    const k = Math.min(1, maxW / c.w, maxH / c.h);
    return div().id(`img-${ref}`).cursor_pointer().rounded(8).overflow_hidden().border_1().border_color(t.border)
      .tooltip("View image").on_click(() => openOverlay({ mod: "chat-file", kind: "window",
        key: `chat-image-${ref}`, width: 900, height: 680, frame: "none",
        props: { image: c.rel, imageWidth: c.w, imageHeight: c.h, title: c.abs.split("/").pop() } }))
      .child(image(c.rel).w(Math.round(c.w * k)).h(Math.round(c.h * k)).rounded(8));
  }

  openFilePreview(url, cx, change = null, changes = null, collapseOthers = false) {
    const pane = this.myPane(), term = this.terminal();
    const key = previewKey(pane);
    const target = fileLink(url, term?.foreground?.cwd ?? term?.cwd ?? pane?.cwd, Boolean(change));
    if (!target || !key) { if (!change) cx.open_url(url); return; }
    const pages = shared("chat.preview") ?? {};
    setShared("chat.preview", {...pages, [key]: {...target, on: machineOf(pane.terminal), change,
      changes: changes?.map(file => ({...file, file: fileLink(file.path, term?.foreground?.cwd ?? term?.cwd ?? pane?.cwd, true)?.file ?? file.path})) ?? null,
      mode: change ? "diff" : /\.(md|markdown|mdown)$/i.test(target.file) ? "preview" : "source",
      collapseOthers, revision: Date.now()}});
    cx.spawn(async () => {
      try {
        const current = layout();
        const find = (node, id) => node?.id === id ? node : (node?.children ?? []).map(child => find(child, id)).find(Boolean);
        if (!find(current, "chat-preview")) await herdr("layout.set", {layout: previewLayout(current)});
        else {
          await herdr("layout.select", {stack: "panel-body", child: "chat-preview"});
          await herdr("layout.show", {id: "panel"});
        }
      }
      catch(error) { notify({title:"Could not open file preview",body:String(error?.message ?? error),level:"error"}); }
    });
  }

  markdown(id, text) {
    return TextView.markdown(id, text).selectable(true)
      .on_link_click((url, cx) => this.openFilePreview(url, cx));
  }

  entry(e, t, last, nextKind = null) {
    if (e.kind === "error") return v_flex().w_full().gap(6).px(12).py(10).rounded(10)
      .border_1().border_color(t.blocked).bg(t.surface)
      .child(div().text_size(12.5).font_semibold().text_color(t.blocked).child(e.usage ? "Usage limit reached" : "Agent error"))
      .child(div().text_size(13).child(this.markdown(`error-${e.key}`, e.text)));
    if (e.kind === "changes") return this.changeBlock(e, t);
    if (e.kind === "user") {
      // Let actual text layout size the bubble, capped by the panel width.
      const side = Math.max(18, Math.round((this.width - 900) / 2) + 16);
      const max = Math.max(120, Math.floor((this.width - 2 * side) * 0.70));
      // On hover, Copy and Edit (back into the message box to change and send
      // again) under the bubble, in a row that's always there.
      const on = this.hovered === e.key && Boolean(e.text);
      return v_flex().id(`row-${e.key}`).w_full().items_end().gap(4).on_hover(this.hover(e.key))
        .when(Boolean(e.from), (el) => el.child(div().text_size(11).text_color(t.dim).child(`hc · ${e.from}`)))
        .when(e.images.length > 0, el => el.child(h_flex().max_w(max).flex_wrap().justify_end().gap(6)
          .children(e.images.map(i => this.img(i.ref, t, Math.min(160, max), 112)))))
        .when(Boolean(e.files?.length), el => el.child(h_flex().max_w(max).flex_wrap().justify_end().gap(6)
          .children(e.files.map(file => h_flex().max_w(max).min_w(0).gap(8).px(12).py(8).rounded(8).bg(t.raised).tooltip(file.path)
            .child(svg("mods/chat/icons/attachment.svg").size(16).flex_none().text_color(t.muted))
            .child(v_flex().min_w(0).gap(2)
              .child(div().truncate().text_size(12).child(file.name))
              .when(Number.isFinite(file.bytes), el => el.child(div().text_size(10.5).text_color(t.dim)
                .child(file.bytes < 1024 ? `${file.bytes} B` : `${Math.round(file.bytes / 1024)} KB`))))))))
        .when(Boolean(e.text), el => el.child(v_flex().w_auto().max_w(max).min_w(0).flex_none().px(14).py(10).rounded(14).bg(settings().dark ? "#4e3087" : "#ede5fa").text_size(14).line_height("22px")
          .child(this.markdown(e.key, emojify(e.text)))))
        .child(h_flex().h(24).gap(4).when(on, (el) => el
          .child(this.tinyButton(`copyu-${e.key}`, this.copied === `u-${e.key}` ? "check" : "copy", "Copy", (_e, cx) => this.copyOut(e.text, `u-${e.key}`, cx), t))
          .child(this.tinyButton(`edit-${e.key}`, "edit", "Edit and send again", (_e, cx) => { this.input.set_value(""); this.input.replace(e.text); this.input.focus(); cx.notify(); }, t))));
    }
    if (e.kind === "assistant") {
      // On hover, Copy for the whole reply, in a row under it that's always there.
      return v_flex().id(`row-${e.key}`).w_full().relative().gap(6).text_size(14.5).line_height("24px").on_hover(this.hover(e.key))
        .child(this.reply(e, t))
        .when(nextKind !== "tools" && nextKind !== "changes", row => row.child(this.replyCopy(e, t)));
    }
    if (e.kind === "thinking") return this.thinkingView(e, t, last);
    if (e.kind === "notice") {
      const at = new Date(e.timestamp);
      const time = Number.isFinite(at.getTime()) ? `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}` : null;
      return h_flex().w_full().gap(5).py(2).items_center().text_size(11.5).text_color(t.dim)
        .child(div().min_w(0).truncate().tooltip(e.detail ?? e.text).child(e.text))
        .when(Boolean(time), el => el.child(div().flex_none().child(`· ${time}`)));
    }
    if (e.kind === "card") return this.card(e, t);
    if (e.kind === "output") return this.plainOutput(`out-${e.key}`, e.text, t, Boolean(e.error));
    if (e.kind === "note") {
      const text = e.text.length > 400 ? e.text.slice(0, 400) + "…" : e.text;
      const note = h_flex().w_full().justify_center().child(
        h_flex().gap(8).px(10).py(3).rounded(8).bg(t.surface).text_size(11.5).text_color(t.dim).child(text)
          .when(Boolean(e.summary), (el) => el.child(div().id(`sum-${e.key}`).cursor_pointer().text_color(t.accent)
            .hover((s) => s.underline())
            .on_click((_e, cx) => { this.summaryOpen = this.summaryOpen === e.key ? null : e.key; cx.notify(); })
            .child(this.summaryOpen === e.key ? "Hide summary" : "Show summary"))));
      if (!e.summary || this.summaryOpen !== e.key) return note;
      return v_flex().w_full().gap(8).child(note).child(div().w_full().px(16).py(12).rounded(12).border_1()
        .border_color(t.border).bg(t.surface).text_size(13).child(this.markdown(`summary-${e.key}`, e.summary)));
    }
    return this.tools(e, t, last);
  }

  replyCopy(e, t) {
    return h_flex().h(18).gap(4).when(this.hovered === e.key && e.key !== "streaming", (el) => el
      .child(this.tinyButton(`copya-${e.key}`, this.copied === `a-${e.key}` ? "check" : "copy", "Copy reply", (_e, cx) => this.copyOut(e.text, `a-${e.key}`, cx), t).size(18)));
  }

  thinkingView(e, t, last) {
    const id = `think-${e.key}`, open = this.open.has(id);
    const working = last && this.terminal()?.status === "working";
    return v_flex().w_full().min_w(0)
      .child(h_flex().id(id).px(4).py(3).gap(8).items_center().cursor_pointer().text_color(t.dim)
        .hover(s => s.text_color(t.muted))
        .on_click((_e, cx) => this.toggleCard(id, cx, open))
        .child(svg(`mods/chat/icons/${open ? "chevron-down" : "chevron"}.svg`).size(12).flex_none())
        .child(div().flex_none().text_size(12).child(working ? "Thinking…" : "Thought process"))
        .when(!open, el => el.child(div().flex_1().min_w(0).truncate().text_size(12).child(summaryLine(e.text)))))
      .when(open, el => el.child(div().mt(4).pl(12).border_l(2).border_color(t.border).text_size(12.5).line_height("20px").text_color(t.muted)
        .child(this.markdown(`think-md-${e.key}`, e.text))));
  }

  // Render terminal output as selectable literal text, without Markdown's
  // fenced-code frame/language badge. Long output expands explicitly.
  toggleCard(key, cx, open = this.open.has(key)) {
    open ? this.open.delete(key) : this.open.add(key);
    this.anchorCard = true;
    cx.notify();
  }

  plainOutput(id, text, t, error = false, framed = true) {
    const lines = text.split("\n"), long = lines.length > 12 || text.length > 900;
    const open = this.open.has(`output-${id}`);
    const shown = long && !open ? lines.slice(0, 12).join("\n").slice(0, 900) : text;
    const escaped = shown.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/\t/g, "    ");
    const short = !long && lines.length <= 2;
    return v_flex().w_full().min_w(0).gap(4)
      .child(div().w_full().min_w(0)
        .text_size(!framed ? 12 : short ? 12.5 : 11.5).text_color(error ? t.blocked : t.muted)
        .when(error || (!short && framed), el => el.px(12).py(8).rounded(8).bg(t.surface).border_1().border_color(error ? t.blocked : t.border))
        .when((!short || !framed) && Boolean(settings().font_family), el => el.font_family(settings().font_family))
        .child(TextView.html(id, `<pre>${escaped}</pre>`).selectable(true).text_color(error ? t.blocked : t.muted)
          .when((!short || !framed) && Boolean(settings().font_family), el => el.font_family(settings().font_family))
          .when(!framed, el => el.text_size(12).line_height("18px"))))
      .when(long, el => el.child(div().id(`expand-${id}`).w_auto().flex_none().text_size(11.5).text_color(t.dim).cursor_pointer()
        .hover(style => style.text_color(t.foreground))
        .on_click((_event, cx) => { this.toggleCard(`output-${id}`, cx, open); })
        .child(open ? "Show less" : "Show more")));
  }

  // The context, status and usage cards, as the Claude app draws them.
  card(e, t) {
    const box = (title, sub) => v_flex().w_full().max_w(620).p(14).gap(10).rounded(12).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(8).items_baseline().child(div().text_size(13).font_semibold().child(title))
        .when(Boolean(sub), (el) => el.child(div().text_size(12).text_color(t.dim).child(sub))));
    const bar = (pct, color) => div().w_full().h(6).rounded(3).bg(t.raised)
      .child(div().h_full().rounded(3).bg(color).w(`${Math.max(0, Math.min(100, pct))}%`));
    const row = (k, v) => h_flex().gap(12).text_size(12.5).child(div().w(110).flex_none().text_color(t.muted).child(k)).child(div().flex_1().min_w(0).child(String(v)));
    if (e.loading) return box(e.title ?? (e.card === "usage" ? "Usage" : e.card === "status" ? "Status" : "Context"))
      .child(h_flex().gap(8).text_size(12).text_color(t.muted).child(div().text_color(t.working).frames(SPINNER, 90)).child("Asking Claude…"));
    if (e.error) return box(e.title ?? "Usage").child(div().text_size(12).text_color(t.blocked).child(e.error));
    if (e.card === "context") {
      const COLORS = { "System prompt": t.dim, "System tools": t.muted, "MCP tools": t.ansi2, "MCP server instructions": t.ansi2, "Memory files": t.ansi3,
        "Skills": t.ansi5, "Messages": t.accent, "Custom agents": t.ansi6, "Free space": t.raised, "Autocompact buffer": t.border };
      const used = e.cats.filter((c) => !/deferred|free space|autocompact/i.test(c.name));
      const rest = e.cats.filter((c) => /free space|autocompact/i.test(c.name));
      const line = (c) => h_flex().gap(10).items_center().text_size(12.5)
        .child(div().size(9).rounded(3).flex_none().bg(COLORS[c.name] ?? t.ansi4))
        .child(div().flex_1().text_color(/free|autocompact/i.test(c.name) ? t.muted : t.foreground).child(c.name))
        .child(div().w(60).flex_none().text_color(t.muted).child(c.tokens))
        .child(div().w(48).flex_none().text_color(t.dim).child(`${c.pct}%`));
      return box("Context", e.model)
        .child(h_flex().gap(8).items_baseline().child(div().text_size(20).font_semibold().child(`${e.pct ?? 0}%`))
          .child(div().text_size(12).text_color(t.muted).child(`${e.used ?? "?"} of ${e.max ?? "?"} tokens used`)))
        .child(h_flex().w_full().h(8).rounded(4).overflow_hidden().bg(t.raised)
          .children(used.filter((c) => c.pct > 0).map((c) => div().h_full().bg(COLORS[c.name] ?? t.ansi4).w(`${Math.max(0.6, c.pct)}%`))))
        .child(v_flex().gap(5).children([...used, ...rest].map(line)));
    }
    if (e.card === "info") return this.infoView(e, box, t);
    if (e.card === "status") return box("Status").child(v_flex().gap(6).children(e.rows.map(([k, v]) => row(k, v))));
    if (e.codex !== undefined) return this.codexUsage(e.codex, box, bar, row, t);
    const u = e.usage, rl = u.rate_limits ?? {};
    const money = (m) => m ? `${m.currency === "USD" ? "$" : ""}${(m.amount_minor / 10 ** (m.exponent ?? 2)).toFixed(2)}` : "";
    // The terminal keeps the session's cost to itself; its log has the tokens.
    const models = Object.entries(this.t?.tokens ?? {});
    const k = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n ?? 0);
    const limits = [["Current session", rl.five_hour], ["This week", rl.seven_day], ["This week, Opus", rl.seven_day_opus], ["This week, Sonnet", rl.seven_day_sonnet]]
      .filter(([, v]) => v && typeof v.utilization === "number");
    const tips = u.behaviors?.day?.recommendations ?? [];
    return box("Usage", u.subscription_type ? `${u.subscription_type} plan` : null)
      .child(v_flex().gap(6)
        .when(!models.length, (el) => el.child(row("This session", "nothing yet")))
        .children(models.map(([m, x]) => row(modelName(this.current().cat?.models, m) || m, `${k(x.input)} tokens in · ${k(x.output)} out`))))
      .children(limits.map(([name, v]) => v_flex().gap(4)
        .child(h_flex().text_size(12.5).child(div().flex_1().child(name)).child(div().text_color(t.muted).child(`${Math.round(v.utilization)}%${v.resets_at ? ` · resets ${new Date(v.resets_at * (v.resets_at < 1e12 ? 1000 : 1)).toLocaleString()}` : ""}`)))
        .child(bar(v.utilization, v.utilization >= 90 ? t.blocked : t.accent))))
      .when(Boolean(rl.spend?.enabled), (el) => el.child(v_flex().gap(4)
        .child(h_flex().text_size(12.5).child(div().flex_1().child("Usage credits")).child(div().text_color(t.muted).child(`${money(rl.spend.used)} of ${money(rl.spend.limit)} · ${rl.spend.percent}%`)))
        .child(bar(rl.spend.percent, rl.spend.severity === "normal" ? t.accent : t.blocked))))
      .when(tips.length > 0, (el) => el.child(v_flex().gap(4).pt(2)
        .child(div().text_size(11.5).font_semibold().text_color(t.dim).child("Today's tips"))
        .children(tips.map((r) => div().text_size(12).text_color(t.muted).child(`${r.title}${r.detail ? ` — ${r.detail}` : ""}`)))));
  }

  infoView(e, box, t) {
    const small = (id, label, action) => div().id(id).flex_none().px(8).py(3).rounded(6).cursor_pointer().bg(t.raised).text_size(11.5)
      .hover((s) => s.bg(t.hover)).on_click(action).child(label);
    const STATUS = { connected: t.done, on: t.done, failed: t.blocked, "needs login": t.blocked, disabled: t.dim, off: t.dim, pending: t.working };
    return box(e.title)
      .when(Boolean(e.note), (el) => el.child(div().text_size(12).text_color(t.muted).child(e.note)))
      .children(e.sections.filter((x) => x.rows.length).map((sec, si) => v_flex().gap(2)
        .when(Boolean(sec.title), (el) => el.child(div().pt(4).text_size(11).font_semibold().text_color(t.dim).child(sec.title)))
        .children(sec.rows.slice(0, 80).map((r, ri) => h_flex().id(`info-${e.key}-${si}-${ri}`).px(8).py(6).gap(10).items_center().rounded(8)
          .when(Boolean(r.run), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(r.run))
          .child(v_flex().flex_1().min_w(0)
            .child(div().text_size(12.5).font_medium().truncate().child(r.label))
            .when(Boolean(r.detail), (el) => el.child(div().text_size(11.5).text_color(t.muted).truncate().child(r.detail))))
          .when(Boolean(r.status), (el) => el.child(h_flex().flex_none().gap(5).items_center().text_size(11.5).text_color(t.muted)
            .child(div().size(7).rounded_full().bg(STATUS[r.status] ?? t.dim)).child(r.status)))
          .children((r.actions ?? []).map(([label, run], ai) => small(`ia-${e.key}-${si}-${ri}-${ai}`, label, run)))))))
      .when(e.buttons.length > 0, (el) => el.child(h_flex().gap(6).flex_wrap().pt(2)
        .children(e.buttons.map(([label, run], i) => this.button(`ib-${e.key}-${i}`, label, run, t)))));
  }

  // Codex's usage: its spend limit and rate-limit windows, and this session's tokens.
  codexUsage(l, box, bar, row, t) {
    const k = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n ?? 0);
    const when = (s) => s ? ` · resets ${new Date(s * 1000).toLocaleDateString()}` : "";
    const ind = l?.individualLimit ?? l?.individual_limit;
    const windows = [["Short window", l?.primary], ["Weekly", l?.secondary]].filter(([, w]) => w && typeof (w.usedPercent ?? w.used_percent) === "number");
    const models = Object.entries(this.t?.tokens ?? {});
    return box("Usage", l?.planType ?? l?.plan_type ? `${l.planType ?? l.plan_type} plan` : null)
      .child(v_flex().gap(6)
        .when(!models.length, (el) => el.child(row("This session", "nothing yet")))
        .children(models.map(([m, x]) => row(modelName(this.current().cat?.models, m) || m, `${k(x.input)} tokens in · ${k(x.output)} out`))))
      .when(Boolean(ind), (el) => {
        const used = Number(ind.used), limit = Number(ind.limit), pct = limit ? Math.round(100 * used / limit) : 100 - (ind.remainingPercent ?? 0);
        return el.child(v_flex().gap(4)
          .child(h_flex().text_size(12.5).child(div().flex_1().child("Spend limit"))
            .child(div().text_color(t.muted).child(`$${used.toFixed(2)} of $${limit.toFixed(2)} · ${pct}%${when(ind.resetsAt)}`)))
          .child(bar(pct, pct >= 90 ? t.blocked : t.accent)));
      })
      .children(windows.map(([name, w]) => {
        const pct = w.usedPercent ?? w.used_percent;
        return v_flex().gap(4)
          .child(h_flex().text_size(12.5).child(div().flex_1().child(name)).child(div().text_color(t.muted).child(`${Math.round(pct)}%${when(w.resetsAt ?? w.resets_at)}`)))
          .child(bar(pct, pct >= 90 ? t.blocked : t.accent));
      }))
      .when(!l, (el) => el.child(div().text_size(12).text_color(t.muted).child("Codex didn't report its limits.")));
  }

  tools(e, t, last) {
    const open = this.open.has(e.key);
    const running = last && e.items.some((i) => i.result === null) && this.terminal()?.status === "working";
    const described = e.items.map(toolDetails);
    const visible = described.filter(item => item.name !== "Wait" || item.error || item.result === null);
    const items = visible.length ? visible : described;
    if (items.length === 1) return this.tool(e.key, items[0].id ?? 0, items[0], t);
    const commands = items.every(item => item.name === "Bash" || item.name === "Wait");
    const label = commands ? running ? "Running commands" : "Ran commands" : toolSummary(items, running);
    const failed = described.some((i) => i.error);
    const thumbs = e.items.flatMap((i) => i.images);
    return v_flex().w_full().gap(6)
      .child(h_flex().id(`tg-${e.key}`).gap(6).items_center().cursor_pointer().text_size(13).text_color(t.dim)
        .hover((s) => s.text_color(t.muted))
        .on_click((_ev, cx) => { this.toggleCard(e.key, cx, open); })
        .child(svg(`mods/chat/icons/${commands ? "terminal" : "edit"}.svg`).size(14).flex_none())
        .child(div().min_w(0).truncate().child(label))
        .child(svg(`mods/chat/icons/${open ? "chevron-down" : "chevron"}.svg`).size(12).flex_none())
        .when(running, (el) => el.child(div().flex_none().text_color(t.working).frames(SPINNER, 90)))
        .when(failed, (el) => el.child(div().flex_none().text_color(t.blocked).child("error"))))
      .when(!open && thumbs.length > 0, (el) => el.child(h_flex().pl(16).gap(6).children(thumbs.map((i) => this.img(i.ref, t, 312, 215)))))
      .when(open, (el) => el.children((visible.length ? visible : described).map((i, n) => this.tool(e.key, i.id ?? n, i, t))));
  }

  diffView(id, file, t) {
    const lines = diffLines(file), expanded = this.open.has(`diff-more-${id}`);
    const shown = expanded ? lines : lines.slice(0, 80);
    const colors = { added: t.ansi2, removed: t.ansi1, hunk: t.ansi6, header: t.muted, context: t.foreground };
    const escape = text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\t/g, "    ");
    return v_flex().w_full().min_w(0).gap(0).py(6).rounded(8).border_1().border_color(t.border).bg(t.background)
      .children(diffGroups(shown).map((group, index) => div().w_full().min_w(0).px(10)
        .child(TextView.html(`diff-${id}-${index}`, `<pre>${escape(group.text)}</pre>`).selectable(true)
          .text_size(12).line_height("18px").text_color(colors[group.kind])
          .when(Boolean(settings().font_family), el => el.font_family(settings().font_family)))))
      .when(lines.length > 80, el => el.child(div().id(`diff-expand-${id}`).px(10).py(5).text_size(11.5).text_color(t.muted).cursor_pointer()
        .hover(style => style.text_color(t.foreground)).on_click((_event, cx) => this.toggleCard(`diff-more-${id}`, cx))
        .child(expanded ? "Show less" : `Show more (${lines.length - 80} lines)`)));
  }

  openChanges(entry, cx, index = 0) {
    const file = entry.files[index];
    this.openFilePreview(file.path, cx, file, entry.files, !sidebarVisible(layout()));
  }

  changeHover(id, trigger, file, entryKey, t) {
    if (sidebarVisible(layout())) return trigger;
    this.diffHoverGeometry ??= {};
    const side = Math.max(18, Math.round((this.width - 900) / 2) + 16);
    const width = this.changeWidths?.[entryKey] ?? Math.max(200, this.width - 2 * side);
    const geometry = this.diffHoverGeometry[id] ?? {anchor:"top_left", width:width-24, height:320};
    trigger.on_mouse_move((event, cx) => {
      const viewport = this.chatBounds ?? {y:0,height:this.viewH || 600};
      const next = hoverGeometry(event.bounds, viewport, width);
      if (JSON.stringify(next) !== JSON.stringify(this.diffHoverGeometry[id])) { this.diffHoverGeometry[id] = next; cx.notify(); }
    });
    const colors = {added:t.ansi2,removed:t.ansi1,hunk:t.ansi6,header:t.muted,context:t.foreground};
    const escape = text => text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const lines = diffLines(file), groups = diffGroups(lines);
    const content = v_flex().w(geometry.width).max_h(geometry.height).rounded(10).border_1().border_color(t.input).bg(t.popover).shadow_lg().overflow_hidden()
      .on_scroll_wheel((_event,cx) => cx.stop_propagation())
      .child(div().h(36).flex_none().px(12).flex().items_center().text_size(12).font_semibold().child(file.path.split(/[\\/]/).at(-1)))
      .child(v_flex().id(`hover-scroll-${id}`).h(Math.min(Math.max(64,geometry.height-38),Math.max(80,lines.length*18+16))).flex_none().overflow_y_scrollbar().py(8)
        .children(groups.map((group,index) => div().px(10).w_full().min_w(0).flex_none()
          .child(TextView.html(`hover-diff-${id}-${index}`,`<pre>${escape(group.text)}</pre>`).selectable(true).text_size(12).line_height("18px").text_color(colors[group.kind])
            .when(Boolean(settings().font_family),el=>el.font_family(settings().font_family))))));
    return HoverCard.new(`diff-hover-${id}`).w_auto().self_start().flex_none()
      .open_delay(250).close_delay(250).anchor(geometry.anchor).trigger(trigger).content(content);
  }

  changeBlock(entry, t) {
    const overview = changeOverview(entry.files), listKey = `file-list-${entry.key}`;
    const expanded = this.open.has(listKey), files = expanded ? entry.files : entry.files.slice(0,3);
    const stats = (added,removed) => h_flex().gap(6).flex_none().text_size(12.5)
      .when(added!=null,el=>el.child(div().text_color(t.done).child(`+${added}`)))
      .when(removed!=null,el=>el.child(div().text_color(t.ansi1).child(`−${removed}`)));
    const title = div().id(`preview-change-${entry.key}`).w_auto().self_start().flex_none().truncate().text_size(14).font_semibold().cursor_pointer()
      .when(entry.files.length===1,el=>el.hover(style=>style.text_color(t.accent)))
      .on_click((_event,cx)=>this.openChanges(entry,cx))
      .child(entry.files.length===1?`${entry.files[0].operation==='delete'?'Deleted':entry.files[0].operation==='add'?'Added':'Edited'} ${overview.labels[0]}`:`Edited ${entry.files.length} files`);
    const chrome = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(t.chrome) ? `${t.chrome.slice(0,7)}99` : t.chrome;
    let heading = h_flex().id(`change-heading-${entry.key}`).w_full().px(12).py(12).gap(10).items_center()
      .bg(chrome).rounded_t(11).when(entry.files.length===1,el=>el.rounded_b(11))
      .child(div().size(36).flex_none().rounded(10).when(settings().dark,el=>el.bg(t.chrome)).flex().items_center().justify_center()
        .child(svg("mods/chat/icons/edit.svg").size(20).text_color(t.muted)))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(h_flex().w_full()
          .child(entry.files.length===1?this.changeHover(`heading-${entry.key}`,title,entry.files[0],entry.key,t):title)
          .child(div().flex_1()))
        .child(stats(overview.added,overview.removed)))
      .child(div().id(`diff-toggle-${entry.key}`).flex_none().h(28).px(12).rounded_full().border(0.5)
        .border_color(settings().dark?t.input:t.border).flex().items_center().justify_center()
        .cursor_pointer().text_size(12).text_color(t.foreground)
        .hover(style=>style.text_color(t.accent)).on_click((_event,cx)=>this.openChanges(entry,cx)).child("View changes"));
    return v_flex().w_full().min_w(0).rounded(12).border(0.5).border_color(t.border).overflow_hidden()
      .on_size_change((size,cx)=>{this.changeWidths??={};if(this.changeWidths[entry.key]!==size.width){this.changeWidths[entry.key]=size.width;cx.notify();}})
      .child(heading)
      .when(entry.files.length>1,el=>el.child(v_flex().border_t(settings().dark ? 1 : 0.5).border_color(t.border)
        .children(files.map((file,index)=>{
          const id=`${entry.key}-${index}`;
          const row=h_flex().id(`file-${id}`).px(12).py(8).gap(8).items_center()
            .when(index===files.length-1&&(entry.files.length<=3||expanded),el=>el.rounded_b(11))
            .child(this.changeHover(id,div().w_auto().min_w(0).flex_none().truncate().text_size(13).cursor_pointer()
              .hover(style=>style.text_color(t.accent)).on_click((_event,cx)=>this.openChanges(entry,cx,index))
              .child(overview.labels[index]),file,entry.key,t))
            .child(div().flex_1())
            .child(stats(file.added,file.removed));
          return row;
        }))))
      .when(entry.files.length>3,el=>el.child(h_flex().id(`more-${entry.key}`).px(12).py(9).gap(8).items_center().border_t(settings().dark ? 1 : 0.5).border_color(t.border).rounded_b(11).cursor_pointer()
        .hover(style=>style.bg(t.hover)).text_size(12.5).on_click((_event,cx)=>this.toggleCard(listKey,cx))
        .child(expanded?"Show fewer files":`Show ${entry.files.length-3} more files`).child(div().child(expanded?"▴":"▾"))));
  }

  shellDetails(id, item, t, running) {
    const command = typeof item.displayInput === "string" ? item.displayInput : item.input?.cmd ?? item.input?.command ?? item.summary;
    const pendingOutput = item.sessionId != null && item.exitCode == null;
    return v_flex().w_full().min_w(0).mt(6).px(12).py(10).gap(8).rounded(12)
      .border(0.5).border_color(item.error ? t.blocked : t.input).bg(t.surface)
      .child(div().text_size(12).text_color(t.muted).child("Shell"))
      .child(this.plainOutput(`${id}-command`, `$ ${command ?? ""}`, { ...t, muted: t.foreground }, false, false))
      .when(Boolean(item.result?.trim()), el => el.child(div().w_full().min_w(0).pt(8).border_t(1).border_color(t.border)
        .child(this.plainOutput(`${id}-shell-output`, item.result, t, item.error, false))))
      .child(h_flex().justify_end().text_size(11.5).text_color(item.error ? t.blocked : t.dim)
        .child(item.error ? `✕ Failed${item.exitCode != null ? ` · exit ${item.exitCode}` : ""}`
          : running ? "Running…" : pendingOutput ? "Output pending" : item.result === null ? "Pending" : "✓ Success"));
  }

  planView(id, i, t) {
    return v_flex().id(`${id}-plan`).w_full().min_w(0).mt(6).px(12).py(10).gap(6).rounded(12).border(0.5).border_color(t.input).bg(t.surface)
      .when(Boolean(i.planExplanation), el => el.child(div().text_size(12).text_color(t.muted).child(i.planExplanation)))
      .children(i.todos.map(todo => {
        const done = todo.status === "completed";
        const active = todo.status === "in_progress";
        return h_flex().gap(8).items_center().text_size(12.5)
          .child(div().flex_none().w(14).text_color(done ? t.done : active ? t.accent : t.dim)
            .child(done ? "✓" : active ? "▸" : "○"))
          .child(div().flex_1().min_w(0)
            .when(done, d => d.text_color(t.dim).line_through())
            .when(active, d => d.font_medium().text_color(t.foreground))
            .when(!done && !active, d => d.text_color(t.muted))
            .child(active && todo.activeForm ? todo.activeForm : todo.text));
      }));
  }

  tool(key, n, i, t) {
    i = i.changes ? i : toolDetails(i);
    const id = `tool-${key}-${n}`, open = this.open.has(id);
    const running = i.result === null && this.terminal()?.status === "working";
    const isPlan = i.name === "Plan" && Boolean(i.todos?.length);
    return v_flex().w_full().min_w(0)
      .when(i.error, el => el.rounded(8).border_1().border_color(t.blocked))
      .child(h_flex().id(id).px(4).py(3).gap(8).items_center().cursor_pointer().text_color(t.muted)
        .hover(style => i.name === "Bash" ? style.text_color(t.foreground) : style.bg(t.hover))
        .on_click((_event, cx) => { this.toggleCard(id, cx, open); })
        .child(svg(`mods/chat/icons/${i.name === "Edit" ? "edit" : i.name === "Bash" || i.name === "Wait" ? "terminal" : i.name === "Plan" ? "scroll" : /search|grep|glob/i.test(i.name) ? "search" : "plug"}.svg`).size(14).flex_none())
        .child(div().flex_none().text_size(12.5).child(i.name === "Edit" ? i.error ? "Edit failed" : i.result === null ? "Editing" : "Edited" : i.name === "Bash" ? i.error ? "Command failed" : i.result === null ? "Running" : "Ran" : i.name))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).child(i.name === "Bash" ? commandPreview(i.displayInput ?? i.summary) : summaryLine(i.summary)))
        .when(i.changes?.length === 1 && i.changes[0].added != null && !i.error, el => el
          .child(div().text_size(11.5).text_color(t.done).child(`+${i.changes[0].added}`))
          .child(div().text_size(11.5).text_color(t.ansi1).child(`−${i.changes[0].removed ?? 0}`)))
        .when(running, el => el.child(div().text_size(12).text_color(t.dim).frames(SPINNER, 90)))
        .when(!running && (i.error || i.result === null), el => el.child(div().text_size(11).text_color(i.error ? t.blocked : t.dim).child(i.error ? "Error" : "Pending")))
        .child(svg(`mods/chat/icons/${open ? "chevron-down" : "chevron"}.svg`).size(12).flex_none()))
      .when(open && isPlan, el => el.child(this.planView(id, i, t)))
      .when(open && i.name === "Bash", el => el.child(this.shellDetails(id, i, t, running)))
      .when(open && !isPlan && i.name !== "Bash", el => el.child(v_flex().w_full().min_w(0).mt(6).px(12).py(10).gap(8)
        .rounded(12).border(0.5).border_color(i.error ? t.blocked : t.input).bg(t.surface)
        .when(i.input != null, row => row.child(v_flex().gap(4)
          .child(div().text_size(11).text_color(t.dim).child("Input"))
          .child(this.plainOutput(`${id}-input`, typeof i.displayInput === "string" ? i.displayInput
            : i.displayInput?.command ?? i.displayInput?.cmd ?? JSON.stringify(i.displayInput, null, 2), t, false, false))))
        .when(Boolean(i.result?.trim()), row => row.child(v_flex().gap(4)
          .child(div().text_size(11).text_color(t.dim).child("Output"))
          .child(this.plainOutput(`${id}-result`, i.result, t, i.error, false))))
        .when(i.images.length > 0, row => row.child(h_flex().flex_wrap().gap(6)
          .children(i.images.map(image => this.img(image.ref, t, 420, 300)))))))
      .when(open && i.displayInput !== i.input, el => el.child(v_flex().px(12).pb(8).gap(4)
        .child(this.button(`raw-${id}`, this.open.has(`raw-${id}`) ? "Hide raw details" : "Raw details", (_e, cx) => {
          this.toggleCard(`raw-${id}`, cx);
        }, t).w_auto().self_start().bg(t.background).text_color(t.dim).px(0).py(2))
        .when(this.open.has(`raw-${id}`), row => row.child(this.plainOutput(`${id}-raw`,
          typeof i.input === "string" ? i.input : JSON.stringify(i.input, null, 2), t, false, false)))))
      .when(i.images.length > 0 && (!open || i.name === "Bash"), el => el.child(h_flex().px(12).pb(10).flex_wrap().gap(6)
        .children(i.images.map(image => this.img(image.ref, t, 420, 300)))));
  }

  // Model and effort picks, for a new chat or the running one.
  modelChips(prefix, cat, model, effort, pick, t) {
    const efforts = cat?.models.find((m) => m.id === model)?.efforts ?? [];
    const label = (text) => div().w(52).flex_none().pt(5).text_size(12).text_color(t.dim).child(text);
    return v_flex().gap(8)
      .child(h_flex().gap(8).items_start().child(label("Model"))
        .child(h_flex().flex_1().gap(6).flex_wrap()
          .when(Boolean(cat?.loading), (el) => el.child(div().text_size(12).text_color(t.dim).child("…")))
          .children((cat?.models ?? []).map((m) => this.chip(`${prefix}-m-${m.id}`, m.name, m.id === model, (_e, cx) => pick(m.id, null, cx), t)))))
      .when(efforts.length > 0, (el) => el.child(h_flex().gap(8).items_start().child(label("Effort"))
        .child(h_flex().flex_1().gap(6).flex_wrap()
          .children(efforts.map((e) => this.chip(`${prefix}-e-${e}`, e, e === effort, (_ev, cx) => pick(null, e, cx), t))))));
  }

  newChat(t) {
    const { kind, machine } = this.cfg;
    const cat = this.loadCatalogCached(kind, machine);
    const model = this.cfg.model ?? cat?.model, effort = this.cfg.effort ?? cat?.effort;
    const folder = this.cfg.folder || this.defaultFolder(machine) || "~";
    const others = machines().filter((m) => m.name && m.layout === "ready").map((m) => m.name);
    const recent = (shared("chat.recent") ?? []).filter((r) => r.machine === machine && r.folder && r.folder !== folder);
    const running = terminals().filter((x) => agentKind(x) && x.state === "live");
    const label = (text) => div().pt(6).text_size(12).font_semibold().text_color(t.muted).child(text);
    const form = v_flex().w_full().max_w(640).gap(10)
      .child(div().text_size(18).font_semibold().child(this.starting ? "Starting…" : "New chat"))
      .child(label("Agent"))
      .child(h_flex().gap(6).children(Object.entries(AGENTS).map(([k, name]) => this.chip(`agent-${k}`, name, k === kind, (_e, cx) => {
        this.cfg = { ...this.cfg, kind: k, model: null, effort: null };
        this.loadCatalog(k, machine, cx);
        cx.notify();
      }, t))))
      .when(others.length > 0, (el) => el.child(label("Machine")).child(h_flex().gap(6).flex_wrap()
        .children([null, ...others].map((m) => this.chip(`machine-${m ?? "here"}`, m ?? "This computer", m === machine, (_e, cx) => {
          this.cfg = { ...this.cfg, machine: m, folder: null, model: null, effort: null };
          this.loadCatalog(this.cfg.kind, m, cx);
          cx.notify();
        }, t)))))
      .child(label("Folder"))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().px(10).py(6).rounded(8).bg(t.surface).border_1().border_color(t.border).text_size(12.5).child(tilde(folder)))
        .when(!machine, (el) => el.child(this.button("pick-folder", "Choose…", (_e, cx) => cx.spawn(async (cx) => {
          const f = await pickFolder({ prompt: "Where should the agent work?" });
          if (f) { this.cfg = { ...this.cfg, folder: f }; cx.notify(); }
        }), t))))
      .when(recent.length > 0, (el) => el.child(h_flex().gap(6).flex_wrap().children(recent.map((r, n) =>
        this.chip(`recent-${n}`, tilde(r.folder) || "~", false, (_e, cx) => { this.cfg = { ...this.cfg, folder: r.folder }; cx.notify(); }, t)))))
      .child(label("Model and effort"))
      .child(this.modelChips("new", cat, model, effort, (m, e, cx) => {
        if (m) this.cfg = { ...this.cfg, model: m };
        if (e) this.cfg = { ...this.cfg, effort: e };
        cx.notify();
      }, t))
      .child(div().pt(4).text_size(12).text_color(t.dim).child("Type your first message below, or press Start to begin without one."))
      .when(running.length > 0, (el) => el.child(label("Or continue a running agent")).children(running.map((a) =>
        h_flex().id(`pick-${a.address}`).gap(8).px(10).py(7).rounded(8).cursor_pointer().bg(t.surface).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.openBeside(a.address, cx))
          .child(div().flex_none().font_semibold().text_size(12.5).child(AGENTS[agentKind(a)]))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(`${a.title || a.address} · ${tilde(a.foreground?.cwd ?? a.cwd ?? "")}`)))));
    return div().id("new-scroll").flex_1().min_h(0).overflow_y_scrollbar()
      .child(h_flex().w_full().justify_center().px(24).py(24).child(form));
  }

  header(term, t) {
    return v_flex().flex_none()
      .when(Boolean(this.searching) && (this.shown(), true), (el) => el.child(h_flex().id("search-bar").key_context("ChatSearch")
        .on_action("chat_search_close", (_e, cx) => this.closeSearch(cx))
        .h(38).px(12).gap(8).items_center().border_t(1).border_color(t.border).bg(t.background)
        .child(div().flex_1().child(Input.new(this.search).w_full().h(28).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.5)))
        .child(div().flex_none().text_size(12).text_color(t.dim).child(this.search.value().trim() ? `${this.matches ?? 0} match${this.matches === 1 ? "" : "es"}` : ""))
        .child(div().id("search-close").flex_none().px(6).py(2).rounded(5).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.closeSearch(cx)).child("×"))));
  }

  // The permission mode, left of the model: a button whose menu
  // opens upward. The riskier modes show in the warning color.
  modeMenu(term, t) {
    const { kind, mode } = this.current();
    if (!kind) return div();
    const modes = modesOf(kind);
    const now = modes.find((m) => m.id === mode);
    const risky = mode === "bypassPermissions" || mode === "full";
    const busy = kind === "codex" && term?.status === "working";
    const item = (m) => h_flex().id(`pm-${m.id}`).px(10).py(5).gap(8).rounded(6).text_size(12.5).text_color(busy ? t.dim : t.foreground)
      .when(!busy, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.showModes = false; this.setMode(m, cx); cx.notify(); }))
      .child(div().w(12).flex_none().text_color(t.accent).child(m.id === mode ? "✓" : ""))
      .child(v_flex().flex_1().min_w(0).child(div().child(m.label)).child(div().text_size(11).text_color(t.dim).child(m.desc)));
    const menu = v_flex().w(300).p(4).rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_lg()
      .child(div().px(10).pt(8).pb(4).text_size(11).font_semibold().text_color(t.dim).child("Permissions"))
      .children(modes.map(item))
      .when(busy, (el) => el.child(div().px(10).py(6).text_size(11).text_color(t.dim).child("Codex can switch once it stops working.")));
    return Popover.new("mode-menu").anchor("bottom_right").open(Boolean(this.showModes))
      .on_open_change((open, cx) => { this.showModes = open; if (open) this.readMode(cx); cx.notify(); })
      .trigger(div().id("mode").flex_none().h(30).px(10).flex().items_center().gap(5).rounded_full().cursor_pointer().text_size(12.5)
        .when(Boolean(this.showModes), (el) => el.bg(t.hover))
        .text_color(risky ? t.blocked : this.showModes ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover).text_color(risky ? t.blocked : t.foreground))
        .child(div().child(now?.label ?? "Permissions")).child(svg("mods/chat/icons/chevron-down.svg").size(12).flex_none().self_center().text_color(t.muted)))
      .content(menu);
  }

  // The model and effort of the running session: a button in the message bar
  // whose menu opens upward.
  modelMenu(term, t) {
    const { kind, cat, model, effort } = this.current();
    const name = [modelName(cat?.models, model), effort].filter(Boolean).join(" · ");
    if (!name) return div();
    const label = h_flex().gap(5).items_center()
      .child(div().max_w(180).truncate().text_color(t.foreground).child(modelName(cat?.models, model)))
      .child(div().w(52).flex_none().text_color(t.dim).child(effort ?? ""))
      .child(div().size(12).flex_none().flex().items_center().justify_center().text_color(t.muted)
        .child(this.switching ? div().frames(SPINNER, 90)
          : svg("mods/chat/icons/chevron-down.svg").size(12)));
    const efforts = cat?.models.find((m) => m.id === model)?.efforts
      ?? (kind === "claude" ? CLAUDE_EFFORTS : []);
    const pick = (m, e) => (_ev, cx) => { this.showModels = false; this.applyModel(m, e, cx, term); };
    const heading = (text) => div().px(10).pt(8).pb(4).text_size(11).font_semibold().text_color(t.dim).child(text);
    const item = (id, text, selected, action) => h_flex().id(id).px(10).py(5).gap(8).rounded(6).cursor_pointer().text_size(12.5)
      .text_color(t.foreground).hover((s) => s.bg(t.hover)).on_click(action)
      .child(div().w(12).flex_none().text_color(t.accent).child(selected ? "✓" : ""))
      .child(div().flex_1().child(text));
    const menu = v_flex().w(240).p(4).rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_lg()
      .child(heading("Model"))
      .children((cat?.models ?? []).map((m) => item(`mm-${m.id}`, m.name, m.id === model, pick(m.id, null))))
      .when(efforts.length > 0, (el) => el.child(div().h(1).mx(6).my(4).bg(t.border)).child(heading("Effort"))
        .children(efforts.map((e) => item(`me-${e}`, e, e === effort, pick(null, e)))))
      .when(term?.status === "working", (el) => el.child(div().px(10).py(6).text_size(11).text_color(t.dim).child("The agent is busy; a switch waits in its queue.")));
    return Popover.new("model-menu").anchor("bottom_right").open(Boolean(this.showModels))
      .on_open_change((open, cx) => { this.showModels = open; cx.notify(); })
      .trigger(div().id("model").flex_none().h(30).px(10).flex().items_center().rounded_full().cursor_pointer().text_size(12.5)
        .when(Boolean(this.showModels), (el) => el.bg(t.hover)).text_color(this.showModels ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(this.switching ? "Applying model settings…" : name).child(label))
      .content(menu);
  }

  body(t) {
    this.settle();
    const { start, ents } = this.shown();
    const shown = ents.slice(start);
    const streamText = this.streamShown();
    if (this.tracer?.isEnabled() && (this.t?.kind ?? agentKind(this.terminal())) === "codex") {
      const tail = shown.slice(-3).map((e) => `${e.key}:${e.kind}:${e.text?.length ?? e.items?.length ?? 0}`).join(",");
      const pendingSig = this.pending.map((p) => `${p.delivering ? 1 : 0}:${p.seenWorking ? 1 : 0}:${p.text?.length ?? 0}`).join(",");
      const sig = `${tail}|s:${streamText?.length ?? 0}|r:${this.running?.title ?? ""}|p:${pendingSig}|st:${this.t?.codexTurn?.stage ?? ""}:${this.t?.codexTurn?.epoch ?? 0}`;
      this.tracer.record("render_sig", {
        sig,
        streamLen: streamText?.length ?? 0,
        hasRun: Boolean(this.running),
        pending: this.pending.length,
        stage: this.t?.codexTurn?.stage ?? null,
      });
    }
    const copyAtChange = new Map(), deferCopy = new Set();
    for (let index = 0; index < shown.length; index++) {
      if (shown[index].kind !== "changes") continue;
      const reply = shown.slice(0, index).reverse().find(entry => entry.kind === "assistant" || entry.kind === "user");
      if (reply?.kind === "assistant") { copyAtChange.set(shown[index].key, reply); deferCopy.add(reply.key); }
    }
    const rendered = withPending(shown, this.pending);
    const lastRendered = rendered.at(-1);
    const streamMt = !lastRendered ? 0 : ["assistant", "tools", "thinking"].includes(lastRendered.kind) ? 8 : 18;
    const runMt = streamText ? 8 : streamMt;
    // The conversation sits in a centered column as wide as the message card.
    const side = Math.max(18, Math.round((this.width - 900) / 2) + 16);
    const content = v_flex().id("content").absolute().left(0).right(0).top(this.contentH > 0 ? this.viewH - this.contentH + this.off : 0).px(side).py(24).gap(0)
      .on_size_change((size, cx) => {
        if (size.height === this.contentH) { this.anchorCard = false; return; }
        // Position from the measured top, not the new bottom: height changes
        // must not move the whole page for a frame before this correction.
        if ((this.off > 0 || this.anchorCard) && this.contentH > 0 && !this.earlier) this.off += size.height - this.contentH;
        this.anchorCard = false;
        this.earlier = false;
        this.grew = false;
        this.contentH = size.height;
        this.clamp();
        cx.notify();
      })
      .when(start > 0, (el) => el.child(h_flex().w_full().justify_center().child(
        div().id("earlier").px(10).py(4).rounded(8).cursor_pointer().bg(t.surface).text_size(12).text_color(t.muted)
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.earlier = true; this.limit += PAGE; this.cacheShown(cx); cx.notify(); })
          .child(`Show earlier (${start})`))))
      .when(start === 0 && Boolean(this.truncated), (el) => el.child(h_flex().w_full().justify_center()
        .child(div().id("load-earlier-history").px(10).py(4).rounded(8).cursor_pointer().bg(t.surface).text_size(12).text_color(t.muted)
          .hover(style => style.bg(t.hover)).on_click((_e, cx) => this.loadEarlier(cx))
          .child(this.historyLoading ? "Loading earlier history…" : "Load earlier history"))))
      .children(rendered.map((entry, index, entries) => {
        const previous = entries[index - 1];
        const tight = previous && ((["assistant", "tools", "thinking"].includes(previous.kind) && ["assistant", "tools", "thinking"].includes(entry.kind)) || entry.kind === "changes");
        const completed = entry.kind === "notice" && entry.event === "completed";
        const copyReply = copyAtChange.get(entry.key);
        return v_flex().w_full().mt(index ? completed ? 0 : tight ? 8 : 18 : 0).child(entry.kind === "pending"
          ? this.queued(entry.message, entry.index, t) : copyReply
            ? v_flex().id(`copy-after-${entry.key}`).w_full().on_hover(this.hover(copyReply.key))
              .child(this.entry(entry, t, index === entries.length - 1, entries[index + 1]?.kind))
              .child(this.replyCopy(copyReply, t))
            : this.entry(entry, t, index === entries.length - 1,
              deferCopy.has(entry.key) ? "changes" : entries[index + 1]?.kind));
      }))
      .when(Boolean(streamText), (el) => el.child(v_flex().w_full().mt(streamMt).child(this.entry({ kind: "assistant", text: streamText, key: "streaming" }, t, true))))
      .when(Boolean(this.running), (el) => el.child(v_flex().w_full().mt(runMt).child(this.runningView(t))))
;

    const scroll = div().id("scroll").relative().flex_1().min_h(0).overflow_hidden()
      .on_size_change((size, cx) => {
        if (this.viewH === size.height && this.width === size.width) return;
        this.viewH = size.height; this.width = size.width; this.clamp(); cx.notify();
      })
      .on_mouse_move(event => { this.chatBounds = event.bounds; })
      .on_scroll_wheel((e, cx) => { this.off += e.delta.y; this.clamp(); cx.notify(); })
      .child(content);

    // A thin scroll thumb, and a way back to the newest message.
    const max = this.contentH - this.viewH;
    if (max > 4 && this.viewH > 0) {
      const thumb = Math.max(24, this.viewH * this.viewH / this.contentH);
      const top = (1 - this.off / max) * (this.viewH - thumb);
      scroll.child(div().absolute().right(3).top(top).w(4).h(thumb).rounded(2).bg(t.border));
    }
    if (this.off > 40) {
      scroll.child(div().id("latest").absolute().bottom(12).right(16).px(10).py(5).rounded(12).cursor_pointer()
        .bg(t.popover).border_1().border_color(t.border).text_size(12).text_color(t.foreground)
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.off = 0; cx.notify(); }).child("↓ Latest"));
    }
    if (!this.t && !this.pending.length) {
      const term = this.terminal(), name = AGENTS[agentKind(term)] ?? "The agent";
      const asking = Boolean(this.screen) && (term?.status === "blocked" || Boolean(parsePrompt(this.screen)));
      const msg = this.error
        ?? (this.waitingForLog ? "Waiting for the session log. You can send a message below."
          : !term ? "This chat's agent has ended." : asking ? `${name} needs an answer before it starts:`
          : term.status === "working" ? `${name} is working…`
          : this.missing ? `${name} is ready. Type your first message below.` : "Loading…");
      scroll.child(v_flex().absolute().inset_0().items_center().justify_center().gap(14).p(24)
        .child(div().text_color(t.dim).child(msg))
        .when(asking, (el) => el.child(div().w_full().max_w(720)
          .child(this.promptBox("The agent is asking:", t)))));
    }
    const panel = typeof this.panelView === "function" ? this.panelView(t) : null;
    const slash = typeof this.slash === "function" ? this.slash() : null;
    const emoji = !panel && !slash && typeof this.emojiMenu === "function" ? this.emojiMenu() : null;
    const mention = !panel && !slash && !emoji && typeof this.mentionMenu === "function" ? this.mentionMenu() : null;
    const overlay = panel ?? (slash ? h_flex().w_full().justify_center().child(this.commandMenu(t))
      : emoji ? h_flex().w_full().justify_center().child(this.emojiView(t))
      : mention ? h_flex().w_full().justify_center().child(this.mentionView(t))
      : null);
    if (overlay) {
      scroll.child(div().absolute().left(16).right(16).bottom(8)
        .on_scroll_wheel((_e, cx) => cx.stop_propagation())
        .child(overlay));
    }
    return scroll;
  }

  // A question on the agent's terminal: its text, and its choices as buttons
  // that move the selection there and confirm. Without a menu, the screen itself.
  promptBox(title, t) {
    const form = this.idleAsk === "form";
    const q = form ? null : parsePrompt(this.screen);
    const hasCustom = Boolean(q?.options?.some((o) => /^(?:type something|other)\b/i.test(o)));
    const key = (k, label) => this.button(`key-${k}`, label, () => hc(["keys", this.term, k]), t);
    const mono = settings().font_family;
    const lines = (this.screen ?? "").split("\n").filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim()));
    return v_flex().p(12).gap(10).rounded(10).border_1().border_color(t.blocked).bg(t.background)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().font_semibold().text_size(12.5).text_color(t.blocked).child(title))
        .child(this.button("go-term2", "Show terminal", (_e, cx) => this.showTerminal(cx), t)))
      .when(Boolean(q?.question), (el) => el.child(div().text_size(12.5).child(this.markdown("question", q.question))))
      .when(Boolean(q), (el) => el.child(v_flex().gap(6).children(q.options.map((o, n) =>
        h_flex().id(`choice-${n}`).px(12).py(8).gap(10).rounded(8).cursor_pointer().border_1()
          .border_color(n === q.selected ? t.accent : t.border).bg(n === q.selected ? t.selected : t.surface)
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => {
            if (q.multi && q.boxes?.[n]) {
              hc(["keys", this.term, ...toggleChoice(q.selected, n)]);
              q.selected = n;
              q.checked[n] = !q.checked[n];
            } else {
              hc(["keys", this.term, ...choose(q.selected, n)]);
              this.screenSeq++; this.screen = this.idleAsk = null;
            }
            cx.notify();
          })
          .child(div().flex_none().w(16).text_color(q.multi && q.boxes?.[n] && q.checked?.[n] ? t.accent : t.dim)
            .child(q.multi && q.boxes?.[n] ? (q.checked?.[n] ? "☑" : "☐") : String(n + 1)))
          .child(div().flex_1().text_size(12.5).child(o)))))
        .when(hasCustom && Boolean(this.promptInput), (row) => row.child(h_flex().gap(6).items_center()
          .child(div().flex_1().child(Input.new(this.promptInput).text_size(12.5)))
          .child(this.button("choice-custom-send", "Send", (_e, cx) => {
            const v = this.promptInput.value().trim();
            if (!v) return;
            this.promptInput.set_value("");
            this.submitCustomPrompt(v, cx);
          }, t)))))
      .when(!q && lines.length > 0, (el) => el.child(div().text_size(11.5).text_color(t.muted)
        .when(Boolean(mono), (d) => d.font_family(mono))
        .child(this.markdown("screen", "~~~~text\n" + lines.slice(-24).join("\n") + "\n~~~~"))))
      .child(h_flex().gap(6).flex_wrap()
        .when(!q, (el) => el.child(key("up", "↑")).child(key("down", "↓"))
          .when(form, (el) => el.child(key("left", "←")).child(key("right", "→")))
          .child(key("enter", "Enter")))
        .when(Boolean(q?.multi), (el) => el.child(key("space", "Toggle")).child(key("enter", "Submit")))
        .child(key("esc", "Esc")));
  }

  contextBadge(t) {
    const limits = normalizeRateLimits(this.t?.limits) ?? normalizeRateLimits(this.rateLimits);
    if (!limits) return null;
    const resetText = (at) => {
      if (!at) return "";
      const ms = typeof at === "number" ? at * (at < 1e12 ? 1000 : 1) : Date.parse(at);
      return Number.isFinite(ms) ? ` · resets ${new Date(ms).toLocaleString()}` : "";
    };
    const ringColor = (pct, normal) => pct >= 90 ? t.blocked : pct >= 75 ? t.working : normal;
    const badge = (id, pct, normal, tip, onClick) => {
      const color = ringColor(pct, normal);
      return h_flex().id(id).px(3).py(3).items_center().rounded(6)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip(tip)
        .on_click(onClick)
        .child(ringIcon(pct, color, t.border));
    };
    const items = [];
    if (limits.fiveHour) {
      const { pct, resetsAt } = limits.fiveHour;
      items.push(badge("limit-5h-badge", pct, t.accent,
        `5h limit: ${pct}% used${resetText(resetsAt)}`,
        (_e, cx) => this.hostCard("usage", cx)));
    }
    if (limits.sevenDay) {
      const { pct, resetsAt } = limits.sevenDay;
      items.push(badge("limit-7d-badge", pct, t.muted,
        `7d limit: ${pct}% used${resetText(resetsAt)}`,
        (_e, cx) => this.hostCard("usage", cx)));
    }
    return items.length ? h_flex().id("usage-badges").gap(2).items_center().children(items) : null;
  }

  // The message box: one card with the text on top and its controls under it.
  footer(term, t) {
    const status = term?.status;
    const working = status === "working";
    const inlineQueue = working && !this.dialog && this.outbox.visibleItems.length > 0
      && !Boolean(this.outboxExpanded ?? this.outbox.visibleItems.some(item => item.state === "error"));
    const typed = Boolean(this.input.value().trim()) || this.attach.length > 0;
    // A command chosen from the menu: what it takes, under the message box.
    const chosen = !this.dialog && !this.slash() && this.input.content().tokens.length > 0 ? this.typedCommand() : null;
    const stop = working && !typed && !this.dialog;
    const ctxBadge = !this.dialog ? this.contextBadge(t) : null;
    const showWorkingRow = working && (!this.running || inlineQueue || (term.report?.msg && term.report.msg !== this.running.title));
    const icon = (id, text, action, on) => div().id(id).flex_none().size(30).rounded_full().flex().items_center().justify_center()
      .cursor_pointer().text_size(16).text_color(t.muted).when(Boolean(on), (el) => el.bg(t.hover))
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(action).child(text);
    const card = v_flex().w_full().max_w(900).rounded(18).border(0.5).border_color(this.inputFocused ? t.input : t.border)
      .bg(settings().dark ? t.background : "#00000000").when(settings().dark, el => el.shadow_sm())
      .when(this.attach.length > 0, (el) => el.child(h_flex().px(12).pt(12).gap(8).flex_wrap().children(this.attach.map((a, n) =>
        div().relative()
          .child(a.image ? this.img(a.image.ref, t, 144, 108) : div().px(10).py(8).rounded(8).bg(t.raised).text_size(11.5).child(a.name))
          .child(div().id(`rm-${n}`).absolute().top(-6).right(-6).size(18).rounded_full().flex().items_center().justify_center()
            .bg(t.foreground).text_color(t.background).text_size(11).cursor_pointer().hover((s) => s.opacity(0.8))
            .on_click((_e, cx) => { this.attach.splice(n, 1); cx.notify(); }).child("×"))))))
      .child(div().id("composer").w_full()
        .when(Boolean(this.slash()), (el) => el.key_context(this.slash().nav ? "ChatMenuNav" : "ChatMenu"))
        .when(!this.slash() && (Boolean(this.emojiMenu()) || Boolean(this.mentionMenu())), (el) => el.key_context("ChatMenu"))
        .when(!this.slash() && this.panelLive(), (el) => el.key_context("ChatPanel"))
        .on_action("chat_menu_up", (_e, cx) => this.menuKey({ keystroke: "up" }, cx))
        .on_action("chat_menu_down", (_e, cx) => this.menuKey({ keystroke: "down" }, cx))
        .on_action("chat_menu_left", (_e, cx) => this.menuKey({ keystroke: "left" }, cx))
        .on_action("chat_menu_escape", (_e, cx) => this.menuKey({ keystroke: "escape" }, cx))
        .on_action("chat_menu_right", (_e, cx) => this.menuKey({ keystroke: "right" }, cx))
        .on_key_down((e, cx) => this.menuKey(e, cx))
        .child(Textarea.new(this.input).w_full().px(16).pt(14).pb(6).border_0().bg(settings().dark ? t.background : "#00000000").text_size(14).line_height("21px").text_color(t.foreground)
          .token((tk) => div().px(6).rounded(6).bg(t.selected).text_color(t.accent).font_medium().child(tk.token.label ?? tk.token.text))))
      .when(Boolean(chosen), (el) => el.child(h_flex().px(16).pb(2).gap(8).text_size(11.5).text_color(t.dim)
        .when(Boolean(chosen?.hint), (r) => r.child(div().flex_none().child(chosen.hint)))
        .child(div().flex_1().min_w(0).truncate().child(chosen?.desc ?? ""))))
      .child(h_flex().px(8).pb(8).gap(4).items_center()
        .child(icon("attach", svg("mods/chat/icons/attachment.svg").size(14), (_e, cx) => this.pickFiles(cx)).size(26).tooltip("Attach files"))
        .child(div().flex_1())
        .when(!this.dialog && Boolean(this.term), (el) => el.child(this.modeMenu(term, t)).child(this.modelMenu(term, t)))
        .when(Boolean(ctxBadge), (el) => el.child(ctxBadge))
        .child(div().id("send").flex_none().size(28).rounded_full().flex().items_center().justify_center().cursor_pointer()
          .text_size(stop ? 12 : 16).font_semibold()
          .bg(stop ? t.accent : typed || this.dialog ? t.solid : t.raised)
          .text_color(stop ? t.accent_foreground : typed || this.dialog ? t.solid_foreground : t.dim)
          .hover((s) => s.opacity(0.85))
          .when(!working || stop || this.dialog, el => el.tooltip(stop ? "Stop" : this.dialog ? "Start" : "Send"))
          .on_click((_e, cx) => (stop ? hc(["interrupt", this.term]) : this.send(cx)))
          .child(stop ? div().size(12).flex_none().rounded(2).bg(t.accent_foreground) : "↑")));
    return v_flex().flex_none().bg(t.background).rounded_b(9).overflow_hidden().px(16).pb(14).gap(8)
      .when(Boolean(this.t?.issue?.usage), el => el.child(h_flex().w_full().justify_center().child(
        h_flex().w_full().max_w(900).px(10).py(8).gap(8).items_center().rounded(8).border_1().border_color(t.blocked)
          .child(div().flex_1().min_w(0).text_size(12).text_color(t.blocked)
            .tooltip(this.t.issue.message).child("Usage limit reached · queued messages are paused"))
          .child(this.button("usage-terminal", "Show TUI", (_e, cx) => this.showTerminal(cx), t)))))
      .when(showWorkingRow, (el) => el.child(h_flex().w_full().justify_center().child(h_flex().w_full().max_w(900).px(6).gap(8).items_center().text_size(12).text_color(t.muted)
        .child(div().flex_none().text_color(t.working).frames(SPINNER, 90))
        .child(div().flex_1().min_w(0).truncate().child(term.report?.msg || "Working…"))
        .when(inlineQueue, row => row.child(this.outboxView(t, true))))))
      .when((status === "blocked" || Boolean(this.idleAsk)) && Boolean(this.t), (el) => el.child(h_flex().w_full().justify_center()
        .child(div().w_full().max_w(900).child(this.promptBox("The agent is asking:", t)))))
      .when(Boolean(this.error), (el) => el.child(h_flex().w_full().justify_center()
        .child(div().w_full().max_w(900).px(6).text_size(11.5).text_color(t.blocked).child(this.error))))
      .when(!this.dialog && this.outbox.failedItems.length > 0, el => el.child(this.failedSendsView(t)))
      .when(!this.dialog && this.outbox.visibleItems.length > 0 && !inlineQueue, el => el.child(this.outboxView(t)))
      .child(h_flex().w_full().justify_center().child(card));
  }

  // The / menu over the message box: the commands that match what's typed,
  // a window of them around the highlighted one.
  commandMenu(t) {
    const { rows, pickable, sel, nav } = this.slash();
    const KICON = { app: "settings", harness: "terminal", skill: "scroll", plugin: "plugin", mcp: "plug" };
    const icon = (name, on) => svg(`mods/chat/icons/${name}.svg`).size(15).flex_none().text_color(on ? t.foreground : t.dim);
    const hover = (i) => (on, cx) => { if (on && this.menuSel !== i) { this.menuSel = i; cx.notify(); } };
    const shell = (id, i) => h_flex().id(id).px(10).py(6).gap(10).rounded(8).items_center().cursor_pointer()
      .bg(i === sel ? t.selected : t.popover).on_hover(hover(i)).on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    const draw = (r, i) => {
      if (r.type === "header") return div().px(10).pt(6).pb(3).text_size(11).font_semibold().text_color(t.dim).child(r.label);
      if (r.type === "sep") return div().h(1).mx(6).my(4).bg(t.border);
      if (r.type === "back") return h_flex().id("menu-back").px(8).py(5).gap(6).items_center().rounded(8).cursor_pointer().text_size(12).font_semibold().text_color(t.muted)
        .hover((s) => s.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { this.menuSub = null; this.menuSel = 0; this.input.focus(); cx.notify(); })
        .child(svg("mods/chat/icons/back.svg").size(14).text_color(t.dim)).child(r.label);
      const on = i === sel;
      if (r.type === "sub" || r.type === "action") return shell(`menu-${r.id}`, i).on_click((_e, cx) => { this.choose(r, cx); this.input.focus(); })
        .child(icon(r.icon, on)).child(div().flex_1().text_size(13).child(r.label))
        .when(Boolean(r.detail), (el) => el.child(div().text_size(12).text_color(t.dim).child(r.detail)))
        .when(r.type === "sub", (el) => el.child(svg("mods/chat/icons/chevron.svg").size(13).text_color(t.dim)));
      if (r.type === "model") {
        const current = this.current().model;
        const here = r.m.id !== "default" && (r.m.id === current || r.m.resolved === current);
        return shell(`menu-m-${r.m.id}`, i).on_click((_e, cx) => this.choose(r, cx))
          .child(div().w(14).flex_none().text_color(t.accent).child(here ? "✓" : ""))
          .child(div().flex_none().text_size(13).child(r.m.name))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(r.m.desc ?? ""));
      }
      if (r.type === "session") return shell(`menu-s-${r.s.id}`, i).on_click((_e, cx) => this.choose(r, cx))
        .child(div().flex_1().min_w(0).truncate().text_size(13).child(r.s.title))
        .child(div().flex_none().text_size(12).text_color(t.dim).child(r.s.when));
      if (r.type === "mode") {
        const now = this.current().mode;
        return shell(`menu-p-${r.mode.id}`, i).on_click((_e, cx) => this.choose(r, cx))
          .child(div().w(14).flex_none().text_color(t.accent).child(now === r.mode.id ? "✓" : ""))
          .child(div().flex_none().text_size(13).child(r.mode.label))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(r.mode.desc));
      }
      const c = r.c;
      return shell(`cmd-${i}`, i).on_click((_e, cx) => this.choose(r, cx))
        .child(icon(KICON[c.kind] ?? "terminal", on))
        .child(h_flex().flex_none().max_w(nav ? 250 : Math.min(320, Math.max(160, this.width * 0.32))).gap(6).items_baseline().overflow_hidden()
          .child(div().flex_none().text_size(13).font_medium().text_color(t.foreground).child(`/${c.label ?? c.name}`))
          .when(!nav && Boolean(c.hint), (el) => el.child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(c.hint))))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(on ? t.foreground : t.muted).child(c.desc))
        .when(!nav && c.aliases.length > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(c.aliases.map((a) => `/${a}`).join(" "))))
        .when(!nav && Boolean(c.picker) && !c.action, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("picker")));
    };
    // Long lists show a window around the highlighted row.
    const MAX = 9;
    const idx = new Map(pickable.map((r, i) => [r, i]));
    const head = rows.filter((r) => r.type === "back");
    const body = rows.filter((r) => r.type !== "back");
    let shown = body;
    if (pickable.length > MAX + 1 && body.every((r) => idx.has(r))) {
      const start = Math.max(0, Math.min(sel - Math.floor(MAX / 2), body.length - MAX));
      shown = body.slice(start, start + MAX);
    }
    const empty = this.menuSub === "resume" && !pickable.length
      ? div().px(10).py(8).text_size(12.5).text_color(t.muted).child(this.sessions ? "No earlier conversations in this folder." : "Looking for conversations…") : null;
    const card = v_flex().id("cmd-menu").p(6).gap(1).rounded(14).border_1().border_color(t.border).bg(t.popover).shadow_md()
      .when(nav && !this.menuSub, (el) => el.w(420)).when(!nav || Boolean(this.menuSub), (el) => el.w_full())
      .children([...head, ...shown].map((r) => draw(r, idx.get(r) ?? -1)))
      .when(Boolean(empty), (el) => el.child(empty))
      .when(!nav || Boolean(this.menuSub), (el) => el.child(h_flex().px(10).pt(6).pb(2).gap(12).text_size(11).text_color(t.dim)
        .child(div().flex_1().child(pickable.length > MAX + 1 ? `${sel + 1} of ${pickable.length}` : ""))
        .child(nav ? "↑↓ choose · ← back · Enter pick · Esc close" : "↑↓ choose · Tab or Enter pick · Esc close")));
    return h_flex().w_full().max_w(900).child(card);
  }


  // The + button: the system's file picker.
  pickFiles(cx) {
    cx.spawn(async (cx) => {
      const paths = await pickFiles();
      if (paths === null) notify({ title: "No file picker", body: "Install zenity or kdialog, or drop files on the chat", level: "warning", timeout: 5000 });
      else if (paths.length) this.addFiles(paths, cx);
    });
  }

  render() {
    if (!this.dialog && !this.myPane()) return v_flex().id("root").size_full().p(20)
      .child("Chat owner context is missing or ambiguous. Open a new chat from its agent terminal; no terminal has been selected.");
    if (!this.dialog && !this.chatVisible()) return div().id("root").size_full();
    const t = theme();
    const term = this.term ? this.terminal() : null;
    if (!this.dialog && !this.term) {
      return v_flex().id("root").size_full().bg(t.background).items_center().justify_center().text_color(t.dim)
        .child(`No agent here. Press ${shortcut("⇧N")} for a new chat.`);
    }
    const titleIdentity = codexTitleIdentity(term);
    const changedTitle = titleIdentity && this.file && !titleMatchesFile(titleIdentity, this.file);
    if (!this.dialog && agentKind(term) === "codex" && (!this.sessionResolved || changedTitle)) {
      if (!this.identifyFeedback?.needsAction(identifyKey(term, titleIdentity))) {
        return v_flex().id("root").size_full().bg(t.background).text_color(t.dim).p(24)
          .child("Loading conversation…");
      }
      return v_flex().id("root").size_full().bg(t.background).text_color(t.foreground)
        .p(24).gap(12).items_center().justify_center().text_center()
        .child(h_flex().flex_none().gap(8).items_center().justify_center()
          .child(this.button("identify-tui", "Show TUI", (_e, cx) => this.showTerminal(cx), t, true).w_auto().px(16).py(9).text_size(14))
          .child(this.button("identify-retry", "Check again", (_e, cx) => { this.sig = null; this.check(cx); cx.notify(); }, t).w_auto().px(16).py(9).text_size(14)))
        .child(v_flex().gap(4).items_center().text_center().text_size(12).text_color(t.muted)
          .child("We couldn’t identify this conversation automatically.")
          .child("Run /status in TUI, leave the result visible, then return and check again."))
        .when(Boolean(this.error), el => el.child(div().text_size(12).text_color(t.dim).child(String(this.error))));
    }
    return v_flex().id("root").size_full().bg(t.background).rounded_b(9).overflow_hidden().text_color(t.foreground).text_size(14)
      .key_context(this.presentation ? "ChatRoot ChatPresentation" : "ChatRoot")
      .on_action("chat_no_split", (_e, cx) => cx.stop_propagation())
      .on_action("chat_search", (_e, cx) => (this.searching ? this.closeSearch(cx) : this.openSearch(cx)))
      .on_action("chat_side_toggle", (_e, cx) => { this.side.open = !this.side.open; (this.side.open ? this.sideInput : this.input).focus(); cx.notify(); })
      .on_drop((e, cx) => this.addFiles(e.paths, cx))
      .when(this.ended(term), (el) => el.child(v_flex().id("ended").flex_none().items_center().gap(8).py(10).border_b(1).border_color(t.border).bg(t.chrome)
        .child(div().text_color(t.muted).child("This agent's terminal has ended."))
        .child(div().id("close-chat").px(12).py(5).rounded(6).cursor_pointer().bg(t.solid).text_color(t.solid_foreground)
          .hover((s) => s.opacity(0.88)).on_click(() => this.closeChat()).child("Close chat"))))
      .when(!this.dialog, (el) => el.child(this.header(term, t))
        .child(h_flex().flex_1().min_h(0)
          .child(v_flex().flex_1().min_w(0).h_full().child(this.body(t)).child(this.footer(term, t)))
          .when(this.side.open, (el) => el.child(this.sidePane(t)))))
      .when(this.dialog, (el) => el.child(this.newChat(t)).child(this.footer(term, t)));
  }
}
