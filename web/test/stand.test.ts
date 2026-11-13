import { describe, expect, it } from 'vitest';
import { slotPoint } from '../src/motion';
import { standFacesLeft } from '../src/view';
import { C } from '../../shared/constants';
import { closeUpMirrored, mirrorX, CLOSE_UP, heightAt, meltProfile, remaining, slotFoot, slotHit, standSeed, STAND_H, STAND_W, standPlacement, type StandCandle } from '../src/stand';

const H = 3_600_000;
const candle = (over: Partial<StandCandle> = {}): StandCandle => ({ slot: 0, size: 'votive', litAt: 0, expiresAt: 24 * H, ...over });

describe('the votive stand, close up', () => {
  it('a candle is as tall as the time it has left', () => {
    const c = candle({ size: 'pillar' });
    expect(remaining(c, -5)).toBe(1); // not lit yet
    expect(remaining(c, 12 * H)).toBe(0.5);
    expect(remaining(c, 30 * H)).toBe(0);
    expect(heightAt(c, 0)).toBe(CLOSE_UP.pillar.h);
    expect(heightAt(c, 12 * H)).toBeLessThan(CLOSE_UP.pillar.h);
    expect(heightAt(c, 12 * H)).toBeGreaterThan(heightAt(c, 20 * H));
    expect(heightAt(c, 24 * H)).toBe(2); // a stub at the end
  });

  it('seats every slot on its own shelf, the front tier lowest, inside the picture', () => {
    const seen = new Set<string>();
    for (let slot = 0; slot < C.STAND_TIERS * C.STAND_SLOTS_PER_TIER; slot++) {
      const [x, y] = slotFoot(slot);
      seen.add(`${x},${y}`);
      const [hx, hy, hw, hh] = slotHit(candle({ slot, size: 'paschal' }));
      expect(hx).toBeGreaterThanOrEqual(0);
      expect(hy).toBeGreaterThanOrEqual(0);
      expect(hx + hw).toBeLessThanOrEqual(STAND_W);
      expect(hy + hh).toBeLessThanOrEqual(STAND_H);
    }
    expect(seen.size).toBe(C.STAND_TIERS * C.STAND_SLOTS_PER_TIER);
    expect(slotFoot(0)[1]).toBeGreaterThan(slotFoot(C.STAND_SLOTS_PER_TIER)[1]);
  });

  it('keeps neighbouring candles\' hover areas apart', () => {
    const [ax, , aw] = slotHit(candle({ slot: 0, size: 'paschal' }));
    const [bx] = slotHit(candle({ slot: 1, size: 'paschal' }));
    expect(ax + aw).toBeLessThanOrEqual(bx);
  });

  it('is scaled by whole pixels and centred', () => {
    const p = standPlacement(1440, 900);
    expect(Number.isInteger(p.k)).toBe(true);
    expect(p.w).toBe(STAND_W * p.k);
    expect(p.x + p.w / 2).toBeCloseTo(720, 0);
    expect(p.y).toBeGreaterThan(0);
    expect(p.y + p.h).toBeLessThan(900);
  });

  it('slumps at the top as it melts, each candle in its own way', () => {
    const flat = (p: number[]) => p.every((d) => d === 0);
    expect(flat(meltProfile(candle({ size: 'pillar' }), -1))).toBe(true); // not lit
    expect(flat(meltProfile(candle({ size: 'pillar' }), 60_000))).toBe(true); // just lit
    const shapes = new Set<string>();
    for (let slot = 0; slot < 40; slot++) {
      for (const size of ['taper', 'votive', 'pillar', 'paschal'] as const) {
        const c = candle({ slot, size });
        for (const at of [6, 12, 18, 23.9]) {
          const p = meltProfile(c, at * H);
          expect(p).toHaveLength(CLOSE_UP[size].w);
          expect(p[(p.length - 1) / 2]).toBe(0); // the wick stays at the top
          for (const d of p) expect(d).toBeLessThanOrEqual(Math.max(0, heightAt(c, at * H) - 2));
        }
      }
      const p = meltProfile(candle({ slot, size: 'pillar' }), 18 * H);
      expect(flat(p)).toBe(false);
      shapes.add(p.join());
    }
    expect(shapes.size).toBeGreaterThan(8);
  });

  it("hashes a stand's place into a seed for its old wax", () => {
    // The stand to the right of one bay is the stand to the left of the next.
    expect(standSeed(3, 'right')).toBe(standSeed(4, 'left'));
    expect(standSeed(3, 'left')).not.toBe(standSeed(3, 'right'));
    const seeds = new Set<number>();
    for (let bay = -200; bay <= 200; bay++) seeds.add(standSeed(bay, 'left'));
    expect(seeds.size).toBe(401);
    for (const s of seeds) expect(Number.isInteger(s) && s >= 0).toBe(true);
  });
});

describe('the close-up lines up with the nave', () => {
  // Where a slot is drawn across the close-up, as seen on screen.
  const across = (slot: number, mirrored: boolean) => mirrorX(slotFoot(slot)[0], mirrored);
  const cam = { bay: 0 };

  it('shows the altar end on your right for the stand to your left, and on your left for the one to your right', () => {
    for (const arcade of [0, 1]) {
      const facesLeft = standFacesLeft(cam, arcade);
      const mirrored = closeUpMirrored(facesLeft);
      // Slot 0 is the altar end in the nave: the smallest y, the top of the screen.
      expect(slotPoint(arcade, 0, facesLeft).y).toBeLessThan(slotPoint(arcade, 9, facesLeft).y);
      // Looking left from your pews the altar is on your right; looking right, on your left.
      const altarOnRight = arcade <= cam.bay;
      expect(across(0, mirrored) > across(9, mirrored)).toBe(altarOnRight);
    }
  });

  it('keeps the tiers as they are: the front, lowest shelf nearest you in both', () => {
    for (const facesLeft of [true, false]) {
      expect(slotPoint(0, 10, facesLeft).lift).toBeGreaterThan(slotPoint(0, 0, facesLeft).lift);
      expect(slotFoot(10)[1]).toBeLessThan(slotFoot(0)[1]);
    }
  });

  it('mirrors about the middle of the stand, so every spike still has a slot', () => {
    const xs = Array.from({ length: 10 }, (_, k) => slotFoot(k)[0]);
    expect(xs.map((x) => mirrorX(x, true)).sort((a, b) => a - b)).toEqual(xs);
    expect(mirrorX(mirrorX(40, true), true)).toBe(40);
    expect(mirrorX(40, false)).toBe(40);
  });
});
