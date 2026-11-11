import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../mods/chat/source.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/\bexport /g,'');
const parent='01a1c446-db51-7d51-af2e-b707fafc06fc',fork='01a1c9f4-8f3b-7a80-a554-1c53b3b62231';
function setup(){const calls=[];const api=runInNewContext(source+'\n({locate})',{exec:async(command,args,options)=>{calls.push({command,args,options});return {code:0,stdout:command==='python3'?args[2]:'',stderr:''};}});return {api,calls};}
test('explicit resume session wins over an opposite branch label',async()=>{const s=setup();const result=await s.api.locate({address:'alias/t1',foreground:{pid:7,argv:['codex','resume',parent]},labels:{'chat.session.id':fork,'chat.session.pid':'7'}},'codex');assert.equal(result,parent);assert.equal(s.calls[0].options.on,'alias');});
test('fork terminal uses its own process-scoped session binding',async()=>{const s=setup();assert.equal(await s.api.locate({address:'t2',foreground:{pid:8,argv:['codex','resume']},labels:{'chat.session.id':fork,'chat.session.pid':'8'}},'codex'),fork);});
test('a restarted process cannot reuse the previous process session binding',async()=>{const s=setup();assert.equal(await s.api.locate({address:'t2',foreground:{pid:9,argv:['codex']},labels:{'chat.session.id':fork,'chat.session.pid':'8'}},'codex'),null);assert.equal(s.calls[0].command,'sh');});
