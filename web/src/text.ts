// All dynamic text is drawn with canvas fillText. No string from the database ever goes
// into the DOM.
//
// Words float over the scene with no bubble or box, in Grenze Gotisch: a blackletter that
// stays readable at small sizes. Prayers are white for everyone except your own priest, who
// speaks in gold with the shimmer from TuringOS: a pale band sweeping through the gold every
// 3.4 s, over a soft two-layer gold glow. Friends you pick out in the key are named in
// crimson.

export const FACE = '"Grenze Gotisch", Georgia, "Times New Roman", serif';
const FONT_URL = '/fonts/GrenzeGotisch.ttf';

export const GOLD = 'rgb(222, 180, 89)';
/** The sweep: rgb(255 244 208 / 82%) over the gold. */
const SHEEN = 'rgb(251, 236, 187)';
const SHIMMER_MS = 3400;
export const WHITE = '#f2f0ea';
export const CRIMSON = 'rgb(214, 44, 58)';
export const DIM = '#8f8a80';

/** Size of prayer text on the display canvas for a given pixel-art scale. */
export function textSize(scale: number): number {
  return Math.max(16, Math.round(scale * 9));
}

export function font(px: number, weight = 500): string {
  return `${weight} ${px}px ${FACE}`;
}

/**
 * Load the face before the first words are drawn (canvas text does not wait for it). The
 * viewer declares it in CSS too, for the notices; elsewhere it is added here.
 */
export async function loadFont(): Promise<void> {
  try {
    const declared = [...document.fonts].some((f) => f.family.replace(/["']/g, '') === 'Grenze Gotisch');
    if (!declared) document.fonts.add(new FontFace('Grenze Gotisch', `url(${FONT_URL})`, { weight: '100 900' }));
    await document.fonts.load('500 16px "Grenze Gotisch"');
  } catch {
    // Fall back to Georgia.
  }
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function overlaps(a: Rect, b: Rect, pad = 2): boolean {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

export function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width <= maxWidth || !line) line = next;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Text in one colour with a hard dark drop shadow, so it reads over any part of the scene. */
export function plainText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, px: number, colour: string, alpha: number) {
  const o = Math.max(1, Math.round(px / 12));
  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.fillText(text, x + o, y + o);
  ctx.fillStyle = colour;
  ctx.fillText(text, x, y);
  ctx.globalAlpha = 1;
}

/**
 * Gold text with the TuringOS shimmer. `left` and `width` describe the whole block the text
 * belongs to, so the band sweeps across the full line even while it is still being typed.
 */
export function goldText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, px: number, now: number, left: number, width: number, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  // Halo: 0 0 5px gold at 55%, then 0 0 13px gold at 30%.
  const dpr = px / 14;
  ctx.fillStyle = GOLD;
  ctx.shadowColor = 'rgba(222, 180, 89, 0.55)';
  ctx.shadowBlur = 5 * dpr;
  ctx.fillText(text, x, y);
  ctx.shadowColor = 'rgba(222, 180, 89, 0.30)';
  ctx.shadowBlur = 13 * dpr;
  ctx.fillText(text, x, y);
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';
  // The sheen: a band twice the block's width, sweeping right to left (100deg), 34%–66% wide.
  const period = Math.max(width, 120) * 2;
  const phase = (now % SHIMMER_MS) / SHIMMER_MS;
  const start = left + width + period * 0.5 - phase * (width + period * 1.5);
  const tilt = Math.tan((10 * Math.PI) / 180) * px;
  const grad = ctx.createLinearGradient(start, y + tilt, start + period, y - tilt);
  grad.addColorStop(0, GOLD);
  grad.addColorStop(0.34, GOLD);
  grad.addColorStop(0.5, SHEEN);
  grad.addColorStop(0.66, GOLD);
  grad.addColorStop(1, GOLD);
  ctx.fillStyle = grad;
  ctx.fillText(text, x, y);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Prayers: one line per sentence
// ---------------------------------------------------------------------------

export function prayerFont(px: number, own: boolean): string {
  return font(px, own ? 600 : 500);
}

/**
 * Size and place a one-line sentence centred on `cx`, its bottom at `bottom`, kept on
 * screen. Laid out from the full sentence so the text stays put while it is typed; a line
 * too long for the screen is set smaller rather than wrapped.
 */
export function placeLine(ctx: CanvasRenderingContext2D, full: string, cx: number, bottom: number, px: number, own: boolean): Rect & { px: number } {
  ctx.save();
  ctx.font = prayerFont(px, own);
  let w = ctx.measureText(full).width;
  const room = ctx.canvas.width - px * 2;
  if (w > room) {
    px = Math.max(10, Math.floor((px * room) / w));
    ctx.font = prayerFont(px, own);
    w = ctx.measureText(full).width;
  }
  ctx.restore();
  const x = Math.round(Math.max(px, Math.min(ctx.canvas.width - px - w, cx - w / 2)));
  const h = Math.round(px * 1.25);
  return { x, y: Math.round(bottom - h), w, h, px };
}

/**
 * Draw (the typed part of) a line placed by `placeLine`: shimmering gold for your own
 * priest, crimson for a friend you picked out in the key, white for everyone else.
 */
export function drawLine(ctx: CanvasRenderingContext2D, r: Rect & { px: number }, shown: string, style: TagStyle, now: number, alpha: number, dx = 0, dy = 0) {
  if (!shown || alpha <= 0) return;
  ctx.save();
  ctx.font = prayerFont(r.px, style === 'own');
  ctx.textBaseline = 'top';
  const x = r.x + dx;
  const y = r.y + dy + Math.round(r.px * 0.05);
  if (style === 'own') goldText(ctx, shown, x, y, r.px, now, x, r.w, alpha);
  else plainText(ctx, shown, x, y, r.px, style === 'marked' ? CRIMSON : WHITE, alpha);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Names, hover details, the closing card
// ---------------------------------------------------------------------------

export type TagStyle = 'own' | 'plain' | 'marked';

export function measureTag(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, px: number): Rect {
  ctx.save();
  ctx.font = font(px, 600);
  const w = ctx.measureText(text).width;
  ctx.restore();
  return { x: x - w / 2, y: y - px, w, h: px };
}

/** A name above a priest: shimmering gold for your own, crimson for one you picked out. */
export function nameTag(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, px: number, style: TagStyle, now: number) {
  ctx.save();
  ctx.font = font(px, 600);
  ctx.textBaseline = 'bottom';
  const w = ctx.measureText(text).width;
  const left = Math.round(x - w / 2);
  if (style === 'own') goldText(ctx, text, left, Math.round(y), px, now, left, w);
  else plainText(ctx, text, left, Math.round(y), px, style === 'marked' ? CRIMSON : WHITE, style === 'marked' ? 1 : 0.92);
  ctx.restore();
}

/** A small dim note beside the cursor (what clicking will do). */
export function cursorNote(ctx: CanvasRenderingContext2D, x: number, y: number, lines: string[], px: number) {
  if (!lines.length) return;
  ctx.save();
  ctx.font = font(px, 500);
  ctx.textBaseline = 'top';
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const left = Math.max(px, Math.min(ctx.canvas.width - w - px, x + px * 1.1));
  const top = Math.max(px, Math.min(ctx.canvas.height - px * 1.3 * lines.length - px, y + px * 0.6));
  lines.forEach((l, i) => plainText(ctx, l, left, top + i * px * 1.25, px, DIM, 1));
  ctx.restore();
}

/** Hover details, written straight onto the scene beside the cursor. */
export function hoverText(ctx: CanvasRenderingContext2D, x: number, y: number, title: string, body: string, footer: string, px: number) {
  ctx.save();
  ctx.font = font(px, 500);
  const lines = body ? wrap(ctx, body, px * 26) : [];
  const lh = px * 1.25;
  const h = lh * (lines.length + 1 + (footer ? 1 : 0)) + px;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width), ctx.measureText(title).width, footer ? ctx.measureText(footer).width : 0);
  const left = Math.max(px, Math.min(ctx.canvas.width - w - px, x + px * 1.5));
  const top = Math.max(px, Math.min(ctx.canvas.height - h - px, y - h / 2));
  ctx.textBaseline = 'top';
  ctx.font = font(px, 700);
  plainText(ctx, title, left, top, px, WHITE, 1);
  ctx.font = font(px, 500);
  lines.forEach((l, i) => plainText(ctx, l, left, top + lh * (i + 1), px, WHITE, 0.95));
  if (footer) plainText(ctx, footer, left, top + lh * (lines.length + 1), px, DIM, 1);
  ctx.restore();
}

/**
 * A title in shimmering gold over the middle of the screen, with a line beneath it in
 * gold: "Indulgence" as you arrive, "Ite, missa est" as you leave. Written over the scene,
 * with only a soft shadow behind the words so they read.
 */
export function titleOver(ctx: CanvasRenderingContext2D, alpha: number, title: string, subtitle: string, now: number) {
  if (alpha <= 0) return;
  const { width: w, height: h } = ctx.canvas;
  const px = Math.max(32, Math.round(Math.min(w, h) / 8.5));
  const spx = Math.max(16, Math.round(px * 0.36));
  const cy = Math.round(h * 0.42);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(w / 2, cy + px * 0.2);
  ctx.scale(1, 0.42);
  const r = Math.max(px * 6, w * 0.32);
  const shade = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  shade.addColorStop(0, 'rgba(0, 0, 0, 0.6)');
  shade.addColorStop(0.55, 'rgba(0, 0, 0, 0.35)');
  shade.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = shade;
  ctx.fillRect(-r, -r, r * 2, r * 2);
  ctx.restore();

  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.font = font(px, 600);
  const tw = ctx.measureText(title).width;
  goldText(ctx, title, Math.round(w / 2 - tw / 2), cy, px, now, w / 2 - tw / 2, tw, alpha);
  ctx.font = font(spx, 500);
  const sw = ctx.measureText(subtitle).width;
  goldText(ctx, subtitle, Math.round(w / 2 - sw / 2), Math.round(cy + px * 0.82), spx, now, w / 2 - sw / 2, sw, alpha * 0.95);
  ctx.restore();
}
