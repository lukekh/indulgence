// The thurifer: a priest who walks the length of the nave swinging a thurible.
//
// It is not stored anywhere. Its position is a pure function of server time, so every
// viewer sees the same procession at the same moment. Thurifers walk along the front gap,
// one every SPACING tiles, at NPC_TILES_PER_S; any point of the nave sees one pass every
// NPC_INTERVAL_MS (two minutes).

import { C } from '../../shared/constants';

export const NPC_SPEED = C.NPC_TILES_PER_S;
export const NPC_SPACING = (C.NPC_TILES_PER_S * C.NPC_INTERVAL_MS) / 1000;
export const NPC_LANE_Y = C.NPC_LANE_Y;
/** One full swing of the thurible, ms. */
export const SWING_MS = 1700;

export interface Thurifer {
  /** Stable index: thurifer j stands at NPC_SPEED·t − j·NPC_SPACING. */
  j: number;
  x: number;
  y: number;
}

/** World x of thurifer j at server time `now` (ms since the epoch). */
export function thuriferX(j: number, now: number): number {
  return (NPC_SPEED * now) / 1000 - j * NPC_SPACING;
}

/** Thurifers whose lane position lies within [x0, x1] at `now`. */
export function thurifersBetween(now: number, x0: number, x1: number): Thurifer[] {
  const front = (NPC_SPEED * now) / 1000;
  const out: Thurifer[] = [];
  for (let j = Math.ceil((front - x1) / NPC_SPACING); j <= Math.floor((front - x0) / NPC_SPACING); j++) {
    out.push({ j, x: thuriferX(j, now), y: NPC_LANE_Y });
  }
  return out;
}

/** Thurible swing, -1 … 1. */
export function swing(now: number): number {
  return Math.sin((2 * Math.PI * now) / SWING_MS);
}

/** Server time at or after `after` when a thurifer is at world x `x`. */
export function nextPassAt(x: number, after: number): number {
  const front = (NPC_SPEED * after) / 1000;
  const behind = (((front - x) % NPC_SPACING) + NPC_SPACING) % NPC_SPACING; // how far past x the nearest thurifer is
  const toGo = behind === 0 ? 0 : NPC_SPACING - behind;
  return after + (toGo / NPC_SPEED) * 1000;
}

/** The incensation prayer from the Roman Missal, shown when hovering a thurifer. */
export const THURIFER_PRAYER = 'Incensum istud a te benedictum ascendat ad te, Domine, et descendat super nos misericordia tua.';
