import { DIAGNOSTIC, PAPER } from '@jee/shared/config';
import { SPARKLE_PATH } from './PosterMarks';

/**
 * The hero's moving picture: a student climbs the three steps of the offer —
 * the paper, the report, the webinar — cannot reach the second one on their
 * own, and a hand from JEEsociety lifts them from the bottom step to the
 * top, where the {@link DIAGNOSTIC.liftMarks} they came for is waiting. It
 * loops.
 *
 * The steps are the argument, in order, which is why they are a ladder and not
 * a list: a student under {@link DIAGNOSTIC.entryCeilingMarks} does the one
 * thing they can do unaided — sit the paper — and the two steps that actually
 * move their score are the ones they are carried up.
 *
 * How it is built, because the construction is the whole trick:
 *
 *  - It is four **stacked SVG layers**, all with the same viewBox and all
 *    sized to the box: the ladder, the climbing student, the hand (with the
 *    student it is carrying drawn inside it), and the prize. Only the layers
 *    move, and they move with CSS transforms on the <svg> element itself —
 *    which is an ordinary replaced box, so percentage translates resolve
 *    against the layer's own size, which is the box's size. That is what keeps
 *    the animation in step at every width without a single pixel value.
 *  - Nothing inside a layer is transformed by CSS. Placement inside the
 *    viewBox is done with SVG's own `transform` attribute, which every browser
 *    has supported for twenty years, rather than CSS transforms on SVG
 *    children, whose `transform-box` behaviour is not worth betting a hero on.
 *  - The student being carried is a second drawing inside the hand's layer, so
 *    it follows the hand exactly. Handing one element from one parent to
 *    another is not something CSS can do; drawing it twice and crossfading is.
 *  - Every layer's animation is the same 13 s long, with the phases written as
 *    percentages of it (app/landing.css), so the grab happens on the frame the
 *    hand arrives and nothing can drift out of sync.
 *
 * Every number in the labels comes from @jee/shared/config, so the picture
 * cannot promise a step the offer does not have.
 */

/** The steps, bottom to top, placed on the ladder's three rungs. */
const STEPS = [
  {
    step: 1,
    title: 'The paper',
    sub: `3 hours, ${PAPER.maxMarks} marks`,
  },
  {
    step: 2,
    title: 'Your report',
    sub: `+${DIAGNOSTIC.liftMarks} marks, personalised`,
  },
  {
    step: 3,
    title: 'The webinar',
    sub: `${DIAGNOSTIC.webinarHost}, live`,
  },
] as const;

/** Rung heights, bottom to top. One per step, in the viewBox's units. */
const RUNG_Y = [344, 254, 164] as const;

/* The picture would be lying if a step were added and never drawn. */
if (STEPS.length !== RUNG_Y.length) {
  throw new Error('RescueLadder draws one rung per step; STEPS and RUNG_Y have come apart.');
}

/*
 * The ladder sits hard right in the viewBox, with the step labels filling the
 * left half. Two things decided that, and they pull the same way:
 *
 *  - each rung now carries a name and a line of detail, and those need roughly
 *    half the width to stay readable when the whole picture is 320px wide on a
 *    phone;
 *  - the hand reaches in from off the right-hand edge and crosses whatever is
 *    beside the ladder on its way to the student. Beside the ladder is now
 *    empty, so it crosses nothing. The words it used to sweep over are the
 *    offer itself, which is the one thing in the picture that has to stay
 *    legible on every frame.
 */
const RAIL_LEFT = 250;
const RAIL_RIGHT = 330;
/** Where a figure's feet sit: the middle of the ladder. */
const CENTRE = (RAIL_LEFT + RAIL_RIGHT) / 2;
const GROUND = 392;

/**
 * One student, feet at the local origin.
 *
 * `pose` is the only difference between the three appearances: reaching up a
 * rung, dangling from the hand, and both arms up at the top.
 */
function Student({ pose }: { pose: 'climb' | 'carried' | 'cheer' }) {
  const arms = {
    climb: 'M -12 -46 L 0 -34 L 12 -46',
    carried: 'M -15 -30 L 0 -34 L 15 -30',
    cheer: 'M -17 -58 L 0 -36 L 17 -58',
  }[pose];
  const legs = pose === 'carried' ? 'M -11 4 L 0 -18 L 11 3' : 'M -9 0 L 0 -18 L 9 0';

  return (
    <g className="climb__body">
      <path className="climb__limb" d={legs} />
      <path className="climb__limb" d="M 0 -18 L 0 -40" />
      <path className="climb__limb" d={arms} />
      <circle className="climb__head" cx="0" cy="-54" r="10" />
    </g>
  );
}

export function RescueLadder() {
  return (
    <div className="climb">
      {/* The four layers share one square stage, so a percentage translate on
          any of them is a percentage of the same box. */}
      <div
        className="climb__stage"
        role="img"
        aria-label={
          'A student climbs a three-step ladder: the paper, then their report, then the live '
          + `webinar with an ${DIAGNOSTIC.webinarHost}. They cannot reach the second step on `
          + 'their own, so a hand from JEEsociety lifts them from the bottom step to the '
          + `top one, where ${DIAGNOSTIC.liftMarks} more marks are waiting.`
        }
      >
      {/* Layer 1 — the ladder and its labels. Still. */}
        <svg className="climb__layer" viewBox="0 0 420 420" aria-hidden="true">
          <line className="climb__ground" x1="206" y1={GROUND} x2="416" y2={GROUND} />

          <line className="climb__rail" x1={RAIL_LEFT} y1="120" x2={RAIL_LEFT} y2={GROUND} />
          <line className="climb__rail" x1={RAIL_RIGHT} y1="120" x2={RAIL_RIGHT} y2={GROUND} />

          {STEPS.map((item, index) => {
            const y = RUNG_Y[index]!;
            return (
              <g key={item.step}>
                <line className="climb__rung" x1={RAIL_LEFT} y1={y} x2={RAIL_RIGHT} y2={y} />
                <text className="climb__step" x="6" y={y + 10}>
                  {item.step}
                </text>
                {/* The number, then the name on the rung's own line, then the
                    detail under it — read in that order, left to right into
                    the rung it belongs to. Two lines fit the words the offer
                    actually needs, where one line would have run off the
                    stage. */}
                <text className="climb__stepName" x="44" y={y - 3}>
                  {item.title}
                </text>
                <text className="climb__stepSub" x="44" y={y + 18}>
                  {item.sub}
                </text>
              </g>
            );
          })}

          {/* The top rung lights up once the student is standing on it. */}
          <line
            className="climb__glow"
            x1={RAIL_LEFT - 6}
            y1={RUNG_Y[2]}
            x2={RAIL_RIGHT + 6}
            y2={RUNG_Y[2]}
          />
        </svg>

        {/* Layer 2 — the student doing the climbing, drawn standing on the
            ground. The layer is what moves. */}
        <svg className="climb__layer climb__kid" viewBox="0 0 420 420" aria-hidden="true">
          <g transform={`translate(${CENTRE} ${GROUND}) scale(1.22)`}>
            <g className="climb__pose climb__pose--climb">
              <Student pose="climb" />
            </g>
            <g className="climb__pose climb__pose--cheer">
              <Student pose="cheer" />
            </g>
          </g>
        </svg>

        {/* Layer 3 — the hand, with the student it carries drawn inside it so the
            two cannot come apart. Both are placed at the bottom rung, which is
            where the hand arrives and where the grab happens. */}
        <svg className="climb__layer climb__hand" viewBox="0 0 420 420" aria-hidden="true">
          <g
          className="climb__rider"
          transform={`translate(${CENTRE} ${RUNG_Y[0]}) rotate(-7) scale(1.22)`}
        >
            <Student pose="carried" />
          </g>

          <g transform={`translate(${CENTRE + 52} ${RUNG_Y[0] - 44}) rotate(-16)`}>
            {/* The forearm, rotated away from the palm so the hand reads as
                reaching in from off the page. */}
            <g transform="rotate(-30)">
              <rect className="climb__sleeve" x="12" y="-24" width="124" height="48" rx="11" />
              <rect className="climb__cuff" x="18" y="-26" width="13" height="52" rx="5" />
              {/* Fitted to the sleeve's width so the name cannot spill past
                  the cuff. */}
              <text
                className="climb__brand"
                x="44"
                y="5"
                textLength="86"
                lengthAdjust="spacingAndGlyphs"
              >
                JEEsociety
              </text>
            </g>
            <ellipse className="climb__palm" cx="0" cy="0" rx="26" ry="20" />
            <rect className="climb__palm" x="-50" y="-19" width="31" height="10" rx="5" />
            <rect className="climb__palm" x="-52" y="-7" width="33" height="10" rx="5" />
            <rect className="climb__palm" x="-50" y="5" width="31" height="10" rx="5" />
            <rect className="climb__palm" x="-43" y="16" width="26" height="9" rx="4.5" />
            <rect
              className="climb__palm"
              x="-12"
              y="13"
              width="28"
              height="10"
              rx="5"
              transform="rotate(32 -12 13)"
            />
          </g>
        </svg>

        {/* Layer 4 — the prize, above the top rung: the marks the three steps
            are for, which is the one number the whole hero is arguing. It pops
            in once they land. */}
        <svg className="climb__layer climb__prize" viewBox="0 0 420 420" aria-hidden="true">
          {/* Above the rails, not on them. */}
        <g transform={`translate(${CENTRE} 42)`}>
            {/* A student standing on the top rung has the top of their head at
                y≈86, so the plaque stops at 71 and the two never touch. */}
            <rect className="climb__plaque" x="-64" y="-31" width="128" height="60" rx="17" />
            <text className="climb__plaqueNum" x="0" y="-1">
              +{DIAGNOSTIC.liftMarks}
            </text>
            <text className="climb__plaqueWord" x="0" y="20">
              MARKS
            </text>
            {/* Clear of the plaque on every side: gold sparkles drawn over a
                gold plaque are invisible. */}
            {[
              { x: -86, y: -18, size: 18, delay: '0s' },
              { x: 82, y: -30, size: 14, delay: '0.5s' },
              { x: -74, y: 36, size: 11, delay: '1.1s' },
            ].map((spark) => (
              <path
                key={`${spark.x},${spark.y}`}
                className="climb__spark"
                d={SPARKLE_PATH}
                transform={`translate(${spark.x} ${spark.y}) scale(${spark.size / 100})`}
                style={{ animationDelay: spark.delay }}
              />
            ))}
          </g>
          </svg>
        </div>
    </div>
  );
}
