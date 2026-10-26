// src/lib/bubbleSprite.ts
// A disc sprite for the project count bubbles. Used with a symbol layer's
// `icon-text-fit: both`, so the disc stretches (nine-slice) around the number and
// the two can never drift apart, whatever the pitch or zoom.

export const BUBBLE_IMAGE_ID = "count-bubble";

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * 64x64 RGBA (premultiplied) disc: `fill` inside, a 2.5px `stroke` ring, transparent
 * outside, anti-aliased edges. Register with pixelRatio 2 and the nine-slice
 * metadata from `bubbleImageOptions()`.
 */
export function bubbleSprite(fill: string, stroke: string): { width: number; height: number; data: Uint8Array } {
  const size = 64;
  const c = size / 2;
  const r = 30;
  const strokeW = 2.5;
  const f = hexToRgb(fill);
  const s = hexToRgb(stroke);
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      // coverage of the disc (1 inside, 0 outside, soft 1px edge)
      const cover = Math.max(0, Math.min(1, r + 0.5 - d));
      // ring = outer band of the disc
      const ring = Math.max(0, Math.min(1, d - (r - strokeW) + 0.5));
      const rgb = [
        f[0] * (1 - ring) + s[0] * ring,
        f[1] * (1 - ring) + s[1] * ring,
        f[2] * (1 - ring) + s[2] * ring,
      ];
      const a = cover;
      const i = (y * size + x) * 4;
      data[i] = Math.round(rgb[0]! * a); // premultiplied
      data[i + 1] = Math.round(rgb[1]! * a);
      data[i + 2] = Math.round(rgb[2]! * a);
      data[i + 3] = Math.round(255 * a);
    }
  }
  return { width: size, height: size, data };
}

/** Nine-slice metadata: keep the rounded edges, stretch the middle. */
export function bubbleImageOptions() {
  return {
    pixelRatio: 2,
    stretchX: [[18, 46]] as [number, number][],
    stretchY: [[18, 46]] as [number, number][],
    content: [18, 18, 46, 46] as [number, number, number, number],
  };
}
