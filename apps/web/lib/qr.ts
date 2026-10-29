import QRCode from 'qrcode/lib/core/qrcode.js';

/**
 * A QR matrix for an `otpauth://` setup URI.
 *
 * This was a hand-written encoder, and it was wrong. Verified against the
 * `qrcode` library module-for-module it differed in fifteen modules, all in the
 * format-information strip — close enough to look like a QR code and scan on a
 * good day, which is the worst possible failure here: a code that resolves to
 * the wrong secret gives an admin an authenticator whose six digits the server
 * will never accept, with nothing on screen to say why. "Nearly correct" is not
 * a category this can live in, so the proven implementation does the encoding.
 *
 * Imported from `qrcode/lib/core/qrcode.js` rather than the package root: the
 * root entry pulls in canvas and file-system renderers that a browser bundle
 * has no use for. The core export is the encoder alone, and the caller draws
 * the matrix as SVG rects.
 *
 * Level M, which is what authenticator apps are universally fine with, and the
 * mask is left to the library's own penalty scoring rather than pinned.
 */

export interface QrMatrix {
  size: number;
  /** Row-major; true is a dark module. */
  modules: boolean[][];
}

export function encodeQr(text: string): QrMatrix {
  const encoded = QRCode.create(text, { errorCorrectionLevel: 'M' }) as {
    modules: { size: number; get(row: number, col: number): boolean };
  };

  const size = encoded.modules.size;
  const modules = Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => Boolean(encoded.modules.get(row, col))),
  );

  return { size, modules };
}
