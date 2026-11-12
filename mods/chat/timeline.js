// Keep optimistic user messages at their send position while the transcript
// catches up, ahead of response/tool entries that arrived after sending.
export function withPending(entries, pending) {
  const result = [];
  const slots = new Map();
  pending.forEach((message, index) => {
    const anchor = message.afterKey == null ? -1 : entries.findIndex(entry => entry.key === message.afterKey);
    const slot = anchor + 1;
    if (!slots.has(slot)) slots.set(slot, []);
    slots.get(slot).push({ kind: "pending", message, index });
  });
  for (let index = 0; index <= entries.length; index++) {
    result.push(...(slots.get(index) ?? []));
    if (index < entries.length) result.push(entries[index]);
  }
  return result;
}
