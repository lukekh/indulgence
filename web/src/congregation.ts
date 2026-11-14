// The standing congregation: priests who are always there.
//
// Every bay has between NPC_MIN and NPC_MAX of them, kneeling in the same pews for every
// viewer, because who they are and where they sit is worked out from the bay's number alone
// (like the thurifer and the windows, they are not in the database). They say the canned
// prayers, one every pacing slot, each on its own beat.
//
// They give way to real priests. One whose seat a real priest takes is not there; one who
// sits close enough to a real priest that their prayers would run into each other keeps
// silent, and only kneels.

import { C, seatPos } from '../../shared/constants';

export const NPC_MIN = 5;
export const NPC_MAX = 30;

/** As the module's seating has it: how close two priests' prayers collide (geometry.rs). */
export const PRAYER_CLEAR_X = 8;
export const PRAYER_CLEAR_NEXT_ROW_X = 4;

export type NpcVestment = 'Friar' | 'Priest' | 'Bishop' | 'Cardinal';

export interface Npc {
  /** Negative, so it can never be a real priest's id. */
  id: bigint;
  bay: number;
  row: number;
  half: number;
  seat: number;
  x: number;
  y: number;
  vestment: NpcVestment;
  seed: number;
}

/** A well-mixed 32-bit hash of two integers. */
export function mix(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b ^ 0xc2b2ae35, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

const ROWS = C.ROW_Y.length;
const SEATS = ROWS * 2 * C.SEATS_PER_HALF_ROW;

function vestmentFor(seed: number): NpcVestment {
  const r = seed % 100;
  return r < 62 ? 'Friar' : r < 90 ? 'Priest' : r < 99 ? 'Bishop' : 'Cardinal';
}

const cache = new Map<number, Npc[]>();

/** The standing congregation of a bay: the same for every viewer, every time. */
export function congregation(bay: number): Npc[] {
  const known = cache.get(bay);
  if (known) return known;
  const count = NPC_MIN + (mix(bay, 0x51ed) % (NPC_MAX - NPC_MIN + 1));
  // Rank every seat of the bay by a hash and take the first few.
  const ranked = Array.from({ length: SEATS }, (_, i) => i).sort((p, q) => mix(mix(bay, 0xc0ffee), p) - mix(mix(bay, 0xc0ffee), q) || p - q);
  const npcs = ranked.slice(0, count).map((index, i) => {
    const row = Math.floor(index / (2 * C.SEATS_PER_HALF_ROW));
    const half = Math.floor(index / C.SEATS_PER_HALF_ROW) % 2;
    const seat = index % C.SEATS_PER_HALF_ROW;
    const [x, y] = seatPos(bay, row, half, seat);
    const seed = mix(mix(bay, 0xbead), index);
    // Bays run a long way either side of zero; the offset keeps the id negative and unique.
    const id = -((BigInt(bay + 2 ** 30) << 8n) | BigInt(i)) - 1n;
    return { id, bay, row, half, seat, x, y, vestment: vestmentFor(seed), seed };
  });
  if (cache.size > 64) cache.clear();
  cache.set(bay, npcs);
  return npcs;
}

/** Whether the prayers of priests at `a` and `b` are likely to run into each other. */
export function crowds(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  const dx = Math.abs(a.x - b.x);
  const rows = Math.round(Math.abs(a.y - b.y) / C.PEW_STEP_Y);
  return rows === 0 ? dx < PRAYER_CLEAR_X : rows === 1 ? dx < PRAYER_CLEAR_NEXT_ROW_X : false;
}

/** The seat a priest is in, as a key for telling whether a real priest has taken an NPC's. */
export function seatKey(p: { bay: number; row: number; half: number; seat: number }): string {
  return `${p.bay}:${p.row}:${p.half}:${p.seat}`;
}

/**
 * The prayer an NPC is on at time `t`: a new canned prayer every pacing slot, starting on
 * its own beat so the congregation does not speak in unison.
 */
export function npcTick(npc: Npc, t: number, slotMs: number = C.PACING_SLOT_MS): { seq: number; cannedIdx: number; at: number } {
  const offset = npc.seed % slotMs;
  const seq = Math.floor((t - offset) / slotMs);
  return { seq, cannedIdx: mix(npc.seed, seq), at: seq * slotMs + offset };
}
