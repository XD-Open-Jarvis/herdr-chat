import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
const source=readFileSync(new URL('../mods/chat/history.js',import.meta.url),'utf8');
const script=runInNewContext(source.replace(/^import .*;\n/gm,'').replace(/export /g,'')+'\nHISTORY_PY');
function setup(){
 const home=mkdtempSync(join(tmpdir(),'chat-history-'));const dir=join(home,'.codex/sessions');mkdirSync(dir,{recursive:true});
 const ids=['11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333'];
 const files=ids.map(id=>join(dir,`rollout-date-${id}.jsonl`));
 const line=text=>JSON.stringify({type:'message',text})+'\n';
 const write=(n,base,text)=>{writeFileSync(files[n],JSON.stringify({type:'session_meta',payload:{id:ids[n],...(base?{history_base:base}:{})}})+'\n'+text);return Buffer.byteLength(readFileSync(files[n]));};
 const read=(n,bytes)=>JSON.parse(execFileSync('python3',['-c',script,files[n],...(bytes ? [String(bytes)] : [])],{env:{...process.env,HOME:home},encoding:'utf8',maxBuffer:16*1024*1024,stdio:['pipe','pipe','pipe']}));
 return {home,ids,files,line,write,read,close:()=>rmSync(home,{recursive:true,force:true})};
}
test('nested forks inherit only each parent prefix and read child complete lines once',()=>{
 const s=setup();try{
 const a=s.write(0,null,s.line('A'));writeFileSync(s.files[0],s.line('parent-after-fork'),{flag:'a'});
 const b=s.write(1,{thread_id:s.ids[0],end_byte_offset:a},s.line('B'));
 writeFileSync(s.files[1],s.line('sibling-after-fork'),{flag:'a'});
 const end=s.write(2,{thread_id:s.ids[1],end_byte_offset:b},s.line('C'));
 writeFileSync(s.files[2],'{"unfinished":',{flag:'a'});
 const result=s.read(2);assert.deepEqual(result.lines.map(l=>JSON.parse(l).text),['A','B','C']);assert.equal(result.offset,end);
 }finally{s.close();}
});
test('missing parent produces a clear error instead of silently showing partial history',()=>{
 const s=setup();try{s.write(1,{thread_id:s.ids[0],end_byte_offset:100},s.line('B'));assert.throws(()=>s.read(1),/missing or ambiguous/);}finally{s.close();}
});
test('large inherited history is bounded and marked truncated',()=>{
 const s=setup();try{const end=s.write(0,null,Array.from({length:6000},(_,i)=>s.line(String(i)+'x'.repeat(1000))).join(''));s.write(1,{thread_id:s.ids[0],end_byte_offset:end},s.line('child'));const result=s.read(1);assert(result.truncated);assert.equal(JSON.parse(result.lines.at(-1)).text,'child');assert(Buffer.byteLength(result.lines.join('\n'))<4*1024*1024);}finally{s.close();}
});

test('explicit byte budgets progressively reveal older inherited records without crossing the fork boundary',()=>{
 const s=setup();try{
 const end=s.write(0,null,Array.from({length:20},(_,i)=>s.line(`parent-${i}-`+'x'.repeat(100))).join(''));
 writeFileSync(s.files[0],s.line('not-in-this-fork'),{flag:'a'});
 s.write(1,{thread_id:s.ids[0],end_byte_offset:end},s.line('child'));
 const small=s.read(1,500),large=s.read(1,10000);
 assert(small.truncated);assert.equal(large.truncated,false);
 assert(large.lines.length>small.lines.length);
 assert.equal(JSON.parse(large.lines[0]).text,'parent-0-'+'x'.repeat(100));
 assert.equal(JSON.parse(large.lines.at(-1)).text,'child');
 assert(!large.lines.some(line=>line.includes('not-in-this-fork')));
 }finally{s.close();}
});
test('reloading older history preserves message anchors and shifts pending user counts only by prepended users',()=>{
 const rebase=runInNewContext(source.replace(/^import .*;\n/gm,'').replace(/export /g,'')+'\nrebaseHistory');
 const previous={entries:[{kind:'user',text:'recent',key:'e0'},{kind:'assistant',text:'answer',key:'e1'}],breakAfter:'e1'};
 const next={entries:[{kind:'user',text:'older',key:'e0'},{kind:'assistant',text:'old answer',key:'e1'},...previous.entries.map(e=>({...e}))]};
 const pending=[{users:1,afterKey:'e1'}];
 rebase(previous,next,pending,7);
 assert.equal(next.entries[2].key,'e0');assert.equal(next.entries[3].key,'e1');
 assert.equal(next.entries[0].key,'history-7-0');assert.equal(pending[0].users,2);
 assert.equal(next.breakAfter,'e1');assert.equal(pending[0].afterKey,'e1');
});

test('archived parent sessions and non-UTF8 tool output bytes are decoded without crashing',()=>{
 const s=setup();try{
  const archDir=join(s.home,'.codex/archived_sessions');mkdirSync(archDir,{recursive:true});
  const archFile=join(archDir,`rollout-archived-${s.ids[0]}.jsonl`);
  const meta=Buffer.from(JSON.stringify({type:'session_meta',payload:{id:s.ids[0]}})+'\n');
  const rawLine=Buffer.concat([Buffer.from('{"type":"message","text":"bad-'),Buffer.from([0xff,0xfe]),Buffer.from('"}\n')]);
  writeFileSync(archFile,Buffer.concat([meta,rawLine]));
  s.write(1,{thread_id:s.ids[0],end_byte_offset:meta.length+rawLine.length},s.line('from-child'));
  const result=s.read(1);
  assert.equal(result.lines.length,2);
  assert.ok(JSON.parse(result.lines[0]).text.startsWith('bad-'));
  assert.equal(JSON.parse(result.lines[1]).text,'from-child');
 }finally{s.close();}
});

test('windowed skip_tail pagination stitches multi-window inherited history cleanly on line boundaries',async()=>{
 const s=setup();try{
  const end=s.write(0,null,Array.from({length:30},(_,i)=>s.line(`msg-${i}-`+'y'.repeat(80))).join(''));
  s.write(1,{thread_id:s.ids[0],end_byte_offset:end},s.line('child-end'));
  const execMock=async(_cmd,args)=>{
   const out=execFileSync('python3',args,{env:{...process.env,HOME:s.home},encoding:'utf8',maxBuffer:16*1024*1024});
   return {code:0,stdout:out,stderr:''};
  };
  const smallChunkSource=source.replace(/^import .*;\n/gm,'').replace(/export /g,'').replace('const HISTORY_CHUNK = 3 * 1024 * 1024;','const HISTORY_CHUNK = 900;');
  const inheritedHistory=runInNewContext(smallChunkSource+'\ninheritedHistory',{exec:execMock});
  const full=s.read(1,100000);
  const stitched=await inheritedHistory(s.files[1],null,100000);
  assert.deepEqual(Array.from(stitched.lines),full.lines);
  assert.equal(stitched.truncated,false);
  assert.equal(stitched.offset,full.offset);
 }finally{s.close();}
});

test('rebaseHistory aligns identical short entries to the recent suffix instead of prepended duplicates',()=>{
 const rebase=runInNewContext(source.replace(/^import .*;\n/gm,'').replace(/export /g,'')+'\nrebaseHistory');
 const previous={
  entries:[{kind:'user',text:'ok',key:'recent-u'},{kind:'assistant',text:'done',key:'recent-a'}],
  breakAfter:'recent-a',
 };
 const next={
  entries:[
   {kind:'user',text:'ok',key:'x0'},
   {kind:'assistant',text:'earlier reply',key:'x1'},
   {kind:'user',text:'ok',key:'x2'},
   {kind:'assistant',text:'done',key:'x3'},
  ],
 };
 const pending=[{users:1,afterKey:'recent-a'}];
 rebase(previous,next,pending,1);
 assert.equal(next.entries[0].key,'history-1-0');
 assert.equal(next.entries[2].key,'recent-u');
 assert.equal(next.entries[3].key,'recent-a');
 assert.equal(pending[0].users,2);
});

test('inheritedHistory advances past oversized single JSONL lines (> window size) and slims compacted records',async()=>{
 const s=setup();try{
  const bigCompacted=JSON.stringify({type:'compacted',payload:{blob:'z'.repeat(25000)}})+'\n';
  const older=Array.from({length:5},(_,i)=>s.line(`older-${i}`));
  const newer=Array.from({length:3},(_,i)=>s.line(`newer-${i}`));
  const end=s.write(0,null,older.join('')+bigCompacted+newer.join(''));
  const execMock=async(_cmd,args)=>{
   const out=execFileSync('python3',args,{env:{...process.env,HOME:s.home},encoding:'utf8',maxBuffer:16*1024*1024});
   return {code:0,stdout:out,stderr:''};
  };
  const smallChunkSource=source.replace(/^import .*;\n/gm,'').replace(/export /g,'').replace('const HISTORY_WINDOW = 3 * 1024 * 1024;','const HISTORY_WINDOW = 1024;');
  const inheritedHistory=runInNewContext(smallChunkSource+'\ninheritedHistory',{exec:execMock});
  const first=await inheritedHistory(s.files[0],null,4096);
  assert.ok(first.lines.some(l=>l==='{"type":"compacted"}'),'oversized compacted record should be consumed and slimmed');
  assert.equal(first.truncated,true);
  const res=await inheritedHistory(s.files[0],null,30000);
  const texts=res.lines.filter(l=>!l.includes('"compacted"')).map(l=>JSON.parse(l).text);
  assert.ok(texts.includes('older-4'),'larger budget must advance past the >window compacted line into older entries');
  assert.deepEqual(Array.from(texts.slice(-3)),['newer-0','newer-1','newer-2']);
  assert.equal(res.offset,end);
 }finally{s.close();}
});
