import { describe, expect, it } from 'vitest';
import { C } from '../../shared/constants';
import { thurifersBetween, thuriferX, nextPassAt, swing, NPC_SPACING, NPC_SPEED } from '../src/npc';
import { viewportFor, cameraFor, visibleTiles, project } from '../src/iso';

const T = Date.UTC(2026, 10, 9, 12, 0, 0);

describe('thurifer', () => {
  it('passes any point of the nave every two minutes', () => {
    for (const x of [-500, -31, 0, 17, 42, 9000]) {
      const first = nextPassAt(x, T);
      expect(first).toBeGreaterThanOrEqual(T);
      expect(first - T).toBeLessThan(C.NPC_INTERVAL_MS);
      const second = nextPassAt(x, first + 1);
      expect(second - first).toBeCloseTo(C.NPC_INTERVAL_MS, -1);
      // Someone really is there at that moment.
      expect(thurifersBetween(first, x - 0.01, x + 0.01)).toHaveLength(1);
    }
  });

  it('walks slowly along the nave in +x, on the front-gap lane', () => {
    const [th] = thurifersBetween(T, 0, NPC_SPACING);
    expect(th!.y).toBe(C.NPC_LANE_Y);
    expect(thuriferX(th!.j, T + 10_000) - th!.x).toBeCloseTo(10 * NPC_SPEED);
    expect(NPC_SPEED).toBeLessThanOrEqual(1);
  });

  it('is the same for every viewer: a pure function of server time', () => {
    const a = thurifersBetween(T, -200, 200);
    const b = thurifersBetween(T, -200, 200);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(Math.floor(400 / NPC_SPACING));
    expect(a.length).toBeLessThanOrEqual(Math.ceil(400 / NPC_SPACING));
    for (const th of a) expect(th.x).toBeGreaterThanOrEqual(-200);
  });

  it('swings the thurible back and forth', () => {
    const values = Array.from({ length: 40 }, (_, i) => swing(T + i * 50));
    expect(Math.max(...values)).toBeGreaterThan(0.9);
    expect(Math.min(...values)).toBeLessThan(-0.9);
  });
});

describe('full-screen viewport', () => {
  it('covers the whole display with an integer pixel scale', () => {
    const vp = viewportFor(1440, 866);
    expect(vp.scale).toBe(3);
    expect(vp.baseW * vp.scale).toBeGreaterThanOrEqual(1440);
    expect(vp.baseH * vp.scale).toBeGreaterThanOrEqual(866);
    expect(viewportFor(390, 844).scale).toBe(1);
  });

  it('draws enough tiles to reach every corner', () => {
    const vp = viewportFor(1920, 1080);
    const cam = cameraFor(15, 8, vp);
    const { x0, x1, yMax } = visibleTiles(cam, vp);
    // Bottom-left and bottom-right corners land on drawn floor.
    for (const [x, y] of [
      [x0 + 3, yMax - 2],
      [x1 - 3, 0],
    ] as const) {
      const [sx, sy] = project(cam, x, y);
      expect(sx).toBeDefined();
      expect(sy).toBeDefined();
    }
    expect(x1 - x0).toBeGreaterThan(60);
    expect(yMax).toBeGreaterThan(C.DOOR_Y);
  });
});
