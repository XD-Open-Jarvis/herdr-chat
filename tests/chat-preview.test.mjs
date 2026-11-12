import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
const source=readFileSync(new URL('../mods/chat/preview.js',import.meta.url),'utf8');
const {fileLink,previewKey,previewPane,previewLayout}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
test('file links resolve relative to the owning terminal directory and retain line references',()=>{
 assert.deepEqual(fileLink('docs/plan.md#L12-L20','/repo'),{file:'/repo/docs/plan.md',line:12});
 assert.deepEqual(fileLink('/repo/a.ts:22:3','/other'),{file:'/repo/a.ts',line:22});
 assert.deepEqual(fileLink('file:///repo/a%20b.md','/other'),{file:'/repo/a b.md',line:null});
 assert.deepEqual(fileLink('C:\\repo\\a.ts:3','C:\\other'),{file:'C:\\repo\\a.ts',line:3});
 for(const link of ['https://example.com/file.md','mailto:x@example.com','file://other-host/a.md','#heading','bad%ZZ.md'])assert.equal(fileLink(link,'/repo'),null);
 assert.equal(fileLink('readme.md',null),null);
});
test('preview follows the owning pane in the active tab, never another machine with the same local IDs',()=>{
 const meta={presentation:true,owner_tab:'tab',owner_pane:'pane',terminal:'t1'};
 const tree={id:'conversation-view',active:'chat',children:[{id:'chat',children:[{content:{mod:'chat',props:meta}}]}]};
 const remote={tab:'connection-alias/tab',pane:'connection-alias/pane',terminal:'connection-alias/t1'};
 const other={tab:'other/tab',pane:'other/pane',terminal:'other/t1'};
 assert.equal(previewPane(tree,[other,remote],remote.tab,null),remote);
 assert.equal(previewPane(tree,[other],remote.tab,null),null);
 assert.notEqual(previewKey(remote),previewKey(other));
 assert.equal(previewPane(tree,[remote,{...remote}],remote.tab,null),null);
 const selected={tab:'selected-tab',pane:'selected-pane',terminal:'t2'};
 assert.equal(previewPane(tree,[remote,selected],selected.tab,selected.pane),selected);
});
test('adding the sidebar preview changes only the personal layout and preserves terminal structure',()=>{
 const tree={id:'root',children:[{id:'conversation-view',children:[{id:'main',content:{tab:'active'}}]},
 {id:'panel',hidden:true,size:{px:368},children:[{id:'panel-body',children:[{id:'files',content:{mod:'files'}},{id:'changes',content:{mod:'changes'}}]}]}]};
 const next=previewLayout(tree),panel=next.children[1];
 assert.equal(tree.children[1].hidden,true);assert.deepEqual(next.children[0],tree.children[0]);
 assert.equal(panel.hidden,false);assert.equal(panel.children[0].active,'chat-preview');
 assert.equal(panel.children[0].children.length,3);assert.equal(previewLayout(next).children[1].children[0].children.length,3);
 assert.throws(()=>previewLayout({id:'root'}),/no file sidebar/);
});
test('the isolated preview mod ships the same path and diff helpers as chat',()=>{
 assert.equal(readFileSync(new URL('../mods/chat-preview/preview.js',import.meta.url),'utf8'),source);
 assert.equal(readFileSync(new URL('../mods/chat-preview/diff.js',import.meta.url),'utf8'),readFileSync(new URL('../mods/chat/diff.js',import.meta.url),'utf8'));
});
