/**
 * Generate the PWA icon set from the OpenCode mark.
 *
 * The mark is the same geometry as `public/assets/opencode.svg` (pure
 * axis-aligned rectangles, so no SVG rasterizer is needed): a dark tile
 * (#131010) with a white bracket/frame, a cut-out, and a gray inner block.
 *
 * Outputs (public/icons/, copied verbatim into dist/ by Vite):
 *   icon-192.png          install icon (192, `any`)
 *   icon-512.png          install icon (512, `any`)
 *   maskable-512.png      maskable icon — mark held inside the 80% safe circle
 *   apple-touch-icon.png  iOS home screen (180, full-bleed)
 *   badge-96.png          Android notification small icon: WHITE silhouette on
 *                         transparent (Chrome tints the alpha, so a full-color
 *                         or opaque badge renders as a solid white square)
 *
 * Run:  bun run scripts/gen-icons.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const CX = 256;
const CY = 256;

// Mark rectangles in 512-space, from the SVG paths.
const FRAME = { x0: 128, y0: 96, x1: 384, y1: 416 };
const HOLE = { x0: 192, y0: 160, x1: 320, y1: 352 };
const INNER = { x0: 192, y0: 224, x1: 320, y1: 352 };

const BG = [0x13, 0x10, 0x10, 255] as const;
const WHITE = [255, 255, 255, 255] as const;
const GRAY = [0x5a, 0x58, 0x58, 255] as const;
const CLEAR = [0, 0, 0, 0] as const;

type Rgba = readonly [number, number, number, number];

function drawIcon(
  size: number,
  scale: number,
  opts: { transparent: boolean; monochrome: boolean },
): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  const set = (x: number, y: number, c: Rgba) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    data[i] = c[0];
    data[i + 1] = c[1];
    data[i + 2] = c[2];
    data[i + 3] = c[3];
  };
  const fill = (r: { x0: number; y0: number; x1: number; y1: number }, c: Rgba) => {
    const x0 = Math.round((r.x0 - CX) * scale + size / 2);
    const x1 = Math.round((r.x1 - CX) * scale + size / 2);
    const y0 = Math.round((r.y0 - CY) * scale + size / 2);
    const y1 = Math.round((r.y1 - CY) * scale + size / 2);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y, c);
  };

  // Background: full-bleed tile, or fully transparent for the badge.
  if (!opts.transparent) {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, BG);
  }
  fill(FRAME, WHITE);
  fill(HOLE, opts.transparent ? CLEAR : BG);
  fill(INNER, opts.monochrome ? WHITE : GRAY);
  return data;
}

// ---- minimal PNG encoder (RGBA8, no interlace) ------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

function encodePng(size: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size);
  dv.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    png.set(p, o);
    o += p.length;
  }
  return png;
}

const OUT = join(import.meta.dir, "..", "public", "icons");
const targets: Array<{ file: string; size: number; scale: number; opts: { transparent: boolean; monochrome: boolean } }> = [
  { file: "icon-192.png", size: 192, scale: 1.2, opts: { transparent: false, monochrome: false } },
  { file: "icon-512.png", size: 512, scale: 1.2, opts: { transparent: false, monochrome: false } },
  { file: "maskable-512.png", size: 512, scale: 0.75, opts: { transparent: false, monochrome: false } },
  { file: "apple-touch-icon.png", size: 180, scale: 1.15, opts: { transparent: false, monochrome: false } },
  { file: "badge-96.png", size: 96, scale: 0.95, opts: { transparent: true, monochrome: true } },
];

for (const t of targets) {
  const png = encodePng(t.size, drawIcon(t.size, t.scale, t.opts));
  writeFileSync(join(OUT, t.file), png);
  console.log(`wrote ${t.file} (${t.size}×${t.size}, ${png.length} bytes)`);
}
