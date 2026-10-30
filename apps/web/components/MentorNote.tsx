'use client';

import { useState } from 'react';
import { youtubeId } from '../lib/youtube';

/**
 * The note from a mentor: one YouTube video, framed so a student actually
 * presses play.
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  PASTE THE YOUTUBE LINK HERE. Any of these forms work:
 *    'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
 *    'https://youtu.be/dQw4w9WgXcQ'
 *    'dQw4w9WgXcQ'
 *  Left empty, the section still renders and the frame says the link is
 *  missing, so an unfinished page is obvious rather than silently broken.
 * ────────────────────────────────────────────────────────────────────────────
 */
const VIDEO_LINK = '';

/** What the embed is called for anyone using a screen reader. */
const VIDEO_TITLE = 'A note from your IITian mentor';

/**
 * The hand-drawn arrow that points from "please listen to this" down at the
 * play button. Inline SVG so it takes its colour from CSS, and deliberately
 * wobbly — it is the one mark on the page that looks like a person drew it.
 */
function NudgeArrow() {
  return (
    <svg className="note__arrow" viewBox="0 0 90 74" fill="none" aria-hidden="true">
      <path
        d="M8 5c13 3 24 11 29 23 5 12 3 24-3 33 9-5 17-13 21-23 4-10 4-21 1-31"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      <path
        d="M27 51 34 61 46 59"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function MentorNote() {
  const id = youtubeId(VIDEO_LINK);
  const [playing, setPlaying] = useState(false);
  /* maxresdefault does not exist for every upload; hqdefault always does. */
  const [thumb, setThumb] = useState('maxresdefault');

  return (
    <div className="note">
      <p className="note__nudge">
        <NudgeArrow />
        <span>
          <b>Please listen to this.</b>
          It is the one thing on this page we would ask you not to skip.
        </span>
      </p>

      {playing && id ? (
        <iframe
          className="note__frame"
          /* nocookie, and autoplay only because the student just clicked. */
          src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1`}
          title={VIDEO_TITLE}
          allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      ) : (
        /*
         * Until it is clicked this is a picture and a button, not an embed —
         * so the landing page loads none of YouTube's JavaScript and sets
         * none of its cookies for a student who never presses play.
         */
        <button
          type="button"
          className="note__poster"
          onClick={() => id && setPlaying(true)}
          disabled={!id}
          aria-label={id ? `Play: ${VIDEO_TITLE}` : 'Video link not added yet'}
        >
          {id ? (
            <>
              <img
                className="note__thumb"
                src={`https://i.ytimg.com/vi/${id}/${thumb}.jpg`}
                onError={() => setThumb('hqdefault')}
                alt=""
                aria-hidden="true"
              />
              <span className="note__play" aria-hidden="true">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M8 5.2v13.6L19.5 12 8 5.2Z" fill="currentColor" />
                </svg>
              </span>
            </>
          ) : (
            <span className="note__missing">
              Paste the YouTube link in <code>components/MentorNote.tsx</code>
            </span>
          )}
        </button>
      )}
    </div>
  );
}
