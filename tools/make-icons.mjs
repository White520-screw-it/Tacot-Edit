// Generates the Tacot Edit app icons (PNG + ICO) with no dependencies.
// Run: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(dirname(here), 'src-tauri', 'icons');
mkdirSync(outDir, { recursive: true });

const TILE = [14, 15, 19];
const EDGE = [46, 48, 58];
const MAGMA = [255, 92, 57];
const EMBER = [255, 158, 92];
const DIM = [92, 96, 112];

const RADIUS = 0.27;

function insideRounded(x, y, radius) {
  const cx = Math.min(Math.max(x, radius), 1 - radius);
  const cy = Math.min(Math.max(y, radius), 1 - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function insideTriangle(x, y, ax, ay, bx, by, cx, cy) {
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function insideBar(x, y, x0, x1, y0, y1) {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

function sample(x, y) {
  if (!insideRounded(x, y, RADIUS)) return [0, 0, 0, 0];
  const edge = Math.min(x, 1 - x, y, 1 - y);
  if (edge < 0.013) return [...EDGE, 255];

  // Timeline stripes along the lower third.
  if (insideBar(x, y, 0.2, 0.55, 0.7, 0.755)) return [...DIM, 255];
  if (insideBar(x, y, 0.6, 0.8, 0.7, 0.755)) return [...EMBER, 255];
  if (insideBar(x, y, 0.2, 0.4, 0.79, 0.845)) return [...MAGMA, 255];
  if (insideBar(x, y, 0.46, 0.8, 0.79, 0.845)) return [...DIM, 255];

  // Play head over the canvas.
  if (insideTriangle(x, y, 0.36, 0.2, 0.36, 0.56, 0.66, 0.38)) return [...MAGMA, 255];

  return [...TILE, 255];
}

function render(size) {
  const samples = 4;
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          const [cr, cg, cb, ca] = sample(x, y);
          const alpha = ca / 255;
          r += cr * alpha;
          g += cg * alpha;
          b += cb * alpha;
          a += alpha;
        }
      }
      const total = samples * samples;
      const offset = (py * size + px) * 4;
      if (a === 0) {
        pixels.fill(0, offset, offset + 4);
        continue;
      }
      pixels[offset] = Math.round(r / a);
      pixels[offset + 1] = Math.round(g / a);
      pixels[offset + 2] = Math.round(b / a);
      pixels[offset + 3] = Math.round((a / total) * 255);
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
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

function png(size) {
  const pixels = render(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ico(sizes) {
  const images = sizes.map((size) => ({ size, data: png(size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = 6 + directory.length;
  images.forEach((image, index) => {
    const at = index * 16;
    directory[at] = image.size >= 256 ? 0 : image.size;
    directory[at + 1] = image.size >= 256 ? 0 : image.size;
    directory[at + 2] = 0;
    directory[at + 3] = 0;
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(image.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.data.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.data)]);
}

const files = [
  ['32x32.png', png(32)],
  ['128x128.png', png(128)],
  ['128x128@2x.png', png(256)],
  ['icon.png', png(512)],
  ['icon.ico', ico([16, 32, 48, 64, 128, 256])],
];

for (const [name, data] of files) {
  writeFileSync(join(outDir, name), data);
  console.log(`icons/${name}  ${(data.length / 1024).toFixed(1)} KB`);
}
