import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const loadMod = async (rel) =>
  import("data:text/javascript;base64," + Buffer.from(readFileSync(new URL(rel, import.meta.url), "utf8")).toString("base64"));

const { live, liveSnapshot } = await loadMod("../mods/chat/stream.js");
const { Transcript } = await loadMod("../mods/chat/parse.js");
const { CodexHandoff } = await loadMod("../mods/chat/handoff.js");
const { HandoffTracer } = await import("../mods/chat/trace.js");
const { Outbox, outboxScope } = await loadMod("../mods/chat/outbox.js");
const { withPending } = await loadMod("../mods/chat/timeline.js");
const { compactSettings } = await loadMod("../mods/chat/display.js");
const { withChanges } = await loadMod("../mods/chat/activity.js");

const mainSource = readFileSync(new URL("../mods/chat/main.js", import.meta.url), "utf8")
  .replace(/^import[\s\S]*?;\n/gm, "")
  .replace("export default class Chat", "class Chat");

function makeChatClass(overrides = {}) {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  const element = () => {
    const proxy = new Proxy(
      {},
      {
        get: () => (..._args) => proxy,
      },
    );
    return proxy;
  };
  const Chat = runInNewContext(`${mainSource}\nChat`, {
    View: class {},
    appWindow: () => ({ platform: "macos" }),
    div: element,
    v_flex: element,
    h_flex: element,
    svg: element,
    image: element,
    TextView: { markdown: element, html: element },
    settings: () => ({ font_family: "Menlo", dark: false }),
    theme: () => ({
      background: "#fff",
      foreground: "#000",
      muted: "#666",
      dim: "#888",
      border: "#ddd",
      surface: "#f8f8f8",
      hover: "#eee",
      accent: "#06c",
      working: "#06c",
      blocked: "#c00",
      done: "#090",
      raised: "#f0f0f0",
    }),
    shared: () => null,
    setShared: () => {},
    localStorage,
    Outbox,
    outboxScope,
    Transcript,
    CodexHandoff,
    HandoffTracer,
    live,
    liveSnapshot,
    withPending,
    compactSettings,
    withChanges,
    emojify: (v) => v,
    emojiMatches: async () => [],
    machineOf: () => null,
    agentKind: () => "codex",
    codexTitleIdentity: () => null,
    titleMatchesFile: () => true,
    sessionOf: () => "sid",
    notify: () => {},
    hc: async () => ({ code: 0, stdout: "", stderr: "" }),
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    run: () => {},
    ...overrides,
  });
  return { Chat, store };
}

function makeCx() {
  const tasks = [];
  let notifies = 0;
  const cx = {
    timer: {
      after(ms, fn) {
        const t = setTimeout(fn, Math.min(ms, 5));
        t.unref?.();
      },
      every() {},
    },
    notify() {
      notifies++;
    },
    spawn(fn) {
      const p = Promise.resolve().then(() => fn(cx));
      tasks.push(p);
      return p;
    },
  };
  return {
    cx,
    notifies: () => notifies,
    flushTasks: async () => {
      while (tasks.length) {
        const p = tasks.shift();
        await p;
      }
    },
  };
}

// --- Symptom 4: stream.js live() & liveSnapshot() ---

test("live(screen, 'codex') keeps prose ending with SUMMARY-like text as kind:'text' while claude preserves SUMMARY", () => {
  const screen = [
    "› please summarize",
    "",
    "• I finished the refactor.",
    "  Updated 2 files and ran unit tests.",
    "",
    "›",
  ].join("\n");

  assert.deepEqual(live(screen, "codex"), {
    kind: "text",
    text: "I finished the refactor. Updated 2 files and ran unit tests.",
  });

  const claudeScreen = [
    "❯ please summarize",
    "",
    "⏺ I finished the refactor.",
    "  Updated 2 files and ran unit tests.",
    "",
    "────────────────────",
    "❯",
  ].join("\n");
  assert.deepEqual(live(claudeScreen, "claude"), {
    kind: "run",
    title: "Updated 2 files and ran unit tests.",
    out: [],
    time: null,
  });

  // Also test after └ tool output inside the same block on Codex
  const afterToolScreen = [
    "› check files",
    "",
    "• Ran ls",
    "  └ file1.js",
    "",
    "  Updated 2 files and ran unit tests.",
    "",
    "›",
  ].join("\n");
  const codexSnap = liveSnapshot(afterToolScreen, "codex");
  assert.deepEqual(codexSnap.item, {
    kind: "text",
    text: "Updated 2 files and ran unit tests.",
  });
  assert.equal(codexSnap.afterToolInBlock, true);
  assert.equal(codexSnap.blockOrdinal, 1);

  const claudeAfterTool = [
    "❯ check files",
    "",
    "⏺ Ran ls",
    "  ⎿ file1.js",
    "",
    "  Updated 2 files and ran unit tests.",
    "",
    "────────────────────",
    "❯",
  ].join("\n");
  assert.deepEqual(live(claudeAfterTool, "claude"), {
    kind: "run",
    title: "Updated 2 files and ran unit tests.",
    out: [],
    time: null,
  });
});

test("liveSnapshot reports promptLine, blockOrdinal, afterToolInBlock, workedAfterAt, statusAfterAt accurately", () => {
  const screen = [
    "› build feature",
    "",
    "• Checking files first",
    "",
    "• Ran npm test",
    "  └ 10 passed",
    "",
    "• Final answer ready.",
    "",
    "─ Worked for 4s ──────────",
    "• Working (4s • esc to interrupt)",
    "",
    "›",
  ].join("\n");

  const snap = liveSnapshot(screen, "codex");
  assert.equal(snap.promptLine, "› build feature");
  assert.equal(snap.blockOrdinal, 3);
  assert.equal(snap.afterToolInBlock, false);
  assert.equal(snap.workedAfterAt, true);
  assert.equal(snap.statusAfterAt, true);
  assert.deepEqual(snap.item, { kind: "text", text: "Final answer ready." });

  // Scrolled off >80 lines: no › prompt line above block -> from === 0, promptLine === null
  const scrolled = [
    "  continuation of long reply",
    "",
    "• New block after scroll",
    "",
    "›",
  ].join("\n");
  const scrolledSnap = liveSnapshot(scrolled, "codex");
  assert.equal(scrolledSnap.from, 0);
  assert.equal(scrolledSnap.promptLine, null);
  assert.equal(scrolledSnap.blockOrdinal, 1);
  assert.equal(scrolledSnap.workedAfterAt, false);
  assert.equal(scrolledSnap.statusAfterAt, false);
});

// --- parse.js: Transcript.codexTurn state transitions & mid-turn steering ---

test("Transcript.codexTurn tracks epochs, commentary/final_answer, tool calls, mid-turn steering, and completion", () => {
  const t = new Transcript("codex");
  assert.deepEqual(t.codexTurn, {
    epoch: 0,
    turnId: null,
    stage: "idle",
    turnStarted: false,
    userCount: 0,
    assistantCount: 0,
    toolCount: 0,
    lastAssistantKey: null,
  });

  t.feed(JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }));
  assert.equal(t.codexTurn.epoch, 1);
  assert.equal(t.codexTurn.turnId, "t1");
  assert.equal(t.codexTurn.stage, "awaiting_text");

  t.feed(JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
  }));
  assert.equal(t.codexTurn.epoch, 1);
  assert.equal(t.codexTurn.userCount, 1);
  assert.equal(t.codexTurn.stage, "awaiting_text");

  // Commentary message -> assistant_logged
  t.feed(JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Checking..." }] },
  }));
  assert.equal(t.codexTurn.assistantCount, 1);
  assert.equal(t.codexTurn.stage, "assistant_logged");
  assert.ok(t.codexTurn.lastAssistantKey);

  // Mid-turn steering user message while assistant_logged -> resets stage to awaiting_text without bumping epoch
  t.feed(JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "steer now" }] },
  }));
  assert.equal(t.codexTurn.epoch, 1);
  assert.equal(t.codexTurn.userCount, 2);
  assert.equal(t.codexTurn.stage, "awaiting_text");

  // Tool call increments toolCount and sets awaiting_text
  t.feed(JSON.stringify({
    type: "response_item",
    payload: { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
  }));
  assert.equal(t.codexTurn.toolCount, 1);
  assert.equal(t.codexTurn.stage, "awaiting_text");

  // Final answer -> completed
  t.feed(JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Done." }] },
  }));
  assert.equal(t.codexTurn.assistantCount, 2);
  assert.equal(t.codexTurn.stage, "completed");

  t.feed(JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "t1", duration_ms: 1200 } }));
  assert.equal(t.codexTurn.stage, "completed");

  // Claude Transcript must not initialize codexTurn
  const claude = new Transcript("claude");
  assert.equal(claude.codexTurn, undefined);
});

// --- Symptom 1: Pre-send residue never flashes below new user message ---

test("Symptom 1: Chat send, TUI send, and hc send never flash prior turn reply below new user message", () => {
  const handoff = new CodexHandoff();
  const priorScreen = [
    "› first question",
    "",
    "• Prior turn answer that stays on terminal screen.",
    "",
    "─ Worked for 2s",
    "",
    "›",
  ].join("\n");

  const priorSnap = liveSnapshot(priorScreen, "codex");
  const r1 = handoff.update(priorSnap, {
    codexTurn: { epoch: 1, stage: "completed", assistantCount: 1 },
    termStatus: "idle",
    hasPriorAssistant: true,
  });
  assert.equal(r1.streamText, null);
  assert.equal(r1.reason, "worked_on_screen");

  // 1. Chat send retires current screen and rejects stale prior turn even when terminal status flips to working
  handoff.noteUserSend();
  const workingBeforeClear = [
    "› first question",
    "",
    "• Prior turn answer that stays on terminal screen.",
    "",
    "• Working (1s • esc to interrupt)",
    "",
    "›",
  ].join("\n");
  const r2 = handoff.update(liveSnapshot(workingBeforeClear, "codex"), {
    codexTurn: { epoch: 2, stage: "awaiting_text", assistantCount: 0 },
    pendingCount: 1,
    termStatus: "working",
    hasPriorAssistant: true,
  });
  assert.equal(r2.streamText, null);
  assert.equal(r2.reason, "stale_prior_turn");
  assert.equal(handoff.visibleStream({ epoch: 2, stage: "awaiting_text" }), null);

  // 2. Scrolled-off prompt (promptLine === null) with identical retired text is still rejected
  const scrolledPrior = [
    "• Prior turn answer that stays on terminal screen.",
    "",
    "• Working (1s • esc to interrupt)",
    "",
    "›",
  ].join("\n");
  const r3 = handoff.update(liveSnapshot(scrolledPrior, "codex"), {
    codexTurn: { epoch: 2, stage: "awaiting_text", assistantCount: 0 },
    termStatus: "working",
    hasPriorAssistant: true,
  });
  assert.equal(r3.streamText, null);
  assert.equal(r3.reason, "stale_prior_turn");

  // 3. Once new prompt appears with new text, live stream is accepted
  const newTurnScreen = [
    "› second question",
    "",
    "• Fresh reply for second turn.",
    "",
    "›",
  ].join("\n");
  const r4 = handoff.update(liveSnapshot(newTurnScreen, "codex"), {
    codexTurn: { epoch: 2, stage: "awaiting_text", assistantCount: 0 },
    termStatus: "working",
    hasPriorAssistant: true,
  });
  assert.equal(r4.streamText, "Fresh reply for second turn.");
  assert.equal(r4.reason, "live_stream");
  assert.equal(handoff.visibleStream({ epoch: 2, stage: "awaiting_text" }), "Fresh reply for second turn.");

  // 4. TUI send / hc send without Chat send: finishFollow / completed retires turn 2,
  // and turn 3's task_started cannot resurrect turn 2's screen text
  handoff.finishFollow();
  const staleAfterHcSend = [
    "› second question",
    "",
    "• Fresh reply for second turn.",
    "",
    "›",
  ].join("\n");
  const r5 = handoff.update(liveSnapshot(staleAfterHcSend, "codex"), {
    codexTurn: { epoch: 3, stage: "awaiting_text", assistantCount: 0 },
    termStatus: "working",
    hasPriorAssistant: true,
  });
  assert.equal(r5.streamText, null);
  assert.equal(r5.reason, "stale_prior_turn");
});

// --- Symptom 2A & 2B: Serialized Tail + atomic mid-turn and exit drains ---

test("Symptom 2A: readTailOnce & flushTail serialize tail.read() so concurrent calls never overlap", async () => {
  const { Chat } = makeChatClass();
  const { cx } = makeCx();
  let inFlight = 0;
  let maxInFlight = 0;
  let reads = 0;
  const queuedBatches = [
    [JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } })],
    [
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "All done" }] },
      }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "t1", duration_ms: 500 } }),
    ],
  ];

  const tail = {
    truncated: false,
    async read() {
      reads++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return queuedBatches.shift() ?? [];
    },
  };

  const chat = Object.assign(Object.create(Chat.prototype), {
    gen: 1,
    t: new Transcript("codex"),
    codexHandoff: new CodexHandoff(),
    activeTail: { gen: 1, tail, kind: "codex", ready: true, chain: Promise.resolve() },
    chatVisible: () => true,
    cacheShown() {},
    nameSpace() {},
    ensureFollow() {},
    terminal: () => ({ status: "idle" }),
  });

  // Trigger readTailOnce and flushTail concurrently
  const [n1, n2] = await Promise.all([chat.readTailOnce(cx), chat.flushTail(cx)]);
  assert.equal(maxInFlight, 1);
  assert.equal(reads, 2);
  assert.equal(n1, 1);
  assert.equal(n2, 2);
  assert.equal(chat.t.codexTurn.stage, "completed");
});

test("Symptom 2B: follow('codex') holds acceptedText across mid-turn commentary -> tool drain and exit drain without blank frame or duplicate", async () => {
  const screens = [
    [
      "› inspect repo",
      "",
      "• Let me inspect the files first.",
      "",
      "›",
    ].join("\n"),
    [
      "› inspect repo",
      "",
      "• Running git status",
      "  └ On branch main",
      "",
      "›",
    ].join("\n"),
  ];
  let status = "working";
  let screenIdx = 0;
  const observedFrames = [];
  const { Chat } = makeChatClass({
    hc: async (args) => {
      if (args[0] === "read") return { code: 0, stdout: screens[Math.min(screenIdx, screens.length - 1)], stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const { cx, flushTasks } = makeCx();
  const t = new Transcript("codex");
  t.feed(JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }));

  let flushedMidTurn = false;
  const chat = Object.assign(Object.create(Chat.prototype), {
    gen: 1,
    t,
    pending: [],
    codexHandoff: new CodexHandoff(),
    chatVisible: () => true,
    terminal: () => ({ address: "t1", status }),
    flushTail: async () => {
      if (!flushedMidTurn) {
        flushedMidTurn = true;
        // During flushTail, visibleStream must STILL hold the commentary text (no blank frame)
        assert.equal(chat.streamShown(), "Let me inspect the files first.");
        t.feed(JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Let me inspect the files first." }] },
        }));
        t.feed(JSON.stringify({
          type: "response_item",
          payload: { type: "function_call", call_id: "c1", name: "shell", arguments: '{"cmd":"git status"}' },
        }));
      }
      return 2;
    },
  });
  Object.defineProperty(chat, "term", { value: "t1" });

  const origNotify = cx.notify;
  cx.notify = () => {
    origNotify();
    observedFrames.push({
      entries: t.entries.length,
      stream: chat.streamShown(),
      running: chat.running?.title ?? null,
    });
    if (observedFrames.length === 1) {
      // Advance screen to tool call and eventually go idle
      screenIdx = 1;
    } else if (observedFrames.length >= 2) {
      status = "idle";
    }
  };

  chat.follow("codex", cx);
  await flushTasks();

  assert.equal(flushedMidTurn, true);
  // Frame 1: streaming commentary text before tool call
  assert.deepEqual(observedFrames[0], { entries: 0, stream: "Let me inspect the files first.", running: null });
  // Frame 2: after flushTail, entries has assistant + tools, stream is null (no duplicate!), running is tool card (no blank!)
  assert.deepEqual(observedFrames[1], { entries: 2, stream: null, running: "Running git status" });
  // Exit frame: running cleared cleanly
  assert.deepEqual(observedFrames.at(-1), { entries: 2, stream: null, running: null });
});

// --- Symptom 3: Wrapped CJK + Markdown never duplicates on completion or commentary -> tool ---

test("Symptom 3: 80-col wrapped CJK with spaces and Markdown never duplicates before/after Worked for Xs or commentary -> tool", () => {
  const handoff = new CodexHandoff();
  const t = new Transcript("codex");
  t.feed(JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }));
  t.feed(JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "为什么切换导致刷新" }] },
  }));

  // 80-col wrapped Chinese text produces ASCII spaces inside textOf()
  const cjkScreen = [
    "› 为什么切换导致刷新",
    "",
    "• 这个问题主要是切换导致的",
    "  刷新，详见 [stream.js](mods/chat/stream.js)。",
    "",
    "›",
  ].join("\n");
  const snap1 = liveSnapshot(cjkScreen, "codex");
  assert.equal(snap1.item.text, "这个问题主要是切换导致的 刷新，详见 [stream.js](mods/chat/stream.js)。");

  const u1 = handoff.update(snap1, { codexTurn: t.codexTurn, termStatus: "working", hasPriorAssistant: false });
  assert.equal(u1.streamText, snap1.item.text);
  assert.equal(handoff.visibleStream(t.codexTurn), snap1.item.text);

  // Commentary logged in JSONL (without textOf() spaces!) -> synchronous gate drops live stream immediately
  t.feed(JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text: "这个问题主要是切换导致的刷新，详见 [stream.js](mods/chat/stream.js)。" }],
    },
  }));
  assert.equal(handoff.visibleStream(t.codexTurn), null);

  handoff.update(snap1, { codexTurn: t.codexTurn, termStatus: "working", hasPriorAssistant: true });
  assert.equal(handoff.loggedSlot.blockOrdinal, 1);

  // Tool call arrives in log -> stage returns to awaiting_text, but screen still shows block 1 commentary
  t.feed(JSON.stringify({
    type: "response_item",
    payload: { type: "function_call", call_id: "c1", name: "read_file", arguments: "{}" },
  }));
  const u2 = handoff.update(snap1, { codexTurn: t.codexTurn, termStatus: "working", hasPriorAssistant: true });
  assert.equal(u2.streamText, null);
  assert.equal(u2.reason, "stale_logged_slot");

  // New block (blockOrdinal 2) after tool call IS accepted
  const block2Screen = [
    "› 为什么切换导致刷新",
    "",
    "• 这个问题主要是切换导致的",
    "  刷新，详见 [stream.js](mods/chat/stream.js)。",
    "",
    "• 已定位到原因并完成修复。",
    "",
    "›",
  ].join("\n");
  const snap2 = liveSnapshot(block2Screen, "codex");
  assert.equal(snap2.blockOrdinal, 2);
  const u3 = handoff.update(snap2, { codexTurn: t.codexTurn, termStatus: "working", hasPriorAssistant: true });
  assert.equal(u3.streamText, "已定位到原因并完成修复。");

  // Final answer + Worked for Xs -> synchronous gate & workedAfterAt retire stream with zero duplicate
  t.feed(JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "已定位到原因并完成修复。" }] },
  }));
  assert.equal(handoff.visibleStream(t.codexTurn), null);

  const workedScreen = [
    "› 为什么切换导致刷新",
    "",
    "• 已定位到原因并完成修复。",
    "",
    "─ Worked for 5s ─────────",
    "",
    "›",
  ].join("\n");
  const u4 = handoff.update(liveSnapshot(workedScreen, "codex"), {
    codexTurn: { epoch: 1, stage: "awaiting_text" }, // even if log lagged behind screen!
    termStatus: "idle",
  });
  assert.equal(u4.streamText, null);
  assert.equal(u4.reason, "worked_on_screen");
});

// --- Claude unchanged check ---

test("Claude streamShown() preserves legacy logged() behavior unchanged", () => {
  const { Chat } = makeChatClass({ agentKind: () => "claude" });
  const chat = Object.assign(Object.create(Chat.prototype), {
    t: new Transcript("claude"),
    stream: "Hello from Claude",
    terminal: () => ({ status: "working" }),
  });
  assert.equal(chat.streamShown(), "Hello from Claude");
  chat.t.assistant("Hello from Claude");
  assert.equal(chat.streamShown(), null);
});

// --- Symptom 5: settle(), seenWorking, queued() labels ---

test("Symptom 5: whitespace-normalized settle(), seenWorking completion retirement, and queued() labels", () => {
  const labels = [];
  const collectText = (node) => {
    const proxy = new Proxy(
      {},
      {
        get: (_t, key) => (...args) => {
          if (key === "child" && typeof args[0] === "string") labels.push(args[0]);
          if (key === "when" && args[0] && typeof args[1] === "function") args[1](proxy);
          return proxy;
        },
      },
    );
    return proxy;
  };
  const { Chat } = makeChatClass({ div: collectText, v_flex: collectText, h_flex: collectText });
  const t = new Transcript("codex");
  let status = "idle";
  const chat = Object.assign(Object.create(Chat.prototype), {
    t,
    pending: [],
    terminal: () => ({ status }),
    entry: () => collectText(),
  });

  // 1. Whitespace-normalized user match in settle()
  chat.pending.push({ text: "hello\n   world   from   chat", users: 0, delivering: false, at: Date.now() });
  t.feed(JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello world from chat" }] },
  }));
  chat.settle();
  assert.equal(chat.pending.length, 0);

  // 2. seenWorking retirement when Codex turn completes even if user message differed
  const p = { text: "unmatched prompt", users: 1, delivering: false, fromQueue: true, at: Date.now() };
  chat.pending.push(p);
  status = "working";
  chat.settle();
  assert.equal(p.seenWorking, true);
  assert.equal(chat.pending.length, 1);

  // queued() while working (not delivering) -> Steering
  labels.length = 0;
  chat.queued(p, 0, {});
  assert.ok(labels.includes("Steering · added to the running turn"));

  // queued() after working ends before completion -> Sent (never regresses to Sending…)
  status = "idle";
  labels.length = 0;
  chat.queued(p, 0, {});
  assert.ok(labels.includes("Sent"));
  assert.ok(!labels.includes("Sending…"));

  // Once codexTurn.stage === "completed", settle() retires p
  t.codexTurn.stage = "completed";
  chat.settle();
  assert.equal(chat.pending.length, 0);

  // 3. Delivering labels: queued vs direct vs >3000ms timeout
  labels.length = 0;
  chat.queued({ text: "q", delivering: true, fromQueue: true, at: Date.now() }, 0, {});
  assert.ok(labels.includes("Sending queued message…"));

  labels.length = 0;
  chat.queued({ text: "d", delivering: true, fromQueue: false, at: Date.now() }, 0, {});
  assert.ok(labels.includes("Sending to terminal…"));

  labels.length = 0;
  chat.queued({ text: "slow", delivering: true, fromQueue: false, at: Date.now() - 4000 }, 0, {});
  assert.ok(labels.includes("Waiting for terminal input…"));
});

// --- readTailOnce wakes follow() immediately for TUI / hc send ---

test("readTailOnce wakes ensureFollow('codex') immediately when new log lines leave codexTurn.stage === 'awaiting_text'", async () => {
  const { Chat } = makeChatClass();
  const { cx } = makeCx();
  let wokeArgs = null;
  const tail = {
    truncated: false,
    read: async () => [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t-tui" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "from tui" }] } }),
    ],
  };
  const chat = Object.assign(Object.create(Chat.prototype), {
    gen: 1,
    t: new Transcript("codex"),
    activeTail: { gen: 1, tail, kind: "codex", ready: true, chain: Promise.resolve() },
    chatVisible: () => true,
    cacheShown() {},
    nameSpace() {},
    ensureFollow(kind, _cx, graceMs) {
      wokeArgs = { kind, graceMs };
    },
  });

  await chat.readTailOnce(cx);
  assert.deepEqual(wokeArgs, { kind: "codex", graceMs: 1800 });
});

test("single readTailOnce batch with [commentary, function_call] drops visibleStream immediately and promotes loggedSlot", async () => {
  const { Chat } = makeChatClass();
  const { cx } = makeCx();
  const t = new Transcript("codex");
  t.feed(JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }));

  const commentaryScreen = [
    "› check files",
    "",
    "• 让我先查看一下文件。",
    "",
    "›",
  ].join("\n");
  const snap = liveSnapshot(commentaryScreen, "codex");
  const handoff = new CodexHandoff();
  const r1 = handoff.update(snap, { codexTurn: t.codexTurn, termStatus: "working", hasPriorAssistant: false });
  assert.equal(r1.streamText, "让我先查看一下文件。");
  assert.equal(handoff.visibleStream(t.codexTurn), "让我先查看一下文件。");

  const tail = {
    truncated: false,
    read: async () => [
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "让我先查看一下文件。" }] },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "function_call", call_id: "c1", name: "read_file", arguments: "{}" },
      }),
    ],
  };
  const chat = Object.assign(Object.create(Chat.prototype), {
    gen: 1,
    t,
    codexHandoff: handoff,
    activeTail: { gen: 1, tail, kind: "codex", ready: true, chain: Promise.resolve() },
    chatVisible: () => true,
    cacheShown() {},
    nameSpace() {},
    ensureFollow() {},
    terminal: () => ({ status: "working" }),
  });

  await chat.readTailOnce(cx);
  assert.equal(t.codexTurn.assistantCount, 1);
  assert.equal(t.codexTurn.stage, "awaiting_text");
  // Synchronous render gate must immediately drop stream on that frame
  assert.equal(chat.streamShown(), null);

  // Next follow() tick on the same screen must promote loggedSlot and reject as stale_logged_slot
  const r2 = handoff.update(snap, { codexTurn: t.codexTurn, termStatus: "working", hasPriorAssistant: true });
  assert.equal(r2.streamText, null);
  assert.equal(r2.reason, "stale_logged_slot");
  assert.equal(handoff.loggedSlot.assistantCount, 1);
  assert.equal(handoff.loggedSlot.text, "让我先查看一下文件。");
});

test("ensureFollow('codex') called during exit flushTail starts a fresh follow loop instead of being swallowed", async () => {
  let status = "working";
  let screen = [
    "› turn 1",
    "",
    "• Streaming turn 1 reply",
    "",
    "›",
  ].join("\n");
  const { Chat } = makeChatClass({
    hc: async (args) => (args[0] === "read" ? { code: 0, stdout: screen, stderr: "" } : { code: 0, stdout: "", stderr: "" }),
  });
  const { cx, flushTasks } = makeCx();
  const t = new Transcript("codex");
  t.feed(JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }));

  let resolveExitFlush;
  const exitFlushGate = new Promise((r) => { resolveExitFlush = r; });
  let inExitFlush = false;
  let flushCount = 0;

  const chat = Object.assign(Object.create(Chat.prototype), {
    gen: 1,
    t,
    pending: [],
    codexHandoff: new CodexHandoff(),
    chatVisible: () => true,
    terminal: () => ({ address: "t1", status }),
    flushTail: async () => {
      flushCount++;
      if (flushCount === 1) {
        inExitFlush = true;
        await exitFlushGate;
      }
      return 0;
    },
  });
  Object.defineProperty(chat, "term", { value: "t1" });

  let notifyCount = 0;
  cx.notify = () => {
    notifyCount++;
    if (notifyCount === 1) {
      // Trigger exit drain of loop 1
      status = "idle";
    }
  };

  chat.follow("codex", cx);
  // Wait until loop 1 enters exit flushTail
  for (let i = 0; i < 40 && !inExitFlush; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(inExitFlush, true);
  const exitingLoop = chat.streamLoop;
  assert.equal(exitingLoop.exiting, true);

  // New turn triggers ensureFollow while loop 1 is awaiting flushTail
  t.feed(JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t2" } }));
  screen = [
    "› turn 2",
    "",
    "• Streaming turn 2 reply",
    "",
    "›",
  ].join("\n");
  status = "working";
  chat.ensureFollow("codex", cx, 1800);

  const newLoop = chat.streamLoop;
  assert.notEqual(newLoop, exitingLoop);
  assert.equal(newLoop.exiting, false);

  // Release loop 1's exit flush: must NOT clobber newLoop or new turn's stream!
  resolveExitFlush();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(chat.streamLoop, newLoop);
  assert.equal(chat.streamShown(), "Streaming turn 2 reply");

  // Cleanly finish loop 2
  status = "idle";
  t.feed(JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "t2", duration_ms: 100 } }));
  await flushTasks();
  assert.equal(chat.streamLoop, null);
});

test("Transcript.codexTurn does not double-increment epoch when user message precedes task_started", () => {
  const t = new Transcript("codex");

  // Turn 1: user item written before task_started while idle
  t.feed(JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
  }));
  assert.equal(t.codexTurn.epoch, 1);
  assert.equal(t.codexTurn.stage, "awaiting_text");
  assert.equal(t.codexTurn.turnStarted, false);

  t.feed(JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }));
  assert.equal(t.codexTurn.epoch, 1);
  assert.equal(t.codexTurn.turnId, "t1");
  assert.equal(t.codexTurn.stage, "awaiting_text");
  assert.equal(t.codexTurn.turnStarted, true);

  t.feed(JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "ok 1" }] },
  }));
  assert.equal(t.codexTurn.stage, "completed");
  assert.equal(t.codexTurn.turnStarted, false);

  // Turn 2: user item written before task_started while completed
  t.feed(JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "second" }] },
  }));
  assert.equal(t.codexTurn.epoch, 2);
  assert.equal(t.codexTurn.turnStarted, false);
  assert.equal(t.codexTurn.assistantCount, 0);

  t.feed(JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t2" } }));
  assert.equal(t.codexTurn.epoch, 2);
  assert.equal(t.codexTurn.turnId, "t2");
  assert.equal(t.codexTurn.turnStarted, true);

  // Abort resets turnStarted
  t.feed(JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", turn_id: "t2" } }));
  assert.equal(t.codexTurn.stage, "completed");
  assert.equal(t.codexTurn.turnStarted, false);

  // Turn 3: task_started arrives first, then user
  t.feed(JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t3" } }));
  assert.equal(t.codexTurn.epoch, 3);
  assert.equal(t.codexTurn.turnStarted, true);
  t.feed(JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "third" }] },
  }));
  assert.equal(t.codexTurn.epoch, 3);
  assert.equal(t.codexTurn.turnStarted, true);
});

test("Cold-opened idle Codex Chat seeds retired screen via start() so external hc/TUI send never flashes <1s prior reply", async () => {
  // 1. Direct CodexHandoff.seedIdleScreen() unit check
  const direct = new CodexHandoff();
  assert.equal(direct.seeded, false);
  const oldScreen = [
    "› Question 1",
    "",
    "• Old Reply 1",
    "",
    "›",
  ].join("\n");
  direct.seedIdleScreen(liveSnapshot(oldScreen, "codex"));
  assert.equal(direct.seeded, true);
  assert.deepEqual(direct.retired, { promptLine: "› Question 1", text: "Old Reply 1" });

  // Turn 2 starts externally before › Question 2 renders on screen
  const staleRes = direct.update(liveSnapshot(oldScreen, "codex"), {
    codexTurn: { epoch: 2, stage: "awaiting_text", assistantCount: 0, toolCount: 0 },
    termStatus: "working",
  });
  assert.equal(staleRes.streamText, null);
  assert.equal(staleRes.reason, "stale_prior_turn");

  // 2. Full Chat.prototype.start() -> external send -> follow() integration check
  let status = "idle";
  let screen = oldScreen;
  let folderNotify = null;

  class FakeTail {
    constructor() {
      this.offset = 0;
      this.truncated = false;
    }
    async read() {
      return [];
    }
  }

  const { Chat } = makeChatClass({
    Tail: FakeTail,
    inheritedHistory: async () => ({
      offset: 100,
      truncated: false,
      lines: [
        JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Question 1" }] } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Old Reply 1" }] } }),
        JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "t1", duration_ms: 400 } }),
      ],
    }),
    watchFolder: () => {},
    folderPoll: () => () => new Promise((r) => { folderNotify = r; }),
    sleep: () => new Promise((r) => setTimeout(r, 5)),
    hc: async (args) => {
      if (args[0] === "read") return { code: 0, stdout: screen, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });

  const chat = new Chat();
  const { cx } = makeCx();
  Object.assign(chat, {
    gen: 0,
    pending: [],
    stream: null,
    running: null,
    streamLoop: null,
    file: null,
    historyTail: null,
    activeTail: null,
    limit: 80,
    off: 0,
    historyBytes: 4 * 1024 * 1024,
    truncated: false,
    historyLoading: false,
    error: null,
    grew: false,
    codexHandoff: new CodexHandoff(),
    tracer: new HandoffTracer({ isEnabled: () => false }),
    terminal: () => ({ id: "t1", status, kind: "codex" }),
    chatVisible: () => true,
    cacheShown: () => {},
    recordTrace: () => {},
    settle: () => {},
    ack: () => {},
    nameSpace: () => {},
    flushTail: async () => 0,
  });
  Object.defineProperty(chat, "term", { value: "t1" });

  chat.start("/tmp/codex.jsonl", null, "codex", cx);
  for (let i = 0; i < 40 && !chat.codexHandoff.seeded; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(chat.codexHandoff.seeded, true);
  assert.deepEqual(chat.codexHandoff.retired, { promptLine: "› Question 1", text: "Old Reply 1" });

  // External hc/TUI send: task_started lands before › Question 2 paints on PTY
  chat.t.feed(JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t2" } }));
  status = "working";
  chat.ensureFollow("codex", cx, 1800);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(chat.streamShown(), null);

  // Once Turn 2 prompt + new reply render, streamShown() exposes the new reply
  screen = [
    "› Question 2",
    "",
    "• New Reply 2",
    "",
    "›",
  ].join("\n");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(chat.streamShown(), "New Reply 2");

  // Shut down background loops cleanly
  status = "idle";
  chat.t.feed(JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "t2", duration_ms: 200 } }));
  chat.gen++;
  folderNotify?.();
  await new Promise((r) => setTimeout(r, 20));
});

// --- HandoffTracer: monotonic JSONL, deduplication, disabled no-op ---

test("HandoffTracer writes monotonic JSONL events and deduplicates high-frequency signatures only when enabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-trace-"));
  try {
    let enabled = false;
    const tracer = new HandoffTracer({
      id: "term/1:test",
      dir,
      isEnabled: () => enabled,
    });

    // Disabled -> writes nothing
    tracer.record("send", { len: 5 });
    tracer.record("render_sig", { sig: "s1" });
    await tracer.flush();
    assert.equal(existsSync(tracer.path()), false);

    // Enabled -> writes monotonic JSONL and dedups high-frequency events
    enabled = true;
    tracer.record("send", { len: 10 });
    tracer.record("render_sig", { sig: "a" });
    tracer.record("render_sig", { sig: "a" }); // deduped
    tracer.record("follow_frame", { sig: "f1" });
    tracer.record("follow_frame", { sig: "f1" }); // deduped
    tracer.record("check_state", { sig: "c1" });
    tracer.record("check_state", { sig: "c1" }); // deduped
    tracer.record("render_sig", { sig: "b" }); // changed -> written
    await tracer.flush();

    const lines = readFileSync(tracer.path(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 5);
    assert.deepEqual(
      lines.map((l) => l.event),
      ["send", "render_sig", "follow_frame", "check_state", "render_sig"],
    );
    for (let i = 0; i < lines.length; i++) {
      assert.equal(typeof lines[i].t_ms, "number");
      assert.ok(Date.parse(lines[i].ts) > 0);
      if (i > 0) assert.ok(lines[i].t_ms >= lines[i - 1].t_ms);
    }

    // Function `dir: () => ...` + parent `mkdir` for nested non-existent directory
    let dynamicDir = join(dir, "nested", "traces");
    const dynamicTracer = new HandoffTracer({
      id: "dyn-1",
      dir: () => dynamicDir,
      isEnabled: () => true,
    });
    dynamicTracer.record("send", { len: 3 });
    await dynamicTracer.flush();
    assert.equal(dynamicTracer.path(), join(dynamicDir, "herdr-codex-handoff-dyn-1.jsonl"));
    assert.equal(existsSync(dynamicTracer.path()), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GPUI capability sandbox: Chat.init() + check(cx) never probes /tmp and resolves Codex session without hanging on Loading conversation…", async () => {
  const { mkdirSync, promises: nodeFs } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "gpui-sandbox-"));
  const homeDir = join(root, "home");
  const appHomeDir = join(homeDir, ".config", "herdr-app");
  const sessionFile = join(homeDir, ".codex", "sessions", "2026", "11", "13", "rollout-11111111-1111-1111-1111-111111111111.jsonl");
  mkdirSync(join(homeDir, ".codex", "sessions", "2026", "11", "13"), { recursive: true });
  mkdirSync(appHomeDir, { recursive: true });

  try {
    await nodeFs.writeFile(
      sessionFile,
      JSON.stringify({ timestamp: "2026-11-13T00:00:00Z", type: "session_meta", payload: { id: "11111111-1111-1111-1111-111111111111", cwd: homeDir } }) + "\n",
    );

    const assertCanRead = (p) => {
      if (!String(p).startsWith(homeDir)) {
        throw new Error(`cannot read '${p}'; add its directory to capabilities.fs.read in the manifest`);
      }
    };
    const assertCanWrite = (p) => {
      if (!String(p).startsWith(appHomeDir)) {
        throw new Error(`cannot write '${p}'; add its directory to capabilities.fs.write in the manifest`);
      }
    };
    const sandboxFs = {
      exists(p) {
        assertCanRead(p);
        return Promise.resolve(existsSync(p));
      },
      readFile(p, enc) {
        assertCanRead(p);
        return nodeFs.readFile(p, enc);
      },
      writeFile(p, d) {
        assertCanWrite(p);
        return nodeFs.writeFile(p, d);
      },
      mkdir(p, opts) {
        assertCanWrite(p);
        return nodeFs.mkdir(p, opts);
      },
    };

    const { ChatAttention } = await loadMod("../mods/chat/attention.js");
    const { IdentifyFeedback, identifyKey } = await loadMod("../mods/chat/identify.js");
    const { ownerPane, qualifyAddress } = await loadMod("../mods/chat/identity.js");
    const { bindingKey, chooseBinding } = await loadMod("../mods/chat/binding.js");
    const { sidebarVisible } = await loadMod("../mods/chat/hover-diff.js");

    const makeEl = (tag) => {
      const node = { tag, textChildren: [], children: [] };
      const proxy = new Proxy(node, {
        get(target, prop) {
          if (prop === "__node") return target;
          if (prop === "child") return (c) => {
            if (typeof c === "string") target.textChildren.push(c);
            else if (c != null) target.children.push(c?.__node ?? c);
            return proxy;
          };
          if (prop === "children") return (cs) => {
            for (const c of cs ?? []) {
              if (typeof c === "string") target.textChildren.push(c);
              else if (c != null) target.children.push(c?.__node ?? c);
            }
            return proxy;
          };
          if (prop === "when") return (cond, fn) => { if (cond) fn(proxy); return proxy; };
          return (..._args) => proxy;
        },
      });
      return proxy;
    };
    const collectTexts = (node, out = []) => {
      if (!node || typeof node !== "object") return out;
      for (const s of node.textChildren ?? []) out.push(s);
      for (const c of node.children ?? []) collectTexts(c, out);
      return out;
    };

    for (const traceEnabled of [false, true]) {
      const sharedState = new Map([["chat.trace", traceEnabled]]);
      const termObj = {
        address: "t1h",
        status: "idle",
        state: "live",
        cwd: homeDir,
        foreground: { name: "codex", pid: 4242 },
      };
      const fakeState = () => ({
        set_auto_grow() {},
        on() {},
        focus() {},
        value: () => "",
        content: () => ({ tokens: [] }),
        set_value() {},
      });
      const { Chat } = makeChatClass({
        fs: sandboxFs,
        home: () => homeDir,
        appHome: () => appHomeDir,
        shared: (k) => (sharedState.has(k) ? sharedState.get(k) : null),
        setShared: (k, v) => sharedState.set(k, v),
        props: () => ({ terminal: "t1h", owner_tab: "tab-1", owner_pane: "pane-1" }),
        terminals: () => [termObj],
        panes: () => [{ pane: "pane-1", tab: "tab-1", mod: "chat", active: true }],
        spaces: () => [{ id: "sp-1", active: true, tabs: [{ id: "tab-1", active: true, panes: [{ id: "pane-1", active: true }] }] }],
        away: () => false,
        ownerPane,
        qualifyAddress,
        presentationPane: () => null,
        presentationVisible: () => true,
        presentationLayoutReady: () => true,
        layout: () => ({}),
        keys: () => [],
        window: () => ({ platform: "macos", active: true }),
        TextareaState: { new: fakeState },
        InputState: { new: fakeState },
        Textarea: elementStub(),
        Input: elementStub(),
        Popover: elementStub(),
        HoverCard: elementStub(),
        div: () => makeEl("div"),
        v_flex: () => makeEl("v_flex"),
        h_flex: () => makeEl("h_flex"),
        nextCommand: () => new Promise(() => {}),
        watchFolder: () => () => {},
        folderPoll: () => () => new Promise(() => {}),
        inheritedHistory: async () => ({ lines: [], offset: 0, truncated: false }),
        Tail: class {
          constructor(file) { this.file = file; this.offset = 0; this.truncated = false; }
          async read() { return []; }
        },
        locate: async () => sessionFile,
        resolveSession: async (_term, _screen, file) => ({ file, evidence: "test", matchCount: 1, subagent: false }),
        bindingKey,
        chooseBinding,
        ChatAttention,
        IdentifyFeedback,
        identifyKey,
        loadCommands: async () => [],
        catalog: async () => ({ models: [] }),
        modelName: () => "gpt-5",
        CLAUDE_EFFORTS: [],
        sidebarVisible,
        exec: async (cmd) => (cmd === "ps" ? { code: 0, stdout: "Mon Nov 13 00:00:00 2026\n", stderr: "" } : { code: 0, stdout: "", stderr: "" }),
        hc: async () => ({ code: 0, stdout: "", stderr: "" }),
      });

      function elementStub() {
        const proxy = new Proxy({}, { get: () => () => proxy });
        return proxy;
      }

      const chat = new Chat();
      const { cx } = makeCx();
      assert.doesNotThrow(() => chat.init({}, cx));
      for (let i = 0; i < 40 && !chat.sessionResolved; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }

      assert.equal(chat.sessionResolved, true);
      const rendered = chat.render();
      const texts = collectTexts(rendered.__node);
      assert.equal(texts.includes("Loading conversation…"), false);

      await chat.tracer.flush();
      const expectedTracePath = join(appHomeDir, "traces", "herdr-codex-handoff-t1h.jsonl");
      if (traceEnabled) {
        assert.equal(existsSync(expectedTracePath), true);
        const traceContent = readFileSync(expectedTracePath, "utf8");
        assert.match(traceContent, /"event":"check_state"/);
      } else {
        assert.equal(existsSync(expectedTracePath), false);
      }
      chat.gen++;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("body() aligns streaming and running top margins with formal entry spacing (0 / 8 / 18)", () => {
  const makeEl = (tag) => {
    const node = { tag, id: null, mtVal: null, children: [] };
    const proxy = new Proxy(node, {
      get(target, prop) {
        if (prop === "__node") return target;
        if (prop === "id") return (v) => { target.id = v; return proxy; };
        if (prop === "mt") return (v) => { target.mtVal = v; return proxy; };
        if (prop === "child") return (c) => { if (c != null) target.children.push(c?.__node ?? c); return proxy; };
        if (prop === "children") return (cs) => { for (const c of cs ?? []) if (c != null) target.children.push(c?.__node ?? c); return proxy; };
        if (prop === "when") return (cond, fn) => { if (cond) fn(proxy); return proxy; };
        return (..._args) => proxy;
      },
    });
    return proxy;
  };
  const { Chat } = makeChatClass({
    div: () => makeEl("div"),
    v_flex: () => makeEl("v_flex"),
    h_flex: () => makeEl("h_flex"),
  });

  const findContent = (node) => {
    if (!node || typeof node !== "object") return null;
    if (node.id === "content") return node;
    for (const c of node.children ?? []) {
      const hit = findContent(c);
      if (hit) return hit;
    }
    return null;
  };

  const measure = ({ ents = [], pending = [], streamText = null, running = null }) => {
    const chat = new Chat();
    chat.width = 900;
    chat.viewH = 600;
    chat.contentH = 0;
    chat.off = 0;
    chat.limit = 50;
    chat.t = { kind: "codex" };
    chat.pending = pending;
    chat.running = running;
    chat.settle = () => {};
    chat.shown = () => ({ start: 0, ents });
    chat.streamShown = () => streamText;
    chat.terminal = () => ({ id: "term/1", status: "working" });
    chat.entry = (e) => ({ kind: "entry", key: e.key });
    chat.queued = (_m, i) => ({ kind: "queued", index: i });
    chat.runningView = () => ({ kind: "running" });

    const root = chat.body({ surface: "#f8f8f8", hover: "#eee", muted: "#666", border: "#ddd", popover: "#fff", foreground: "#000" });
    const content = findContent(root.__node);
    assert.ok(content, "expected content node");
    const margins = {};
    for (const child of content.children) {
      const inner = child.children?.[0];
      if (inner?.kind === "entry" && inner.key === "streaming") margins.streaming = child.mtVal;
      if (inner?.kind === "running") margins.running = child.mtVal;
    }
    return margins;
  };

  // Empty rendered list -> first item gets mt(0), running after streaming gets mt(8)
  assert.deepEqual(measure({ ents: [], streamText: "hi", running: { title: "Working" } }), { streaming: 0, running: 8 });
  assert.deepEqual(measure({ ents: [], streamText: null, running: { title: "Working" } }), { running: 0 });

  // After user -> streaming / running-without-streaming gets mt(18)
  const userEnt = [{ key: "u1", kind: "user", text: "hello" }];
  assert.deepEqual(measure({ ents: userEnt, streamText: "hi", running: { title: "Working" } }), { streaming: 18, running: 8 });
  assert.deepEqual(measure({ ents: userEnt, streamText: null, running: { title: "Working" } }), { running: 18 });

  // After pending -> streaming / running-without-streaming gets mt(18)
  const pending = [{ text: "queued", id: "p1", afterKey: "a1" }];
  assert.deepEqual(measure({ ents: [{ key: "a1", kind: "assistant", text: "prev" }], pending, streamText: "hi", running: { title: "Working" } }), { streaming: 18, running: 8 });
  assert.deepEqual(measure({ ents: [{ key: "a1", kind: "assistant", text: "prev" }], pending, streamText: null, running: { title: "Working" } }), { running: 18 });

  // After assistant or tools -> streaming / running-without-streaming gets mt(8)
  assert.deepEqual(measure({ ents: [{ key: "a1", kind: "assistant", text: "part 1" }], streamText: "part 2" }), { streaming: 8 });
  assert.deepEqual(measure({ ents: [{ key: "t1", kind: "tools", items: [] }], streamText: null, running: { title: "Working" } }), { running: 8 });
});
