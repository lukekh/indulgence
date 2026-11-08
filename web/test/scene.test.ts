import { describe, expect, it } from 'vitest';
import { C } from '../../shared/constants';
import { glowsBetween, GLASS, GLOW_GAP_ROWS, GLOW_ROWS } from '../src/scene';

describe('window light', () => {
  const glows = glowsBetween(0, C.BAY_W - 1, 400).filter((g) => g.bay === 0);

  it('lies 3 to 4 rows deep down each bay, with 5 rows of shadow between', () => {
    expect(glows.length).toBeGreaterThan(10);
    for (const g of glows) expect((g.y1 - g.y0) / C.PEW_STEP_Y).toBe(GLOW_ROWS);
    for (let i = 1; i < glows.length; i++) expect((glows[i]!.y0 - glows[i - 1]!.y1) / C.PEW_STEP_Y).toBe(GLOW_GAP_ROWS);
  });

  it('starts a third of the way along the pews and reaches the far wall', () => {
    for (const g of glows) {
      expect(g.x0).toBeCloseTo(C.PEW_X[0]! + (C.PEW_X[1]! - C.PEW_X[0]!) / 3);
      expect(g.x1).toBe(C.BAY_W);
    }
  });

  it('mixes pink, orange, green and blue glass', () => {
    for (const g of glows) expect([...g.colours].sort()).toEqual([...GLASS].sort());
  });

  it('is laid out the same for every viewer', () => {
    expect(glowsBetween(0, C.BAY_W - 1, 400)).toEqual(glowsBetween(0, C.BAY_W - 1, 400));
  });
});
