import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
const source=readFileSync(new URL('../mods/chat/timeline.js',import.meta.url),'utf8');
const {withPending}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
test('a pending user precedes new logged responses and tools',()=>{
 const old={key:'old',kind:'assistant'},tools={key:'tools',kind:'tools'},reply={key:'reply',kind:'assistant'};
 const pending={afterKey:'old',text:'new request'};
 const result=withPending([old,tools,reply],[pending]);
 assert.deepEqual(result.map(item=>item.kind),['assistant','pending','tools','assistant']);assert.equal(result[1].message,pending);
});
test('first user message precedes output even before a log exists',()=>{
 assert.deepEqual(withPending([{key:'reply',kind:'assistant'}],[{afterKey:null}]).map(item=>item.kind),['pending','assistant']);
});
test('multiple sends preserve their send order at the same anchor',()=>{
 const result=withPending([{key:'old'},{key:'new'}],[{afterKey:'old',text:'first'},{afterKey:'old',text:'second'}]);
 assert.deepEqual(result.filter(item=>item.kind==='pending').map(item=>item.message.text),['first','second']);
});
test('acknowledged pending message is replaced without a duplicate placeholder',()=>{
 const entries=[{key:'old'},{key:'user',kind:'user'},{key:'reply',kind:'assistant'}];
 assert.deepEqual(withPending(entries,[]),entries);
});
test('a hidden history anchor still puts the pending user before new visible output',()=>{
 assert.equal(withPending([{key:'reply'}],[{afterKey:'hidden'}])[0].kind,'pending');
});
