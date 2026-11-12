import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
const load=async name=>import('data:text/javascript;base64,'+Buffer.from(readFileSync(new URL(`../mods/chat/${name}.js`,import.meta.url),'utf8')).toString('base64'));
const {compactSettings,toolSummary}=await load('display');
const {withPending}=await load('timeline');
const command={kind:'user',command:true,key:'command',text:'/effort low',images:[]};
const success={kind:'notice',key:'success',event:'settings_changed',text:'Set effort level to low (saved as your default for new sessions)',detail:'Set effort level to low: Full explanation'};
test('a setting and its success render as one compact row without changing the source transcript',()=>{
 const source=[command,success],before=JSON.stringify(source);
 const shown=compactSettings(source);assert.equal(shown.length,1);
 assert.equal(shown[0].kind,'notice');assert.equal(shown[0].text,'Effort · low');
 assert.ok(shown[0].detail.includes('/effort low'));assert.ok(shown[0].detail.includes('Full explanation'));
 assert.equal(JSON.stringify(source),before);assert.equal(shown[0].key,command.key);
});
test('a settings command stays compact while awaiting confirmation and cancellation stays one row',()=>{
 const first=compactSettings([command]);assert.equal(first[0].kind,'notice');assert.equal(first[0].text,'/effort low');
 const shown=compactSettings([command,{kind:'output',text:'Cancelled',key:'cancel'}]);
 assert.equal(shown.length,1);assert.equal(shown[0].text,'/effort low · cancelled');
});
test('errors, warnings and non-settings commands remain visible',()=>{
 const error={kind:'output',key:'error',text:'Invalid effort value',error:true};
 assert.equal(compactSettings([command,error])[1],error);
 const normal={...command,text:'/help'};assert.equal(compactSettings([normal])[0],normal);
 const ordinary={kind:'user',text:'explain /effort low'};assert.equal(compactSettings([ordinary])[0],ordinary);
});
test('pending messages keep their place when their settings anchor is merged',()=>{
 const entries=compactSettings([{kind:'assistant',key:'old'},command,success,{kind:'assistant',key:'reply'}]);
 const shown=withPending(entries,[{afterKey:'success',text:'next'}]);
 assert.deepEqual(shown.map(e=>e.kind),['assistant','notice','pending','assistant']);
});
test('tool summaries group steps and count repeated edits to the same file once',()=>{
 const edit={name:'Edit',input:{file_path:'/a.js'},result:'ok'};
 const items=[{name:'Read',result:'ok'},edit,{...edit,input:JSON.stringify(edit.input)},
  {name:'Write',input:{file_path:'/b.js'},result:'ok'},{name:'Bash',result:'ok'},{name:'Grep',result:'ok'}];
 assert.equal(toolSummary(items),'1 read · 2 edits · 1 command · 1 search');
 assert.equal(toolSummary([{name:'Bash',result:'ok'},{name:'Bash',result:'ok'}]),'2 commands');
});
test('running tool summary shows current work and unknown tools retain their name',()=>{
 const items=[{name:'Read',result:'done'},{name:'Bash',summary:'npm test',result:null}];
 assert.equal(toolSummary(items,true),'Bash · npm test');
 assert.equal(toolSummary([{name:'custom_tool',result:'ok'},{name:'custom_tool',result:'ok'}]),'2 custom_tool');
});
test('collapsed single-tool summaries never expose multiline script bodies',()=>{
 const script="python3 - <<'PY'\nfrom pathlib import Path\nfrom datetime import datetime\nprint('private detail')\nPY";
 const label=toolSummary([{name:'Bash',summary:script,result:'ok'}]);
 assert.equal(label,"Bash · python3 - <<'PY'");assert.ok(!label.includes('\n'));assert.ok(!label.includes('from pathlib'));
 assert.equal(toolSummary([{name:'Bash',summary:script,result:null}],true),label);
});
test('tool row summary formatting keeps multiline content only in the original detail',async()=>{
 const {summaryLine}=await load('display');const text='\n\r\n  first line\r\nsecond line';
 assert.equal(summaryLine(text),'first line');assert.equal(text,'\n\r\n  first line\r\nsecond line');
});
