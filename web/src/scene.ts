// Placeholder tileset for the bay: floor, walls, arcades, altar, pews, votive stands and
// candles. Everything is drawn procedurally at base resolution until the art pass.

import { C, type CandleName } from '../../shared/constants';
import { LAYER, project, type Camera, type Drawable } from './iso';
import { slotPoint } from './motion';

const BAY_W = C.BAY_W;
const DEPTH = C.DOOR_Y;

const COL = {
  floorA: '#3a3330',
  floorB: '#433b37',
  arcadeFloor: '#2f2927',
  carpet: '#6e1b1f',
  carpetEdge: '#9b7a2f',
  wall: '#2a2422',
  wallTop: '#4a403b',
  glassA: '#2d4f8a',
  glassB: '#8a2d3c',
  glassC: '#c9a43a',
  pewTop: '#5c3a22',
  pewSide: '#3f2716',
  column: '#5a514b',
  columnShade: '#423a35',
  altarTop: '#efe8d8',
  altarSide: '#b9ae98',
  gold: '#d4a531',
  iron: '#1c1a1a',
};

function local(x: number): number {
  return ((x % BAY_W) + BAY_W) % BAY_W;
}

/** Fill the diamond of tile (x, y). */
function tile(ctx: CanvasRenderingContext2D, cam: Camera, x: number, y: number, color: string) {
  const [cx, cy] = project(cam, x, y);
  ctx.fillStyle = color;
  for (let i = 0; i < 8; i++) {
    const w = i < 4 ? i * 2 + 1 : (7 - i) * 2 + 1;
    ctx.fillRect(cx - w, cy - 4 + i, w * 2, 1);
  }
}

/** An isometric box whose base covers [x0, x1] × [y0, y1] tiles, `h` px tall. */
function box(ctx: CanvasRenderingContext2D, cam: Camera, x0: number, x1: number, y0: number, y1: number, h: number, top: string, left: string, right: string) {
  const a = project(cam, x0 - 0.5, y1 + 0.5); // left corner
  const b = project(cam, x1 + 0.5, y1 + 0.5); // front corner
  const c = project(cam, x1 + 0.5, y0 - 0.5); // right corner
  const d = project(cam, x0 - 0.5, y0 - 0.5); // back corner
  const poly = (pts: [number, number][], color: string) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(pts[0]![0], pts[0]![1]);
    for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
    ctx.closePath();
    ctx.fill();
  };
  poly([a, b, [b[0], b[1] - h], [a[0], a[1] - h]], left);
  poly([b, c, [c[0], c[1] - h], [b[0], b[1] - h]], right);
  poly([[a[0], a[1] - h], [b[0], b[1] - h], [c[0], c[1] - h], [d[0], d[1] - h]], top);
}

export function drawFloor(ctx: CanvasRenderingContext2D, cam: Camera, x0: number, x1: number) {
  for (let x = x0; x <= x1; x++) {
    const lx = local(x);
    for (let y = 0; y <= DEPTH; y++) {
      let color = (x + y) % 2 === 0 ? COL.floorA : COL.floorB;
      if (lx >= C.ARCADE_X[0]! && lx <= C.ARCADE_X[1]!) color = COL.arcadeFloor;
      if (lx >= C.AISLE_X[0]! && lx <= C.AISLE_X[1]! && y >= 4) color = lx === C.AISLE_CENTRE_X ? COL.carpet : COL.carpetEdge;
      tile(ctx, cam, x, y, color);
    }
  }
}

/** Static furniture for every bay overlapping [x0, x1]. */
export function furniture(cam: Camera, x0: number, x1: number): Drawable[] {
  const out: Drawable[] = [];
  const firstBay = Math.floor(x0 / BAY_W);
  const lastBay = Math.floor(x1 / BAY_W);

  // Back wall behind the altars (y = -1), with a window per bay.
  for (let x = x0; x <= x1; x++) {
    out.push({
      depth: x - 1,
      layer: LAYER.furniture,
      draw: (ctx) => {
        box(ctx, cam, x, x, -1, -1, 46, COL.wallTop, COL.wall, COL.wall);
        const lx = local(x);
        if (lx >= 15 && lx <= 19) {
          const [cx, cy] = project(cam, x + 0.5, -0.5);
          const glass = [COL.glassA, COL.glassB, COL.glassC][(lx + Math.floor(x / BAY_W)) % 3]!;
          ctx.fillStyle = glass;
          ctx.fillRect(cx - 6, cy - 40, 5, 22);
          ctx.fillStyle = COL.glassC;
          ctx.fillRect(cx - 4, cy - 42, 1, 2);
        }
      },
    });
  }

  for (let b = firstBay - 1; b <= lastBay + 1; b++) {
    const bx = b * BAY_W;
    // Low back wall with the door gap at the aisle.
    for (let lx = 0; lx < BAY_W; lx++) {
      const x = bx + lx;
      if (x < x0 - 2 || x > x1 + 2) continue;
      if (lx >= C.AISLE_X[0]! && lx <= C.AISLE_X[1]!) continue;
      out.push({ depth: x + DEPTH + 0.6, layer: LAYER.furniture, draw: (ctx) => box(ctx, cam, x, x, DEPTH + 0.6, DEPTH + 0.6, 5, COL.wallTop, COL.wall, COL.wall) });
    }
    // Arcade columns at the bay boundary and the inner edge of the arcade strip.
    for (const cx of [bx + C.ARCADE_X[0]!, bx + C.ARCADE_X[1]!]) {
      for (const cy of [0, 4, 13]) {
        out.push({ depth: cx + cy, layer: LAYER.furniture, draw: (ctx) => box(ctx, cam, cx, cx, cy, cy, 40, COL.column, COL.column, COL.columnShade) });
      }
    }
    // Altar with a cross and two candlesticks.
    out.push({
      depth: bx + C.ALTAR_X[1]! + C.ALTAR_Y[0]!,
      layer: LAYER.furniture,
      draw: (ctx) => {
        box(ctx, cam, bx + C.ALTAR_X[0]!, bx + C.ALTAR_X[1]!, C.ALTAR_Y[0]!, C.ALTAR_Y[1]!, 9, COL.altarTop, COL.altarSide, COL.altarSide);
        const [cx, cy] = project(cam, bx + C.AISLE_CENTRE_X, C.ALTAR_Y[0]! + 1);
        ctx.fillStyle = COL.gold;
        ctx.fillRect(cx, cy - 22, 1, 13);
        ctx.fillRect(cx - 3, cy - 19, 7, 1);
        for (const dx of [-14, 14]) {
          ctx.fillRect(cx + dx, cy - 13, 1, 4);
          ctx.fillStyle = '#ffd36b';
          ctx.fillRect(cx + dx, cy - 15, 1, 2);
          ctx.fillStyle = COL.gold;
        }
      },
    });
    // Pews: a kneeler bench in front of each seat (toward the altar).
    for (const ry of C.ROW_Y) {
      for (let i = 0; i < C.SEATS_PER_HALF_ROW; i++) {
        for (const lx of [C.LEFT_SEAT_X0 - i, C.RIGHT_SEAT_X0 + i]) {
          const x = bx + lx;
          if (x < x0 - 2 || x > x1 + 2) continue;
          out.push({ depth: x + ry - 0.7, layer: LAYER.furniture, draw: (ctx) => box(ctx, cam, x, x, ry - 0.7, ry - 0.7, 6, COL.pewTop, COL.pewSide, COL.pewSide) });
        }
      }
    }
    // Votive stand: four iron tiers across the arcade strip.
    const sx = bx + C.STAND_X[0]!;
    out.push({
      depth: bx + C.STAND_X[0]! + C.STAND_Y[0]!,
      layer: LAYER.furniture,
      draw: (ctx) => {
        for (let t = 0; t < C.STAND_TIERS; t++) {
          const x = sx + 2 - t * 0.7;
          box(ctx, cam, x, x, C.STAND_Y[0]!, C.STAND_Y[1]!, 2 + t * 3, '#2a2626', COL.iron, COL.iron);
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

const CANDLE_SHAPE: Record<CandleName, { w: number; h: number; color: string; band?: string }> = {
  taper: { w: 1, h: 6, color: '#f4efe1' },
  votive: { w: 3, h: 3, color: '#a3202a' },
  pillar: { w: 3, h: 7, color: '#efe4c8' },
  paschal: { w: 3, h: 11, color: '#f7f1df', band: '#b3262c' },
};

/** A candle on its stand; the flame appears at `litAt` and flickers. */
export function candleDrawable(cam: Camera, c: CandleView, now: number, highlight: boolean): Drawable & { hit: [number, number, number, number] } {
  const p = slotPoint(c.arcade, c.slot);
  const [cx, cy] = project(cam, p.x, p.y);
  const shape = CANDLE_SHAPE[c.size];
  const top = cy - 4 - p.lift - shape.h;
  return {
    depth: p.x + p.y + 0.1,
    layer: LAYER.flame,
    hit: [cx - 3, top - 4, 7, shape.h + 6],
    draw: (ctx) => {
      ctx.fillStyle = shape.color;
      ctx.fillRect(cx - Math.floor(shape.w / 2), top, shape.w, shape.h);
      if (shape.band) {
        ctx.fillStyle = shape.band;
        ctx.fillRect(cx - 1, top + 3, shape.w, 1);
        ctx.fillRect(cx, top + 2, 1, 3);
      }
      if (highlight) {
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.fillRect(cx - 2, top + shape.h, 5, 1);
      }
      if (now < c.litAt) {
        ctx.fillStyle = '#222';
        ctx.fillRect(cx, top - 1, 1, 1);
        return;
      }
      const flick = Math.sin(now / 90 + c.slot * 1.7) + Math.sin(now / 37 + c.arcade);
      const fh = flick > 0.8 ? 3 : 2;
      ctx.fillStyle = '#ffcf5a';
      ctx.fillRect(cx, top - fh, 1, fh);
      ctx.fillStyle = '#fff3c4';
      ctx.fillRect(cx, top - 1, 1, 1);
    },
  };
}

/** Warm glow under every lit candle, composited additively after the scene. */
export function drawGlows(ctx: CanvasRenderingContext2D, cam: Camera, candles: CandleView[], now: number) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const c of candles) {
    if (now < c.litAt) continue;
    const p = slotPoint(c.arcade, c.slot);
    const [cx, cy] = project(cam, p.x, p.y);
    const r = 10 + Math.sin(now / 120 + c.slot) * 1.2;
    const g = ctx.createRadialGradient(cx, cy - 8 - p.lift, 0, cx, cy - 8 - p.lift, r);
    g.addColorStop(0, 'rgba(255,170,60,0.22)');
    g.addColorStop(1, 'rgba(255,170,60,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - 8 - p.lift - r, r * 2, r * 2);
  }
  ctx.restore();
}
