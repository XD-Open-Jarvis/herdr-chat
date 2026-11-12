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
