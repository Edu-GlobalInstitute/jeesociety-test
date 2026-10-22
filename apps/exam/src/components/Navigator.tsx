import type { Paper } from '@jee/shared';
import { groupBySubject } from '../lib/paper.js';

/**
 * The OMR sheet: every question at once, status readable at arm's length.
 *
 * Status is encoded by shape as well as colour — filled for answered, a dot
 * for seen-but-blank, a folded corner for marked — so it reads in grayscale
 * and to a colour-blind student.
 */

export interface NavigatorProps {
  paper: Paper;
  answers: Record<string, string>;
  seen: Set<string>;
  markedForReview: string[];
  currentId: string;
  onSelect: (questionId: string) => void;
}

function cellClass(params: {
  answered: boolean;
  seen: boolean;
  marked: boolean;
  current: boolean;
}): string {
  return [
    'cell',
    params.answered ? 'cell--answered' : params.seen ? 'cell--seen' : '',
    params.marked ? 'cell--review' : '',
    params.current ? 'cell--current' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function Navigator({
  paper,
  answers,
  seen,
  markedForReview,
  currentId,
  onSelect,
}: NavigatorProps) {
  const sections = groupBySubject(paper);
  const marked = new Set(markedForReview);
  const numberOf = new Map(paper.questions.map((question, index) => [question.id, index + 1]));

  return (
    <nav className="navigator" aria-label="Questions">
      {sections.map(({ subject, questions }) => {
        const answered = questions.filter((q) => (answers[q.id] ?? '').trim().length > 0).length;
        return (
          <section className="navigator__section" key={subject}>
            <h2 className="navigator__subject">
              <span>{subject}</span>
              <span className="navigator__count tnum">
                {answered}/{questions.length}
              </span>
            </h2>
            <div className="navigator__grid">
              {questions.map((question) => {
                const isAnswered = (answers[question.id] ?? '').trim().length > 0;
                return (
                  <button
                    type="button"
                    key={question.id}
                    className={cellClass({
                      answered: isAnswered,
                      seen: seen.has(question.id),
                      marked: marked.has(question.id),
                      current: question.id === currentId,
                    })}
                    onClick={() => onSelect(question.id)}
                    aria-current={question.id === currentId ? 'true' : undefined}
                    aria-label={`Question ${numberOf.get(question.id)}, ${
                      isAnswered ? 'answered' : 'not answered'
                    }${marked.has(question.id) ? ', marked for review' : ''}`}
                  >
                    <span className="tnum">{numberOf.get(question.id)}</span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}

      <div className="legend">
        <div className="legend__row">
          <span
            className="legend__swatch"
            style={{ background: 'var(--answered)', borderColor: 'var(--answered)' }}
          />
          Answered
        </div>
        <div className="legend__row">
          <span className="legend__swatch cell--seen" />
          Seen, not answered
        </div>
        <div className="legend__row">
          <span className="legend__swatch cell--review" />
          Marked to come back to
        </div>
      </div>
    </nav>
  );
}
