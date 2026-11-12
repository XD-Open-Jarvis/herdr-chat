import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
const load=async name=>import('data:text/javascript;base64,'+Buffer.from(readFileSync(new URL(`../mods/chat/${name}.js`,import.meta.url),'utf8')).toString('base64'));
const {toolDetails,patchChanges,withChanges}=await load('activity');
const patch='*** Begin Patch\n*** Update File: /repo/main.js\n@@\n-old\n-older\n+new\n*** End Patch';
const wrapped=(code,result='success')=>({name:'exec',input:code,summary:code.split('\n')[0],result,error:false,images:[]});
test('Codex exec wrappers expose their static patch and real command instead of orchestration JavaScript',()=>{
 const edit=toolDetails(wrapped(`text(await tools.apply_patch(${JSON.stringify(patch)}));`));
 assert.equal(edit.name,'Edit');assert.equal(edit.summary,'main.js');
 assert.equal(edit.changes[0].added,1);assert.equal(edit.changes[0].removed,2);assert.equal(edit.displayInput,patch);
 const command='node --check mods/chat/main.js; git status';
 const run=toolDetails(wrapped(`const r=await tools.exec_command({cmd:${JSON.stringify(command)},max_output_tokens:100});text(r)`));
 assert.equal(run.name,'Bash');assert.equal(run.summary,command);assert.equal(run.displayInput,command);
});
test('single-quoted JS, escaped quotes, static templates, comments and multiple calls parse without executing anything',()=>{
 const item=toolDetails(wrapped("// tools.apply_patch('not an edit')\nconst example=\"tools.apply_patch('also not an edit')\";\nawait tools.exec_command({cmd:'echo \\\'hello\\\''});await tools.exec_command({cmd:`git status`});"));
 assert.equal(item.summary,"echo 'hello'; git status");assert.deepEqual(item.changes,[]);
});
test('dynamic script arguments and quoted examples never fabricate edits or commands',()=>{
 for(const code of ['await tools.apply_patch(patch)','await tools.exec_command({cmd:prefix + "git status"})',
  'await tools.exec_command({cmd:`echo ${secret}`})','const s="tools.apply_patch(\\"*** Begin Patch\\")";']){
  const detail=toolDetails(wrapped(code));assert.equal(detail.name,'Tool script');assert.deepEqual(detail.changes,[]);
 }
});
test('add, delete and move changes preserve paths and do not invent unavailable deletion counts',()=>{
 const files=patchChanges('*** Add File: a.js\n+one\n+two\n*** Update File: old.js\n*** Move to: new.js\n@@\n-a\n+b\n*** Delete File: gone.js\n*** End Patch');
 assert.equal(files[0].added,2);assert.equal(files[1].oldPath,'old.js');assert.equal(files[1].path,'new.js');
 assert.equal(files[2].operation,'delete');assert.equal(files[2].removed,null);
});
test('historical changes are grouped per turn and placed after the response',()=>{
 const edit=wrapped(`await tools.apply_patch(${JSON.stringify(patch)})`);
 const entries=[{kind:'user',key:'u',text:'fix'},{kind:'tools',key:'t',items:[edit]},
  {kind:'assistant',key:'a',text:'done'},{kind:'notice',event:'completed',key:'done'},
  {kind:'user',key:'u2',text:'next'}];
 const shown=withChanges(entries);assert.deepEqual(shown.map(e=>e.kind),['user','tools','assistant','changes','notice','user']);
 assert.equal(shown[3].files[0].path,'/repo/main.js');assert.equal(entries.length,5);
});
test('failed and pending edits never claim applied file changes; acknowledgements invalidate cached descriptions',()=>{
 const edit=wrapped(`await tools.apply_patch(${JSON.stringify(patch)})`,null);
 const entries=[{kind:'tools',key:'t',items:[edit]}];
 assert.equal(withChanges(entries).length,1);edit.result='ok';assert.equal(withChanges(entries).length,2);
 edit.error=true;assert.equal(withChanges(entries).length,1);
});
test('Claude replacement edits have an inline diff but replace-all does not invent a change count',()=>{
 const item={name:'Edit',input:{file_path:'main.js',old_string:'old\n',new_string:'new\nline\n'},result:'ok'};
 const change=toolDetails(item).changes[0];assert.equal(change.added,2);assert.equal(change.removed,1);
 assert.ok(change.diff.includes('-old\n+new'));
 assert.deepEqual(toolDetails({...item,input:{...item.input,replace_all:true}}).changes,[]);
});
test('changes from repeated patches accumulate without depending on the current working tree',()=>{
 const a=wrapped(`await tools.apply_patch(${JSON.stringify(patch)})`), b=wrapped(`await tools.apply_patch(${JSON.stringify(patch)})`);
 const entries=withChanges([{kind:'tools',key:'t',items:[a,b]},{kind:'assistant',key:'a',text:'done'}]);
 assert.equal(entries.at(-1).files.length,1);assert.equal(entries.at(-1).files[0].added,2);assert.equal(entries.at(-1).files[0].removed,4);
});
test('a wrapper containing both a patch and a command retains both operations',()=>{
 const detail=toolDetails(wrapped(`await tools.apply_patch(${JSON.stringify(patch)});await tools.exec_command({cmd:"npm test"});`));
 assert.ok(detail.summary.includes('main.js'));assert.ok(detail.summary.includes('npm test'));
 assert.ok(detail.displayInput.includes('*** Begin Patch'));assert.ok(detail.displayInput.includes('npm test'));
});
test('nested tool and patch verification failures never produce an applied-change card',()=>{
 for(const result of ['apply_patch verification failed: missing context','Error: cannot patch','{"exit_code":1,"output":"bad"}','{"isError":true}']){
  const edit=wrapped(`await tools.apply_patch(${JSON.stringify(patch)})`,result);
  assert.equal(toolDetails(edit).error,true);assert.equal(withChanges([{kind:'tools',key:'t',items:[edit]}]).length,1);
 }
});
