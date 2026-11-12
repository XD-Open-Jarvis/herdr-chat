import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
const load=async file=>import('data:text/javascript;base64,'+Buffer.from(readFileSync(new URL(file,import.meta.url),'utf8')).toString('base64'));
const {Outbox}=await load('../mods/chat/outbox.js');
const {menuAtBottom}=await load('../mods/chat/prompt.js');
const source=readFileSync(new URL('../mods/chat/main.js',import.meta.url),'utf8');
// Exercise the real controller methods with a fake terminal transport, never a user session.
const method=(name,next,bindings={})=>{
 const part=source.slice(source.indexOf(`  ${name}(`),source.indexOf(`\n  ${next}(`));
 return Function(...Object.keys(bindings),`return ({${part.trim()}})`)(...Object.values(bindings))[name];
};
const pump=method('pumpOutbox','outboxView');
const make=()=>{
 const tasks=[],calls=[];const context={scope:'t1:42:sid',status:'working',turn:1};
 const chat={outbox:new Outbox(),pending:[],term:'t1',queueContext:()=>context,
  saveOutbox(){},userCount:()=>0,deliver:async(...args)=>{calls.push(args);return true;}};
 const cx={notify(){},spawn(fn){tasks.push(()=>fn(cx));}};
 return {chat,context,cx,tasks,calls};
};
test('controller keeps busy follow-ups outside transcript until a turn is free',async()=>{
 const {chat,context,cx,tasks,calls}=make();
 const item=chat.outbox.enqueue({text:'later',paths:['/image.png'],attachments:[{path:'/image.png'}]},context.scope);
 pump.call(chat,cx);assert.equal(tasks.length,0);assert.equal(chat.pending.length,0);
 context.status='idle';pump.call(chat,cx);assert.equal(tasks.length,1);assert.equal(chat.pending.length,1);
 assert.equal(chat.pending[0].delivering,true);
 await tasks.shift()();assert.equal(calls[0][0],'later');assert.deepEqual(calls[0][1],['/image.png']);
 assert.equal(calls[0][3].idleOnly,true);assert.equal(chat.outbox.items.length,0);
 assert.equal(chat.pending[0].delivering,false);
 assert.equal(chat.pending[0].id,item.id);
});
test('controller Send now targets the selected item, and restores it on transport failure',async()=>{
 const {chat,context,cx,tasks}=make();
 const first=chat.outbox.enqueue({text:'first',paths:[],attachments:[]},context.scope);
 const second=chat.outbox.enqueue({text:'second',paths:[],attachments:[]},context.scope);
 chat.deliver=async(text,files,cx,options)=>{assert.equal(text,'second');assert.equal(options.steer,true);throw Error('offline');};
 pump.call(chat,cx,second.id);await tasks.shift()();
 assert.equal(chat.pending.length,0);assert.deepEqual(chat.outbox.items.map(x=>x.id),[first.id,second.id]);
 assert.equal(second.state,'error');assert.equal(second.error,'offline');
});
test('delivery guard invalidates a claimed item if the terminal or session changes',async()=>{
 const {chat,context,cx,tasks}=make();
 const item=chat.outbox.enqueue({text:'old',paths:[],attachments:[]},context.scope);
 chat.deliver=async(text,files,cx,options)=>{assert.equal(options.valid(),false);throw Error('changed session');};
 pump.call(chat,cx,item.id);context.scope='new-session';await tasks.shift()();
 assert.equal(item.state,'error');assert.equal(chat.pending.length,0);
});
const send=method('send','async deliver',{
 agentKind:()=> 'codex',codexTitleIdentity:()=>null,emojify:value=>value,
});
test('Enter while busy enqueues text and attachment snapshots without delivering or adding transcript bubbles',()=>{
 const {chat,context,cx,tasks}=make();let draft='follow-up';
 const attachment={path:'/a.png',name:'a.png',image:{ref:'a'}};
 Object.assign(chat,{sessionResolved:true,terminal:()=>({status:'working'}),
  slash:()=>null,mentionMenu:()=>null,emojiMenu:()=>null,panelLive:()=>false,typedCommand:()=>null,
  input:{value:()=>draft,set_value:value=>{draft=value;}},attach:[attachment],pumpOutbox:()=>pump.call(chat,cx)});
 send.call(chat,cx);
 assert.equal(tasks.length,0);assert.equal(chat.pending.length,0);assert.equal(draft,'');assert.equal(chat.attach.length,0);
 const queued=chat.outbox.items[0];assert.equal(queued.text,'follow-up');assert.deepEqual(queued.paths,['/a.png']);
 attachment.name='changed';assert.equal(queued.attachments[0].name,'a.png');
});
const deliverySource=source.slice(source.indexOf('  async deliver('),source.indexOf('\n  // Starts one terminal'));
const delivery=(hc,machineOf=()=>null,screen='')=>Function('hc','exec','agentKind','machineOf','shellEscape','menuAtBottom',`return ({${deliverySource.trim()}}).deliver`)(async args=>args[0]==='read'?{code:0,stdout:screen}:hc(args),async(command,args,options)=>{assert.equal(command,'hc');assert.equal(options.timeout,180000);return hc(args);},()=> 'codex',machineOf,value=>value,menuAtBottom);
test('automatic delivery uses an atomic idle guard; Send now uses the normal steering submission',async()=>{
 const calls=[],fn=delivery(async args=>{calls.push(args);return {code:0};});
 const chat={term:'mini/t1',terminal:()=>({status:'working'})};const cx={notify(){}};
 assert.equal(await fn.call(chat,'later',[],cx,{idleOnly:true,valid:()=>true}),true);
 assert.deepEqual(calls[0],['send','--if','idle','mini/t1','later']);
 await fn.call(chat,'now',[],cx,{steer:true,valid:()=>true});
 assert.deepEqual(calls[1],['send','mini/t1','now']);
});
test('a session change during attachment upload prevents sending into the new session',async()=>{
 let valid=true;const calls=[];
 const fn=delivery(async args=>{calls.push(args);valid=false;return {code:0,stdout:'/remote/a.png',stderr:''};},()=> 'mini');
 const chat={term:'mini/t1',terminal:()=>({status:'working'})};
 await assert.rejects(fn.call(chat,'old',['/local/a.png'],{notify(){}},{valid:()=>valid}),/conversation changed/);
 assert.deepEqual(calls,[['put','mini/t1','/local/a.png']]);
});
test('Enter while idle dispatches immediately and shows only an optimistic message, not a queue',async()=>{
 const {chat,context,cx,tasks,calls}=make();context.status='idle';let draft='send directly';
 Object.assign(chat,{sessionResolved:true,terminal:()=>({status:'idle'}),
  slash:()=>null,mentionMenu:()=>null,emojiMenu:()=>null,panelLive:()=>false,typedCommand:()=>null,
  input:{value:()=>draft,set_value:value=>{draft=value;}},attach:[],pumpOutbox:()=>pump.call(chat,cx)});
 send.call(chat,cx);
 assert.equal(tasks.length,1);assert.equal(chat.pending[0].text,'send directly');
 assert.equal(chat.outbox.visibleItems.length,0);assert.equal(draft,'');
 await tasks.shift()();assert.equal(calls[0][0],'send directly');assert.equal(chat.outbox.items.length,0);
});
test('an idle terminal menu pauses delivery instead of pressing Enter into its default choice',async()=>{
 const calls=[];const screen='Approaching rate limits\nSwitch to a cheaper model?\n\n› 1. Switch model\n  2. Keep model\n\nenter select · esc back';
 const fn=delivery(async args=>{calls.push(args);return {code:0};},()=>null,screen);
 const chat={term:'t1',terminal:()=>({status:'idle'})};
 await assert.rejects(fn.call(chat,'queued task',[],{notify(){}},{valid:()=>true,idleOnly:true}),error=>error.queuePaused===true);
 assert.deepEqual(calls,[]);assert.equal(chat.idleAsk,'menu');assert.equal(chat.screen,screen);
});
test('a prompt pause restores the selected message to queued without hiding it or marking it failed',async()=>{
 const {chat,context,cx,tasks}=make();context.status='idle';
 const item=chat.outbox.enqueue({text:'keep queued',paths:[],attachments:[]},context.scope);
 chat.deliver=async()=>{throw Object.assign(Error('choose first'),{queuePaused:true});};
 pump.call(chat,cx);await tasks.shift()();
 assert.equal(item.state,'queued');assert.equal(item.error,null);assert.equal(chat.pending.length,0);
 assert.deepEqual(chat.outbox.visibleItems,[item]);assert.equal(chat.outbox.gate,null);
});
test('a usage-limit error pauses automatic sends while retaining the queue and allows explicit retry',async()=>{
 const {chat,context,cx,tasks}=make();context.status='idle';chat.t={issue:{usage:true},entries:[],markInput(){}};
 const item=chat.outbox.enqueue({text:'wait',paths:[],attachments:[]},context.scope);
 pump.call(chat,cx);assert.equal(tasks.length,0);assert.equal(item.state,'queued');
 pump.call(chat,cx,item.id);assert.equal(tasks.length,1);await tasks.shift()();assert.equal(chat.outbox.items.length,0);
});
