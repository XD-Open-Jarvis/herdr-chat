import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
const load=(file,name)=>runInNewContext(readFileSync(new URL('../mods/chat/'+file,import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'')+'\n'+name);
const script=load('session.js','SESSION_PY'), history=load('history.js','HISTORY_PY');
function fixture(fn){
 const home=mkdtempSync(join(tmpdir(),'session-match-'));const dir=join(home,'.codex/sessions');mkdirSync(dir,{recursive:true});
 const ids=['11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222'];
 const files=ids.map(id=>join(dir,`rollout-date-${id}.jsonl`));
 const message=(text,type='user_message')=>JSON.stringify({type:'event_msg',payload:{type,message:text}})+'\n';
 const common='This common conversation text is inherited by both branches';
 const write=(i,text,base)=>writeFileSync(files[i],JSON.stringify({type:'session_meta',payload:{id:ids[i],cwd:'/repo',...(base?{history_base:base}:{})}})+'\n'+text);
 write(0,message(common));const bound=Buffer.byteLength(readFileSync(files[0]));
 write(1,message('First distinctive child message with enough characters')+message('Second distinctive child reply with enough characters','agent_message'),{thread_id:ids[0],end_byte_offset:bound});
 const resolve=(screen,identity=null)=>JSON.parse(execFileSync('python3',['-c',script,JSON.stringify([screen,'/repo',files[0],history,identity])],{env:{...process.env,HOME:home},encoding:'utf8'}));
 try{fn({resolve,files,ids,common});}finally{rmSync(home,{recursive:true,force:true});}
}
test('shared inherited fork history remains ambiguous despite open parent hint',()=>fixture(({resolve,common})=>assert.equal(resolve(common).file,null)));
test('two child conversation anchors select child despite parent hint',()=>fixture(({resolve,files})=>assert.equal(resolve('First distinctive child message with enough characters\nSecond distinctive child reply with enough characters').file,files[1])));
test('one matching line is insufficient',()=>fixture(({resolve})=>assert.equal(resolve('First distinctive child message with enough characters').file,null)));
test('visible status panel identifies exact session; quoted ID alone does not',()=>fixture(({resolve,ids,files})=>{assert.equal(resolve(`Session: ${ids[1]}`).file,null);assert.equal(resolve(`Model: gpt-5\nSession: ${ids[1]}\nContext window: 30%`).file,files[1]);}));
test('unknown or conflicting status IDs never select a candidate',()=>fixture(({resolve,ids})=>assert.equal(resolve(`Model: gpt-5\nSession: ${ids[0]}\nSession: ${ids[1]}\nContext window: 30%`).file,null)));
test('reversed message order cannot identify a branch',()=>fixture(({resolve})=>assert.equal(resolve('Second distinctive child reply with enough characters\nFirst distinctive child message with enough characters').file,null)));
test('two wrapped lines from one message cannot identify a branch',()=>fixture(({resolve})=>assert.equal(resolve('First distinctive child\nmessage with enough characters').file,null)));
test('terminal title identifies a fork from only its unique UUID prefix with zero text',()=>fixture(({resolve,ids,files})=>{
 const result=resolve('',{prefix:ids[1].slice(0,29),complete:false});assert.equal(result.file,files[1]);assert.equal(result.sessionId,ids[1]);assert.equal(result.evidence,'title');
}));
test('an unresolved new terminal title never falls back to old matching text',()=>fixture(({resolve,common})=>{
 const result=resolve(common,{prefix:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaa',complete:false});assert.equal(result.file,null);assert.equal(result.evidence,'title');
}));
test('colliding prefixes fail closed instead of choosing a file by date',()=>fixture(({resolve,ids,files})=>{
 const id=ids[0].slice(0,29)+'2222222';const path=files[1].replace(ids[1],id);
 writeFileSync(path,JSON.stringify({type:'session_meta',payload:{id,cwd:'/repo'}})+'\n');
 assert.equal(resolve('',{prefix:ids[0].slice(0,29),complete:false}).file,null);
}));
test('an empty new title is distinguished from a collision while waiting for its log',()=>fixture(({resolve})=>{
 const result=resolve('',{prefix:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaa',complete:false});
 assert.equal(result.file,null);assert.equal(result.matchCount,0);assert.equal(result.evidence,'title');
}));
