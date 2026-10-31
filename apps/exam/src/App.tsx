import { useCallback, useEffect, useRef, useState } from 'react';
import type { Paper, TestStatusResponse } from '@jee/shared';
import { createClock, type ClockSample, type ServerClock } from './lib/clock.js';
import { ApiError, fetchPaperKey, fetchState, fetchStatus, submitAttempt } from './lib/api.js';
import { AnswerStore } from './lib/store.js';
import { emptyState, loadState } from './lib/idb.js';
import { openPaper } from './lib/paper.js';
import { submitDelayMs, submitWithBackoff } from './lib/sync.js';
import { ComingSoon } from './screens/ComingSoon.js';
import { Lobby } from './screens/Lobby.js';
import { Exam } from './screens/Exam.js';
import { SubmitPending, Submitted, Submitting } from './screens/Submitting.js';

/**
 * The state machine for a student's session.
 *
 *   loading → locked → waiting → lobby → starting → exam → submitting → submitted
 *                                                                     ↘ pending
 *
 * The transition that matters is `starting`: at `startsAt` the client asks for
 * the decryption key, decrypts the paper it already downloaded in the lobby,
 * and renders. The origin serves a ~200 byte response, not 1.5 MB.
 *
 * `locked` is the phase before any of that: the test is on sale but its
 * `tests.status` is still `scheduled`, so the paper is not open to anyone. The
 * API refuses register, key and sync in that state, and this phase is what the
 * student sees instead of a 403.
 */

type Phase =
  | { name: 'loading' }
  | { name: 'error'; message: string }
  | { name: 'signed-out' }
  | { name: 'locked'; status: TestStatusResponse }
  | { name: 'waiting'; status: TestStatusResponse }
  | { name: 'lobby'; status: TestStatusResponse }
  | { name: 'starting'; status: TestStatusResponse }
  | { name: 'exam'; status: TestStatusResponse; paper: Paper }
  | { name: 'submitting'; attempt: number; jitterSeconds: number }
  | { name: 'submitted'; receipt: string }
  | { name: 'pending' };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Where a student who is not signed in is sent. The public site owns auth. */
const WEB_URL = import.meta.env.VITE_WEB_URL ?? 'http://localhost:3001';

/**
 * Which phase a status response puts the student in. Shared by boot and by the
 * poll on the locked screen, so going live is picked up by a tab that has been
 * sitting open without the two paths being able to disagree.
 */
function phaseFor(status: TestStatusResponse, now: number): Phase {
  if (status.attempt?.submittedAt && status.attempt.receipt) {
    // Checked before the lock: a student who has already sat the test must
    // keep seeing their receipt after the row moves on from `live`.
    return { name: 'submitted', receipt: status.attempt.receipt };
  }
  if (!status.examOpen) return { name: 'locked', status };
  if (now < status.lobbyOpensAt) return { name: 'waiting', status };
  if (now < status.startsAt) return { name: 'lobby', status };
  if (status.attempt) return { name: 'starting', status };
  return { name: 'waiting', status };
}

async function sampleClock(): Promise<ServerClock> {
  const samples: ClockSample[] = [];
  for (let i = 0; i < 3; i += 1) {
    const requestedAt = Date.now();
    const status = await fetchStatus();
    samples.push({ serverTime: status.serverTime, requestedAt, receivedAt: Date.now() });
  }
  return createClock(samples);
}

export function App() {
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  const [clock, setClock] = useState<ServerClock | null>(null);
  const storeRef = useRef<AnswerStore | null>(null);
  const paperRef = useRef<Paper | null>(null);
  const submittingRef = useRef(false);

  /* -------------------------------------------------------------- boot -- */
  useEffect(() => {
    let cancelled = false;

    async function boot(): Promise<void> {
      try {
        const serverClock = await sampleClock();
        const status = await fetchStatus();
        if (cancelled) return;
        setClock(serverClock);
        setPhase(phaseFor(status, serverClock.now()));
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          // Not signed in. Students reach this URL during the weeks before the
          // paper opens, and an error screen would read as a fault in the test
          // rather than as "you are not signed in yet".
          setPhase({ name: 'signed-out' });
          return;
        }
        setPhase({
          name: 'error',
          message:
            error instanceof ApiError
              ? error.message
              : 'We could not reach the test server. Check your connection and reload.',
        });
      }
    }

    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ------------------------------------------------ locked → waiting --- */
  /**
   * A student may leave this tab open for weeks, so the locked screen re-reads
   * its status every minute rather than waiting for a reload. The cost is one
   * ~300 byte request per minute per idle tab, and this is the period when
   * there is no other traffic at all.
   */
  useEffect(() => {
    if (phase.name !== 'locked' || !clock) return;
    const timer = setInterval(() => {
      void fetchStatus()
        .then((next) => {
          if (next.examOpen) setPhase(phaseFor(next, clock.now()));
        })
        .catch(() => {
          // Nothing to tell the student: the screen they are on is correct
          // either way, and it will ask again in a minute.
        });
    }, 60_000);
    return () => clearInterval(timer);
  }, [phase.name, clock]);

  /* ------------------------------------------------- waiting → lobby --- */
  useEffect(() => {
    if (phase.name !== 'waiting' || !clock) return;
    const timer = setInterval(() => {
      const now = clock.now();
      if (now >= phase.status.lobbyOpensAt && now < phase.status.startsAt) {
        setPhase({ name: 'lobby', status: phase.status });
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [phase, clock]);

  /* ------------------------------------------------------ the start ----- */
  useEffect(() => {
    if (phase.name !== 'starting' || !clock) return;
    let cancelled = false;

    async function start(): Promise<void> {
      if (phase.name !== 'starting') return;
      try {
        const key = await fetchPaperKey();
        if (cancelled) return;

        const paper = await openPaper(phase.status.testId, phase.status.paperUrl!, key.key);
        if (cancelled) return;
        paperRef.current = paper;

        // Local state wins over the server's: it is always at least as fresh.
        // The server copy is only used when this device has none, which means
        // the student is on a replacement machine.
        const local = await loadState(key.attemptId);
        if (local) {
          storeRef.current = new AnswerStore(local);
        } else {
          const store = new AnswerStore(emptyState(key.attemptId));
          try {
            const server = await fetchState();
            if (server.revision > 0) {
              store.adoptServerState({
                answers: server.answers,
                revision: server.revision,
              });
            }
          } catch {
            // No server state either. A fresh start is the correct outcome.
          }
          storeRef.current = store;
        }

        setPhase({ name: 'exam', status: phase.status, paper });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.code === 'not_started') {
          // The client's clock ran ahead. Wait a second and ask again.
          await sleep(1_000);
          if (!cancelled) setPhase({ ...phase });
          return;
        }
        setPhase({
          name: 'error',
          message:
            error instanceof ApiError
              ? error.message
              : 'We could not open the paper. Reload this page — your answers are safe.',
        });
      }
    }

    void start();
    return () => {
      cancelled = true;
    };
  }, [phase, clock]);

  /* ---------------------------------------------------------- submit ---- */
  const runSubmit = useCallback(async () => {
    const store = storeRef.current;
    const paper = paperRef.current;
    if (!store || !paper || submittingRef.current) return;
    submittingRef.current = true;

    // Jitter: 10,000 clients submitting at the instant the timer hits zero
    // would be one spike. Spread across 45 seconds it is ordinary traffic.
    const delay = submitDelayMs();
    setPhase({ name: 'submitting', attempt: 1, jitterSeconds: Math.ceil(delay / 1000) });

    await store.flush();
    await sleep(delay);

    const result = await submitWithBackoff({
      send: async () => {
        const snapshot = store.snapshot();
        const response = await submitAttempt(snapshot);
        return { receipt: response.receipt, alreadySubmitted: response.alreadySubmitted };
      },
      onAttempt: (attempt) =>
        setPhase({ name: 'submitting', attempt, jitterSeconds: Math.ceil(delay / 1000) }),
      sleep,
    });

    if (result) {
      store.markSubmitted(result.receipt, Date.now());
      setPhase({ name: 'submitted', receipt: result.receipt });
    } else {
      // Every attempt failed. This is genuinely fine: auto-submit finalises the
      // attempt from the last sync, so the student has lost nothing.
      setPhase({ name: 'pending' });
    }
  }, []);

  /* ---------------------------------------------------------- render ---- */
  switch (phase.name) {
    case 'loading':
      return (
        <main className="page">
          <p className="muted">Loading your test…</p>
        </main>
      );

    case 'signed-out':
      return (
        <main className="page">
          <img className="page__logo" src="/logo.jpeg" alt="JEEsociety" width={44} height={44} />
          <h1 className="page__title">Sign in to reach your test</h1>
          <p className="page__lede">
            This is the page you sit the paper on. Sign in with the email you registered with,
            and come back here on the day.
          </p>
          <a className="btn btn--primary" href={`${WEB_URL}/register`}>
            Sign in on the main site
          </a>
        </main>
      );

    case 'error':
      return (
        <main className="page">
          <h1 className="page__title">We could not load your test</h1>
          <div className="notice">{phase.message}</div>
          <button type="button" className="btn btn--primary" onClick={() => location.reload()}>
            Try again
          </button>
        </main>
      );

    case 'locked':
      return <ComingSoon status={phase.status} />;

    case 'waiting':
      return (
        <main className="page">
          <h1 className="page__title">{phase.status.name}</h1>
          <p className="page__lede">
            The waiting room opens 30 minutes before the test. Come back then — this page will
            let you in automatically.
          </p>
          <section className="panel">
            <h2 className="panel__title">Opens</h2>
            <p className="muted" style={{ margin: 0 }}>
              {new Date(phase.status.lobbyOpensAt).toLocaleString()}
            </p>
          </section>
          {!phase.status.paid ? (
            <div className="notice" style={{ marginTop: 16 }}>
              We have not received your payment for this test. Complete it before the waiting room
              opens, or you will not be able to enter.
            </div>
          ) : null}
        </main>
      );

    case 'lobby':
      return (
        <Lobby
          status={phase.status}
          clock={clock!}
          onReady={() => setPhase({ name: 'starting', status: phase.status })}
        />
      );

    case 'starting':
      return (
        <main className="page">
          <h1 className="page__title">Opening your paper</h1>
          <p className="page__lede">This takes a moment. Do not reload.</p>
        </main>
      );

    case 'exam':
      return (
        <Exam
          paper={phase.paper}
          store={storeRef.current!}
          clock={clock!}
          endsAt={phase.status.endsAt}
          onTimeUp={() => void runSubmit()}
          onSubmit={() => void runSubmit()}
        />
      );

    case 'submitting':
      return <Submitting attemptNumber={phase.attempt} jitterSeconds={phase.jitterSeconds} />;

    case 'submitted':
      return (
        <Submitted
          receipt={phase.receipt}
          answered={storeRef.current?.answeredCount() ?? 0}
          total={paperRef.current?.questions.length ?? 75}
        />
      );

    case 'pending':
      return (
        <SubmitPending
          answered={storeRef.current?.answeredCount() ?? 0}
          total={paperRef.current?.questions.length ?? 75}
        />
      );
  }
}
