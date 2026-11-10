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
test('new remote chats persist local terminal and tab IDs while CLI targets stay qualified',()=>{
 const dir=mkdtempSync(join(tmpdir(),'chat-create-test-'));
 try {
  const log=join(dir,'calls.jsonl');
  writeFileSync(join(dir,'herdr-app'),`#!/usr/bin/env node
const fs=require('node:fs');
const [, , verb,command,arg]=process.argv;
const args=JSON.parse(arg);
fs.appendFileSync(process.env.CHAT_TEST_LOG,JSON.stringify({command,args})+'\\n');
if(command==='space.new')console.log(JSON.stringify({terminal:'mini/t8',tab:'mini/tb-owner'}));
else if(command==='pane.split')console.log(JSON.stringify({pane:'mini/p-chat'}));
else console.log(JSON.stringify({ok:true}));
`,{mode:0o755});
  execFileSync('sh',['-c',script,'sh','{}',JSON.stringify({terminal:'__TERM__',owner_tab:'__TAB__',started:true})],
    {env:{...process.env,PATH:dir+':'+process.env.PATH,CHAT_TEST_LOG:log}});
  const calls=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.find(c=>c.command==='pane.focus').args.terminal,'mini/t8');
  assert.deepEqual(calls.find(c=>c.command==='pane.split').args.props,{terminal:'t8',owner_tab:'tb-owner',started:true});
 } finally {rmSync(dir,{recursive:true,force:true});}
});
