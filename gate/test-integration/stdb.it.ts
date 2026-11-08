// Integration test against a real SpacetimeDB (local `spacetime start`).
//
//   spacetime start --in-memory --data-dir "$(mktemp -d)" --listen-addr 127.0.0.1:3077
//   INDULGENCE_ISSUER=http://localhost:8787 INDULGENCE_AUDIENCE=indulgence-it \
//     spacetime publish indulgence-it --server <local> --module-path module --yes
//   STDB_URI=ws://127.0.0.1:3077 STDB_MODULE=indulgence-it npm run test:stdb
//
// The gate serves its OIDC discovery on :8787 so SpacetimeDB can verify gate and viewer
// JWTs. Owner-only checks use `spacetime sql` (the CLI must be logged in as the owner).

import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { Keys } from '../src/keys.js';
import { StdbStore } from '../src/stdb.js';
import { DeferredStore } from '../src/deferred-store.js';
import { SessionManager } from '../src/sessions.js';
import { GateOAuthProvider } from '../src/oauth/provider.js';
import { createApp } from '../src/server.js';
import type { GateConfig } from '../src/config.js';
import { DbConnection, tables } from '../src/module_bindings/index.js';
import { FakeGitHub, LATIN_PRAYERS } from '../test/fakes.js';
import { C, seatPos } from '../../shared/constants.js';

const URI = process.env.STDB_URI ?? 'ws://127.0.0.1:3077';
const MODULE = process.env.STDB_MODULE ?? 'indulgence-it';
const SERVER = process.env.STDB_SERVER ?? 'local3077';
const ISSUER = 'http://localhost:8787';

const cfg: GateConfig = {
  publicUrl: ISSUER,
  siteUrl: 'http://localhost:5173',
  port: 8787,
  host: '127.0.0.1',
  spacetimedbUri: URI,
  spacetimedbModule: MODULE,
  spacetimedbAudience: MODULE,
  githubClientId: 'x',
  githubClientSecret: 'x',
  edgeHmacKey: 'integration-test-key-0123456789abcdef',
  // Persisted so reruns reuse the key: SpacetimeDB caches the issuer's JWKS for ~5 minutes.
  devKeyFile: process.env.IT_KEY_FILE ?? '.it-signing-key.pem',
  signingKid: 'it-1',
  trustProxy: 0,
  devSkipAgeCheck: true,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function sql(q: string): string {
  return execFileSync('spacetime', ['sql', MODULE, q, '--server', SERVER], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
let step = 0;
function ok(msg: string) {
  console.log(`  ✓ ${++step}. ${msg}`);
}

const keys = await Keys.create(cfg);
// HTTP first: SpacetimeDB fetches our OIDC config to validate the gate's own token.
const deferred = new DeferredStore();
const sessions = new SessionManager(deferred, cfg.siteUrl);
const oauth = new GateOAuthProvider({ keys, store: deferred, github: new FakeGitHub(), publicUrl: ISSUER });
const server = http.createServer(createApp({ cfg, keys, oauth, sessions, isStoreReady: () => deferred.isReady() }).app);
await new Promise<void>((r) => server.listen(8787, '127.0.0.1', r));
// Retry like the gate does: after a key change SpacetimeDB may serve a cached JWKS for up to
// ~5 minutes, until its next background refresh reaches our discovery endpoint.
let store: StdbStore | undefined;
for (let attempt = 1; !store; attempt++) {
  try {
    store = await StdbStore.connect(cfg, keys);
  } catch (e) {
    if (attempt > 40) throw e;
    if (attempt === 1) console.log('  … waiting for SpacetimeDB to refresh the gate JWKS');
    await sleep(10_000);
  }
}
deferred.attach(store);
ok('gate connected with its own OIDC-issued JWT and subscribed to priests');

// --- accounts -----------------------------------------------------------------
const users = {
  alice: { id: 1001, login: 'alice', name: 'Alice Liddell' },
  bob: { id: 1002, login: 'bob', name: '' },
  carol: { id: 1003, login: 'carol', name: '' },
};
const acct = (u: { id: number }) => ({ ghHash: keys.ghHash(u.id), viewerSub: keys.viewerSub(u.id) });

await assert.rejects(
  store.upsertAccount({ viewerSub: acct(users.alice).viewerSub, ghHash: acct(users.alice).ghHash, ghLogin: 'alice', ghName: 'Alice Liddell', mutualHashes: [] }),
  /consent_required/,
);
ok('new account without a name choice fails with consent_required');

// Only alice asserts the mutual edge; mutual(u, v) holds if either side asserted it.
await store.upsertAccount({ ...acct(users.alice), ghLogin: 'alice', ghName: 'Alice Liddell', labelMode: 'FullName', mutualHashes: [keys.ghHash(users.bob.id)] });
await store.upsertAccount({ ...acct(users.bob), ghLogin: 'bob', ghName: '', labelMode: 'Username', mutualHashes: [] });
await store.upsertAccount({ ...acct(users.carol), ghLogin: 'carol', ghName: '', labelMode: 'Username', mutualHashes: [] });
ok('accounts created after consent');

// --- seating ----------------------------------------------------------------------
const begin = async (u: typeof users.alice, budget = 20000) => {
  const r = await sessions.begin(acct(u), { intention: `pro anima ${u.login}`, budget_tokens: budget }, { mode: 'pray', mcpSessionId: `mcp-${u.login}` });
  assert.ok('session_id' in r, `begin failed: ${JSON.stringify(r)}`);
  return r;
};
// Strangers first, so the bay is not empty.
const strangers = [];
for (let i = 0; i < 6; i++) {
  const u = { id: 2000 + i, login: `stranger${i}`, name: '' };
  await store.upsertAccount({ ...acct(u), ghLogin: u.login, ghName: '', labelMode: 'Username', mutualHashes: [] });
  strangers.push(await begin(u, 1000 + i * 1000));
}
const a = await begin(users.alice);
const b = await begin(users.bob);
const c = await begin(users.carol);

const priestOf = async (r: { url: string }) => {
  const info = await sessions.redeemTicket(r.url.split('#t=')[1]);
  assert.ok(info);
  return info;
};
const ai = await priestOf(a);
const bi = await priestOf(b);
const ci = await priestOf(c);

// --- viewers ------------------------------------------------------------------------
type Viewer = { conn: DbConnection; info: { priestId: bigint; px: number; viewerSub: string } };
async function viewer(info: { priestId: bigint; px: number; viewerSub: string }, overrides: Record<string, unknown> = {}, aud = MODULE, signer = keys): Promise<Viewer> {
  const token = await signer.sign({ tt: 'viewer', role: 'viewer', px: info.px, pid: info.priestId.toString(), ...overrides } as never, {
    aud,
    sub: info.viewerSub,
    ttlSeconds: 3600,
  });
  return new Promise((resolve, reject) => {
    const conn = DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(MODULE)
      .withToken(token)
      .onConnectError((_ctx, e) => reject(e))
      .onDisconnect((_ctx, e) => reject(e ?? new Error('disconnected')))
      .build();
    const lo = info.px - C.VIEW_HALF_WIDTH;
    const hi = info.px + C.VIEW_HALF_WIDTH;
    conn
      .subscriptionBuilder()
      .onApplied(() => resolve({ conn, info }))
      .onError((ctx) => reject(ctx.event ?? new Error('subscription error')))
      .subscribe([
        `SELECT * FROM priest WHERE x >= ${lo} AND x < ${hi}`,
        `SELECT * FROM prayer_tick WHERE x >= ${lo} AND x < ${hi}`,
        `SELECT * FROM candle WHERE x >= ${lo} AND x < ${hi}`,
        'SELECT * FROM viewer_label',
        'SELECT * FROM prayer_text',
      ]);
  });
}

const va = await viewer(ai);
const vb = await viewer(bi);
const vc = await viewer(ci);
ok('viewers connected with gate-issued view-only JWTs');

const row = (v: Viewer, id: bigint) => v.conn.db.priest.priestId.find(id)!;
const pa = row(va, ai.priestId);
const pb = row(va, bi.priestId);
assert.equal(pa.bay, pb.bay, 'mutuals share a bay');
const dist = Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y);
assert.ok(dist <= 2, `mutuals sit together (distance ${dist})`);
assert.deepEqual([pa.x, pa.y], seatPos(pa.bay, pa.row, pa.half, pa.seat));
ok(`two mutuals joining one after the other share bay ${pa.bay}, ${dist} tile(s) apart`);

assert.equal(pa.vestment.tag, 'Priest'); // 20,000 budget
assert.equal(row(va, ai.priestId).state.tag, 'Entering');
ok('vestment follows the pledged budget (20,000 → Priest)');

const labels = (v: Viewer) =>
  [...v.conn.db.viewerLabel.iter()].map((l) => `${l.priestId === ai.priestId ? 'A' : l.priestId === bi.priestId ? 'B' : l.priestId === ci.priestId ? 'C' : '?'}:${l.label}`).sort();
assert.deepEqual(labels(va), ['A:Alice Liddell', 'B:bob']);
assert.deepEqual(labels(vb), ['A:Alice Liddell', 'B:bob']);
assert.deepEqual(labels(vc), ['C:carol']);
ok('viewer_label view: each viewer sees only their own and their live mutuals\' names');

// --- authorisation -------------------------------------------------------------------
await assert.rejects(va.conn.reducers.depart({ sessionId: b.session_id }), /unauthorized/);
await assert.rejects(
  va.conn.reducers.upsertAccount({ viewerSub: 'x', ghHash: 'f'.repeat(32), ghLogin: 'mallory', ghName: '', labelMode: { tag: 'Username' }, mutualHashes: [] }),
  /unauthorized/,
);
ok('a viewer JWT cannot call reducers');

await assert.rejects(viewer(ai, {}, 'some-other-audience'));
await assert.rejects(viewer(ai, { role: 'gate' }));
const impostor = await Keys.create({ ...cfg, devKeyFile: undefined, signingKid: 'it-1' });
await assert.rejects(viewer(ai, {}, MODULE, impostor));
ok('tokens with the wrong audience, a forged role, or a signature from another key are refused at connect');

// --- prayers -----------------------------------------------------------------------------
await store.postPrayer({ sessionId: a.session_id, text: LATIN_PRAYERS[0]!, tokens: 70, tier: 'Subagent' });
await store.postPrayer({ sessionId: c.session_id, text: LATIN_PRAYERS[1]!, tokens: 50, tier: 'Subagent' });
await sleep(300);
const texts = (v: Viewer) => [...v.conn.db.prayerText.iter()].map((t) => (t.priestId === ai.priestId ? 'A' : t.priestId === ci.priestId ? 'C' : '?')).sort();
assert.deepEqual(texts(va), ['A']);
assert.deepEqual(texts(vb), ['A']);
assert.deepEqual(texts(vc), ['C']);
assert.equal(row(vb, ai.priestId).state.tag, 'Praying');
const tick = vc.conn.db.prayerTick.priestId.find(ai.priestId);
assert.ok(tick && tick.seq === 1, 'strangers get a prayer_tick (canned prayer index) for A');
ok('prayer_text view: owner and mutuals read subagent prayers; strangers only get a tick');

await store.postPrayer({ sessionId: a.session_id, text: LATIN_PRAYERS[2]!, tokens: 60, tier: 'InSession' });
await sleep(300);
assert.equal([...va.conn.db.prayerText.iter()].filter((t) => t.priestId === ai.priestId).length, 2);
assert.equal([...vb.conn.db.prayerText.iter()].filter((t) => t.priestId === ai.priestId).length, 1);
ok('in-session prayers are shown only to their owner');

for (let i = 0; i < 4; i++) await store.postPrayer({ sessionId: a.session_id, text: LATIN_PRAYERS[i % 4]!, tokens: 60, tier: 'Subagent' });
await sleep(300);
assert.equal([...vb.conn.db.prayerText.iter()].filter((t) => t.priestId === ai.priestId).length, 3);
ok('prayer_text keeps the last 3 per (viewer, priest)');

// --- takeover -------------------------------------------------------------------------------
const c2 = await begin(users.carol, 60000);
const c2i = await priestOf(c2);
await sleep(300);
assert.equal(row(vc, ci.priestId).state.tag, 'Departing');
assert.equal(row(vc, c2i.priestId).vestment.tag, 'Bishop');
ok('a second begin takes over: the old priest departs, the new one is a bishop (60,000)');

// --- depart and candles ---------------------------------------------------------------------
await sessions.depart(acct(users.alice), { session_id: a.session_id });
await sleep(400);
const departing = row(vb, ai.priestId);
assert.equal(departing.state.tag, 'Departing');
const candle = vb.conn.db.candle.candleId.find(departing.candleId);
assert.ok(candle, 'candle visible');
assert.equal(candle.label, 'Alice Liddell');
assert.equal(candle.arcade, departing.half === 0 ? departing.bay : departing.bay + 1);
const litDelay = Number(candle.litAt.microsSinceUnixEpoch - departing.stateSince.microsSinceUnixEpoch) / 1000;
assert.equal(litDelay, C.CANDLE_LIT_AFTER_MS);
const burnH = Number(candle.expiresAt.microsSinceUnixEpoch - candle.litAt.microsSinceUnixEpoch) / 3.6e9;
assert.equal(candle.size.tag, 'Taper');
assert.equal(burnH, 24);
assert.deepEqual(labels(vb), ['B:bob']);
assert.deepEqual(texts(vb), []);
ok(`depart: candle "${candle.label}" on arcade ${candle.arcade} slot ${candle.slot}, lit +${litDelay / 1000} s, burns ${burnH} h; A's labels and texts removed`);

// --- forget ------------------------------------------------------------------------------------
const before = sql(`SELECT * FROM account WHERE gh_hash = '${keys.ghHash(users.alice.id)}'`);
assert.match(before, /alice/);
assert.equal((await sessions.forget(acct(users.alice))).hasOwnProperty('ok'), true);
await sleep(300);
const h = keys.ghHash(users.alice.id);
for (const q of [
  `SELECT * FROM account WHERE gh_hash = '${h}'`,
  `SELECT * FROM follow_edge WHERE owner_hash = '${h}'`,
  `SELECT * FROM follow_edge WHERE other_hash = '${h}'`,
  `SELECT * FROM session WHERE session_id = '${a.session_id}'`,
  `SELECT * FROM candle WHERE label = 'Alice Liddell'`,
]) {
  const out = sql(q);
  assert.ok(!/alice|Alice|[0-9a-f]{32}/.test(out.split('\n').slice(2).join('\n')), `forget left rows: ${q}\n${out}`);
}
assert.ok(!vb.conn.db.candle.candleId.find(departing.candleId));
ok('forget deletes the account, follow edges (both directions), sessions and candles');

// --- removal after the departure animation --------------------------------------------------------
console.log(`  … waiting ${C.PRIEST_REMOVE_AFTER_MS / 1000}s for remove_priest`);
await sleep(C.PRIEST_REMOVE_AFTER_MS + 1500);
assert.ok(!vb.conn.db.priest.priestId.find(ai.priestId));
assert.ok(!vb.conn.db.prayerTick.priestId.find(ai.priestId));
ok(`remove_priest deletes the priest and prayer_tick rows ${C.PRIEST_REMOVE_AFTER_MS / 1000} s after departure`);

await sessions.shutdown();
await sleep(300);
assert.equal([...vb.conn.db.priest.iter()].filter((p) => p.state.tag !== 'Departing').length, 0);
ok('gate shutdown departs every live priest');

for (const v of [va, vb, vc]) v.conn.disconnect();
store.disconnect();
server.close();
console.log(`\nAll ${step} integration checks passed against ${URI}/${MODULE}.`);
process.exit(0);
