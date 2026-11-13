// A votive stand seen close up, from where a priest kneels to light a candle.
//
// Clicking a stand in the nave opens this view over the cathedral: its four iron tiers face
// on, the front tier lowest, every candle large enough to tell apart. Each candle is as tall
// as the time it has left: it starts at its full height when lit and burns down to a stub by
// the time it expires, with wax pooling at its foot and a drip running down its side. It is
// pixel art at base resolution, dithered like the nave, and scaled up by whole pixels.

import { C, type CandleName } from '../../shared/constants';
import { ditherFrame } from './dither';
import { applyLighting, drawFlame, COL, type Light } from './scene';

/** Size of the close-up in base pixels. */
export const STAND_W = 264;
export const STAND_H = 190;

/** Full height and width of each kind of candle, base px. */
export const CLOSE_UP: Record<CandleName, { w: number; h: number }> = {
  taper: { w: 3, h: 26 },
  votive: { w: 9, h: 11 },
  pillar: { w: 9, h: 24 },
  paschal: { w: 11, h: 32 },
};
/** What is left of any candle at the end: a stub. */
const STUB = 2;
const TIER_STEP = 37;
const FRONT_SHELF_Y = STAND_H - 22;
const SLOT_X0 = 33;
const SLOT_STEP = 22;

export interface StandCandle {
  slot: number;
  size: CandleName;
  litAt: number;
  expiresAt: number;
}

/** How much of a candle is left at `now`: 1 until it is lit, falling to 0 as it expires. */
export function remaining(c: Pick<StandCandle, 'litAt' | 'expiresAt'>, now: number): number {
  if (now <= c.litAt) return 1;
  if (c.expiresAt <= c.litAt) return 0;
  return Math.max(0, Math.min(1, (c.expiresAt - now) / (c.expiresAt - c.litAt)));
}

/** A candle's height in the close-up at `now`, base px. */
export function heightAt(c: StandCandle, now: number): number {
  const full = CLOSE_UP[c.size].h;
  return Math.max(STUB, Math.round(STUB + (full - STUB) * remaining(c, now)));
}

/**
 * The shape of a candle's top at `now`: for each column of its width, how many px the wax
 * has sunk below the wick. Flat when first lit; as it burns the top slumps, each candle in
 * its own way (to the left, to the right, rounded into a dome, or cut by a gully where the
 * wax ran off), chosen by its slot and when it was lit, and never deeper than the candle.
 */
export function meltProfile(c: StandCandle, now: number): number[] {
  const { w } = CLOSE_UP[c.size];
  const out = new Array<number>(w).fill(0);
  if (now <= c.litAt) return out;
  const spent = 1 - remaining(c, now);
  const depth = Math.min(heightAt(c, now) - 2, Math.round(spent * (w > 3 ? 6 : 2)));
  if (depth <= 0) return out;
  const seed = Math.imul((c.slot + 1) * 2654435761 + Math.floor(c.litAt / 1000), 1274126177) >>> 4;
  const style = seed % 4;
  const mid = (w - 1) / 2;
  const gully = seed % 8 < 4 ? 1 : w - 2;
  for (let i = 0; i < w; i++) {
    if (i === mid) continue;
    const u = (i - mid) / mid;
    let f = style === 0 ? Math.max(0, -u) + 0.25 * Math.max(0, u) : style === 1 ? Math.max(0, u) + 0.25 * Math.max(0, -u) : style === 2 ? u * u : 0.45 * u * u + (i === gully && w > 3 ? 0.55 : 0);
    if (spent > 0.3 && w > 3 && (seed >> (i + 5)) & 1) f += 0.2;
    out[i] = Math.round(depth * Math.min(1, f));
  }
  return out;
}

/** Where a slot's candle stands: the middle of its foot, base px. Tier 0 is the front, lowest shelf. */
export function slotFoot(slot: number): [number, number] {
  const tier = Math.floor(slot / C.STAND_SLOTS_PER_TIER);
  const k = slot % C.STAND_SLOTS_PER_TIER;
  return [SLOT_X0 + k * SLOT_STEP, FRONT_SHELF_Y - tier * TIER_STEP];
}

/** The area to hover for a candle (generous, and at least its full height), base px. */
export function slotHit(c: StandCandle): [number, number, number, number] {
  const [x, y] = slotFoot(c.slot);
  const { w, h } = CLOSE_UP[c.size];
  const hw = Math.max(w, 9) / 2 + 2;
  return [x - hw, y - h - 6, hw * 2, h + 9];
}

/** The rim round a hovered candle: a darker crimson than the names in the key. */
const RIM = 'rgb(168, 28, 42)';
/** Its dithered outer edge, darker still, so the rim seems to fade into the dark. */
const RIM_FADE = 'rgb(92, 14, 24)';

/**
 * A stand's own number, hashed from where it is: the bay of pews it serves and which side of
 * them it stands on. (The stand to the right of one bay is the one to the left of the next,
 * so both descriptions give the same number.) Its old wax is generated from this.
 */
export function standSeed(bay: number, side: 'left' | 'right'): number {
  const arcade = bay + (side === 'right' ? 1 : 0);
  let h = Math.imul(arcade ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** The stand whose old wax is being drawn. */
let waxSeed = 0;

/** A number from 0 to n - 1, always the same for the same place on the same stand. */
function chance(a: number, b: number, n: number): number {
  return (Math.imul(Math.imul(a + 1, 374761393) ^ Math.imul(b + 1, 668265263) ^ waxSeed, 1274126177) >>> 9) % n;
}

/**
 * Decades of wax on one shelf (its top edge at `y`): mounds set round the spikes where
 * candle after candle burnt down, runs that went over the front of the rail and hang beneath
 * it, and spatters on the floor under the lowest shelf. Duller than fresh wax. Generated
 * from the stand's seed: every stand has its own, the same for everyone who looks at it.
 */
function oldWax(ctx: CanvasRenderingContext2D, tier: number, y: number) {
  // Mounds round most of the spikes, and a few between them.
  for (let k = 0; k < C.STAND_SLOTS_PER_TIER * 2 - 1; k++) {
    const between = k % 2 === 1;
    if (chance(tier, k, 10) < (between ? 6 : 2)) continue;
    const cx = SLOT_X0 + Math.floor(k / 2) * SLOT_STEP + (between ? SLOT_STEP / 2 + chance(k, tier, 7) - 3 : chance(k, tier, 3) - 1);
    const half = 2 + chance(tier + 7, k, between ? 3 : 5);
    const rows = 1 + chance(tier + 13, k, between ? 2 : 3);
    for (let r = 0; r < rows; r++) {
      const hw = Math.max(1, half - r * 2);
      ctx.fillStyle = r === rows - 1 && chance(k, tier + 3, 3) === 0 ? COL.wax : COL.pewRail;
      ctx.fillRect(Math.round(cx) - hw, y - 1 - r, hw * 2 + 1, 1);
    }
  }
  // Runs down the face of the rail; the longer ones hang below it and end in a bead.
  for (let i = 0; i < 26; i++) {
    if (chance(tier + 21, i, 10) < 3) continue;
    const x = 19 + i * 9 + chance(tier + 5, i, 7);
    if (x > STAND_W - 20) continue;
    const len = 2 + chance(tier + 31, i, 5) + (chance(tier + 41, i, 4) === 0 ? 5 + chance(i, tier + 9, 6) : 0);
    const wide = chance(tier + 51, i, 3) === 0 ? 2 : 1;
    ctx.fillStyle = COL.pewRail;
    ctx.fillRect(x, y, wide, len);
    if (len > 7) {
      ctx.fillStyle = COL.ink;
      ctx.fillRect(x - 1, y + 8, 1, len - 8);
      ctx.fillRect(x + wide, y + 8, 1, len - 8);
      ctx.fillStyle = COL.wax;
      ctx.fillRect(x, y + len - 1, wide, 1);
    }
  }
  // What fell from the lowest shelf lies on the floor.
  if (tier === 0) {
    for (let i = 0; i < 12; i++) {
      const x = 24 + i * 19 + chance(i, 77, 11);
      const hw = 1 + chance(i, 78, 4);
      ctx.fillStyle = COL.pewRail;
      ctx.fillRect(x - hw, STAND_H - 11, hw * 2 + 1, 1);
      if (hw > 2) ctx.fillRect(x - hw + 2, STAND_H - 12, hw * 2 - 3, 1);
    }
  }
}

let canvas: HTMLCanvasElement | undefined;

/**
 * Draw the close-up at base resolution and return its canvas. `hover` is the slot under the
 * mouse, if any, which is rimmed in crimson; `seed` (see standSeed) shapes the stand's old wax.
 */
export function renderStand(candles: StandCandle[], now: number, hover?: number, seed = 0): HTMLCanvasElement {
  waxSeed = seed;
  canvas ??= document.createElement('canvas');
  canvas.width = STAND_W;
  canvas.height = STAND_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

  // The arcade wall behind, and the floor.
  // Kept nearly black, so the ironwork and the wax stand out against it.
  ctx.fillStyle = '#060606';
  ctx.fillRect(0, 0, STAND_W, STAND_H);
  ctx.fillStyle = COL.reredos;
  ctx.fillRect(0, STAND_H - 10, STAND_W, 10);
  ctx.fillStyle = COL.ink;
  ctx.fillRect(0, STAND_H - 11, STAND_W, 1);
  for (let x = 12; x < STAND_W; x += 42) ctx.fillRect(x, STAND_H - 10, 1, 10);

  const sorted = [...candles].sort((a, b) => b.slot - a.slot);
  const lights: Light[] = [];
  const flames: [number, number, number][] = [];
  /** The hovered candle: rimmed in crimson round its own shape (wick and flame too), over the dithered frame. */
  let outline: { x: number; left: number; top: number; w: number; h: number; foot: number; lit: boolean; seed: number; prof: number[] } | undefined;
  for (let tier = C.STAND_TIERS - 1; tier >= 0; tier--) {
    const y = FRONT_SHELF_Y - tier * TIER_STEP;
    // The shelf: an iron rail with a lit edge, on uprights, and its drip tray.
    ctx.fillStyle = COL.ink;
    ctx.fillRect(15, y - 1, STAND_W - 30, 9);
    ctx.fillStyle = COL.column;
    ctx.fillRect(16, y, STAND_W - 32, 7);
    ctx.fillStyle = COL.columnEdge;
    ctx.fillRect(16, y, STAND_W - 32, 3);
    ctx.fillStyle = COL.wax;
    ctx.fillRect(16, y, STAND_W - 32, 1);
    ctx.fillStyle = COL.pewFront;
    ctx.fillRect(16, y + 6, STAND_W - 32, 1);
    for (const ux of [20, STAND_W - 24]) {
      ctx.fillStyle = COL.column;
      ctx.fillRect(ux, y + 7, 4, STAND_H - 10 - y - 7);
      ctx.fillStyle = COL.columnEdge;
      ctx.fillRect(ux, y + 7, 1, STAND_H - 10 - y - 7);
    }
    // A spike for every slot, where a candle would stand.
    ctx.fillStyle = COL.wax;
    for (let k = 0; k < C.STAND_SLOTS_PER_TIER; k++) ctx.fillRect(SLOT_X0 + k * SLOT_STEP, y - 3, 1, 3);

    oldWax(ctx, tier, y);

    for (const c of sorted.filter((s) => Math.floor(s.slot / C.STAND_SLOTS_PER_TIER) === tier)) {
      const [x, foot] = slotFoot(c.slot);
      const { w } = CLOSE_UP[c.size];
      const h = heightAt(c, now);
      const left = x - Math.floor(w / 2);
      const top = foot - h;
      const lit = c.litAt <= now;
      const spent = 1 - remaining(c, now);
      // Wax that has run down pools at the foot, wider the longer it has burnt.
      if (lit) {
        const pool = Math.round(spent * (w / 2 + 3));
        ctx.fillStyle = COL.pewRail;
        ctx.fillRect(left - pool, foot - 1, w + pool * 2, 1);
        if (pool > 2) ctx.fillRect(left - pool + 2, foot - 2, w + pool * 2 - 4, 1);
      }
      // The body, column by column: its top slumps as it melts, each candle differently.
      const prof = meltProfile(c, now);
      ctx.fillStyle = COL.ink;
      prof.forEach((d, i) => ctx.fillRect(left + i - 1, top + d - 1, 3, h - d + 1));
      prof.forEach((d, i) => {
        // A rounded body: shade down one side, and a soft rim along the melted top.
        ctx.fillStyle = w > 3 && i === w - 1 ? COL.altarFront : w > 3 && i === w - 2 ? COL.pewRail : COL.wax;
        ctx.fillRect(left + i, top + d, 1, h - d);
        if (w > 3 && lit && h - d > 4 && i > 0 && i < w - 2) {
          ctx.fillStyle = COL.pewRail;
          ctx.fillRect(left + i, top + d, 1, 1);
        }
      });
      if (lit && w > 3) {
        // Wax that ran over and set: a run down one side, longer the more has burnt.
        const right = c.slot % 2 === 0;
        const edge = right ? w - 1 : 0;
        const len = Math.min(h - prof[edge]! - 2, Math.round(spent * (4 + (c.slot % 5))));
        if (len > 1) {
          ctx.fillStyle = COL.ink;
          ctx.fillRect(right ? left + w : left - 2, top + prof[edge]! + 1, 2, len + 1);
          ctx.fillStyle = right ? COL.pewRail : COL.wax;
          ctx.fillRect(right ? left + w : left - 1, top + prof[edge]! + 1, 1, len);
        }
      }
      if (lit) {
        // A drip creeping down the side, over and over.
        const run = ((now / 90 + c.slot * 37) % 400) / 400;
        const dy = Math.floor(run * Math.max(1, h - prof[0]! - 2));
        const d0 = prof[0]!;
        if (h - d0 > 4 && top + d0 + 1 + dy < foot - 2) {
          ctx.fillStyle = COL.wax;
          ctx.fillRect(left - 1, top + d0 + 1 + dy, 1, 2);
          ctx.fillStyle = COL.ink;
          ctx.fillRect(left - 2, top + d0 + 1 + dy, 1, 2);
        }
        // Wick and flame.
        ctx.fillStyle = COL.ink;
        ctx.fillRect(x, top - 2, 1, 2);
        flames.push([x, top - 3, c.slot]);
        lights.push({ x, y: top - 4, r: 40, power: 0.7 });
      } else {
        ctx.fillStyle = COL.ink;
        ctx.fillRect(x, top - 2, 1, 2);
      }
      if (hover === c.slot) outline = { x, left, top, w, h, foot, lit, seed: c.slot, prof };
    }
  }

  applyLighting(ctx, STAND_W, STAND_H, lights, 0.8);
  ditherFrame(ctx, STAND_W, STAND_H);
  for (const [x, y, seed] of flames) {
    // A taller flame than in the nave: a white core in a pale teardrop.
    const fh = flameHeight(now, seed);
    ctx.fillStyle = '#d9d6cf';
    ctx.fillRect(x - 1, y - fh + 2, 3, fh - 2);
    ctx.fillRect(x, y - fh, 1, fh + 1);
    drawFlame(ctx, x, y, now, seed);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y - 2, 1, 3);
  }
  if (outline) {
    // The rim follows the candle's own shape: body, wick and flame. A solid crimson line
    // against it, and a dithered one outside that; neither goes below the shelf.
    const o = outline;
    const parts: [number, number, number, number][] = o.prof.map((d, i) => [o.left + i, o.top + d, 1, o.h - d]);
    parts.push([o.x, o.top - 2, 1, 2]);
    if (o.lit) {
      const fh = flameHeight(now, o.seed);
      parts.push([o.x - 1, o.top - 1 - fh, 3, fh - 1], [o.x, o.top - 3 - fh, 1, fh + 1]);
    }
    const near = (px: number, py: number, d: number) => parts.some(([rx, ry, rw, rh]) => px >= rx - d && px < rx + rw + d && py >= ry - d && py < ry + rh + d);
    for (let py = o.top - 12; py < o.foot; py++) {
      for (let px = o.left - 3; px < o.left + o.w + 3; px++) {
        if (near(px, py, 0)) continue;
        const inner = near(px, py, 1);
        if (!inner && !(near(px, py, 2) && (px + py) % 2 === 0)) continue;
        ctx.fillStyle = inner ? RIM : RIM_FADE;
        ctx.fillRect(px, py, 1, 1);
      }
    }
  }
  return canvas;
}

/** Height of a flame in the close-up at `now`, base px: it flickers between 4 and 6. */
function flameHeight(now: number, seed: number): number {
  const flick = Math.sin(now / 110 + seed * 1.9) + Math.sin(now / 43 + seed);
  return flick > 0.9 ? 6 : flick < -0.9 ? 4 : 5;
}

/** Width of the frame round the close-up, base px. */
export const FRAME = 16;
/** How far the arch's springing sits below its crown, base px: a shallow, segmental arch. */
export const ARCH_RISE = 14;
/** Dark stone, so the archway stays quieter than the candles it frames. */
const STONE = { ink: '#080707', dark: '#1f1d1b', shade: '#302e2a', mid: '#403d39', light: '#59554f', pale: '#76726a' };
let frame: HTMLCanvasElement | undefined;

/**
 * A carved stone archway for the close-up, (STAND_W + 2·FRAME) × (STAND_H + 2·FRAME) base
 * px with the opening left clear. The head of the opening is a shallow arch that covers the
 * picture's top corners, and the top of the stone follows it, so the whole is arched. Roll mouldings run round the opening,
 * the arch is cut into voussoirs about a keystone, the jambs are coursed ashlar on capitals
 * and bases. Drawn once.
 */
export function renderFrame(): HTMLCanvasElement {
  if (frame) return frame;
  const w = STAND_W + 2 * FRAME;
  const h = STAND_H + 2 * FRAME;
  const cx = w / 2;
  const half = STAND_W / 2;
  const R = (half * half + ARCH_RISE * ARCH_RISE) / (2 * ARCH_RISE);
  /** Top of the opening in column x (flat past the springing, over the jambs). */
  const head = (x: number) => {
    const dx = Math.min(half, Math.abs(x + 0.5 - cx));
    return FRAME + Math.round(R - Math.sqrt(R * R - dx * dx));
  };
  /** Top of the stone in column x: the outside follows the same arch, so the whole is arched. */
  const RO = (cx * cx + ARCH_RISE * ARCH_RISE) / (2 * ARCH_RISE);
  const crown = (x: number) => Math.round(RO - Math.sqrt(RO * RO - (x + 0.5 - cx) ** 2));
  const spring = FRAME + ARCH_RISE;
  frame = document.createElement('canvas');
  frame.width = w;
  frame.height = h;
  const g = frame.getContext('2d')!;
  const px = (x: number, y: number, colour: string, pw = 1, ph = 1) => {
    g.fillStyle = colour;
    g.fillRect(x, y, pw, ph);
  };

  // The stone, weathered: flecks of shade and light, the same every time.
  px(0, 0, STONE.mid, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = (Math.imul(x * 374761393 + y * 668265263, 1274126177) >>> 8) % 100;
      if (n < 9) px(x, y, STONE.shade);
      else if (n > 93) px(x, y, STONE.light);
    }
  }

  // Jambs: coursed ashlar, joints staggered from side to side.
  for (const [x0, off] of [[1, 0], [w - FRAME + 5, 11]] as [number, number][]) {
    for (let y = spring + 10 + off; y < h - FRAME - 4; y += 22) {
      px(x0, y, STONE.dark, FRAME - 6, 1);
      px(x0, y + 1, STONE.light, FRAME - 6, 1);
    }
  }
  // Voussoirs: joints fanning out from the arch, and the bed of the masonry above them.
  for (let k = 0; 11 + k * 20 < half + 4; k++) {
    for (const side of [-1, 1]) {
      const xj = Math.round(cx + side * (11 + k * 20));
      for (let o = 5; o <= 11; o++) {
        const x = xj + Math.round((((xj - cx) / R) * o * 5) / 2);
        const y = head(xj) - o;
        if (x > 1 && x < w - 2 && y > crown(x) + 3) px(x, y, STONE.dark);
      }
    }
  }
  for (let x = 1; x < w - 1; x++) {
    if (head(x) - 12 > crown(x) + 4) px(x, head(x) - 12, STONE.dark);
    if (head(x) - 13 > crown(x) + 4) px(x, head(x) - 13, STONE.light);
  }
  // Mouldings round the opening, from its edge outward: a shadowed arris, a roll, a hollow.
  const bands = [STONE.ink, STONE.pale, STONE.light, STONE.shade, STONE.dark];
  for (let x = 1; x < w - 1; x++) bands.forEach((c, o) => px(x, head(x) - 1 - o, c));
  for (let y = spring; y < h - FRAME; y++) {
    bands.forEach((c, o) => {
      px(FRAME - 1 - o, y, c);
      px(w - FRAME + o, y, c);
    });
  }
  // The sill.
  bands.forEach((c, o) => px(FRAME - 1 - o, h - FRAME + o, c, w - 2 * (FRAME - 1 - o), 1));
  px(1, h - 6, STONE.dark, w - 2, 1);
  px(1, h - 5, STONE.light, w - 2, 4);
  px(1, h - 2, STONE.shade, w - 2, 1);

  // Capitals at the springing and bases on the sill: moulded blocks standing proud of the jambs.
  for (const x0 of [1, w - FRAME - 1]) {
    px(x0, spring - 3, STONE.ink, FRAME, 7);
    px(x0, spring - 2, STONE.pale, FRAME, 1);
    px(x0, spring - 1, STONE.light, FRAME, 2);
    px(x0 + 1, spring + 1, STONE.shade, FRAME - 2, 1);
    px(x0 + 2, spring + 2, STONE.dark, FRAME - 4, 1);
    px(x0, h - FRAME - 6, STONE.ink, FRAME, 7);
    px(x0 + 2, h - FRAME - 5, STONE.shade, FRAME - 4, 1);
    px(x0 + 1, h - FRAME - 4, STONE.light, FRAME - 2, 1);
    px(x0, h - FRAME - 3, STONE.pale, FRAME, 1);
    px(x0, h - FRAME - 2, STONE.light, FRAME, 2);
  }

  // The keystone, standing proud, with a cross cut into it.
  for (let y = 2; y <= FRAME + 1; y++) {
    const hw = 7 - Math.floor(((y - 2) * 2) / FRAME);
    px(cx - hw - 1, y, STONE.ink, 2 * hw + 2, 1);
    px(cx - hw, y, y === 2 ? STONE.pale : STONE.light, 2 * hw, 1);
    px(cx - hw, y, STONE.pale);
    px(cx + hw - 1, y, STONE.shade);
  }
  px(cx - 6, FRAME + 2, STONE.ink, 12, 1);
  px(cx - 1, 5, STONE.dark, 2, 9);
  px(cx - 3, 8, STONE.dark, 6, 2);

  // A cornice following the arched top, and the edge of the whole; nothing above the arch.
  for (let x = 0; x < w; x++) {
    const y = crown(x);
    g.clearRect(x, 0, 1, y);
    px(x, y, STONE.ink);
    if (Math.abs(x + 0.5 - cx) > 8 && x > 0 && x < w - 1) {
      px(x, y + 1, STONE.pale);
      px(x, y + 2, STONE.light);
      px(x, y + 3, STONE.dark);
    }
  }
  px(0, crown(0), STONE.ink, 1, h - crown(0));
  px(w - 1, crown(0), STONE.ink, 1, h - crown(0));
  px(0, h - 1, STONE.ink, w, 1);

  // The opening.
  for (let x = FRAME; x < w - FRAME; x++) g.clearRect(x, head(x), 1, h - FRAME - head(x));
  return frame;
}

/** Whole-pixel scale and place of the close-up on a display of this size, in display px. */
export function standPlacement(displayW: number, displayH: number): { k: number; x: number; y: number; w: number; h: number } {
  const k = Math.max(1, Math.floor(Math.min((displayW * 0.86) / (STAND_W + 2 * FRAME), (displayH * 0.76) / (STAND_H + 2 * FRAME))));
  const w = STAND_W * k;
  const h = STAND_H * k;
  return { k, x: Math.round((displayW - w) / 2), y: Math.round((displayH - h) / 2 + displayH * 0.02), w, h };
}
