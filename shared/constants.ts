// Typed access to shared/constants.json for the gate and the web client.
// The Rust module reads the same JSON through module/build.rs.

import raw from './constants.json';

export const C = raw;

export type VestmentName = 'friar' | 'priest' | 'bishop' | 'cardinal';
export type CandleName = 'taper' | 'votive' | 'pillar' | 'paschal';

export interface SpendTier {
  min: number;
  vestment: VestmentName;
  candle: CandleName;
  burn_h: number;
}

export const SPEND_TIERS = raw.SPEND_TIERS as SpendTier[];

/** Index into SPEND_TIERS for an amount of prayer tokens. */
export function spendTier(tokens: number): number {
  let idx = 0;
  SPEND_TIERS.forEach((t, i) => {
    if (tokens >= t.min) idx = i;
  });
  return idx;
}

/** Prayer tokens for accepted text: ceil(chars / 3), counting code points. */
export function prayerTokens(text: string): number {
  return Math.ceil([...text].length / C.CHARS_PER_TOKEN);
}

/** World tile of a seat (b, row, half, i). half 0 = left, 1 = right. */
export function seatPos(bay: number, row: number, half: number, i: number): [number, number] {
  const local = half === 0 ? C.LEFT_SEAT_X0 - i : C.RIGHT_SEAT_X0 + i;
  return [C.BAY_W * bay + local, C.ROW_Y[row]!];
}

/** World x of an arcade's stand centre. */
export function standX(arcade: number): number {
  return C.BAY_W * arcade + C.STAND_CENTRE_X;
}

export function bayOfX(x: number): number {
  return Math.floor(x / C.BAY_W);
}
