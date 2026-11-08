// Asset sheets for review, drawn by the viewer's own code: the cathedral, the altar, the
// pews, a votive stand and every priest. Each shows the asset as it looks in game
// (candlelit and dithered) above the same thing raw (flat greys, before lighting and the
// dither). render-assets.ts saves each sheet as a JPEG.

import { C, type CandleName, type VestmentName } from '../../shared/constants';
import { bayCentreX, cameraFor, project, sortDrawables, viewportFor, visibleTiles, TH, type Camera, type Drawable, type Viewport } from '../../web/src/view';
import { AMBIENT, COL, GLOW_BEAM_ALPHA, GLOW_FLOOR_ALPHA, applyLighting, candleDrawable, candleFlame, drawFixedFlames, drawFlame, drawRays, drawStatic, fixedLights, furniture, glowsBetween, type CandleView, type Light } from '../../web/src/scene';
import { ditherFrame } from '../../web/src/dither';
import { PriestSprites, VESTMENTS } from '../../web/src/sprites';
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

function nave(vp: Viewport, cam: Camera, candles: CandleView[], raw: boolean): HTMLCanvasElement {
  const { baseW: w, baseH: h } = vp;
  const base = canvas(w, h);
  const ctx = ctx2d(base);
  const { x0, x1, yMax } = visibleTiles(cam, vp);
  drawStatic(ctx, cam, x0, x1, yMax, w, h);
  const drawables: Drawable[] = furniture(cam, x0, x1, yMax);
  for (const c of candles) drawables.push(candleDrawable(cam, c, NOW, false));
  for (const d of sortDrawables(drawables)) d.draw(ctx);
  if (!raw) {
    const lights: Light[] = fixedLights(cam, x0, x1, yMax);
    for (const c of candles) {
      const [fx, fy] = candleFlame(cam, c);
      lights.push({ x: fx, y: fy, r: 30, power: 0.5 });
    }
    applyLighting(ctx, w, h, lights, AMBIENT);
    const rays = canvas(w, h);
    const rctx = ctx2d(rays);
    drawRays(rctx, cam, x0, x1, w, h, NOW, yMax);
    ditherFrame(ctx, w, h, rctx.getImageData(0, 0, w, h).data);
  }
  drawFixedFlames(ctx, cam, x0, x1, yMax, NOW);
  candles.forEach((c, i) => {
    const [fx, fy] = candleFlame(cam, c);
    drawFlame(ctx, fx, fy, NOW, i);
  });
  return base;
}

/** The window light alone, on black, at `gain` times its real strength. */
function lightOnly(vp: Viewport, cam: Camera, gain: number): HTMLCanvasElement {
  const { baseW: w, baseH: h } = vp;
  const { x0, x1, yMax } = visibleTiles(cam, vp);
  const rays = canvas(w, h);
  const rctx = ctx2d(rays);
  drawRays(rctx, cam, x0, x1, w, h, NOW, yMax);
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
// Priests
// ---------------------------------------------------------------------------

const CELL_W = 40;
const CELL_H = 44;
const FEET_Y = 40;

type Figure = { caption: string; draw: (ctx: CanvasRenderingContext2D, fx: number, fy: number) => void };

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

const out = new Map<string, HTMLCanvasElement>();
const api = {
  ready: false,
  error: '',
  names: [] as string[],
  jpeg: (name: string) => out.get(name)!.toDataURL('image/jpeg', 0.92),
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

  // A pool of window light, with the camera moved down the nave to it.
  const glow = glowsBetween(0, C.BAY_W - 1, 400).find((g) => g.bay === 0 && g.y0 > C.ROW_Y[0]!)!;
  const glowCam: Camera = { ...cam, oy: Math.round(vp.baseH / 2 + 40 - ((glow.y0 + glow.y1) / 2) * TH) };
  const [gx0] = project(glowCam, -2, 0);
  const [gx1] = project(glowCam, C.BAY_W + 2, 0);
  const crop = { x: gx0, y: 0, w: gx1 - gx0, h: vp.baseH, k: 2 };
  add(
    'window-light',
    sheet('Window light', `Dim, diffuse pools 3–4 rows deep with 5 rows between, from a third of the way along the pews to the far wall: ${Math.round(GLOW_FLOOR_ALPHA * 100)}% on the floor, ${Math.round(GLOW_BEAM_ALPHA * 100)}% in the rays from the window.`, [
      { label: 'in game: candlelit and dithered (2×)', src: nave(vp, glowCam, [], false), ...crop },
      { label: 'the light alone, at 5× its real strength (2×)', src: lightOnly(vp, glowCam, 5), ...crop },
    ]),
  );

  add('altar', naveSheet('The altar', 'One at the top of every bay: altar, cross, two candlesticks, before a dark reredos.', { x0: C.ALTAR_X[0]! - 4, x1: C.ALTAR_X[1]! + 5, y0: -2.8, y1: C.ALTAR_Y[1]! + 2.5 }, 4));
  add('pews', naveSheet('The pews', 'Long plain benches across the nave between the side aisles, with a candle on each end.', { x0: C.PEW_X[0]! - 2, x1: C.PEW_X[1]! + 3, y0: C.ROW_Y[2]! - 1.5, y1: C.ROW_Y[4]! + 0.6 }, 3));

  // A stand with candles of every size, lit.
  const sizes: [number, CandleName][] = [
    [1, 'taper'], [3, 'taper'], [6, 'taper'], [8, 'taper'],
    [12, 'votive'], [15, 'votive'], [18, 'votive'],
    [21, 'pillar'], [25, 'pillar'], [28, 'pillar'],
    [34, 'paschal'], [37, 'paschal'],
  ];
  const candles: CandleView[] = sizes.map(([slot, size]) => ({ arcade: 0, slot, size, litAt: 0, expiresAt: NOW + 3_600_000 }));
  add('votive-stand', naveSheet('The votive stand', 'Four iron tiers in the arcade, between two columns, with tapers, votives, pillars and paschal candles.', { x0: C.ARCADE_X[0]! - 1.5, x1: C.ARCADE_X[1]! + 1.5, y0: C.STAND_Y[0]! - 1.5, y1: C.STAND_Y[1]! + 1.5, above: 40 }, 5, candles));

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

  api.names = [...out.keys()];
  api.ready = true;
}

main().catch((e) => {
  api.error = String((e as Error).stack ?? e);
});
