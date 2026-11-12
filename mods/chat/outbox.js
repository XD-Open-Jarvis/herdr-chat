// Chat owns unsent messages; terminal-native queues cannot select one item to steer.
export function outboxScope(term, session) {
  return term?.state === "live" && term?.foreground?.pid && session
    ? `${term.address.split("/").at(-1)}:${term.foreground.pid}:${session}` : null;
}
export class Outbox {
  constructor(saved = {}) {
    this.items = Array.isArray(saved.items) ? saved.items.map(item => item.state === "sending"
      ? { ...item, state: "error", error: "Delivery was interrupted. Check TUI before retrying." } : item) : [];
    this.gate = saved.gate ?? null;
  }
  // Idle submissions start synchronously; retain an internal delivery receipt
  // for crash recovery without presenting them as queued follow-ups.
  canSendDirect(context) {
    this.observe(context);
    return Boolean(context.scope) && ["idle", "done"].includes(context.status)
      && this.gate?.scope !== context.scope
      && !this.items.some(item => item.scope === context.scope || item.state === "sending");
  }
  get visibleItems() {
    return this.items.filter(item => !(item.direct && item.state === "sending"));
  }
  enqueue(message, scope) {
    const item = { ...message, scope, id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, state: "queued" };
    this.items.push(item);
    return item;
  }
  observe({ scope, status, turn }) {
    if (!this.gate || this.gate.scope !== scope) return;
    if (status === "working" || status === "blocked") this.gate.sawBusy = true;
    if (["idle", "done"].includes(status) && (this.gate.sawBusy ||
      (Number.isSafeInteger(turn) && Number.isSafeInteger(this.gate.turn) && turn > this.gate.turn))) this.gate = null;
  }
  claim(context, id = null) {
    this.observe(context);
    if (!context.scope || this.items.some(item => item.state === "sending")) return null;
    if (!["idle", "done", "working", ...(id ? ["error"] : [])].includes(context.status)) return null;
    const item = id ? this.items.find(item => item.id === id)
      : this.items.find(item => item.scope === context.scope);
    if (!item || item.scope !== context.scope || item.state === "sending") return null;
    if (!id && ((this.gate?.scope === context.scope) || item.state !== "queued" || !["idle", "done"].includes(context.status))) return null;
    this.previousGate = this.gate;
    this.gate = { scope: context.scope, turn: context.turn, sawBusy: false };
    item.state = "sending";
    item.error = null;
    return item;
  }
  finish(id, error = null, paused = false) {
    const item = this.items.find(item => item.id === id);
    if (!item) return;
    if (error) {
      item.state = paused ? "queued" : "error"; item.error = paused ? null : error;
      this.gate = this.previousGate ?? null;
    } else this.items = this.items.filter(item => item.id !== id);
    this.previousGate = null;
  }
  remove(id) { this.items = this.items.filter(item => item.id !== id || item.state === "sending"); }
  toJSON() { return { items: this.items, gate: this.gate }; }
}
