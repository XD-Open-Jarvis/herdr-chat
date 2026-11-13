import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../mods/chat/main.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\n/gm, '').replace('export default class Chat', 'class Chat');
const Chat = runInNewContext(source + '\nChat', { View: class {} });

test('a prior reply still on the terminal is never shown after a new logged user message', () => {
  const old = 'The earlier answer is still visible on the terminal screen while a new message begins.';
  const view = Object.assign(Object.create(Chat.prototype), {
    t: { entries: [{ kind: 'assistant', text: old }, { kind: 'user', text: 'new question' }] },
    stream: old.slice(0, -15), streamUsers: 1, pending: [],
  });
  assert.equal(view.previousReplyOnScreen(view.stream), true);
  assert.equal(view.streamShown(), null);
});

test('a live reply remains visible until the log contains all of its visible text', () => {
  const view = Object.assign(Object.create(Chat.prototype), {
    t: { entries: [{ kind: 'user', text: 'question' }, { kind: 'assistant', text: 'The first part' }] },
    stream: 'The first part and the rest of the live reply', streamUsers: 1, pending: [],
  });
  assert.equal(view.logged(view.stream), false);
  assert.equal(view.streamShown(), view.stream);
  view.t.entries[1].text = view.stream;
  assert.equal(view.streamShown(), null);
});
