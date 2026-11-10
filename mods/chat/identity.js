// Persist machine-local IDs. Resolve addresses only through the owning pane's
// live tab, whose machine prefix belongs to this client's connection aliases.
export const localId = (id) => typeof id === "string" ? id.split("/").pop() : null;
export const machineOfTab = (tab) => typeof tab === "string" && tab.includes("/") ? tab.slice(0, tab.lastIndexOf("/")) : null;
export function qualifyAddress(saved, tab) {
  const id = localId(saved);
  if (!id || !tab) return null;
  const machine = machineOfTab(tab);
  return machine ? `${machine}/${id}` : id;
}
export function ownerPane(meta, all) {
  const tab = localId(meta.owner_tab);
  const pane = localId(meta.owner_pane);
  if (!tab) return null;
  const matches = all.filter((p) => p.mod === "chat" && localId(p.tab) === tab && (!pane || localId(p.pane) === pane));
  // Ambiguous pane/tab IDs are an error, never a reason to choose an active
  // machine or search all machines for a terminal with the same bare ID.
  return matches.length === 1 ? matches[0] : null;
}
export function chatProps(terminal, tab) {
  return { terminal: localId(terminal), owner_tab: localId(tab) };
}
