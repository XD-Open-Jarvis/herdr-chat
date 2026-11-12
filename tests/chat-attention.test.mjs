import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
const source=readFileSync(new URL('../mods/chat/attention.js',import.meta.url),'utf8');
const {ChatAttention}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const shown={visible:true,active:true,ready:true};
const terminal={address:'remote/t1',status:'done',turn:4,labels:{'herdr.seen':'3'}};
test('a foreground loaded Chat acknowledges its completed remote turn',async()=>{
 const tracker=new ChatAttention(),calls=[];await tracker.update(terminal,shown,(...args)=>calls.push(args));assert.deepEqual(calls,[['remote/t1',4]]);
});
test('hidden, background and unbound chats do not mark anything read',async()=>{
 for(const state of [{...shown,visible:false},{...shown,active:false},{...shown,ready:false}]){
  const tracker=new ChatAttention();let calls=0;await tracker.update(terminal,state,()=>calls++);assert.equal(calls,0);
 }
});
test('one write per turn preserves a different client mark unread until looking again',async()=>{
 const tracker=new ChatAttention();let calls=0;const write=()=>calls++;
 await tracker.update(terminal,shown,write);await tracker.update(terminal,shown,write);assert.equal(calls,1);
 tracker.update(terminal,{...shown,visible:false},write);
 await tracker.update(terminal,shown,write);assert.equal(calls,2);
 await tracker.update({...terminal,turn:5},shown,write);assert.equal(calls,3);
});
test('already seen, working and blocked states are never overwritten',async()=>{
 for(const t of [{...terminal,labels:{'herdr.seen':'4'}},{...terminal,labels:{'herdr.seen':'5'}},{...terminal,status:'working'},{...terminal,status:'blocked'}]){
  let calls=0;await new ChatAttention().update(t,shown,()=>calls++);assert.equal(calls,0);
 }
});
test('failed writes retry and missing read labels join the shared contract',async()=>{
 const tracker=new ChatAttention();let calls=0;const t={...terminal,labels:{}};
 await tracker.update(t,shown,()=>{calls++;throw new Error('offline')});await tracker.update(t,shown,()=>calls++);assert.equal(calls,2);
});
test('writes are serialized so an earlier turn cannot overwrite a later one',async()=>{
 const tracker=new ChatAttention(),calls=[];let finish;
 const pending=tracker.update(terminal,shown,turn=>{calls.push(turn);return new Promise(resolve=>finish=resolve)});
 await Promise.resolve();assert.equal(tracker.update({...terminal,turn:5},shown,()=>{}),null);
 finish();await pending;await tracker.update({...terminal,turn:5},shown,()=>calls.push('next'));assert.equal(calls.length,2);
});
test('raw idle with an unread turn is acknowledged even though only the sidebar says done',async()=>{
 const tracker=new ChatAttention(),calls=[];
 const raw={address:'t1g',status:'idle',turn:48,labels:{'herdr.seen':'47'}};
 await tracker.update(raw,shown,(address,turn)=>calls.push({address,turn}));
 assert.deepEqual(calls,[{address:'t1g',turn:48}]);
});
test('status idle may arrive before the incremented turn event',async()=>{
 const tracker=new ChatAttention(),calls=[];
 const write=(_address,turn)=>calls.push(turn);
 await tracker.update({...terminal,status:'idle',turn:4,labels:{'herdr.seen':'4'}},shown,write);
 await tracker.update({...terminal,status:'idle',turn:5,labels:{'herdr.seen':'4'}},shown,write);
 assert.deepEqual(calls,[5]);
});
test('core status objects are normalized without acknowledging working or error',async()=>{
 const calls=[];
 for(const state of ['working','blocked','error'])await new ChatAttention().update({...terminal,status:{state}},shown,()=>calls.push(state));
 assert.deepEqual(calls,[]);
 await new ChatAttention().update({...terminal,status:{state:'idle'}},shown,()=>calls.push('idle'));
 assert.deepEqual(calls,['idle']);
});
test('an idle but unread background conversation stays unread',async()=>{
 let calls=0;await new ChatAttention().update({...terminal,status:'idle'},{...shown,active:false},()=>calls++);assert.equal(calls,0);
});
