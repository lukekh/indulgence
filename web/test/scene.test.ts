import { describe, expect, it } from 'vitest';
import { C } from '../../shared/constants';
import { glowsAround, windowLightAt, windowPoint, GLOW_GAP_ROWS, GLOW_ROWS, type Glow } from '../src/scene';
import { DESIGNS, GLASS, inLancet } from '../src/glass';

describe('window light', () => {
  // Your bay is bay 0; the screen shows its neighbours on either side, down to y = 40.
  const glows = glowsAround(0, -20, 50, 40);
  const inBay = (b: number) => glows.filter((g) => g.bay === b);
  const rows = (tiles: number) => tiles / C.PEW_STEP_Y;

  it('falls twice down your column of pews, 3 to 4 rows deep with 5 rows between', () => {
    const [a, b] = inBay(0);
    expect(inBay(0)).toHaveLength(2);
    for (const g of [a!, b!]) expect(rows(g.y1 - g.y0)).toBe(GLOW_ROWS);
    expect(rows(b!.y0 - a!.y1)).toBe(GLOW_GAP_ROWS);
    expect(a!.y0).toBeGreaterThanOrEqual(C.ROW_Y[0]! - 1.5);
    expect(b!.y1).toBeLessThanOrEqual(40);
  });

  it('falls once in each column beside it, in the gap between yours', () => {
    const [a, b] = inBay(0);
    for (const bay of [-1, 1]) {
      expect(inBay(bay)).toHaveLength(1);
      const g = inBay(bay)[0]!;
      expect(g.y0).toBeGreaterThanOrEqual(a!.y1);
      expect(g.y1).toBeLessThanOrEqual(b!.y0);
    }
  });

  it('starts a third of the way along the pews from its window and reaches the far side of the nave', () => {
    const third = (C.PEW_X[1]! - C.PEW_X[0]!) / 3;
    for (const g of [...inBay(-1), ...inBay(0)]) {
      expect(g.fromLeft).toBe(true);
      expect(g.x0 - g.bay * C.BAY_W).toBeCloseTo(C.PEW_X[0]! + third);
      expect(g.x1).toBeGreaterThan((g.bay * C.BAY_W) + C.SIDE_AISLE_X[1]!);
    }
    // To the right, lit from the right, so the part of the bay in view catches it.
    const right = inBay(1)[0]!;
    expect(right.fromLeft).toBe(false);
    expect(right.x0).toBeLessThan(C.BAY_W + C.SIDE_AISLE_X[0]!);
    expect(right.x1 - C.BAY_W).toBeCloseTo(C.PEW_X[1]! - third);
  });

  it('never falls in an arcade, among the columns and votive stands', () => {
    for (const g of glows) {
      const bx = g.bay * C.BAY_W;
      expect(g.x0).toBeGreaterThan(bx + C.ARCADE_X[1]! + 0.4);
      expect(g.x1).toBeLessThan(bx + C.BAY_W + C.ARCADE_X[0]! - 0.4);
    }
  });

  it('comes through one of the window designs, the same for every viewer', () => {
    const again = glowsAround(0, -20, 50, 40);
    glows.forEach((g, i) => {
      expect(DESIGNS).toContain(g.design);
      expect(again[i]!.design).toBe(g.design);
    });
  });

  it('shows a different window in each of the two pools in your bay', () => {
    for (let centre = -60; centre <= 60; centre++) {
      const [a, b] = glowsAround(centre, centre * C.BAY_W - 20, centre * C.BAY_W + 50, 40).filter((g) => g.bay === centre);
      expect(a!.design).not.toBe(b!.design);
    }
  });

  it('chooses among all the designs from bay to bay', () => {
    const seen = new Set<string>();
    for (let centre = -60; centre <= 60; centre++) {
      for (const g of glowsAround(centre, centre * C.BAY_W - 20, centre * C.BAY_W + 50, 40)) seen.add(g.design.name);
    }
    expect([...seen].sort()).toEqual(DESIGNS.map((d) => d.name).sort());
  });
});

describe('window light at a point', () => {
  const glows = glowsAround(0, -20, 50, 40);
  /** World position of (u, v) in a pool's window. */
  const at = (g: Glow, u: number, v: number): [number, number] => [g.fromLeft ? g.x0 + u * (g.x1 - g.x0) : g.x1 - u * (g.x1 - g.x0), g.y0 + v * (g.y1 - g.y0)];
  /** A point well inside the window where glass (not lead) lets light through. */
  const glassPoint = (g: Glow): [number, number] => {
    for (let u = 0.3; u < 0.7; u += 0.01) {
      for (let v = 0.3; v < 0.7; v += 0.01) if (g.design.glass(u, v)) return [u, v];
    }
    throw new Error('no glass');
  };

  it("is the window's glass where it falls, at full strength", () => {
    for (const g of glows) {
      const [u, v] = glassPoint(g);
      const [x, y] = at(g, u, v);
      expect(windowPoint(g, x, y)[0]).toBeCloseTo(u);
      expect(windowPoint(g, x, y)[1]).toBeCloseTo(v);
      expect(windowLightAt([g], x, y)).toEqual({ colour: g.design.glass(u, v), strength: 1 });
    }
  });

  it('is the nearest glass on a lead, and nothing outside the arch', () => {
    const palette = Object.values(GLASS);
    for (const g of glows) {
      // The lead round the edge of the window, just inside it.
      const lead = at(g, 0.5, 0.012);
      expect(g.design.glass(0.5, 0.012)).toBeUndefined();
      expect(palette).toContain(windowLightAt([g], ...lead)?.colour);
      // Beside the pointed apex, past the sill, and well off to either side.
      for (const [u, v] of [[0.97, 0.06], [0.97, 0.94], [-0.1, 0.5], [0.5, -0.2], [0.5, 1.2]] as const) {
        expect(inLancet(u, v)).toBe(false);
        expect(windowLightAt([g], ...at(g, u, v))).toBeUndefined();
      }
    }
    // Where the windows' light falls on no pool at all.
    expect(windowLightAt(glows, C.STAND_CENTRE_X, 12)).toBeUndefined();
  });

  it('lies sill toward its window: on the left in your bay, on the right to your right', () => {
    const mine = glows.find((g) => g.bay === 0)!;
    const right = glows.find((g) => g.bay === 1)!;
    const mid = (g: Glow) => (g.y0 + g.y1) / 2;
    // Across the sill the pool is the window's full width; at the far end, only its point.
    expect(windowLightAt([mine], mine.x0 + 0.5, mine.y0 + 0.6)).toBeDefined();
    expect(windowLightAt([mine], mine.x1 - 0.3, mine.y0 + 0.6)).toBeUndefined();
    expect(windowLightAt([mine], mine.x1 - 0.3, mid(mine))?.strength).toBeGreaterThan(0);
    expect(windowLightAt([right], right.x1 - 0.5, right.y0 + 0.6)).toBeDefined();
    expect(windowLightAt([right], right.x0 + 0.3, right.y0 + 0.6)).toBeUndefined();
  });
});
