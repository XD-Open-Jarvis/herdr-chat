import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
const source=readFileSync(new URL('../mods/chat/main.js',import.meta.url),'utf8')
 .replace(/^import[\s\S]*?;\n/gm,'').replace('export default class Chat','class Chat');
const script=runInNewContext(source+'\nNEW_SPACE',{View:class {},appWindow:()=>({platform:'macos'})});
test('new remote chat starts one terminal and selects local presentation without creating a Chat pane',()=>{
 const dir=mkdtempSync(join(tmpdir(),'chat-create-test-'));
 try {
  const log=join(dir,'calls.jsonl');
  writeFileSync(join(dir,'herdr-app'),`#!/usr/bin/env node
const fs=require('node:fs');const [,,verb,command,arg]=process.argv;
if(verb==='ls'){console.log(JSON.stringify({spaces:[{tabs:[{id:'alias/tb-owner',terminals:[{pane:'alias/p-agent',terminal:'alias/t8'}]}]}]}));process.exit(0);}
const args=JSON.parse(arg);fs.appendFileSync(process.env.CHAT_TEST_LOG,JSON.stringify({command,args})+'\\n');
if(command==='space.new')console.log(JSON.stringify({terminal:'alias/t8',tab:'alias/tb-owner'}));
else console.log(JSON.stringify({ok:true}));
`,{mode:0o755});
  const tree=JSON.parse(readFileSync(new URL('../layouts/chat.json',import.meta.url)));
  execFileSync('python3',['-c',script,'{}',JSON.stringify(tree),JSON.stringify({started:true})],
   {env:{...process.env,PATH:dir+':'+process.env.PATH,CHAT_TEST_LOG:log}});
  const calls=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(c=>c.command),['space.new','layout.set','chat.focus']);
  const find=(n,id)=>n.id===id?n:(n.children||[]).map(c=>find(c,id)).find(Boolean);
  assert.deepEqual(find(calls[1].args.layout,find(calls[1].args.layout,'conversation-view').active).children.find(c=>c.content?.mod==='chat').content.props,
   {started:true,presentation:true,terminal:'t8',owner_tab:'tb-owner',owner_pane:'p-agent'});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
