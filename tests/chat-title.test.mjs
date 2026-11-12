import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../mods/chat/title.js',import.meta.url),'utf8');
const api=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const id='01a1ce0e-87ba-7bb3-b99b-fc3189eeba6e';
const terminal={state:'live',status:'idle',report:{app:'codex',state:'idle'},foreground:{argv:['/bin/codex','-c',api.CODEX_TITLE_CONFIG]},title:`codex | Example | project | ${id}`};
test('active explicitly configured Codex title exposes its full identity',()=>{
 assert.deepEqual(api.codexTitleIdentity(terminal),{prefix:id,complete:true});
});
test('the actual 0.167.1 truncated ID is recognized without inventing missing digits',()=>{
 assert.deepEqual(api.codexTitleIdentity({...terminal,title:`codex | Example | project | ${id.slice(0,29)}...`}),{prefix:id.slice(0,29),complete:false});
});
test('plain titles, UUIDs in task names and unconfigured processes are not identity',()=>{
 assert.equal(api.codexTitleIdentity({...terminal,foreground:{argv:['codex']}}),null);
 assert.equal(api.codexTitleIdentity({...terminal,title:`${id} | project`}),null);
 assert.equal(api.codexTitleIdentity({...terminal,title:'codex | 01a1...'}),null);
});
test('exit and trust/startup states cannot reuse a leftover title',()=>{
 assert.equal(api.codexTitleIdentity({...terminal,state:'finished'}),null);
 assert.equal(api.codexTitleIdentity({...terminal,report:null}),null);
 assert.equal(api.codexTitleIdentity({...terminal,foreground:{argv:['/bin/zsh']}}),null);
});
test('display names hide transport IDs without modifying unconfigured titles',()=>{
 assert.equal(api.conversationTitle(terminal),'Example | project');
 assert.equal(api.conversationTitle({...terminal,title:`codex | ${id} | project | ${id.slice(0,29)}...`}), 'project');
 assert.equal(api.conversationTitle({...terminal,foreground:{argv:['codex']}}),terminal.title);
});
test('a changed title invalidates an old file within the same process',()=>{
 const identity=api.codexTitleIdentity(terminal);
 assert.equal(api.titleMatchesFile(identity,`/sessions/rollout-date-${id}.jsonl`),true);
 assert.equal(api.titleMatchesFile(identity,'/sessions/rollout-date-11111111-1111-1111-1111-111111111111.jsonl'),false);
});
test('new Chat Codex launches inject only a per-process override',()=>{
 const models=readFileSync(new URL('../mods/chat/models.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'');
 const launch=runInNewContext(models+'\nlaunchArgv',{CODEX_TITLE_CONFIG:api.CODEX_TITLE_CONFIG});
 const argv=launch('codex','model','low');assert.equal(argv[1],'-c');assert.equal(argv[2],api.CODEX_TITLE_CONFIG);
 assert.equal(launch('claude','model','low').includes(api.CODEX_TITLE_CONFIG),false);
});
test('header and chat use the identical title identity helper',()=>{
 assert.equal(source,readFileSync(new URL('../mods/chat-pane/title.js',import.meta.url),'utf8'));
});
test('the last title override controls trust, matching Codex configuration precedence',()=>{
 assert.equal(api.codexTitleIdentity({...terminal,foreground:{argv:['codex','-c',api.CODEX_TITLE_CONFIG,'--config=tui.terminal_title=["thread-title"]']}}),null);
 assert.notEqual(api.codexTitleIdentity({...terminal,foreground:{argv:['codex','--config',api.CODEX_TITLE_CONFIG]}}),null);
});
