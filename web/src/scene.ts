// The cathedral, seen straight on from the back of the nave: an altar at the top of each
// bay, rows of plain pews running on below the screen, arcade columns down both sides,
// votive stands in the arcades. Everything is drawn in near-neutral greys; the dither pass
// (dither.ts) turns it into a few dark tones, and the only colour in the scene is light
// through unseen stained-glass windows (glass.ts) high in the walls.

import { C, type CandleName } from '../../shared/constants';
import { LAYER, project, standFacesLeft, unproject, TH, TW, type Camera, type Drawable } from './view';
import { slotPoint } from './motion';
import { blur, saturate, designFor, dominantGlass, lancet, lightThrough, rasterise, toBytes, LANCET_LENGTH, type Rgb, type WindowDesign } from './glass';

const BAY_W = C.BAY_W;

/** How bright the nave is away from any candle (0 … 1). */
export const AMBIENT = 0.42;

/** The scene's greys, before lighting and the dither. */
export const COL = {
  floor: '#2c2a28',
  joint: '#1d1c1b',
  arcadeFloor: '#232120',
  wall: '#0f0e0e',
  reredos: '#3a3733',
  reredosLine: '#0c0b0b',
  altarTop: '#c2bcb0',
  altarFront: '#7c776f',
  pewTop: '#8e887e',
  pewRail: '#c4beb2',
  pewFront: '#45423d',
  column: '#6e6a63',
  columnEdge: '#a8a399',
  columnShade: '#3a3734',
  ink: '#050505',
  iron: '#1e1d1c',
  wax: '#e2ded5',
};

function local(x: number): number {
  return ((x % BAY_W) + BAY_W) % BAY_W;
}

/**
 * A box standing on the floor rectangle [xa, xb] × [ya, yb] (tile edges), `h` px tall:
 * its top face and the face toward the camera.
 */
function box(ctx: CanvasRenderingContext2D, cam: Camera, xa: number, xb: number, ya: number, yb: number, h: number, top: string, front: string, rail?: string) {
  const [l, back] = project(cam, xa, ya);
  const [r, fr] = project(cam, xb, yb);
  const depth = Math.max(1, fr - back);
  ctx.fillStyle = top;
  ctx.fillRect(l, back - h, r - l, depth);
  ctx.fillStyle = front;
  ctx.fillRect(l, fr - h, r - l, h);
  // Obra Dinn–style ink: a hard outline, and a pale rail where the top meets the front.
  ctx.fillStyle = COL.ink;
  ctx.fillRect(l - 1, back - h - 1, r - l + 2, 1);
  ctx.fillRect(l - 1, fr, r - l + 2, 1);
  ctx.fillRect(l - 1, back - h - 1, 1, fr - back + h + 2);
  ctx.fillRect(r, back - h - 1, 1, fr - back + h + 2);
  if (rail) {
    ctx.fillStyle = rail;
    ctx.fillRect(l, fr - h, r - l, 1);
  }
}

/** Pew rows in view: the seated rows and, beyond them, empty pews without end. */
export function pewRows(yMax: number): number[] {
  const rows: number[] = [];
  for (let y = C.ROW_Y[0]!; y <= yMax + 1; y += C.PEW_STEP_Y) rows.push(y);
  return rows;
}

const PEW_H = 9;
const COLUMN_H = 96;

export function drawStatic(ctx: CanvasRenderingContext2D, cam: Camera, x0: number, x1: number, yMax: number, baseW: number, baseH: number) {
  // Floor: large stone flags in two close greys.
  for (let x = x0; x <= x1; x++) {
    const lx = local(x);
    for (let y = -1; y <= yMax; y++) {
      const [sx, sy] = project(cam, x - 0.5, y - 0.5);
      if (sx > baseW || sy > baseH || sx + TW < 0 || sy + TH < 0) continue;
      ctx.fillStyle = lx >= C.ARCADE_X[0]! && lx <= C.ARCADE_X[1]! ? COL.arcadeFloor : COL.floor;
      ctx.fillRect(sx, sy, TW, TH);
      // Flagstone joints every two tiles, staggered row by row.
      ctx.fillStyle = COL.joint;
      if (y % 2 === 0) ctx.fillRect(sx, sy, TW, 1);
      if ((x + (Math.floor(y / 2) % 2)) % 2 === 0) ctx.fillRect(sx, sy, 1, TH);
    }
  }
  // The east wall behind the altars, rising past the top of the screen.
  const [, wallFoot] = project(cam, 0, -0.5);
  ctx.fillStyle = COL.wall;
  ctx.fillRect(0, 0, baseW, wallFoot);
  for (let b = Math.floor(x0 / BAY_W) - 1; b <= Math.floor(x1 / BAY_W) + 1; b++) {
    const [l] = project(cam, b * BAY_W + C.ALTAR_X[0]! - 1.5, 0);
    const [r] = project(cam, b * BAY_W + C.ALTAR_X[1]! + 1.5, 0);
    ctx.fillStyle = COL.reredos;
    ctx.fillRect(l, 0, r - l, wallFoot);
    ctx.fillStyle = COL.reredosLine;
    const mid = (l + r) / 2;
    for (const dx of [-28, 0, 28]) ctx.fillRect(Math.round(mid + dx), 0, 1, wallFoot - 4);
  }
}

/** Static furniture for every bay overlapping [x0, x1], down to yMax. */
export function furniture(cam: Camera, x0: number, x1: number, yMax: number): Drawable[] {
  const out: Drawable[] = [];
  const rows = pewRows(yMax);
  for (let b = Math.floor(x0 / BAY_W) - 1; b <= Math.floor(x1 / BAY_W) + 1; b++) {
    const bx = b * BAY_W;
    // Altar, cross and two candlesticks, at the top of the screen.
    out.push({
      depth: C.ALTAR_Y[1]!,
      layer: LAYER.furniture,
      x: bx,
      draw: (ctx) => {
        box(ctx, cam, bx + C.ALTAR_X[0]! - 0.5, bx + C.ALTAR_X[1]! + 0.5, C.ALTAR_Y[0]! - 0.5, C.ALTAR_Y[1]! + 0.5, 14, COL.altarTop, COL.altarFront, COL.pewRail);
        const [cx, top] = project(cam, bx + C.AISLE_CENTRE_X, C.ALTAR_Y[0]! + 0.5);
        ctx.fillStyle = COL.altarTop;
        ctx.fillRect(cx, top - 14 - 22, 1, 22);
        ctx.fillRect(cx - 5, top - 14 - 16, 11, 1);
        for (const dx of [-28, 28]) {
          ctx.fillRect(cx + dx, top - 14 - 6, 1, 6);
          ctx.fillStyle = COL.wax;
          ctx.fillRect(cx + dx, top - 14 - 10, 1, 4);
          ctx.fillStyle = COL.altarTop;
        }
      },
    });
    // Plain pews, one long bench per row, with a candle on each end.
    for (const ry of rows) {
      out.push({
        depth: ry - 0.6,
        layer: LAYER.furniture,
        x: bx,
        draw: (ctx) => {
          box(ctx, cam, bx + C.PEW_X[0]! - 0.5, bx + C.PEW_X[1]! + 0.5, ry - 0.85, ry - 0.45, PEW_H, COL.pewTop, COL.pewFront, COL.pewRail);
          for (const lx of [C.PEW_X[0]!, C.PEW_X[1]!]) {
            const [fx, fy] = pewEndCandle(cam, bx + lx, ry);
            ctx.fillStyle = COL.wax;
            ctx.fillRect(fx, fy + 1, 1, 3);
          }
        },
      });
    }
    // Arcade columns, the length of the nave, on both sides of the votive stands.
    for (const lx of [C.ARCADE_X[0]!, C.ARCADE_X[1]!]) {
      for (let cy = 2; cy <= yMax + 8; cy += C.COLUMN_STEP_Y) {
        const x = bx + lx;
        out.push({
          depth: cy,
          layer: LAYER.furniture,
          x,
          draw: (ctx) => {
            box(ctx, cam, x - 0.4, x + 0.4, cy - 0.3, cy + 0.3, COLUMN_H, COL.column, COL.column);
            const [l, foot] = project(cam, x - 0.4, cy + 0.3);
            const [r] = project(cam, x + 0.4, cy);
            ctx.fillStyle = COL.columnEdge;
            ctx.fillRect(l, foot - COLUMN_H, 1, COLUMN_H);
            ctx.fillStyle = COL.columnShade;
            ctx.fillRect(r - 2, foot - COLUMN_H, 2, COLUMN_H);
          },
        });
      }
    }
    // Votive stand: four iron tiers in the arcade, stepping up away from your column of pews.
    const facesLeft = standFacesLeft(cam, b);
    out.push({
      depth: C.STAND_Y[0]! - 0.5,
      layer: LAYER.furniture,
      x: bx,
      draw: (ctx) => {
        for (let t = 0; t < C.STAND_TIERS; t++) {
          const xa = facesLeft ? bx + C.STAND_X[0]! - 0.4 + t * 0.7 : bx + C.STAND_X[1]! + 0.4 - t * 0.7 - 0.7;
          box(ctx, cam, xa, xa + 0.7, C.STAND_Y[0]! - 0.3, C.STAND_Y[1]! + 0.3, 3 + t * 3, '#2a2928', COL.iron);
        }
      },
    });
  }
  return out;
}

export interface CandleView {
  arcade: number;
  slot: number;
  size: CandleName;
  litAt: number;
  expiresAt: number;
}

const CANDLE_SHAPE: Record<CandleName, { w: number; h: number }> = {
  taper: { w: 1, h: 6 },
  votive: { w: 3, h: 3 },
  pillar: { w: 3, h: 7 },
  paschal: { w: 3, h: 11 },
};

/** A candle on its stand. Its flame is drawn after the dither pass, if lit. */
export function candleDrawable(cam: Camera, c: CandleView, now: number, highlight: boolean): Drawable & { hit: [number, number, number, number] } {
  const p = slotPoint(c.arcade, c.slot, standFacesLeft(cam, c.arcade));
  const [cx, cy] = project(cam, p.x, p.y);
  const shape = CANDLE_SHAPE[c.size];
  const top = cy - 3 - p.lift - shape.h;
  return {
    depth: p.y + 0.1,
    layer: LAYER.flame,
    x: p.x,
    hit: [cx - 3, top - 4, 7, shape.h + 6],
    draw: (ctx) => {
      ctx.fillStyle = COL.wax;
      ctx.fillRect(cx - Math.floor(shape.w / 2), top, shape.w, shape.h);
      if (highlight) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(cx - 2, top + shape.h, 5, 1);
      }
      if (now < c.litAt) {
        ctx.fillStyle = '#111';
        ctx.fillRect(cx, top - 1, 1, 1);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Candlelight
// ---------------------------------------------------------------------------

/** Flame position of the candle on a pew end. */
function pewEndCandle(cam: Camera, x: number, ry: number): [number, number] {
  const [sx, sy] = project(cam, x, ry - 0.45);
  return [sx, sy - PEW_H - 5];
}

export interface Light {
  x: number;
  y: number;
  r: number;
  /** 0 … 1 */
  power: number;
}

/** Steady flames: two on each altar, one on every pew end. */
export function fixedLights(cam: Camera, x0: number, x1: number, yMax: number): Light[] {
  const out: Light[] = [];
  const rows = pewRows(yMax);
  for (let b = Math.floor(x0 / BAY_W) - 1; b <= Math.floor(x1 / BAY_W) + 1; b++) {
    const bx = b * BAY_W;
    const [ax, ay] = project(cam, bx + C.AISLE_CENTRE_X, C.ALTAR_Y[0]! + 0.5);
    out.push({ x: ax - 28, y: ay - 25, r: 52, power: 0.5 }, { x: ax + 28, y: ay - 25, r: 52, power: 0.5 });
    for (const ry of rows) {
      for (const lx of [C.PEW_X[0]!, C.PEW_X[1]!]) {
        const [x, y] = pewEndCandle(cam, bx + lx, ry);
        out.push({ x, y, r: 58, power: 0.55 });
      }
    }
  }
  return out;
}

/** Flame and its bright core, drawn after the dither pass so it stays a clean point of light. */
export function drawFlame(ctx: CanvasRenderingContext2D, x: number, y: number, now: number, seed: number) {
  const flick = Math.sin(now / 90 + seed * 1.7) + Math.sin(now / 37 + seed);
  const fh = flick > 0.8 ? 3 : 2;
  ctx.fillStyle = '#d9d6cf';
  ctx.fillRect(Math.round(x), Math.round(y) - fh + 1, 1, fh);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
}

export function drawFixedFlames(ctx: CanvasRenderingContext2D, cam: Camera, x0: number, x1: number, yMax: number, now: number) {
  fixedLights(cam, x0, x1, yMax).forEach((s, i) => drawFlame(ctx, s.x, s.y, now, i));
}

/** Where a stand candle's flame is. */
export function candleFlame(cam: Camera, c: CandleView): [number, number] {
  const p = slotPoint(c.arcade, c.slot, standFacesLeft(cam, c.arcade));
  const [cx, cy] = project(cam, p.x, p.y);
  return [cx, cy - 3 - p.lift - CANDLE_SHAPE[c.size].h - 1];
}

const lightCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : undefined;

/** Darken the whole frame to `ambient`, letting steady pools of candlelight through. */
export function applyLighting(ctx: CanvasRenderingContext2D, width: number, height: number, lights: Light[], ambient: number) {
  if (!lightCanvas) return;
  if (lightCanvas.width !== width || lightCanvas.height !== height) {
    lightCanvas.width = width;
    lightCanvas.height = height;
  }
  const l = lightCanvas.getContext('2d')!;
  l.globalCompositeOperation = 'source-over';
  const a = Math.round(255 * ambient);
  l.fillStyle = `rgb(${a},${a},${a})`;
  l.fillRect(0, 0, width, height);
  l.globalCompositeOperation = 'lighter';
  for (const s of lights) {
    if (s.x < -s.r || s.x > width + s.r || s.y < -s.r || s.y > height + s.r) continue;
    const grad = l.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r);
    grad.addColorStop(0, `rgba(255,255,255,${s.power})`);
    grad.addColorStop(0.45, `rgba(255,255,255,${s.power * 0.35})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    l.fillStyle = grad;
    l.fillRect(s.x - s.r, s.y - s.r, s.r * 2, s.r * 2);
  }
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(lightCanvas, 0, 0);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Coloured light from the windows
// ---------------------------------------------------------------------------

/** Rows of pews one pool of window light covers, and the rows of shadow between pools. */
export const GLOW_ROWS = 3.5;
export const GLOW_GAP_ROWS = 5;
/** Opacity of the light where it lies on the floor, and of its rays, laid over the frame. */
export const GLOW_FLOOR_ALPHA = 0.18;
export const GLOW_BEAM_ALPHA = 0.03;
/** How high the windows are above the floor, base px, and how far the rays lean toward them. */
const WINDOW_HEIGHT_PX = 260;
const BEAM_LEAN = 0.5;
/** How far the light stops short of an arcade's columns, tiles. */
const NAVE_INSET = 0.6;
/**
 * A pool is drawn from its window at low resolution (base px per pixel), then blurred (by
 * three box blurs of this radius, in those pixels) and scaled up smoothly, so the picture in
 * the glass is only a soft suggestion on the floor.
 */
const POOL_PX = 3;
const POOL_BLUR = 4;
/** How much a blurred pool's colours are pushed apart again (1 = as blurred). */
const POOL_SATURATION = 1.8;
/** Room round the window's image for the blur to spread into, in low-resolution pixels. */
const POOL_PAD = 3 * POOL_BLUR + 1;
/** Half the width of the soft edge of a pool, in window widths (its strength for windowLightAt). */
const POOL_SOFT = 0.1;
/** Rays of light per pool. */
const RAYS = 4;

function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** A pool of window light on the floor, in world tiles. */
export interface Glow {
  bay: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Which side its window is on; the pool reaches across to the opposite wall. */
  fromLeft: boolean;
  /** The window it comes through. */
  design: WindowDesign;
}

/**
 * Pools of window light, arranged around the viewer's own bay (`centre`): two down its
 * column of pews, 3–4 rows deep with 5 rows of shadow between, and one in each column
 * beside it, lying in that gap. Each is the image of a pointed lancet window lying on its
 * side: its sill a third of the way along the pews from the window, its apex at the far side
 * of the nave, stopping short of the arcade. Bays to the right are lit from their right-hand
 * window, so the part of them in view catches the light. `yBottom` is the bottom of the screen.
 */
export function glowsAround(centre: number, x0: number, x1: number, yBottom: number): Glow[] {
  const out: Glow[] = [];
  const pewW = C.PEW_X[1]! - C.PEW_X[0]!;
  const top = C.ROW_Y[0]! - 1.5;
  const rows = (yBottom - top) / C.PEW_STEP_Y;
  // The two pools in the middle, centred down the screen.
  const first = Math.max(0, (rows - (2 * GLOW_ROWS + GLOW_GAP_ROWS)) / 2);
  const second = first + GLOW_ROWS + GLOW_GAP_ROWS;
  const between = first + GLOW_ROWS + (GLOW_GAP_ROWS - GLOW_ROWS) / 2;
  for (let b = Math.floor(x0 / BAY_W) - 1; b <= Math.floor(x1 / BAY_W) + 1; b++) {
    const bx = b * BAY_W;
    const fromLeft = b <= centre;
    // The nave between the arcades: light never falls among the columns and votive stands.
    const inner: [number, number] = [bx + C.ARCADE_X[1]! + NAVE_INSET, bx + BAY_W + C.ARCADE_X[0]! - NAVE_INSET];
    const xs: [number, number] = fromLeft ? [bx + C.PEW_X[0]! + pewW / 3, inner[1]] : [inner[0], bx + C.PEW_X[1]! - pewW / 3];
    const starts = b === centre ? [first, second] : [between + (hash(b) - 0.5) * 1.2];
    starts.forEach((row, k) => {
      const y0 = top + row * C.PEW_STEP_Y;
      out.push({ bay: b, x0: xs[0], x1: xs[1], y0, y1: y0 + GLOW_ROWS * C.PEW_STEP_Y, fromLeft, design: designFor(b, fromLeft, k) });
    });
  }
  return out;
}

/** Where a floor point (world tiles) falls in a pool's window: u from the sill to the apex, v across. */
export function windowPoint(g: Glow, x: number, y: number): [number, number] {
  const u = g.fromLeft ? (x - g.x0) / (g.x1 - g.x0) : (g.x1 - x) / (g.x1 - g.x0);
  return [u, (y - g.y0) / (g.y1 - g.y0)];
}

/** Rings of offsets (window widths) to look for glass beside a point that falls on a lead. */
const NEAR = [0.04, 0.08, 0.13, 0.2, 0.28].flatMap((r) => Array.from({ length: 8 }, (_, i): [number, number] => [r * Math.cos((i * Math.PI) / 4), r * Math.sin((i * Math.PI) / 4)]));

/**
 * The window light at a point on the floor (world tiles), if it lies in a pool: the glass
 * colour there (or the nearest glass, on a lead) and how strong it is (0 … 1, soft at the
 * window's edges).
 */
export function windowLightAt(glows: Glow[], x: number, y: number): { colour: Rgb; strength: number } | undefined {
  for (const g of glows) {
    const [u, v] = windowPoint(g, x, y);
    const d = lancet(v - 0.5, u * LANCET_LENGTH);
    const strength = Math.max(0, Math.min(1, 0.5 - d / (2 * POOL_SOFT)));
    if (strength <= 0) continue;
    const here = g.design.glass(u, v);
    if (here) return { colour: here, strength };
    for (const [dx, dy] of NEAR) {
      const c = g.design.glass(u + dy / LANCET_LENGTH, v + dx);
      if (c) return { colour: c, strength };
    }
  }
  return undefined;
}

/** Pool images by window, side and size: every pool is the same size, so a few serve them all. */
const poolCache = new Map<string, HTMLCanvasElement>();

/**
 * A pool's image at low resolution, blurred: `w` × `h` base px of floor (plus POOL_PAD round
 * it) at 1/POOL_PX scale, at full opacity where the glass is.
 */
function poolImage(g: Glow, w: number, h: number): HTMLCanvasElement {
  const key = `${g.design.name}:${g.fromLeft}:${w}x${h}`;
  const cached = poolCache.get(key);
  if (cached) return cached;
  const lw = Math.ceil(w / POOL_PX) + 2 * POOL_PAD;
  const lh = Math.ceil(h / POOL_PX) + 2 * POOL_PAD;
  const px = rasterise(lw, lh, (i, j) => {
    const bx = (i - POOL_PAD) * POOL_PX;
    return g.design.glass(g.fromLeft ? bx / w : 1 - bx / w, ((j - POOL_PAD) * POOL_PX) / h);
  });
  blur(px, lw, lh, POOL_BLUR);
  saturate(px, POOL_SATURATION);
  const c = document.createElement('canvas');
  c.width = lw;
  c.height = lh;
  const cctx = c.getContext('2d')!;
  const img = cctx.createImageData(lw, lh);
  // On the floor the leads only dim the light a little, as it spreads past them: the glass
  // averages full strength.
  img.data.set(toBytes(px, 1 / lightThrough(g.design)));
  cctx.putImageData(img, 0, 0);
  poolCache.set(key, c);
  return c;
}

/** Lay the window light over the finished frame: a soft, low-opacity glow. */
export function applyRays(ctx: CanvasRenderingContext2D, rays: HTMLCanvasElement) {
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.drawImage(rays, 0, 0);
  ctx.restore();
}

/**
 * Window light, drawn into its own canvas and laid over the finished (dithered) frame as a
 * soft glow: its alpha is the light's opacity, its colour the glass it came through. A dim,
 * diffuse image of each window on the floor and pews, and fainter rays slanting down onto
 * it from the window.
 */
export function drawRays(ctx: CanvasRenderingContext2D, cam: Camera, x0: number, x1: number, width: number, height: number): Glow[] {
  ctx.clearRect(0, 0, width, height);
  const [, yBottom] = unproject(cam, width / 2, height);
  const glows = glowsAround(cam.bay, x0, x1, yBottom);
  drawGlows(ctx, cam, glows);
  return glows;
}

/** Draw pools of window light (see drawRays) onto a cleared canvas. */
export function drawGlows(ctx: CanvasRenderingContext2D, cam: Camera, glows: Glow[]) {
  if (typeof document === 'undefined') return;
  for (const g of glows) {
    const [sx0, sy0] = project(cam, g.x0, g.y0);
    const [sx1, sy1] = project(cam, g.x1, g.y1);
    const w = sx1 - sx0;
    const h = sy1 - sy0;

    // Rays: narrow shafts from the window high on its side down onto the pool, narrowing
    // toward the window, each in the glass that fills that part of it.
    const lean = (g.fromLeft ? 1 : -1) * WINDOW_HEIGHT_PX * BEAM_LEAN;
    const foot = sy0 + h * 0.55;
    ctx.save();
    ctx.globalAlpha = GLOW_BEAM_ALPHA;
    for (let i = 0; i < RAYS; i++) {
      const [u0, u1] = g.fromLeft ? [i / RAYS, (i + 1) / RAYS] : [1 - (i + 1) / RAYS, 1 - i / RAYS];
      const cx = sx0 + (w * (i + 0.5)) / RAYS;
      const half = (w / RAYS) * 0.32;
      const top = foot - WINDOW_HEIGHT_PX;
      ctx.fillStyle = `rgb(${dominantGlass(g.design, u0, u1).join(',')})`;
      ctx.beginPath();
      ctx.moveTo(cx - half, foot);
      ctx.lineTo(cx + half, foot);
      ctx.lineTo(cx - lean + half * 0.5, top);
      ctx.lineTo(cx - lean - half * 0.5, top);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // The pool: the window's image, soft and dim.
    const pad = POOL_PAD * POOL_PX;
    const img = poolImage(g, w, h);
    ctx.save();
    ctx.globalAlpha = GLOW_FLOOR_ALPHA;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx0 - pad, sy0 - pad, img.width * POOL_PX, img.height * POOL_PX);
    ctx.restore();
  }
}
