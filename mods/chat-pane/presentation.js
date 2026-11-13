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
  const template = findNode(updated, "conversation-page");
  if (!stack || !template) throw new Error("Select the updated Chat layout first");
  const matches = (meta) => meta?.owner_tab === localId(target.tab)
    && meta?.owner_pane === localId(target.pane) && meta?.terminal === localId(target.terminal);
  const live = typeof panes === "function" ? panes() : null;
  if (Array.isArray(live) && live.length > 0) {
    const livePanes = new Set(live.map((p) => localId(p?.pane ?? p?.id)).filter(Boolean));
    const livePairs = new Set(live.map((p) => `${localId(p?.pane ?? p?.id)}::${localId(p?.terminal)}`));
    const hasTermField = live.some((p) => p?.terminal);
    stack.children = stack.children.filter((child) => {
      if (child.id === "main" || child.id === "conversation-page") return true;
      const meta = pageMeta(child);
      if (!meta || matches(meta)) return true;
      const op = localId(meta.owner_pane);
      const ot = localId(meta.terminal);
      if (op && !livePanes.has(op)) return false;
      if (op && ot && hasTermField && !livePairs.has(`${op}::${ot}`)) return false;
      return true;
    });
  }
  let page = stack.children.find((child) => matches(pageMeta(child)));
  if (!page) {
    page = JSON.parse(JSON.stringify(template));
    const key = `${localId(target.tab)}-${localId(target.pane)}-${localId(target.terminal)}`;
    const rename = (node) => {
      node.id += `-${key}`;
      for (const child of node.children ?? []) rename(child);
    };
    rename(page);
    const props = { ...extra, presentation: true, terminal: localId(target.terminal),
      owner_tab: localId(target.tab), owner_pane: localId(target.pane) };
    page.children.find((child) => child.content?.mod === "chat").content.props = props;
    page.children.find((child) => child.content?.mod === "chat-pane").content.props = props;
    stack.children.push(page);
  }
  // Chat is a single full-size presentation of the same pane. Use its
  // ordinary frame, never the split-pane focus highlight.
  const frame = findNode(updated, "main")?.content?.pane;
  page.background = frame?.background ?? "background";
  page.border = { ...(frame?.border ?? { width: 1, color: "border" }) };
  page.radius = frame?.radius ?? 10;
  stack.active = page.id;
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
  const current = layout();
  const next = viewLayout(current, target, extra);
  const page = activePage(next);
  const previous = findNode(current, page.id);
  const sameFrame = previous && ["background", "border", "radius"].every(key =>
    JSON.stringify(previous[key]) === JSON.stringify(page[key]));
  if (sameFrame)
    await herdr("layout.select", { stack: "conversation-view", child: page.id });
  else
    await herdr("layout.set", { layout: next });
  await herdr("chat.focus", {});
  return { pane: target.pane };
}

export async function showTerminal(target) {
  await herdr("layout.select", { stack: "conversation-view", child: "main" });
  if (target && panes().some((p) => p.pane === target.pane && p.tab === target.tab && p.terminal === target.terminal))
    await herdr("pane.focus", { pane: target.pane });
}

export function pageMeta(page) {
  return page?.children?.find((child) => child.content?.mod === "chat")?.content?.props;
}

export function activePage(tree) {
  const stack = findNode(tree, "conversation-view");
  return stack?.children?.find((child) => child.id === stack.active);
}

export function presentationVisible(tree = layout(), owner = null) {
  const meta = pageMeta(activePage(tree));
  return shared("layout") === "chat" && Boolean(meta?.presentation)
    && (!owner || (meta.owner_tab === owner.owner_tab && meta.owner_pane === owner.owner_pane
      && localId(meta.terminal) === localId(owner.terminal)));
}

export function presentationLayoutReady(tree) {
  return Boolean(findNode(tree, "conversation-view") && findNode(tree, "conversation-chat") && findNode(tree, "conversation-header"));
}
