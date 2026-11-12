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
