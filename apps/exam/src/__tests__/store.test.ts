import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnswerStore } from '../lib/store.js';
import { emptyState, loadState, saveState } from '../lib/idb.js';

/**
 * Local state is the student's protection against a refresh — the server is 90
 * seconds behind by design, and this closes the gap. These tests cover the two
 * properties that matter: a change is persisted, and `revision` only ever
 * moves forward.
 */

describe('AnswerStore', () => {
  let persisted: ReturnType<typeof vi.fn>;
  let store: AnswerStore;

  beforeEach(() => {
    persisted = vi.fn().mockResolvedValue(undefined);
    store = new AnswerStore(emptyState('attempt-1'), persisted, 0);
  });

  it('advances the revision on every change', () => {
    store.setAnswer('q1', 'A');
    expect(store.get().revision).toBe(1);
    store.setAnswer('q1', 'B');
    expect(store.get().revision).toBe(2);
  });

  it('does not advance the revision when nothing changed', () => {
    // This is what lets the sync loop skip the request entirely, which drops
    // 30-40% of the event's traffic.
    store.setAnswer('q1', 'A');
    store.setAnswer('q1', 'A');
    expect(store.get().revision).toBe(1);
  });

  it('advances the revision when an answer is cleared', () => {
    store.setAnswer('q1', 'A');
    store.clearAnswer('q1');
    expect(store.get().revision).toBe(2);
    expect(store.get().answers.q1).toBeUndefined();
  });

  it('persists after the debounce window', async () => {
    store.setAnswer('q61', 'some working');
    await store.flush();
    expect(persisted).toHaveBeenCalled();
    const saved = persisted.mock.calls.at(-1)![0];
    expect(saved.answers.q61).toBe('some working');
  });

  it('coalesces a burst of typing into one write', async () => {
    for (let i = 0; i < 50; i += 1) store.setAnswer('q61', 'x'.repeat(i));
    await store.flush();
    expect(persisted).toHaveBeenCalledTimes(1);
    expect(store.get().revision).toBe(50);
  });

  it('counts keystrokes and pastes without recording what was typed', async () => {
    store.recordKeystrokes('q61', 5);
    store.recordPaste('q61', 400);
    await store.flush();

    const telemetry = store.get().telemetry.q61!;
    expect(telemetry).toEqual({ keystrokes: 5, pastes: 1, pastedChars: 400 });
    expect(JSON.stringify(store.get().telemetry)).not.toContain('x');
  });

  it('never lowers the synced revision when acknowledgements arrive late', () => {
    store.markSynced(10, 1_000);
    store.markSynced(4, 2_000);
    expect(store.get().syncedRevision).toBe(10);
  });

  it('tracks marked-for-review locally without touching the revision', () => {
    store.setAnswer('q1', 'A');
    const before = store.get().revision;
    store.toggleReview('q1');
    expect(store.get().markedForReview).toEqual(['q1']);
    // Marking is a private note, not answer state: it costs no sync.
    expect(store.get().revision).toBe(before);
    store.toggleReview('q1');
    expect(store.get().markedForReview).toEqual([]);
  });

  it('counts only non-blank answers as answered', () => {
    store.setAnswer('q1', 'A');
    store.setAnswer('q2', '   ');
    store.setAnswer('q3', '');
    expect(store.answeredCount()).toBe(1);
  });

  it('reports lengths for the snapshot, not text', () => {
    store.setAnswer('q61', 'hello world');
    expect(store.lengths()).toEqual({ q61: 11 });
  });

  it('adopts server state only when asked, for a replacement machine', async () => {
    store.adoptServerState({ answers: { q1: 'A' }, telemetry: {}, revision: 42 });
    await store.flush();
    expect(store.get().answers).toEqual({ q1: 'A' });
    expect(store.get().revision).toBe(42);
    // Already acknowledged, so the next sync is skipped rather than resending.
    expect(store.get().syncedRevision).toBe(42);
  });
});

describe('IndexedDB round trip', () => {
  it('survives a reload: state written is state read back', async () => {
    const store = new AnswerStore(emptyState('attempt-reload'), saveState, 0);
    store.setAnswer('q1', 'C');
    store.setAnswer('q61', 'a long derivation');
    store.recordKeystrokes('q61', 120);
    await store.flush();

    // A new AnswerStore, as a reloaded page would build.
    const restored = await loadState('attempt-reload');
    expect(restored).toBeDefined();
    expect(restored!.answers).toEqual({ q1: 'C', q61: 'a long derivation' });
    expect(restored!.revision).toBe(2);
    expect(restored!.telemetry.q61!.keystrokes).toBe(120);
  });

  it('keeps the revision across a reload, so the first sync is not ignored', async () => {
    const first = new AnswerStore(emptyState('attempt-rev'), saveState, 0);
    for (let i = 0; i < 7; i += 1) first.setAnswer('q1', `v${i}`);
    await first.flush();

    const restored = await loadState('attempt-rev');
    const second = new AnswerStore(restored!, saveState, 0);
    second.setAnswer('q1', 'next');

    // A reset counter would make the server's `revision <` guard drop this.
    expect(second.get().revision).toBe(8);
  });
});
