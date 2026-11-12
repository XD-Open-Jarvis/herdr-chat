// Pane/tab IDs are machine-local and are resolved through their owner at run
// time. Do not persist a client-specific connection alias in the binding key.
export function bindingKey(owner, terminal) {
  const local = value => value?.split('/').pop();
  if (!owner?.owner_tab || !owner?.owner_pane || !terminal) return null;
  return JSON.stringify([local(owner.owner_tab), local(owner.owner_pane), local(terminal)]);
}

export function chooseBinding(previous, result, process) {
  if (!process) return null;
  if (result?.file) return { file: result.file, process, evidence: result.evidence };
  // An explicit status panel with a different/missing log is contradictory
  // evidence. An ordinary screen with too little matching text is not.
  if (result?.evidence === 'status') return null;
  return previous?.process === process ? previous : null;
}
