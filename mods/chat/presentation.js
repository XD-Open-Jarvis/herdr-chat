import { layout, panes, run, shared } from "herdr";
import { herdr } from "./backstage.js";
import { localId, qualifyAddress } from "./identity.js";

export function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

// Only personal layout files change. The shared tab/split document is never written.
export function viewLayout(tree, target, extra = {}) {
  const updated = JSON.parse(JSON.stringify(tree));
  const stack = findNode(updated, "conversation-view");
  const body = findNode(updated, "conversation-chat");
  const head = findNode(updated, "conversation-header");
  if (!stack || !body || !head) throw new Error("Select the updated Chat layout first");
  const props = { ...extra, presentation: true, terminal: localId(target.terminal),
    owner_tab: localId(target.tab), owner_pane: localId(target.pane) };
  body.content.props = props;
  head.content.props = props;
  stack.active = "conversation-page";
  return updated;
}

export function presentationPane(meta, all) {
  if (!meta.owner_tab || !meta.owner_pane || !meta.terminal) return null;
  const matches = all.filter((p) => p.terminal && localId(p.tab) === localId(meta.owner_tab)
    && localId(p.pane) === localId(meta.owner_pane)
    && p.terminal === qualifyAddress(meta.terminal, p.tab));
  return matches.length === 1 ? matches[0] : null;
}

export async function openChat(target, extra = {}) {
  // Reject stale or mismatched targets before changing any local UI.
  if (!panes().some((p) => p.pane === target.pane && p.tab === target.tab && p.terminal === target.terminal))
    throw new Error("This terminal pane is no longer available");
  await herdr("layout.set", { layout: viewLayout(layout(), target, extra) });
  await herdr("chat.focus", {});
  return { pane: target.pane };
}

export async function showTerminal(target) {
  await herdr("layout.select", { stack: "conversation-view", child: "main" });
  if (target && panes().some((p) => p.pane === target.pane && p.tab === target.tab && p.terminal === target.terminal))
    await herdr("pane.focus", { pane: target.pane });
}

export function presentationVisible(tree = layout()) {
  return shared("layout") === "chat" && findNode(tree, "conversation-view")?.active === "conversation-page";
}

export function presentationLayoutReady(tree) {
  return Boolean(findNode(tree, "conversation-view") && findNode(tree, "conversation-chat") && findNode(tree, "conversation-header"));
}
