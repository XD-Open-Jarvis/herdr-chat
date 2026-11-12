import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
const source=readFileSync(new URL('../mods/chat-file/main.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/export default class ChatFile/,'class ChatFile').replace(/export /g,'');
const p={imageWidth:1000,imageHeight:500};
const {imageFit,imageBounds,ChatFile}=runInNewContext(source+'\n({imageFit,imageBounds,ChatFile})',{View:class {},props:()=>p});
test('initial fit preserves aspect ratio and does not upscale small originals',()=>{
 assert.equal(imageFit({width:524,height:324},1000,500),.5);
 assert.equal(imageFit({width:900,height:680},100,50),1);
});
test('small images stay centered and large image panning stays within bounds',()=>{
 const v={width:524,height:324};
 const small=imageBounds(v,100,50,1,{x:300,y:-100});assert.equal(small.x,0);assert.equal(small.y,0);assert.equal(small.left,212);
 const large=imageBounds(v,1000,500,2,{x:1e5,y:-1e5});assert.equal(large.left,12);assert.equal(large.top,v.height-12-large.height);
});
function view(){const v=Object.create(ChatFile.prototype);v.viewport={width:524,height:324};v.imageScale=null;v.imageOffset={x:0,y:0};return v;}
test('zoom keeps the image point beneath the cursor stationary',()=>{
 const v=view();v.zoomImage(1,{notify(){}},{x:362,y:162});
 assert.equal(v.imageScale,1);assert.equal(v.imageOffset.x,-100);assert.equal(v.imageOffset.y,0);
});
test('zoom respects limits and actual size remains available',()=>{
 const v=view();v.zoomImage(100,{notify(){}});assert.equal(v.imageScale,8);
 v.zoomImage(.001,{notify(){}});assert.equal(v.imageScale,.1);
 v.zoomImage(1,{notify(){}});assert.equal(v.imageScale,1);
});
