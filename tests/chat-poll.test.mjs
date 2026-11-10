import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
const source=readFileSync(new URL('../mods/chat/poll.js',import.meta.url),'utf8');
const {folderPoll}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
function setup(){
 let watchCount=0,resolveWatch,rejectWatch;
 const timers=new Set();
 const timer={after(ms,resolve){const t={ms,resolve,cancel(){timers.delete(t);}};timers.add(t);return t;}};
 const wait=folderPoll(()=>{watchCount++;return new Promise((resolve,reject)=>{resolveWatch=resolve;rejectWatch=reject;});},timer,'/logs');
 return {wait,timers,get watches(){return watchCount;},change:()=>resolveWatch(),fail:()=>rejectWatch(Error('unavailable')),
 tick(ms=15000){for(const t of [...timers])if(t.ms===ms){timers.delete(t);t.resolve();}}};
}
test('10000 quiet polling intervals keep one pending folder watch and no abandoned timers',async()=>{
 const s=setup();for(let i=0;i<10000;i++){const p=s.wait();s.tick();await p;}
 assert.equal(s.watches,1);assert.equal(s.timers.size,0);
});
test('file changes cancel fallback timers and only then allow a replacement watch',async()=>{
 const s=setup();for(let i=0;i<1000;i++){
  const p=s.wait();s.change();await p;assert.equal(s.timers.size,0);
 }assert.equal(s.watches,1000);
});
test('watch failure backs off before allowing another watch',async()=>{
 const s=setup();const p=s.wait();s.fail();await Promise.resolve();
 assert([...s.timers].some(t=>t.ms===3000));s.tick(3000);await p;
 assert.equal(s.timers.size,0);const next=s.wait();assert.equal(s.watches,2);s.tick();await next;
});
