// All dynamic text is drawn with canvas fillText. No string from the database ever goes
// into the DOM.

export const SERIF = "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif";

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

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
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

export interface BubbleLayout {
  rect: Rect;
  lines: string[];
  px: number;
  tail: [number, number];
  own: boolean;
}

/** Measure a speech bubble whose tail points at (x, y), showing the last `maxLines` lines. */
export function layoutBubble(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, px: number, maxLines = 3, own = false): BubbleLayout | undefined {
  ctx.save();
  ctx.font = `italic ${px}px ${SERIF}`;
  const maxW = px * 16;
  const lines = wrap(ctx, text, maxW).slice(-maxLines);
  const w = lines.length ? Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width))) + px : 0;
  ctx.restore();
  if (!lines.length) return undefined;
  const h = lines.length * px * 1.25 + px * 0.6;
  return { rect: { x: Math.round(x - w / 2), y: Math.round(y - h - px * 0.8), w, h }, lines, px, tail: [x, y], own };
}

export function drawBubble(ctx: CanvasRenderingContext2D, b: BubbleLayout) {
  const { rect: r, px, lines } = b;
  ctx.save();
  ctx.font = `italic ${px}px ${SERIF}`;
  ctx.fillStyle = b.own ? 'rgba(255, 246, 222, 0.96)' : 'rgba(246, 238, 220, 0.9)';
  ctx.strokeStyle = 'rgba(60, 40, 20, 0.6)';
  ctx.lineWidth = Math.max(1, px / 12);
  ctx.beginPath();
  const tx = Math.max(r.x + px * 0.5, Math.min(r.x + r.w - px * 0.5, b.tail[0]));
  ctx.moveTo(tx - px * 0.35, r.y + r.h - 1);
  ctx.lineTo(b.tail[0], b.tail[1] - px * 0.2);
  ctx.lineTo(tx + px * 0.35, r.y + r.h - 1);
  ctx.fill();
  roundRect(ctx, r.x, r.y, r.w, r.h, px * 0.4);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#2b1d12';
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, r.x + px / 2, r.y + px * 0.3 + i * px * 1.25));
  ctx.restore();
}

export function measureTag(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, px: number): Rect {
  ctx.save();
  ctx.font = `600 ${px}px ${SERIF}`;
  const w = ctx.measureText(text).width;
  ctx.restore();
  return { x: x - w / 2, y: y - px, w, h: px };
}

export function nameTag(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, px: number, color = '#f3dfa8') {
  ctx.save();
  ctx.font = `600 ${px}px ${SERIF}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.lineWidth = Math.max(2, px / 4);
  ctx.strokeStyle = 'rgba(20, 12, 8, 0.85)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/** Hover card near (x, y), kept on screen. */
export function card(ctx: CanvasRenderingContext2D, x: number, y: number, title: string, body: string, footer: string, px: number) {
  ctx.save();
  const maxW = px * 24;
  ctx.font = `${px}px ${SERIF}`;
  const lines = body ? wrap(ctx, body, maxW) : [];
  ctx.font = `600 ${px * 1.1}px ${SERIF}`;
  const tw = ctx.measureText(title).width;
  ctx.font = `${px}px ${SERIF}`;
  const w = Math.min(maxW, Math.max(tw, ...lines.map((l) => ctx.measureText(l).width), footer ? ctx.measureText(footer).width : 0)) + px * 1.4;
  const lh = px * 1.3;
  const h = px * 1.6 + lines.length * lh + (footer ? lh * 1.2 : 0) + px * 0.6;
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  const bx = Math.max(px, Math.min(cw - w - px, x + px));
  const by = Math.max(px, Math.min(ch - h - px, y - h - px));
  ctx.fillStyle = 'rgba(24, 18, 14, 0.94)';
  ctx.strokeStyle = 'rgba(212, 165, 49, 0.7)';
  ctx.lineWidth = Math.max(1, px / 12);
  roundRect(ctx, bx, by, w, h, px * 0.3);
  ctx.fill();
  ctx.stroke();
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#f3dfa8';
  ctx.font = `600 ${px * 1.1}px ${SERIF}`;
  ctx.fillText(title, bx + px * 0.7, by + px * 0.5);
  ctx.fillStyle = '#e9e0cf';
  ctx.font = `italic ${px}px ${SERIF}`;
  lines.forEach((l, i) => ctx.fillText(l, bx + px * 0.7, by + px * 1.9 + i * lh));
  if (footer) {
    ctx.fillStyle = '#a89780';
    ctx.font = `${px * 0.9}px ${SERIF}`;
    ctx.fillText(footer, bx + px * 0.7, by + px * 1.9 + lines.length * lh + px * 0.3);
  }
  ctx.restore();
}

export function closingCard(ctx: CanvasRenderingContext2D, alpha: number, title: string, subtitle: string) {
  const { width: w, height: h } = ctx.canvas;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#0c0907';
  ctx.fillRect(0, 0, w, h);
  const px = Math.max(24, Math.min(w, h) / 12);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e8c872';
  ctx.font = `italic ${px}px ${SERIF}`;
  ctx.fillText(title, w / 2, h / 2 - px * 0.3);
  ctx.fillStyle = '#a89780';
  ctx.font = `${px * 0.35}px ${SERIF}`;
  ctx.fillText(subtitle, w / 2, h / 2 + px * 0.7);
  ctx.restore();
}
