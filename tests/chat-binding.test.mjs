import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
const source=readFileSync(new URL('../mods/chat/binding.js',import.meta.url),'utf8');
const {bindingKey,chooseBinding}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const bound={file:'/sessions/current.jsonl',process:'42:Thu Nov 12 10:00:00 2026',evidence:'status'};
test('missing screen anchors do not revoke an established process binding',()=>{
 for(const evidence of ['ambiguous','too-many-candidates'])assert.equal(chooseBinding(bound,{file:null,evidence},bound.process),bound);
});
test('persisted binding survives a mod reload when process start identity matches',()=>{
 const saved=JSON.parse(JSON.stringify(bound));assert.deepEqual(chooseBinding(saved,{file:null,evidence:'ambiguous'},bound.process),bound);
});
test('same PID with a different start time cannot reuse a binding',()=>{
 assert.equal(chooseBinding(bound,{file:null,evidence:'ambiguous'},'42:Fri Nov 13 10:00:00 2026'),null);
});
test('an explicit new status without an available log invalidates the old binding',()=>{
 assert.equal(chooseBinding(bound,{file:null,evidence:'status'},bound.process),null);
});
test('verified new session evidence replaces the binding within the same process',()=>{
 const next=chooseBinding(bound,{file:'/sessions/fork.jsonl',evidence:'text'},bound.process);
 assert.equal(next.file,'/sessions/fork.jsonl');assert.equal(next.process,bound.process);
});
test('no binding is invented from an ambiguous initial screen',()=>{
 assert.equal(chooseBinding(null,{file:null,evidence:'ambiguous'},bound.process),null);
});
test('binding owner keys survive connection alias changes and isolate panes',()=>{
 const first=bindingKey({owner_tab:'mini/tab',owner_pane:'mini/pane'},'mini/t1');
 assert.equal(first,bindingKey({owner_tab:'new/tab',owner_pane:'new/pane'},'new/t1'));
 assert.notEqual(first,bindingKey({owner_tab:'mini/tab',owner_pane:'mini/other'},'mini/t1'));
 assert.equal(bindingKey({},'t1'),null);
});
test('a new title whose log is not yet available revokes the old binding',()=>{
 assert.equal(chooseBinding(bound,{file:null,evidence:'title'},bound.process),null);
});
