import { describe, expect, it } from 'vitest';
import { fadeLevel, nextTrack, sources, FADE_IN_MS, IMPULSE_RESPONSE, MUSIC_VOLUME, TRACKS } from '../src/music';

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

describe('the chants', () => {
  it('are sung in order, and begin again after the last', () => {
    const order = [0];
    for (let i = 0; i < TRACKS.length; i++) order.push(nextTrack(order.at(-1)!));
    expect(order).toEqual([...TRACKS.keys(), 0]);
    expect(nextTrack(0, 1)).toBe(0);
  });

  it('are all in the public folder in both forms, each listed once, with the nave beside them', () => {
    expect(new Set(TRACKS).size).toBe(TRACKS.length);
    const names = (files: Record<string, unknown>) => Object.keys(files).map((f) => f.replace('../public', ''));
    const onDisk = [...names(import.meta.glob('../public/audio/*.mp4')), ...names(import.meta.glob('../public/audio/*.m4a'))];
    const wanted = [...TRACKS.flatMap((t) => sources(t).map((s) => s.src)), IMPULSE_RESPONSE];
    expect(wanted.sort()).toEqual(onDisk.sort());
  });

  it('are offered as Opus first, and as AAC to a browser without it', () => {
    expect(sources('dies-irae')).toEqual([
      { src: '/audio/dies-irae-opus.mp4', type: 'audio/mp4; codecs=opus' },
      { src: '/audio/dies-irae-aac.m4a', type: 'audio/mp4' },
    ]);
  });
});
