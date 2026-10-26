import {
  KeyResponseSchema,
  RegisterResponseSchema,
  SubmitResponseSchema,
  SyncResponseSchema,
  TestStatusResponseSchema,
  type SubmitRequest,
  type SyncRequest,
} from '@jee/shared';

/**
 * The API client. Every response is parsed through the shared schema, so a
 * server change that breaks the contract shows up here as a clear error rather
 * than as undefined propagating into the exam UI.
 */

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    // The session is a cookie, so every call is credentialed.
    credentials: 'include',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const error = body as { error?: string; message?: string };
    throw new ApiError(
      response.status,
      error.error ?? 'unknown',
      error.message ?? `Request failed (${response.status}).`,
    );
  }
  return body;
}

export async function fetchStatus() {
  return TestStatusResponseSchema.parse(await call('/test/status'));
}

export async function fetchServerTime(): Promise<number> {
  const body = (await call('/test/time')) as { serverTime: number };
  return body.serverTime;
}

export async function registerAttempt() {
  return RegisterResponseSchema.parse(
    await call('/attempt/register', { method: 'POST', body: '{}' }),
  );
}

export async function fetchPaperKey() {
  return KeyResponseSchema.parse(await call('/attempt/key'));
}

export async function syncAttempt(payload: SyncRequest) {
  return SyncResponseSchema.parse(
    await call('/attempt/sync', { method: 'POST', body: JSON.stringify(payload) }),
  );
}

export async function submitAttempt(payload: SubmitRequest) {
  return SubmitResponseSchema.parse(
    await call('/attempt/submit', { method: 'POST', body: JSON.stringify(payload) }),
  );
}

/** Last synced state, for a student who had to move to another machine. */
export async function fetchState() {
  return (await call('/attempt/state')) as {
    id: string;
    revision: number;
    status: string;
    answers: Record<string, string>;
    submittedAt: string | null;
    receipt: string | null;
    serverTime: number;
    endsAt: number;
  };
}

/**
 * The encrypted paper comes from the CDN, not the API — it is byte-identical
 * for all 10,000 students, so the origin must never serve it 10,000 times.
 */
export async function downloadPaper(paperUrl: string): Promise<unknown> {
  const response = await fetch(paperUrl, { credentials: 'omit', cache: 'force-cache' });
  if (!response.ok) throw new Error(`Paper download failed (${response.status}).`);
  return response.json();
}
