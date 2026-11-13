// Single-ownership handoff state machine between Codex's terminal stream and
// its session JSONL log. Ensures zero cross-format text comparison, zero
// pre-send residue flashing, and atomic slot/turn transitions.

export class CodexHandoff {
  constructor() {
    this.reset();
  }

  /** Clears all handoff state on session/file/generation reset. */
  reset() {
    this.latestSnapshot = null;
    this.acceptedText = null;
    this.acceptedEpoch = 0;
    this.acceptedAssistantCount = 0;
    this.acceptedBlockOrdinal = 0;
    this.acceptedPromptLine = null;
    this.drainedSlot = null;
    this.running = null;
    this.retired = null;
    this.loggedSlot = null;
    this.draining = false;
    this.seeded = false;
  }

  /** Seeds retired screen state from a cold-opened idle Codex terminal before follow() runs. */
  seedIdleScreen(snapshot) {
    this.seeded = true;
    this.latestSnapshot = snapshot ?? null;
    if (snapshot?.item?.kind === "text") {
      this.retired = {
        promptLine: snapshot.promptLine ?? null,
        text: snapshot.item.text,
      };
    }
  }

  /**
   * Records any visible screen text as retired on user send so pre-send screen
   * residue can never flash below the newly added optimistic user bubble.
   */
  noteUserSend() {
    this.seeded = true;
    if (this.latestSnapshot?.item?.kind === "text") {
      this.retired = {
        promptLine: this.latestSnapshot.promptLine ?? null,
        text: this.latestSnapshot.item.text,
      };
    } else if (this.acceptedText) {
      this.retired = {
        promptLine: this.latestSnapshot?.promptLine ?? this.retired?.promptLine ?? null,
        text: this.acceptedText,
      };
    }
    this.acceptedText = null;
    this.acceptedAssistantCount = 0;
    this.acceptedBlockOrdinal = 0;
    this.acceptedPromptLine = null;
    this.drainedSlot = null;
    this.running = null;
    this.draining = false;
  }

  /** Marks an async Tail drain in progress while holding acceptedText visible. */
  beginDrain() {
    this.draining = true;
  }

  /** Ends an async Tail drain and releases the drained active-slot text. */
  endDrain({ keepRun = false } = {}) {
    if (this.acceptedText) {
      this.drainedSlot = {
        epoch: this.acceptedEpoch,
        assistantCount: this.acceptedAssistantCount,
        text: this.acceptedText,
        blockOrdinal: this.acceptedBlockOrdinal,
        promptLine: this.acceptedPromptLine,
      };
    }
    this.draining = false;
    this.acceptedText = null;
    if (!keepRun) this.running = null;
  }

  /** Retires any remaining screen text and clears active stream state on loop exit. */
  finishFollow() {
    this.seeded = true;
    if (this.latestSnapshot?.item?.kind === "text") {
      this.retired = {
        promptLine: this.latestSnapshot.promptLine ?? null,
        text: this.latestSnapshot.item.text,
      };
    } else if (this.acceptedText) {
      this.retired = {
        promptLine: this.latestSnapshot?.promptLine ?? this.retired?.promptLine ?? null,
        text: this.acceptedText,
      };
    }
    this.acceptedText = null;
    this.acceptedAssistantCount = 0;
    this.acceptedBlockOrdinal = 0;
    this.acceptedPromptLine = null;
    this.drainedSlot = null;
    this.running = null;
    this.draining = false;
  }

  /**
   * Evaluates one terminal snapshot against the parsed Codex turn state.
   * Returns { streamText, running, shouldDrainBeforeDrop, reason }.
   */
  update(snapshot, { codexTurn = null, pendingCount = 0, termStatus = null, hasPriorAssistant = false } = {}) {
    this.seeded = true;
    this.latestSnapshot = snapshot ?? null;

    if (snapshot?.workedAfterAt) {
      this.retired = {
        promptLine: snapshot.promptLine ?? null,
        text: snapshot.item?.kind === "text" ? snapshot.item.text : this.acceptedText ?? this.retired?.text ?? null,
      };
      this.acceptedText = null;
      this.running = null;
      return { streamText: null, running: null, shouldDrainBeforeDrop: false, reason: "worked_on_screen" };
    }

    if (codexTurn?.stage === "completed") {
      this.retired = {
        promptLine: snapshot?.promptLine ?? null,
        text: snapshot?.item?.kind === "text" ? snapshot.item.text : this.acceptedText ?? this.retired?.text ?? null,
      };
      this.acceptedText = null;
      this.running = null;
      return { streamText: null, running: null, shouldDrainBeforeDrop: false, reason: "turn_completed_in_log" };
    }

    if (codexTurn?.stage === "assistant_logged") {
      const sameSlot =
        this.loggedSlot &&
        this.loggedSlot.epoch === codexTurn.epoch &&
        this.loggedSlot.assistantCount === codexTurn.assistantCount;
      this.loggedSlot = {
        epoch: codexTurn.epoch,
        assistantCount: codexTurn.assistantCount,
        text: snapshot?.item?.kind === "text"
          ? snapshot.item.text
          : (sameSlot ? this.loggedSlot?.text : null) ?? this.acceptedText ?? null,
        blockOrdinal: snapshot?.blockOrdinal ?? (sameSlot ? this.loggedSlot?.blockOrdinal : null) ?? 0,
        promptLine: snapshot?.promptLine ?? (sameSlot ? this.loggedSlot?.promptLine : null) ?? null,
      };
      this.acceptedText = null;
      this.drainedSlot = null;
      this.running = snapshot?.item?.kind === "run" ? snapshot.item : null;
      return { streamText: null, running: this.running, shouldDrainBeforeDrop: false, reason: "slot_logged" };
    }

    // If commentary + *_call arrived in a single Tail batch between follow()
    // ticks, promote the previously accepted slot into loggedSlot even though
    // codexTurn.stage already transitioned back to "awaiting_text".
    const priorSlot = this.acceptedText
      ? {
          epoch: this.acceptedEpoch,
          assistantCount: this.acceptedAssistantCount,
          text: this.acceptedText,
          blockOrdinal: this.acceptedBlockOrdinal,
          promptLine: this.acceptedPromptLine,
        }
      : this.drainedSlot;
    if (
      priorSlot &&
      codexTurn &&
      codexTurn.epoch === priorSlot.epoch &&
      codexTurn.assistantCount > priorSlot.assistantCount
    ) {
      if (
        !this.loggedSlot ||
        this.loggedSlot.epoch !== codexTurn.epoch ||
        this.loggedSlot.assistantCount < codexTurn.assistantCount
      ) {
        this.loggedSlot = {
          epoch: codexTurn.epoch,
          assistantCount: codexTurn.assistantCount,
          text: priorSlot.text,
          blockOrdinal: priorSlot.blockOrdinal,
          promptLine: priorSlot.promptLine,
        };
      }
      this.acceptedText = null;
      this.drainedSlot = null;
    }

    if (codexTurn && codexTurn.stage === "idle") {
      const brandNewWorking =
        codexTurn.epoch === 0 &&
        !hasPriorAssistant &&
        termStatus === "working" &&
        !(pendingCount > 0 && !snapshot?.statusAfterAt);
      if (!brandNewWorking) {
        if (snapshot?.item?.kind === "text" && termStatus !== "working") {
          this.retired = { promptLine: snapshot.promptLine ?? null, text: snapshot.item.text };
        }
        this.acceptedText = null;
        this.running = null;
        return { streamText: null, running: null, shouldDrainBeforeDrop: false, reason: "turn_idle" };
      }
    }

    if (snapshot?.item?.kind === "text") {
      // Turn Barrier: do not re-expose text already retired from a prior turn.
      if (
        this.retired &&
        snapshot.item.text === this.retired.text &&
        (snapshot.promptLine === null || snapshot.promptLine === this.retired.promptLine)
      ) {
        this.acceptedText = null;
        this.running = null;
        return { streamText: null, running: null, shouldDrainBeforeDrop: false, reason: "stale_prior_turn" };
      }
      // Slot Shadow Barrier: after a mid-turn tool call resets stage to awaiting_text,
      // reject the already-logged commentary block if no newer block/post-tool text exists.
      if (
        this.loggedSlot &&
        codexTurn &&
        this.loggedSlot.epoch === codexTurn.epoch &&
        snapshot.item.text === this.loggedSlot.text &&
        snapshot.promptLine !== null &&
        snapshot.blockOrdinal <= this.loggedSlot.blockOrdinal &&
        !snapshot.afterToolInBlock
      ) {
        this.acceptedText = null;
        return { streamText: null, running: this.running, shouldDrainBeforeDrop: false, reason: "stale_logged_slot" };
      }
      this.acceptedText = snapshot.item.text;
      this.acceptedEpoch = codexTurn?.epoch ?? 0;
      this.acceptedAssistantCount = codexTurn?.assistantCount ?? 0;
      this.acceptedBlockOrdinal = snapshot.blockOrdinal ?? 0;
      this.acceptedPromptLine = snapshot.promptLine ?? null;
      this.drainedSlot = null;
      this.running = null;
      return { streamText: this.acceptedText, running: null, shouldDrainBeforeDrop: false, reason: "live_stream" };
    }

    const epoch = codexTurn?.epoch ?? 0;
    const shouldDrainBeforeDrop =
      Boolean(this.acceptedText) &&
      this.acceptedEpoch === epoch &&
      codexTurn?.stage === "awaiting_text" &&
      !this.draining;
    if (!shouldDrainBeforeDrop && !this.draining) {
      this.acceptedText = null;
    }
    this.running = snapshot?.item?.kind === "run" ? snapshot.item : this.running;
    return {
      streamText: this.acceptedText,
      running: this.running,
      shouldDrainBeforeDrop,
      reason: snapshot?.item?.kind === "run" ? "running_tool" : shouldDrainBeforeDrop ? "drain_before_drop" : "empty_screen",
    };
  }

  /**
   * Synchronous render-time ownership gate: drops the live stream on the exact
   * render frame in which the log commits the active slot or ends the turn.
   */
  visibleStream(codexTurn) {
    if (!this.acceptedText) return null;
    if (codexTurn?.stage === "completed" || codexTurn?.stage === "assistant_logged") return null;
    if (codexTurn && codexTurn.stage === "idle" && codexTurn.epoch > 0) return null;
    if (codexTurn && this.acceptedEpoch !== codexTurn.epoch && codexTurn.epoch > 0) return null;
    if (codexTurn && this.acceptedEpoch === codexTurn.epoch && codexTurn.assistantCount > this.acceptedAssistantCount) return null;
    return this.acceptedText;
  }
}
