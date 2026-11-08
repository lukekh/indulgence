// Obra Dinn–style ordered dithering. After the scene is drawn and candlelit, every base
// pixel is reduced to its luminance and dithered with a 4 × 4 Bayer matrix onto a ramp of
// four dark greys. Where a shaft of coloured light falls, the dither picks from that
// colour's ramp instead, so the shafts are the only colour on screen.

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

/**
 * Dither the canvas in place. `rays`, if given, is a same-sized RGBA buffer whose alpha is
 * the strength of coloured light at each pixel and whose colour is that light's hue.
 */
export function ditherFrame(ctx: CanvasRenderingContext2D, width: number, height: number, rays?: Uint8ClampedArray) {
  const img = ctx.getImageData(0, 0, width, height);
  const d = img.data;
  const g = luminanceLut();
  const levels = GREYS.length - 1;
  for (let y = 0, i = 0; y < height; y++) {
    const row = (y & 3) * 4;
    for (let x = 0; x < width; x++, i += 4) {
      const t = BAYER[row + (x & 3)]!;
      let lum = g[Math.round(0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!)]! / 255;
      const ray = rays ? rays[i + 3]! / 255 : 0;
      if (ray > 0) lum = Math.min(1, lum + ray * 0.45);
      const scaled = lum * levels;
      const base = Math.floor(scaled);
      const level = Math.min(levels, base + (scaled - base > t ? 1 : 0));
      if (ray > 0 && level > 0 && ray * 1.6 > t) {
        // Lit by stained glass: this pixel takes the glass colour at the dithered brightness.
        const k = 0.35 + 0.65 * (level / levels);
        d[i] = Math.round(rays![i]! * k);
        d[i + 1] = Math.round(rays![i + 1]! * k);
        d[i + 2] = Math.round(rays![i + 2]! * k);
      } else {
        const c = GREYS[level]!;
        d[i] = c[0];
        d[i + 1] = c[1];
        d[i + 2] = c[2];
      }
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
