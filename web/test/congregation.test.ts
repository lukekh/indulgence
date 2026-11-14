import { describe, expect, it } from 'vitest';
import { C, seatPos } from '../../shared/constants';
import { congregation, crowds, npcTick, seatKey, NPC_MAX, NPC_MIN, PRAYER_CLEAR_NEXT_ROW_X, PRAYER_CLEAR_X } from '../src/congregation';

describe('the standing congregation', () => {
  const bays = Array.from({ length: 401 }, (_, i) => i - 200);

  it('has between 5 and 30 priests in every bay, and the numbers vary', () => {
    const counts = bays.map((b) => congregation(b).length);
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(NPC_MIN);
    expect(Math.max(...counts)).toBeLessThanOrEqual(NPC_MAX);
    expect(new Set(counts).size).toBeGreaterThan(15);
    expect([NPC_MIN, NPC_MAX]).toEqual([5, 30]);
  });

  it('is the same for every viewer, every time: it comes from the bay number alone', () => {
    for (const b of [-7, 0, 3, 120]) {
      const again = congregation(b).map((n) => ({ ...n }));
      expect(congregation(b)).toEqual(again);
    }
    expect(congregation(1).map(seatKey)).not.toEqual(congregation(2).map((n) => seatKey({ ...n, bay: 1 })));
  });

  it('seats each one in a real pew of its own bay, no two in one seat', () => {
    for (const b of bays) {
      const npcs = congregation(b);
      expect(new Set(npcs.map(seatKey)).size).toBe(npcs.length);
      for (const n of npcs) {
        expect(n.bay).toBe(b);
        expect([n.x, n.y]).toEqual(seatPos(b, n.row, n.half, n.seat));
        expect(n.row).toBeLessThan(C.ROW_Y.length);
        expect(n.seat).toBeLessThan(C.SEATS_PER_HALF_ROW);
        expect(n.id < 0n).toBe(true);
      }
    }
    const ids = bays.flatMap((b) => congregation(b).map((n) => n.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is mostly friars, with the odd bishop', () => {
    const all = bays.flatMap((b) => congregation(b));
    const share = (v: string) => all.filter((n) => n.vestment === v).length / all.length;
    expect(share('Friar')).toBeGreaterThan(0.5);
    expect(share('Bishop')).toBeLessThan(0.15);
    expect(share('Cardinal')).toBeLessThan(0.03);
  });
});

describe('an NPC and a real priest', () => {
  const at = (x: number, row: number) => ({ x, y: C.ROW_Y[row]! });

  it('collide by the same rule the module seats real priests by', () => {
    expect([PRAYER_CLEAR_X, PRAYER_CLEAR_NEXT_ROW_X]).toEqual([8, 4]);
    expect(crowds(at(8, 2), at(15, 2))).toBe(true);
    expect(crowds(at(8, 2), at(16, 2))).toBe(false);
    expect(crowds(at(10, 2), at(13, 3))).toBe(true);
    expect(crowds(at(10, 3), at(10, 2))).toBe(true);
    expect(crowds(at(10, 2), at(14, 3))).toBe(false);
    expect(crowds(at(10, 2), at(10, 4))).toBe(false);
  });
});

describe("an NPC's prayers", () => {
  const [a, b] = congregation(0);
  const SLOT = C.PACING_SLOT_MS;

  it('change once every pacing slot, and hold steady within it', () => {
    const t = 1_800_000_000_000;
    const now = npcTick(a!, t);
    expect(now.at).toBeLessThanOrEqual(t);
    expect(t - now.at).toBeLessThan(SLOT);
    expect(npcTick(a!, now.at)).toEqual(now);
    expect(npcTick(a!, now.at + SLOT - 1)).toEqual(now);
    const next = npcTick(a!, now.at + SLOT);
    expect(next.seq).toBe(now.seq + 1);
    expect(next.at).toBe(now.at + SLOT);
  });

  it('are on their own beat, not in unison with their neighbour', () => {
    const t = 1_800_000_000_000;
    expect(npcTick(a!, t).at).not.toBe(npcTick(b!, t).at);
  });
});
