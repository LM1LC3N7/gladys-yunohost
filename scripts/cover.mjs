// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a night-blue gradient, a
// small self-hosted server of three stacked units (status LEDs, one amber),
// an "upgrade" arrow in a ring beside it and a backup box below the arrow.
// No logo of any project. Plain Node (zlib), no dependency. Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const NIGHT = [10, 20, 40];
const DUSK = [24, 52, 92];
const PANEL = [196, 202, 212];
const PANEL_DARK = [150, 158, 170];
const PORT = [28, 32, 40];
const DARK = [40, 48, 60];
const GREEN = [70, 220, 120];
const AMBER = [250, 176, 40];
const CYAN = [86, 210, 236];
const BLUE = [0, 111, 255];
const STEEL = [120, 132, 150];

/** Distance from a point to a rounded rectangle (negative inside). */
function roundedBox(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Distance from a point to a segment. */
function segment(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

const UNITS = [170, 267, 364];
const SERVER_X = 300;
const RING = { cx: 590, cy: 215, r: 78 };

function pixel(x, y) {
  let color = mix(NIGHT, DUSK, y / HEIGHT);
  // The server: three stacked units, a shadow behind them.
  color = mix(color, DARK, smooth(0, roundedBox(x, y, SERVER_X + 8, 275, 170, 160, 14)));
  for (const [i, cy] of UNITS.entries()) {
    color = mix(
      color,
      mix(PANEL, PANEL_DARK, (y - cy + 40) / 80),
      smooth(0, roundedBox(x, y, SERVER_X, cy, 160, 40, 9)),
    );
    // Vent slots on the left, LEDs on the right.
    for (let k = 0; k < 5; k += 1) {
      color = mix(color, PORT, smooth(0, roundedBox(x, y, 190 + k * 26, cy, 8, 22, 3)));
    }
    color = mix(color, i === 1 ? AMBER : GREEN, smooth(5, Math.hypot(x - 400, y - cy)));
    color = mix(color, GREEN, smooth(5, Math.hypot(x - 428, y - cy)));
    color = mix(color, STEEL, smooth(0, roundedBox(x, y, 360, cy, 14, 4, 2)));
  }
  // The upgrade ring and its arrow.
  const d = Math.abs(Math.hypot(x - RING.cx, y - RING.cy) - RING.r);
  color = mix(color, CYAN, smooth(7, d));
  color = mix(color, BLUE, smooth(0, Math.hypot(x - RING.cx, y - RING.cy) - (RING.r - 14)));
  const shaft = segment(x, y, RING.cx, RING.cy + 38, RING.cx, RING.cy - 30);
  const left = segment(x, y, RING.cx, RING.cy - 40, RING.cx - 28, RING.cy - 10);
  const right = segment(x, y, RING.cx, RING.cy - 40, RING.cx + 28, RING.cy - 10);
  color = mix(color, PANEL, smooth(8, Math.min(shaft, left, right)));
  // The backup box below the ring.
  color = mix(color, STEEL, smooth(0, roundedBox(x, y, RING.cx, 395, 62, 42, 8)));
  color = mix(color, PANEL_DARK, smooth(0, roundedBox(x, y, RING.cx, 362, 70, 12, 4)));
  color = mix(color, DARK, smooth(0, roundedBox(x, y, RING.cx, 395, 18, 6, 3)));
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
