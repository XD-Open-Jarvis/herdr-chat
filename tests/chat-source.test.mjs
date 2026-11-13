import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../mods/chat/source.js", import.meta.url), "utf8");

function createTailClass(chunkOverride = null) {
  let code = source.replace(/^import .*;\n/gm, "").replace(/export /g, "");
  if (chunkOverride != null) {
    code = code.replace("const TAIL_CHUNK_BYTES = 4 * 1024 * 1024;", `const TAIL_CHUNK_BYTES = ${chunkOverride};`);
  }
  const execMock = async (cmd, args) => {
    const out = execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout: out, stderr: "" };
  };
  return runInNewContext(`${code}\nTail`, { exec: execMock });
}

test("Tail preserves exact byte offsets when initial tail boundary splits multi-byte UTF-8 characters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-tail-"));
  const file = join(dir, "session.jsonl");
  try {
    const line1 = JSON.stringify({ id: 1, text: "中文🚀".repeat(20) }) + "\n";
    const line2 = JSON.stringify({ id: 2, text: "完整的第二条消息" }) + "\n";
    const buf1 = Buffer.from(line1, "utf8");
    const buf2 = Buffer.from(line2, "utf8");
    writeFileSync(file, Buffer.concat([buf1, buf2]));

    // Pick a byte budget that lands mid-codepoint inside line1's UTF-8 sequence
    const Tail = createTailClass();
    const budget = buf2.length + 11; // 11 bytes into the end of line1 (inside 3/4-byte UTF-8 sequence)
    const tail = new Tail(file, null, budget);

    const initial = await tail.read();
    assert.equal(tail.truncated, true);
    assert.equal(initial.length, 1);
    assert.equal(JSON.parse(initial[0]).id, 2);
    assert.equal(tail.offset, buf1.length + buf2.length);

    // Append line3 and ensure zero byte drift (the opening '{"id":3' is not eaten!)
    const line3 = JSON.stringify({ id: 3, text: "后续新增消息不会丢失" }) + "\n";
    appendFileSync(file, line3);
    const next = await tail.read();
    assert.equal(next.length, 1);
    assert.deepEqual(JSON.parse(next[0]), { id: 3, text: "后续新增消息不会丢失" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Tail paginates large reads across chunks and preserves skipFirst across unfinished lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-tail-chunk-"));
  const file = join(dir, "session.jsonl");
  try {
    const records = Array.from({ length: 25 }, (_, i) => JSON.stringify({ i, body: "x".repeat(120) }) + "\n");
    writeFileSync(file, records.join(""));

    // Small chunk cap (600 bytes) forces multiple Python invocations inside a single tail.read()
    const Tail = createTailClass(600);
    const tail = new Tail(file, null, 100_000);
    const all = await tail.read();
    assert.equal(tail.truncated, false);
    assert.equal(all.length, 25);
    assert.deepEqual(
      Array.from(all, (l) => JSON.parse(l).i),
      Array.from({ length: 25 }, (_, i) => i),
    );

    // Now test initial read landing inside an unfinished line (no newline yet in tail window)
    const file2 = join(dir, "unfinished.jsonl");
    const firstLine = JSON.stringify({ i: 0, body: "a".repeat(200) }) + "\n";
    const partialSecond = '{"i":1,"body":"still-writing';
    writeFileSync(file2, firstLine + partialSecond);

    const tail2 = new Tail(file2, null, 15); // lands inside partialSecond, no '\n' yet
    assert.deepEqual(Array.from(await tail2.read()), []);
    assert.equal(tail2.skipFirst, true);

    // Complete partialSecond (skipped because truncated) and write line 2
    appendFileSync(file2, '"}\n{"i":2,"body":"complete"}\n');
    const afterFinish = await tail2.read();
    assert.equal(afterFinish.length, 1);
    assert.equal(JSON.parse(afterFinish[0]).i, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
