import { REWARD_BANDS } from '@jee/shared/config';
import { SPARKLE_PATH } from './PosterMarks';

/**
 * The hero's moving picture: a student climbs the three-band ladder, cannot
 * reach the next rung on their own, and a hand from JEE Society lifts them
 * from the bottom rung to the top, where the prize is waiting. It loops.
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
 * The rungs are labelled from REWARD_BANDS, so the picture cannot promise a
 * band the reward policy does not have.
 */

/** The rungs, bottom to top, placed on the ladder's three steps. */
const RUNGS = [
  { y: 344, floor: 97, short: 'Half-price seat' },
  { y: 254, floor: 98, short: '₹10,000 mentorship' },
  { y: 164, floor: 99, short: 'iPad or iPhone' },
] as const;

/* The picture would be lying if the policy changed under it. */
if (RUNGS.length !== REWARD_BANDS.length) {
  throw new Error('RescueLadder draws one rung per reward band; REWARD_BANDS has changed.');
}

const RAIL_LEFT = 90;
const RAIL_RIGHT = 170;
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
          'A student climbs a three-rung ladder labelled 97, 98 and 99 percentile. They cannot '
          + 'reach the next rung, so a hand from JEE Society lifts them from the bottom rung to '
          + 'the top one, where an iPad is waiting.'
        }
      >
      {/* Layer 1 — the ladder and its labels. Still. */}
        <svg className="climb__layer" viewBox="0 0 420 420" aria-hidden="true">
          <line className="climb__ground" x1="44" y1={GROUND} x2="256" y2={GROUND} />

          <line className="climb__rail" x1={RAIL_LEFT} y1="120" x2={RAIL_LEFT} y2={GROUND} />
          <line className="climb__rail" x1={RAIL_RIGHT} y1="120" x2={RAIL_RIGHT} y2={GROUND} />

          {RUNGS.map((rung) => (
            <g key={rung.floor}>
              <line className="climb__rung" x1={RAIL_LEFT} y1={rung.y} x2={RAIL_RIGHT} y2={rung.y} />
              <text className="climb__floor" x="192" y={rung.y + 9}>
                {rung.floor}
              </text>
              <text className="climb__prizeWord" x="238" y={rung.y + 6}>
                {rung.short}
              </text>
            </g>
          ))}

          {/* The top rung lights up once the student is standing on it. */}
          <line
            className="climb__glow"
            x1={RAIL_LEFT - 6}
            y1={RUNGS[2]!.y}
            x2={RAIL_RIGHT + 6}
            y2={RUNGS[2]!.y}
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
          transform={`translate(${CENTRE} ${RUNGS[0]!.y}) rotate(-7) scale(1.22)`}
        >
            <Student pose="carried" />
          </g>

          <g transform={`translate(${CENTRE + 52} ${RUNGS[0]!.y - 44}) rotate(-16)`}>
            {/* The forearm, rotated away from the palm so the hand reads as
                reaching in from off the page. */}
            <g transform="rotate(-30)">
              <rect className="climb__sleeve" x="12" y="-24" width="124" height="48" rx="11" />
              <rect className="climb__cuff" x="18" y="-26" width="13" height="52" rx="5" />
              {/* Two lines: one would run off the end of the sleeve. */}
              <text className="climb__brand" x="44" y="-3">JEE</text>
              <text className="climb__brand" x="44" y="13">SOCIETY</text>
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

        {/* Layer 4 — the prize, above the top rung. It pops in once they land. */}
        <svg className="climb__layer climb__prize" viewBox="0 0 420 420" aria-hidden="true">
          {/* Above the rails, not on them: a student standing on the top rung
            has their head at y≈98, which is where the prize used to be. */}
        <g transform={`translate(${CENTRE} 58)`}>
            <rect className="climb__tablet" x="-26" y="-34" width="52" height="68" rx="8" />
            <rect className="climb__screen" x="-20" y="-28" width="40" height="52" rx="4" />
            <circle className="climb__screen" cx="0" cy="28" r="3" />
            {[
              { x: -46, y: -28, size: 18, delay: '0s' },
              { x: 36, y: -14, size: 14, delay: '0.5s' },
              { x: -34, y: 24, size: 11, delay: '1.1s' },
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

        <p className="climb__caption">
          You do the climbing. The top three bands get a hand up.
        </p>
    </div>
  );
}
