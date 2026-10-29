import { MENTORSHIP } from '@jee/shared/config';
import { SPARKLE_PATH } from './PosterMarks';

/**
 * The reward, acted out: a bhaiya at the board teaching his chhote bhai.
 *
 * The scene is the whole offer in one picture — somebody who has already got
 * into IIT Bombay, standing at a board, solving the question the younger
 * student is stuck on. It loops: the chalk writes itself, the question mark
 * over the boy turns into a bulb, and he throws both arms up.
 *
 * Built the same way as components/RescueLadder, for the same reasons:
 *
 *  - **Stacked SVG layers** over one stage, every layer sharing the viewBox and
 *    sized to the box, so a percentage translate on a layer is a percentage of
 *    the same square at every width. No pixel values anywhere.
 *  - **Placement inside a layer uses SVG's own `transform` attribute**, and CSS
 *    here animates `opacity` and `stroke-dashoffset`, which have no origin to
 *    get wrong. The one element that scales — the bulb popping on — is nested
 *    inside the group that places it, because a CSS `transform` on an SVG
 *    element replaces its `transform` attribute instead of composing with it,
 *    and a single group doing both would snap to the viewBox origin.
 *  - **Poses are crossfades, not motion.** Each figure is drawn twice — the
 *    bhaiya resting and pointing, the boy writing and cheering — and the pair
 *    swap opacity on the frame the beat lands. Moving a limb along a path is
 *    not something CSS can do to an SVG child reliably; drawing it twice is.
 *  - **The chalk draws itself** with `pathLength="1"`, so every stroke dashes
 *    from 1 to 0 over the same normalised length no matter how long the real
 *    path is. Restyling a stroke cannot desynchronise the handwriting.
 *  - Every layer's animation is the same 14 s, with phases written as
 *    percentages of it in app/landing.css, so nothing can drift apart.
 *
 * The caption reads the programme's real length out of @jee/shared/config, so
 * the picture cannot advertise a longer seat than the reward policy gives.
 */

/** Where the figures stand, and where the floor is. */
const FLOOR = 318;
const BHAIYA_X = 80;
const BOY_X = 262;

/**
 * The chalk on the board, in the order a hand would write it.
 *
 * `d` is the stroke; `at` is how far into the writing phase it starts, as a
 * fraction, so the strokes arrive in sequence rather than all at once. The
 * tick is last and is the only one in teal — it is the moment the boy gets it.
 */
const CHALK = [
  { d: 'M 180 96 C 184 78 175 60 184 49 C 191 42 199 48 194 59', at: 0 },
  { d: 'M 206 62 L 222 86', at: 0.14 },
  { d: 'M 222 62 L 206 86', at: 0.2 },
  { d: 'M 234 70 L 256 70', at: 0.3 },
  { d: 'M 234 79 L 256 79', at: 0.36 },
  { d: 'M 268 59 C 277 52 285 63 274 73 C 268 79 280 83 286 76', at: 0.44 },
  { d: 'M 186 142 L 306 142', at: 0.56 },
  { d: 'M 194 106 L 194 148', at: 0.62 },
  { d: 'M 202 137 C 220 99 256 99 274 137', at: 0.7 },
] as const;

/** The tick, drawn after the working — its own stroke so it can be teal. */
const TICK = 'M 318 112 L 332 128 L 360 86';

/** Sparkles around the bulb, once the boy has it. */
const SPARKS = [
  { x: 272, y: 168, size: 17, delay: '0s' },
  { x: 334, y: 182, size: 13, delay: '0.45s' },
  { x: 288, y: 214, size: 10, delay: '0.9s' },
] as const;

/**
 * The bhaiya: taller, at the board, with an IIT Bombay lanyard.
 *
 * `pose` is the only difference between his two appearances — arms down, and
 * the right arm up at the board.
 */
function Bhaiya({ pose }: { pose: 'rest' | 'teach' }) {
  const arms = pose === 'teach' ? 'M -14 -31 L 0 -36 L 21 -57' : 'M -14 -30 L 0 -36 L 14 -30';

  return (
    <g>
      <path className="mentor__limb" d="M -9 0 L 0 -18 L 9 0" />
      <path className="mentor__limb" d="M 0 -18 L 0 -44" />
      <path className="mentor__limb" d={arms} />
      {/* The card hangs at belly height, below the arms. Sitting it at chest
          height put it straight over both hands, which left him armless for
          the two thirds of the loop he is not pointing. The lanyard is drawn
          first so the card covers where the cord ends. */}
      <path className="mentor__cord" d="M -5 -42 L 0 -26 L 5 -42" />
      <rect className="mentor__tagCard" x="-11" y="-26" width="22" height="10" rx="2.5" />
      <text className="mentor__tag" x="0" y="-18.5">
        IIT B
      </text>
      <circle className="mentor__head" cx="0" cy="-54" r="10" />
    </g>
  );
}

/**
 * The chhote bhai: smaller, sitting cross-legged with a notebook on his lap.
 *
 * `pose` swaps him from writing to both arms up.
 */
function ChhoteBhai({ pose }: { pose: 'write' | 'cheer' }) {
  const arms = pose === 'cheer' ? 'M -16 -44 L 0 -30 L 16 -44' : 'M -12 -25 L 0 -30 L 11 -19';

  return (
    <g>
      <path className="mentor__limb" d="M -17 0 Q -6 -13 4 -4 Q 12 1 18 -6" />
      <path className="mentor__limb" d="M 0 -14 L 0 -36" />
      <g transform="rotate(-9)">
        <rect className="mentor__book" x="-11" y="-19" width="23" height="9" rx="1.5" />
        <path className="mentor__bookLine" d="M -5 -14.5 L 7 -14.5" />
      </g>
      <path className="mentor__limb" d={arms} />
      <circle className="mentor__head" cx="0" cy="-45" r="9" />
    </g>
  );
}

export function MentorScene() {
  return (
    <div className="mentor">
      {/* Every layer shares this one square stage. */}
      <div
        className="mentor__stage"
        role="img"
        aria-label={
          `An older student from IIT Bombay stands at a blackboard and works a question `
          + `through while his younger brother sits on the floor with a notebook. The question `
          + `mark over the boy turns into a lit bulb and he throws both arms up.`
        }
      >
        {/* Layer 1 — the room: the board, its frame and the floor. Still. */}
        <svg className="mentor__layer" viewBox="0 0 420 340" aria-hidden="true">
          <rect className="mentor__frame" x="118" y="8" width="290" height="154" rx="7" />
          <rect className="mentor__board" x="126" y="16" width="274" height="138" rx="4" />
          {/* The chalk tray, and one stick of chalk resting on it. */}
          <rect className="mentor__tray" x="140" y="162" width="246" height="7" rx="3.5" />
          <rect className="mentor__chalkStick" x="350" y="156" width="22" height="6" rx="3" />
          <line className="mentor__floor" x1="24" y1={FLOOR} x2="400" y2={FLOOR} />
          {/* The mat he sits on, so he is not floating on the line. */}
          <ellipse className="mentor__mat" cx={BOY_X} cy={FLOOR - 1} rx="54" ry="8" />
        </svg>

        {/* Layer 2 — the handwriting. Each stroke dashes itself on. */}
        <svg className="mentor__layer" viewBox="0 0 420 340" aria-hidden="true">
          {CHALK.map((stroke) => (
            <path
              key={stroke.d}
              className="mentor__chalk"
              d={stroke.d}
              pathLength="1"
              /* The writing phase is 5.6 s of the 14 s loop; a stroke's start
                 is its place in that phase, which is why `at` is a fraction. */
              style={{ animationDelay: `${(stroke.at * 5.6).toFixed(2)}s` }}
            />
          ))}
          <path className="mentor__tick" d={TICK} pathLength="1" />
        </svg>

        {/* Layer 3 — the bhaiya, two poses crossfaded in place. */}
        <svg className="mentor__layer" viewBox="0 0 420 340" aria-hidden="true">
          <g transform={`translate(${BHAIYA_X} ${FLOOR}) scale(1.75)`}>
            <g className="mentor__pose mentor__pose--rest">
              <Bhaiya pose="rest" />
            </g>
            <g className="mentor__pose mentor__pose--teach">
              <Bhaiya pose="teach" />
            </g>
          </g>
          {/* The pointer, from his raised hand to the bottom corner of the
              board. It appears with the pointing pose, not before. */}
          <line className="mentor__pointer" x1="118" y1="218" x2="158" y2="166" />
        </svg>

        {/* Layer 4 — the boy, likewise. */}
        <svg className="mentor__layer" viewBox="0 0 420 340" aria-hidden="true">
          <g transform={`translate(${BOY_X} ${FLOOR}) scale(1.55)`}>
            <g className="mentor__pose mentor__pose--write">
              <ChhoteBhai pose="write" />
            </g>
            <g className="mentor__pose mentor__pose--cheer">
              <ChhoteBhai pose="cheer" />
            </g>
          </g>
        </svg>

        {/* Layer 5 — what is going on over his head: a doubt, then a bulb. */}
        <svg className="mentor__layer" viewBox="0 0 420 340" aria-hidden="true">
          <g className="mentor__doubt" transform="translate(312 196)">
            <circle className="mentor__bubble" cx="0" cy="0" r="21" />
            <text className="mentor__doubtMark" x="0" y="9">
              ?
            </text>
          </g>

          {/* Two nested groups, not one: a CSS `transform` on an SVG element
              replaces its `transform` attribute rather than composing with it,
              so the group that is placed and the group that pops have to be
              different elements. The outer one places; the inner one scales. */}
          <g transform="translate(312 194)">
            <g className="mentor__idea">
            {/* The glass, the screw base, and three rays. */}
            <path
              className="mentor__bulbGlass"
              d="M 0 -20 C 10 -20 17 -12 17 -3 C 17 4 12 7 11 13 L -11 13 C -12 7 -17 4 -17 -3 C -17 -12 -10 -20 0 -20 Z"
            />
            <rect className="mentor__bulbBase" x="-8" y="13" width="16" height="6" rx="2" />
            <rect className="mentor__bulbBase" x="-6" y="20" width="12" height="5" rx="2.5" />
            <path className="mentor__filament" d="M -5 6 L -2 -5 L 2 2 L 5 -8" />
            <g className="mentor__rays">
              <line x1="0" y1="-30" x2="0" y2="-39" />
              <line x1="-22" y1="-22" x2="-29" y2="-29" />
              <line x1="22" y1="-22" x2="29" y2="-29" />
            </g>
            </g>
          </g>

          {SPARKS.map((spark) => (
            <path
              key={`${spark.x},${spark.y}`}
              className="mentor__spark"
              d={SPARKLE_PATH}
              transform={`translate(${spark.x} ${spark.y}) scale(${spark.size / 100})`}
              style={{ animationDelay: spark.delay }}
            />
          ))}
        </svg>
      </div>

      {/* The price is already in the lede beside this picture, so the caption
          says the part the picture cannot: who is on the other end of it. */}
      <p className="mentor__caption">
        {MENTORSHIP.months} months of it — weekly, one to one, with someone who sat this exam
        and got in.
      </p>
    </div>
  );
}
