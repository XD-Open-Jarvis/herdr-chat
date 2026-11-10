import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
const identity=readFileSync(new URL('../mods/chat/identity.js',import.meta.url),'utf8');
const {ownerPane,qualifyAddress,chatProps}=await import('data:text/javascript;base64,'+Buffer.from(identity).toString('base64'));
const source=readFileSync(new URL('../mods/chat/main.js',import.meta.url),'utf8')
 .replace(/^import[\s\S]*?;\n/gm,'').replace('export default class Chat','class Chat');
function chat(meta, all, live, active) {
 const Chat=runInNewContext(source+'\nChat',{
  View:class {},appWindow:()=>({platform:'macos'}),ownerPane,qualifyAddress,chatProps,
  panes:()=>all,terminals:()=>live,spaces:()=>[{active:true,tabs:[{id:active,active:true}]}],
 });
 const view=Object.create(Chat.prototype);
 view.owner=meta;view.terminalId=meta.terminal.split('/').pop();view.dialog=false;
 return view;
}
const panes=[{pane:'p-local',mod:'chat',tab:'tb-local'},
 {pane:'new-alias/p-remote',mod:'chat',tab:'new-alias/tb-remote'}];
const live=[{address:'t8',labels:{'herdr.tab':'tb-local'}},
 {address:'new-alias/t8',labels:{'herdr.tab':'tb-remote'}}];
test('new props persist only local terminal and owner tab IDs',()=>{
 assert.deepEqual(chatProps('mini/t8','mini/tb-remote'),{terminal:'t8',owner_tab:'tb-remote'});
});
test('remote owner selects its t8 even while a local t8 is active',()=>{
 const v=chat({terminal:'t8',owner_tab:'tb-remote',owner_pane:'p-remote'},panes,live,'tb-local');
 assert.equal(v.myPane(),panes[1]);assert.equal(v.term,'new-alias/t8');assert.equal(v.terminal(),live[1]);
 assert.equal(v.chatVisible(),false);
});
test('the remote chat is visible when its own tab is shown',()=>{
 const v=chat({terminal:'t8',owner_tab:'tb-remote'},panes,live,'new-alias/tb-remote');
 assert.equal(v.chatVisible(),true);
});
test('old full addresses are requalified using the pane, not their saved alias',()=>{
 const v=chat({terminal:'old-alias/t8',owner_tab:'tb-remote'},panes,live,'tb-local');
 assert.equal(v.term,'new-alias/t8');
});
test('a locally owned chat strips an obsolete remote prefix',()=>{
 const v=chat({terminal:'old-alias/t8',owner_tab:'tb-local'},panes,live,'new-alias/tb-remote');
 assert.equal(v.term,'t8');assert.equal(v.terminal(),live[0]);
});
test('missing remote terminal never falls back to local t8',()=>{
 const v=chat({terminal:'t8',owner_tab:'tb-remote'},panes,[live[0]],'tb-local');
 assert.equal(v.terminal(),null);
});
test('missing or ambiguous owner metadata never selects a terminal',()=>{
 const v=chat({terminal:'t8'},panes,live,'tb-local');assert.equal(v.term,null);assert.equal(v.terminal(),null);
 const duplicate=[panes[1],{pane:'other/p-remote',mod:'chat',tab:'other/tb-remote'}];
 assert.equal(ownerPane({owner_tab:'tb-remote',owner_pane:'p-remote'},duplicate),null);
});
test('an explicit owner pane disambiguates multiple chat panes in the same tab',()=>{
 const all=[panes[1],{pane:'new-alias/p-second',mod:'chat',tab:'new-alias/tb-remote'}];
 assert.equal(ownerPane({owner_tab:'tb-remote',owner_pane:'p-second'},all),all[1]);
 assert.equal(ownerPane({owner_tab:'tb-remote'},all),null);
});
test('all three mods use identical machine-local identity helpers',()=>{
 for(const name of ['chat-tabs','chat-pane'])assert.equal(identity,readFileSync(new URL(`../mods/${name}/identity.js`,import.meta.url),'utf8'));
});
