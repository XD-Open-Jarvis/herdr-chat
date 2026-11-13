import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../mods/chat/preview.js',import.meta.url),'utf8');
const hoverDiffSource=readFileSync(new URL('../mods/chat/hover-diff.js',import.meta.url),'utf8');
const {fileLink,previewKey,previewPane,previewLayout}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const {sidebarVisible}=await import('data:text/javascript;base64,'+Buffer.from(hoverDiffSource).toString('base64'));
test('file links resolve relative to the owning terminal directory and retain line references',()=>{
 assert.deepEqual(fileLink('docs/plan.md#L12-L20','/repo'),{file:'/repo/docs/plan.md',line:12});
 assert.deepEqual(fileLink('/repo/a.ts:22:3','/other'),{file:'/repo/a.ts',line:22});
 assert.deepEqual(fileLink('file:///repo/a%20b.md','/other'),{file:'/repo/a b.md',line:null});
 assert.deepEqual(fileLink('C:\\repo\\a.ts:3','C:\\other'),{file:'C:\\repo\\a.ts',line:3});
 for(const link of ['https://example.com/file.md','mailto:x@example.com','file://other-host/a.md','#heading','bad%ZZ.md'])assert.equal(fileLink(link,'/repo'),null);
 assert.equal(fileLink('readme.md',null),null);
});
test('preview follows the owning pane in the active tab, never another machine with the same local IDs',()=>{
 const meta={presentation:true,owner_tab:'tab',owner_pane:'pane',terminal:'t1'};
 const tree={id:'conversation-view',active:'chat',children:[{id:'chat',children:[{content:{mod:'chat',props:meta}}]}]};
 const remote={tab:'connection-alias/tab',pane:'connection-alias/pane',terminal:'connection-alias/t1'};
 const other={tab:'other/tab',pane:'other/pane',terminal:'other/t1'};
 assert.equal(previewPane(tree,[other,remote],remote.tab,null),remote);
 assert.equal(previewPane(tree,[other],remote.tab,null),null);
 assert.notEqual(previewKey(remote),previewKey(other));
 assert.equal(previewPane(tree,[remote,{...remote}],remote.tab,null),null);
 const selected={tab:'selected-tab',pane:'selected-pane',terminal:'t2'};
 assert.equal(previewPane(tree,[remote,selected],selected.tab,selected.pane),selected);
});
test('adding the sidebar preview changes only the personal layout and preserves terminal structure',()=>{
 const tree={id:'root',children:[{id:'conversation-view',children:[{id:'main',content:{tab:'active'}}]},
 {id:'panel',hidden:true,size:{px:368},children:[{id:'panel-body',children:[{id:'files',content:{mod:'files'}},{id:'changes',content:{mod:'changes'}}]}]}]};
 const next=previewLayout(tree),panel=next.children[1];
 assert.equal(tree.children[1].hidden,true);assert.deepEqual(next.children[0],tree.children[0]);
 assert.equal(panel.hidden,false);assert.equal(panel.children[0].active,'chat-preview');
 assert.equal(panel.children[0].children.length,3);assert.equal(previewLayout(next).children[1].children[0].children.length,3);
 assert.throws(()=>previewLayout({id:'root'}),/no file sidebar/);
});
test('the isolated preview mod ships the same path and diff helpers as chat',()=>{
 assert.equal(readFileSync(new URL('../mods/chat-preview/preview.js',import.meta.url),'utf8'),source);
 assert.equal(readFileSync(new URL('../mods/chat-preview/diff.js',import.meta.url),'utf8'),readFileSync(new URL('../mods/chat/diff.js',import.meta.url),'utf8'));
});
test('Markdown fragments and queries do not become part of the disk filename',()=>{
 assert.deepEqual(fileLink('docs/setup.md#configuration','/project'),{file:'/project/docs/setup.md',line:null});
 assert.deepEqual(fileLink('README.md?raw=1#intro','/project'),{file:'/project/README.md',line:null});
 assert.deepEqual(fileLink('docs/a.ts?raw=1#L12-L20','/project'),{file:'/project/docs/a.ts',line:12});
 assert.deepEqual(fileLink('file:///repo/a%23b%3Fc.md#intro','/other'),{file:'/repo/a#b?c.md',line:null});
 assert.deepEqual(fileLink('/repo/a#b?c.md','/other',true),{file:'/repo/a#b?c.md',line:null});
});
test('opening an existing sidebar preserves its saved pixel or proportional width',()=>{
 for(const size of [{px:666},{weight:2}]){
  const tree={id:'panel',size,hidden:true,children:[{id:'panel-body',children:[]}]};
  assert.deepEqual(previewLayout(tree).size,size);
 }
 assert.equal(previewLayout({id:'panel',children:[{id:'panel-body',children:[]}]}).size.px,520);
});

function previewView(terminal, pane, tree) {
 const calls=[],tasks=[];let saved;
 const main=readFileSync(new URL('../mods/chat/main.js',import.meta.url),'utf8').replace(/^import[\s\S]*?;\n/gm,'').replace('export default class Chat','class Chat');
 const Chat=runInNewContext(main+'\nChat',{View:class{},appWindow:()=>({platform:'macos'}),fileLink,previewKey,previewLayout,sidebarVisible,
  machineOf:address=>address?.includes('/')?address.split('/')[0]:null,
  shared:()=>({}),setShared:(_key,value)=>{saved=value;},layout:()=>tree,
  herdr:async(name,args)=>{calls.push({name,args});},notify:notice=>{throw new Error(notice.body);}});
 const view=Object.assign(Object.create(Chat.prototype),{myPane:()=>pane,terminal:()=>terminal});
 const cx={open_url(){throw new Error('A machine-owned file must not open on the local desktop.');},spawn(fn){tasks.push(fn(cx));}};
 return {view,cx,calls,tasks,saved:()=>saved};
}
test('offline terminals open files using their verified pane machine and last known folder',async()=>{
 const pane={tab:'alias/tab',pane:'alias/pane',terminal:'alias/t1',cwd:'/remote/repo'};
 const tree={id:'panel',hidden:true,size:{px:640},children:[{id:'panel-body',children:[{id:'chat-preview'}]}]};
 const s=previewView(null,pane,tree);
 assert.doesNotThrow(()=>s.view.openFilePreview('docs/setup.md#intro',s.cx));
 await Promise.all(s.tasks);
 const request=s.saved()[previewKey(pane)];
 assert.equal(request.on,'alias');assert.equal(request.file,'/remote/repo/docs/setup.md');
 assert(!s.calls.some(call=>call.name==='layout.resize'));
 assert.equal(s.calls.at(-1).name,'layout.show');
});
test('closing and reopening a preview never resets a user chosen sidebar width',async()=>{
 const pane={tab:'tab',pane:'pane',terminal:'t1'};
 const s=previewView({address:'t1',cwd:'/repo'},pane,{id:'panel',hidden:true,size:{px:700},children:[{id:'chat-preview'}]});
 s.view.openFilePreview('/repo/a.md',s.cx);await Promise.all(s.tasks);
 assert.deepEqual(s.calls.map(call=>call.name),['layout.select','layout.show']);
});
test('View changes opens the entire recorded change set and resolves every file on its owner machine',async()=>{
 const pane={tab:'alias/tab',pane:'alias/pane',terminal:'alias/t1',cwd:'/remote/repo'};
 const tree={id:'panel',children:[{id:'chat-preview'}]};
 const s=previewView(null,pane,tree);
 s.view.openChanges({files:[{path:'a.js',diff:'-a\n+b'},{path:'docs/b.md',diff:'+b'}]},s.cx,1);
 await Promise.all(s.tasks);
 const request=s.saved()[previewKey(pane)];
 assert.equal(request.changes.length,2);assert.equal(request.file,'/remote/repo/docs/b.md');
 assert.equal(request.changes[0].file,'/remote/repo/a.js');assert.equal(request.changes[1].file,'/remote/repo/docs/b.md');
 assert.equal(request.mode,'diff');assert.equal(request.on,'alias');
});

test('diff collection filename and File buttons use cx.stop_propagation without calling event.stop_propagation',async()=>{
 const collectionSrc=readFileSync(new URL('../mods/chat-preview/collection.js',import.meta.url),'utf8');
 const diffSrc=readFileSync(new URL('../mods/chat-preview/diff.js',import.meta.url),'utf8');
 const {collectionPosition,FILE_HEADER}=await import('data:text/javascript;base64,'+Buffer.from(collectionSrc).toString('base64'));
 const {diffLines,diffGroups}=await import('data:text/javascript;base64,'+Buffer.from(diffSrc).toString('base64'));
 const previewMain=readFileSync(new URL('../mods/chat-preview/main.js',import.meta.url),'utf8')
  .replace(/^import[\s\S]*?;\n/gm,'').replace('export default class Preview','class Preview');
 const clicks=[];
 const el=(id=null)=>{
  const node=new Proxy({id,label:null,onClick:null},{get(target,prop){
   if(prop==='id')return nextId=>{target.id=nextId;return node;};
   if(prop==='on_click')return fn=>{target.onClick=fn;clicks.push(target);return node;};
   if(prop==='child')return v=>{if(typeof v==='string')target.label=v;return node;};
   if(prop==='when')return (cond,fn)=>cond?fn(node):node;
   if(prop==='children')return ()=>node;
   return ()=>node;
  }});
  return node;
 };
 let state={'k1':{revision:1,mode:'diff',changes:[{path:'/repo/a.js',file:'/repo/a.js',diff:'-old\n+new',added:1,removed:1}]}};
 const Preview=runInNewContext(previewMain+'\nPreview',{
  View:class{},div:()=>el(),h_flex:()=>el(),v_flex:()=>el(),
  TextView:{html:()=>el()},Editor:{new:()=>el()},EditorState:{new:()=>({})},
  shared:()=>state,setShared:(_k,v)=>{state=v;},theme:()=>({}),settings:()=>({font_family:'Menlo'}),
  spaces:()=>[],panes:()=>[],focused:()=>null,layout:()=>({}),readTextFile:async()=>'',run:()=>{},
  previewPane,previewKey,fileLink,collectionPosition,FILE_HEADER,diffLines,diffGroups,
 });
 const view=new Preview();view.init();
 view.diffCollection(state.k1,{},'k1');
 let stopped=0,notified=0;
 const cx={stop_propagation(){stopped++;},notify(){notified++;}};
 const titleClick=clicks.find(c=>c.label?.includes('a.js'));
 const fileBtn=clicks.find(c=>c.id==='collection-file-0');
 assert.ok(titleClick);assert.ok(fileBtn);
 assert.doesNotThrow(()=>titleClick.onClick({click_count:1},cx));
 assert.equal(stopped,1);assert.equal(notified,1);assert.equal(view.diffCollapsed.has('/repo/a.js'),true);
 assert.doesNotThrow(()=>fileBtn.onClick({click_count:1},cx));
 assert.equal(stopped,2);assert.equal(state.k1.mode,'source');
});
