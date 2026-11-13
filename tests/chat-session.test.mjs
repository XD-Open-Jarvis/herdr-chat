import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';
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
 const resolve=(screen,identity=null,previous=null)=>JSON.parse(execFileSync('python3',['-c',script,JSON.stringify([screen,'/repo',files[0],history,identity,previous])],{env:{...process.env,HOME:home},encoding:'utf8'}));
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
test('Guardian copied context cannot win text, title or status matching',()=>fixture(({resolve,files,ids})=>{
 const first='First main conversation message with unique content';
 const second='Second main conversation reply with unique content';
 const record=(type,message)=>JSON.stringify({type:'event_msg',payload:{type,message}})+'\n';
 appendFileSync(files[0],record('user_message',first)+record('agent_message',second));
 const guardian='33333333-3333-3333-3333-333333333333';
 const path=files[0].replace(ids[0],guardian);
 writeFileSync(path,JSON.stringify({type:'session_meta',payload:{id:guardian,cwd:'/repo',parent_thread_id:ids[0],source:{subagent:{other:'guardian'}}}})+'\n'+record('user_message',first)+record('agent_message',second));
 const screen=first+'\n'+second;
 assert.equal(resolve(screen).file,files[0]);
 assert.deepEqual([resolve('',{prefix:guardian,complete:true}).file,resolve(`Model: gpt-5\nSession: ${guardian}\nContext window: 30%`).file],[null,null]);
 const old=resolve(screen,null,path);assert.equal(old.invalidPrevious,true);assert.equal(old.file,files[0]);
}));
test('parent or structured subagent source alone excludes copied logs',()=>fixture(({resolve,files,ids})=>{
 const text='Two independent messages in a different candidate';
 for(const [suffix,extra] of [['44444444-4444-4444-4444-444444444444',{parent_thread_id:ids[0]}],['55555555-5555-5555-5555-555555555555',{source:{subagent:{thread_spawn:{}}}}]]){
  const path=files[0].replace(ids[0],suffix);
  writeFileSync(path,JSON.stringify({type:'session_meta',payload:{id:suffix,cwd:'/repo',...extra}})+'\n'+JSON.stringify({type:'event_msg',payload:{type:'user_message',message:text}})+'\n');
  assert.equal(resolve('',{prefix:suffix,complete:true}).file,null);
 }
}));
test('duplicate primary root conversations remain ambiguous',()=>fixture(({resolve,files,ids})=>{
 const first='Identical root conversation request with enough content';
 const second='Identical root conversation answer with enough content';
 const records=[first,second].map((message,i)=>JSON.stringify({type:'event_msg',payload:{type:i?'agent_message':'user_message',message}})+'\n').join('');
 appendFileSync(files[0],records);
 const other='66666666-6666-6666-6666-666666666666';
 writeFileSync(files[0].replace(ids[0],other),JSON.stringify({type:'session_meta',payload:{id:other,cwd:'/repo',source:'cli'}})+'\n'+records);
 assert.equal(resolve(first+'\n'+second).file,null);
}));

test('subagent title match reports subagent=true while a brand-new root title reports subagent=false',()=>fixture(({resolve,files,ids})=>{
 const sub='77777777-7777-7777-7777-777777777777';
 writeFileSync(files[0].replace(ids[0],sub),JSON.stringify({type:'session_meta',payload:{id:sub,cwd:'/repo',parent_thread_id:ids[0]}})+'\n');
 const subRes=resolve('',{prefix:sub,complete:true});
 assert.equal(subRes.file,null);assert.equal(subRes.matchCount,0);assert.equal(subRes.subagent,true);
 const freshRes=resolve('',{prefix:'88888888-8888-8888-8888-888888888888',complete:true});
 assert.equal(freshRes.file,null);assert.equal(freshRes.matchCount,0);assert.equal(freshRes.subagent,false);
}));
