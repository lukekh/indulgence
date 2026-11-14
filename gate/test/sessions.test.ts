import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { C } from '../../shared/constants.js';
import { SessionManager, DELETION_TTL_MS, type BeginResult, type PrayResult, type VigilResult, type Sampler } from '../src/sessions.js';
import { FakeStore, LATIN_PRAYERS, LATIN_PRAYER } from './fakes.js';

const alice = { ghHash: 'a'.repeat(32), viewerSub: 'v.alice' };
const bob = { ghHash: 'b'.repeat(32), viewerSub: 'v.bob' };

function setup() {
  const store = new FakeStore();
  for (const a of [alice, bob]) {
    store.accounts.set(a.ghHash, { ...a, ghLogin: 'x', ghName: '', mutualHashes: [], labelMode: 'Username' });
  }
  const sessions = new SessionManager(store, 'https://site.test');
  return { store, sessions };
}

const signal = () => new AbortController().signal;

async function begin(sessions: SessionManager, who = alice, extra: Record<string, unknown> = {}, mode: 'pray' | 'sampling' = 'pray') {
  const r = await sessions.begin(who, { intention: 'for the soul of my cat', ...extra }, { mode, mcpSessionId: 'mcp-1' });
  if ('error' in r) throw new Error(r.error);
  return r as BeginResult;
}

/** Run a promise to completion while advancing fake time. */
async function settle<T>(p: Promise<T>, ms = 60_000): Promise<T> {
  let done = false;
  let value!: T;
  void p.then((v) => {
    done = true;
    value = v;
  });
  for (let t = 0; t < ms && !done; t += 250) await vi.advanceTimersByTimeAsync(250);
  if (!done) throw new Error('did not settle');
  return value;
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
afterEach(() => vi.useRealTimers());

describe('begin', () => {
  it('creates a session, seats a priest and returns a ticket URL', async () => {
    const { store, sessions } = setup();
    const r = await begin(sessions);
    expect(r.mode).toBe('pray');
    expect(r.budget_tokens).toBe(C.BUDGET_DEFAULT);
    expect(r.url).toMatch(/^https:\/\/site\.test\/#t=[A-Za-z0-9_-]{22}$/);
    expect(store.live()).toHaveLength(1);
    expect(store.live()[0]!.tier).toBe('Pending');
  });

  it('shares prayers with mutuals by default, and opts out only on request', async () => {
    const { store, sessions } = setup();
    const r = await begin(sessions);
    expect(r.share_prayers).toBe(true);
    expect(store.live()[0]!.share).toBe(true);
    const off = await begin(sessions, alice, { share_prayers: false });
    expect(off.share_prayers).toBe(false);
    expect(store.live().at(-1)!.share).toBe(false);
    expect((await begin(sessions, alice, { share_prayers: true })).share_prayers).toBe(true);
    expect((await begin(sessions, alice, { share_prayers: null })).share_prayers).toBe(true);
    for (const bad of ['no', 0, 1, 'false', {}]) {
      expect(await sessions.begin(alice, { intention: 'cat', share_prayers: bad }, { mode: 'pray' })).toEqual({ error: 'bad_args' });
    }
  });

  it('clamps budgets and rejects bad intentions', async () => {
    const { sessions } = setup();
    expect((await begin(sessions, alice, { budget_tokens: 5 })).budget_tokens).toBe(C.BUDGET_MIN);
    expect((await begin(sessions, alice, { budget_tokens: 5e9 })).budget_tokens).toBe(C.BUDGET_MAX);
    expect(await sessions.begin(alice, { intention: 'x'.repeat(C.INTENTION_MAX_CHARS + 1) }, { mode: 'pray' })).toEqual({ error: 'invalid_intention' });
    expect(await sessions.begin(alice, { intention: 'cat', budget_tokens: 'lots' }, { mode: 'pray' })).toEqual({ error: 'bad_args' });
  });

  it('rate-limits begin to 10 per hour per account', async () => {
    const { sessions } = setup();
    for (let i = 0; i < C.BEGIN_PER_HOUR; i++) await begin(sessions);
    expect(await sessions.begin(alice, { intention: 'cat' }, { mode: 'pray' })).toEqual({ error: 'rate_limited' });
    expect('session_id' in (await sessions.begin(bob, { intention: 'cat' }, { mode: 'pray' }))).toBe(true);
    vi.advanceTimersByTime(3_600_001);
    expect('session_id' in (await sessions.begin(alice, { intention: 'cat' }, { mode: 'pray' }))).toBe(true);
  });

  it('takes over: a second begin departs the first priest', async () => {
    const { store, sessions } = setup();
    const first = await begin(sessions);
    const second = await begin(sessions);
    expect(store.departs).toEqual([first.session_id]);
    expect(store.live().map((s) => s.sessionId)).toEqual([second.session_id]);
    const r = (await sessions.pray(alice, { session_id: first.session_id, text: LATIN_PRAYER, tier: 'subagent' }, { signal: signal() })) as PrayResult;
    expect(r).toEqual({ done: true, accepted: false, left: C.BUDGET_DEFAULT });
  });

  it('reports the store errors it knows', async () => {
    const { store, sessions } = setup();
    store.failNext = 'full';
    expect(await sessions.begin(alice, { intention: 'cat' }, { mode: 'pray' })).toEqual({ error: 'full' });
    store.ready = false;
    expect(await sessions.begin(alice, { intention: 'cat' }, { mode: 'pray' })).toEqual({ error: 'unavailable' });
  });
});

describe('pray', () => {
  it('accepts, debits ceil(chars / 3), and holds the response for the pacing slot', async () => {
    const { store, sessions } = setup();
    const { session_id } = await begin(sessions);
    const start = Date.now();
    const r = (await settle(sessions.pray(alice, { session_id, text: LATIN_PRAYER, tier: 'subagent' }, { signal: signal() }))) as PrayResult;
    const tokens = Math.ceil(LATIN_PRAYER.length / 3);
    expect(r).toEqual({ done: false, accepted: true, left: C.BUDGET_DEFAULT - tokens });
    expect(Date.now() - start).toBeGreaterThanOrEqual(C.PACING_SLOT_MS);
    expect(store.live()[0]!.prayers).toEqual([{ text: LATIN_PRAYER, tokens, tier: 'Subagent' }]);
  });

  it('never accepts two prayers within 20 seconds, even in parallel', async () => {
    const { store, sessions } = setup();
    const { session_id } = await begin(sessions);
    const accepted: number[] = [];
    const orig = store.postPrayer.bind(store);
    store.postPrayer = async (a) => {
      accepted.push(Date.now());
      return orig(a);
    };
    const calls = LATIN_PRAYERS.slice(0, 3).map((text) => sessions.pray(alice, { session_id, text, tier: 'subagent' }, { signal: signal() }));
    await settle(Promise.all(calls), 120_000);
    expect(accepted).toHaveLength(3);
    expect(accepted[1]! - accepted[0]!).toBeGreaterThanOrEqual(C.PACING_SLOT_MS);
    expect(accepted[2]! - accepted[1]!).toBeGreaterThanOrEqual(C.PACING_SLOT_MS);
  });

  it('does not debit rejected prayers and reports no reason', async () => {
    const { store, sessions } = setup();
    const { session_id } = await begin(sessions);
    const r = await settle(sessions.pray(alice, { session_id, text: 'See src/index.ts for details', tier: 'subagent' }, { signal: signal() }));
    expect(r).toEqual({ done: false, accepted: false, left: C.BUDGET_DEFAULT });
    expect(store.live()[0]!.spent).toBe(0);
  });

  it('ends the session after 10 consecutive rejections', async () => {
    const { store, sessions } = setup();
    const { session_id } = await begin(sessions);
    let last: PrayResult | undefined;
    for (let i = 0; i < C.MAX_CONSECUTIVE_REJECTS; i++) {
      last = (await settle(sessions.pray(alice, { session_id, text: 'not latin at all, sorry', tier: 'in_session' }, { signal: signal() }))) as PrayResult;
    }
    expect(last!.done).toBe(true);
    expect(store.departs).toEqual([session_id]);
  });

  it('returns done and departs once the budget is spent', async () => {
    const { store, sessions } = setup();
    const { session_id } = await begin(sessions, alice, { budget_tokens: C.BUDGET_MIN });
    let r: PrayResult | undefined;
    let n = 0;
    do {
      r = (await settle(sessions.pray(alice, { session_id, text: LATIN_PRAYERS[n++ % 4], tier: 'subagent' }, { signal: signal() }))) as PrayResult;
    } while (!r.done && n < 50);
    expect(r.done).toBe(true);
    expect(r.left).toBe(0);
    expect(store.departs).toEqual([session_id]);
    const after = await sessions.pray(alice, { session_id, text: LATIN_PRAYER, tier: 'subagent' }, { signal: signal() });
    expect(after).toEqual({ done: true, accepted: false, left: 0 });
  });

  it('rejects sessions owned by someone else as if unknown', async () => {
    const { sessions } = setup();
    const { session_id } = await begin(sessions);
    expect(await sessions.pray(bob, { session_id, text: LATIN_PRAYER, tier: 'subagent' }, { signal: signal() })).toEqual({
      done: true,
      accepted: false,
      left: 0,
    });
    expect(await sessions.pray(alice, { session_id, text: LATIN_PRAYER, tier: 'admin' }, { signal: signal() })).toEqual({ error: 'bad_args' });
  });

  it('marks the session ended when the module departs the priest (takeover elsewhere, reaper)', async () => {
    const { store, sessions } = setup();
    const { session_id } = await begin(sessions);
    store.emitGone(store.live()[0]!.priestId);
    expect(await sessions.pray(alice, { session_id, text: LATIN_PRAYER, tier: 'subagent' }, { signal: signal() })).toMatchObject({ done: true });
  });
});

describe('disconnects', () => {
  it('departs 90 s after a cancelled call unless another pray arrives', async () => {
    const { store, sessions } = setup();
    const { session_id } = await begin(sessions);
    const ac = new AbortController();
    const p = sessions.pray(alice, { session_id, text: LATIN_PRAYER, tier: 'subagent' }, { signal: ac.signal });
    await vi.advanceTimersByTimeAsync(1000);
    ac.abort();
    await settle(p);
    expect(store.heartbeats.some((h) => h.cancelAt)).toBe(true);
    await vi.advanceTimersByTimeAsync(C.CANCEL_GRACE_MS - 5000);
    expect(store.departs).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.departs).toEqual([session_id]);
  });

  it('a pray call inside the grace period keeps the priest', async () => {
    const { store, sessions } = setup();
    const { session_id } = await begin(sessions);
    const ac = new AbortController();
    const p = sessions.pray(alice, { session_id, text: LATIN_PRAYER, tier: 'subagent' }, { signal: ac.signal });
    await vi.advanceTimersByTimeAsync(1000);
    ac.abort();
    await settle(p);
    await vi.advanceTimersByTimeAsync(30_000);
    await settle(sessions.pray(alice, { session_id, text: LATIN_PRAYERS[1], tier: 'subagent' }, { signal: signal() }));
    await vi.advanceTimersByTimeAsync(C.CANCEL_GRACE_MS);
    expect(store.departs).toEqual([]);
  });

  it('departs after 180 s of silence', async () => {
    const { store, sessions } = setup();
    const { session_id } = await begin(sessions);
    await vi.advanceTimersByTimeAsync(C.SILENCE_DEPART_MS - 1000);
    await sessions.tick();
    expect(store.departs).toEqual([]);
    sessions.touchMcp('mcp-1');
    await vi.advanceTimersByTimeAsync(C.SILENCE_DEPART_MS - 1000);
    await sessions.tick();
    expect(store.departs).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    await sessions.tick();
    expect(store.departs).toEqual([session_id]);
  });

  it('departs at once on a clean MCP shutdown', async () => {
    const { store, sessions } = setup();
    const { session_id } = await begin(sessions);
    await sessions.onMcpClosed('mcp-1');
    expect(store.departs).toEqual([session_id]);
  });

  it('heartbeats live sessions so the module reaper leaves them alone', async () => {
    const { store, sessions } = setup();
    await begin(sessions);
    sessions.touchMcp('mcp-1');
    await vi.advanceTimersByTimeAsync(61_000);
    sessions.touchMcp('mcp-1');
    await sessions.tick();
    expect(store.heartbeats).toHaveLength(1);
  });
});

describe('vigil (sampling)', () => {
  it('samples one prayer per slot with includeContext none semantics, until the budget is spent', async () => {
    const { store, sessions } = setup();
    const { session_id } = await begin(sessions, alice, { budget_tokens: C.BUDGET_MIN }, 'sampling');
    const prompts: string[] = [];
    let i = 0;
    const sampler: Sampler = async (system, user) => {
      prompts.push(user);
      expect(system).toContain('medieval Latin liturgy');
      return LATIN_PRAYERS[i++ % 4]!;
    };
    const progress: number[] = [];
    // The command calls vigil again until done (each call lasts at most 5 minutes).
    let r: VigilResult;
    let calls = 0;
    let total = 0;
    do {
      r = (await settle(sessions.vigil(alice, { session_id }, { signal: signal(), sampler, progress: (n) => progress.push(n) }), 400_000)) as VigilResult;
      total += r.prayers;
      calls++;
    } while (!r.done && calls < 5);
    expect(r.done).toBe(true);
    expect(calls).toBe(2);
    expect(r.mode).toBe('sampling');
    expect(total).toBeGreaterThan(10);
    expect(i).toBe(total); // one sampling request per accepted prayer: none wasted
    expect(prompts[0]).toBe('Intentio: for the soul of my cat');
    expect(store.live()).toHaveLength(0);
    expect(store.sessions.get(session_id)!.prayers.every((p) => p.tier === 'Sampling')).toBe(true);
    expect(progress.at(-1)).toBe(r.prayers);
  });

  it('falls back to pray mode after 3 failed sampling requests', async () => {
    const { sessions } = setup();
    const { session_id } = await begin(sessions, alice, {}, 'sampling');
    const sampler: Sampler = async () => {
      throw new Error('user declined');
    };
    const r = (await settle(sessions.vigil(alice, { session_id }, { signal: signal(), sampler }))) as VigilResult;
    expect(r).toMatchObject({ done: false, mode: 'pray', prayers: 0 });
  });

  it('returns at most 5 minutes after it starts', async () => {
    const { sessions } = setup();
    const { session_id } = await begin(sessions, alice, { budget_tokens: C.BUDGET_MAX }, 'sampling');
    const sampler: Sampler = async () => LATIN_PRAYER;
    const start = Date.now();
    const r = (await settle(sessions.vigil(alice, { session_id }, { signal: signal(), sampler }), 400_000)) as VigilResult;
    expect(r.done).toBe(false);
    expect(Date.now() - start).toBeLessThanOrEqual(C.VIGIL_MAX_MS + C.PACING_SLOT_MS);
  });
});

describe('viewer tickets', () => {
  it('can be used again and again while the priest is in the cathedral', async () => {
    const { sessions } = setup();
    const r1 = await begin(sessions);
    const t1 = r1.url.split('#t=')[1];
    const first = await sessions.redeemTicket(t1);
    expect(first).toMatchObject({ viewerSub: alice.viewerSub, sessionId: r1.session_id });
    expect(await sessions.redeemTicket(t1)).toEqual(first);
    // Time alone does not wear it out.
    vi.advanceTimersByTime(60 * 60_000);
    expect(await sessions.redeemTicket(t1)).toEqual(first);
    expect(await sessions.redeemTicket('not-a-ticket-at-all-xx')).toBeUndefined();
  });

  it('still works while the priest walks out, and stops once it has gone', async () => {
    const { sessions } = setup();
    const r = await begin(sessions);
    const t = r.url.split('#t=')[1];
    await sessions.depart(alice, { session_id: r.session_id });
    expect(await sessions.redeemTicket(t)).toMatchObject({ sessionId: r.session_id });
    vi.advanceTimersByTime(C.PRIEST_REMOVE_AFTER_MS - 1000);
    expect(await sessions.redeemTicket(t)).toMatchObject({ sessionId: r.session_id });
    vi.advanceTimersByTime(2000);
    expect(await sessions.redeemTicket(t)).toBeUndefined();
  });

  it("an earlier priest's link stops when a new session takes over and the old priest has gone", async () => {
    const { sessions } = setup();
    const old = (await begin(sessions)).url.split('#t=')[1];
    await begin(sessions);
    vi.advanceTimersByTime(C.PRIEST_REMOVE_AFTER_MS + 1);
    expect(await sessions.redeemTicket(old)).toBeUndefined();
  });

  it('refresh works only while the session is live', async () => {
    const { store, sessions } = setup();
    const r = await begin(sessions);
    const pid = store.live()[0]!.priestId;
    expect(await sessions.viewerInfoForPriest(alice.viewerSub, pid)).toBeDefined();
    await sessions.depart(alice, { session_id: r.session_id });
    expect(await sessions.viewerInfoForPriest(alice.viewerSub, pid)).toBeUndefined();
  });
});

describe('deleting an account', () => {
  it('needs the link to be confirmed, which works once and for ten minutes', async () => {
    const { store, sessions } = setup();
    sessions.gateUrl = 'https://gate.test';
    const { url } = sessions.requestDeletion(alice);
    const t = new URL(url).searchParams.get('t')!;
    expect(url.startsWith('https://gate.test/delete-account?t=')).toBe(true);
    expect(sessions.deletionPending(t)).toBe(true);
    expect(sessions.deletionPending('nope')).toBe(false);
    expect(await sessions.confirmDeletion('nope')).toEqual({ error: 'invalid_link' });
    expect(store.forgotten).toEqual([]);
    vi.advanceTimersByTime(DELETION_TTL_MS + 1);
    expect(await sessions.confirmDeletion(t)).toEqual({ error: 'invalid_link' });
    expect(store.forgotten).toEqual([]);

    const again = new URL(sessions.requestDeletion(alice).url).searchParams.get('t')!;
    expect(await sessions.confirmDeletion(again)).toEqual({ ok: true });
    expect(store.forgotten).toEqual([alice.ghHash]);
    expect(await sessions.confirmDeletion(again)).toEqual({ error: 'invalid_link' });
  });

  it('ends the live session without a candle and deletes the account', async () => {
    const { store, sessions } = setup();
    const forgotten: string[] = [];
    sessions.onForgotten = (h) => forgotten.push(h);
    const { session_id } = await begin(sessions);
    expect(await sessions.forget(alice.ghHash)).toEqual({ ok: true });
    expect(store.departs).toEqual([]); // module's forget departs without lighting a candle
    expect(store.forgotten).toEqual([alice.ghHash]);
    expect(forgotten).toEqual([alice.ghHash]);
    expect(await sessions.pray(alice, { session_id, text: LATIN_PRAYER, tier: 'subagent' }, { signal: signal() })).toMatchObject({ done: true });
  });
});
