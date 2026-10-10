// App icon drawn in code: a near-black macOS-style rounded square with a single off-white mark,
// a thin ring around a small solid dot. Pure pixel math (no Electron), so the same drawing feeds
// the runtime dock icon (icon.js) and the build-time .icns (scripts/build-app.mjs).

const BG = [0x11, 0x12, 0x14];
const MARK = [0xec, 0xec, 0xee];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function roundedRectDist(px, py, c, half, r) {
  const qx = Math.abs(px - c) - (half - r);
  const qy = Math.abs(py - c) - (half - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// Calls put(offset, r, g, b, coverage) for every covered pixel; r/g/b are 0..255 floats, coverage 0..1.
function draw(size, put) {
  const c = size / 2;
  const half = size * 0.4; // ~10% margin, per Apple's icon grid
  const radius = size * 0.18; // ~22% of the body, close to the macOS squircle
  const ringR = size * 0.17; // ring centerline
  const ringW = size * 0.012; // half stroke width
  const dotR = size * 0.035;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const shape = clamp01(0.5 - roundedRectDist(px, py, c, half, radius));
      if (shape === 0) continue;
      const d = Math.hypot(px - c, py - c);
      const ring = clamp01(ringW + 0.5 - Math.abs(d - ringR));
      const dot = clamp01(dotR + 0.5 - d);
      const [r, g, b] = mix(BG, MARK, Math.max(ring, dot));
      put((y * size + x) * 4, r, g, b, shape);
    }
  }
}

// BGRA, premultiplied alpha (Skia N32 on macOS) — what nativeImage.createFromBitmap expects.
export function iconBGRA(size = 512) {
  const buf = Buffer.alloc(size * size * 4);
  draw(size, (o, r, g, b, a) => {
    buf[o] = Math.round(b * a);
    buf[o + 1] = Math.round(g * a);
    buf[o + 2] = Math.round(r * a);
    buf[o + 3] = Math.round(255 * a);
  });
  return buf;
}

// Straight (non-premultiplied) RGBA — what PNG expects.
export function iconRGBA(size = 512) {
  const buf = Buffer.alloc(size * size * 4);
  draw(size, (o, r, g, b, a) => {
    buf[o] = Math.round(r);
    buf[o + 1] = Math.round(g);
    buf[o + 2] = Math.round(b);
    buf[o + 3] = Math.round(255 * a);
  });
  return buf;
}
