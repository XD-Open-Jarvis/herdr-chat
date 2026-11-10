import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

// Execute the shipped tab-selection logic with Herdr's live data mocked.
const source = readFileSync(new URL("../mods/chat-tabs/main.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "")
  .replace("export default class Tabs", "class Tabs");

function selection({ address = "t1", label, chatTab, chatMod = "chat" }) {
  const terminal = { address, report: { app: "codex" }, labels: label ? { "chat.tab": label } : {} };
  const agent = { pane: "agent", tab: "work", terminal: address, focused: true };
  const allPanes = [agent, ...(chatTab ? [{ pane: "chat", tab: chatTab, mod: chatMod }] : [])];
  return runInNewContext(source + '\nnew Tabs().chatIn({ id: "work" }, { tabs: tabs })', {
    View: class {}, terminals: () => [terminal], findNode:()=>null,presentationPane:()=>null,panes: () => allPanes,
    tabs: [{ id: "work" }, ...(chatTab ? [{ id: chatTab }] : [])],
  });
}

test("offers Move to chat for an agent without a chat label", () => {
  assert.equal(selection({}).agent?.pane, "agent");
});
test("closing the chat tab in another layout leaves Move to chat available", () => {
  const result = selection({ label: "closed" });
  assert.equal(result.agent?.pane, "agent");
  assert.equal(result.back, undefined);
});
test("a surviving tab without a chat pane does not count as a chat", () => {
  const result = selection({ label: "old", chatTab: "old", chatMod: "files" });
  assert.equal(result.agent?.pane, "agent");
  assert.equal(result.back, undefined);
});
test("a live hidden chat offers Back to chat instead of a duplicate", () => {
  const result = selection({ label: "conversation", chatTab: "conversation" });
  assert.equal(result.agent, undefined);
  assert.equal(result.back, "conversation");
});
test("remote labels resolve against machine-qualified pane tab ids", () => {
  const result = selection({ address: "remote/t1", label: "conversation", chatTab: "remote/conversation" });
  assert.equal(result.agent, undefined);
  assert.equal(result.back, "remote/conversation");
});

// Run the same render prelude that reconciles the frame before building UI.
const framePrelude = source.slice(source.indexOf("    const space = spaces().find(p => p.active);"),
  source.indexOf("    // Settled tabs are put away"));
const findSource = source.slice(source.indexOf("function find("), source.indexOf("// Claude Code or Codex"));
function reconcile(paneList, color = "accent") {
  const tree = { id: "root", children: [{ id: "main", content: { pane: {
    border: { width: 1, color: "border" }, focus: { width: 1, color }, lone: true,
  } } }] };
  const calls = [];
  runInNewContext(findSource + framePrelude, {
    spaces: () => [{ active: true, tabs: [{ id: "work", active: true }] }],
    findNode:()=>null,presentationPane:()=>null,panes: () => paneList, layout: () => tree,
    run: (command, args) => calls.push({ command, args }),
  });
  return { tree, calls };
}
test("one pane keeps its normal frame while suppressing the focus accent", () => {
  const { tree, calls } = reconcile([{ tab: "work" }]);
  assert.equal(calls[0].args.layout.children[0].content.pane.focus.color, "border");
  assert.equal(calls[0].args.layout.children[0].content.pane.lone, true);
  assert.equal(tree.children[0].content.pane.focus.color, "accent");
});
test("a zoomed split uses the normal border", () => {
  const { calls } = reconcile([{ tab: "work", zoomed: true }, { tab: "work" }]);
  assert.equal(calls[0].args.layout.children[0].content.pane.focus.color, "border");
});
test("unzooming a split restores the focus accent", () => {
  const { calls } = reconcile([{ tab: "work" }, { tab: "work" }], "border");
  assert.equal(calls[0].args.layout.children[0].content.pane.focus.color, "accent");
});
test("panes in other tabs do not cause focus highlighting", () => {
  const { calls } = reconcile([{ tab: "work" }, { tab: "other" }]);
  assert.equal(calls[0].args.layout.children[0].content.pane.focus.color, "border");
});
test("a matching frame does not issue another layout mutation", () => {
  assert.equal(reconcile([{ tab: "work" }], "border").calls.length, 0);
});

test("pending border changes are not resent on every redraw", () => {
  const calls=[];
  const tree={id:'main',content:{pane:{border:{width:1,color:'border'},focus:{width:1,color:'accent'}}}};
  const context={spaces:()=>[{active:true,tabs:[{id:'work',active:true}]}],
    findNode:()=>null,presentationPane:()=>null,panes:()=>[{tab:'work'}],layout:()=>tree,run:(...args)=>calls.push(args)};
  runInNewContext(findSource + 'function renderFrame() {\n' + framePrelude + '\n}\nrenderFrame(); renderFrame();',context);
  assert.equal(calls.length,1);
});
test('switching to another tab leaves local Chat mode without changing shared panes',()=>{
 const calls=[];const owner={pane:'agent',tab:'previous',terminal:'t1'};
 const tree={id:'conversation-view',active:'conversation-page'};
 const context={spaces:()=>[{active:true,tabs:[{id:'next',active:true}]}],
  panes:()=>[owner],layout:()=>tree,findNode:(_tree,id)=>id==='conversation-view'?tree:id==='conversation-chat'?{content:{props:{}}}:null,
  presentationPane:()=>owner,run:(command,args)=>calls.push({command,args})};
 runInNewContext(findSource+'function renderFrame() {\n'+framePrelude+'\n}\nrenderFrame(); renderFrame();',context);
 assert.deepEqual(calls.map(c=>c.command),['layout.select']);
 assert.equal(calls[0].args.child,'main');
});
