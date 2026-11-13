// Live /indulgence sessions: budgets, pacing, prayer checks, disconnect detection.
//
// Everything that reaches a model from here is numbers, ids or the viewer URL. Prayer
// text and intentions stay in this process (intentions are dropped when a session ends)
// or go to SpacetimeDB; reasons for rejection are logged as counters only.

import { randomBytes } from 'node:crypto';
import { C, prayerTokens } from '../../shared/constants.js';
import { checkIntention, checkPrayer, type RejectReason } from './safety/index.js';
import { StoreError, type Store, type TierName } from './store.js';
import { randomId } from './keys.js';

export type Mode = 'sampling' | 'pray';

export interface Account {
  ghHash: string;
  viewerSub: string;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** Produces one prayer through MCP sampling. Throws if refused or failed. */
export type Sampler = (systemPrompt: string, userText: string, opts: { signal: AbortSignal; timeoutMs: number }) => Promise<string>;

export type ErrorCode =
  | 'bad_args'
  | 'invalid_intention'
  | 'rate_limited'
  | 'full'
  | 'unavailable'
  | 'no_account';

export interface BeginResult {
  session_id: string;
  url: string;
  mode: Mode;
  budget_tokens: number;
  /** Whether mutuals can read this session's prayers (the default); false if the user opted out. */
  share_prayers: boolean;
}
export interface PrayResult {
  done: boolean;
  accepted: boolean;
  left: number;
}
export interface VigilResult {
  done: boolean;
  mode: Mode;
  prayers: number;
  spent: number;
  left: number;
}

/** The fixed priest persona, shared by sampling requests and the plugin's subagent. */
export const PRIEST_SYSTEM_PROMPT = [
  'You are a priest in a medieval cathedral.',
  'Compose one prayer in the style of medieval Latin liturgy (a collect, a litany, or versicles and responses) for the soul named in the intention.',
  'Use only the intention. Mention no code, files, projects, tools, people or places from anywhere else.',
  `Write Latin only, at most ${C.PRAYER_MAX_WORDS} words.`,
  'Use only letters, spaces, commas, full stops, colons, question marks and exclamation marks. No digits, brackets, semicolons or other symbols.',
  'Reply with the prayer and nothing else.',
].join('\n');

const SLOT = C.PACING_SLOT_MS;
const REJECT_HOLD_MS = 3000;
const SAMPLING_RETRY_MS = 2000;
const HEARTBEAT_EVERY_MS = 60_000;
const ENDED_RETAIN_MS = 10 * 60_000;
const TICKET_TTL_MS = 10 * 60_000;
/** How long a link that confirms an account's deletion stays good. */
export const DELETION_TTL_MS = 10 * 60_000;
const MAX_QUEUED_CALLS = 3;

interface LiveSession {
  id: string;
  priestId: bigint;
  ghHash: string;
  viewerSub: string;
  mcpSessionId?: string;
  intention: string;
  budget: number;
  spent: number;
  prayers: number;
  mode: Mode;
  px?: number;
  lastAcceptAt: number;
  lastSeen: number;
  lastHeartbeat: number;
  lastCallAt: number;
  inflight: number;
  rejects: number;
  cancelAt?: number;
  cancelTimer?: unknown;
  lock: Promise<void>;
  queued: number;
  ended: boolean;
  endedAt?: number;
}

interface Ticket {
  sessionId: string;
  expires: number;
}

export interface ViewerInfo {
  viewerSub: string;
  priestId: bigint;
  px: number;
  sessionId: string;
}

export class SessionManager {
  private sessions = new Map<string, LiveSession>();
  private liveByAccount = new Map<string, string>();
  private beginTimes = new Map<string, number[]>();
  private tickets = new Map<string, Ticket>();
  readonly rejectCounts = new Map<RejectReason, number>();
  /** Called after an account is deleted (the OAuth layer then refuses its old tokens). */
  onForgotten?: (ghHash: string) => void;
  /** One-time links that confirm an account's deletion, by their token. */
  private deletions = new Map<string, { ghHash: string; expires: number }>();
  /** The gate's own public address, where the confirmation page lives. */
  gateUrl = '';

  constructor(
    private readonly store: Store,
    private readonly siteUrl: string,
    private readonly clock: Clock = realClock,
  ) {
    store.onPriestGone((priestId) => {
      for (const s of this.sessions.values()) {
        if (s.priestId === priestId && !s.ended) this.markEnded(s);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  async begin(
    account: Account,
    args: { intention?: unknown; budget_tokens?: unknown; share_prayers?: unknown },
    ctx: { mode: Mode; mcpSessionId?: string },
  ): Promise<BeginResult | { error: ErrorCode }> {
    const intention = checkIntention(args.intention);
    if (!intention.ok) return { error: 'invalid_intention' };

    let budget: number = C.BUDGET_DEFAULT;
    if (args.budget_tokens !== undefined && args.budget_tokens !== null) {
      if (typeof args.budget_tokens !== 'number' || !Number.isFinite(args.budget_tokens)) return { error: 'bad_args' };
      budget = Math.min(C.BUDGET_MAX, Math.max(C.BUDGET_MIN, Math.round(args.budget_tokens)));
    }

    // Sharing is the default; false opts out, and anything else is refused.
    if (args.share_prayers !== undefined && args.share_prayers !== null && typeof args.share_prayers !== 'boolean') return { error: 'bad_args' };
    const share = args.share_prayers !== false;

    const now = this.clock.now();
    const recent = (this.beginTimes.get(account.ghHash) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= C.BEGIN_PER_HOUR) return { error: 'rate_limited' };
    if (this.liveCount() >= C.MAX_LIVE_SESSIONS) return { error: 'full' };
    if (!this.store.isReady()) return { error: 'unavailable' };

    // Takeover: one live priest per account. The old one departs and lights its candle.
    const previous = this.liveByAccount.get(account.ghHash);
    if (previous) {
      const old = this.sessions.get(previous);
      if (old) await this.end(old);
    }

    const sessionId = randomId(18);
    const priestId = randomPriestId();
    try {
      await this.store.enter({
        sessionId,
        priestId,
        ghHash: account.ghHash,
        budget,
        tier: ctx.mode === 'sampling' ? 'Sampling' : 'Pending',
        share,
      });
    } catch (e) {
      const code = e instanceof StoreError ? e.code : 'unavailable';
      if (code === 'no_account') return { error: 'no_account' };
      if (code === 'full') return { error: 'full' };
      return { error: 'unavailable' };
    }
    recent.push(now);
    this.beginTimes.set(account.ghHash, recent);

    const s: LiveSession = {
      id: sessionId,
      priestId,
      ghHash: account.ghHash,
      viewerSub: account.viewerSub,
      mcpSessionId: ctx.mcpSessionId,
      intention: intention.text,
      budget,
      spent: 0,
      prayers: 0,
      mode: ctx.mode,
      lastAcceptAt: 0,
      lastSeen: now,
      lastHeartbeat: now,
      lastCallAt: now,
      inflight: 0,
      rejects: 0,
      lock: Promise.resolve(),
      queued: 0,
      ended: false,
    };
    this.sessions.set(sessionId, s);
    this.liveByAccount.set(account.ghHash, sessionId);
    s.px = await this.store.priestX(priestId, 5000);

    const ticket = this.issueTicket(sessionId);
    return { session_id: sessionId, url: `${this.siteUrl}/#t=${ticket}`, mode: ctx.mode, budget_tokens: budget, share_prayers: share };
  }

  async pray(
    account: Account,
    args: { session_id?: unknown; text?: unknown; tier?: unknown },
    ctx: { signal: AbortSignal },
  ): Promise<PrayResult | { error: ErrorCode }> {
    if (args.tier !== 'subagent' && args.tier !== 'in_session') return { error: 'bad_args' };
    const tier: TierName = args.tier === 'subagent' ? 'Subagent' : 'InSession';
    const s = this.find(account, args.session_id);
    if (!s || s.ended) return { done: true, accepted: false, left: s ? left(s) : 0 };

    return this.track(s, ctx.signal, async () => {
      const r = await this.withLock(s, async (): Promise<PrayResult> => {
        if (s.ended) return { done: true, accepted: false, left: left(s) };
        await this.sleepUntil(s.lastAcceptAt + SLOT, ctx.signal);
        if (ctx.signal.aborted || s.ended) return { done: s.ended, accepted: false, left: left(s) };

        const verdict = checkPrayer(args.text);
        if (!verdict.ok) {
          await this.reject(s, verdict.reason);
          if (!s.ended) await this.sleepUntil(this.clock.now() + REJECT_HOLD_MS, ctx.signal);
          return { done: s.ended, accepted: false, left: left(s) };
        }
        if (!(await this.accept(s, verdict.text, tier))) return { done: s.ended, accepted: false, left: left(s) };
        const done = s.spent >= s.budget;
        await this.sleepUntil(s.lastAcceptAt + SLOT, ctx.signal);
        if (done) await this.end(s);
        return { done, accepted: true, left: left(s) };
      });
      return r ?? { done: false, accepted: false, left: left(s) };
    });
  }

  async vigil(
    account: Account,
    args: { session_id?: unknown },
    ctx: { signal: AbortSignal; sampler?: Sampler; progress?: (n: number) => void },
  ): Promise<VigilResult | { error: ErrorCode }> {
    const s = this.find(account, args.session_id);
    if (!s) return { done: true, mode: 'pray', prayers: 0, spent: 0, left: 0 };
    const summary = (prayers: number): VigilResult => ({ done: s.ended, mode: s.mode, prayers, spent: s.spent, left: left(s) });
    if (s.ended) return summary(0);
    if (s.mode !== 'sampling' || !ctx.sampler) {
      s.mode = 'pray';
      return summary(0);
    }
    const sampler = ctx.sampler;

    return this.track(s, ctx.signal, async () => {
      const r = await this.withLock(s, async () => {
        const deadline = this.clock.now() + C.VIGIL_MAX_MS;
        let accepted = 0;
        let failures = 0;
        while (!s.ended && !ctx.signal.aborted) {
          const remaining = deadline - this.clock.now();
          if (remaining < 2000) break;
          let text: string;
          try {
            // Sampled during the current slot; accepted when it ends.
            text = await sampler(PRIEST_SYSTEM_PROMPT, `Intentio: ${s.intention}`, {
              signal: ctx.signal,
              timeoutMs: Math.min(remaining, 120_000),
            });
          } catch {
            if (ctx.signal.aborted) break;
            failures++;
            if (failures >= C.VIGIL_MAX_FAILURES) {
              s.mode = 'pray';
              break;
            }
            await this.sleepUntil(this.clock.now() + SAMPLING_RETRY_MS, ctx.signal);
            continue;
          }
          failures = 0;
          await this.sleepUntil(s.lastAcceptAt + SLOT, ctx.signal);
          if (ctx.signal.aborted || s.ended) break;
          const verdict = checkPrayer(text);
          if (!verdict.ok) {
            await this.reject(s, verdict.reason);
            await this.sleepUntil(this.clock.now() + REJECT_HOLD_MS, ctx.signal);
            continue;
          }
          if (await this.accept(s, verdict.text, 'Sampling')) {
            accepted++;
            ctx.progress?.(accepted);
          }
          if (s.spent >= s.budget) {
            await this.sleepUntil(s.lastAcceptAt + SLOT, ctx.signal);
            await this.end(s);
          }
        }
        return summary(accepted);
      });
      return r ?? summary(0);
    });
  }

  async depart(account: Account, args: { session_id?: unknown }): Promise<{ ok: true }> {
    const s = this.find(account, args.session_id);
    if (s) await this.end(s);
    return { ok: true };
  }

  /**
   * The first half of deleting an account: nothing is deleted. Returns a one-time link to a
   * page on the gate where the person confirms it themselves, so that no model can delete
   * an account on its own say-so.
   */
  requestDeletion(account: Account): { url: string } {
    const now = this.clock.now();
    for (const [t, d] of this.deletions) if (d.expires < now || d.ghHash === account.ghHash) this.deletions.delete(t);
    const token = randomBytes(16).toString('base64url'); // 128-bit
    this.deletions.set(token, { ghHash: account.ghHash, expires: now + DELETION_TTL_MS });
    return { url: `${this.gateUrl}/delete-account?t=${token}` };
  }

  /** Whether a confirmation link is still good (it is not used up by asking). */
  deletionPending(token: unknown): boolean {
    const d = typeof token === 'string' ? this.deletions.get(token) : undefined;
    return !!d && d.expires >= this.clock.now();
  }

  /** The second half: the person pressed the button. The link works once. */
  async confirmDeletion(token: unknown): Promise<{ ok: true } | { error: ErrorCode | 'invalid_link' }> {
    if (!this.deletionPending(token)) return { error: 'invalid_link' };
    const { ghHash } = this.deletions.get(token as string)!;
    this.deletions.delete(token as string);
    return this.forget(ghHash);
  }

  /**
   * Delete the account: end any live session without a candle; the module deletes the rest.
   * Candles already lit are kept, and burn until they go out.
   */
  async forget(ghHash: string): Promise<{ ok: true } | { error: ErrorCode }> {
    for (const s of this.sessions.values()) {
      if (s.ghHash === ghHash) {
        this.markEnded(s);
        this.sessions.delete(s.id);
      }
    }
    this.beginTimes.delete(ghHash);
    try {
      await this.store.forget(ghHash);
    } catch {
      return { error: 'unavailable' };
    }
    this.onForgotten?.(ghHash);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Disconnect detection
  // -------------------------------------------------------------------------

  /** Any MCP request on a transport session counts as activity for its live sessions. */
  touchMcp(mcpSessionId: string) {
    const now = this.clock.now();
    for (const s of this.sessions.values()) if (s.mcpSessionId === mcpSessionId && !s.ended) s.lastSeen = now;
  }

  /** Clean shutdown (`DELETE /mcp`) or transport closed: depart at once. */
  async onMcpClosed(mcpSessionId: string) {
    const ending = [...this.sessions.values()].filter((s) => s.mcpSessionId === mcpSessionId && !s.ended);
    await Promise.all(ending.map((s) => this.end(s)));
  }

  /** Periodic: silence detection, heartbeats, cleanup. Call every few seconds. */
  async tick() {
    const now = this.clock.now();
    const work: Promise<unknown>[] = [];
    for (const s of this.sessions.values()) {
      if (s.ended) {
        if (s.endedAt !== undefined && now - s.endedAt > ENDED_RETAIN_MS) this.sessions.delete(s.id);
        continue;
      }
      if (s.inflight === 0 && now - s.lastSeen > C.SILENCE_DEPART_MS) {
        work.push(this.end(s));
        continue;
      }
      if (now - s.lastHeartbeat >= HEARTBEAT_EVERY_MS) {
        s.lastHeartbeat = now;
        work.push(this.store.heartbeat(s.id, s.cancelAt ? new Date(s.cancelAt) : undefined).catch(() => {}));
      }
    }
    for (const [t, ticket] of this.tickets) if (ticket.expires < now) this.tickets.delete(t);
    await Promise.all(work);
  }

  /** Depart every live session (graceful gate shutdown). */
  async shutdown() {
    await Promise.all([...this.sessions.values()].filter((s) => !s.ended).map((s) => this.end(s)));
  }

  liveCount(): number {
    return this.liveByAccount.size;
  }

  // -------------------------------------------------------------------------
  // Viewer tickets
  // -------------------------------------------------------------------------

  private issueTicket(sessionId: string): string {
    const t = randomBytes(16).toString('base64url'); // 128-bit
    this.tickets.set(t, { sessionId, expires: this.clock.now() + TICKET_TTL_MS });
    return t;
  }

  /** Single use: a second redemption of the same ticket fails. */
  async redeemTicket(ticket: unknown): Promise<ViewerInfo | undefined> {
    if (typeof ticket !== 'string') return undefined;
    const t = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!t || t.expires < this.clock.now()) return undefined;
    return this.viewerInfo(t.sessionId);
  }

  /** For refreshing a viewer token: the account's live session, if any. */
  async viewerInfoForPriest(viewerSub: string, priestId: bigint): Promise<ViewerInfo | undefined> {
    for (const s of this.sessions.values()) {
      if (s.viewerSub === viewerSub && s.priestId === priestId && !s.ended) return this.viewerInfo(s.id);
    }
    return undefined;
  }

  private async viewerInfo(sessionId: string): Promise<ViewerInfo | undefined> {
    const s = this.sessions.get(sessionId);
    if (!s || s.ended) return undefined;
    s.px ??= await this.store.priestX(s.priestId, 3000);
    if (s.px === undefined) return undefined;
    return { viewerSub: s.viewerSub, priestId: s.priestId, px: s.px, sessionId: s.id };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private find(account: Account, sessionId: unknown): LiveSession | undefined {
    if (typeof sessionId !== 'string') return undefined;
    const s = this.sessions.get(sessionId);
    return s && s.ghHash === account.ghHash ? s : undefined;
  }

  /** Book-keeping for a pray/vigil call: activity, cancellation grace. */
  private async track<T>(s: LiveSession, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    const now = this.clock.now();
    s.lastSeen = now;
    s.lastCallAt = now;
    if (s.cancelTimer !== undefined) {
      this.clock.clearTimeout(s.cancelTimer);
      s.cancelTimer = undefined;
    }
    if (s.cancelAt !== undefined) {
      s.cancelAt = undefined;
      void this.store.heartbeat(s.id).catch(() => {});
    }
    const onAbort = () => this.onCancelled(s);
    signal.addEventListener('abort', onAbort, { once: true });
    s.inflight++;
    try {
      return await fn();
    } finally {
      s.inflight--;
      s.lastSeen = this.clock.now();
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** `notifications/cancelled` (Esc / Ctrl+C): depart unless a pray or vigil call arrives within 90 s. */
  private onCancelled(s: LiveSession) {
    if (s.ended) return;
    const at = this.clock.now();
    s.cancelAt = at;
    void this.store.heartbeat(s.id, new Date(at)).catch(() => {});
    if (s.cancelTimer !== undefined) this.clock.clearTimeout(s.cancelTimer);
    s.cancelTimer = this.clock.setTimeout(() => {
      s.cancelTimer = undefined;
      if (!s.ended && s.lastCallAt <= at) void this.end(s);
    }, C.CANCEL_GRACE_MS);
  }

  private async withLock<T>(s: LiveSession, fn: () => Promise<T>): Promise<T | undefined> {
    if (s.queued >= MAX_QUEUED_CALLS) return undefined;
    s.queued++;
    const prev = s.lock;
    let release!: () => void;
    s.lock = new Promise<void>((r) => (release = r));
    try {
      await prev;
      return await fn();
    } finally {
      s.queued--;
      release();
    }
  }

  private async accept(s: LiveSession, text: string, tier: TierName): Promise<boolean> {
    const tokens = prayerTokens(text);
    try {
      await this.store.postPrayer({ sessionId: s.id, text, tokens, tier });
    } catch (e) {
      if (e instanceof StoreError && (e.code === 'not_live' || e.code === 'no_session')) this.markEnded(s);
      return false;
    }
    const now = this.clock.now();
    s.spent += tokens;
    s.prayers++;
    s.rejects = 0;
    s.lastAcceptAt = now;
    s.lastHeartbeat = now;
    return true;
  }

  private async reject(s: LiveSession, reason: RejectReason) {
    this.rejectCounts.set(reason, (this.rejectCounts.get(reason) ?? 0) + 1);
    s.rejects++;
    if (s.rejects >= C.MAX_CONSECUTIVE_REJECTS) await this.end(s);
  }

  private async end(s: LiveSession) {
    if (s.ended) return;
    this.markEnded(s);
    try {
      await this.store.depart(s.id);
    } catch {
      // The module's reap_stale reducer is the backstop.
    }
  }

  private markEnded(s: LiveSession) {
    if (s.ended) return;
    s.ended = true;
    s.endedAt = this.clock.now();
    s.intention = '';
    if (s.cancelTimer !== undefined) this.clock.clearTimeout(s.cancelTimer);
    s.cancelTimer = undefined;
    if (this.liveByAccount.get(s.ghHash) === s.id) this.liveByAccount.delete(s.ghHash);
  }

  /** Resolves at time `t` or as soon as `signal` aborts. Never rejects. */
  private sleepUntil(t: number, signal?: AbortSignal): Promise<void> {
    const ms = t - this.clock.now();
    if (ms <= 0 || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.clock.clearTimeout(handle);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const handle = this.clock.setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}

function left(s: LiveSession): number {
  return Math.max(0, s.budget - s.spent);
}

function randomPriestId(): bigint {
  const b = randomBytes(8);
  b[0]! &= 0x7f;
  const id = b.readBigUInt64BE();
  return id === 0n ? 1n : id;
}
