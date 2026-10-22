import { CLIENT_TIMING, answerLengths, type AnswerMap, type TelemetryMap } from '@jee/shared';
import { emptyState, saveState, type LocalState } from './idb.js';

/**
 * Local answer state, and the only place `revision` is advanced.
 *
 * `revision` is the contract with the server: every change bumps it, and the
 * sync loop skips entirely when it has not moved. It is persisted alongside the
 * answers, because a reload that reset the counter would have its first sync
 * silently ignored by the server's `revision <` guard.
 */

export type Listener = (state: LocalState) => void;

export class AnswerStore {
  private state: LocalState;
  private listeners = new Set<Listener>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSave = false;

  constructor(
    initial: LocalState,
    private readonly persist: (state: LocalState) => Promise<unknown> = saveState,
    private readonly debounceMs: number = CLIENT_TIMING.idbDebounceMs,
  ) {
    this.state = initial;
  }

  static empty(attemptId: string): AnswerStore {
    return new AnswerStore(emptyState(attemptId));
  }

  get(): LocalState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  /**
   * Debounced so that typing does not write to IndexedDB on every keystroke,
   * but short enough that a crash costs a fraction of a second of work.
   */
  private scheduleSave(): void {
    this.pendingSave = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void this.flush();
    }, this.debounceMs);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.pendingSave) return;
    this.pendingSave = false;
    this.state = { ...this.state, lastSavedAt: Date.now() };
    await this.persist(this.state);
    this.emit();
  }

  setAnswer(questionId: string, value: string): void {
    if (this.state.answers[questionId] === value) return;
    this.state = {
      ...this.state,
      answers: { ...this.state.answers, [questionId]: value },
      revision: this.state.revision + 1,
    };
    this.scheduleSave();
    this.emit();
  }

  clearAnswer(questionId: string): void {
    if (!(questionId in this.state.answers)) return;
    const answers = { ...this.state.answers };
    delete answers[questionId];
    this.state = { ...this.state, answers, revision: this.state.revision + 1 };
    this.scheduleSave();
    this.emit();
  }

  /** Counters only — never a keystroke stream. Most of these students are minors. */
  recordKeystrokes(questionId: string, count = 1): void {
    const current = this.state.telemetry[questionId] ?? {
      keystrokes: 0,
      pastes: 0,
      pastedChars: 0,
    };
    this.state = {
      ...this.state,
      telemetry: {
        ...this.state.telemetry,
        [questionId]: { ...current, keystrokes: current.keystrokes + count },
      },
    };
    this.scheduleSave();
  }

  recordPaste(questionId: string, chars: number): void {
    const current = this.state.telemetry[questionId] ?? {
      keystrokes: 0,
      pastes: 0,
      pastedChars: 0,
    };
    this.state = {
      ...this.state,
      telemetry: {
        ...this.state.telemetry,
        [questionId]: {
          ...current,
          pastes: current.pastes + 1,
          pastedChars: current.pastedChars + chars,
        },
      },
    };
    this.scheduleSave();
  }

  toggleReview(questionId: string): void {
    const marked = this.state.markedForReview.includes(questionId)
      ? this.state.markedForReview.filter((id) => id !== questionId)
      : [...this.state.markedForReview, questionId];
    this.state = { ...this.state, markedForReview: marked };
    this.scheduleSave();
    this.emit();
  }

  /** Called when the server acknowledges a sync. */
  markSynced(revision: number, at: number): void {
    this.state = {
      ...this.state,
      syncedRevision: Math.max(this.state.syncedRevision, revision),
      lastSyncedAt: at,
    };
    this.scheduleSave();
    this.emit();
  }

  markSubmitted(receipt: string, at: number): void {
    this.state = { ...this.state, receipt, submittedAt: at };
    this.pendingSave = true;
    void this.flush();
  }

  /**
   * Replaces local state with the server's. Used only when resuming on a
   * machine that has no IndexedDB copy — never to overwrite local work, which
   * is always at least as fresh as the server's.
   */
  adoptServerState(params: {
    answers: AnswerMap;
    telemetry: TelemetryMap;
    revision: number;
  }): void {
    this.state = {
      ...this.state,
      answers: params.answers,
      telemetry: params.telemetry,
      revision: params.revision,
      syncedRevision: params.revision,
    };
    this.pendingSave = true;
    void this.flush();
  }

  snapshot() {
    return {
      attemptId: this.state.attemptId,
      revision: this.state.revision,
      answers: this.state.answers,
      telemetry: this.state.telemetry,
    };
  }

  lengths(): Record<string, number> {
    return answerLengths(this.state.answers);
  }

  answeredCount(): number {
    return Object.values(this.state.answers).filter((value) => value.trim().length > 0).length;
  }
}
