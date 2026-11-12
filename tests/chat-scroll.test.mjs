import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
const source=readFileSync(new URL('../mods/chat/main.js',import.meta.url),'utf8')
 .replace(/^import[\s\S]*?;\n/gm,'').replace('export default class Chat','class Chat');
function setup(off=200){
 const elements=new Map();
 function element(){
  const state={};let proxy;
  proxy=new Proxy(state,{get:(_target,key)=> (...args)=>{
   if(key==='id'){state.id=args[0];elements.set(args[0],state);}
   else if(key==='on_size_change')state.resize=args[0];
   else if(key==='top')state.top=args[0];
   else if(key==='when'){if(args[0])args[1](proxy);}
   return proxy;
  }});return proxy;
 }
 const Chat=runInNewContext(source+'\nChat',{View:class{},appWindow:()=>({platform:'macos'}),div:element,v_flex:element,h_flex:element,withPending:()=>[]});
 const view=Object.assign(Object.create(Chat.prototype),{off,contentH:1400,viewH:600,width:900,open:new Set(),t:{},pending:[],settle(){},shown:()=>({start:0,ents:[]}),streamShown:()=>null});
 let redraws=0;const cx={notify(){redraws++;}};
 return {view,elements,cx,redraws:()=>redraws};
}
test('expanding a card keeps the measured content top fixed across layout correction',()=>{
 const s=setup();s.view.body({});const top=s.elements.get('content').top;
 s.view.toggleCard('card',s.cx);s.view.body({});
 assert.equal(s.elements.get('content').top,top);
 s.elements.get('content').resize({height:1900},s.cx);s.view.body({});
 assert.equal(s.elements.get('content').top,top);assert.equal(s.view.off,700);
 s.view.toggleCard('card',s.cx);s.view.body({});
 s.elements.get('content').resize({height:1400},s.cx);s.view.body({});
 assert.equal(s.elements.get('content').top,top);assert.equal(s.view.off,200);
});
test('opening a card at the latest message preserves its top instead of following the new bottom',()=>{
 const s=setup(0);s.view.body({});const top=s.elements.get('content').top;
 s.view.toggleCard('card',s.cx);s.view.body({});
 s.elements.get('content').resize({height:1800},s.cx);s.view.body({});
 assert.equal(s.elements.get('content').top,top);assert.equal(s.view.off,400);
});
test('unchanged content and viewport dimensions do not schedule another redraw',()=>{
 const s=setup();s.view.body({});
 s.elements.get('content').resize({height:1400},s.cx);
 s.elements.get('scroll').resize({height:600,width:900},s.cx);
 assert.equal(s.redraws(),0);
});
