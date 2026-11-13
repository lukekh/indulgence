import { describe, expect, it } from 'vitest';
import { fadeLevel, FADE_IN_MS, MUSIC_VOLUME } from '../src/music';

describe('music fades', () => {
  it('moves in a straight line and stays within its ends', () => {
    expect(fadeLevel(-5, 1000, 0, 0.5)).toBe(0);
    expect(fadeLevel(0, 1000, 0, 0.5)).toBe(0);
    expect(fadeLevel(500, 1000, 0, 0.5)).toBeCloseTo(0.25);
    expect(fadeLevel(1000, 1000, 0, 0.5)).toBe(0.5);
    expect(fadeLevel(5000, 1000, 0.5, 0)).toBe(0);
    expect(fadeLevel(250, 1000, 0.4, 0)).toBeCloseTo(0.3);
  });

  it('finishes at once for a zero-length fade, and starts quietly', () => {
    expect(fadeLevel(0, 0, 0.2, 0.7)).toBe(0.7);
    expect(fadeLevel(FADE_IN_MS / 10, FADE_IN_MS, 0, MUSIC_VOLUME)).toBeLessThan(MUSIC_VOLUME / 5);
  });
});
