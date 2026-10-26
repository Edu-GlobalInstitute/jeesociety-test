/**
 * The prize, as photographs.
 *
 * Both images are Creative Commons BY-SA 4.0 from Wikimedia Commons, which is
 * why `PRIZE_PHOTO_CREDIT` is exported and rendered in the footer — that
 * licence requires visible attribution, and dropping the credit makes the use
 * unlicensed. Replacing these files means replacing that credit too.
 *
 * The iPad is a framed photo tile rather than a cut-out: its silver body and
 * its grey backdrop are too close in tone to mask cleanly, and a ragged edge
 * looks worse than an honest frame. The iPhone came already isolated on
 * transparency, so it floats in front and overlaps the tile, which is what
 * gives the pair any depth.
 */

export const PRIZE_PHOTO_CREDIT = [
  {
    what: 'iPad Pro',
    author: '彭家杰',
    href: 'https://commons.wikimedia.org/wiki/File:IPad_Pro_11_silver.jpg',
  },
  {
    what: 'iPhone 7',
    author: 'MacRepairDundee.co.uk',
    href:
      'https://commons.wikimedia.org/wiki/'
      + 'File:IPhone_7_-_A1778_Rose_Gold_-_Back_Right_-_Transparent_BG_no_shadow.png',
  },
] as const;

export function PrizeDevices() {
  return (
    <div className="prize">
      <div className="prize__tile">
        <img
          src="/prizes/ipad.webp"
          alt="An iPad Pro, seen from the back."
          width={900}
          height={1245}
          loading="eager"
          decoding="async"
        />
      </div>
      <img
        className="prize__phone"
        src="/prizes/iphone.webp"
        alt="An iPhone 7 in rose gold, seen from the back at an angle."
        width={480}
        height={1812}
        loading="eager"
        decoding="async"
      />
    </div>
  );
}
