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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
