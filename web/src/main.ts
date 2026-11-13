// /indulgence viewer: trades the ticket for a view-only token, subscribes to its field of
// view and draws the cathedral around its own priest.

import { C, type CandleName, type VestmentName } from '../../shared/constants';
import { DbConnection } from './module_bindings';
import type { Priest, PrayerTick, Candle } from './module_bindings/types';
import { bayCentreX, cameraFor, project, sortDrawables, standFacesLeft, viewportFor, visibleTiles, LAYER, type Drawable, type Viewport, type Camera } from './view';
import { candleShown, poseAt, seatedAt, type Action, type PriestPlan, type Pose } from './motion';
import { AMBIENT, standRect, drawStatic, furniture, candleDrawable, candleFlame, applyLighting, fixedLights, drawFixedFlames, drawFlame, drawRays, applyRays, windowLightAt, type CandleView, type Glow, type Light } from './scene';
import { ditherFrame } from './dither';
import { PriestSprites, vestmentName, thuriferHand, thuribleBowl, type Side } from './sprites';
import { thurifersBetween, thuriferX, swing, NPC_LANE_Y, THURIFER_PRAYER } from './npc';
import { titleOver, cursorNote, drawLine, hoverText, loadFont, measureTag, nameTag, overlaps, placeLine, textSize, CRIMSON, type Rect, type TagStyle } from './text';
import { drawKey, type KeyEntry, type KeyRow } from './key';
import { setUpNotices } from './notices';
import { setUpMusic } from './music';
import { closeUpMirrored, mirrorX, renderFrame, renderStand, slotHit, standPlacement, standSeed, FRAME, type StandCandle } from './stand';
import { schedule, spokenAt, LINGER_MS, type Recital } from './recital';
import { cannedPrayer } from './canned';
import { takeTicketFromUrl, loadGrant, saveGrant, clearGrant, redeemTicket, refreshGrant, spectate, GATE_URL, type ViewerGrant } from './net';
import { setUpLanding } from './landing';

const SLOT = C.PACING_SLOT_MS;
/**
 * Demo builds only (demo/record.ts): shifts the thurifers' procession in time so one comes
 * past just when the recording wants it, instead of waiting up to two minutes. Zero otherwise.
 */
const THURIFER_SHIFT_MS = Number(import.meta.env.VITE_DEMO_THURIFER_SHIFT_MS ?? 0) || 0;
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
const rctx = rayLayer.getContext('2d')!;
let rayKey = '';
let glows: Glow[] = [];

const ms = (t: { microsSinceUnixEpoch: bigint }) => Number(t.microsSinceUnixEpoch / 1000n);

type Phase = 'loading' | 'live' | 'reconnecting' | 'closing' | 'closed' | 'no-ticket';
let phase: Phase = 'loading';
/** Gold words over the scene: the title as you arrive, the dismissal as you leave. */
const TITLE = 'Indulgence';
const MOTTO = 'Mea Culpa, Pater';
const DISMISSAL = 'Ite, missa est';
const INTRO_HOLD_MS = 5000;
const INTRO_FADE_MS = 1500;
/** The dismissal's line beneath, for a priest that left a candle burning or not. */
const endLine = (candleId: bigint) => (candleId !== 0n ? 'Your votive is lit. Deo gratias.' : 'Deo gratias.');
let introAt: number | undefined;
/** Where your priest last was, so the camera stays put once it has gone. */
let lastOwnX: number | undefined;
let closingSince = 0;
let closingTitle = DISMISSAL;
let closingSubtitle = endLine(1n);
let disconnectedAt: number | undefined;

let grant: ViewerGrant | undefined;
let skew = 0;
let conn: DbConnection | undefined;
let ownId = 0n;
let sprites: PriestSprites | undefined;
let subscribed = false;
/**
 * A visitor who came without a link: shown a bay chosen at random, with the welcome over
 * it. There is no priest of their own, so nothing is dismissed and nothing ends.
 */
let spectator = false;

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
let hovered: { kind: 'priest'; id: bigint } | { kind: 'candle'; id: bigint } | { kind: 'thurifer'; id: number } | { kind: 'stand'; id: number } | undefined;
/** The arcade whose votive stand is open in the close-up, if any, and where it is drawn. */
let openStand: number | undefined;
let standPanel: Rect | undefined;

const now = () => Date.now() + skew;

function closeWith(title: string, subtitle: string) {
  if (spectator || phase === 'closing' || phase === 'closed') return;
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
  if (!grant && !ticket) {
    // No link: the welcome, over whichever bay the gate picks (or over the dark, if the
    // gate cannot be reached). That grant is not kept, so a reload shows another bay.
    spectator = true;
    showLanding();
    grant = await spectate().catch(() => undefined);
  }
  sprites = await spritesLoading;
  if (!grant) {
    phase = 'no-ticket';
    closingTitle = TITLE;
    closingSubtitle = 'This link has already been used or has expired.';
    return;
  }
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
    if (!spectator) saveGrant(next);
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
      if (!spectator) saveGrant(next);
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
      if (nextAttempt === undefined) closeWith(DISMISSAL, 'The connection to the cathedral was lost.');
      else phase = 'reconnecting';
    })
    .onConnectError(() => {
      disconnectedAt ??= Date.now();
      if (phase === 'loading') closeWith(TITLE, 'Could not reach the cathedral.');
    })
    .build();

  conn.db.priest.onDelete((_ctx, p) => {
    if (p.priestId === ownId) closeWith(DISMISSAL, endLine(p.candleId));
  });

  // The field of view never changes: seated priests do not move.
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      subscribed = true;
      if (!spectator && !conn!.db.priest.priestId.find(ownId)) closeWith(DISMISSAL, 'Your priest has already left.');
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

  // Before there is a cathedral to show, the words are written on the dark.
  const ending = phase === 'closing' || phase === 'closed';
  if (phase === 'no-ticket' || !conn || !subscribed) {
    if (spectator) return; // the welcome carries the title
    if (phase === 'no-ticket' || ending) titleOver(dctx, 1, closingTitle, closingSubtitle, Date.now());
    else titleOver(dctx, 1, TITLE, MOTTO, Date.now());
    return;
  }

  const own = conn.db.priest.priestId.find(ownId);
  if (own) lastOwnX = own.x;
  // The dismissal comes as soon as your votive is lit (or, with no candle, once you have gone).
  if (own?.state.tag === 'Departing' && !ending && t - ms(own.stateSince) > (own.candleId !== 0n ? C.CANDLE_LIT_AFTER_MS : C.PRIEST_REMOVE_AFTER_MS)) {
    closeWith(DISMISSAL, endLine(own.candleId));
  }
  // Your bay's altar at the top centre of the screen; pews run on past the bottom.
  const cam = cameraFor(bayCentreX(lastOwnX ?? grant!.px), vp);
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

  // A candle's place is kept from when its priest sets off, but it is not on the stand
  // until that priest kneels there.
  const lighters = new Map<bigint, Action>();
  for (const p of priests) if (p.row.state.tag === 'Departing' && p.row.candleId !== 0n) lighters.set(p.row.candleId, p.pose.action);
  const candles: (CandleView & { row: Candle; hit: [number, number, number, number] })[] = [];
  for (const c of conn.db.candle.iter()) {
    if (!candleShown(ms(c.litAt), t, lighters.get(c.candleId))) continue;
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
  const tn = t + THURIFER_SHIFT_MS;
  const thurifers = thurifersBetween(tn, x0, x1).map((th) => {
    const feet = project(cam, th.x, th.y);
    const pose: Pose = { x: th.x, y: th.y, dir: 'right', action: 'walk', t: t / 1000, alpha: 1 };
    drawables.push({
      depth: th.y,
      layer: LAYER.priest,
      x: th.x,
      draw: (ctx: CanvasRenderingContext2D) => void sprites!.drawThurifer(ctx, pose, feet[0], feet[1], { swing: swing(tn) }),
    });
    return { ...th, feet };
  });

  for (const d of sortDrawables(drawables)) d.draw(bctx);
  for (const th of thurifers) drawSmoke(bctx, cam, th.j, tn);

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
    const [bx, by] = thuribleBowl(hx, hy, swing(tn));
    lights.push({ x: bx, y: by, r: 18, power: 0.3 });
  }
  applyLighting(bctx, baseW, baseH, lights, AMBIENT);
  ditherFrame(bctx, baseW, baseH);
  // The window light never moves: drawn once for each camera, like the floor.
  if (key !== rayKey) {
    glows = drawRays(rctx, cam, x0, x1, baseW, baseH);
    rayKey = key;
  }
  applyRays(bctx, rayLayer);
  // The windows light the side of each figure that faces them: faintly everywhere, and in
  // the glass colour where it stands in a pool of light.
  const windowSide = (x: number): Side => (Math.floor(x / C.BAY_W) <= cam.bay ? 'left' : 'right');
  for (const p of priests) {
    sprites!.litSide(bctx, vestmentName(p.row.vestment.tag), p.pose, p.feet[0], p.feet[1], windowSide(p.pose.x), windowLightAt(glows, p.pose.x, p.pose.y));
  }
  for (const th of thurifers) {
    const pose: Pose = { x: th.x, y: th.y, dir: 'right', action: 'walk', t: t / 1000, alpha: 1 };
    sprites!.litSide(bctx, 'thurifer', pose, th.feet[0], th.feet[1], windowSide(th.x), windowLightAt(glows, th.x, th.y));
  }
  drawFixedFlames(bctx, cam, x0, x1, yMax, t);
  for (const [fx, fy, seed] of litFlames) drawFlame(bctx, fx, fy, t, seed);
  // Friends picked out in the key, ringed in crimson after the dither so it stays crimson.
  for (const p of priests) {
    if (marked.has(p.row.priestId) && p.label) sprites!.mark(bctx, vestmentName(p.row.vestment.tag), p.pose, p.feet[0], p.feet[1], CRIMSON);
  }

  dctx.imageSmoothingEnabled = false;
  dctx.drawImage(base, offX, offY, baseW * scale, baseH * scale);

  // --- hit testing ------------------------------------------------------------------
  hovered = undefined;
  keyHover = undefined;
  const inKey = !!mouse && !!keyPanel && mouse.x >= keyPanel.x && mouse.x <= keyPanel.x + keyPanel.w && mouse.y >= keyPanel.y && mouse.y <= keyPanel.y + keyPanel.h;
  if (openStand !== undefined) {
    // The close-up has the mouse: nothing behind it reacts.
  } else if (mouse && inKey) {
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
      else {
        for (let a = Math.floor(x0 / C.BAY_W) - 1; a <= Math.floor(x1 / C.BAY_W) + 1; a++) {
          const [sx, sy, sw, sh] = standRect(cam, a);
          if (bx >= sx && bx <= sx + sw && by >= sy && by <= sy + sh) hovered = { kind: 'stand', id: a };
        }
      }
    }
  }
  const hoveredPriest = hovered?.kind === 'priest' ? hovered.id : undefined;
  const clickable = keyHover !== undefined || (hoveredPriest !== undefined && hoveredPriest !== ownId) || hovered?.kind === 'stand' || hovered?.kind === 'candle';
  display.style.cursor = clickable ? 'pointer' : 'default';

  // --- words over the scene ------------------------------------------------------------
  const ownPos = own ? [own.x, own.y] : [grant!.px, C.ROW_Y[0]!];
  const strangers = priests
    .filter((p) => !p.label && p.row.priestId !== ownId)
    .sort((a, b) => Math.abs(a.row.x - ownPos[0]!) + Math.abs(a.row.y - ownPos[1]!) - (Math.abs(b.row.x - ownPos[0]!) + Math.abs(b.row.y - ownPos[1]!)))
    .slice(0, STRANGER_PRAYERS)
    .map((p) => p.row.priestId);

  // Names: yours always; anyone else's only while hovered, or in crimson once picked out
  // in the key. Written under the priest's feet, apart from its prayers over its head, and
  // nudged downward until they stop colliding.
  const tagStyle = (p: PriestView): TagStyle | undefined =>
    p.row.priestId === ownId ? 'own' : marked.has(p.row.priestId) && p.label ? 'marked' : p.row.priestId === hoveredPriest ? 'plain' : undefined;
  const tagOrder = (p: PriestView) => (p.row.priestId === ownId ? 0 : p.row.priestId === hoveredPriest ? 1 : 2);
  const placed: Rect[] = [];
  const tagPx = Math.round(textPx * 0.9);
  for (const p of priests.filter((x) => tagStyle(x)).sort((a, b) => tagOrder(a) - tagOrder(b))) {
    const [dx, feetY] = toDisplay(p.feet[0], p.feet[1] + 1);
    const style = tagStyle(p)!;
    // Named for its vestment: "Your friar", "Hildegard's bishop", "a cardinal".
    const kind = vestmentName(p.row.vestment.tag);
    const text = style === 'own' ? `Your ${kind}` : p.label ? `${p.label}'s ${kind}` : `a ${kind}`;
    let dy = feetY + tagPx; // nameTag takes the bottom of the text
    let r = measureTag(dctx, dx, dy, text, tagPx);
    for (let k = 0; k < 4 && placed.some((q) => overlaps(q, r)); k++) {
      dy += tagPx * 1.1;
      r = measureTag(dctx, dx, dy, text, tagPx);
    }
    placed.push(r);
    nameTag(dctx, dx, dy, text, tagPx, style, t);
  }

  // Prayers, a clause at a time, once a priest has sat down: yours, your friends', a
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
    const [ax, ay] = toDisplay(p.feet[0], p.feet[1] - HEAD);
    const cur = placeLine(dctx, spoken.current.line.text, ax, ay - textPx * 0.25, px, mine);
    const prev = spoken.previous ? placeLine(dctx, spoken.previous.text, ax, cur.y, px, mine) : undefined;
    const block = (): Rect => (prev ? { x: Math.min(cur.x, prev.x), y: prev.y, w: Math.max(cur.x + cur.w, prev.x + prev.w) - Math.min(cur.x, prev.x), h: cur.y + cur.h - prev.y } : cur);
    for (let k = 0; k < 3 && placed.some((q) => overlaps(q, block())); k++) {
      cur.y -= cur.h;
      if (prev) prev.y -= cur.h;
    }
    if (placed.some((q) => overlaps(q, block())) && !mine) continue;
    placed.push(block());

    const voice: TagStyle = mine ? 'own' : marked.has(id) && p.label ? 'marked' : 'plain';
    drawLine(dctx, cur, spoken.current.shown, voice, t, spoken.current.alpha);
    if (prev && spoken.previous) {
      // The finished line rises above the new one at half opacity, sways a couple of
      // pixels as it drifts off, and is gone after LINGER_MS.
      const age = t - spoken.previous.since;
      const rise = Math.min(1, age / 220);
      const sway = Math.sin((age / 1000) * Math.PI * 1.3) * scale * 1.5;
      const drift = (-age / LINGER_MS) * scale * 2;
      const out = Math.max(0, Math.min(1, (LINGER_MS - age) / 350));
      drawLine(dctx, prev, spoken.previous.text, voice, t, spoken.previous.alpha * out, sway, (cur.y - prev.y) * (1 - rise) + drift);
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
    } else if (hovered.kind === 'stand') {
      cursorNote(dctx, mouse.x, mouse.y, ['the votive stand', 'click to look closer'], notePx);
    } else {
      const c = candles.find((x) => x.row.candleId === hovered!.id)!;
      const lit = c.litAt <= t;
      const hours = Math.max(0, Math.round((c.expiresAt - t) / 3_600_000));
      hoverText(dctx, mouse.x, mouse.y, c.row.label, lit ? `A ${c.size}, burning for about ${hours} more hour${hours === 1 ? '' : 's'}.` : 'Being lit…', 'click to look closer', notePx);
    }
  }

  // --- a votive stand, close up ------------------------------------------------------------
  standPanel = undefined;
  if (openStand !== undefined) {
    const onStand = candles.filter((c) => c.arcade === openStand);
    const place = standPlacement(display.width, display.height);
    standPanel = { x: place.x - FRAME * place.k, y: place.y - FRAME * place.k, w: place.w + 2 * FRAME * place.k, h: place.h + 2 * FRAME * place.k };
    // Drawn as you would see it from your pews: see closeUpMirrored.
    const mirrored = closeUpMirrored(standFacesLeft(cam, openStand));
    const mx = mouse ? mirrorX((mouse.x - place.x) / place.k, mirrored) : -1;
    const my = mouse ? (mouse.y - place.y) / place.k : -1;
    const over = onStand.find((c) => {
      const [hx, hy, hw, hh] = slotHit(c as StandCandle);
      return mx >= hx && mx <= hx + hw && my >= hy && my <= hy + hh;
    });
    dctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
    dctx.fillRect(0, 0, display.width, display.height);
    dctx.imageSmoothingEnabled = false;
    const standImage = renderStand(onStand, t, over?.slot, standSeed(openStand, 'left'));
    if (mirrored) {
      dctx.save();
      dctx.translate(place.x + place.w, place.y);
      dctx.scale(-1, 1);
      dctx.drawImage(standImage, 0, 0, place.w, place.h);
      dctx.restore();
    } else {
      dctx.drawImage(standImage, place.x, place.y, place.w, place.h);
    }
    const fk = FRAME * place.k;
    dctx.drawImage(renderFrame(), place.x - fk, place.y - fk, place.w + 2 * fk, place.h + 2 * fk);
    const burning = onStand.filter((c) => c.litAt <= t).length;
    const count = onStand.length === 0 ? 'No candles burn here yet.' : `${burning} candle${burning === 1 ? '' : 's'} burning`;
    nameTag(dctx, display.width / 2, place.y - fk - textPx * 0.5, `The votive stand · ${count}`, textPx, 'own', t);
    nameTag(dctx, display.width / 2, place.y + place.h + fk + textPx * 1.4, 'click outside, or press Esc, to return to the nave', Math.round(textPx * 0.8), 'plain', t);
    if (over && mouse) {
      const lit = over.litAt <= t;
      const hours = Math.max(0, Math.round((over.expiresAt - t) / 3_600_000));
      const left = Math.round(100 * Math.max(0, Math.min(1, (over.expiresAt - t) / (over.expiresAt - over.litAt))));
      hoverText(dctx, mouse.x, mouse.y, over.row.label, lit ? `A ${over.size}, ${left}% left: about ${hours} more hour${hours === 1 ? '' : 's'}.` : 'Being lit…', '', Math.round(textPx * 0.8));
    }
    display.style.cursor = 'default';
  }

  // --- the key: friends in the cathedral with you --------------------------------------
  const keyEntries: KeyEntry[] = priests
    .filter((p) => p.label && p.row.priestId !== ownId)
    .map((p) => ({ id: p.row.priestId, name: p.label!, leaving: p.row.state.tag === 'Departing', marked: marked.has(p.row.priestId) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // (Once you have left, or are leaving, you are no longer among them: no key. Nor behind the close-up.)
  if (spectator || ending || openStand !== undefined || own?.state.tag === 'Departing') {
    keyPanel = undefined;
    keyRows = [];
  } else {
    const drawnKey = drawKey(dctx, keyEntries, Math.round(textPx * 0.85), keyHover);
    keyPanel = drawnKey.panel;
    keyRows = drawnKey.rows;
  }

  // --- status and closing ---------------------------------------------------------------
  if (phase === 'reconnecting' && disconnectedAt !== undefined) {
    if (Date.now() - disconnectedAt > RETRY_FOR_MS) closeWith(DISMISSAL, 'The connection to the cathedral was lost.');
    nameTag(dctx, display.width / 2, display.height - textPx, 'reconnecting…', textPx, 'plain', t);
  }
  // The title over the cathedral as you arrive: five seconds, then it fades.
  introAt ??= Date.now();
  const sinceIntro = Date.now() - introAt;
  if (!spectator && !ending && sinceIntro < INTRO_HOLD_MS + INTRO_FADE_MS) {
    titleOver(dctx, Math.min(1, 1 - (sinceIntro - INTRO_HOLD_MS) / INTRO_FADE_MS), TITLE, MOTTO, Date.now());
  }
  // And the dismissal as you leave, over the cathedral, which carries on behind it.
  if (ending) {
    const a = Math.min(1, (Date.now() - closingSince) / 2000);
    titleOver(dctx, a, closingTitle, closingSubtitle, Date.now());
    if (a >= 1 && phase === 'closing') {
      phase = 'closed';
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
  if (openStand !== undefined) {
    const inside = mouse && standPanel && mouse.x >= standPanel.x && mouse.x <= standPanel.x + standPanel.w && mouse.y >= standPanel.y && mouse.y <= standPanel.y + standPanel.h;
    if (!inside) openStand = undefined;
    return;
  }
  if (hovered?.kind === 'stand') {
    openStand = hovered.id;
    return;
  }
  if (hovered?.kind === 'candle') {
    const id = hovered.id;
    const c = conn?.db.candle.candleId.find(id);
    if (c) openStand = c.arcade;
    return;
  }
  if (keyHover !== undefined) {
    if (marked.has(keyHover)) marked.delete(keyHover);
    else marked.add(keyHover);
    return;
  }
  if (hovered?.kind !== 'priest' || hovered.id === ownId) return;
  if (muted.has(hovered.id)) muted.delete(hovered.id);
  else muted.add(hovered.id);
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') openStand = undefined;
});

setUpNotices();
const showLanding = setUpLanding(GATE_URL);
setUpMusic();
void start();
requestAnimationFrame(frame);
