import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../mods/chat/main.js',import.meta.url),'utf8')
  .replace(/^import[\s\S]*?;\n/gm,'').replace('export default class Chat','class Chat');
function setup({active='work',zoomed='chat',dialog=false}={}) {
  const calls=[];
  const mine={pane:'chat',mod:'chat',tab:'work',zoomed:zoomed==='chat'};
  const all=[mine,{pane:'tui',terminal:'t1',tab:'work',zoomed:zoomed==='tui'}];
  const element={id(){return this;},size_full(){return this;}};
  const Chat=runInNewContext(source+'\nChat',{
    View:class {},appWindow:()=>({platform:'macos'}),
    spaces:()=>[{active:true,tabs:[{id:active,active:true}]}],panes:()=>all,
    shared:()=>({'chat':'t1'}),setShared:()=>{throw Error('unexpected shared write');},
    theme:()=>{calls.push('theme');throw Error('hidden render built UI');},div:()=>element,
    terminals:()=>[{address:'t1',status:'working'}],
    hc:()=>{calls.push('screen read');throw Error('hidden chat read screen');},
    away:()=>false,agentKind:()=>{calls.push('agent detection');},
  });
  const view=Object.create(Chat.prototype);
  Object.assign(view,{dialog,term:'t1',myPane:()=>mine,stream:'old',running:{},catalogs:{}});
  return {view,calls,element};
}
test('a zoomed TUI hides its chat',()=>assert.equal(setup({zoomed:'tui'}).view.chatVisible(),false));
test('the zoomed chat and a visible split remain active',()=>{
  assert.equal(setup().view.chatVisible(),true);
  assert.equal(setup({zoomed:null}).view.chatVisible(),true);
});
test('another tab suspends the chat but the new-chat dialog remains active',()=>{
  assert.equal(setup({active:'other'}).view.chatVisible(),false);
  assert.equal(setup({active:'other',dialog:true}).view.chatVisible(),true);
});
test('hidden chat renders only an empty placeholder',()=>{
  const s=setup({zoomed:'tui'});assert.equal(s.view.render(),s.element);assert.deepEqual(s.calls,[]);
});
test('hidden chat check skips detection, polling and catalog work',()=>{
  const s=setup({zoomed:'tui'});s.view.check({});assert.deepEqual(s.calls,[]);
});
test('terminal-follow loop exits without screen reads or redraws in TUI mode',async()=>{
  const s=setup({zoomed:'tui'});let task;let redraws=0;
  const cx={spawn(fn){task=fn(this);},notify(){redraws++;}};
  s.view.follow('codex',cx);await task;
  assert.deepEqual(s.calls,[]);assert.equal(redraws,0);assert.equal(s.view.streamLoop,null);
});
