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
test('idle sends start immediately without appearing as queued follow-ups',()=>{
 for(const status of ['idle','done']){
  const q=new Outbox();const context={...idle,status};
  assert.equal(q.canSendDirect(context),true);
  const item=q.enqueue({text:'now',paths:[],attachments:[],direct:true},context.scope);
  assert.equal(q.claim(context),item);assert.equal(q.visibleItems.length,0);
  assert.equal(q.canSendDirect(context),false);
  q.finish(item.id);assert.equal(q.visibleItems.length,0);
 }
});
test('busy sends and existing same-session queues retain FIFO instead of bypassing the queue',()=>{
 const q=new Outbox();assert.equal(q.canSendDirect(busy),false);
 const first=add(q,'first');assert.equal(q.canSendDirect(idle),false);
 assert.deepEqual(q.visibleItems,[first]);
});
test('failed or uncertain direct deliveries become visible for recovery',()=>{
 const q=new Outbox();const item=q.enqueue({text:'retain me',paths:[],attachments:[],direct:true},idle.scope);
 q.claim(idle);assert.equal(q.visibleItems.length,0);
 const restored=new Outbox(JSON.parse(JSON.stringify(q)));
 assert.equal(restored.visibleItems.length,0);assert.equal(restored.failedItems[0].text,'retain me');assert.equal(restored.failedItems[0].state,'error');
 q.finish(item.id,'offline');assert.equal(q.visibleItems.length,0);assert.equal(q.failedItems[0],item);assert.equal(item.error,'offline');
});
test('an error phase does not auto-send but permits an explicit retry after the user chooses recovery',()=>{
 const q=new Outbox();const item=add(q,'retry');const context={...idle,status:'error'};
 assert.equal(q.claim(context),null);assert.equal(q.claim(context,item.id),item);
});
test('a failed idle send is separate from the queue and never blocks a later idle send',()=>{
 const q=new Outbox();const failed=q.enqueue({text:'old',paths:[],attachments:[],direct:true},idle.scope);
 q.claim(idle);q.finish(failed.id,'read timed out');
 assert.equal(q.visibleItems.length,0);assert.equal(q.failedItems.length,1);assert.equal(q.canSendDirect(idle),true);
 const next=q.enqueue({text:'new',paths:[],attachments:[],direct:true},idle.scope);
 assert.equal(q.claim(idle),next);assert.equal(q.visibleItems.length,0);assert.equal(q.failedItems[0],failed);
});
test('an idle send interrupted by a terminal menu stays recoverable without appearing as a working queue',()=>{
 const q=new Outbox();const item=q.enqueue({text:'draft',paths:[],attachments:[],direct:true},idle.scope);
 q.claim(idle);q.finish(item.id,'Waiting for your selection',true);
 assert.equal(q.visibleItems.length,0);assert.equal(q.failedItems[0].text,'draft');
});
test('explicit retry follows the same terminal session after a process restart, but auto delivery does not',()=>{
 const q=new Outbox();const old={scope:'t1:42:session-a',status:'idle'};
 const item=q.enqueue({text:'retry',paths:[],attachments:[],direct:true},old.scope);
 q.claim(old);q.finish(item.id,'offline');
 const resumed={...old,scope:'t1:99:session-a'};
 assert.equal(q.claim(resumed),null);
 assert.equal(q.retryReason(resumed,item.id),null);
 assert.equal(q.claim(resumed,item.id),item);
 assert.equal(item.scope,resumed.scope);
});
test('explicit retry rejects a different terminal or session and explains blocked delivery',()=>{
 const q=new Outbox();const item=add(q,'retry');
 assert.match(q.retryReason({...idle,scope:'different:pid:session'},item.id),/original session/);
 assert.match(q.retryReason({...idle,scope:'terminal:pid:other'},item.id),/original session/);
 assert.equal(q.claim({...idle,scope:'terminal:pid:other'},item.id),null);
 assert.match(q.retryReason({...idle,status:'blocked'},item.id),/terminal prompt/);
 assert.match(q.retryReason({...idle,scope:null},item.id),/Identify/);
});
