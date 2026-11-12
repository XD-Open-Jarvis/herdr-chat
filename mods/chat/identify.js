// Keep background probes separate from user-facing identification feedback.
export const IDENTIFY_GRACE_MS = 4000;
export function identifyKey(term, title) {
  return `${term?.address}:${term?.foreground?.pid}:${title?.prefix ?? ""}`;
}
export class IdentifyFeedback {
  begin(key, now = Date.now()) {
    if (this.key === key) return;
    this.key = key;
    this.started = now;
    this.failed = false;
  }
  finish(resolved) {
    this.failed = !resolved;
  }
  needsAction(key, now = Date.now()) {
    return this.key === key && this.failed && now - this.started >= IDENTIFY_GRACE_MS;
  }
}
