import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';

const identitySource=readFileSync(new URL('../mods/chat/identity.js',import.meta.url),'utf8');
const {ownerPane,qualifyAddress,chatProps,machineOfTab}=await import('data:text/javascript;base64,'+Buffer.from(identitySource).toString('base64'));

const source = readFileSync(new URL('../mods/chat/backstage.js', import.meta.url), 'utf8');
const switching = source.slice(source.indexOf('export async function switchView'))
  .replace('export async function', 'async function');
function setup({chat = true, terminal = true, zoomed = 'chat', parked = false} = {}) {
  const calls = [];
  const term = {address:'remote/t1'};
  const list = [
    ...(chat ? [{pane:'chat', mod:'chat', tab:'remote/tab', zoomed:zoomed === 'chat'}] : []),
    ...(terminal && !parked ? [{pane:'tui', terminal:term.address, tab:'remote/tab', zoomed:zoomed === 'tui'}] : []),
    {pane:'other', terminal:'remote/t2', tab:'remote/tab', zoomed:false},
  ];
  const fn = runInNewContext(switching + '\nswitchView', {
    panes:()=>list, away:()=>parked,
    show:async(t)=>{calls.push(['restore',t.address]);list.push({pane:'tui',terminal:t.address,tab:'remote/tab',zoomed:false});},
    pause:async()=>{},
    herdr:async(command,args)=>{calls.push([command,args.pane]);},
  });
  return {calls,run:(mode)=>fn('chat',term,mode),list};
}
test('TUI selects the existing agent pane, without creating a split', async()=>{
  const s=setup(); await s.run('terminal');
  assert.deepEqual(s.calls,[['pane.zoom','tui'],['pane.focus','tui']]);
  assert.equal(s.list.length,3);
});
test('Chat selects the existing chat and preserves other split panes', async()=>{
  const s=setup({zoomed:'tui'});await s.run('chat');
  assert.deepEqual(s.calls,[['pane.zoom','chat'],['pane.focus','chat']]);
  assert.equal(s.list[2].terminal,'remote/t2');
});
test('selecting the already active view does not toggle zoom off',async()=>{
  const s=setup();await s.run('chat');
  assert.deepEqual(s.calls,[['pane.focus','chat']]);
});
test('old parked terminals are restored before the TUI is selected',async()=>{
  const s=setup({parked:true});await s.run('terminal');
  assert.deepEqual(s.calls,[['restore','remote/t1'],['pane.zoom','tui'],['pane.focus','tui']]);
});
test('missing chat fails without changing another pane',async()=>{
  const s=setup({chat:false});await assert.rejects(s.run('terminal'),/chat pane/);
  assert.deepEqual(s.calls,[]);
});
test('missing terminal fails without opening a replacement',async()=>{
  const s=setup({terminal:false});await assert.rejects(s.run('terminal'),/terminal is no longer/);
  assert.deepEqual(s.calls,[]);
});
test('both mods ship identical switching helpers',()=>{
  assert.equal(source,readFileSync(new URL('../mods/chat-pane/backstage.js',import.meta.url),'utf8'));
});

const headerSource=readFileSync(new URL('../mods/chat-pane/main.js',import.meta.url),'utf8')
  .replace(/^import[\s\S]*?;\n/gm,'').replace('export default class Pane','class Pane');
function headerSetup({linked=false,chat=true}={}) {
  const terminal={address:'remote/t1',report:{app:'codex'}};
  const tui={pane:'tui',terminal:terminal.address,tab:'remote/tab',app:'codex'};
  const conversation={pane:'chat',mod:'chat',tab:tui.tab};
  const calls=[];
  const Pane=runInNewContext(headerSource+'\nPane',{
    props:()=>({}),showTerminal:async(args)=>calls.push(["showTerminal",args]),
    View:class {},qualifyAddress,chatProps,machineOfTab,shared:()=>linked?{chat:terminal.address}:{},
    terminals:()=>[terminal],panes:()=>chat?[tui,conversation]:[tui],
    herdr:async(command,args)=>{calls.push([command,args]);return {pane:'new-chat'};},
    openConversation:async(args)=>{calls.push(['openConversation',args]);return {pane:'new-chat'};},
    bindOwner:async(...args)=>{calls.push(['bindOwner',...args]);},
    switchView:async(...args)=>{calls.push(['switchView',...args]);},
    notify:()=>assert.fail('unexpected switch error'),
  });
  return {view:new Pane(),tui,terminal,conversation,calls};
}
test('fresh terminal without a chat still gets the segmented header',()=>{
  const s=headerSetup({chat:false});const pair=s.view.chatPair(s.tui);
  assert.equal(pair.chat,null);assert.equal(pair.term,s.terminal);assert.equal(pair.terminalPane,'tui');
});
test('a same-tab chat without an explicit association is not guessed',()=>{
  const s=headerSetup();assert.equal(s.view.chatPair(s.tui).chat,null);
});
test('Chat selection opens a client-local presentation without pane commands',async()=>{
  const s=headerSetup({chat:false});let task;
  const cx={spawn(fn){task=fn(this);},notify(){}};
  s.view.selectView(s.view.chatPair(s.tui),'chat',cx);await task;
  assert.equal(s.calls[0][0],'openConversation');assert.equal(s.calls[0][1].terminal,'remote/t1');assert.equal(s.calls[0][1].tab,'remote/tab');
  assert.equal(s.calls.length,1); // no pane creation, focus or zoom command
});
test('selecting TUI on a fresh terminal does not create a chat',()=>{
  const s=headerSetup({chat:false});s.view.selectView(s.view.chatPair(s.tui),'terminal',{});
  assert.equal(s.calls.length,0);
});
