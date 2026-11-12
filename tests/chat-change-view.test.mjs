import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
const load=async path=>import('data:text/javascript;base64,'+Buffer.from(readFileSync(new URL(path,import.meta.url),'utf8')).toString('base64'));
const {collectionPosition}=await load('../mods/chat-preview/collection.js');
const {sidebarVisible,hoverGeometry}=await load('../mods/chat/hover-diff.js');
const files=[{path:'one.js',diff:'-a\n+b'},{path:'two.js',diff:'+c'},{path:'three.js',diff:'+d'}];
test('the current filename remains pinned until the next file header pushes it out',()=>{
 assert.equal(collectionPosition(files,[300,400,500],0,200).index,0);
 const pushing=collectionPosition(files,[300,400,500],280,200);
 assert.equal(pushing.index,0);assert.equal(pushing.headerTop,-24);
 const next=collectionPosition(files,[300,400,500],300,200);
 assert.equal(next.index,1);assert.equal(next.headerTop,0);
 const third=collectionPosition(files,[300,400,500],700,200);
 assert.equal(third.index,2);assert.equal(third.headerTop,0);
});
test('diff scrolling clamps at both ends and accounts for measured section heights',()=>{
 assert.equal(collectionPosition(files,[300,400,500],-30,200).offset,0);
 assert.equal(collectionPosition(files,[300,400,500],9000,200).offset,1000);
 assert.equal(collectionPosition(files,[300,400,500],200,2000).offset,0);
 const estimated=collectionPosition(files,[],0,200);assert(estimated.total>0);
 assert.equal(collectionPosition(files,[300,400,500],0,200).total,1200);
});
test('hover diff pins below upper rows, above lower rows and stays narrower than the card',()=>{
 const viewport={y:100,height:700};
 const upper=hoverGeometry({y:180,height:30},viewport,700);
 assert.equal(upper.anchor,'top_left');assert.equal(upper.width,676);
 const lower=hoverGeometry({y:700,height:30},viewport,700);
 assert.equal(lower.anchor,'bottom_left');assert.equal(lower.width,676);assert(lower.height<=360);
});
test('a visible right sidebar suppresses hover previews regardless of its selected page',()=>{
 assert.equal(sidebarVisible({id:'root',children:[{id:'panel',hidden:true}]}),false);
 assert.equal(sidebarVisible({id:'root',children:[{id:'panel',hidden:false}]}),true);
 assert.equal(sidebarVisible({id:'root'}),false);
});
