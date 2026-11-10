import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
const source=readFileSync(new URL('../mods/chat/owner.js',import.meta.url),'utf8');
function moduleWith(globals={}) {
 return runInNewContext(source.replace(/^import .*;\n/gm,'').replace(/\bexport /g,''),globals);
}
function load(globals={}) {
 return runInNewContext(source.replace(/^import .*;\n/gm,'').replace(/\bexport /g,'')+'\n({OWNER_PY,createChat,openChat})',globals);
}
const {OWNER_PY}=load();
// Actual tab shape reported by the MBP, plus the newly created Chat pane.
function fixture() {
 return {spaces:[{id:'s1',tabs:[{id:'tb-owner',root:{id:'root',type:'row',children:[
  {id:'p-agent',content:{terminal:'t14'}},
  {id:'p-old-tab-only',content:{mod:'chat',props:{terminal:'t14',owner_tab:'tb-owner'}}},
  {id:'p-old-alias',content:{mod:'chat',props:{terminal:'mini/t14'}}},
  {id:'p-new',content:{mod:'chat',props:{terminal:'t14',owner_tab:'tb-owner',model:'keep'}}},
 ]}}]}],future:{keep:true}};
}
function core(initial=fixture(), conflict=false) {
 const dir=mkdtempSync(join(tmpdir(),'chat-owner-test-'));
 const state=join(dir,'state.json'),log=join(dir,'calls.jsonl');
 writeFileSync(state,JSON.stringify({version:1,value:initial}));
 writeFileSync(join(dir,'hc'),`#!/usr/bin/env node
const fs=require('node:fs');
const request=JSON.parse(fs.readFileSync(0,'utf8'));
const file=process.env.CHAT_OWNER_STATE,log=process.env.CHAT_OWNER_LOG;
fs.appendFileSync(log,JSON.stringify(request)+'\\n');
const state=JSON.parse(fs.readFileSync(file,'utf8'));
let response;
if(request.method==='doc.get')response={result:state};
else if(request.method==='doc.set'){
 if(process.env.CHAT_OWNER_CONFLICT==='1'&&!state.conflicted){
  state.conflicted=true;state.version++;state.value.concurrent={keep:true};
  fs.writeFileSync(file,JSON.stringify(state));response={error:{data:{kind:'conflict'}}};
 }else if(request.params.version!==state.version)response={error:{data:{kind:'conflict'}}};
 else {state.value=request.params.value;state.version++;fs.writeFileSync(file,JSON.stringify(state));response={result:{version:state.version}};}
}else response={error:{message:'Unexpected core mutation'}};
console.log(JSON.stringify({jsonrpc:'2.0',id:1,...response}));
`,{mode:0o755});
 const env={...process.env,PATH:dir+':'+process.env.PATH,CHAT_OWNER_STATE:state,CHAT_OWNER_LOG:log,CHAT_OWNER_CONFLICT:conflict?'1':'0'};
 return {
  call:(mode,pane='alias/p-new',tab='alias/tb-owner',terminal='alias/t14')=>JSON.parse(execFileSync('python3',['-c',OWNER_PY,mode,pane,tab,terminal],{env,encoding:'utf8',stdio:['pipe','pipe','pipe']})),
  state:()=>JSON.parse(readFileSync(state,'utf8')),
  calls:()=>readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),
  close:()=>rmSync(dir,{recursive:true,force:true}),
 };
}
test('multi-chat tab binds only the exact newly returned pane and preserves old panes and agent',()=>{
 const original=fixture(),c=core(original);
 try{
  assert.equal(c.call('find',''),null);
  c.call('bind');
  const doc=c.state().value,children=doc.spaces[0].tabs[0].root.children;
  assert.deepEqual(children.slice(0,3),original.spaces[0].tabs[0].root.children.slice(0,3));
  assert.deepEqual(children[3].content.props,{terminal:'t14',owner_tab:'tb-owner',owner_pane:'p-new',model:'keep'});
  assert.deepEqual(doc.future,original.future);
  assert.equal(c.call('find',''),'p-new');
  assert(c.calls().every(request=>['doc.get','doc.set'].includes(request.method)&&request.params.on==='alias'));
 }finally{c.close();}
});
test('current client alias selects the core; persisted owner IDs stay local',()=>{
 const c=core();try{
  c.call('bind','mbp-connection/p-new','mbp-connection/tb-owner','mbp-connection/t14');
  assert(c.calls().every(request=>request.params.on==='mbp-connection'));
  assert.equal(c.state().value.spaces[0].tabs[0].root.children[3].content.props.owner_pane,'p-new');
 }finally{c.close();}
});
test('concurrent document changes survive the version retry',()=>{
 const c=core(fixture(),true);try{
  c.call('bind');assert.deepEqual(c.state().value.concurrent,{keep:true});
  assert.equal(c.calls().filter(r=>r.method==='doc.set').length,2);
 }finally{c.close();}
});
test('binding is idempotent and does not rewrite an already owned pane',()=>{
 const c=core();try{
  c.call('bind');c.call('bind');assert.equal(c.calls().filter(r=>r.method==='doc.set').length,1);
 }finally{c.close();}
});
test('a changed target binding is rejected without modifying the document',()=>{
 const initial=fixture();initial.spaces[0].tabs[0].root.children[3].content.props.terminal='t99';
 const c=core(initial);try{
  assert.throws(()=>c.call('bind'));assert.deepEqual(c.state().value,initial);
  assert.equal(c.calls().filter(r=>r.method==='doc.set').length,0);
 }finally{c.close();}
});
test('createChat waits for exact owner binding after pane creation',async()=>{
 const calls=[];
 const api=load({
  chatProps:(terminal,tab)=>({terminal:terminal.split('/').pop(),owner_tab:tab.split('/').pop()}),
  herdr:async(command,args)=>{calls.push({command,args});return {pane:'alias/p-new'};},
  exec:async(command,args)=>{calls.push({command,args});return {code:0,stdout:'{"pane":"p-new"}'};},
 });
 await api.createChat({pane:'alias/p-agent',tab:'alias/tb-owner',terminal:'alias/t14'});
 assert.equal(calls[0].command,'pane.split');
 assert.deepEqual(JSON.parse(JSON.stringify(calls[0].args.props)),{terminal:'t14',owner_tab:'tb-owner'});
 assert.deepEqual(Array.from(calls[1].args.slice(2)),['bind','alias/p-new','alias/tb-owner','alias/t14']);
});
test('opening an owned chat reuses it instead of creating a fourth pane',async()=>{
 const api=load({exec:async()=>({code:0,stdout:'"p-new"'}),
  qualifyAddress:(id,tab)=>tab.split('/')[0]+'/'+id,
  herdr:()=>assert.fail('should not create another pane'),
 });
 const result=await api.openChat({pane:'alias/p-agent',tab:'alias/tb-owner',terminal:'alias/t14'});
 assert.equal(result.pane,'alias/p-new');
});
test('owner helpers are identical in all three isolated mods',()=>{
 for(const name of ['chat-pane','chat-tabs'])assert.equal(source,readFileSync(new URL(`../mods/${name}/owner.js`,import.meta.url),'utf8'));
});
