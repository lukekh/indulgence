// All dynamic text is drawn with canvas fillText. No string from the database ever goes
// into the DOM.
//
// Prayers float over the scene with no bubble or box: white for everyone, except your own
// priest, who speaks in gold with the shimmer from TuringOS: a pale band sweeping through
// the gold every 3.4 s, over a soft two-layer gold glow.

export const MONO = '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';

export const GOLD = 'rgb(222, 180, 89)';
/** The sweep: rgb(255 244 208 / 82%) over the gold. */
const SHEEN = 'rgb(251, 236, 187)';
const SHIMMER_MS = 3400;

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

/** Plain white text with a hard dark drop shadow, so it reads over any part of the scene. */
function whiteText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, px: number, alpha: number) {
  const o = Math.max(1, Math.round(px / 12));
  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.fillText(text, x + o, y + o);
  ctx.fillStyle = '#f2f0ea';
  ctx.fillText(text, x, y);
  ctx.globalAlpha = 1;
}

/**
 * Gold text with the TuringOS shimmer. `left` and `width` describe the whole block the line
 * belongs to, so every line of one prayer shows its slice of the same sweeping band.
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

export interface PrayerLayout {
  rect: Rect;
  lines: string[];
  px: number;
  own: boolean;
}

/** Lay out a prayer above (cx, bottom): its last `maxLines` lines, centred. */
export function layoutPrayer(ctx: CanvasRenderingContext2D, cx: number, bottom: number, text: string, px: number, maxLines: number, own: boolean): PrayerLayout | undefined {
  ctx.save();
  ctx.font = `${own ? 600 : 400} ${px}px ${MONO}`;
  const lines = wrap(ctx, text, px * 26).slice(-maxLines);
  const w = lines.length ? Math.max(...lines.map((l) => ctx.measureText(l).width)) : 0;
  ctx.restore();
  if (!lines.length) return undefined;
  const h = lines.length * px * 1.3;
  return { rect: { x: Math.round(cx - w / 2), y: Math.round(bottom - h), w, h }, lines, px, own };
}

export function drawPrayer(ctx: CanvasRenderingContext2D, p: PrayerLayout, now: number, alpha = 1) {
  ctx.save();
  ctx.font = `${p.own ? 600 : 400} ${p.px}px ${MONO}`;
  ctx.textBaseline = 'top';
  p.lines.forEach((line, i) => {
    const lw = ctx.measureText(line).width;
    const x = Math.round(p.rect.x + (p.rect.w - lw) / 2);
    const y = Math.round(p.rect.y + i * p.px * 1.3);
    if (p.own) goldText(ctx, line, x, y, p.px, now, p.rect.x, p.rect.w, alpha);
    else whiteText(ctx, line, x, y, p.px, alpha);
  });
  ctx.restore();
}

export function measureTag(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, px: number): Rect {
  ctx.save();
  ctx.font = `600 ${px}px ${MONO}`;
  const w = ctx.measureText(text).width;
  ctx.restore();
  return { x: x - w / 2, y: y - px, w, h: px };
}

/** A name above a priest: white, or shimmering gold for your own. */
export function nameTag(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, px: number, own: boolean, now: number) {
  ctx.save();
  ctx.font = `600 ${px}px ${MONO}`;
  ctx.textBaseline = 'bottom';
  const w = ctx.measureText(text).width;
  const left = Math.round(x - w / 2);
  if (own) goldText(ctx, text, left, Math.round(y), px, now, left, w);
  else whiteText(ctx, text, left, Math.round(y), px, 0.9);
  ctx.restore();
}

/** Hover details, written straight onto the scene beside the cursor. */
export function hoverText(ctx: CanvasRenderingContext2D, x: number, y: number, title: string, body: string, footer: string, px: number, own: boolean, now: number) {
  ctx.save();
  ctx.font = `${px}px ${MONO}`;
  const lines = body ? wrap(ctx, body, px * 30) : [];
  const lh = px * 1.3;
  const h = lh * (lines.length + 1 + (footer ? 1 : 0)) + px;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width), ctx.measureText(title).width, footer ? ctx.measureText(footer).width : 0);
  const left = Math.max(px, Math.min(ctx.canvas.width - w - px, x + px * 1.5));
  const top = Math.max(px, Math.min(ctx.canvas.height - h - px, y - h / 2));
  ctx.textBaseline = 'top';
  ctx.font = `700 ${px}px ${MONO}`;
  if (own) goldText(ctx, title, left, top, px, now, left, w);
  else whiteText(ctx, title, left, top, px, 1);
  ctx.font = `${px}px ${MONO}`;
  lines.forEach((l, i) => {
    if (own) goldText(ctx, l, left, top + lh * (i + 1), px, now, left, w);
    else whiteText(ctx, l, left, top + lh * (i + 1), px, 0.95);
  });
  if (footer) {
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillText(footer, left + 1, top + lh * (lines.length + 1) + 1);
    ctx.fillStyle = '#8f8a80';
    ctx.fillText(footer, left, top + lh * (lines.length + 1));
  }
  ctx.restore();
}

export function closingCard(ctx: CanvasRenderingContext2D, alpha: number, title: string, subtitle: string, now: number) {
  const { width: w, height: h } = ctx.canvas;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#0a0909';
  ctx.fillRect(0, 0, w, h);
  const px = Math.max(22, Math.round(Math.min(w, h) / 13));
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${px}px ${MONO}`;
  const tw = ctx.measureText(title).width;
  goldText(ctx, title, Math.round(w / 2 - tw / 2), Math.round(h / 2 - px * 0.4), px, now, w / 2 - tw / 2, tw, alpha);
  ctx.font = `${Math.round(px * 0.34)}px ${MONO}`;
  const sw = ctx.measureText(subtitle).width;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#8f8a80';
  ctx.fillText(subtitle, Math.round(w / 2 - sw / 2), Math.round(h / 2 + px * 0.7));
  ctx.restore();
}
