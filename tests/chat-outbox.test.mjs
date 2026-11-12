import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
const source=readFileSync(new URL('../mods/chat/outbox.js',import.meta.url),'utf8');
const {Outbox,outboxScope}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const busy={scope:'terminal:pid:session',status:'working',turn:3};
const idle={...busy,status:'idle'};
const add=(q,text)=>q.enqueue({text,paths:[],attachments:[]},busy.scope);
test('normal sends queue while working, then dispatch FIFO one turn at a time',()=>{
 const q=new Outbox();const first=add(q,'first'),second=add(q,'second');
 assert.equal(q.claim(busy),null);assert.deepEqual(q.items.map(x=>x.text),['first','second']);
 assert.equal(q.claim(idle),first);assert.equal(q.claim(idle),null);
 q.finish(first.id);assert.equal(q.claim(idle),null); // stale idle must not drain the queue
 q.observe(busy);assert.equal(q.claim(idle),second);
});
test('Send now selects exactly one later message while the rest stay queued',()=>{
 const q=new Outbox();const first=add(q,'first'),second=add(q,'second'),third=add(q,'third');
 assert.equal(q.claim(busy,second.id),second);assert.equal(q.claim(busy,third.id),null);
 q.finish(second.id);assert.deepEqual(q.items,[first,third]);assert.equal(q.claim(busy),null);
});
test('turn counter releases the queue even when a short busy phase was missed',()=>{
 const q=new Outbox();const first=add(q,'first'),second=add(q,'second');
 q.claim(idle);q.finish(first.id);assert.equal(q.claim({...idle,turn:4}),second);
});
test('blocked prompts, finished terminals and changed sessions never receive queued messages',()=>{
 for(const context of [{...busy,status:'blocked'},{...busy,status:null},{...idle,scope:'other'}, {...idle,scope:null}]){
  const q=new Outbox();const item=add(q,'stay');
  assert.equal(q.claim(context),null);assert.equal(q.claim(context,item.id),null);assert.equal(q.items.length,1);
 }
 assert.equal(outboxScope({state:'finished',address:'t1',foreground:{pid:1}},'sid'),null);
 assert.notEqual(outboxScope({state:'live',address:'t1',foreground:{pid:1}},'a'),outboxScope({state:'live',address:'t1',foreground:{pid:1}},'b'));
});
test('delivery failure retains text and attachments without repeated automatic attempts',()=>{
 const q=new Outbox();const file={path:'/a.png',image:{ref:'a'}};
 const item=q.enqueue({text:'with image',paths:['/a.png'],attachments:[file]},busy.scope);
 q.claim(idle);q.finish(item.id,'offline');assert.equal(q.claim(idle),null);
 assert.deepEqual(q.items[0].attachments,[file]);assert.equal(q.claim(idle,item.id),item);
});
test('reload preserves ordering and never automatically replays an uncertain delivery',()=>{
 const q=new Outbox();const first=add(q,'first');add(q,'second');q.claim(idle);
 const restored=new Outbox(JSON.parse(JSON.stringify(q)));
 assert.deepEqual(restored.items.map(x=>x.text),['first','second']);assert.equal(restored.items[0].state,'error');
 assert.equal(restored.claim({...idle,turn:9}),null);
 restored.remove(first.id);assert.equal(restored.items[0].text,'second');
});
test('an old session gate does not block a new session queue',()=>{
 const q=new Outbox();const first=add(q,'first');q.claim(idle);q.finish(first.id);
 const next=q.enqueue({text:'new',paths:[],attachments:[]},'other');
 assert.equal(q.claim({...idle,scope:'other'}),next);
});
test('persisted scope uses the machine-local terminal ID across connection alias changes',()=>{
 const term={state:'live',address:'mini/t1',foreground:{pid:42}};
 assert.equal(outboxScope(term,'sid'),outboxScope({...term,address:'different-alias/t1'},'sid'));
});
