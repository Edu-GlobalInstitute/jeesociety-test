/**
 * The sun, already up behind the headline.
 *
 * The hero is a morning rather than a night, so this is the morning's source:
 * a disc that rises out of the horizon on load, a slow fan of rays behind it,
 * and a warm bloom that carries the bottom edge of the band into the cream of
 * the next section. On a pale sky the rays and the bloom are painted stronger
 * than they were on navy (app/landing.css) — there is less contrast to spend.
 *
 * It is four empty elements on purpose — every pixel of it is painted by CSS
 * gradients (app/landing.css), so there is no image to download and nothing to
 * go blurry on a 120 Hz phone. It carries no meaning, so it is aria-hidden.
 */
export function Sunrise() {
  return (
    <div className="sunrise" aria-hidden="true">
      <div className="sunrise__glow" />
      <div className="sunrise__rays" />
      <div className="sunrise__disc" />
      <div className="sunrise__haze" />
    </div>
  );
}
