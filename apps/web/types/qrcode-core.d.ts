/**
 * Types for `qrcode/lib/core/qrcode.js`.
 *
 * `@types/qrcode` declares the package root only, and the root entry drags in
 * canvas and filesystem renderers a browser bundle has no use for — so lib/qr.ts
 * imports the core encoder directly and declares the one function it calls.
 */
declare module 'qrcode/lib/core/qrcode.js' {
  interface QrCodeBitMatrix {
    size: number;
    get(row: number, col: number): boolean;
  }

  interface QrCodeData {
    modules: QrCodeBitMatrix;
    version: number;
    maskPattern: number;
  }

  export function create(
    data: string,
    options?: {
      errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' | 'low' | 'medium' | 'quartile' | 'high';
      version?: number;
      maskPattern?: number;
      toSJISFunc?: (char: string) => number;
    },
  ): QrCodeData;

  const QRCode: { create: typeof create };
  export default QRCode;
}
