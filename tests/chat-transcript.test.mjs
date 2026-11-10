import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
const source = readFileSync(new URL('../mods/chat/parse.js', import.meta.url),'utf8');
const {Transcript} = await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
function codex(text) {
  const t=new Transcript('codex');
  t.feed(JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}}));
  return t.entries;
}
test('Codex displays an hc user message and its sender',()=>{
  const e=codex('<hc from="t1">终端滚动很卡\n第二行</hc>');
  assert.equal(e.length,1);assert.equal(e[0].kind,'user');
  assert.equal(e[0].text,'终端滚动很卡\n第二行');assert.equal(e[0].from,'t1');
});
test('remote hc addresses are kept as sender metadata',()=>{
  assert.equal(codex('<hc from="mac/ppid:18571">你好</hc>')[0].from,'mac/ppid:18571');
});
test('Claude displays the same hc envelope',()=>{
  const t=new Transcript('claude');
  t.feed(JSON.stringify({type:'user',message:{content:'<hc from="t1">继续</hc>'}}));
  assert.equal(t.entries[0].text,'继续');assert.equal(t.entries[0].from,'t1');
});
test('a transport wrapper without sender still displays its content',()=>{
  assert.equal(codex('<hc>hello</hc>')[0].text,'hello');
});
test('internal environment and task envelopes remain filtered',()=>{
  assert.equal(codex('<environment_context>internal</environment_context>').length,0);
  const t=new Transcript('claude');t.user('<task-notification>internal</task-notification>');
  assert.equal(t.entries.length,0);
});
test('ordinary messages, literal inline hc tags and images are preserved',()=>{
  assert.equal(codex('example: <hc from="t1">hello</hc>')[0].text,'example: <hc from="t1">hello</hc>');
  const t=new Transcript('claude');t.user('',[{path:'/tmp/image.png'}]);
  assert.equal(t.entries[0].images.length,1);
});
test('system reminders inside transported input stay hidden',()=>{
  assert.equal(codex('<hc from="t1"><system-reminder>internal</system-reminder>hello</hc>')[0].text,'hello');
});
