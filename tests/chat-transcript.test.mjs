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
test('hc image descriptors become previews before cleaned text',()=>{
 const e=codex('<hc from="mini/t1">\\{"bytes":43006,"path":"/tmp/paste.png"\\} 请看这张图</hc>')[0];
 assert.equal(e.text,'请看这张图');assert.equal(e.images[0].path,'/tmp/paste.png');assert.equal(e.from,'mini/t1');
});
test('multiple file descriptors become image previews and attachment cards',()=>{
 const e=codex('{"bytes":10,"path":"/tmp/a.png"} {"bytes":1024,"path":"/tmp/report.pdf"} 正文')[0];
 assert.equal(e.text,'正文');assert.equal(e.images.length,1);assert.equal(e.files.length,1);assert.equal(e.files[0].name,'report.pdf');
});
test('attachment-only messages remain visible without an empty text bubble',()=>{
 const e=codex('{"bytes":1024,"path":"/tmp/report.pdf"}')[0];
 assert.equal(e.text,'');assert.equal(e.files.length,1);
});
test('Claude uses the same transported attachment parser',()=>{
 const t=new Transcript('claude');t.user('<hc>{"bytes":10,"path":"/tmp/a.png"} hello</hc>');
 assert.equal(t.entries[0].text,'hello');assert.equal(t.entries[0].images.length,1);
});
test('ordinary JSON examples and malformed descriptors remain text',()=>{
 for(const text of ['Example: {"bytes":10,"path":"/tmp/a.png"}','```json\n{"bytes":10,"path":"/tmp/a.png"}\n```','{"bytes":"bad","path":"/tmp/a.png"}','{"path":"/tmp/a.png"}','{"bytes":10,"path":"https://example.com/a.png"}'])assert.equal(codex(text)[0].text,text);
});
test('native image blocks and their hc descriptors show the image once',()=>{
 const t=new Transcript('codex');
 t.feed(JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'{"bytes":10,"path":"/tmp/a.png"} hello'},{type:'input_image',image_url:'data:image/png;base64,YWJj'}]}}));
 assert.equal(t.entries[0].images.length,1);assert.equal(t.entries[0].images[0].data,'YWJj');assert.equal(t.entries[0].text,'hello');
});
