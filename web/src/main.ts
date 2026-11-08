// /indulgence viewer: trades the ticket for a view-only token, subscribes to its field of
// view and draws the cathedral around its own priest.

import { C, type CandleName, type VestmentName } from '../../shared/constants';
import { DbConnection } from './module_bindings';
import type { Priest, PrayerTick, Candle } from './module_bindings/types';
import { cameraFor, project, sortDrawables, LAYER, type Drawable } from './iso';
import { poseAt, type PriestPlan, type Pose } from './motion';
import { drawFloor, furniture, candleDrawable, drawGlows, type CandleView } from './scene';
import { PriestSprites, vestmentName } from './sprites';
import { card, closingCard, drawBubble, layoutBubble, measureTag, nameTag, overlaps, type Rect } from './text';
import { cannedPrayer } from './canned';
import { takeTicketFromUrl, loadGrant, saveGrant, clearGrant, redeemTicket, refreshGrant, type ViewerGrant } from './net';

const SLOT = C.PACING_SLOT_MS;
const RETRY_FOR_MS = 120_000;
const STRANGER_BUBBLES = 3;

const display = document.getElementById('view') as HTMLCanvasElement;
const dctx = display.getContext('2d')!;
const base = document.createElement('canvas');
base.width = C.BASE_W_PX;
base.height = C.BASE_H_PX;
const bctx = base.getContext('2d')!;

const ms = (t: { microsSinceUnixEpoch: bigint }) => Number(t.microsSinceUnixEpoch / 1000n);

type Phase = 'loading' | 'live' | 'reconnecting' | 'closing' | 'closed' | 'no-ticket';
let phase: Phase = 'loading';
let closingSince = 0;
let closingTitle = 'Ite, missa est';
let closingSubtitle = 'Your candle is lit.';
let disconnectedAt: number | undefined;

let grant: ViewerGrant | undefined;
let skew = 0;
let conn: DbConnection | undefined;
let ownId = 0n;
let sprites: PriestSprites | undefined;
let subscribed = false;

const enteredAt = new Map<bigint, number>();
const muted = new Set<bigint>();
let mouse: { x: number; y: number } | undefined;
let hovered: { kind: 'priest'; id: bigint } | { kind: 'candle'; id: bigint } | undefined;

const now = () => Date.now() + skew;

function closeWith(title: string, subtitle: string) {
  if (phase === 'closing' || phase === 'closed') return;
  phase = 'closing';
  closingSince = Date.now();
  closingTitle = title;
  closingSubtitle = subtitle;
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start() {
  // Redeem first: the ticket is single use, so lose as little time as possible before the
  // grant is safely in sessionStorage.
  const ticket = takeTicketFromUrl();
  const spritesLoading = PriestSprites.load();
  try {
    grant = ticket ? await redeemTicket(ticket) : loadGrant();
  } catch {
    grant = undefined;
  }
  if (grant) saveGrant(grant);
  sprites = await spritesLoading;
  if (!grant) {
    phase = 'no-ticket';
    closingTitle = '/indulgence';
    closingSubtitle = ticket ? 'This link has already been used or has expired.' : 'Run /indulgence in Claude Code to enter the cathedral.';
    return;
  }
  saveGrant(grant);
  skew = grant.server_time - grant.received_at;
  ownId = BigInt(grant.priest_id);
  connect(grant);
  setInterval(() => void keepTokenFresh(), 30 * 60_000);
}

async function keepTokenFresh() {
  if (!grant || phase === 'closing' || phase === 'closed') return;
  if (grant.expires_at - Date.now() > 90 * 60_000) return;
  const next = await refreshGrant(grant.token).catch(() => undefined);
  if (next) {
    grant = next;
    saveGrant(next);
  }
}

function connect(g: ViewerGrant) {
  const lo = g.px - C.VIEW_HALF_WIDTH;
  const hi = g.px + C.VIEW_HALF_WIDTH;
  conn = DbConnection.builder()
    .withUri(g.uri)
    .withDatabaseName(g.module)
    .withToken(g.token)
    .withTokenProvider(async () => {
      const next = await refreshGrant(grant!.token);
      if (!next) throw new Error('session ended');
      grant = next;
      saveGrant(next);
      return next.token;
    })
    .withAutomaticReconnect({ minDelayMs: 1000, maxDelayMs: 15_000 })
    .onConnect(() => {
      disconnectedAt = undefined;
      if (phase === 'reconnecting' || phase === 'loading') phase = 'live';
    })
    .onDisconnect((_ctx, _err, nextAttempt) => {
      if (phase === 'closing' || phase === 'closed') return;
      disconnectedAt ??= Date.now();
      if (nextAttempt === undefined) closeWith('Ite, missa est', 'The connection to the cathedral was lost.');
      else phase = 'reconnecting';
    })
    .onConnectError(() => {
      disconnectedAt ??= Date.now();
      if (phase === 'loading') closeWith('/indulgence', 'Could not reach the cathedral.');
    })
    .build();

  conn.db.priest.onInsert((_ctx, p) => {
    if (p.state.tag === 'Entering') enteredAt.set(p.priestId, ms(p.stateSince));
  });
  conn.db.priest.onDelete((_ctx, p) => {
    enteredAt.delete(p.priestId);
    if (p.priestId === ownId) closeWith('Ite, missa est', 'Your candle is lit.');
  });

  // The field of view never changes: seated priests do not move.
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      subscribed = true;
      if (!conn!.db.priest.priestId.find(ownId)) closeWith('Ite, missa est', 'Your priest has already left.');
    })
    .subscribe([
      `SELECT * FROM priest WHERE x >= ${lo} AND x < ${hi}`,
      `SELECT * FROM prayer_tick WHERE x >= ${lo} AND x < ${hi}`,
      `SELECT * FROM candle WHERE x >= ${lo} AND x < ${hi}`,
      'SELECT * FROM viewer_label',
      'SELECT * FROM prayer_text',
    ]);
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

interface PriestView {
  row: Priest;
  pose: Pose;
  feet: [number, number];
  label?: string;
}

function planOf(p: Priest): PriestPlan {
  let candle: PriestPlan['candle'];
  if (p.state.tag === 'Departing' && p.candleId !== 0n) {
    const c = conn?.db.candle.candleId.find(p.candleId);
    if (c) candle = { arcade: c.arcade, slot: c.slot };
    else {
      // Candle outside our field of view: walk toward the stand the rules would pick.
      candle = { arcade: p.half === 0 ? p.bay : p.bay + 1, slot: 0 };
    }
  }
  return {
    bay: p.bay,
    row: p.row,
    half: p.half,
    seat: p.seat,
    state: p.state.tag as PriestPlan['state'],
    since: ms(p.stateSince),
    enteredAt: enteredAt.get(p.priestId),
    candle,
  };
}

function currentPrayer(p: Priest, tick: PrayerTick | null | undefined): { text: string; real: boolean } | undefined {
  if (!tick) return undefined;
  for (const t of conn!.db.prayerText.iter()) {
    if (t.priestId === p.priestId && t.seq === tick.seq) return { text: t.text, real: true };
  }
  return { text: cannedPrayer(tick.cannedIdx), real: false };
}

function frame() {
  requestAnimationFrame(frame);
  resize();
  const t = now();
  const scale = Math.max(1, Math.floor(Math.min(display.width / C.BASE_W_PX, display.height / C.BASE_H_PX)));
  const offX = Math.floor((display.width - C.BASE_W_PX * scale) / 2);
  const offY = Math.floor((display.height - C.BASE_H_PX * scale) / 2);
  const toDisplay = (bx: number, by: number): [number, number] => [offX + bx * scale, offY + by * scale];
  const textPx = Math.max(11, Math.round(scale * 5.5));

  dctx.fillStyle = '#0c0907';
  dctx.fillRect(0, 0, display.width, display.height);

  if (phase === 'no-ticket') {
    closingCard(dctx, 1, closingTitle, closingSubtitle);
    return;
  }
  if (!conn || !subscribed) {
    closingCard(dctx, 1, '/indulgence', 'Entering the cathedral…');
    return;
  }

  const own = conn.db.priest.priestId.find(ownId);
  if (own?.state.tag === 'Departing' && phase !== 'closing' && phase !== 'closed' && t - ms(own.stateSince) > C.PRIEST_REMOVE_AFTER_MS) {
    closeWith('Ite, missa est', 'Your candle is lit.');
  }
  const focus = own ? [own.x, own.y] : [grant!.px, C.ROW_Y[1]!];
  const cam = cameraFor(focus[0]!, focus[1]!);
  const x0 = focus[0]! - 22;
  const x1 = focus[0]! + 22;

  // --- base layer -----------------------------------------------------------
  bctx.imageSmoothingEnabled = false;
  bctx.fillStyle = '#120e0c';
  bctx.fillRect(0, 0, C.BASE_W_PX, C.BASE_H_PX);
  drawFloor(bctx, cam, x0, x1);
  const drawables: Drawable[] = furniture(cam, x0, x1);

  const labels = new Map<bigint, string>();
  for (const l of conn.db.viewerLabel.iter()) labels.set(l.priestId, l.label);

  const priests: PriestView[] = [];
  for (const p of conn.db.priest.iter()) {
    const pose = poseAt(planOf(p), t);
    if (pose.action === 'gone') continue;
    const feet = project(cam, pose.x, pose.y);
    const view: PriestView = { row: p, pose, feet, label: labels.get(p.priestId) };
    priests.push(view);
    const v: VestmentName = vestmentName(p.vestment.tag);
    drawables.push({ depth: pose.x + pose.y, layer: LAYER.priest, draw: (ctx) => sprites!.draw(ctx, v, pose, feet[0], feet[1]) });
  }

  const candles: (CandleView & { row: Candle; hit: [number, number, number, number] })[] = [];
  for (const c of conn.db.candle.iter()) {
    const view: CandleView = {
      arcade: c.arcade,
      slot: c.slot,
      size: c.size.tag.toLowerCase() as CandleName,
      litAt: ms(c.litAt),
      expiresAt: ms(c.expiresAt),
    };
    const d = candleDrawable(cam, view, t, hovered?.kind === 'candle' && hovered.id === c.candleId);
    drawables.push(d);
    candles.push({ ...view, row: c, hit: d.hit });
  }

  for (const d of sortDrawables(drawables)) d.draw(bctx);
  drawGlows(bctx, cam, candles, t);
  vignette(bctx);

  dctx.imageSmoothingEnabled = false;
  dctx.drawImage(base, offX, offY, C.BASE_W_PX * scale, C.BASE_H_PX * scale);

  // --- hit testing ------------------------------------------------------------------
  hovered = undefined;
  if (mouse) {
    const bx = (mouse.x - offX) / scale;
    const by = (mouse.y - offY) / scale;
    const byDepth = [...priests].sort((a, b) => b.pose.x + b.pose.y - (a.pose.x + a.pose.y));
    const hitP = byDepth.find((p) => Math.abs(bx - p.feet[0]) <= 6 && by <= p.feet[1] + 1 && by >= p.feet[1] - 24);
    if (hitP) hovered = { kind: 'priest', id: hitP.row.priestId };
    else {
      const hitC = candles.find((c) => bx >= c.hit[0] && bx <= c.hit[0] + c.hit[2] && by >= c.hit[1] && by <= c.hit[1] + c.hit[3]);
      if (hitC) hovered = { kind: 'candle', id: hitC.row.candleId };
    }
  }
  display.style.cursor = hovered?.kind === 'priest' && hovered.id !== ownId ? 'pointer' : 'default';

  // --- overlay text -------------------------------------------------------------------
  const ownPos = own ? [own.x, own.y] : focus;
  const strangers = priests
    .filter((p) => !p.label && p.row.priestId !== ownId)
    .sort((a, b) => Math.abs(a.row.x - ownPos[0]!) + Math.abs(a.row.y - ownPos[1]!) - (Math.abs(b.row.x - ownPos[0]!) + Math.abs(b.row.y - ownPos[1]!)))
    .slice(0, STRANGER_BUBBLES)
    .map((p) => p.row.priestId);

  // Name tags first (yours, then mutuals), nudged upward until they stop colliding.
  const placed: Rect[] = [];
  const anchors = new Map<bigint, [number, number]>();
  const tagged = priests.filter((p) => p.label || p.row.priestId === ownId).sort((a, b) => Number(b.row.priestId === ownId) - Number(a.row.priestId === ownId));
  const tagPx = Math.round(textPx * 0.9);
  for (const p of tagged) {
    const [dx, dy0] = toDisplay(p.feet[0], p.feet[1] - 22);
    const text = p.label ?? 'You';
    let dy = dy0 - textPx * 0.2;
    let r = measureTag(dctx, dx, dy, text, tagPx);
    for (let k = 0; k < 4 && placed.some((q) => overlaps(q, r)); k++) {
      dy -= tagPx * 1.1;
      r = measureTag(dctx, dx, dy, text, tagPx);
    }
    placed.push(r);
    anchors.set(p.row.priestId, [dx, r.y]);
    nameTag(dctx, dx, dy, text, tagPx, p.row.priestId === ownId ? '#ffe9a8' : '#f3dfa8');
  }

  // Speech bubbles in priority order: yours, mutuals, then a few nearby strangers.
  const order = [...priests].sort((a, b) => rank(a) - rank(b));
  function rank(p: PriestView) {
    return p.row.priestId === ownId ? 0 : p.label ? 1 : 2;
  }
  for (const p of order) {
    const mine = p.row.priestId === ownId;
    if (muted.has(p.row.priestId) || p.pose.action !== 'kneel') continue;
    if (!(mine || p.label || strangers.includes(p.row.priestId))) continue;
    const tick = conn.db.prayerTick.priestId.find(p.row.priestId);
    if (!tick) continue;
    const elapsed = t - ms(tick.at);
    if (elapsed < 0 || elapsed > SLOT) continue;
    const prayer = currentPrayer(p.row, tick)!;
    const shown = prayer.text.slice(0, Math.ceil(prayer.text.length * Math.min(1, elapsed / (SLOT * 0.85))));
    const [ax, ay] = anchors.get(p.row.priestId) ?? toDisplay(p.feet[0], p.feet[1] - 22);
    const layout = layoutBubble(dctx, ax, ay - textPx * 0.2, shown, textPx, mine ? 3 : 2, mine);
    if (!layout) continue;
    for (let k = 0; k < 3 && placed.some((q) => overlaps(q, layout.rect)); k++) layout.rect.y -= layout.rect.h * 0.6;
    if (placed.some((q) => overlaps(q, layout.rect)) && !mine) continue;
    placed.push(layout.rect);
    drawBubble(dctx, layout);
  }

  if (hovered && mouse) {
    if (hovered.kind === 'priest') {
      const p = priests.find((x) => x.row.priestId === hovered!.id)!;
      const mine = p.row.priestId === ownId;
      const v = vestmentName(p.row.vestment.tag);
      const title = mine ? `${p.label ?? 'You'} (you)` : (p.label ?? `A ${v}`);
      const tick = conn.db.prayerTick.priestId.find(p.row.priestId);
      const prayer = muted.has(p.row.priestId) ? undefined : currentPrayer(p.row, tick);
      const body = p.row.state.tag === 'Departing' ? 'Going to light a candle.' : (prayer?.text ?? 'Kneeling in silence.');
      const footer = mine ? '' : muted.has(p.row.priestId) ? 'Muted. Click to unmute.' : 'Click to mute.';
      card(dctx, mouse.x, mouse.y, title, body, footer, textPx);
    } else {
      const c = candles.find((x) => x.row.candleId === hovered!.id)!;
      const lit = c.litAt <= t;
      const hours = Math.max(0, Math.round((c.expiresAt - t) / 3_600_000));
      card(dctx, mouse.x, mouse.y, c.row.label, lit ? `A ${c.size}, burning for about ${hours} more hour${hours === 1 ? '' : 's'}.` : 'Being lit…', '', textPx);
    }
  }

  // --- status and closing ---------------------------------------------------------------
  if (phase === 'reconnecting' && disconnectedAt !== undefined) {
    if (Date.now() - disconnectedAt > RETRY_FOR_MS) closeWith('Ite, missa est', 'The connection to the cathedral was lost.');
    nameTag(dctx, display.width / 2, display.height - textPx, 'Reconnecting…', textPx, '#a89780');
  }
  if (phase === 'closing' || phase === 'closed') {
    const a = Math.min(1, (Date.now() - closingSince) / 2000);
    closingCard(dctx, a, closingTitle, closingSubtitle);
    if (a >= 1 && phase === 'closing') {
      phase = 'closed';
      conn.disconnect();
      clearGrant();
    }
  }
}

function vignette(ctx: CanvasRenderingContext2D) {
  const g = ctx.createRadialGradient(C.BASE_W_PX / 2, C.BASE_H_PX / 2, C.BASE_H_PX * 0.35, C.BASE_W_PX / 2, C.BASE_H_PX / 2, C.BASE_W_PX * 0.62);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.65)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, C.BASE_W_PX, C.BASE_H_PX);
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.floor(display.clientWidth * dpr);
  const h = Math.floor(display.clientHeight * dpr);
  if (display.width !== w || display.height !== h) {
    display.width = w;
    display.height = h;
  }
}

display.addEventListener('mousemove', (e) => {
  const dpr = window.devicePixelRatio || 1;
  const r = display.getBoundingClientRect();
  mouse = { x: (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * dpr };
});
display.addEventListener('mouseleave', () => (mouse = undefined));
display.addEventListener('click', () => {
  if (hovered?.kind !== 'priest' || hovered.id === ownId) return;
  if (muted.has(hovered.id)) muted.delete(hovered.id);
  else muted.add(hovered.id);
});

void start();
requestAnimationFrame(frame);
