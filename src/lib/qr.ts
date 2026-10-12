/**
 * Dependency-free QR Code encoder (byte mode) — the R11 pairing dialog needs a
 * QR that encodes a URL, and AGENTS rule 5 makes a QR dependency expensive
 * (`qrcode`/`jsqr` are hundreds of KB for one modal). This is a compact,
 * pure implementation of the ISO/IEC 18004 symbol: byte-mode segments,
 * versions 1–40, all four error-correction levels, Reed–Solomon ECC, the
 * eight data masks with the standard penalty scoring, and format/version info.
 *
 * It deliberately supports ONLY byte mode. A URL is byte-mode in practice
 * (lowercase letters are outside the alphanumeric set), so the extra numeric /
 * alphanumeric / kanji segmenters would be dead weight.
 *
 * Verified where the repo could verify it: the emitted module matrix is
 * byte-for-byte identical to the reference `qrcode` npm package for byte-mode
 * inputs across versions/ECC levels (see `docs/plans/parity.md` R11 notes in
 * the worker report). The modules are returned as a boolean grid so any
 * renderer (SVG, canvas, terminal) can draw them without this module knowing.
 */

export type QrEcc = "L" | "M" | "Q" | "H";

export interface QrMatrix {
  /** Modules per side (version * 4 + 17). */
  size: number;
  /** `modules[row][col] === true` means a dark module. */
  modules: boolean[][];
  version: number;
  ecc: QrEcc;
}

/** Total codewords (data + EC) per version; index 0 is unused. */
const CODEWORDS_COUNT = [
  0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655,
  733, 815, 901, 991, 1085, 1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921,
  2051, 2185, 2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706,
];

/** EC block counts per (version, L/M/Q/H). */
const EC_BLOCKS_TABLE = [
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 1, 2, 2, 4, 1, 2, 4, 4, 2, 4, 4, 4,
  2, 4, 6, 5, 2, 4, 6, 6, 2, 5, 8, 8, 4, 5, 8, 8, 4, 5, 8, 11, 4, 8, 10, 11,
  4, 9, 12, 16, 4, 9, 16, 16, 6, 10, 12, 18, 6, 10, 17, 16, 6, 11, 16, 19,
  6, 13, 18, 21, 7, 14, 21, 25, 8, 16, 20, 25, 8, 17, 23, 25, 9, 17, 23, 34,
  9, 18, 25, 30, 10, 20, 27, 32, 12, 21, 29, 35, 12, 23, 34, 37, 12, 25, 34,
  40, 13, 26, 35, 42, 14, 28, 38, 45, 15, 29, 40, 48, 16, 31, 43, 51, 17, 33,
  45, 54, 18, 35, 48, 57, 19, 37, 51, 60, 19, 38, 53, 63, 20, 40, 56, 66, 21,
  43, 59, 70, 22, 45, 62, 74, 24, 47, 65, 77, 25, 49, 68, 81,
];

/** Total EC codewords per (version, L/M/Q/H). */
const EC_CODEWORDS_TABLE = [
  7, 10, 13, 17, 10, 16, 22, 28, 15, 26, 36, 44, 20, 36, 52, 64, 26, 48, 72,
  88, 36, 64, 96, 112, 40, 72, 108, 130, 48, 88, 132, 156, 60, 110, 160, 192,
  72, 130, 192, 224, 80, 150, 224, 264, 96, 176, 260, 308, 104, 198, 288, 352,
  120, 216, 320, 384, 132, 240, 360, 432, 144, 280, 408, 480, 168, 308, 448,
  532, 180, 338, 504, 588, 196, 364, 546, 650, 224, 416, 600, 700, 224, 442,
  644, 750, 252, 476, 690, 816, 270, 504, 750, 900, 300, 560, 810, 960, 312,
  588, 870, 1050, 336, 644, 952, 1110, 360, 700, 1020, 1200, 390, 728, 1050,
  1260, 420, 784, 1140, 1350, 450, 812, 1200, 1440, 480, 868, 1290, 1530, 510,
  924, 1350, 1620, 540, 980, 1440, 1710, 570, 1036, 1530, 1800, 570, 1064,
  1590, 1890, 600, 1120, 1680, 1980, 630, 1204, 1770, 2100, 660, 1260, 1860,
  2220, 720, 1316, 1950, 2310, 750, 1372, 2040, 2430,
];

/** Format-info data bits for each ECC level (L/M/Q/H). */
const ECC_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };
/** Column index into the (version, L/M/Q/H) tables. */
const ECC_INDEX: Record<QrEcc, number> = { L: 0, M: 1, Q: 2, H: 3 };

// ---- Galois field GF(256), QR's byte-wise modulo 0x11D ---------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGalois() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

function polyMul(p1: Uint8Array, p2: Uint8Array): Uint8Array {
  const out = new Uint8Array(p1.length + p2.length - 1);
  for (let i = 0; i < p1.length; i++) {
    for (let j = 0; j < p2.length; j++) out[i + j] = out[i + j]! ^ gfMul(p1[i]!, p2[j]!);
  }
  return out;
}

function polyMod(dividend: Uint8Array, divisor: Uint8Array): Uint8Array {
  let result = new Uint8Array(dividend);
  while (result.length - divisor.length >= 0) {
    const coeff = result[0]!;
    if (coeff !== 0) {
      for (let i = 0; i < divisor.length; i++) {
        result[i] = result[i]! ^ gfMul(divisor[i]!, coeff);
      }
    }
    let offset = 0;
    while (offset < result.length && result[offset] === 0) offset++;
    result = result.slice(offset);
  }
  return result;
}

function genEcPoly(degree: number): Uint8Array {
  let poly: Uint8Array = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) poly = polyMul(poly, new Uint8Array([1, EXP[i]!]));
  return poly;
}

function rsEncode(data: Uint8Array, degree: number, gen: Uint8Array): Uint8Array {
  const padded = new Uint8Array(data.length + degree);
  padded.set(data);
  const remainder = polyMod(padded, gen);
  const start = degree - remainder.length;
  if (start > 0) {
    const out = new Uint8Array(degree);
    out.set(remainder, start);
    return out;
  }
  return remainder;
}

// ---- bit buffer ------------------------------------------------------------

class BitBuffer {
  bytes: number[] = [];
  length = 0;

  putBit(bit: boolean) {
    const i = Math.floor(this.length / 8);
    if (this.bytes.length <= i) this.bytes.push(0);
    if (bit) this.bytes[i] = this.bytes[i]! | (0x80 >>> this.length % 8);
    this.length++;
  }

  put(num: number, len: number) {
    for (let i = 0; i < len; i++) this.putBit(((num >>> (len - i - 1)) & 1) === 1);
  }
}

// ---- symbol construction ---------------------------------------------------

function bchDigit(n: number): number {
  let digit = 0;
  while (n !== 0) {
    digit++;
    n >>>= 1;
  }
  return digit;
}

const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | 1;
const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);
const G15_BCH = bchDigit(G15);
const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | 1;
const G18_BCH = bchDigit(G18);

function formatBits(ecc: QrEcc, mask: number): number {
  const data = (ECC_BITS[ecc]! << 3) | mask;
  let d = data << 10;
  while (bchDigit(d) - G15_BCH >= 0) d ^= G15 << (bchDigit(d) - G15_BCH);
  return ((data << 10) | d) ^ G15_MASK;
}

function versionBits(version: number): number {
  let d = version << 12;
  while (bchDigit(d) - G18_BCH >= 0) d ^= G18 << (bchDigit(d) - G18_BCH);
  return (version << 12) | d;
}

function charCountBits(version: number): number {
  return version < 10 ? 8 : 16;
}

/** Max byte-mode payload (bytes) for a version + ECC level. */
function byteCapacity(version: number, ecc: QrEcc): number {
  const total = CODEWORDS_COUNT[version]!;
  const ecTotal = EC_CODEWORDS_TABLE[(version - 1) * 4 + ECC_INDEX[ecc]]!;
  const usable = (total - ecTotal) * 8 - (4 + charCountBits(version));
  return Math.floor(usable / 8);
}

function bestVersion(byteLength: number, ecc: QrEcc): number {
  for (let v = 1; v <= 40; v++) {
    if (byteLength <= byteCapacity(v, ecc)) return v;
  }
  throw new Error("QR: data too long (max 2953 bytes at ECC level L)");
}

function createCodewords(bytes: Uint8Array, version: number, ecc: QrEcc): Uint8Array {
  const buffer = new BitBuffer();
  // Byte-mode segment: 0100, then the character-count indicator, then the bytes.
  buffer.put(0b0100, 4);
  buffer.put(bytes.length, charCountBits(version));
  for (const b of bytes) buffer.put(b, 8);

  const total = CODEWORDS_COUNT[version]!;
  const ecTotal = EC_CODEWORDS_TABLE[(version - 1) * 4 + ECC_INDEX[ecc]]!;
  const dataBits = (total - ecTotal) * 8;

  if (buffer.length + 4 <= dataBits) buffer.put(0, 4);
  while (buffer.length % 8 !== 0) buffer.putBit(false);
  const remaining = (dataBits - buffer.length) / 8;
  for (let i = 0; i < remaining; i++) buffer.put(i % 2 ? 0x11 : 0xec, 8);

  return interleave(Uint8Array.from(buffer.bytes), version, ecc);
}

function interleave(data: Uint8Array, version: number, ecc: QrEcc): Uint8Array {
  const total = CODEWORDS_COUNT[version]!;
  const ecTotal = EC_CODEWORDS_TABLE[(version - 1) * 4 + ECC_INDEX[ecc]]!;
  const dataTotal = total - ecTotal;
  const blocks = EC_BLOCKS_TABLE[(version - 1) * 4 + ECC_INDEX[ecc]]!;

  const group2 = total % blocks;
  const group1 = blocks - group2;
  const totalInGroup1 = Math.floor(total / blocks);
  const dataInGroup1 = Math.floor(dataTotal / blocks);
  const dataInGroup2 = dataInGroup1 + 1;
  const ecCount = totalInGroup1 - dataInGroup1;

  const gen = genEcPoly(ecCount);
  const dc: Uint8Array[] = new Array(blocks);
  const ec: Uint8Array[] = new Array(blocks);
  let offset = 0;
  let maxData = 0;
  for (let b = 0; b < blocks; b++) {
    const size = b < group1 ? dataInGroup1 : dataInGroup2;
    dc[b] = data.slice(offset, offset + size);
    ec[b] = rsEncode(dc[b]!, ecCount, gen);
    offset += size;
    maxData = Math.max(maxData, size);
  }

  const out = new Uint8Array(total);
  let idx = 0;
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < blocks; b++) if (i < dc[b]!.length) out[idx++] = dc[b]![i]!;
  }
  for (let i = 0; i < ecCount; i++) {
    for (let b = 0; b < blocks; b++) out[idx++] = ec[b]![i]!;
  }
  return out;
}

/** Symbol grid + reserved-flag grid, mirroring the reference BitMatrix. */
class Grid {
  readonly size: number;
  readonly data: Uint8Array;
  readonly reserved: Uint8Array;

  constructor(size: number) {
    this.size = size;
    this.data = new Uint8Array(size * size);
    this.reserved = new Uint8Array(size * size);
  }

  set(row: number, col: number, value: number | boolean, reserved = false) {
    const i = row * this.size + col;
    this.data[i] = value ? 1 : 0;
    if (reserved) this.reserved[i] = 1;
  }

  get(row: number, col: number): number {
    return this.data[row * this.size + col]!;
  }

  xor(row: number, col: number, value: boolean) {
    const i = row * this.size + col;
    this.data[i] = this.data[i]! ^ (value ? 1 : 0);
  }

  isReserved(row: number, col: number): boolean {
    return this.reserved[row * this.size + col]! === 1;
  }
}

function setupFinderPattern(grid: Grid) {
  const size = grid.size;
  const positions: [number, number][] = [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ];
  for (const [row, col] of positions) {
    for (let r = -1; r <= 7; r++) {
      if (row + r <= -1 || size <= row + r) continue;
      for (let c = -1; c <= 7; c++) {
        if (col + c <= -1 || size <= col + c) continue;
        const dark =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        grid.set(row + r, col + c, dark, true);
      }
    }
  }
}

function setupTimingPattern(grid: Grid) {
  const size = grid.size;
  for (let r = 8; r < size - 8; r++) {
    const value = r % 2 === 0;
    grid.set(r, 6, value, true);
    grid.set(6, r, value, true);
  }
}

function alignmentRowCol(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const intervals = size === 145 ? 26 : Math.ceil((size - 13) / (2 * count - 2)) * 2;
  const positions = [size - 7];
  for (let i = 1; i < count - 1; i++) positions[i] = positions[i - 1]! - intervals;
  positions.push(6);
  return positions.reverse();
}

function setupAlignmentPattern(grid: Grid, version: number) {
  const pos = alignmentRowCol(version);
  const len = pos.length;
  for (let i = 0; i < len; i++) {
    for (let j = 0; j < len; j++) {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === len - 1) ||
        (i === len - 1 && j === 0)
      ) {
        continue;
      }
      const row = pos[i]!;
      const col = pos[j]!;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const dark = r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
          grid.set(row + r, col + c, dark, true);
        }
      }
    }
  }
}

function setupVersionInfo(grid: Grid, version: number) {
  const size = grid.size;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const row = Math.floor(i / 3);
    const col = (i % 3) + size - 8 - 3;
    const dark = ((bits >> i) & 1) === 1;
    grid.set(row, col, dark, true);
    grid.set(col, row, dark, true);
  }
}

function setupFormatInfo(grid: Grid, ecc: QrEcc, mask: number) {
  const size = grid.size;
  const bits = formatBits(ecc, mask);
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >> i) & 1) === 1;
    if (i < 6) grid.set(i, 8, dark, true);
    else if (i < 8) grid.set(i + 1, 8, dark, true);
    else grid.set(size - 15 + i, 8, dark, true);

    if (i < 8) grid.set(8, size - i - 1, dark, true);
    else if (i < 9) grid.set(8, 15 - i - 1 + 1, dark, true);
    else grid.set(8, 15 - i - 1, dark, true);
  }
  grid.set(size - 8, 8, 1, true);
}

function setupData(grid: Grid, data: Uint8Array) {
  const size = grid.size;
  let inc = -1;
  let row = size - 1;
  let bitIndex = 7;
  let byteIndex = 0;

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        if (!grid.isReserved(row, col - c)) {
          let dark = false;
          if (byteIndex < data.length) dark = ((data[byteIndex]! >>> bitIndex) & 1) === 1;
          grid.set(row, col - c, dark);
          bitIndex--;
          if (bitIndex === -1) {
            byteIndex++;
            bitIndex = 7;
          }
        }
      }
      row += inc;
      if (row < 0 || size <= row) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }
}

function maskAt(pattern: number, i: number, j: number): boolean {
  switch (pattern) {
    case 0:
      return (i + j) % 2 === 0;
    case 1:
      return i % 2 === 0;
    case 2:
      return j % 3 === 0;
    case 3:
      return (i + j) % 3 === 0;
    case 4:
      return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5:
      return ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6:
      return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    default:
      return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
  }
}

function applyMask(pattern: number, grid: Grid) {
  const size = grid.size;
  for (let col = 0; col < size; col++) {
    for (let row = 0; row < size; row++) {
      if (grid.isReserved(row, col)) continue;
      grid.xor(row, col, maskAt(pattern, row, col));
    }
  }
}

function penaltyN1(g: Grid): number {
  const size = g.size;
  let points = 0;
  for (let row = 0; row < size; row++) {
    let sameCol = 0;
    let sameRow = 0;
    let lastCol: number | null = null;
    let lastRow: number | null = null;
    for (let col = 0; col < size; col++) {
      let module = g.get(row, col);
      if (module === lastCol) sameCol++;
      else {
        if (sameCol >= 5) points += 3 + (sameCol - 5);
        lastCol = module;
        sameCol = 1;
      }
      module = g.get(col, row);
      if (module === lastRow) sameRow++;
      else {
        if (sameRow >= 5) points += 3 + (sameRow - 5);
        lastRow = module;
        sameRow = 1;
      }
    }
    if (sameCol >= 5) points += 3 + (sameCol - 5);
    if (sameRow >= 5) points += 3 + (sameRow - 5);
  }
  return points;
}

function penaltyN2(g: Grid): number {
  const size = g.size;
  let points = 0;
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const sum =
        g.get(row, col) + g.get(row, col + 1) + g.get(row + 1, col) + g.get(row + 1, col + 1);
      if (sum === 4 || sum === 0) points++;
    }
  }
  return points * 3;
}

function penaltyN3(g: Grid): number {
  const size = g.size;
  let points = 0;
  for (let row = 0; row < size; row++) {
    let bitsCol = 0;
    let bitsRow = 0;
    for (let col = 0; col < size; col++) {
      bitsCol = ((bitsCol << 1) & 0x7ff) | g.get(row, col);
      if (col >= 10 && (bitsCol === 0x5d0 || bitsCol === 0x05d)) points++;
      bitsRow = ((bitsRow << 1) & 0x7ff) | g.get(col, row);
      if (col >= 10 && (bitsRow === 0x5d0 || bitsRow === 0x05d)) points++;
    }
  }
  return points * 40;
}

function penaltyN4(g: Grid): number {
  let dark = 0;
  for (let i = 0; i < g.data.length; i++) dark += g.data[i]!;
  const k = Math.abs(Math.ceil((dark * 100) / g.data.length / 5) - 10);
  return k * 10;
}

function bestMask(grid: Grid, ecc: QrEcc): number {
  let best = 0;
  let lower = Infinity;
  for (let p = 0; p < 8; p++) {
    setupFormatInfo(grid, ecc, p);
    applyMask(p, grid);
    const penalty = penaltyN1(grid) + penaltyN2(grid) + penaltyN3(grid) + penaltyN4(grid);
    applyMask(p, grid);
    if (penalty < lower) {
      lower = penalty;
      best = p;
    }
  }
  return best;
}

/**
 * Encode `text` (UTF-8, byte mode) and return the final module matrix.
 * Uses the smallest version that fits at the chosen ECC level.
 */
export function encodeQr(text: string, ecc: QrEcc = "M"): QrMatrix {
  if (!text) throw new Error("QR: empty input");
  const bytes = new TextEncoder().encode(text);
  const version = bestVersion(bytes.length, ecc);
  const codewords = createCodewords(bytes, version, ecc);
  const size = version * 4 + 17;
  const grid = new Grid(size);

  setupFinderPattern(grid);
  setupTimingPattern(grid);
  setupAlignmentPattern(grid, version);
  // Reserve the format-info area with placeholder bits so the mask never
  // touches it, then overwrite it once the mask is chosen.
  setupFormatInfo(grid, ecc, 0);
  if (version >= 7) setupVersionInfo(grid, version);
  setupData(grid, codewords);

  const mask = bestMask(grid, ecc);
  applyMask(mask, grid);
  setupFormatInfo(grid, ecc, mask);

  const modules: boolean[][] = [];
  for (let row = 0; row < size; row++) {
    const line: boolean[] = new Array(size);
    for (let col = 0; col < size; col++) line[col] = grid.get(row, col) === 1;
    modules.push(line);
  }
  return { size, modules, version, ecc };
}

/** Convenience: a single SVG path (unit squares) for a matrix. */
export function qrPath(matrix: QrMatrix): string {
  let d = "";
  for (let row = 0; row < matrix.size; row++) {
    for (let col = 0; col < matrix.size; col++) {
      if (matrix.modules[row]![col]) d += `M${col} ${row}h1v1h-1z`;
    }
  }
  return d;
}
