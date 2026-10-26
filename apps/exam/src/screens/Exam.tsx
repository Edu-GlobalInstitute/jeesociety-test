import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CLIENT_TIMING, type Paper } from '@jee/shared';
import { countdown, formatCountdown, type ServerClock } from '../lib/clock.js';
import { SaveIndicator } from '../components/SaveIndicator.js';
import { Navigator } from '../components/Navigator.js';
import { QuestionView } from '../components/QuestionView.js';
import { startSyncLoop, syncOnce } from '../lib/sync.js';
import { syncAttempt } from '../lib/api.js';
import type { AnswerStore } from '../lib/store.js';

/**
 * The test itself. Three hours of a student's life run through this component.
 *
 * It owns three loops: a one-second tick for the clock, the 90-second sync, and
 * the debounced IndexedDB write inside AnswerStore. Nothing here blocks on the
 * network — every interaction writes locally first and the network catches up.
 */

export interface ExamProps {
  paper: Paper;
  store: AnswerStore;
  clock: ServerClock;
  endsAt: number;
  onTimeUp: () => void;
  onSubmit: () => void;
}

export function Exam({ paper, store, clock, endsAt, onTimeUp, onSubmit }: ExamProps) {
  const [state, setState] = useState(() => store.get());
  const [now, setNow] = useState(() => clock.now());
  const [currentId, setCurrentId] = useState(() => paper.questions[0]?.id ?? '');
  const [seen, setSeen] = useState<Set<string>>(() => new Set([paper.questions[0]?.id ?? '']));
  const timeUpFired = useRef(false);

  useEffect(() => store.subscribe(setState), [store]);

  useEffect(() => {
    const timer = setInterval(() => setNow(clock.now()), 1000);
    return () => clearInterval(timer);
  }, [clock]);

  // The 90-second sync. Full state every time — never a diff, because a
  // dropped patch would corrupt server state silently and permanently.
  useEffect(() => {
    const deps = {
      getSnapshot: () => store.snapshot(),
      getSyncedRevision: () => store.get().syncedRevision,
      send: (payload: ReturnType<AnswerStore['snapshot']>) => syncAttempt(payload),
      onResult: (outcome: { status: string; revision?: number }, at: number) => {
        if (outcome.status === 'sent' && outcome.revision !== undefined) {
          store.markSynced(outcome.revision, at);
        }
      },
      now: () => Date.now(),
    };
    // One sync on entry, so the server knows the student has started even if
    // they then read for ten minutes without touching anything.
    void syncOnce(deps);
    return startSyncLoop(deps);
  }, [store]);

  const remaining = countdown(endsAt, now);

  useEffect(() => {
    if (remaining.expired && !timeUpFired.current) {
      timeUpFired.current = true;
      onTimeUp();
    }
  }, [remaining.expired, onTimeUp]);

  const index = useMemo(
    () => paper.questions.findIndex((question) => question.id === currentId),
    [paper.questions, currentId],
  );
  const question = paper.questions[index];

  const goTo = useCallback(
    (questionId: string) => {
      setCurrentId(questionId);
      setSeen((current) => new Set(current).add(questionId));
    },
    [],
  );

  // Flush pending local writes if the tab is closing. Best effort: the sync
  // loop and auto-submit are what actually guarantee nothing is lost.
  useEffect(() => {
    const onHide = () => void store.flush();
    window.addEventListener('pagehide', onHide);
    window.addEventListener('beforeunload', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('beforeunload', onHide);
    };
  }, [store]);

  if (!question) return null;

  const answered = store.answeredCount();
  const lastTenMinutes = remaining.totalMs <= 10 * 60_000;

  return (
    <div className="shell">
      <header className="topbar">
        <span className="topbar__name">{paper.name}</span>
        <div className="topbar__meta">
          <SaveIndicator lastSyncedAt={state.lastSyncedAt} now={Date.now()} />
          <span className="tnum">
            {answered}/{paper.questions.length} answered
          </span>
          <button type="button" className="btn btn--primary" onClick={onSubmit}>
            Submit test
          </button>
          <span
            className={`timer tnum${lastTenMinutes ? ' timer--soon' : ''}`}
            role="timer"
            aria-live="off"
          >
            <span className="timer__label">Time remaining</span>
            {formatCountdown(remaining)}
          </span>
        </div>
      </header>

      <div className="workspace">
        <div className="question-pane">
          <QuestionView
            question={question}
            number={index + 1}
            value={state.answers[question.id] ?? ''}
            marked={state.markedForReview.includes(question.id)}
            onChange={(value) => store.setAnswer(question.id, value)}
            onToggleReview={() => store.toggleReview(question.id)}
            onClear={() => store.clearAnswer(question.id)}
            onPrev={() => goTo(paper.questions[index - 1]!.id)}
            onNext={() => goTo(paper.questions[index + 1]!.id)}
            hasPrev={index > 0}
            hasNext={index < paper.questions.length - 1}
          />
        </div>

        <Navigator
          paper={paper}
          answers={state.answers}
          seen={seen}
          markedForReview={state.markedForReview}
          currentId={currentId}
          onSelect={goTo}
        />
      </div>
    </div>
  );
}

export const syncIntervalMs = CLIENT_TIMING.syncIntervalMs;
