import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
const source=readFileSync(new URL('../mods/chat/main.js',import.meta.url),'utf8').replace(/^import[\s\S]*?;\n/gm,'').replace('export default class Chat','class Chat');
function setup(){
 const builder=()=>{const ops=[];const b={move_to(...args){ops.push(['move',...args]);return b;},arc_to(...args){ops.push(['arc',...args]);return b;},build(){return {ops};}};return b;};
 function element(){const el={children:[],size(n){el.dimension=n;return el;},child(child){el.children.push(child);return el;},when(ok,fn){if(ok)fn(el);return el;}};
 for(const name of ['relative','flex_none','absolute','left','top'])el[name]=()=>el;return el;}
 return runInNewContext(source+'\n({ringArcPath,ringIcon})',{View:class{},appWindow:()=>({platform:'macos'}),PathBuilder:{stroke:builder},div:element,window:{paint_path:()=>element()}});
}
test('used quota opens a clockwise gap from twelve while the remaining arc ends at twelve',()=>{
 const {ringArcPath}=setup();const center=6.5,radius=4.775;
 for(const [pct,x,y] of [[75,center+radius,center],[50,center,center+radius],[25,center-radius,center]]){
  const path=ringArcPath(pct),start=path.ops[0],arc=path.ops[1];
  assert(Math.abs(start[1]-x)<0.001);assert(Math.abs(start[2]-y)<0.001);
  assert.equal(arc[5],true);assert.equal(arc[6],center);assert(Math.abs(arc[7]-(center-radius))<0.001);
 }
 assert.equal(ringArcPath(0),null);assert.equal(ringArcPath(100).ops.length,3);
});
test('every ring and both paint layers have the same explicit size regardless of percentage',()=>{
 const {ringIcon}=setup();
 for(const pct of [0,1,25,75,100]){
  const ring=ringIcon(pct,'#aaa','#555');assert.equal(ring.dimension,13);
  assert.equal(ring.children.length,pct?2:1);
  for(const layer of ring.children)assert.equal(layer.dimension,13);
 }
});
