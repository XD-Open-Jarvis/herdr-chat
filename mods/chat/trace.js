// Non-invasive monotonic flight recorder for Codex live-stream vs JSONL
// handoff diagnostics. Disabled by default; writes serialized JSONL events to
// /tmp/herdr-codex-handoff-<id>.jsonl only when explicitly enabled.
import * as fs from "fs/promises";

const HIGH_FREQ_EVENTS = new Set(["check_state", "follow_frame", "render_sig"]);

const perfNow = () => {
  const perf = /** @type {{ now?: () => number } | undefined} */ (/** @type {Record<string, unknown>} */ (globalThis).performance);
  return typeof perf?.now === "function" ? perf.now() : Date.now();
};

/** Appends a chunk to `path`, using fs.appendFile when available or read+write in GPUI. */
async function appendText(path, chunk) {
  const mod = /** @type {{ appendFile?: (p: string, d: string, e?: string) => Promise<void> }} */ (/** @type {unknown} */ (fs));
  if (typeof mod.appendFile === "function") {
    await mod.appendFile(path, chunk, "utf8");
    return;
  }
  const prev = await fs.readFile(path, "utf8").catch(() => "");
  await fs.writeFile(path, prev + chunk);
}

export class HandoffTracer {
  /**
   * @param {{ id?: string, getId?: () => string, isEnabled?: () => boolean, dir?: string, append?: (path: string, chunk: string) => Promise<void> }} [options]
   */
  constructor(options = {}) {
    this.getId = typeof options.getId === "function" ? options.getId : () => options.id ?? "default";
    this.isEnabledFn = typeof options.isEnabled === "function" ? options.isEnabled : () => false;
    this.dir = options.dir ?? "/tmp";
    this.appendFn = typeof options.append === "function" ? options.append : appendText;
    this.lastMs = 0;
    this.lastSig = new Map();
    this.pending = [];
    this.flushing = null;
  }

  /** Returns true only when tracing is explicitly enabled. */
  isEnabled() {
    try {
      return Boolean(this.isEnabledFn());
    } catch {
      return false;
    }
  }

  /** Resolves the sanitized JSONL log path for the current chat instance. */
  path() {
    const safeId = String(this.getId() || "default").replace(/[^A-Za-z0-9._-]+/g, "_");
    return `${this.dir}/herdr-codex-handoff-${safeId}.jsonl`;
  }

  /** Records a monotonic JSONL trace event, deduplicating high-frequency signatures. */
  record(event, data = {}) {
    if (!this.isEnabled()) return;
    if (HIGH_FREQ_EVENTS.has(event)) {
      const sig = typeof data.sig === "string" ? data.sig : JSON.stringify(data);
      if (this.lastSig.get(event) === sig) return;
      this.lastSig.set(event, sig);
    }
    this.lastMs = Math.max(this.lastMs, Math.round(perfNow()));
    const entry = { t_ms: this.lastMs, ts: new Date().toISOString(), event, ...data };
    this.pending.push(JSON.stringify(entry) + "\n");
    if (!this.flushing) {
      this.flushing = this.#drain().finally(() => {
        this.flushing = null;
      });
    }
  }

  /** Waits until all currently queued trace lines have been flushed. */
  async flush() {
    while (this.flushing) {
      await this.flushing;
    }
  }

  async #drain() {
    while (this.pending.length) {
      const chunk = this.pending.splice(0, this.pending.length).join("");
      try {
        await this.appendFn(this.path(), chunk);
      } catch {}
    }
  }
}
