import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';

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
