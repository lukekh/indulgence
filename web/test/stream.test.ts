import { describe, expect, it } from 'vitest';
import { C } from '../../shared/constants';
import { bayOf, Director, leadingBay, siteAddress, streamKeyFromUrl, CROSSFADE_MS, RECHOOSE_MS, type BayCandle, type BayPriest } from '../src/stream';
import { capKey, keyCapacity, keyMetrics } from '../src/key';
import { congregation } from '../src/congregation';

const praying = (bay: number, n = 1): BayPriest[] => Array.from({ length: n }, () => ({ bay, departing: false }));
const leaving = (bay: number, n = 1): BayPriest[] => Array.from({ length: n }, () => ({ bay, departing: true }));
const NOW = 1_000_000;
const burning = (bay: number, n = 1): BayCandle[] =>
  Array.from({ length: n }, (_, i) => ({ x: bay * C.BAY_W + 1 + (i % 3), litAt: NOW - 1000, expiresAt: NOW + 3_600_000 }));

describe('the livestream link', () => {
  it('carries the key after #stream=, and nothing else is the livestream', () => {
    expect(streamKeyFromUrl('#stream=abc-123_XYZ')).toBe('abc-123_XYZ');
    expect(streamKeyFromUrl('#t=sometickethere123&stream=k%2Fey')).toBe('k/ey');
    expect(streamKeyFromUrl('#t=abcdefghijklmnop')).toBeUndefined();
    expect(streamKeyFromUrl('')).toBeUndefined();
    expect(streamKeyFromUrl('#stream=%E0%A4%A')).toBeUndefined();
  });

  it('writes the site as it would be typed', () => {
    expect(siteAddress({ host: 'lukekh.github.io', pathname: '/indulgence/' })).toBe('lukekh.github.io/indulgence');
    expect(siteAddress({ host: 'localhost:5173', pathname: '/' })).toBe('localhost:5173');
  });
});

describe('the busiest bay', () => {
  it('is the one with the most priests praying', () => {
    expect(leadingBay([...praying(3, 2), ...praying(-1, 5), ...praying(0, 1)], [], NOW)).toBe(-1);
  });

  it('does not count priests leaving', () => {
    expect(leadingBay([...praying(2, 2), ...leaving(5, 4)], [], NOW)).toBe(2);
    expect(leadingBay([...praying(2, 1), ...praying(5, 1), ...leaving(5, 3)], [], NOW, 2)).toBe(2);
  });

  it('never counts the standing congregation, which is not in the database', () => {
    // Every bay has its own congregation; it is drawn by the browser and never passed in.
    expect(congregation(4).length).toBeGreaterThan(0);
    expect(leadingBay(praying(7), [], NOW)).toBe(7);
  });

  it('between equals, has the most candles burning', () => {
    expect(leadingBay([...praying(1, 2), ...praying(4, 2)], [...burning(1, 1), ...burning(4, 3)], NOW)).toBe(4);
  });

  it('counts only candles lit and not yet out, by the bay their stand is in', () => {
    const unlit: BayCandle = { x: 4 * C.BAY_W + 2, litAt: NOW + 5000, expiresAt: NOW + 3_600_000 };
    const out: BayCandle = { x: 4 * C.BAY_W + 2, litAt: NOW - 7_200_000, expiresAt: NOW - 1 };
    expect(leadingBay([...praying(1), ...praying(4)], [...burning(1, 1), unlit, out, unlit], NOW)).toBe(1);
    expect(bayOf(-1)).toBe(-1);
    expect(bayOf(C.BAY_W)).toBe(1);
  });

  it('then keeps the bay already shown, if it is among the busiest', () => {
    expect(leadingBay([...praying(2), ...praying(6)], [], NOW, 6)).toBe(6);
    expect(leadingBay([...praying(2), ...praying(6)], [], NOW, 9)).toBe(2);
  });

  it('then is the one nearest bay 0, and the lower of two as near', () => {
    expect(leadingBay([...praying(5), ...praying(-3), ...praying(8)], [], NOW)).toBe(-3);
    expect(leadingBay([...praying(2), ...praying(-2)], [], NOW)).toBe(-2);
  });

  it('with no one praying, goes by candles; with nothing at all, stays put or shows bay 0', () => {
    expect(leadingBay(leaving(3), burning(-4, 2), NOW)).toBe(-4);
    expect(leadingBay([], [], NOW)).toBe(0);
    expect(leadingBay([], [], NOW, 11)).toBe(11);
    expect(leadingBay(leaving(3), [], NOW, 11)).toBe(11);
  });
});

describe('moving between bays', () => {
  it('chooses at once, then again only every five minutes', () => {
    const d = new Director();
    let asked = 0;
    const choose = (bay: number) => () => (asked++, bay);
    expect(d.tick(0, choose(3))).toBe(false); // the first choice: no fade
    expect(d.bay).toBe(3);
    expect(d.tick(RECHOOSE_MS - 1, choose(9))).toBe(false);
    expect(d.bay).toBe(3);
    expect(asked).toBe(1);
    expect(d.tick(RECHOOSE_MS, choose(9))).toBe(true);
    expect(d.bay).toBe(9);
    expect(asked).toBe(2);
  });

  it('passes the bay shown to the choice, so a tie can keep it', () => {
    const d = new Director();
    d.tick(0, () => 4);
    let seen: number | undefined;
    d.tick(RECHOOSE_MS, (cur) => ((seen = cur), cur!));
    expect(seen).toBe(4);
  });

  it('does not fade when the leader is unchanged', () => {
    const d = new Director();
    d.tick(0, () => 2);
    expect(d.fade(10)).toBeUndefined();
    expect(d.tick(RECHOOSE_MS, () => 2)).toBe(false);
    expect(d.fade(RECHOOSE_MS + 10)).toBeUndefined();
  });

  it('fades the old bay out softly over about three seconds when it changes', () => {
    const d = new Director();
    d.tick(0, () => 2);
    const at = RECHOOSE_MS;
    expect(d.tick(at, () => 5)).toBe(true);
    expect(d.fade(at)).toBe(1);
    const mid = d.fade(at + CROSSFADE_MS / 2)!;
    expect(mid).toBeCloseTo(0.5);
    const early = d.fade(at + CROSSFADE_MS / 10)!;
    expect(early).toBeGreaterThan(0.9); // eased: slow to start
    expect(d.fade(at + CROSSFADE_MS)).toBeUndefined();
    expect(d.fade(at + CROSSFADE_MS - 1)).toBeUndefined(); // once gone, gone
    expect(CROSSFADE_MS).toBeGreaterThanOrEqual(2000);
    expect(CROSSFADE_MS).toBeLessThanOrEqual(4000);
  });
});

describe('the livestream key', () => {
  it('lists everyone when they fit', () => {
    expect(capKey(['a', 'b'], 3)).toEqual({ shown: ['a', 'b'], more: 0 });
    expect(capKey(['a', 'b', 'c'], 3)).toEqual({ shown: ['a', 'b', 'c'], more: 0 });
    expect(capKey([], 3)).toEqual({ shown: [], more: 0 });
  });

  it('gives the last row to "and N more" when they do not', () => {
    expect(capKey(['a', 'b', 'c', 'd', 'e'], 3)).toEqual({ shown: ['a', 'b'], more: 3 });
    expect(capKey(['a', 'b'], 1)).toEqual({ shown: [], more: 2 });
  });

  it('fits in the top three quarters of the screen', () => {
    const px = 23;
    const rows = keyCapacity(1080, px);
    const m = keyMetrics(1920, px);
    expect(m.firstRow + rows * m.rowH).toBeLessThanOrEqual(1080 * 0.75);
    expect(m.firstRow + (rows + 1) * m.rowH).toBeGreaterThan(1080 * 0.75);
    expect(keyCapacity(10, px)).toBe(1);
  });
});
