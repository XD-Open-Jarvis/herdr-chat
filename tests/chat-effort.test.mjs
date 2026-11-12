import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
const source=readFileSync(new URL('../mods/chat/main.js',import.meta.url),'utf8')
 .replace(/^import[\s\S]*?;\n/gm,'').replace('export default class Chat','class Chat');
function setup(kind='claude',model='grok/grok-4.7',efforts=[]) {
 const texts=[];
 const element=()=>new Proxy({}, {get(_target,key){
  if(key==='when') return (condition,fn)=>{const el=element();return condition ? fn(el) : el;};
  if(key==='child') return value=>{if(typeof value==='string')texts.push(value);return element();};
  if(key==='children') return ()=>element();
  if(key==='on_click') return ()=>element();
  return ()=>element();
 }});
 const Chat=runInNewContext(source+'\nChat',{View:class {},appWindow:()=>({platform:'macos'}),
  div:element,h_flex:element,v_flex:element,svg:element,modelName:(_models,id)=>id,
  CLAUDE_EFFORTS:["low","medium","high","xhigh","max"],
  machineOf:()=>null, sleep:()=>{}, switchModel:async(...args)=>{view.switched=args;},
  Popover:{new:element}});
 const view=Object.create(Chat.prototype);
 view.current=()=>({kind,model,effort:'medium',cat:{models:[{id:'claude-opus',name:'Opus',efforts}]}});
 return {view,texts};
}
test('custom Claude Code provider models retain an effort entry without an exact catalog match',()=>{
 const {view,texts}=setup();view.modelMenu({status:'idle'},{});
 assert.ok(texts.includes('Effort'));
 for(const level of ['low','medium','high','xhigh','max'])assert.ok(texts.includes(level));
 assert.equal(texts.includes('Adjust effort…'),false);
});
test('known model effort options remain and Codex never receives the Claude fallback',()=>{
 for(const [kind,model,efforts] of [['claude','claude-opus',['low','high']],['codex','custom',[]]]){
  const {view,texts}=setup(kind,model,efforts);view.modelMenu({status:'idle'},{});
  assert.equal(texts.includes('Adjust effort…'),false);
 }
});
test('effort-only selection keeps a custom provider model and updates the selected effort',async()=>{
 const {view}=setup();const tasks=[];const cx={notify(){},spawn(fn){tasks.push(()=>fn(cx));}};
 view.t={kind:'claude',model:'grok/grok-4.7'};Object.defineProperty(view,'term',{value:'t1'});
 view.applyModel(null,'high',cx);await tasks[0]();
 assert.deepEqual(Array.from(view.switched.slice(0,4)),['t1','claude',null,'high']);
 assert.equal(view.chosen.model,'grok/grok-4.7');assert.equal(view.chosen.effort,'high');
});
test('switching keeps the model and effort labels visible instead of replacing them with Switching',()=>{
 const {view,texts}=setup();view.switching=true;view.modelMenu({status:'idle'},{});
 assert.ok(texts.includes('grok/grok-4.7'));assert.ok(texts.includes('medium'));assert.equal(texts.includes('Switching…'),false);
});
test('failed settings delivery keeps the previous selection and exposes the error',async()=>{
 const {view}=setup();const tasks=[];const cx={notify(){},spawn(fn){tasks.push(()=>fn(cx));}};
 view.t={kind:'claude',model:'grok/grok-4.7'};Object.defineProperty(view,'term',{value:'t1'});
 view.switched=null;
 // The controller must preserve its chosen value when the transport rejects.
 const method=source.slice(source.indexOf('  applyModel('),source.indexOf('  // The running session\'s model and effort'));
 const apply=Function('agentKind','machineOf','sleep','switchModel',`return ({${method.trim()}}).applyModel`)(()=> 'claude',()=>null,()=>{},async()=>{throw Error('not delivered');});
 const previous={model:'grok/grok-4.7',effort:'medium'};view.chosen=previous;
 apply.call(view,null,'high',cx);await tasks[0]();assert.equal(view.chosen,previous);assert.equal(view.error,'not delivered');assert.equal(view.switching,false);
});
test('Claude and Codex transport failures reject model switching instead of reporting success',async()=>{
 const models=readFileSync(new URL('../mods/chat/models.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'');
 for(const kind of ['claude','codex']){
  const calls=[];
  const switchModel=runInNewContext(models+'\nswitchModel',{
   hc:async args=>{calls.push(args);return {code:1,stderr:'terminal unavailable'};},
   exec:async()=>({code:0}),CODEX_TITLE_CONFIG:''});
  await assert.rejects(switchModel('t1',kind,'custom','high',null,async()=>{}),/terminal unavailable/);
  assert.equal(calls.length,1);
 }
});
