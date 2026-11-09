// The key: a small panel at the top right listing your mutuals who are in the cathedral
// with you. Clicking a name picks that priest out: a crimson outline round its figure and
// its name written over its head in crimson, until it is clicked again.

import { CRIMSON, DIM, WHITE, font, plainText, type Rect } from './text';

export interface KeyEntry {
  id: bigint;
  name: string;
  /** Has stood up to go and light its candle. */
  leaving: boolean;
  marked: boolean;
}

export interface KeyRow {
  id: bigint;
  rect: Rect;
}

const TITLE = 'currently praying';

/** Where the key's parts sit on a display `displayW` wide, for text of size `px`. */
export function keyMetrics(displayW: number, px: number) {
  const pad = Math.round(px * 0.75);
  const margin = Math.round(px * 1.1);
  const titlePx = Math.round(px * 0.8);
  const rowH = Math.round(px * 1.4);
  const top = margin;
  return { pad, margin, titlePx, rowH, top, right: displayW - margin, firstRow: top + pad + Math.round(titlePx * 1.7) };
}

/** Middle of the i-th name's row: somewhere a click picks out that friend. */
export function keyRowCentre(displayW: number, px: number, i: number): { x: number; y: number } {
  const m = keyMetrics(displayW, px);
  return { x: m.right - m.pad - px * 2, y: m.firstRow + i * m.rowH + m.rowH / 2 };
}

/** Draw the key; returns the whole panel and its clickable rows. */
export function drawKey(ctx: CanvasRenderingContext2D, entries: KeyEntry[], px: number, hovered: bigint | undefined): { panel: Rect; rows: KeyRow[] } {
  const m = keyMetrics(ctx.canvas.width, px);
  const box = Math.max(5, Math.round(px * 0.42));
  const gap = Math.round(px * 0.55);
  ctx.save();
  ctx.font = font(m.titlePx, 600);
  let inner = ctx.measureText(TITLE).width;
  ctx.font = font(px, 600);
  const labels = entries.map((e) => (e.leaving ? `${e.name} · leaving` : e.name));
  for (const l of labels) inner = Math.max(inner, box + gap + ctx.measureText(l).width);
  const empty = entries.length === 0;
  if (empty) {
    ctx.font = font(px, 500);
    inner = Math.max(inner, ctx.measureText('no friends here yet').width);
  }
  const w = Math.ceil(inner + m.pad * 2);
  const h = m.firstRow - m.top + Math.max(1, entries.length) * m.rowH + Math.round(m.pad * 0.6);
  const left = m.right - w;

  // A dark, thinly ruled panel.
  ctx.fillStyle = 'rgba(6, 6, 6, 0.74)';
  ctx.fillRect(left, m.top, w, h);
  ctx.strokeStyle = 'rgba(160, 154, 142, 0.38)';
  ctx.lineWidth = 1;
  ctx.strokeRect(left + 0.5, m.top + 0.5, w - 1, h - 1);

  ctx.textBaseline = 'top';
  ctx.font = font(m.titlePx, 600);
  plainText(ctx, TITLE, left + m.pad, m.top + m.pad, m.titlePx, DIM, 1);
  ctx.strokeStyle = 'rgba(160, 154, 142, 0.25)';
  const rule = m.firstRow - Math.round(m.titlePx * 0.45);
  ctx.beginPath();
  ctx.moveTo(left + m.pad, rule + 0.5);
  ctx.lineTo(left + w - m.pad, rule + 0.5);
  ctx.stroke();

  const rows: KeyRow[] = [];
  if (empty) {
    ctx.font = font(px, 500);
    plainText(ctx, 'no friends here yet', left + m.pad, m.firstRow + Math.round((m.rowH - px) / 2), px, DIM, 0.8);
  }
  entries.forEach((e, i) => {
    const y = m.firstRow + i * m.rowH;
    const ty = y + Math.round((m.rowH - px) / 2);
    const bx = left + m.pad;
    const by = y + Math.round((m.rowH - box) / 2);
    // A square: hollow, or filled crimson when picked out.
    if (e.marked) {
      ctx.fillStyle = CRIMSON;
      ctx.fillRect(bx, by, box, box);
    } else {
      ctx.strokeStyle = hovered === e.id ? WHITE : DIM;
      ctx.strokeRect(bx + 0.5, by + 0.5, box - 1, box - 1);
    }
    ctx.font = font(px, 600);
    const colour = e.marked ? CRIMSON : e.leaving ? DIM : WHITE;
    plainText(ctx, labels[i]!, bx + box + gap, ty, px, colour, hovered === e.id || e.marked ? 1 : 0.86);
    rows.push({ id: e.id, rect: { x: left, y, w, h: m.rowH } });
  });
  ctx.restore();
  return { panel: { x: left, y: m.top, w, h }, rows };
}
