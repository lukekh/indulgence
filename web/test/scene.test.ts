import { describe, expect, it } from 'vitest';
import { C } from '../../shared/constants';
import { glowsAround, GLASS, GLOW_GAP_ROWS, GLOW_ROWS } from '../src/scene';

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

  it('mixes pink, orange, green and blue glass', () => {
    for (const g of glows) expect([...g.colours].sort()).toEqual([...GLASS].sort());
  });
});
