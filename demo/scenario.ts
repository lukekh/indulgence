// The demo cathedral: the real gate (HTTP app, sessions, safety filters) on a real
// SpacetimeDB, with GitHub replaced by a fake and Claude Code replaced by direct calls into
// the gate's MCP tool handler (`callTool`), so tool results are the real templates.
//
// Cast: you, three mutual friends praying, two mutual friends who already left votive
// candles burning, and a congregation of strangers.

import http from 'node:http';
import { Keys } from '../gate/src/keys.js';
import { StdbStore } from '../gate/src/stdb.js';
import { DeferredStore } from '../gate/src/deferred-store.js';
import { SessionManager } from '../gate/src/sessions.js';
import { GateOAuthProvider } from '../gate/src/oauth/provider.js';
import { createApp } from '../gate/src/server.js';
import { callTool } from '../gate/src/mcp.js';
import type { GateConfig } from '../gate/src/config.js';
import { DbConnection, tables } from '../gate/src/module_bindings/index.js';
import { FakeGitHub, LATIN_PRAYERS } from '../gate/test/fakes.js';
import { C } from '../shared/constants.js';

export interface CathedralOptions {
  gatePort: number;
  siteUrl: string;
  stdbUri: string;
  module: string;
  youLogin: string;
  strangers: number;
  log?: (line: string) => void;
}

export interface Layout {
  own: { x: number; y: number };
  friends: Record<string, { x: number; y: number }>;
  candles: Record<string, { arcade: number; slot: number; size: string }>;
}

const PRAYERS = [
  ...LATIN_PRAYERS,
  'Sancte Michael Archangele, defende nos in proelio, contra nequitiam et insidias diaboli esto praesidium.',
  'Benedicat tibi Dominus et custodiat te. Ostendat Dominus faciem suam tibi et misereatur tui.',
  'Ad te levavi animam meam, Deus meus, in te confido, non erubescam. Exaudi nos, Domine.',
  'Te Deum laudamus, te Dominum confitemur. Te aeternum Patrem omnis terra veneratur.',
];
const YOUR_PRAYERS = [
  'Deus, qui omnia animalia creasti, suscipe animam famuli tui parvi, qui nobis fidelis fuit et dulcis. Da ei requiem in hortis tuis, ubi sol semper lucet. Per Christum Dominum nostrum. Amen.',
  'Pro anima eius rogamus te, Domine: exaudi nos. Ut lucem perpetuam ei concedas: te rogamus, audi nos. Ut in pace requiescat: te rogamus, audi nos.',
];

const LIVE_FRIENDS = [
  { id: 2, name: 'Hildegard', budget: 60_000 },
  { id: 3, name: 'Anselm', budget: 25_000 },
  { id: 4, name: 'Scholastica', budget: 8_000 },
];
/** Spend between 10,000 and 49,999 prayer tokens lights a votive. */
const CANDLE_FRIENDS = [
  { id: 5, name: 'Bede', spent: 14_000 },
  { id: 6, name: 'Clare', spent: 31_000 },
];
const YOU = 1;
const STRANGER_BUDGETS = [3000, 8000, 12_000, 30_000, 60_000, 250_000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startCathedral(o: CathedralOptions) {
  const log = o.log ?? (() => {});
  const cfg: GateConfig = {
    publicUrl: `http://localhost:${o.gatePort}`,
    siteUrl: o.siteUrl,
    port: o.gatePort,
    host: '127.0.0.1',
    spacetimedbUri: o.stdbUri,
    spacetimedbModule: o.module,
    spacetimedbAudience: o.module,
    githubClientId: 'demo',
    githubClientSecret: 'demo',
    edgeHmacKey: 'demo-only-hmac-key-0123456789abcdef',
    signingKid: 'demo-1',
    trustProxy: 0,
    devSkipAgeCheck: true,
    allowedRedirectOrigins: [],
  };
  const keys = await Keys.create(cfg); // ephemeral: each run uses a fresh SpacetimeDB
  const store = new DeferredStore();
  const sessions = new SessionManager(store, o.siteUrl);
  const oauth = new GateOAuthProvider({ keys, store, github: new FakeGitHub(), publicUrl: cfg.publicUrl });
  const server = http.createServer(createApp({ cfg, keys, oauth, sessions, isStoreReady: () => store.isReady() }).app);
  await new Promise<void>((r) => server.listen(o.gatePort, '127.0.0.1', r));
  log(`gate listening on ${cfg.publicUrl}`);

  let stdb: StdbStore | undefined;
  for (let attempt = 1; !stdb; attempt++) {
    try {
      stdb = await StdbStore.connect(cfg, keys);
    } catch (e) {
      if (attempt > 30) throw e;
      await sleep(1000);
    }
  }
  store.attach(stdb);

  const acct = (id: number) => ({ ghHash: keys.ghHash(id), viewerSub: keys.viewerSub(id) });
  const friendIds = [...LIVE_FRIENDS, ...CANDLE_FRIENDS].map((f) => f.id);
  const liveIds = LIVE_FRIENDS.map((f) => f.id);

  // Accounts. You are mutuals with all five friends; the three live friends with each other.
  await store.upsertAccount({ ...acct(YOU), ghLogin: o.youLogin, ghName: '', labelMode: 'Username', mutualHashes: friendIds.map((id) => keys.ghHash(id)) });
  for (const f of [...LIVE_FRIENDS, ...CANDLE_FRIENDS]) {
    const mutuals = [YOU, ...(liveIds.includes(f.id) ? liveIds.filter((x) => x !== f.id) : [])];
    await store.upsertAccount({ ...acct(f.id), ghLogin: f.name.toLowerCase(), ghName: f.name, labelMode: 'FullName', mutualHashes: mutuals.map((id) => keys.ghHash(id)) });
  }
  for (let i = 0; i < o.strangers; i++) {
    await store.upsertAccount({ ...acct(100 + i), ghLogin: `pilgrim${i}`, ghName: '', labelMode: 'Username', mutualHashes: [] });
  }

  const live: { id: number; sessionId: string; tier: 'subagent' | 'in_session' }[] = [];
  const begin = async (id: number, budget: number) => {
    const r = await sessions.begin(acct(id), { intention: 'pro anima', budget_tokens: budget }, { mode: 'pray', mcpSessionId: `demo-${id}` });
    if (!('session_id' in r)) throw new Error(`begin failed for ${id}: ${JSON.stringify(r)}`);
    return r.session_id;
  };

  // Two friends came earlier, prayed for a while and left votives.
  for (const f of CANDLE_FRIENDS) {
    const sid = await begin(f.id, 20_000);
    for (let k = 0; k < 3; k++) await store.postPrayer({ sessionId: sid, text: PRAYERS[k]!, tokens: Math.ceil(f.spent / 3), tier: 'Subagent' });
    await sessions.depart(acct(f.id), { session_id: sid });
  }
  const candlesLitAt = Date.now();
  log('two friends lit votives');

  for (let i = 0; i < o.strangers; i++) {
    live.push({ id: 100 + i, sessionId: await begin(100 + i, STRANGER_BUDGETS[i % STRANGER_BUDGETS.length]!), tier: 'in_session' });
  }
  for (const f of LIVE_FRIENDS) live.push({ id: f.id, sessionId: await begin(f.id, f.budget), tier: 'subagent' });
  log(`${LIVE_FRIENDS.length} friends and ${o.strangers} strangers seated`);

  // Everyone prays on their own rhythm; MCP activity keeps them from being reaped.
  let stopped = false;
  const keepalive = setInterval(() => {
    for (const s of live) sessions.touchMcp(`demo-${s.id}`);
    void sessions.tick();
  }, 5000);
  let n = 0;
  const prayLoop = (s: (typeof live)[number], delay: number) => {
    const go = async () => {
      if (stopped) return;
      const text = PRAYERS[n++ % PRAYERS.length]!;
      const r = await sessions.pray(acct(s.id), { session_id: s.sessionId, text, tier: s.tier }, { signal: new AbortController().signal });
      if (!stopped && 'done' in r && !r.done) setTimeout(() => void go(), 1500 + Math.random() * 3000);
    };
    setTimeout(() => void go(), delay);
  };
  for (const s of live) prayLoop(s, Math.random() * 12_000);

  // The votive-lighters walk out slowly; the camera should arrive after they have gone.
  const readyAt = candlesLitAt + C.PRIEST_REMOVE_AFTER_MS + 2000;

  // ---- you, through the gate's MCP tool handler -------------------------------------------
  const you = acct(YOU);
  const signal = () => new AbortController().signal;
  let yourSession = '';

  return {
    sessions,
    /** When the two friends who lit votives have left the building (ms). */
    readyAt,
    /** `begin` as Claude Code would call it. Returns the real tool result text and fields. */
    async begin(intention: string, budget: number) {
      const res = await callTool(sessions, 'begin', { intention, budget_tokens: budget }, { account: you, signal: signal(), mcpSessionId: `demo-${YOU}` });
      const sc = res.structuredContent as { session_id: string; url: string; mode: string; budget_tokens: number };
      yourSession = sc.session_id;
      live.push({ id: YOU, sessionId: sc.session_id, tier: 'subagent' });
      return { text: (res.content[0] as { text: string }).text, ...sc };
    },
    /** One `pray` call as the priest subagent would make it. */
    async pray(i: number) {
      const text = YOUR_PRAYERS[i % YOUR_PRAYERS.length]!;
      const res = await callTool(sessions, 'pray', { session_id: yourSession, text, tier: 'subagent' }, { account: you, signal: signal() });
      return { ...(res.structuredContent as { done: boolean; accepted: boolean; left: number }), text };
    },
    async depart() {
      live.splice(live.findIndex((s) => s.id === YOU), 1);
      await callTool(sessions, 'depart', { session_id: yourSession }, { account: you, signal: signal() });
    },
    /** Where things are, read as your viewer would see them (for aiming the mouse). */
    async layout(): Promise<Layout> {
      const token = await keys.sign({ tt: 'viewer', role: 'viewer' }, { aud: o.module, sub: you.viewerSub, ttlSeconds: 600 });
      const conn = await new Promise<DbConnection>((resolve, reject) => {
        const c = DbConnection.builder()
          .withUri(o.stdbUri)
          .withDatabaseName(o.module)
          .withToken(token)
          .onConnectError((_ctx, e) => reject(e))
          .build();
        c.subscriptionBuilder()
          .onApplied(() => resolve(c))
          .subscribe([tables.priest, tables.candle, tables.viewerLabel]);
      });
      const out: Layout = { own: { x: 0, y: 0 }, friends: {}, candles: {} };
      for (const l of conn.db.viewerLabel.iter()) {
        const p = conn.db.priest.priestId.find(l.priestId);
        if (!p) continue;
        if (l.label === o.youLogin) out.own = { x: p.x, y: p.y };
        else out.friends[l.label] = { x: p.x, y: p.y };
      }
      for (const c of conn.db.candle.iter()) out.candles[c.label] = { arcade: c.arcade, slot: c.slot, size: c.size.tag.toLowerCase() };
      conn.disconnect();
      return out;
    },
    async stop() {
      stopped = true;
      clearInterval(keepalive);
      await Promise.race([sessions.shutdown(), sleep(5000)]);
      stdb?.disconnect();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

export type Cathedral = Awaited<ReturnType<typeof startCathedral>>;
