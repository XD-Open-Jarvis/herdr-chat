// Follow Herdr's shared read-state contract: acknowledge a displayed completed
// turn once, without continuously undoing another client's mark-unread action.
export class ChatAttention {
  looked = null;
  pending = null;

  update(terminal, { visible, active, ready }, write) {
    if (!visible || !active || !ready) { this.looked = null; return null; }
    // terminals() exposes the raw agent phase, usually idle after finishing.
    // The sidebar derives done separately from turn > herdr.seen. Do not wait
    // for the raw phase to say done: many agents never report that word.
    const phase = typeof terminal?.status === "string" ? terminal.status : terminal?.status?.state;
    if (phase !== "idle" && phase !== "done") return null;
    const turn = terminal.turn;
    if (!Number.isSafeInteger(turn) || turn < 0) return null;
    const key = `${terminal.address}:${turn}`;
    if (this.looked === key || this.pending) return null;
    this.looked = key;
    const label = terminal.labels?.["herdr.seen"];
    if (label != null && Number.isFinite(Number(label)) && Number(label) >= turn) return null;
    this.pending = Promise.resolve().then(() => write(terminal.address, turn))
      .catch(() => { if (this.looked === key) this.looked = null; })
      .finally(() => { this.pending = null; });
    return this.pending;
  }
}
