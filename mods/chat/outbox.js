// Chat owns unsent messages; terminal-native queues cannot select one item to steer.
export function outboxScope(term, session) {
  return term?.state === "live" && term?.foreground?.pid && session
    ? `${term.address.split("/").at(-1)}:${term.foreground.pid}:${session}` : null;
}
export const GATE_STALE_MS = 10000;

export class Outbox {
  constructor(saved = {}) {
    this.items = Array.isArray(saved.items) ? saved.items.map(item => item.state === "sending"
      ? { ...item, state: "error", error: "Delivery was interrupted. Check TUI before retrying." } : item) : [];
    this.gate = saved.gate ? { ...saved.gate, at: Number.isFinite(saved.gate.at) ? saved.gate.at : Date.now() } : null;
  }
  // Idle submissions start synchronously; retain an internal delivery receipt
  // for crash recovery without presenting them as queued follow-ups.
  canSendDirect(context) {
    this.observe(context);
    return Boolean(context.scope) && ["idle", "done"].includes(context.status)
      && this.gate?.scope !== context.scope
      && !this.items.some(item => (item.scope === context.scope && !(item.direct && item.state === "error")) || item.state === "sending");
  }
  get visibleItems() {
    return this.items.filter(item => !(item.direct && ["sending", "error"].includes(item.state)));
  }
  get failedItems() {
    return this.items.filter(item => item.direct && item.state === "error");
  }
  enqueue(message, scope) {
    const item = { ...message, scope, id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, state: "queued" };
    this.items.push(item);
    return item;
  }
  observe({ scope, status, turn, now = Date.now() }) {
    if (!this.gate || this.gate.scope !== scope) return;
    if (status === "working" || status === "blocked") this.gate.sawBusy = true;
    const expired = Number.isFinite(this.gate.at) && now - this.gate.at >= GATE_STALE_MS;
    if (["idle", "done"].includes(status) && (this.gate.sawBusy || expired ||
      (Number.isSafeInteger(turn) && Number.isSafeInteger(this.gate.turn) && turn > this.gate.turn))) this.gate = null;
  }
  retryReason(context, id) {
    const item = this.items.find(item => item.id === id);
    if (!item) return "Message is no longer available.";
    if (!context.scope) return "Identify the current session before retrying.";
    const before = item.scope?.split(":"), now = context.scope.split(":");
    const sameSession = before?.length === 3 && now.length === 3 && before[0] === now[0] && before[2] === now[2];
    if (item.scope !== context.scope && !sameSession) return "Return to the original session to retry.";
    if (this.items.some(message => message.state === "sending")) return "Another message is being sent. Try again when it finishes.";
    if (context.status === "blocked") return "Answer the terminal prompt before retrying.";
    if (!["idle", "done", "working", "error"].includes(context.status)) return "Waiting for the terminal to become ready.";
    return null;
  }
  claim(context, id = null) {
    this.observe(context);
    if (!context.scope || this.items.some(item => item.state === "sending")) return null;
    if (!["idle", "done", "working", ...(id ? ["error"] : [])].includes(context.status)) return null;
    if (id && this.retryReason(context, id)) return null;
    const item = id ? this.items.find(item => item.id === id)
      : this.items.find(item => item.scope === context.scope && !(item.direct && item.state === "error"));
    if (!item || (!id && item.scope !== context.scope) || item.state === "sending") return null;
    if (!id && ((this.gate?.scope === context.scope) || item.state !== "queued" || !["idle", "done"].includes(context.status))) return null;
    if (id) item.scope = context.scope;
    this.previousGate = this.gate;
    this.gate = { scope: context.scope, turn: context.turn, sawBusy: false, at: context.now ?? Date.now() };
    item.state = "sending";
    item.error = null;
    return item;
  }
  finish(id, error = null, paused = false) {
    const item = this.items.find(item => item.id === id);
    if (!item) return;
    if (error) {
      item.state = paused && !item.direct ? "queued" : "error"; item.error = paused && !item.direct ? null : error;
      this.gate = this.previousGate ?? null;
    } else this.items = this.items.filter(item => item.id !== id);
    this.previousGate = null;
  }
  remove(id) { this.items = this.items.filter(item => item.id !== id || item.state === "sending"); }
  toJSON() { return { items: this.items, gate: this.gate }; }
}
