// /indulgence viewer: trades the ticket for a view-only token, subscribes to its field of
// view and draws the cathedral around its own priest.

import { C, type CandleName, type VestmentName } from '../../shared/constants';
import { DbConnection } from './module_bindings';
import type { Priest, PrayerTick, Candle } from './module_bindings/types';
import { bayCentreX, cameraFor, project, sortDrawables, viewportFor, visibleTiles, LAYER, type Drawable, type Viewport, type Camera } from './view';
import { poseAt, seatedAt, type PriestPlan, type Pose } from './motion';
import { AMBIENT, drawStatic, furniture, candleDrawable, candleFlame, applyLighting, fixedLights, drawFixedFlames, drawFlame, drawRays, type CandleView, type Light } from './scene';
import { ditherFrame } from './dither';
import { PriestSprites, vestmentName, thuriferHand, thuribleBowl } from './sprites';
import { thurifersBetween, thuriferX, swing, NPC_LANE_Y, THURIFER_PRAYER } from './npc';
import { closingCard, cursorNote, drawLine, hoverText, loadFont, measureTag, nameTag, overlaps, placeLine, textSize, CRIMSON, type Rect, type TagStyle } from './text';
import { drawKey, type KeyEntry, type KeyRow } from './key';
import { schedule, spokenAt, LINGER_MS, type Recital } from './recital';
import { cannedPrayer } from './canned';
import { takeTicketFromUrl, loadGrant, saveGrant, clearGrant, redeemTicket, refreshGrant, type ViewerGrant } from './net';

const SLOT = C.PACING_SLOT_MS;
/** Height of a priest sprite above its feet, base px (LPC sheets are drawn at half size). */
const HEAD = 30;
const RETRY_FOR_MS = 120_000;
/** Strangers nearest you whose (canned) prayers are written over the scene. */
const STRANGER_PRAYERS = 2;

const display = document.getElementById('view') as HTMLCanvasElement;
const dctx = display.getContext('2d')!;
const base = document.createElement('canvas');
const bctx = base.getContext('2d', { willReadFrequently: true })!;
// Floor and back wall never move (the camera is fixed on your seat): drawn once per camera.
const staticLayer = document.createElement('canvas');
const sctx = staticLayer.getContext('2d')!;
let staticKey = '';
// Coloured light from the vault, kept apart so the dither can tint by it.
const rayLayer = document.createElement('canvas');
const rctx = rayLayer.getContext('2d', { willReadFrequently: true })!;

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

const muted = new Set<bigint>();
/** Friends picked out from the key: crimson outline, crimson name. */
const marked = new Set<bigint>();
/** The key as last drawn, for hit testing. */
let keyPanel: Rect | undefined;
let keyRows: KeyRow[] = [];
let keyHover: bigint | undefined;
/** Each priest's prayer being recited and the one before, so a new prayer can take over. */
const recitals = new Map<bigint, { key: string; cur?: Recital; prev?: Recital }>();
let mouse: { x: number; y: number } | undefined;
let hovered: { kind: 'priest'; id: bigint } | { kind: 'candle'; id: bigint } | { kind: 'thurifer'; id: number } | undefined;

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
  void loadFont();
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

  conn.db.priest.onDelete((_ctx, p) => {
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
  /** When it sat down in its pew (it prays only from then on); undefined once leaving. */
  seated?: number;
}

function planOf(p: Priest, entryY: number): PriestPlan {
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
    enteredAt: ms(p.enteredAt),
    candle,
    entryY,
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
  const vp: Viewport = viewportFor(display.width, display.height);
  const { scale, offX, offY, baseW, baseH } = vp;
  if (base.width !== baseW || base.height !== baseH) {
    base.width = rayLayer.width = baseW;
    base.height = rayLayer.height = baseH;
  }
  const toDisplay = (bx: number, by: number): [number, number] => [offX + bx * scale, offY + by * scale];
  const textPx = textSize(scale);

  dctx.fillStyle = '#0a0909';
  dctx.fillRect(0, 0, display.width, display.height);

  if (phase === 'no-ticket') {
    closingCard(dctx, 1, closingTitle, closingSubtitle, Date.now());
    return;
  }
  if (!conn || !subscribed) {
    closingCard(dctx, 1, '/indulgence', 'Entering the cathedral…', Date.now());
    return;
  }

  const own = conn.db.priest.priestId.find(ownId);
  if (own?.state.tag === 'Departing' && phase !== 'closing' && phase !== 'closed' && t - ms(own.stateSince) > C.PRIEST_REMOVE_AFTER_MS) {
    closeWith('Ite, missa est', 'Your candle is lit.');
  }
  // Your bay's altar at the top centre of the screen; pews run on past the bottom.
  const cam = cameraFor(bayCentreX(own ? own.x : grant!.px), vp);
  const { x0, x1, yMax } = visibleTiles(cam, vp);
  const entryY = Math.max(C.ENTRY_Y, yMax + 2);

  // --- scene, in grey -------------------------------------------------------------
  const key = `${cam.ox},${cam.oy},${baseW},${baseH}`;
  if (key !== staticKey) {
    staticLayer.width = baseW;
    staticLayer.height = baseH;
    drawStatic(sctx, cam, x0, x1, yMax, baseW, baseH);
    staticKey = key;
  }
  bctx.imageSmoothingEnabled = false;
  bctx.drawImage(staticLayer, 0, 0);
  const drawables: Drawable[] = furniture(cam, x0, x1, yMax);

  const labels = new Map<bigint, string>();
  for (const l of conn.db.viewerLabel.iter()) labels.set(l.priestId, l.label);

  const priests: PriestView[] = [];
  for (const p of conn.db.priest.iter()) {
    const plan = planOf(p, entryY);
    const pose = poseAt(plan, t);
    if (pose.action === 'gone') continue;
    const feet = project(cam, pose.x, pose.y);
    const view: PriestView = { row: p, pose, feet, label: labels.get(p.priestId), seated: seatedAt(plan) };
    priests.push(view);
    const v: VestmentName = vestmentName(p.vestment.tag);
    drawables.push({ depth: pose.y, layer: LAYER.priest, x: pose.x, draw: (ctx: CanvasRenderingContext2D) => sprites!.draw(ctx, v, pose, feet[0], feet[1]) });
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

  // The thurifer processes across the front of the nave, every two minutes at any one place.
  const thurifers = thurifersBetween(t, x0, x1).map((th) => {
    const feet = project(cam, th.x, th.y);
    const pose: Pose = { x: th.x, y: th.y, dir: 'right', action: 'walk', t: t / 1000, alpha: 1 };
    drawables.push({
      depth: th.y,
      layer: LAYER.priest,
      x: th.x,
      draw: (ctx: CanvasRenderingContext2D) => void sprites!.drawThurifer(ctx, pose, feet[0], feet[1], { swing: swing(t) }),
    });
    return { ...th, feet };
  });

  for (const d of sortDrawables(drawables)) d.draw(bctx);
  for (const th of thurifers) drawSmoke(bctx, cam, th.j, t);

  // --- candlelight, coloured shafts, dither ---------------------------------------------
  const lights: Light[] = fixedLights(cam, x0, x1, yMax);
  const litFlames: [number, number, number][] = [];
  for (const c of candles) {
    if (c.litAt > t) continue;
    const [fx, fy] = candleFlame(cam, c);
    lights.push({ x: fx, y: fy, r: 30, power: 0.5 });
    litFlames.push([fx, fy, c.slot + c.arcade * 40]);
  }
  for (const th of thurifers) {
    const [hx, hy] = thuriferHand(sprites!, th.feet[0], th.feet[1]);
    const [bx, by] = thuribleBowl(hx, hy, swing(t));
    lights.push({ x: bx, y: by, r: 18, power: 0.3 });
  }
  applyLighting(bctx, baseW, baseH, lights, AMBIENT);
  drawRays(rctx, cam, x0, x1, baseW, baseH, Math.floor(t / 2000) * 2000);
  ditherFrame(bctx, baseW, baseH, rctx.getImageData(0, 0, baseW, baseH).data);
  drawFixedFlames(bctx, cam, x0, x1, yMax, t);
  for (const [fx, fy, seed] of litFlames) drawFlame(bctx, fx, fy, t, seed);
  // Friends picked out in the key, ringed in crimson after the dither so it stays crimson.
  for (const p of priests) {
    if (marked.has(p.row.priestId)) sprites!.mark(bctx, vestmentName(p.row.vestment.tag), p.pose, p.feet[0], p.feet[1], CRIMSON);
  }

  dctx.imageSmoothingEnabled = false;
  dctx.drawImage(base, offX, offY, baseW * scale, baseH * scale);

  // --- hit testing ------------------------------------------------------------------
  hovered = undefined;
  keyHover = undefined;
  const inKey = !!mouse && !!keyPanel && mouse.x >= keyPanel.x && mouse.x <= keyPanel.x + keyPanel.w && mouse.y >= keyPanel.y && mouse.y <= keyPanel.y + keyPanel.h;
  if (mouse && inKey) {
    keyHover = keyRows.find((r) => mouse!.y >= r.rect.y && mouse!.y < r.rect.y + r.rect.h)?.id;
  } else if (mouse) {
    const bx = (mouse.x - offX) / scale;
    const by = (mouse.y - offY) / scale;
    const byDepth = [...priests].sort((a, b) => b.pose.y - a.pose.y);
    const hitP = byDepth.find((p) => Math.abs(bx - p.feet[0]) <= 7 && by <= p.feet[1] + 1 && by >= p.feet[1] - HEAD);
    const hitT = thurifers.find((th) => Math.abs(bx - th.feet[0]) <= 8 && by <= th.feet[1] + 1 && by >= th.feet[1] - HEAD);
    if (hitP) hovered = { kind: 'priest', id: hitP.row.priestId };
    else if (hitT) hovered = { kind: 'thurifer', id: hitT.j };
    else {
      const hitC = candles.find((c) => bx >= c.hit[0] && bx <= c.hit[0] + c.hit[2] && by >= c.hit[1] && by <= c.hit[1] + c.hit[3]);
      if (hitC) hovered = { kind: 'candle', id: hitC.row.candleId };
    }
  }
  const hoveredPriest = hovered?.kind === 'priest' ? hovered.id : undefined;
  display.style.cursor = keyHover !== undefined || (hoveredPriest !== undefined && hoveredPriest !== ownId) ? 'pointer' : 'default';

  // --- words over the scene ------------------------------------------------------------
  const ownPos = own ? [own.x, own.y] : [grant!.px, C.ROW_Y[0]!];
  const strangers = priests
    .filter((p) => !p.label && p.row.priestId !== ownId)
    .sort((a, b) => Math.abs(a.row.x - ownPos[0]!) + Math.abs(a.row.y - ownPos[1]!) - (Math.abs(b.row.x - ownPos[0]!) + Math.abs(b.row.y - ownPos[1]!)))
    .slice(0, STRANGER_PRAYERS)
    .map((p) => p.row.priestId);

  // Names: yours always; anyone else's only while hovered, or in crimson once picked out
  // in the key. Nudged upward until they stop colliding.
  const tagStyle = (p: PriestView): TagStyle | undefined =>
    p.row.priestId === ownId ? 'own' : marked.has(p.row.priestId) ? 'marked' : p.row.priestId === hoveredPriest ? 'plain' : undefined;
  const tagOrder = (p: PriestView) => (p.row.priestId === ownId ? 0 : p.row.priestId === hoveredPriest ? 1 : 2);
  const placed: Rect[] = [];
  const anchors = new Map<bigint, [number, number]>();
  const tagPx = Math.round(textPx * 0.9);
  for (const p of priests.filter((x) => tagStyle(x)).sort((a, b) => tagOrder(a) - tagOrder(b))) {
    const [dx, dy0] = toDisplay(p.feet[0], p.feet[1] - HEAD);
    const style = tagStyle(p)!;
    const text = style === 'own' ? 'you' : (p.label ?? `a ${vestmentName(p.row.vestment.tag)}`);
    let dy = dy0 - textPx * 0.2;
    let r = measureTag(dctx, dx, dy, text, tagPx);
    for (let k = 0; k < 4 && placed.some((q) => overlaps(q, r)); k++) {
      dy -= tagPx * 1.1;
      r = measureTag(dctx, dx, dy, text, tagPx);
    }
    placed.push(r);
    anchors.set(p.row.priestId, [dx, r.y]);
    nameTag(dctx, dx, dy, text, tagPx, style, t);
  }

  // Prayers, a sentence at a time, once a priest has sat down: yours, your friends', a
  // couple of nearby strangers' and whoever is under the mouse.
  const present = new Set(priests.map((p) => p.row.priestId));
  for (const id of recitals.keys()) if (!present.has(id)) recitals.delete(id);
  const rank = (p: PriestView) => (p.row.priestId === ownId ? 0 : p.row.priestId === hoveredPriest ? 1 : p.label ? 2 : 3);
  for (const p of [...priests].sort((a, b) => rank(a) - rank(b))) {
    const id = p.row.priestId;
    const mine = id === ownId;
    if (muted.has(id) || p.seated === undefined || t < p.seated) continue;
    if (!(mine || p.label || strangers.includes(id) || id === hoveredPriest)) continue;
    const tick = conn.db.prayerTick.priestId.find(id);
    if (!tick) continue;
    const key = `${tick.seq}:${ms(tick.at)}`;
    let mem = recitals.get(id);
    if (!mem || mem.key !== key) {
      mem = { key, prev: mem?.cur };
      recitals.set(id, mem);
    }
    mem.cur = schedule(currentPrayer(p.row, tick)!.text, Math.max(ms(tick.at), p.seated), SLOT);
    const spoken = spokenAt(mem.cur, mem.prev, t);
    if (!spoken.current) continue;

    const px = mine ? textPx : Math.round(textPx * 0.94);
    const [ax, ay] = anchors.get(id) ?? toDisplay(p.feet[0], p.feet[1] - HEAD);
    const cur = placeLine(dctx, spoken.current.line.text, ax, ay - textPx * 0.25, px, mine);
    const prev = spoken.previous ? placeLine(dctx, spoken.previous.text, ax, cur.y, px, mine) : undefined;
    const block = (): Rect => (prev ? { x: Math.min(cur.x, prev.x), y: prev.y, w: Math.max(cur.x + cur.w, prev.x + prev.w) - Math.min(cur.x, prev.x), h: cur.y + cur.h - prev.y } : cur);
    for (let k = 0; k < 3 && placed.some((q) => overlaps(q, block())); k++) {
      cur.y -= cur.h;
      if (prev) prev.y -= cur.h;
    }
    if (placed.some((q) => overlaps(q, block())) && !mine) continue;
    placed.push(block());

    drawLine(dctx, cur, spoken.current.shown, mine, t, spoken.current.alpha);
    if (prev && spoken.previous) {
      // The finished line rises above the new one at half opacity, sways a couple of
      // pixels as it drifts off, and is gone after LINGER_MS.
      const age = t - spoken.previous.since;
      const rise = Math.min(1, age / 220);
      const sway = Math.sin((age / 1000) * Math.PI * 1.3) * scale * 1.5;
      const drift = (-age / LINGER_MS) * scale * 2;
      const out = Math.max(0, Math.min(1, (LINGER_MS - age) / 350));
      drawLine(dctx, prev, spoken.previous.text, mine, t, spoken.previous.alpha * out, sway, (cur.y - prev.y) * (1 - rise) + drift);
    }
  }

  if (hovered && mouse) {
    const notePx = Math.round(textPx * 0.8);
    if (hovered.kind === 'priest') {
      const p = priests.find((x) => x.row.priestId === hovered!.id)!;
      if (p.row.priestId !== ownId) {
        const notes: string[] = [];
        if (p.row.state.tag === 'Departing') notes.push(p.row.candleId !== 0n ? 'going to light a candle' : 'leaving');
        else if (p.seated === undefined || t < p.seated) notes.push('on the way to a pew');
        notes.push(muted.has(p.row.priestId) ? 'muted · click to unmute' : 'click to mute');
        cursorNote(dctx, mouse.x, mouse.y, notes, notePx);
      }
    } else if (hovered.kind === 'thurifer') {
      hoverText(dctx, mouse.x, mouse.y, 'the thurifer', THURIFER_PRAYER, 'passes every two minutes', notePx);
    } else {
      const c = candles.find((x) => x.row.candleId === hovered!.id)!;
      const lit = c.litAt <= t;
      const hours = Math.max(0, Math.round((c.expiresAt - t) / 3_600_000));
      hoverText(dctx, mouse.x, mouse.y, c.row.label, lit ? `A ${c.size}, burning for about ${hours} more hour${hours === 1 ? '' : 's'}.` : 'Being lit…', '', notePx);
    }
  }

  // --- the key: friends in the cathedral with you --------------------------------------
  const keyEntries: KeyEntry[] = priests
    .filter((p) => p.label && p.row.priestId !== ownId)
    .map((p) => ({ id: p.row.priestId, name: p.label!, leaving: p.row.state.tag === 'Departing', marked: marked.has(p.row.priestId) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const drawnKey = drawKey(dctx, keyEntries, Math.round(textPx * 0.85), keyHover);
  keyPanel = drawnKey.panel;
  keyRows = drawnKey.rows;

  // --- status and closing ---------------------------------------------------------------
  if (phase === 'reconnecting' && disconnectedAt !== undefined) {
    if (Date.now() - disconnectedAt > RETRY_FOR_MS) closeWith('Ite, missa est', 'The connection to the cathedral was lost.');
    nameTag(dctx, display.width / 2, display.height - textPx, 'reconnecting…', textPx, 'plain', t);
  }
  if (phase === 'closing' || phase === 'closed') {
    const a = Math.min(1, (Date.now() - closingSince) / 2000);
    closingCard(dctx, a, closingTitle, closingSubtitle, Date.now());
    if (a >= 1 && phase === 'closing') {
      phase = 'closed';
      conn.disconnect();
      clearGrant();
    }
  }
}

const SMOKE_EVERY_MS = 140;
const SMOKE_LIFE_S = 3.6;

/** Incense smoke: puffs released from the thurible's past positions, rising and fading. */
function drawSmoke(ctx: CanvasRenderingContext2D, cam: Camera, j: number, t: number) {
  ctx.save();
  const last = Math.floor(t / SMOKE_EVERY_MS) * SMOKE_EVERY_MS;
  for (let te = last; te > t - SMOKE_LIFE_S * 1000; te -= SMOKE_EVERY_MS) {
    const age = (t - te) / 1000;
    const feet = project(cam, thuriferX(j, te), NPC_LANE_Y);
    const [hx, hy] = thuriferHand(sprites!, feet[0], feet[1]);
    const [bx, by] = thuribleBowl(hx, hy, swing(te));
    const seed = Math.sin(te * 12.9898) * 43758.5453;
    const wobble = Math.sin(te / 300 + age * 2) * age * 1.6;
    const x = bx + wobble - age * 1.2 + (seed - Math.floor(seed) - 0.5) * 2;
    const y = by - age * 7.5;
    const r = 0.8 + age * 1.3;
    ctx.globalAlpha = 0.32 * (1 - age / SMOKE_LIFE_S);
    ctx.fillStyle = '#ddd6cb';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
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
  if (keyHover !== undefined) {
    if (marked.has(keyHover)) marked.delete(keyHover);
    else marked.add(keyHover);
    return;
  }
  if (hovered?.kind !== 'priest' || hovered.id === ownId) return;
  if (muted.has(hovered.id)) muted.delete(hovered.id);
  else muted.add(hovered.id);
});

void start();
requestAnimationFrame(frame);
