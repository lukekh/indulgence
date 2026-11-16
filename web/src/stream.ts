// The livestream: the viewer opened as `#stream=<key>`, for OBS to send to YouTube.
//
// It shows one bay, the one where most people are praying, and names everyone in the
// cathedral. Every five minutes it looks again; if another bay has taken the lead, the old
// view fades out over the new one, and if not, nothing moves. Only priests in the database
// count: the standing congregation and the thurifer are drawn by each browser and are
// everywhere alike.

import { C } from '../../shared/constants';

/** How often the stream looks again for the busiest bay. */
export const RECHOOSE_MS = 5 * 60_000;
/** How long the old bay takes to fade out over the new one. */
export const CROSSFADE_MS = 3000;

/** The stream key in the link (`#stream=<key>`), if this is the livestream. */
export function streamKeyFromUrl(hash: string): string | undefined {
  const m = /[#&]stream=([^&]+)/.exec(hash);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]!) || undefined;
  } catch {
    return undefined;
  }
}

/** The site's address as viewers of the stream would type it: no scheme, no fragment. */
export function siteAddress(loc: Pick<Location, 'host' | 'pathname'>): string {
  return `${loc.host}${loc.pathname}`.replace(/\/+$/, '');
}

export interface BayPriest {
  bay: number;
  /** Has stood up to leave: no longer counts. */
  departing: boolean;
}

export interface BayCandle {
  x: number;
  litAt: number;
  expiresAt: number;
}

export function bayOf(x: number): number {
  return Math.floor(x / C.BAY_W);
}

/**
 * The bay the stream shows: the one with the most priests praying (not leaving); between
 * equals, the one with the most candles burning on its stand; then the bay already shown, if
 * it is among them; then the one nearest bay 0, and the lower of two as near. With no one
 * praying and no candle burning, the bay already shown, or bay 0.
 */
export function leadingBay(priests: BayPriest[], candles: BayCandle[], now: number, current?: number): number {
  const praying = new Map<number, number>();
  for (const p of priests) if (!p.departing) praying.set(p.bay, (praying.get(p.bay) ?? 0) + 1);
  const burning = new Map<number, number>();
  for (const c of candles) {
    if (c.litAt > now || c.expiresAt <= now) continue;
    const b = bayOf(c.x);
    burning.set(b, (burning.get(b) ?? 0) + 1);
  }
  const bays = new Set([...praying.keys(), ...burning.keys()]);
  if (bays.size === 0) return current ?? 0;

  const score = (b: number): [number, number] => [praying.get(b) ?? 0, burning.get(b) ?? 0];
  let best: number[] = [];
  let top: [number, number] = [-1, -1];
  for (const b of bays) {
    const s = score(b);
    const cmp = s[0] - top[0] || s[1] - top[1];
    if (cmp > 0) {
      top = s;
      best = [b];
    } else if (cmp === 0) {
      best.push(b);
    }
  }
  if (current !== undefined && best.includes(current)) return current;
  return best.sort((a, b) => Math.abs(a) - Math.abs(b) || a - b)[0]!;
}

/**
 * When the stream chooses its bay, and the crossfade when the choice changes. The first
 * choice is made at once and shown without a fade.
 */
export class Director {
  bay: number | undefined;
  private chosenAt: number | undefined;
  private fadeSince: number | undefined;

  /**
   * Call every frame once the scene is known. Chooses again when it is time; returns true if
   * the bay has just changed, so the caller should keep a still of the old view to fade out.
   */
  tick(now: number, choose: (current: number | undefined) => number): boolean {
    if (this.chosenAt !== undefined && now - this.chosenAt < RECHOOSE_MS) return false;
    this.chosenAt = now;
    const next = choose(this.bay);
    const changed = this.bay !== undefined && next !== this.bay;
    this.bay = next;
    if (changed) this.fadeSince = now;
    return changed;
  }

  /** How opaque the still of the old bay is over the new one, or undefined once it has gone. */
  fade(now: number): number | undefined {
    if (this.fadeSince === undefined) return undefined;
    const k = (now - this.fadeSince) / CROSSFADE_MS;
    if (k >= 1) {
      this.fadeSince = undefined;
      return undefined;
    }
    const eased = k * k * (3 - 2 * k);
    return 1 - Math.max(0, eased);
  }
}
