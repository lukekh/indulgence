import { describe, expect, it } from 'vitest';
import { C, seatPos } from '../../shared/constants';
import { poseAt, along, pathLength, enterPath, departPaths, approachPoint, seatedAt, slotPoint, type PriestPlan, candleShown } from '../src/motion';
import { cameraFor, project, standFacesLeft, viewportFor } from '../src/view';

const seat = { bay: 0, row: 1, half: 0, seat: 3 };
const [sx, sy] = seatPos(0, 1, 0, 3);

describe('projection', () => {
  it('looks straight up the nave: pews are horizontal, the altar is at the top', () => {
    const vp = viewportFor(1440, 866);
    const cam = cameraFor(15, vp);
    // Across the nave is screen x; toward the altar is up the screen.
    const [ax, ay] = project(cam, 15, 6);
    const [bx, by] = project(cam, 26, 6);
    expect(by).toBe(ay);
    expect(bx - ax).toBe(11 * C.TILE_W_PX);
    expect(project(cam, 15, 8)[1] - ay).toBe(2 * C.TILE_H_PX);
    expect(ax).toBe(Math.round(vp.baseW / 2));
    // The altar sits just below the top of the screen.
    expect(project(cam, 17, C.ALTAR_Y[0]!)[1]).toBeLessThan(60);
  });
});

describe('votive stands', () => {
  it('face in toward your column of pews from both sides', () => {
    const cam = cameraFor(C.BAY_W * 2 + C.AISLE_CENTRE_X, viewportFor(1440, 900));
    expect(cam.bay).toBe(2);
    // Your left arcade and those beyond it face right; your right arcade and beyond face left.
    expect([1, 2, 3, 4].map((a) => standFacesLeft(cam, a))).toEqual([false, false, true, true]);
  });

  it('step their tiers back away from the front, mirrored when facing left', () => {
    const front = slotPoint(3, 2);
    const back = slotPoint(3, 32);
    expect(back.x).toBeLessThan(front.x);
    expect(back.lift).toBeGreaterThan(front.lift);
    const centre = 3 * C.BAY_W + C.STAND_CENTRE_X;
    expect(slotPoint(3, 2, true).x - centre).toBeCloseTo(centre - front.x);
    expect(slotPoint(3, 32, true).x).toBeGreaterThan(slotPoint(3, 2, true).x);
    expect(slotPoint(3, 32, true).y).toBe(back.y);
  });
});

describe('paths', () => {
  it('walks axis-aligned segments and reports heading', () => {
    const path: [number, number][] = [
      [0, 0],
      [0, -4],
      [3, -4],
    ];
    expect(pathLength(path)).toBe(7);
    expect(along(path, 2)).toEqual({ p: [0, -2], dir: 'up', done: false });
    expect(along(path, 5)).toEqual({ p: [1, -4], dir: 'right', done: false });
    expect(along(path, 99).done).toBe(true);
  });

  it('comes up its side aisle from below the screen and side-steps into the pew', () => {
    const side = C.SIDE_AISLE_X[0]!;
    expect(enterPath(seat)).toEqual([
      [side, C.ENTRY_Y],
      [side, sy],
      [sx, sy],
    ]);
    expect(enterPath({ ...seat, entryY: 40 })[0]).toEqual([side, 40]);
    // Pews span the nave between the side aisles.
    expect(C.PEW_X[0]).toBeGreaterThan(side);
    expect(C.PEW_X[1]).toBeLessThan(C.SIDE_AISLE_X[1]!);
  });

  it('departs along its pew to the side aisle and the stand beside it, then out by the door', () => {
    const plan: PriestPlan = { ...seat, state: 'Departing', since: 0, candle: { arcade: 0, slot: 4 } };
    const { toStand, toDoor, approach } = departPaths(plan);
    expect(toStand[1]).toEqual([C.SIDE_AISLE_X[0], sy]);
    expect(toStand.at(-1)).toEqual(approach);
    expect(toDoor.at(-1)![1]).toBe(C.ENTRY_Y);
    // Right-half priests go to the next arcade and approach it from the west.
    expect(approachPoint(0, 1, 0)[0]).toBeLessThan(C.BAY_W + C.STAND_CENTRE_X);
  });
});

describe('poses over time', () => {
  it('walks in at WALK_TILES_PER_S (slowly), then kneels facing the altar', () => {
    const plan: PriestPlan = { ...seat, state: 'Entering', since: 1000 };
    const walkMs = (pathLength(enterPath(seat)) / C.WALK_TILES_PER_S) * 1000;
    expect(poseAt(plan, 1000)).toMatchObject({ x: C.SIDE_AISLE_X[0], y: C.ENTRY_Y, action: 'walk', dir: 'up' });
    expect(poseAt(plan, 1000 + walkMs + 10)).toMatchObject({ x: sx, y: sy, action: 'kneel', dir: 'up' });
  });

  it('comes up the aisle from behind, turns into the pew in profile, kneels facing the altar', () => {
    const plan: PriestPlan = { ...seat, state: 'Entering', since: 0 };
    const path = enterPath(seat);
    const aisleMs = (Math.abs(path[1]![1] - path[0]![1]) / C.WALK_TILES_PER_S) * 1000;
    const walkMs = (pathLength(path) / C.WALK_TILES_PER_S) * 1000;
    for (let t = 0; t < aisleMs; t += 250) expect(poseAt(plan, t).dir).toBe('up');
    // Left half: from the left side aisle, walking right along the pew.
    for (let t = aisleMs + 100; t < walkMs; t += 250) expect(poseAt(plan, t)).toMatchObject({ dir: 'right', action: 'walk' });
    expect(poseAt(plan, walkMs + 100)).toMatchObject({ dir: 'up', action: 'kneel' });
    // Right half: from the right side aisle, walking left.
    const right: PriestPlan = { ...seat, half: 1, state: 'Entering', since: 0 };
    const rp = enterPath(right);
    const rAisle = (Math.abs(rp[1]![1] - rp[0]![1]) / C.WALK_TILES_PER_S) * 1000;
    expect(poseAt(right, rAisle + 200).dir).toBe('left');
    // Leaving, it turns: along the pew in profile, and later toward the door.
    const leaving: PriestPlan = { ...seat, state: 'Departing', since: 0, candle: { arcade: 0, slot: 4 } };
    expect(poseAt(leaving, 500).dir).toBe('left');
    expect(poseAt(leaving, C.CANDLE_LIT_AFTER_MS + 2000).dir).toBe('down');
  });

  it('keeps walking after the first prayer if it has not reached its seat yet', () => {
    const plan: PriestPlan = { ...seat, state: 'Praying', since: 1500, enteredAt: 1000 };
    expect(poseAt(plan, 1600).action).toBe('walk');
  });

  it('knows when it sits down (prayers are said only from then on)', () => {
    const plan: PriestPlan = { ...seat, state: 'Praying', since: 1500, enteredAt: 1000, entryY: 40 };
    const at = seatedAt(plan)!;
    expect(at).toBe(1000 + (pathLength(enterPath(plan)) / C.WALK_TILES_PER_S) * 1000);
    expect(poseAt(plan, at - 50).action).toBe('walk');
    expect(poseAt(plan, at + 50).action).toBe('kneel');
    // Already seated before we saw it; and no longer once it is leaving.
    expect(seatedAt({ ...seat, state: 'Praying', since: 0 })).toBe(Number.NEGATIVE_INFINITY);
    expect(seatedAt({ ...seat, state: 'Departing', since: 0 })).toBeUndefined();
  });

  it('walks slowly to the stand, kneels, lights the candle before lit_at, then leaves', () => {
    const plan: PriestPlan = { ...seat, state: 'Departing', since: 0, candle: { arcade: 0, slot: 4 } };
    expect(poseAt(plan, 100).action).toBe('walk');
    const { toStand } = departPaths(plan);
    const arrive = (pathLength(toStand) / C.WALK_TILES_PER_S) * 1000;
    expect(arrive).toBeLessThan(C.CANDLE_LIT_AFTER_MS - C.LIGHT_CANDLE_MS);
    expect(poseAt(plan, arrive - 500).action).toBe('walk');
    expect(poseAt(plan, arrive + 500).action).toBe('kneel');
    const atLight = poseAt(plan, C.CANDLE_LIT_AFTER_MS - 500);
    expect(atLight.action).toBe('light');
    expect(atLight.dir).toBe('left');
    expect(poseAt(plan, C.CANDLE_LIT_AFTER_MS + 1000).action).toBe('walk');
    expect(poseAt(plan, C.PRIEST_REMOVE_AFTER_MS).action).toBe('gone');
  });

  it('walks straight out when there is no candle (forget)', () => {
    const plan: PriestPlan = { ...seat, state: 'Departing', since: 0 };
    expect(poseAt(plan, 0)).toMatchObject({ action: 'walk' });
    expect(poseAt(plan, C.PRIEST_REMOVE_AFTER_MS).action).toBe('gone');
  });
});

describe('a candle on its stand', () => {
  const litAt = 100_000;

  it('is not there while its priest walks over, though its place is kept', () => {
    expect(candleShown(litAt, litAt - 20_000, 'walk')).toBe(false);
    expect(candleShown(litAt, litAt - 1, 'walk')).toBe(false);
  });

  it('appears when the priest kneels at the stand, and stays while it is lit', () => {
    expect(candleShown(litAt, litAt - 9_000, 'kneel')).toBe(true);
    expect(candleShown(litAt, litAt - 1_000, 'light')).toBe(true);
  });

  it('is there once lit, whoever is or is not in view', () => {
    expect(candleShown(litAt, litAt)).toBe(true);
    expect(candleShown(litAt, litAt + 5, 'walk')).toBe(true);
    expect(candleShown(litAt, litAt + 3_600_000)).toBe(true);
  });

  it('with its priest out of view, appears as the lighting begins', () => {
    expect(candleShown(litAt, litAt - C.LIGHT_CANDLE_MS - 1)).toBe(false);
    expect(candleShown(litAt, litAt - C.LIGHT_CANDLE_MS)).toBe(true);
  });
});
