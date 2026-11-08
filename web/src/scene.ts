// Placeholder tileset for the bay: floor, walls, arcades, altar, pews, votive stands and
// candles. Everything is drawn procedurally at base resolution until the art pass.

import { C, type CandleName } from '../../shared/constants';
import { LAYER, project, type Camera, type Drawable } from './iso';
import { slotPoint } from './motion';

const BAY_W = C.BAY_W;
const DEPTH = C.DOOR_Y;

const COL = {
  floorA: '#3a3430',
  floorB: '#3f3834',
  arcadeFloor: '#332d2a',
  carpet: '#5a2a28',
  wall: '#35302c',
  wallB: '#38322e',
  wallTop: '#4a433d',
  pilaster: '#433b36',
  course: 'rgba(0,0,0,0.18)',
  lead: '#161210',
  vault: '#0b0908',
  narthexA: '#2c2724',
  narthexB: '#302a27',
  glassA: '#2d4f8a',
  glassB: '#8a2d3c',
  glassC: '#c9a43a',
  // Plain wooden pews, a very muted, unsaturated brown.
  pewTop: '#70665c',
  pewFront: '#574e46',
  pewSide: '#4a423b',
  pewCap: '#80766b',
  column: '#5a524c',
  columnShade: '#47403b',
  altarTop: '#d9d2c4',
  altarSide: '#a39a8a',
  gold: '#b8902e',
  iron: '#1c1a1a',
  wax: '#e9e1cf',
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

/** Screen y of the back wall's foot (y = -0.5) at screen x. */
function wallFootY(cam: Camera, sx: number): number {
  return (sx - 4 - cam.ox) / 2 - 2 + cam.oy;
}

/** Fill the wall between heights h0 and h1(dx) px over the screen columns [sx0, sx1]. */
function wallSpan(ctx: CanvasRenderingContext2D, cam: Camera, sx0: number, sx1: number, h0: number, h1: (sx: number) => number, color: (sx: number, h: number) => string) {
  for (let sx = Math.round(sx0); sx < Math.round(sx1); sx++) {
    const foot = wallFootY(cam, sx);
    const top = Math.round(foot - h1(sx));
    const bottom = Math.round(foot - h0);
    for (let y = top; y < bottom; y += 2) {
      ctx.fillStyle = color(sx, Math.round(foot - y));
      ctx.fillRect(sx, y, 1, Math.min(2, bottom - y));
    }
  }
}

const GLASS = ['#2d4f8a', '#8a2d3c', '#c9a43a', '#2f6b4a', '#5a3d8a'];

/**
 * Everything that never moves and sits behind every priest: the nave floor and aisle, the
 * narthex beyond the door, and the back wall rising behind the altars with its windows.
 * Drawn once per camera into a cached layer.
 */
export function drawStatic(ctx: CanvasRenderingContext2D, cam: Camera, x0: number, x1: number, yMax: number, baseW: number, baseH: number) {
  ctx.fillStyle = COL.vault;
  ctx.fillRect(0, 0, baseW, baseH);

  // Back wall face, from its foot (y = -0.5) up past the top of the screen.
  for (let x = x0; x <= x1; x++) {
    const a = project(cam, x - 0.5, -0.5);
    const b = project(cam, x + 0.5, -0.5);
    const lx = local(x);
    ctx.fillStyle = lx === 0 || lx === 4 ? COL.pilaster : (Math.floor(x / BAY_W) % 2 === 0 ? COL.wall : COL.wallB);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(b[0], -60);
    ctx.lineTo(a[0], -60);
    ctx.closePath();
    ctx.fill();
  }
  // Stone courses.
  ctx.fillStyle = COL.course;
  const [sxa] = project(cam, x0 - 0.5, -0.5);
  const [sxb] = project(cam, x1 + 0.5, -0.5);
  for (let h = 12; h < baseH + 400; h += 12) {
    for (let sx = Math.round(sxa); sx < sxb; sx += 1) ctx.fillRect(sx, Math.round(wallFootY(cam, sx) - h), 1, 1);
  }
  // Windows: a tall three-light lancet above each altar, clerestory lights between.
  for (let b = Math.floor(x0 / BAY_W) - 1; b <= Math.floor(x1 / BAY_W) + 1; b++) {
    const [cx] = project(cam, b * BAY_W + C.AISLE_CENTRE_X, -0.5);
    const half = 22;
    wallSpan(
      ctx,
      cam,
      cx - half,
      cx + half,
      22,
      (sx) => 92 - ((sx - cx) / half) ** 2 * 16,
      (sx, h) => {
        const dx = sx - cx;
        if (Math.abs(dx) >= half - 1 || Math.abs(Math.abs(dx) - 7) < 1 || h % 10 < 2) return COL.lead;
        return GLASS[(Math.floor(h / 10) + (dx < -7 ? 0 : dx > 7 ? 2 : 1) + b) % GLASS.length]!;
      },
    );
    // Rose window above the lancets.
    wallSpan(ctx, cam, cx - 9, cx + 9, 100, (sx) => 100 + Math.sqrt(Math.max(0, 81 - (sx - cx) ** 2)) * 2, (sx, h) =>
      (sx - cx) ** 2 + ((h - 109) / 1) ** 2 < 4 ? COL.glassC : (h + sx) % 6 < 2 ? COL.lead : GLASS[(h + b) % 2 === 0 ? 0 : 1]!,
    );
    for (const lx of [8, 26]) {
      const [wx] = project(cam, b * BAY_W + lx, -0.5);
      wallSpan(ctx, cam, wx - 6, wx + 6, 70, (sx) => 104 - ((sx - wx) / 6) ** 2 * 6, (sx, h) =>
        Math.abs(sx - wx) >= 5 || h % 8 < 2 ? COL.lead : GLASS[(Math.floor(h / 8) + b + lx) % 2 === 0 ? 0 : 4]!,
      );
    }
  }
  // The vault darkens toward the top of the screen.
  const g = ctx.createLinearGradient(0, 0, 0, baseH * 0.7);
  g.addColorStop(0, 'rgba(6,4,3,0.75)');
  g.addColorStop(1, 'rgba(6,4,3,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, baseW, baseH);

  // Floor: nave, arcades and aisle carpet; the narthex continues past the door wall.
  for (let x = x0; x <= x1; x++) {
    const lx = local(x);
    for (let y = 0; y <= yMax; y++) {
      const [cx, cy] = project(cam, x, y);
      if (cx < -10 || cx > baseW + 10 || cy < -6 || cy > baseH + 6) continue;
      let color: string;
      if (y > DEPTH) color = (x + y) % 2 === 0 ? COL.narthexA : COL.narthexB;
      else {
        color = (x + y) % 2 === 0 ? COL.floorA : COL.floorB;
        if (lx >= C.ARCADE_X[0]! && lx <= C.ARCADE_X[1]!) color = COL.arcadeFloor;
        if (lx >= C.AISLE_X[0]! && lx <= C.AISLE_X[1]! && y >= C.BACK_WALK_Y) color = COL.carpet;
        if (lx >= C.ALTAR_X[0]! && lx <= C.ALTAR_X[1]! && y === C.ALTAR_Y[1]! + 1) color = COL.carpet;
      }
      tile(ctx, cam, x, y, color);
    }
  }
}

/** Static furniture for every bay overlapping [x0, x1]. */
export function furniture(cam: Camera, x0: number, x1: number): Drawable[] {
  const out: Drawable[] = [];
  const firstBay = Math.floor(x0 / BAY_W);
  const lastBay = Math.floor(x1 / BAY_W);

  for (let b = firstBay - 1; b <= lastBay + 1; b++) {
    const bx = b * BAY_W;
    // Low back wall with the door gap at the aisle.
    for (let lx = 0; lx < BAY_W; lx++) {
      const x = bx + lx;
      if (x < x0 - 2 || x > x1 + 2) continue;
      if (lx >= C.AISLE_X[0]! && lx <= C.AISLE_X[1]!) continue;
      out.push({ depth: x + DEPTH + 0.6, layer: LAYER.furniture, draw: (ctx) => box(ctx, cam, x, x, DEPTH + 0.6, DEPTH + 0.6, 5, COL.wallTop, COL.wall, COL.wall) });
    }
    // Arcade columns at the bay boundary and the inner edge of the arcade strip, each with
    // a candle in a sconce on the faces that line the side aisles.
    for (const cx of [bx + C.ARCADE_X[0]!, bx + C.ARCADE_X[1]!]) {
      for (const cy of COLUMN_Y) {
        out.push({
          depth: cx + cy,
          layer: LAYER.furniture,
          draw: (ctx) => {
            box(ctx, cam, cx, cx, cy, cy, 72, COL.column, COL.column, COL.columnShade);
            if (SCONCE_Y.includes(cy)) {
              const [sx, sy] = sconcePoint(cam, cx, cy);
              ctx.fillStyle = COL.iron;
              ctx.fillRect(sx - 1, sy + 4, 3, 1);
              ctx.fillStyle = COL.wax;
              ctx.fillRect(sx, sy + 1, 1, 3);
            }
          },
        });
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
          ctx.fillStyle = COL.wax;
          ctx.fillRect(cx + dx, cy - 16, 1, 3);
          ctx.fillStyle = COL.gold;
        }
      },
    });
    // Four long, plain wooden pews spanning the nave between the side aisles, one in front
    // of each row of seats; drawn in tile-long pieces so they sort with the priests.
    for (const ry of C.ROW_Y) {
      const py = ry - 0.6;
      for (let lx = C.PEW_X[0]!; lx <= C.PEW_X[1]!; lx++) {
        const x = bx + lx;
        if (x < x0 - 2 || x > x1 + 2) continue;
        const end = lx === C.PEW_X[0]! || lx === C.PEW_X[1]!;
        out.push({
          depth: x + py,
          layer: LAYER.furniture,
          draw: (ctx) => {
            box(ctx, cam, x, x, py, py, PEW_H, COL.pewTop, COL.pewFront, COL.pewSide);
            // A worn top rail along the back of the pew.
            const [ex, ey] = project(cam, x - 0.5, py + 0.5);
            ctx.fillStyle = COL.pewCap;
            for (let i = 0; i < 8; i++) ctx.fillRect(ex + i, ey - PEW_H + Math.floor(i / 2), 1, 1);
            if (end) {
              // A candle on each pew end, lining the side aisles.
              const [sx, sy] = pewEndCandle(cam, x, py);
              ctx.fillStyle = COL.wax;
              ctx.fillRect(sx, sy + 1, 1, 3);
            }
          },
        });
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
      // Unlit wick until lit_at; the flame itself is drawn after the lighting pass.
      if (now < c.litAt) {
        ctx.fillStyle = '#222';
        ctx.fillRect(cx, top - 1, 1, 1);
      }
    },
  };
}

const COLUMN_Y = [0, 4, 13];
const PEW_H = 10;
const SCONCE_Y = [4, 13];

/** Flame position of the sconce on column (cx, cy). */
function sconcePoint(cam: Camera, cx: number, cy: number): [number, number] {
  const [sx, sy] = project(cam, cx + 0.5, cy + 0.5);
  return [sx, sy - 26];
}

/** Flame position of the candle on a pew end. */
function pewEndCandle(cam: Camera, x: number, py: number): [number, number] {
  const [sx, sy] = project(cam, x, py);
  return [sx, sy - PEW_H - 7];
}

export interface Light {
  x: number;
  y: number;
  r: number;
  /** 0 … 1 */
  power: number;
  rgb?: [number, number, number];
}

const WARM: [number, number, number] = [255, 176, 98];

/** Steady candle flames for every bay in view: altar, column sconces, pew ends. */
export function fixedLights(cam: Camera, x0: number, x1: number): Light[] {
  const out: Light[] = [];
  for (let b = Math.floor(x0 / BAY_W) - 1; b <= Math.floor(x1 / BAY_W) + 1; b++) {
    const bx = b * BAY_W;
    for (const cx of [bx + C.ARCADE_X[0]!, bx + C.ARCADE_X[1]!]) {
      for (const cy of SCONCE_Y) {
        const [x, y] = sconcePoint(cam, cx, cy);
        out.push({ x, y, r: 46, power: 0.5 });
      }
    }
    const [ax, ay] = project(cam, bx + C.AISLE_CENTRE_X, C.ALTAR_Y[0]! + 1);
    out.push({ x: ax - 14, y: ay - 17, r: 40, power: 0.45 }, { x: ax + 14, y: ay - 17, r: 40, power: 0.45 });
    // Faint light through the lancet window behind each altar.
    const [wx, wy] = project(cam, bx + C.AISLE_CENTRE_X, -0.5);
    out.push({ x: wx, y: wy - 50, r: 70, power: 0.22, rgb: [150, 170, 220] });
    for (const ry of C.ROW_Y) {
      for (const lx of [C.PEW_X[0]!, C.PEW_X[1]!]) {
        const [x, y] = pewEndCandle(cam, bx + lx, ry - 0.6);
        out.push({ x, y, r: 64, power: 0.5 });
      }
    }
  }
  return out;
}

/** Flame and its tiny bright core, drawn after the lighting pass so it stays bright. */
export function drawFlame(ctx: CanvasRenderingContext2D, x: number, y: number, now: number, seed: number) {
  const flick = Math.sin(now / 90 + seed * 1.7) + Math.sin(now / 37 + seed);
  const fh = flick > 0.8 ? 3 : 2;
  ctx.fillStyle = '#ffcf5a';
  ctx.fillRect(Math.round(x), Math.round(y) - fh + 1, 1, fh);
  ctx.fillStyle = '#fff3c4';
  ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
}

const lightCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : undefined;

/**
 * Darken the whole scene, then let candlelight through: an ambient level multiplied over the
 * frame, plus warm flickering pools around every light.
 */
export function applyLighting(ctx: CanvasRenderingContext2D, width: number, height: number, lights: Light[], ambient = 0.2) {
  if (!lightCanvas) return;
  if (lightCanvas.width !== width || lightCanvas.height !== height) {
    lightCanvas.width = width;
    lightCanvas.height = height;
  }
  const l = lightCanvas.getContext('2d')!;
  l.globalCompositeOperation = 'source-over';
  const a = Math.round(255 * ambient);
  l.fillStyle = `rgb(${a},${Math.round(a * 0.92)},${Math.round(a * 0.86)})`;
  l.fillRect(0, 0, width, height);
  l.globalCompositeOperation = 'lighter';
  lights.forEach((s) => {
    if (s.x < -s.r || s.x > width + s.r || s.y < -s.r || s.y > height + s.r) return;
    // Pools are steady; only the flames themselves flicker (drawn after this pass). Keeping
    // the light map still also lets recordings compress: nothing changes where nothing moves.
    const [r, g, b] = s.rgb ?? WARM;
    const grad = l.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r);
    grad.addColorStop(0, `rgba(${r},${g},${b},${s.power})`);
    grad.addColorStop(0.45, `rgba(${r},${g},${b},${s.power * 0.35})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    l.fillStyle = grad;
    l.fillRect(s.x - s.r, s.y - s.r, s.r * 2, s.r * 2);
  });
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(lightCanvas, 0, 0);
  ctx.restore();
}

/** Flames of the fixed candles (sconces, altar, pew ends), after lighting. */
export function drawFixedFlames(ctx: CanvasRenderingContext2D, cam: Camera, x0: number, x1: number, now: number) {
  let i = 0;
  for (const s of fixedLights(cam, x0, x1)) {
    if (s.rgb) continue;
    drawFlame(ctx, s.x, s.y, now, i++);
  }
}

/** Where a stand candle's flame is, for lighting. */
export function candleFlame(cam: Camera, c: CandleView): [number, number] {
  const p = slotPoint(c.arcade, c.slot);
  const [cx, cy] = project(cam, p.x, p.y);
  return [cx, cy - 4 - p.lift - CANDLE_SHAPE[c.size].h - 1];
}
