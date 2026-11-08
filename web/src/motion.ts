// Client-side movement. The server stores only state changes (`state`, `state_since`,
// `lit_at`); every walk is animated here along fixed waypoints at 4 tiles per second.

import { C, seatPos, standX } from '../../shared/constants';

export type Dir = 'up' | 'left' | 'down' | 'right';
export type Action = 'walk' | 'kneel' | 'light' | 'gone';
export type Pt = [number, number];

export interface PriestPlan {
  bay: number;
  row: number;
  half: number;
  seat: number;
  state: 'Entering' | 'Praying' | 'Departing';
  /** ms (server clock) when the current state began. */
  since: number;
  /** ms when we first saw this priest entering, so a walk can finish after the first prayer. */
  enteredAt?: number;
  /** Stand slot of the candle this priest lights on departure, if any. */
  candle?: { arcade: number; slot: number };
}

export interface Pose {
  x: number;
  y: number;
  dir: Dir;
  action: Action;
  /** Seconds spent in the current action (for animation frames). */
  t: number;
  alpha: number;
}

const SPEED = C.WALK_TILES_PER_S;
const MAX_SPEED = 12;
const LIT = C.CANDLE_LIT_AFTER_MS;
const REMOVE = C.PRIEST_REMOVE_AFTER_MS;

export function aisleX(bay: number): number {
  return C.BAY_W * bay + C.AISLE_CENTRE_X;
}

/** Fine position of a candle slot on its stand: 4 tiers stepping back, 10 along y. */
export function slotPoint(arcade: number, slot: number): { x: number; y: number; lift: number } {
  const tier = Math.floor(slot / C.STAND_SLOTS_PER_TIER);
  const k = slot % C.STAND_SLOTS_PER_TIER;
  const span = C.STAND_Y[1]! - C.STAND_Y[0]! + 1;
  return {
    x: C.BAY_W * arcade + C.STAND_X[1]! - tier * 0.7,
    y: C.STAND_Y[0]! + 0.25 + (k * (span - 0.5)) / C.STAND_SLOTS_PER_TIER,
    lift: tier * 3,
  };
}

/** Where a priest stands to light a candle: beside the stand, on the side facing its bay. */
export function approachPoint(bay: number, arcade: number, slot: number): Pt {
  const y = Math.round(slotPoint(arcade, slot).y);
  return arcade <= bay ? [standX(arcade) + 3, y] : [standX(arcade) - 3, y];
}

export function pathLength(path: Pt[]): number {
  let L = 0;
  for (let i = 1; i < path.length; i++) L += Math.abs(path[i]![0] - path[i - 1]![0]) + Math.abs(path[i]![1] - path[i - 1]![1]);
  return L;
}

/** Point and heading `d` tiles along an axis-aligned path. */
export function along(path: Pt[], d: number): { p: Pt; dir: Dir; done: boolean } {
  let rest = Math.max(0, d);
  let dir: Dir = 'up';
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1]!;
    const [bx, by] = path[i]!;
    const len = Math.abs(bx - ax) + Math.abs(by - ay);
    if (len === 0) continue;
    dir = bx > ax ? 'right' : bx < ax ? 'left' : by > ay ? 'down' : 'up';
    if (rest <= len) {
      const f = rest / len;
      return { p: [ax + (bx - ax) * f, ay + (by - ay) * f], dir, done: false };
    }
    rest -= len;
  }
  return { p: path[path.length - 1]!, dir, done: true };
}

export function enterPath(p: Pick<PriestPlan, 'bay' | 'row' | 'half' | 'seat'>): Pt[] {
  const [sx, sy] = seatPos(p.bay, p.row, p.half, p.seat);
  const ax = aisleX(p.bay);
  return [
    [ax, C.DOOR_Y],
    [ax, sy],
    [sx, sy],
  ];
}

export function departPaths(p: PriestPlan): { toStand: Pt[]; toDoor: Pt[]; approach?: Pt } {
  const [sx, sy] = seatPos(p.bay, p.row, p.half, p.seat);
  const ax = aisleX(p.bay);
  if (!p.candle) {
    return { toStand: [[sx, sy]], toDoor: [[sx, sy], [ax, sy], [ax, C.DOOR_Y]] };
  }
  const approach = approachPoint(p.bay, p.candle.arcade, p.candle.slot);
  return {
    approach,
    toStand: [[sx, sy], [ax, sy], [ax, C.FRONT_GAP_Y], [approach[0], C.FRONT_GAP_Y], approach],
    toDoor: [approach, [approach[0], C.BACK_WALK_Y], [ax, C.BACK_WALK_Y], [ax, C.DOOR_Y]],
  };
}

/** Where a priest is, which way it faces and what it is doing at server time `now`. */
export function poseAt(p: PriestPlan, now: number): Pose {
  const [sx, sy] = seatPos(p.bay, p.row, p.half, p.seat);
  const kneel = (t: number): Pose => ({ x: sx, y: sy, dir: 'up', action: 'kneel', t, alpha: 1 });

  if (p.state !== 'Departing') {
    const start = p.enteredAt ?? (p.state === 'Entering' ? p.since : undefined);
    if (start === undefined) return kneel((now - p.since) / 1000);
    const path = enterPath(p);
    const t = Math.max(0, now - start) / 1000;
    const a = along(path, t * SPEED);
    if (a.done) return kneel(t - pathLength(path) / SPEED);
    return { x: a.p[0], y: a.p[1], dir: a.dir, action: 'walk', t, alpha: 1 };
  }

  const t = Math.max(0, now - p.since);
  const { toStand, toDoor, approach } = departPaths(p);
  if (approach) {
    const walkMs = LIT - C.LIGHT_CANDLE_MS;
    const L1 = pathLength(toStand);
    const v1 = Math.min(MAX_SPEED, Math.max(SPEED, L1 / (walkMs / 1000)));
    if (t < LIT) {
      const a = along(toStand, (t / 1000) * v1);
      if (!a.done) return { x: a.p[0], y: a.p[1], dir: a.dir, action: 'walk', t: t / 1000, alpha: 1 };
      const faceStand: Dir = approach[0] > standX(p.candle!.arcade) ? 'left' : 'right';
      const arrived = (L1 / v1) * 1000;
      return { x: approach[0], y: approach[1], dir: faceStand, action: 'light', t: (t - arrived) / 1000, alpha: 1 };
    }
  }
  const startExit = approach ? LIT : 0;
  const exitMs = REMOVE - startExit - 1000;
  const L2 = pathLength(toDoor);
  const v2 = Math.min(MAX_SPEED, Math.max(SPEED, L2 / (exitMs / 1000)));
  const te = (t - startExit) / 1000;
  const a = along(toDoor, te * v2);
  if (!a.done) return { x: a.p[0], y: a.p[1], dir: a.dir, action: 'walk', t: te, alpha: 1 };
  const fade = 1 - (te - L2 / v2);
  return { x: a.p[0], y: a.p[1], dir: 'down', action: fade > 0 ? 'walk' : 'gone', t: te, alpha: Math.max(0, fade) };
}
