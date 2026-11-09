import { describe, expect, it } from 'vitest';
import { blur, designFor, dominantGlass, inLancet, lightThrough, rasterise, DESIGNS, GLASS, type Rgb } from '../src/glass';

/** Samples of a design on a grid over its window, (u, v) → glass. */
function samples(rows = 180, cols = 60): { u: number; v: number }[] {
  const out: { u: number; v: number }[] = [];
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) out.push({ u: (i + 0.5) / rows, v: (j + 0.5) / cols });
  return out;
}

describe('the lancet', () => {
  /** How much of the window's width is glass at u. */
  const width = (u: number) => samples(1, 400).filter((p) => inLancet(u, p.v)).length / 400;

  it('has straight sides from the sill, then a pointed arch', () => {
    for (const u of [0.01, 0.2, 0.4, 0.6]) expect(width(u)).toBeCloseTo(1, 1);
    let last = 1;
    for (let u = 0.7; u < 1; u += 0.03) {
      expect(width(u)).toBeLessThanOrEqual(last);
      last = width(u);
    }
    expect(width(0.99)).toBeLessThan(0.15);
    expect(inLancet(0.99, 0.5)).toBe(true);
  });

  it('is symmetric across its middle, and empty outside it', () => {
    for (const { u, v } of samples(40, 20)) expect(inLancet(u, v)).toBe(inLancet(u, 1 - v));
    for (const [u, v] of [[-0.01, 0.5], [1.01, 0.5], [0.5, -0.01], [0.5, 1.01], [0.95, 0.05], [0.95, 0.95]] as const) expect(inLancet(u, v)).toBe(false);
  });
});

describe('the window designs', () => {
  const palette = Object.values(GLASS);

  it('are glass only inside the arch, with leads between the pieces', () => {
    for (const d of DESIGNS) {
      let lit = 0;
      for (const { u, v } of samples()) {
        const c = d.glass(u, v);
        if (!inLancet(u, v)) expect(c).toBeUndefined();
        if (c) lit++;
      }
      // Leads and saddle bars stop some of the light, but most comes through.
      expect(lightThrough(d)).toBeGreaterThan(0.4);
      expect(lightThrough(d)).toBeLessThan(0.85);
      expect(lit).toBeGreaterThan(0);
    }
  });

  it('are made of medieval glass, mostly cobalt blue and ruby', () => {
    const count = new Map<Rgb, number>();
    for (const d of DESIGNS) {
      for (const { u, v } of samples()) {
        const c = d.glass(u, v);
        if (!c) continue;
        expect(palette).toContain(c);
        count.set(c, (count.get(c) ?? 0) + 1);
      }
    }
    const share = (c: Rgb) => count.get(c) ?? 0;
    const blue = share(GLASS.cobalt) + share(GLASS.azure);
    for (const c of palette) if (c !== GLASS.cobalt && c !== GLASS.azure) expect(blue).toBeGreaterThan(share(c));
    for (const c of palette) if (c !== GLASS.cobalt && c !== GLASS.azure && c !== GLASS.ruby) expect(share(GLASS.ruby)).toBeGreaterThan(share(c));
  });

  it('each look different', () => {
    const names = new Set(DESIGNS.map((d) => d.name));
    expect(names.size).toBe(DESIGNS.length);
    expect(DESIGNS.length).toBeGreaterThanOrEqual(4);
    const signature = (d: (typeof DESIGNS)[number]) => samples(30, 10).map(({ u, v }) => d.glass(u, v)?.join(',') ?? '-').join(' ');
    expect(new Set(DESIGNS.map(signature)).size).toBe(DESIGNS.length);
  });

  it('are chosen by a hash of the bay, its wall and the pool: never the same twice in a bay', () => {
    for (let bay = -300; bay <= 300; bay++) {
      for (const fromLeft of [true, false]) {
        expect(designFor(bay, fromLeft, 0)).toBe(designFor(bay, fromLeft, 0));
        expect(designFor(bay, fromLeft, 1)).not.toBe(designFor(bay, fromLeft, 0));
      }
    }
  });

  it('give each ray of light the glass that fills its part of the window', () => {
    for (const d of DESIGNS) for (const [u0, u1] of [[0, 0.25], [0.5, 0.75]]) expect(palette).toContain(dominantGlass(d, u0!, u1!));
  });
});

describe('drawing the light', () => {
  it('rasterises glass as premultiplied pixels, dark where no light comes through', () => {
    const px = rasterise(2, 1, (x) => (x < 1 ? GLASS.ruby : undefined), 2);
    expect(Array.from(px.slice(0, 4)).map((n) => Math.round(n * 255))).toEqual([...GLASS.ruby, 255]);
    expect(Array.from(px.slice(4))).toEqual([0, 0, 0, 0]);
  });

  it('blurs without losing light', () => {
    const w = 21;
    const px = new Float32Array(w * w * 4);
    px.set([0.5, 0.25, 1, 1], (10 * w + 10) * 4);
    blur(px, w, w, 2);
    const total = [0, 1, 2, 3].map((c) => px.filter((_, i) => i % 4 === c).reduce((a, b) => a + b, 0));
    total.forEach((t, c) => expect(t).toBeCloseTo([0.5, 0.25, 1, 1][c]!, 4));
    expect(px[(10 * w + 10) * 4 + 3]).toBeLessThan(0.2);
    expect(px[(10 * w + 14) * 4 + 3]).toBeGreaterThan(0);
  });
});
