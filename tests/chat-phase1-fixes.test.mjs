import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const loadMod = async (rel) =>
  import("data:text/javascript;base64," + Buffer.from(readFileSync(new URL(rel, import.meta.url), "utf8")).toString("base64"));

const { Outbox, outboxScope } = await loadMod("../mods/chat/outbox.js");
const emojiCombined =
  readFileSync(new URL("../mods/chat/emoji-names.js", import.meta.url), "utf8").replace(/^export /gm, "") +
  "\n" +
  readFileSync(new URL("../mods/chat/emoji.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
const { emojify, emojiMatches } = await import(
  "data:text/javascript;base64," + Buffer.from(emojiCombined).toString("base64")
);
const { live } = await loadMod("../mods/chat/stream.js");

const mainSource = readFileSync(new URL("../mods/chat/main.js", import.meta.url), "utf8")
  .replace(/^import[\s\S]*?;\n/gm, "")
  .replace("export default class Chat", "class Chat");

function makeChatClass(overrides = {}) {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  const Chat = runInNewContext(`${mainSource}\nChat`, {
    View: class {},
    appWindow: () => ({ platform: "macos" }),
    Outbox,
    outboxScope,
    emojify,
    emojiMatches,
    localStorage,
    machineOf: () => null,
    agentKind: () => "claude",
    codexTitleIdentity: () => null,
    titleMatchesFile: () => true,
    sessionOf: () => "sid",
    notify: () => {},
    ...overrides,
  });
  return { Chat, store };
}

test("Outbox localStorage is isolated per terminalId and migrates matching legacy outbox-v1 items", () => {
  const { Chat, store } = makeChatClass();
  store.set(
    "outbox-v1",
    JSON.stringify({
      items: [
        { id: "1", text: "for-t1", paths: [], attachments: [], scope: "t1:10:s1", state: "queued" },
        { id: "2", text: "for-t2", paths: [], attachments: [], scope: "t2:20:s2", state: "queued" },
      ],
      gate: null,
    }),
  );

  const c1 = Object.assign(Object.create(Chat.prototype), { dialog: false, terminalId: "t1" });
  const c2 = Object.assign(Object.create(Chat.prototype), { dialog: false, terminalId: "t2" });
  c1.loadOutbox();
  c2.loadOutbox();

  assert.deepEqual(Array.from(c1.outbox.items, (x) => x.text), ["for-t1"]);
  assert.deepEqual(Array.from(c2.outbox.items, (x) => x.text), ["for-t2"]);

  // Saving c1 must not overwrite c2's queue
  c1.outbox.remove("1");
  c1.saveOutbox();
  c2.saveOutbox();

  const c2Reloaded = Object.assign(Object.create(Chat.prototype), { dialog: false, terminalId: "t2" });
  c2Reloaded.loadOutbox();
  assert.deepEqual(Array.from(c2Reloaded.outbox.items, (x) => x.text), ["for-t2"]);
});

test("failed queued item auto-expands outbox, settle preserves delivering items and ignores command entries, and afterKey skips ephemeral cards", async () => {
  const { Chat } = makeChatClass();
  const tasks = [];
  const cx = { notify() {}, spawn(fn) { tasks.push(() => fn(cx)); } };
  const context = { scope: "t1:42:sid", status: "idle", turn: 1 };
  const chat = Object.assign(Object.create(Chat.prototype), {
    dialog: false,
    terminalId: "t1",
    pending: [],
    outboxExpanded: false,
    queueContext: () => context,
    terminal: () => ({ status: "idle" }),
    t: {
      entries: [
        { kind: "assistant", key: "real-reply", text: "hi" },
        { kind: "user", key: "cmd-u", text: "/status", command: true, ephemeral: true },
        { kind: "card", key: "card-1", title: "Status", ephemeral: true },
      ],
      markInput() {},
    },
    deliver: async () => { throw new Error("transport failed"); },
  });
  Object.defineProperty(chat, "term", { value: "t1" });
  chat.loadOutbox();

  // Enqueue non-direct (queued) item and trigger failed delivery
  const item = chat.outbox.enqueue({ text: "queued msg", paths: [], attachments: [], direct: false }, context.scope);
  chat.pumpOutbox(cx);
  assert.equal(chat.pending.length, 1);
  // afterKey skips ephemeral /status card and anchors to "real-reply"
  assert.equal(chat.pending[0].afterKey, "real-reply");
  // userCount ignores { command: true }
  assert.equal(chat.pending[0].users, 0);

  // While delivering=true, settle() must NOT drop the item even if >15s elapsed (e.g. 60s draft protection)
  chat.pending[0].at = Date.now() - 30_000;
  chat.settle();
  assert.equal(chat.pending.length, 1);

  // Finish failed delivery -> auto-expands outbox so Retry button is visible
  await tasks.shift()();
  assert.equal(item.state, "error");
  assert.equal(chat.outboxExpanded, true);
});

function makeTokenAwareInput(initial = "") {
  let text = initial;
  let sel = { start: text.length, end: text.length };
  let tokens = [];
  return {
    value: () => text,
    tokens: () => tokens.map((t) => ({ ...t })),
    focus() {},
    set_value(v) {
      text = v;
      tokens = [];
      sel = { start: text.length, end: text.length };
    },
    set_selected_range(range) {
      sel = { start: range.start, end: range.end };
    },
    replace(ins) {
      const delta = ins.length - (sel.end - sel.start);
      tokens = tokens
        .filter((tk) => !(tk.range.start < sel.end && tk.range.end > sel.start))
        .map((tk) =>
          tk.range.start >= sel.end
            ? { ...tk, range: { start: tk.range.start + delta, end: tk.range.end + delta } }
            : tk,
        );
      text = text.slice(0, sel.start) + ins + text.slice(sel.end);
      sel = { start: sel.start + ins.length, end: sel.start + ins.length };
    },
    addToken(tokenText, id = "cmd:review") {
      const start = text.length;
      text += tokenText;
      tokens.push({ id, text: tokenText, range: { start, end: text.length } });
      sel = { start: text.length, end: text.length };
    },
  };
}

test("emojifyInput, @mention and :emoji: preserve multiline newlines and /command tokens", async () => {
  const { Chat } = makeChatClass();
  const input = makeTokenAwareInput();
  input.addToken("/review");
  input.replace(" line one\nline two ");
  const tasks = [];
  const cx = { notify() {}, spawn(fn) { tasks.push(() => fn(cx)); } };
  const chat = Object.assign(Object.create(Chat.prototype), {
    dialog: false,
    input,
    slash: () => null,
    terminal: () => ({ cwd: "/repo" }),
    fileList: { folder: "/repo", at: Date.now(), paths: ["mods/chat/main.js", "README.md"] },
  });

  // 1. @mention on line 2 preserves /review token and line 1 newline
  input.replace("@main");
  chat.updateMention(cx);
  assert.ok(chat.mentionMenu());
  chat.pickMention("mods/chat/main.js", cx);
  assert.equal(input.value(), "/review line one\nline two @mods/chat/main.js ");
  assert.equal(input.tokens().length, 1);
  assert.equal(input.tokens()[0].text, "/review");

  // 2. :emoji: menu on line 2 preserves /review token and multiline draft
  input.replace(":rock");
  chat.updateEmoji(cx);
  await tasks.shift()();
  const em = chat.emojiMenu();
  assert.ok(em);
  const rocket = em.items.find((x) => x.name === "rocket") ?? em.items[0];
  chat.pickEmoji(rocket, cx);
  assert.equal(input.value(), `/review line one\nline two @mods/chat/main.js ${rocket.char} `);
  assert.equal(input.tokens().length, 1);

  // 3. Inline :+1: via emojifyInput preserves /review token and newlines
  input.replace(":+1:");
  chat.emojifyInput();
  assert.equal(input.value(), `/review line one\nline two @mods/chat/main.js ${rocket.char} 👍`);
  assert.equal(input.tokens().length, 1);
});

test("stream.js live() stops at an empty Codex › prompt without scraping bullets below the composer", () => {
  const screen = [
    "› explain this",
    "",
    "• Streaming current turn reply.",
    "",
    "›",
    "• Hint or menu item below the input box",
  ].join("\n");
  assert.deepEqual(live(screen, "codex"), { kind: "text", text: "Streaming current turn reply." });
});

test("models.js preserves custom Claude model, parses only top-level Codex TOML keys, and restores/removes Claude settings safely", async () => {
  const modelsSrc = readFileSync(new URL("../mods/chat/models.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace(/export /g, "");
  const dir = mkdtempSync(join(tmpdir(), "chat-models-"));
  try {
    const toml = [
      "model = 'gpt-5.4'",
      "model_reasoning_effort = 'high'",
      "",
      "[profiles.other]",
      'model = "o3-mini"',
      'model_reasoning_effort = "low"',
    ].join("\n");
    const claudeSettings = JSON.stringify({ model: "litellm/claude-custom", effortLevel: "max" });
    const runModels = (execFn, hcFn = async () => ({ code: 0 })) =>
      runInNewContext(`${modelsSrc}\n({ catalog, switchModel })`, { exec: execFn, hc: hcFn, CODEX_TITLE_CONFIG: "" });

    const m1 = runModels(async (_cmd, args) => {
      const target = args[3] ?? "";
      if (target.includes("models_cache.json")) {
        return { code: 0, stdout: JSON.stringify({ models: [{ slug: "gpt-5.4", display_name: "GPT-5.4", visibility: "list" }] }) };
      }
      if (target.includes("config.toml")) return { code: 0, stdout: toml };
      return { code: 0, stdout: claudeSettings };
    });

    const codexCat = await m1.catalog("codex", null);
    assert.equal(codexCat.model, "gpt-5.4");
    assert.equal(codexCat.effort, "high");

    const claudeCat = await m1.catalog("claude", null);
    assert.equal(claudeCat.model, "litellm/claude-custom");
    assert.ok(claudeCat.models.some((x) => x.id === "litellm/claude-custom"));

    // Codex switchModel without model rejects cleanly instead of sending "/model null"
    await assert.rejects(m1.switchModel("t1", "codex", null, "high", null, async () => {}), /Choose a model/);

    // Claude switchModel when settings.json did NOT exist removes any file created during /model
    const fakeHome = join(dir, "home-missing");
    const mMissing = runModels(
      async (cmd, args) => {
        const out = execFileSync(cmd, args, { env: { ...process.env, HOME: fakeHome }, encoding: "utf8" });
        return { code: 0, stdout: out, stderr: "" };
      },
      async () => {
        // Simulate Claude creating ~/.claude/settings.json during /model
        execFileSync("sh", ["-c", 'mkdir -p "$HOME/.claude" && echo \'{"model":"opus"}\' > "$HOME/.claude/settings.json"'], {
          env: { ...process.env, HOME: fakeHome },
        });
        return { code: 0 };
      },
    );
    await mMissing.switchModel("t1", "claude", "opus", null, null, async () => {});
    assert.throws(() => readFileSync(join(fakeHome, ".claude/settings.json"), "utf8"), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chat-file REMOTE_SAVE_PY enforces optimistic concurrency and writes atomically", () => {
  const fileSrc = readFileSync(new URL("../mods/chat-file/main.js", import.meta.url), "utf8");
  const remoteSavePy = runInNewContext(
    fileSrc.slice(fileSrc.indexOf("const REMOTE_SAVE_PY ="), fileSrc.indexOf("export function imageFit")) + "\nREMOTE_SAVE_PY",
  );
  const dir = mkdtempSync(join(tmpdir(), "chat-remote-save-"));
  const target = join(dir, "nested/CLAUDE.md");
  try {
    // 1. New file (expected = null) creates parent dirs and writes content
    execFileSync("python3", ["-c", remoteSavePy, target, "first version\n", "null"], { encoding: "utf8" });
    assert.equal(readFileSync(target, "utf8"), "first version\n");

    // 2. Matching expected content updates atomically
    execFileSync("python3", ["-c", remoteSavePy, target, "second version\n", JSON.stringify("first version\n")], { encoding: "utf8" });
    assert.equal(readFileSync(target, "utf8"), "second version\n");

    // 3. Stale expected content fails with exit code 2 without clobbering disk
    writeFileSync(target, "external edit\n");
    assert.throws(
      () => execFileSync("python3", ["-c", remoteSavePy, target, "overwrite\n", JSON.stringify("second version\n")], { encoding: "utf8", stdio: "pipe" }),
      /File changed on disk/,
    );
    assert.equal(readFileSync(target, "utf8"), "external edit\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
