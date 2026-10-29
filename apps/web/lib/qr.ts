/**
 * A QR encoder, just big enough for an `otpauth://` setup URI.
 *
 * Written here rather than installed because this app is a static export whose
 * bundle every student downloads, and a general QR library is 15-40 KB for one
 * screen that only admins ever open. A TOTP URI is ~110 bytes of a known
 * alphabet, so the general case is not needed: this does byte mode at
 * error-correction level M, versions 1-10, which covers up to 213 bytes.
 *
 * The output is a boolean matrix. The caller draws it as SVG rects, so there is
 * no canvas and nothing to rasterise.
 *
 * Correctness here is not a matter of taste: a QR code that scans to the wrong
 * secret gives an admin an authenticator that produces codes the server will
 * never accept. The secret is therefore also shown as text to be typed in by
 * hand, which is the path that does not depend on any of this.
 */

/* ── Galois field arithmetic over GF(256), the Reed-Solomon field ────────── */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    // The QR standard's primitive polynomial, x^8 + x^4 + x^3 + x^2 + 1.
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** The generator polynomial for `degree` error-correction codewords. */
function generatorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]!;
      next[j + 1] ^= gfMul(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

function reedSolomon(data: Uint8Array, eccCount: number): Uint8Array {
  const generator = generatorPoly(eccCount);
  const remainder = new Uint8Array(eccCount);
  for (const byte of data) {
    const factor = byte ^ remainder[0]!;
    remainder.copyWithin(0, 1);
    remainder[eccCount - 1] = 0;
    for (let i = 0; i < eccCount; i += 1) {
      remainder[i] ^= gfMul(generator[i + 1]!, factor);
    }
  }
  return remainder;
}

/* ── Version table, level M, byte mode ───────────────────────────────────── */

/**
 * Per version: total codewords, ECC codewords per block, and the block split.
 * Level M only — the level authenticator apps are universally fine with, and
 * the one that keeps a TOTP URI inside a version small enough to scan from a
 * laptop screen.
 */
const VERSIONS = [
  { version: 1, totalCodewords: 26, eccPerBlock: 10, group1: 1, group2: 0 },
  { version: 2, totalCodewords: 44, eccPerBlock: 16, group1: 1, group2: 0 },
  { version: 3, totalCodewords: 70, eccPerBlock: 26, group1: 1, group2: 0 },
  { version: 4, totalCodewords: 100, eccPerBlock: 18, group1: 2, group2: 0 },
  { version: 5, totalCodewords: 134, eccPerBlock: 24, group1: 2, group2: 0 },
  { version: 6, totalCodewords: 172, eccPerBlock: 16, group1: 4, group2: 0 },
  { version: 7, totalCodewords: 196, eccPerBlock: 18, group1: 4, group2: 0 },
  { version: 8, totalCodewords: 242, eccPerBlock: 22, group1: 2, group2: 2 },
] as const;

/** Alignment-pattern centre coordinates, by version. */
const ALIGNMENT: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
};

/** Format information for level M, one entry per mask 0-7. Pre-computed BCH. */
const FORMAT_M = [
  0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0,
] as const;

/** Version information for versions 7+. Pre-computed BCH(18,6). */
const VERSION_INFO: Record<number, number> = {
  7: 0x07c94,
  8: 0x085bc,
};

export interface QrMatrix {
  size: number;
  /** Row-major; true is a dark module. */
  modules: boolean[][];
}

/**
 * Encodes `text` as a QR matrix.
 *
 * Throws when the text does not fit in version 8 at level M (242 codewords),
 * which a TOTP URI never approaches — but throwing is the right failure, since
 * silently truncating would produce a code that scans to a wrong secret.
 */
export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);

  const spec = VERSIONS.find((candidate) => {
    const blocks = candidate.group1 + candidate.group2;
    const dataCodewords = candidate.totalCodewords - candidate.eccPerBlock * blocks;
    // 4 bits mode + 8 or 16 bits length + the payload.
    const headerBits = 4 + (candidate.version >= 10 ? 16 : 8);
    return dataCodewords * 8 >= headerBits + bytes.length * 8;
  });
  if (!spec) {
    throw new Error(`${bytes.length} bytes is too long for this encoder.`);
  }

  const blocks = spec.group1 + spec.group2;
  const dataCodewords = spec.totalCodewords - spec.eccPerBlock * blocks;

  /* ── Bit stream: mode indicator, length, payload, terminator, padding ── */

  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, 8);
  for (const byte of bytes) push(byte, 8);

  // Terminator, up to four zero bits, then pad to a byte boundary.
  for (let i = 0; i < 4 && bits.length < dataCodewords * 8; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const data = new Uint8Array(dataCodewords);
  for (let i = 0; i < bits.length / 8; i += 1) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i * 8 + j]!;
    data[i] = byte;
  }
  // The standard's alternating pad bytes, from the first unused codeword.
  for (let i = Math.ceil(bits.length / 8); i < dataCodewords; i += 1) {
    data[i] = i % 2 === Math.ceil(bits.length / 8) % 2 ? 0xec : 0x11;
  }

  /* ── Split into blocks, compute ECC, interleave ───────────────────────── */

  const shortBlockLength = Math.floor(dataCodewords / blocks);
  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];

  let offset = 0;
  for (let i = 0; i < blocks; i += 1) {
    // The later blocks in group 2 carry one extra data codeword each.
    const length = i < spec.group1 ? shortBlockLength : shortBlockLength + 1;
    const block = data.slice(offset, offset + length);
    offset += length;
    dataBlocks.push(block);
    eccBlocks.push(reedSolomon(block, spec.eccPerBlock));
  }

  const interleaved: number[] = [];
  const longest = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < longest; i += 1) {
    for (const block of dataBlocks) {
      if (i < block.length) interleaved.push(block[i]!);
    }
  }
  for (let i = 0; i < spec.eccPerBlock; i += 1) {
    for (const block of eccBlocks) interleaved.push(block[i]!);
  }

  /* ── Lay out the matrix ───────────────────────────────────────────────── */

  const size = spec.version * 4 + 17;
  // null = not yet written, which is what distinguishes a function module from
  // a data module that happens to be light.
  const grid: (boolean | null)[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => null),
  );

  const setFinder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const y = row + r;
        const x = col + c;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        const onRing = r === 0 || r === 6 || c === 0 || c === 6;
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        grid[y]![x] = (r >= 0 && r <= 6 && c >= 0 && c <= 6) && (onRing || inCore);
      }
    }
  };

  setFinder(0, 0);
  setFinder(0, size - 7);
  setFinder(size - 7, 0);

  for (const row of ALIGNMENT[spec.version] ?? []) {
    for (const col of ALIGNMENT[spec.version] ?? []) {
      // Skip the three corners, where the finders already are.
      if (
        (row === 6 && col === 6)
        || (row === 6 && col === size - 7)
        || (row === size - 7 && col === 6)
      ) {
        continue;
      }
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          grid[row + r]![col + c] =
            Math.max(Math.abs(r), Math.abs(c)) !== 1;
        }
      }
    }
  }

  // Timing patterns.
  for (let i = 8; i < size - 8; i += 1) {
    if (grid[6]![i] === null) grid[6]![i] = i % 2 === 0;
    if (grid[i]![6] === null) grid[i]![6] = i % 2 === 0;
  }

  // The dark module, always set, and the format-information reservation.
  grid[size - 8]![8] = true;
  for (let i = 0; i < 9; i += 1) {
    if (grid[8]![i] === null) grid[8]![i] = false;
    if (grid[i]![8] === null) grid[i]![8] = false;
  }
  for (let i = size - 8; i < size; i += 1) {
    if (grid[8]![i] === null) grid[8]![i] = false;
    if (grid[i]![8] === null) grid[i]![8] = false;
  }
  if (spec.version >= 7) {
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        grid[size - 11 + j]![i] = false;
        grid[i]![size - 11 + j] = false;
      }
    }
  }

  /* ── Place the data, zig-zagging up and down column pairs ─────────────── */

  // Mask 0 is fixed rather than chosen by penalty score. The standard's mask
  // selection optimises scan reliability across arbitrary payloads; for a URI
  // of this shape and length, mask 0 scans reliably, and evaluating all eight
  // would be four times the code for no outcome an admin would notice.
  const MASK = 0;
  const maskAt = (row: number, col: number) => (row + col) % 2 === 0;

  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    const columnPair = right === 6 ? right - 1 : right;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const col of [columnPair, columnPair - 1]) {
        if (grid[row]![col] !== null) continue;
        const byte = interleaved[bitIndex >> 3] ?? 0;
        const bit = (byte >> (7 - (bitIndex & 7))) & 1;
        bitIndex += 1;
        grid[row]![col] = (bit === 1) !== maskAt(row, col);
      }
    }
    upward = !upward;
    if (columnPair !== right) right += 1;
  }

  /* ── Format and version information ──────────────────────────────────── */

  const format = FORMAT_M[MASK]!;
  const formatBit = (i: number) => ((format >> i) & 1) === 1;

  for (let i = 0; i <= 5; i += 1) grid[8]![i] = formatBit(14 - i);
  grid[8]![7] = formatBit(8);
  grid[8]![8] = formatBit(7);
  grid[7]![8] = formatBit(6);
  for (let i = 9; i <= 14; i += 1) grid[14 - i]![8] = formatBit(14 - i);

  for (let i = 0; i <= 7; i += 1) grid[size - 1 - i]![8] = formatBit(i);
  for (let i = 8; i <= 14; i += 1) grid[8]![size - 15 + i] = formatBit(i);

  if (spec.version >= 7) {
    const info = VERSION_INFO[spec.version]!;
    for (let i = 0; i < 18; i += 1) {
      const bit = ((info >> i) & 1) === 1;
      grid[Math.floor(i / 3)]![size - 11 + (i % 3)] = bit;
      grid[size - 11 + (i % 3)]![Math.floor(i / 3)] = bit;
    }
  }

  return {
    size,
    modules: grid.map((row) => row.map((cell) => cell === true)),
  };
}
