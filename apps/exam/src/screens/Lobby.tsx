import { useEffect, useState } from 'react';
import type { TestStatusResponse } from '@jee/shared';
import { countdown, formatCountdown, type ServerClock } from '../lib/clock.js';
import { checkIndexedDbWritable, checkLocalStorage } from '../lib/idb.js';
import { ensurePaperDownloaded } from '../lib/paper.js';
import { ApiError, registerAttempt, syncAttempt } from '../lib/api.js';

/**
 * The lobby. It exists to find problems while there is still time to fix them,
 * and to spread 10,000 arrivals across 30 minutes instead of one instant.
 *
 * Four things happen here, in this order:
 *   1. register — this is what admits the student; it closes at starts_at
 *   2. environment checks, including a real sync round trip
 *   3. the encrypted paper downloads in the background
 *   4. a countdown driven by server time
 */

type CheckState = 'pending' | 'ok' | 'bad';

interface Check {
  id: string;
  label: string;
  state: CheckState;
  detail?: string;
}

export interface LobbyProps {
  status: TestStatusResponse;
  clock: ServerClock;
  onReady: (attemptId: string) => void;
}

export function Lobby({ status, clock, onReady }: LobbyProps) {
  const [now, setNow] = useState(() => clock.now());
  const [attemptId, setAttemptId] = useState<string | null>(status.attempt?.id ?? null);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Check[]>([
    { id: 'storage', label: 'Your browser can save your answers', state: 'pending' },
    { id: 'local', label: 'Your browser can remember your place', state: 'pending' },
    { id: 'sync', label: 'Your answers can reach our servers', state: 'pending' },
    { id: 'paper', label: 'The question paper is on this device', state: 'pending' },
  ]);

  useEffect(() => {
    const timer = setInterval(() => setNow(clock.now()), 1000);
    return () => clearInterval(timer);
  }, [clock]);

  const set = (id: string, state: CheckState, detail?: string) =>
    setChecks((current) =>
      current.map((check) => (check.id === id ? { ...check, state, detail } : check)),
    );

  // Registration runs on arrival. Everything else depends on it, because the
  // sync round trip needs an attempt to write to.
  useEffect(() => {
    let cancelled = false;

    async function run(): Promise<void> {
      let id = attemptId;
      if (!id) {
        try {
          const registered = await registerAttempt();
          if (cancelled) return;
          id = registered.attemptId;
          setAttemptId(id);
        } catch (error) {
          if (cancelled) return;
          setRegisterError(
            error instanceof ApiError
              ? error.message
              : 'We could not sign you in to the test. Check your connection and reload.',
          );
          return;
        }
      }

      const storage = await checkIndexedDbWritable();
      if (cancelled) return;
      set('storage', storage.ok ? 'ok' : 'bad', storage.detail);

      const local = checkLocalStorage();
      set('local', local.ok ? 'ok' : 'bad', local.detail);

      // A real sync, not a ping: a check that exercises a different code path
      // from the real thing is not a check. Revision 1 with no answers.
      try {
        await syncAttempt({ attemptId: id, revision: 1, answers: {} });
        if (cancelled) return;
        set('sync', 'ok');
      } catch (error) {
        if (cancelled) return;
        set('sync', 'bad', error instanceof Error ? error.message : String(error));
      }

      if (status.paperUrl) {
        try {
          await ensurePaperDownloaded(status.testId, status.paperUrl);
          if (cancelled) return;
          set('paper', 'ok');
        } catch (error) {
          if (cancelled) return;
          set('paper', 'bad', error instanceof Error ? error.message : String(error));
        }
      } else {
        set('paper', 'bad', 'The paper is not published yet. Tell an invigilator.');
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toStart = countdown(status.startsAt, now);
  const allChecksDone = checks.every((check) => check.state !== 'pending');
  const anyBad = checks.some((check) => check.state === 'bad');

  // The moment the clock reaches zero, hand over to the exam screen. A student
  // whose checks failed still gets in — the checks are advice, not a gate.
  useEffect(() => {
    if (toStart.expired && attemptId) onReady(attemptId);
  }, [toStart.expired, attemptId, onReady]);

  return (
    <main className="page">
      <img className="page__logo" src="/logo.jpeg" alt="JEE Society" width={44} height={44} />
      <h1 className="page__title">{status.name}</h1>
      <p className="page__lede">
        Stay on this page. The test opens automatically when the countdown reaches zero — you do
        not need to refresh.
      </p>

      {registerError ? <div className="notice">{registerError}</div> : null}

      <section className="panel" aria-live="polite">
        <h2 className="panel__title">Starts in</h2>
        <p className="countdown-large tnum">{formatCountdown(toStart)}</p>
        <p className="muted">
          {new Date(status.startsAt).toLocaleString()} · 3 hours · {75} questions
        </p>
      </section>

      <section className="panel">
        <h2 className="panel__title">Checks on this device</h2>
        <ul className="checklist">
          {checks.map((check) => (
            <li
              key={check.id}
              className={`check${
                check.state === 'ok' ? ' check--ok' : check.state === 'bad' ? ' check--bad' : ''
              }`}
            >
              <span className="check__mark" aria-hidden="true">
                {check.state === 'ok' ? '✓' : check.state === 'bad' ? '!' : ''}
              </span>
              <span>
                {check.label}
                {check.detail ? <span className="check__detail">{check.detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>

        {allChecksDone && anyBad ? (
          <p className="muted" style={{ marginTop: 16 }}>
            Something on this device did not check out. You can still sit the test, but switch to
            another browser or machine now if you can — and tell an invigilator either way.
          </p>
        ) : null}
      </section>

      <section className="panel">
        <h2 className="panel__title">Before you start</h2>
        <ul className="checklist">
          <li className="check">
            <span className="check__mark" aria-hidden="true" />
            <span>
              Your answers save to this device as you type, and to our servers every 90 seconds.
            </span>
          </li>
          <li className="check">
            <span className="check__mark" aria-hidden="true" />
            <span>
              If your connection drops, keep working. Your answers are kept here and sent when it
              returns.
            </span>
          </li>
          <li className="check">
            <span className="check__mark" aria-hidden="true" />
            <span>
              If this device fails entirely, sign in on another one — your last saved answers will
              be there.
            </span>
          </li>
        </ul>
      </section>
    </main>
  );
}
