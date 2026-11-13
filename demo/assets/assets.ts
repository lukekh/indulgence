// Asset sheets for review, drawn by the viewer's own code: the cathedral, the altar, the
// pews, a votive stand, the stained-glass windows and every priest. Each shows the asset as
// it looks in game (candlelit and dithered) above the same thing raw (flat greys, before
// lighting and the dither). render-assets.ts saves each sheet as a JPEG.

import { C, seatPos, type CandleName, type VestmentName } from '../../shared/constants';
import { bayCentreX, cameraFor, project, sortDrawables, unproject, viewportFor, visibleTiles, LAYER, type Camera, type Drawable, type Viewport } from '../../web/src/view';
import { AMBIENT, COL, GLOW_BEAM_ALPHA, GLOW_FLOOR_ALPHA, applyLighting, applyRays, candleDrawable, candleFlame, drawFixedFlames, drawFlame, drawGlows, drawRays, drawStatic, fixedLights, furniture, glowsAround, windowLightAt, type CandleView, type Glow, type Light } from '../../web/src/scene';
import { DESIGNS, GLASS, LANCET_LENGTH, rasterise, toBytes, type WindowDesign } from '../../web/src/glass';
import { ditherFrame } from '../../web/src/dither';
import { PriestSprites, VESTMENTS, type Side } from '../../web/src/sprites';
import { renderFrame, renderStand, standSeed, FRAME, STAND_H, STAND_W, type StandCandle } from '../../web/src/stand';
import { FACE, loadFont } from '../../web/src/text';
import type { Dir, Pose } from '../../web/src/motion';

/** A fixed moment, so flames and shafts of light are the same on every run. */
const NOW = 1_000_000;
const DISPLAY_W = 1440;
const DISPLAY_H = 900;
const BG = '#0a0909';

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
const ctx2d = (c: HTMLCanvasElement) => c.getContext('2d', { willReadFrequently: true })!;

// ---------------------------------------------------------------------------
// The nave, drawn as the viewer draws a frame (without priests or words)
// ---------------------------------------------------------------------------

/** Figures placed in the nave (world tiles in `pose`), and whether the windows light their sides. */
interface People {
  sprites: PriestSprites;
  figures: { name: VestmentName | 'thurifer'; pose: Pose }[];
  rim: boolean;
}

/** Changes the windows of the pools of light in view (for showing one design in place). */
type Windows = (glows: Glow[]) => Glow[];

/** The window light as the viewer draws it, or with its windows changed by `windows`. */
function windowLight(rctx: CanvasRenderingContext2D, vp: Viewport, cam: Camera, windows?: Windows): Glow[] {
  const { baseW: w, baseH: h } = vp;
  const { x0, x1 } = visibleTiles(cam, vp);
  if (!windows) return drawRays(rctx, cam, x0, x1, w, h);
  const [, yBottom] = unproject(cam, w / 2, h);
  const glows = windows(glowsAround(cam.bay, x0, x1, yBottom));
  rctx.clearRect(0, 0, w, h);
  drawGlows(rctx, cam, glows);
  return glows;
}

function nave(vp: Viewport, cam: Camera, candles: CandleView[], raw: boolean, people?: People, windows?: Windows): HTMLCanvasElement {
  const { baseW: w, baseH: h } = vp;
  const base = canvas(w, h);
  const ctx = ctx2d(base);
  const { x0, x1, yMax } = visibleTiles(cam, vp);
  drawStatic(ctx, cam, x0, x1, yMax, w, h);
  const drawables: Drawable[] = furniture(cam, x0, x1, yMax);
  for (const c of candles) drawables.push(candleDrawable(cam, c, NOW, false));
  for (const f of people?.figures ?? []) {
    const [fx, fy] = project(cam, f.pose.x, f.pose.y);
    drawables.push({
      depth: f.pose.y,
      layer: LAYER.priest,
      x: f.pose.x,
      draw: (g) => (f.name === 'thurifer' ? void people!.sprites.drawThurifer(g, f.pose, fx, fy, { swing: 0.5 }) : people!.sprites.draw(g, f.name, f.pose, fx, fy)),
    });
  }
  for (const d of sortDrawables(drawables)) d.draw(ctx);
  if (!raw) {
    const lights: Light[] = fixedLights(cam, x0, x1, yMax);
    for (const c of candles) {
      const [fx, fy] = candleFlame(cam, c);
      lights.push({ x: fx, y: fy, r: 30, power: 0.5 });
    }
    applyLighting(ctx, w, h, lights, AMBIENT);
    ditherFrame(ctx, w, h);
    const rays = canvas(w, h);
    const glows = windowLight(ctx2d(rays), vp, cam, windows);
    applyRays(ctx, rays);
    if (people?.rim) {
      for (const f of people.figures) {
        const [fx, fy] = project(cam, f.pose.x, f.pose.y);
        const side: Side = Math.floor(f.pose.x / C.BAY_W) <= cam.bay ? 'left' : 'right';
        people.sprites.litSide(ctx, f.name, f.pose, fx, fy, side, windowLightAt(glows, f.pose.x, f.pose.y));
      }
    }
  }
  drawFixedFlames(ctx, cam, x0, x1, yMax, NOW);
  candles.forEach((c, i) => {
    const [fx, fy] = candleFlame(cam, c);
    drawFlame(ctx, fx, fy, NOW, i);
  });
  return base;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Crops of one render side by side, a few dark pixels apart. */
function pair(src: HTMLCanvasElement, rects: Rect[], gap = 6): HTMLCanvasElement {
  const w = rects.reduce((n, r) => n + r.w, 0) + gap * (rects.length - 1);
  const h = Math.max(...rects.map((r) => r.h));
  const out = canvas(w, h);
  const g = out.getContext('2d')!;
  g.fillStyle = BG;
  g.fillRect(0, 0, w, h);
  let x = 0;
  for (const r of rects) {
    g.drawImage(src, r.x, r.y, r.w, r.h, x, 0, r.w, r.h);
    x += r.w + gap;
  }
  return out;
}

/** Canvases side by side, a few dark pixels apart. */
function beside(srcs: HTMLCanvasElement[], gap = 6): HTMLCanvasElement {
  const w = srcs.reduce((n, c) => n + c.width, 0) + gap * (srcs.length - 1);
  const out = canvas(w, Math.max(...srcs.map((c) => c.height)));
  const g = out.getContext('2d')!;
  g.fillStyle = BG;
  g.fillRect(0, 0, out.width, out.height);
  srcs.reduce((x, c) => (g.drawImage(c, x, 0), x + c.width + gap), 0);
  return out;
}

/** The window light alone, on black, at `gain` times its real strength. */
function lightOnly(vp: Viewport, cam: Camera, gain: number, windows?: Windows): HTMLCanvasElement {
  const { baseW: w, baseH: h } = vp;
  const rays = canvas(w, h);
  const rctx = ctx2d(rays);
  windowLight(rctx, vp, cam, windows);
  const img = rctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = Math.min(1, (d[i + 3]! / 255) * gain);
    d[i] = Math.round(d[i]! * a);
    d[i + 1] = Math.round(d[i + 1]! * a);
    d[i + 2] = Math.round(d[i + 2]! * a);
    d[i + 3] = 255;
  }
  rctx.putImageData(img, 0, 0);
  return rays;
}

// ---------------------------------------------------------------------------
// Sheets: a title, then panels top to bottom, each scaled up by whole pixels
// ---------------------------------------------------------------------------

interface Panel {
  label: string;
  src: HTMLCanvasElement;
  /** Source rectangle, base px. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Whole-number scale. */
  k: number;
  /** Captions under the panel, centred on these source x positions. */
  captions?: { x: number; text: string }[];
}

function sheet(title: string, subtitle: string, panels: Panel[]): HTMLCanvasElement {
  const pad = 32;
  const titleH = 72;
  const labelH = 30;
  const capH = 30;
  const gap = 26;
  const measure = canvas(1, 1).getContext('2d')!;
  measure.font = `600 32px ${FACE}`;
  let textW = measure.measureText(title).width;
  measure.font = `500 18px ${FACE}`;
  textW = Math.max(textW, measure.measureText(subtitle).width);
  const W = Math.ceil(Math.max(textW, ...panels.map((p) => p.w * p.k))) + pad * 2;
  const H = pad + titleH + panels.reduce((n, p) => n + labelH + p.h * p.k + (p.captions ? capH : 0) + gap, 0) - gap + pad;
  const out = canvas(W, H);
  const g = out.getContext('2d')!;
  g.fillStyle = BG;
  g.fillRect(0, 0, W, H);
  g.textBaseline = 'top';
  g.fillStyle = '#f2f0ea';
  g.font = `600 32px ${FACE}`;
  g.fillText(title, pad, pad);
  g.fillStyle = '#8f8a80';
  g.font = `500 18px ${FACE}`;
  g.fillText(subtitle, pad, pad + 40);
  let y = pad + titleH;
  for (const p of panels) {
    g.fillStyle = '#8f8a80';
    g.font = `500 18px ${FACE}`;
    g.fillText(p.label, pad, y + 4);
    y += labelH;
    g.imageSmoothingEnabled = false;
    g.drawImage(p.src, p.x, p.y, p.w, p.h, pad, y, p.w * p.k, p.h * p.k);
    g.strokeStyle = 'rgba(160, 154, 142, 0.3)';
    g.strokeRect(pad - 0.5, y - 0.5, p.w * p.k + 1, p.h * p.k + 1);
    y += p.h * p.k;
    if (p.captions) {
      g.fillStyle = '#c4beb2';
      g.font = `500 17px ${FACE}`;
      for (const c of p.captions) {
        const w = g.measureText(c.text).width;
        g.fillText(c.text, pad + c.x * p.k - w / 2, y + 7);
      }
      y += capH;
    }
    y += gap;
  }
  return out;
}

/** A crop of the nave in tiles, in game above raw. */
function naveSheet(title: string, subtitle: string, tiles: { x0: number; x1: number; y0: number; y1: number; above?: number }, k: number, candles: CandleView[] = []) {
  const vp = viewportFor(DISPLAY_W, DISPLAY_H);
  const cam = cameraFor(bayCentreX(C.AISLE_CENTRE_X), vp);
  const [ax, ay] = project(cam, tiles.x0, tiles.y0);
  const [bx, by] = project(cam, tiles.x1, tiles.y1);
  const top = Math.max(0, ay - (tiles.above ?? 0));
  const r = { x: ax, y: top, w: bx - ax, h: by - top };
  return sheet(title, subtitle, [
    { label: `in game: candlelit and dithered (${k}×)`, src: nave(vp, cam, candles, false), ...r, k },
    { label: `raw: flat greys before lighting and the dither (${k}×)`, src: nave(vp, cam, candles, true), ...r, k },
  ]);
}

// ---------------------------------------------------------------------------
// Stained glass
// ---------------------------------------------------------------------------

/** What each window shows, for its caption. */
const SUBJECTS: Record<string, string> = {
  'Agnus Dei': 'the Lamb of God with the banner of the Resurrection, on a green hill; a star above',
  Pentecost: 'the Holy Spirit as a dove, descending in gold rays on tongues of fire',
  'A saint': 'a saint with a book, robed in blue and green, haloed, under a canopy, on red',
  'Station II': 'the second station of the cross: Christ, bowed, takes up the cross',
  Grisaille: 'pale glass in a lattice of leads, with a green stem through three quatrefoils',
  'Chi-Rho': 'the monogram of Christ in a green wreath, a star above',
  'Pelican in her piety': 'the pelican feeding her young from her own breast, above her nest',
  'Keys of Saint Peter': 'the keys of the kingdom, crossed, one gold and one silver',
  'Madonna and Child': 'the Virgin in a blue mantle holding the Child, both haloed',
  'Saint George': 'his shield with its red cross, and his lance through the dragon',
  'Annunciation lilies': 'white lilies in a gold vase',
  Calvary: 'three crosses on a green hill, the sun and the moon above',
  'The True Vine': 'a winding vine with leaves and clusters of grapes',
  "Saint Catherine's wheel": 'the spiked wheel of her martyrdom, under a crown',
  'Sacred Heart': 'the heart aflame, bound with thorns, in a glory of rays',
};
/** Windows per row on the sheet of designs. */
const LANCETS_PER_ROW = 5;

const LANCET_W = 64;
const LANCET_GAP = 28;

/** Every window as designed, upright and crisp, side by side. */
function lancets(designs: WindowDesign[]): HTMLCanvasElement {
  const h = LANCET_W * LANCET_LENGTH;
  const c = canvas(designs.length * (LANCET_W + LANCET_GAP) - LANCET_GAP, h);
  const g = ctx2d(c);
  g.fillStyle = BG;
  g.fillRect(0, 0, c.width, c.height);
  designs.forEach((d, i) => {
    const px = rasterise(LANCET_W, h, (x, y) => d.glass(1 - y / h, x / LANCET_W), 4);
    const img = g.createImageData(LANCET_W, h);
    img.data.set(toBytes(px));
    const one = canvas(LANCET_W, h);
    ctx2d(one).putImageData(img, 0, 0);
    g.drawImage(one, i * (LANCET_W + LANCET_GAP), 0);
  });
  return c;
}

// ---------------------------------------------------------------------------
// Priests
// ---------------------------------------------------------------------------

const CELL_W = 40;
const CELL_H = 44;
const FEET_Y = 40;

type Figure = { caption: string; draw: (ctx: CanvasRenderingContext2D, fx: number, fy: number) => void };

/**
 * Figures on the nave floor, candlelit and dithered, with the window light on their left
 * side: none, the faint edge they have everywhere, or standing in a pool of ruby glass.
 */
function rimStrip(sprites: PriestSprites, figures: { caption: string; name: VestmentName | 'thurifer'; pose: Pose }[], mode: 'none' | 'faint' | 'pool'): HTMLCanvasElement {
  const c = strip(
    figures.map((f) => ({ caption: f.caption, draw: (g, fx, fy) => (f.name === 'thurifer' ? void sprites.drawThurifer(g, f.pose, fx, fy, { swing: 0.5 }) : sprites.draw(g, f.name, f.pose, fx, fy)) })),
    true,
  );
  const g = ctx2d(c);
  const ruby = GLASS.ruby;
  if (mode === 'pool') {
    g.save();
    g.globalCompositeOperation = 'screen';
    g.fillStyle = `rgba(${ruby.join(',')},${GLOW_FLOOR_ALPHA})`;
    g.fillRect(0, 0, c.width, c.height);
    g.restore();
  }
  if (mode !== 'none') {
    figures.forEach((f, i) => sprites.litSide(g, f.name, f.pose, i * CELL_W + CELL_W / 2, FEET_Y, 'left', mode === 'pool' ? { colour: ruby, strength: 1 } : undefined));
  }
  return c;
}

const pose = (dir: Dir, action: Pose['action'], t = 0.3): Pose => ({ x: 0, y: 0, dir, action, t, alpha: 1 });

/** Figures side by side on the nave floor; in game, each lit by a nearby candle and dithered. */
function strip(figures: Figure[], inGame: boolean): HTMLCanvasElement {
  const c = canvas(CELL_W * figures.length, CELL_H);
  const g = ctx2d(c);
  g.fillStyle = COL.floor;
  g.fillRect(0, 0, c.width, c.height);
  figures.forEach((f, i) => f.draw(g, i * CELL_W + CELL_W / 2, FEET_Y));
  if (inGame) {
    const lights: Light[] = figures.map((_, i) => ({ x: i * CELL_W + CELL_W / 2 - 16, y: 12, r: 46, power: 0.5 }));
    applyLighting(g, c.width, c.height, lights, AMBIENT);
    ditherFrame(g, c.width, c.height);
  }
  return c;
}

function figureSheet(title: string, subtitle: string, figures: Figure[], k: number) {
  const captions = figures.map((f, i) => ({ x: i * CELL_W + CELL_W / 2, text: f.caption }));
  const w = CELL_W * figures.length;
  return sheet(title, subtitle, [
    { label: `in game: lit by a nearby candle and dithered (${k}×)`, src: strip(figures, true), x: 0, y: 0, w, h: CELL_H, k, captions },
    { label: `raw sprite (${k}×)`, src: strip(figures, false), x: 0, y: 0, w, h: CELL_H, k, captions },
  ]);
}

const TIERS: Record<VestmentName, string> = {
  friar: 'friar: under 10,000 prayer tokens',
  priest: 'priest: 10,000 to 49,999 prayer tokens',
  bishop: 'bishop: 50,000 to 199,999 prayer tokens',
  cardinal: 'cardinal: 200,000 prayer tokens and over',
};

// ---------------------------------------------------------------------------

/** The stand close-up in its stone archway, at base resolution. */
function framedStand(candles: StandCandle[], now: number, hover?: number, seed = standSeed(0, 'left')): HTMLCanvasElement {
  const c = canvas(STAND_W + 2 * FRAME, STAND_H + 2 * FRAME);
  const g = ctx2d(c);
  g.drawImage(renderStand(candles, now, hover, seed), FRAME, FRAME);
  g.drawImage(renderFrame(), 0, 0);
  return c;
}

const MELT_HOURS = 72;
const MELT_K = 3;
/**
 * One frame of the melting hyperlapse: a candle of each size (and a second taper) lit at
 * hour 0, at `i` of `n` frames through the 72 hours the longest of them burns.
 */
function meltFrame(i: number, n: number): string {
  const HOUR = 3_600_000;
  const hours = (MELT_HOURS * i) / (n - 1);
  const life: [number, CandleName, number][] = [[2, 'taper', 24], [7, 'taper', 24], [13, 'votive', 36], [16, 'votive', 36], [24, 'pillar', 48], [35, 'paschal', 72]];
  const now = NOW + hours * HOUR;
  // Candles are removed when they expire, as in the cathedral.
  const candles: StandCandle[] = life.filter(([, , h]) => hours < h).map(([slot, size, h]) => ({ slot, size, litAt: NOW, expiresAt: NOW + h * HOUR }));
  const pic = framedStand(candles, now + i * 137);
  const c = canvas(pic.width * MELT_K, pic.height * MELT_K + 54);
  const g = ctx2d(c);
  g.fillStyle = BG;
  g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingEnabled = false;
  g.drawImage(pic, 0, 0, pic.width * MELT_K, pic.height * MELT_K);
  g.font = `600 26px ${FACE}`;
  g.textBaseline = 'middle';
  g.fillStyle = 'rgb(222, 180, 89)';
  const text = `hour ${Math.floor(hours)} of ${MELT_HOURS}`;
  g.fillText(text, (c.width - g.measureText(text).width) / 2, pic.height * MELT_K + 28);
  return c.toDataURL('image/png');
}

const out = new Map<string, HTMLCanvasElement>();
const api = {
  ready: false,
  error: '',
  names: [] as string[],
  jpeg: (name: string) => out.get(name)!.toDataURL('image/jpeg', 0.92),
  melt: meltFrame,
};
(window as unknown as { assets: typeof api }).assets = api;

function add(name: string, c: HTMLCanvasElement) {
  c.dataset.name = name;
  document.body.append(c);
  out.set(name, c);
}

async function main() {
  await loadFont();
  await document.fonts.ready;
  const sprites = await PriestSprites.load('/sprites');

  // The whole view, as on a 1440 × 900 screen.
  const vp = viewportFor(DISPLAY_W, DISPLAY_H);
  const cam = cameraFor(bayCentreX(C.AISLE_CENTRE_X), vp);
  const full = { x: 0, y: 0, w: vp.baseW, h: vp.baseH, k: vp.scale };
  add('cathedral', sheet('The cathedral', `In game, empty, as on a 1440 × 900 screen (${vp.scale}×). The view repeats without end in every direction.`, [{ label: 'candlelit and dithered', src: nave(vp, cam, [], false), ...full }]));
  add('cathedral-raw', sheet('The cathedral, raw', `The same view before lighting and the dither (${vp.scale}×).`, [{ label: 'flat greys', src: nave(vp, cam, [], true), ...full }]));

  // The window light, as it falls around your bay.
  add(
    'window-light',
    sheet('Window light', `Dim, diffuse pools 3–4 rows deep: two down your column of pews with 5 rows between, one in each column beside it. ${Math.round(GLOW_FLOOR_ALPHA * 100)}% opacity on the floor, ${Math.round(GLOW_BEAM_ALPHA * 100)}% in the rays.`, [
      { label: `in game (${vp.scale}×)`, src: nave(vp, cam, [], false), ...full },
      { label: `the light alone, at 5× its real opacity (${vp.scale}×)`, src: lightOnly(vp, cam, 5), ...full },
    ]),
  );

  // The stained glass: each window as designed, then as its light lies on the floor of your
  // bay (in the upper pool, the only one lit here), in game and on its own.
  const { x0: vx0, x1: vx1 } = visibleTiles(cam, vp);
  const pool = glowsAround(cam.bay, vx0, vx1, unproject(cam, vp.baseW / 2, vp.baseH)[1]).find((g) => g.bay === cam.bay)!;
  const only = (design: WindowDesign): Windows => () => [{ ...pool, design }];
  const [px0, py0] = project(cam, pool.x0 - 2.5, pool.y0 - 1.5);
  const [px1, py1] = project(cam, pool.x1 + 0.5, pool.y1 + 1.5);
  const poolCrop: Rect = { x: px0, y: py0, w: px1 - px0, h: py1 - py0 };
  const rows: WindowDesign[][] = [];
  for (let i = 0; i < DESIGNS.length; i += LANCETS_PER_ROW) rows.push(DESIGNS.slice(i, i + LANCETS_PER_ROW));
  add(
    'stained-glass',
    sheet('The stained glass', `Each pool of window light is the image of a pointed lancet, one of ${DESIGNS.length} designs chosen by a hash of its bay and wall. On the floor it lies on its side, sill toward its window, blurred and at ${Math.round(GLOW_FLOOR_ALPHA * 100)}% opacity (see stained-glass-floor.jpg).`, rows.map((row, r) => {
      const strip = lancets(row);
      return {
        label: r === 0 ? 'as designed: leads, a border of small panes, iron saddle bars (3×)' : '',
        src: strip,
        x: 0,
        y: 0,
        w: strip.width,
        h: strip.height,
        k: 3,
        captions: row.map((d, i) => ({ x: i * (LANCET_W + LANCET_GAP) + LANCET_W / 2, text: d.name })),
      };
    })),
  );
  add(
    'stained-glass-floor',
    sheet('The stained glass on the floor', 'Each window as its light lies on the floor of your bay: in game, candlelit and dithered, and its light alone at 5× its real strength.', [
      ...DESIGNS.map((d) => {
        const both = beside([pair(nave(vp, cam, [], false, undefined, only(d)), [poolCrop]), pair(lightOnly(vp, cam, 5, only(d)), [poolCrop])]);
        return { label: `${d.name}, ${SUBJECTS[d.name]}: in game, and its light alone at 5× (2×)`, src: both, x: 0, y: 0, w: both.width, h: both.height, k: 2 };
      }),
    ]),
  );

  add('altar', naveSheet('The altar', 'One at the top of every bay: altar, cross, two candlesticks, before a dark reredos.', { x0: C.ALTAR_X[0]! - 4, x1: C.ALTAR_X[1]! + 5, y0: -2.8, y1: C.ALTAR_Y[1]! + 2.5 }, 4));
  add('pews', naveSheet('The pews', 'Long plain benches across the nave between the side aisles, with a candle on each end.', { x0: C.PEW_X[0]! - 2, x1: C.PEW_X[1]! + 3, y0: C.ROW_Y[2]! - 1.5, y1: C.ROW_Y[4]! + 0.6 }, 3));

  // Both stands beside your pews, with candles of every size, lit. Each faces your column.
  const sizes: [number, CandleName][] = [
    [1, 'taper'], [3, 'taper'], [6, 'taper'], [8, 'taper'],
    [12, 'votive'], [15, 'votive'], [18, 'votive'],
    [21, 'pillar'], [25, 'pillar'], [28, 'pillar'],
    [34, 'paschal'], [37, 'paschal'],
  ];
  const candles: CandleView[] = [0, 1].flatMap((arcade) => sizes.map(([slot, size]) => ({ arcade, slot, size, litAt: 0, expiresAt: NOW + 3_600_000 })));
  const standCrop = (arcade: number): Rect => {
    const bx = arcade * C.BAY_W;
    const [ax, ay] = project(cam, bx + C.ARCADE_X[0]! - 1.5, C.STAND_Y[0]! - 1.5);
    const [bxp, byp] = project(cam, bx + C.ARCADE_X[1]! + 1.5, C.STAND_Y[1]! + 1.5);
    return { x: ax, y: ay - 40, w: bxp - ax, h: byp - ay + 40 };
  };
  const stands = (raw: boolean) => pair(nave(vp, cam, candles, raw), [standCrop(0), standCrop(1)]);
  const standsIn = stands(false);
  const standsRaw = stands(true);
  // The stand close up: candles of every size at every stage of burning, and one not yet lit.
  const HOUR = 3_600_000;
  const burn: Record<CandleName, number> = { taper: 24, votive: 36, pillar: 48, paschal: 72 };
  const closeUp: StandCandle[] = (
    [
      [0, 'taper', 0.02], [1, 'taper', 0.3], [3, 'taper', 0.6], [4, 'taper', 0.9], [7, 'taper', 0.45], [9, 'taper', -1],
      [10, 'votive', 0.05], [12, 'votive', 0.5], [13, 'votive', 0.85], [16, 'votive', 0.25], [18, 'votive', 0.7],
      [21, 'pillar', 0.1], [23, 'pillar', 0.55], [26, 'pillar', 0.95], [28, 'pillar', 0.35],
      [31, 'paschal', 0.03], [34, 'paschal', 0.5], [37, 'paschal', 0.8],
    ] as [number, CandleName, number][]
  ).map(([slot, size, spent]) => {
    const life = burn[size] * HOUR;
    return spent < 0 ? { slot, size, litAt: NOW + 2000, expiresAt: NOW + 2000 + life } : { slot, size, litAt: NOW - spent * life, expiresAt: NOW + (1 - spent) * life };
  });
  const closeUpShot = framedStand(closeUp, NOW, 23);
  // Three empty stands, each with the old wax generated from where it stands.
  const waxW = STAND_W + 2 * FRAME;
  const waxShot = canvas(waxW * 3 + 16, STAND_H + 2 * FRAME);
  ([[0, 'left'], [0, 'right'], [-7, 'left']] as [number, 'left' | 'right'][]).forEach(([bay, side], i) => {
    ctx2d(waxShot).drawImage(framedStand([], NOW, undefined, standSeed(bay, side)), i * (waxW + 8), 0);
  });
  add(
    'votive-old-wax',
    sheet('Old wax on the votive stands', "Each stand's old wax is generated from a hash of where it is (its bay of pews and which side of them), so no two are alike and everyone sees the same.", [
      { label: 'bay 0 left · bay 0 right · bay −7 left, with no candles burning (2×)', src: waxShot, x: 0, y: 0, w: waxShot.width, h: waxShot.height, k: 2 },
    ]),
  );
  add(
    'votive-close-up',
    sheet('The votive stand, close up', 'Click a stand in the nave for this view. Each candle is as tall as the time it has left; wax pools at its foot as it burns. Hover a candle for whose it is.', [
      { label: 'tapers, votives, pillars and paschal candles from just lit to nearly spent; the last taper is not yet lit; the hovered pillar has a dithered crimson rim (4×)', src: closeUpShot, x: 0, y: 0, w: closeUpShot.width, h: closeUpShot.height, k: 4 },
    ]),
  );

  add(
    'votive-stand',
    sheet('The votive stands', 'Four iron tiers in each arcade, with tapers, votives, pillars and paschal candles, stepping up away from your column of pews: left of it (facing right) and right of it (facing left).', [
      { label: 'in game: candlelit and dithered (4×)', src: standsIn, x: 0, y: 0, w: standsIn.width, h: standsIn.height, k: 4 },
      { label: 'raw: flat greys before lighting and the dither (4×)', src: standsRaw, x: 0, y: 0, w: standsRaw.width, h: standsRaw.height, k: 4 },
    ]),
  );

  // Every vestment in every pose it is drawn in.
  const poses: { caption: string; pose: Pose }[] = [
    { caption: 'up the aisle', pose: pose('up', 'walk') },
    { caption: 'kneeling', pose: pose('up', 'kneel') },
    { caption: 'along the pew', pose: pose('right', 'walk') },
    { caption: 'along the pew', pose: pose('left', 'walk', 0.5) },
    { caption: 'walking out', pose: pose('down', 'walk') },
    { caption: 'lighting', pose: pose('left', 'light', 1.2) },
  ];
  for (const v of VESTMENTS) {
    const figures = poses.map((p) => ({ caption: p.caption, draw: (ctx: CanvasRenderingContext2D, fx: number, fy: number) => sprites.draw(ctx, v, p.pose, fx, fy) }));
    add(`priest-${v}`, figureSheet(`The ${v}`, TIERS[v], figures, 6));
  }

  // The thurifer, at three points of the thurible's swing.
  const swings = [-1, 0, 1].map((s) => ({
    caption: `swing ${s > 0 ? '+1' : s}`,
    draw: (ctx: CanvasRenderingContext2D, fx: number, fy: number) => void sprites.drawThurifer(ctx, pose('right', 'walk', 0.3 + (s + 1) * 0.2), fx - 4, fy, { swing: s }),
  }));
  add('thurifer', figureSheet('The thurifer', 'Processes across the front of the nave every two minutes, swinging a smoking thurible.', swings, 8));

  // Everyone together, from behind and from the front.
  const lineup: Figure[] = [];
  for (const v of VESTMENTS) {
    lineup.push({ caption: `${v}, back`, draw: (ctx, fx, fy) => sprites.draw(ctx, v, pose('up', 'kneel'), fx, fy) });
    lineup.push({ caption: 'front', draw: (ctx, fx, fy) => sprites.draw(ctx, v, pose('down', 'walk'), fx, fy) });
  }
  lineup.push({ caption: 'thurifer', draw: (ctx, fx, fy) => void sprites.drawThurifer(ctx, pose('right', 'walk'), fx - 4, fy, { swing: 0.6 }) });
  add('priests', figureSheet('The clergy', 'Friar, priest, bishop and cardinal by spend tier, and the thurifer.', lineup, 4));

  // The windows lighting the side of each figure that faces them (the left, in your bay).
  const kneelers: People['figures'] = [];
  for (let row = 0; row <= 6; row++) {
    const seats: [number, number][] = row % 2 ? [[1, 0], [1, 3], [1, 6], [0, 2]] : [[1, 1], [1, 5], [0, 0], [0, 5]];
    seats.forEach(([half, seat], i) => {
      const [x, y] = seatPos(0, row, half, seat);
      kneelers.push({ name: VESTMENTS[(row + i) % VESTMENTS.length]!, pose: { x, y, dir: 'up', action: 'kneel', t: 0, alpha: 1 } });
    });
  }
  kneelers.push({ name: 'friar', pose: { x: C.SIDE_AISLE_X[1]!, y: 12, dir: 'up', action: 'walk', t: 0.4, alpha: 1 } });
  kneelers.push({ name: 'priest', pose: { x: 11.5, y: 13, dir: 'right', action: 'walk', t: 0.2, alpha: 1 } });
  const [rx0, ry0] = project(cam, C.ARCADE_X[1]! - 0.5, C.ROW_Y[0]! - 1.5);
  const [rx1, ry1] = project(cam, C.BAY_W + 0.5, C.ROW_Y[6]! + 0.8);
  const pews = { x: rx0, y: ry0 - 30, w: rx1 - rx0, h: ry1 - ry0 + 30, k: 3 };
  const closeUps = [
    ...VESTMENTS.map((v) => ({ caption: v, name: v, pose: pose('up', 'kneel') })),
    { caption: 'priest, along a pew', name: 'priest' as const, pose: pose('left', 'walk') },
    { caption: 'thurifer', name: 'thurifer' as const, pose: pose('right', 'walk') },
  ];
  const cw = CELL_W * closeUps.length;
  const caps = closeUps.map((f, i) => ({ x: i * CELL_W + CELL_W / 2, text: f.caption }));
  add(
    'window-rim',
    sheet('Window light on the priests', 'The side of each figure facing the windows (the left, in your bay) catches their light: a faint pale edge everywhere, and the glass colour in a pool of light.', [
      { label: 'in game, with the window light on their sides (3×)', src: nave(vp, cam, [], false, { sprites, figures: kneelers, rim: true }), ...pews },
      { label: 'the same without it, for comparison (3×)', src: nave(vp, cam, [], false, { sprites, figures: kneelers, rim: false }), ...pews },
      { label: 'close up, without window light (6×)', src: rimStrip(sprites, closeUps, 'none'), x: 0, y: 0, w: cw, h: CELL_H, k: 6, captions: caps },
      { label: 'close up, the faint edge from the windows they have everywhere (6×)', src: rimStrip(sprites, closeUps, 'faint'), x: 0, y: 0, w: cw, h: CELL_H, k: 6, captions: caps },
      { label: 'close up, standing in a pool of ruby glass light (6×)', src: rimStrip(sprites, closeUps, 'pool'), x: 0, y: 0, w: cw, h: CELL_H, k: 6, captions: caps },
    ]),
  );

  api.names = [...out.keys()];
  api.ready = true;
}

main().catch((e) => {
  api.error = String((e as Error).stack ?? e);
});
