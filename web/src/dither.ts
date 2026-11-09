// Obra Dinn–style ordered dithering. After the scene is drawn and candlelit, every base
// pixel is reduced to its luminance and dithered with a 4 × 4 Bayer matrix onto a ramp of
// four dark greys. The coloured window light is laid over the result afterwards as a soft
// glow (scene.ts, applyRays), so it is the only colour on screen.

/** Bayer 4 × 4 thresholds, 0 … 1. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

/** Dark to light. Faintly warm greys, like old print. */
export const GREYS: [number, number, number][] = [
  [10, 9, 9],
  [38, 36, 34],
  [84, 80, 75],
  [170, 165, 155],
];

/** Lifts dark mid-tones a little before quantising, so candlelit detail survives. */
const GAMMA = 0.75;

let lut: Uint8Array | undefined;
function luminanceLut(): Uint8Array {
  if (lut) return lut;
  lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round(Math.pow(i / 255, GAMMA) * 255);
  return lut;
}

/** Dither the canvas in place onto the grey ramp. */
export function ditherFrame(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const img = ctx.getImageData(0, 0, width, height);
  const d = img.data;
  const g = luminanceLut();
  const levels = GREYS.length - 1;
  for (let y = 0, i = 0; y < height; y++) {
    const row = (y & 3) * 4;
    for (let x = 0; x < width; x++, i += 4) {
      const t = BAYER[row + (x & 3)]!;
      const scaled = (g[Math.round(0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!)]! / 255) * levels;
      const base = Math.floor(scaled);
      const c = GREYS[Math.min(levels, base + (scaled - base > t ? 1 : 0))]!;
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
