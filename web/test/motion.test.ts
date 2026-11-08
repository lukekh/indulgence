import { describe, expect, it } from 'vitest';
import { C, seatPos } from '../../shared/constants';
import { poseAt, along, pathLength, enterPath, departPaths, approachPoint, type PriestPlan } from '../src/motion';
import { toScreen } from '../src/iso';

const seat = { bay: 0, row: 1, half: 0, seat: 3 };
const [sx, sy] = seatPos(0, 1, 0, 3);

describe('projection', () => {
  it('is 2:1 isometric with 16 × 8 tiles', () => {
    expect(toScreen(0, 0)).toEqual([0, 0]);
    expect(toScreen(1, 0)).toEqual([8, 4]);
    expect(toScreen(0, 1)).toEqual([-8, 4]);
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

  it('enters from the door, up the aisle, sideways to the seat', () => {
    expect(enterPath(seat)).toEqual([
      [C.AISLE_CENTRE_X, C.DOOR_Y],
      [C.AISLE_CENTRE_X, sy],
      [sx, sy],
    ]);
  });

  it('departs via the aisle and the front gap to the stand, then out by the door', () => {
    const plan: PriestPlan = { ...seat, state: 'Departing', since: 0, candle: { arcade: 0, slot: 4 } };
    const { toStand, toDoor, approach } = departPaths(plan);
    expect(toStand[2]).toEqual([C.AISLE_CENTRE_X, C.FRONT_GAP_Y]);
    expect(toStand.at(-1)).toEqual(approach);
    expect(toDoor.at(-1)).toEqual([C.AISLE_CENTRE_X, C.DOOR_Y]);
    // Right-half priests go to the next arcade and approach it from the west.
    expect(approachPoint(0, 1, 0)[0]).toBeLessThan(C.BAY_W + C.STAND_CENTRE_X);
  });
});

describe('poses over time', () => {
  it('walks in at 4 tiles per second, then kneels facing the altar', () => {
    const plan: PriestPlan = { ...seat, state: 'Entering', since: 1000 };
    const walkMs = (pathLength(enterPath(seat)) / C.WALK_TILES_PER_S) * 1000;
    expect(poseAt(plan, 1000)).toMatchObject({ x: C.AISLE_CENTRE_X, y: C.DOOR_Y, action: 'walk', dir: 'up' });
    expect(poseAt(plan, 1000 + walkMs + 10)).toMatchObject({ x: sx, y: sy, action: 'kneel', dir: 'up' });
  });

  it('keeps walking after the first prayer if it has not reached its seat yet', () => {
    const plan: PriestPlan = { ...seat, state: 'Praying', since: 1500, enteredAt: 1000 };
    expect(poseAt(plan, 1600).action).toBe('walk');
  });

  it('lights the candle before lit_at, then leaves and is gone by removal', () => {
    const plan: PriestPlan = { ...seat, state: 'Departing', since: 0, candle: { arcade: 0, slot: 4 } };
    expect(poseAt(plan, 100).action).toBe('walk');
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
