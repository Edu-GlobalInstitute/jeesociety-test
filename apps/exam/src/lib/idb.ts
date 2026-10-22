import type { AnswerMap, EncryptedPaper, TelemetryMap } from '@jee/shared';

/**
 * The student's local safety net.
 *
 * Every change is written here immediately (debounced 300 ms). If the browser
 * crashes or the student reloads, this is what brings their work back — the
 * server sync is 90 seconds behind by design, and the gap between the two is
 * exactly what this file closes.
 *
 * Written against raw IndexedDB rather than a wrapper library: this is the one
 * piece of client code whose failure loses a student's work, and it is small
 * enough to read in full.
 */

const DB_NAME = 'jee-exam';
const DB_VERSION = 1;
const STATE_STORE = 'state';
const PAPER_STORE = 'paper';

export interface LocalState {
  attemptId: string;
  answers: AnswerMap;
  telemetry: TelemetryMap;
  /** Monotonic. Bumped on every change, carried on every sync. */
  revision: number;
  /** Highest revision the server has acknowledged. */
  syncedRevision: number;
  lastSavedAt: number;
  lastSyncedAt: number | null;
  /** Questions the student marked to come back to. Local only. */
  markedForReview: string[];
  submittedAt: number | null;
  receipt: string | null;
}

export function emptyState(attemptId: string): LocalState {
  return {
    attemptId,
    answers: {},
    telemetry: {},
    revision: 0,
    syncedRevision: 0,
    lastSavedAt: 0,
    lastSyncedAt: null,
    markedForReview: [],
    submittedAt: null,
    receipt: null,
  };
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STATE_STORE)) db.createObjectStore(STATE_STORE);
      if (!db.objectStoreNames.contains(PAPER_STORE)) db.createObjectStore(PAPER_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
  });
}

function run<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = fn(transaction.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'));
        transaction.oncomplete = () => db.close();
      }),
  );
}

export function loadState(attemptId: string): Promise<LocalState | undefined> {
  return run<LocalState | undefined>(STATE_STORE, 'readonly', (store) =>
    store.get(attemptId),
  );
}

export function saveState(state: LocalState): Promise<unknown> {
  return run(STATE_STORE, 'readwrite', (store) => store.put(state, state.attemptId));
}

export function savePaper(testId: number, blob: EncryptedPaper): Promise<unknown> {
  return run(PAPER_STORE, 'readwrite', (store) => store.put(blob, `paper-${testId}`));
}

export function loadPaper(testId: number): Promise<EncryptedPaper | undefined> {
  return run<EncryptedPaper | undefined>(PAPER_STORE, 'readonly', (store) =>
    store.get(`paper-${testId}`),
  );
}

/**
 * The lobby's first environment check. A student whose browser blocks storage
 * — private mode on some browsers, a locked-down school machine — needs to
 * find out now, while there is still time to switch machines, not at minute 40.
 */
export async function checkIndexedDbWritable(): Promise<{ ok: boolean; detail?: string }> {
  try {
    const probe = `__probe_${Date.now()}`;
    await run(STATE_STORE, 'readwrite', (store) => store.put({ probe: true }, probe));
    const read = await run<unknown>(STATE_STORE, 'readonly', (store) => store.get(probe));
    await run(STATE_STORE, 'readwrite', (store) => store.delete(probe));
    if (!read) return { ok: false, detail: 'Storage accepted a write but read back nothing.' };
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export function checkLocalStorage(): { ok: boolean; detail?: string } {
  try {
    const key = `__probe_${Date.now()}`;
    localStorage.setItem(key, '1');
    const value = localStorage.getItem(key);
    localStorage.removeItem(key);
    return value === '1' ? { ok: true } : { ok: false, detail: 'Read back the wrong value.' };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
