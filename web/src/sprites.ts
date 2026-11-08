// Priest sprites. Loads Universal LPC Spritesheet Character Generator exports from
// /sprites/<vestment>.png (64 × 64 frames, 832 px wide, rows up/left/down/right) and
// pre-scales them for the 16 × 8 tile grid. Missing sheets fall back to procedural figures.

import type { VestmentName } from '../../shared/constants';
import type { Dir, Pose } from './motion';

const FRAME = 64;
/** LPC characters are drawn for 32 px tiles; ours are 16 px wide, so halve them. */
export const SPRITE_SCALE = 0.5;
const DIR_ROW: Record<Dir, number> = { up: 0, left: 1, down: 2, right: 3 };

/** Animation blocks in the standard LPC sheet (first row, frame count). */
const ANIM = {
  spellcast: { row: 0, frames: 7 },
  thrust: { row: 4, frames: 8 },
  walk: { row: 8, frames: 9 },
  sit: { row: 30, frames: 3 },
} as const;

/** Leg cycle rate, matched to the slow 1 tile/s walk. */
const WALK_FPS = 5;

/** Candle lighting: the generator's "watering" cycle on the thrust rows. */
const LIGHT_CYCLE = [0, 1, 4, 4, 4, 4, 5];

export const VESTMENTS: VestmentName[] = ['friar', 'priest', 'bishop', 'cardinal'];
type SheetName = VestmentName | 'thurifer';

export function vestmentName(tag: string): VestmentName {
  const v = tag.toLowerCase() as VestmentName;
  return VESTMENTS.includes(v) ? v : 'friar';
}

export class PriestSprites {
  private sheets = new Map<SheetName, HTMLCanvasElement>();
  /** Each sheet as a flat pale silhouette, drawn offset by a pixel to outline the figure. */
  private outlines = new Map<SheetName, HTMLCanvasElement>();
  /** Silhouettes in the marking colour, made when first needed. */
  private marks = new Map<string, HTMLCanvasElement>();
  private scratch?: HTMLCanvasElement;

  static async load(base = '/sprites'): Promise<PriestSprites> {
    const s = new PriestSprites();
    await Promise.all(
      [...VESTMENTS, 'thurifer' as const].map(async (v) => {
        try {
          const img = await loadImage(`${base}/${v}.png`);
          if (img.width < 13 * FRAME || img.height < 34 * FRAME) return;
          const sheet = downscale(img, SPRITE_SCALE);
          s.sheets.set(v, sheet);
          s.outlines.set(v, silhouette(sheet, OUTLINE));
        } catch {
          // No sheet for this vestment yet: draw the placeholder.
        }
      }),
    );
    return s;
  }

  hasSheet(v: VestmentName): boolean {
    return this.sheets.has(v);
  }

  hasThuriferSheet(): boolean {
    return this.sheets.has('thurifer') || this.sheets.has('priest');
  }

  /**
   * The thurifer: /sprites/thurifer.png if present, else the priest sheet, else a placeholder
   * in cassock and white surplice. Returns where the thurible's bowl is.
   */
  drawThurifer(ctx: CanvasRenderingContext2D, pose: Pose, fx: number, fy: number, s: ThuribleState): [number, number] {
    const name: SheetName = this.sheets.has('thurifer') ? 'thurifer' : 'priest';
    const sheet = this.sheets.get(name);
    if (sheet) {
      const outline = this.outlines.get(name)!;
      for (const [dx, dy] of OUTLINE_OFFSETS) drawFromSheet(ctx, outline, pose, fx + dx, fy + dy);
      drawFromSheet(ctx, sheet, pose, fx, fy);
    } else drawPlaceholder(ctx, 'thurifer', pose, fx, fy);
    const [ox, oy] = handOffset(!!sheet);
    return drawThurible(ctx, Math.round(fx + ox), Math.round(fy + oy), s);
  }

  /** Draw a priest with its feet at (fx, fy) on the base canvas. */
  draw(ctx: CanvasRenderingContext2D, v: VestmentName, pose: Pose, fx: number, fy: number) {
    if (pose.action === 'gone' || pose.alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = pose.alpha;
    const sheet = this.sheets.get(v);
    if (sheet) {
      const outline = this.outlines.get(v)!;
      for (const [dx, dy] of OUTLINE_OFFSETS) drawFromSheet(ctx, outline, pose, fx + dx, fy + dy);
      drawFromSheet(ctx, sheet, pose, fx, fy);
    } else drawPlaceholder(ctx, v, pose, fx, fy);
    ctx.restore();
  }

  /**
   * A one-pixel ring of `colour` round a priest's figure. Drawn after the dither, over the
   * figure already there, so it keeps its colour.
   */
  mark(ctx: CanvasRenderingContext2D, v: VestmentName, pose: Pose, fx: number, fy: number, colour: string) {
    const sheet = this.sheets.get(v);
    if (!sheet || pose.action === 'gone' || pose.alpha <= 0) return;
    const key = `${v}:${colour}`;
    let ring = this.marks.get(key);
    if (!ring) {
      ring = silhouette(sheet, colour);
      this.marks.set(key, ring);
    }
    const f = FRAME * SPRITE_SCALE;
    const s = (this.scratch ??= document.createElement('canvas'));
    s.width = f + 4;
    s.height = f + 4;
    const sc = s.getContext('2d')!;
    // Feet placed so the frame lands at (2, 2) on the scratch canvas.
    const lx = f / 2 + 2;
    const ly = f - 2 + 2;
    for (const [dx, dy] of RING_OFFSETS) drawFromSheet(sc, ring, pose, lx + dx, ly + dy);
    sc.globalCompositeOperation = 'destination-out';
    drawFromSheet(sc, sheet, pose, lx, ly);
    sc.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.globalAlpha = pose.alpha;
    ctx.drawImage(s, Math.round(fx - f / 2) - 2, Math.round(fy - f + 2) - 2);
    ctx.restore();
  }
}

/** Where the thurible hangs from, relative to the feet, for a sheet or the placeholder. */
function handOffset(hasSheet: boolean): [number, number] {
  return hasSheet ? [6, -13] : [5, -9];
}

/** Where the thurifer's hand is, for a thurifer drawn with feet at (fx, fy). */
export function thuriferHand(sprites: PriestSprites, fx: number, fy: number): [number, number] {
  const [ox, oy] = handOffset(sprites.hasThuriferSheet());
  return [Math.round(fx + ox), Math.round(fy + oy)];
}

/** Bowl position of a thurible hanging from (hx, hy) at swing -1 … 1. */
export function thuribleBowl(hx: number, hy: number, swing: number): [number, number] {
  const angle = swing * 0.95;
  return [hx + Math.sin(angle) * 7, hy + Math.cos(angle) * 7 + 1];
}

export interface ThuribleState {
  /** -1 … 1 */
  swing: number;
}

/** Thurible on its chains, swinging ahead of the hand. Returns the bowl's position. */
export function drawThurible(ctx: CanvasRenderingContext2D, hx: number, hy: number, s: ThuribleState): [number, number] {
  const angle = s.swing * 0.95;
  const len = 7;
  const px = hx + Math.sin(angle) * len;
  const py = hy + Math.cos(angle) * len;
  ctx.fillStyle = '#b8902e';
  for (let i = 1; i < len; i++) ctx.fillRect(Math.round(hx + (Math.sin(angle) * len * i) / len), Math.round(hy + (Math.cos(angle) * len * i) / len), 1, 1);
  ctx.fillStyle = '#d4a531';
  ctx.fillRect(Math.round(px) - 1, Math.round(py), 3, 2);
  ctx.fillStyle = '#8a6a1e';
  ctx.fillRect(Math.round(px) - 1, Math.round(py) + 2, 3, 1);
  ctx.fillStyle = Math.abs(s.swing) > 0.8 ? '#ff9a3c' : '#c4562a';
  ctx.fillRect(Math.round(px), Math.round(py) - 1, 1, 1);
  return [px, py + 1];
}

function drawFromSheet(ctx: CanvasRenderingContext2D, sheet: HTMLCanvasElement, pose: Pose, fx: number, fy: number) {
  const f = FRAME * SPRITE_SCALE;
  let row: number;
  let col: number;
  switch (pose.action) {
    case 'walk':
      row = ANIM.walk.row + DIR_ROW[pose.dir];
      col = 1 + (Math.floor(pose.t * WALK_FPS) % (ANIM.walk.frames - 1));
      break;
    case 'light':
      row = ANIM.thrust.row + DIR_ROW[pose.dir];
      col = LIGHT_CYCLE[Math.min(LIGHT_CYCLE.length - 1, Math.floor(Math.max(0, pose.t) * 3.5))]!;
      break;
    default:
      row = ANIM.sit.row + DIR_ROW[pose.dir];
      col = 0;
  }
  // LPC feet sit about 4 px above the bottom of a 64 px frame.
  ctx.drawImage(sheet, col * f, row * f, f, f, Math.round(fx - f / 2), Math.round(fy - f + 2), f, f);
}

const PALETTE: Record<SheetName, { robe: string; trim: string; hat?: string }> = {
  thurifer: { robe: '#1d1b22', trim: '#f4f1ea' },
  friar: { robe: '#6b4a2b', trim: '#e8dcc0' },
  priest: { robe: '#1d1b22', trim: '#f2efe6' },
  bishop: { robe: '#f1ede2', trim: '#6c2c86', hat: '#f6f2e8' },
  cardinal: { robe: '#b0161c', trim: '#e9c46a', hat: '#c01820' },
};

/** A small figure in vestment colours: friar hood, white stole, mitre, scarlet zucchetto. */
function drawPlaceholder(ctx: CanvasRenderingContext2D, v: SheetName, pose: Pose, fx: number, fy: number) {
  const pal = PALETTE[v];
  const kneeling = pose.action === 'kneel';
  const bob = pose.action === 'walk' ? Math.round(Math.abs(Math.sin(pose.t * WALK_FPS)) * 1) : 0;
  const h = kneeling ? 9 : 13;
  const x = Math.round(fx);
  const y = Math.round(fy) - bob;
  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(x - 4, y - 1, 9, 2);
  // Robe (trapezoid)
  ctx.fillStyle = pal.robe;
  for (let i = 0; i < h; i++) {
    const w = 3 + Math.round((i / h) * 3);
    ctx.fillRect(x - w, y - h + i, w * 2 + 1, 1);
  }
  // Trim: stole (priest), cord (friar), pallium-ish band (bishop, cardinal), surplice (thurifer)
  ctx.fillStyle = pal.trim;
  if (v === 'thurifer') {
    for (let i = 0; i < Math.ceil(h * 0.55); i++) {
      const w = 3 + Math.round((i / h) * 3) + 1;
      ctx.fillRect(x - w, y - h + i, w * 2 + 1, 1);
    }
  } else if (v === 'priest') {
    ctx.fillRect(x - 2, y - h + 1, 1, h - 2);
    ctx.fillRect(x + 2, y - h + 1, 1, h - 2);
  } else if (v === 'friar') {
    ctx.fillRect(x - 4, y - h + 5, 9, 1);
  } else {
    ctx.fillRect(x - 3, y - h + 2, 7, 1);
    ctx.fillRect(x, y - h + 2, 1, 5);
  }
  // Arms reaching forward while lighting a candle
  if (pose.action === 'light') {
    ctx.fillStyle = pal.robe;
    const dx = pose.dir === 'left' ? -1 : 1;
    ctx.fillRect(x + dx * 4, y - h + 4, dx * 3, 2);
  }
  // Head
  const hy = y - h - 4;
  if (v === 'friar') {
    ctx.fillStyle = pal.robe; // hood
    ctx.fillRect(x - 3, hy - 1, 7, 6);
    ctx.fillStyle = '#e0b48c';
    if (pose.dir !== 'up') ctx.fillRect(x - 1, hy + 1, 3, 3);
  } else {
    ctx.fillStyle = '#e0b48c';
    ctx.fillRect(x - 2, hy, 5, 5);
    if (pose.dir === 'up') {
      ctx.fillStyle = '#8a8178';
      ctx.fillRect(x - 2, hy + 1, 5, 3);
    }
  }
  if (v === 'bishop') {
    ctx.fillStyle = pal.hat!; // mitre
    ctx.fillRect(x - 2, hy - 3, 5, 3);
    ctx.fillRect(x - 1, hy - 5, 3, 2);
    ctx.fillRect(x, hy - 6, 1, 1);
    ctx.fillStyle = '#d4a531';
    ctx.fillRect(x, hy - 3, 1, 3);
    // Crozier
    ctx.fillRect(x + 5, y - h - 6, 1, h + 5);
    ctx.fillRect(x + 4, y - h - 8, 2, 1);
    ctx.fillRect(x + 3, y - h - 7, 1, 2);
  } else if (v === 'cardinal') {
    ctx.fillStyle = pal.hat!; // zucchetto
    ctx.fillRect(x - 2, hy - 1, 5, 2);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`missing ${src}`));
    img.src = src;
  });
}

const OUTLINE = '#9a958b';
const OUTLINE_OFFSETS: [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
];
const RING_OFFSETS: [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

/** The sheet's shape filled with one colour. */
function silhouette(sheet: HTMLCanvasElement, colour: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = sheet.width;
  c.height = sheet.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(sheet, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

/** Scale a whole sheet once, averaging pixels, so per-frame draws are 1:1. */
function downscale(img: HTMLImageElement, scale: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  // Snap alpha so edges stay crisp after averaging.
  const data = ctx.getImageData(0, 0, c.width, c.height);
  for (let i = 3; i < data.data.length; i += 4) data.data[i] = data.data[i]! >= 96 ? 255 : 0;
  ctx.putImageData(data, 0, 0);
  return c;
}
