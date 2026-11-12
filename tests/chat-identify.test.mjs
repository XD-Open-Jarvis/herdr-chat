import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
const source=readFileSync(new URL('../mods/chat/identify.js',import.meta.url),'utf8');
const {IdentifyFeedback,identifyKey}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
test('initial and still-running identification never requests user action',()=>{
 const ui=new IdentifyFeedback();ui.begin('a',0);
 assert.equal(ui.needsAction('a',10000),false);
 ui.finish(false);assert.equal(ui.needsAction('a',3999),false);
 assert.equal(ui.needsAction('a',4000),true);
});
test('background retries preserve the stable action screen and success clears it',()=>{
 const ui=new IdentifyFeedback();ui.begin('a',0);ui.finish(false);
 ui.begin('a',6000);assert.equal(ui.needsAction('a',6000),true);
 ui.finish(true);assert.equal(ui.needsAction('a',6001),false);
});
test('a fork or new process gets its own grace period and hides stale feedback immediately',()=>{
 const ui=new IdentifyFeedback();ui.begin('a',0);ui.finish(false);
 assert.equal(ui.needsAction('b',10000),false);
 ui.begin('b',10000);ui.finish(false);
 assert.equal(ui.needsAction('b',13999),false);
 assert.equal(ui.needsAction('b',14000),true);
 const term={address:'mini/t1',foreground:{pid:42}};
 assert.notEqual(identifyKey(term,{prefix:'a'}),identifyKey(term,{prefix:'b'}));
 assert.notEqual(identifyKey(term,null),identifyKey({...term,foreground:{pid:43}},null));
});
