import { StoreError, type AccountInput, type Store, type TierName } from '../src/store.js';
import type { GitHubApi, GitHubUser } from '../src/oauth/github.js';

export interface FakeSession {
  sessionId: string;
  priestId: bigint;
  ghHash: string;
  budget: number;
  spent: number;
  live: boolean;
  tier: TierName;
  prayers: { text: string; tokens: number; tier: TierName }[];
}

/** In-memory stand-in for the SpacetimeDB module (enough for gate logic tests). */
export class FakeStore implements Store {
  accounts = new Map<string, AccountInput & { labelMode: 'Username' | 'FullName' }>();
  sessions = new Map<string, FakeSession>();
  priests = new Map<bigint, { x: number; departing: boolean }>();
  departs: string[] = [];
  heartbeats: { sessionId: string; cancelAt?: Date }[] = [];
  forgotten: string[] = [];
  ready = true;
  failNext?: string;
  private gone: ((id: bigint) => void)[] = [];
  private nextX = 8;

  private maybeFail() {
    if (this.failNext) {
      const c = this.failNext;
      this.failNext = undefined;
      throw new StoreError(c);
    }
  }

  isReady() {
    return this.ready;
  }
  onPriestGone(cb: (id: bigint) => void) {
    this.gone.push(cb);
  }
  emitGone(id: bigint) {
    for (const cb of this.gone) cb(id);
  }

  async upsertAccount(a: AccountInput) {
    this.maybeFail();
    const prev = this.accounts.get(a.ghHash);
    if (!prev && !a.labelMode) throw new StoreError('consent_required');
    this.accounts.set(a.ghHash, { ...a, labelMode: a.labelMode ?? prev!.labelMode });
  }
  /** Grant → when it was revoked (seconds). */
  revoked = new Map<string, number>();
  async touchAccount(ghHash: string, grant: string, issuedAtS: number) {
    this.maybeFail();
    if (!this.accounts.has(ghHash)) throw new StoreError('no_account');
    const at = this.revoked.get(grant);
    if (at !== undefined && issuedAtS <= at) throw new StoreError('revoked');
  }
  async revokeGrant(_ghHash: string, grant: string) {
    this.maybeFail();
    this.revoked.set(grant, Math.floor(Date.now() / 1000));
  }
  async enter(a: { sessionId: string; priestId: bigint; ghHash: string; budget: number; tier: TierName }) {
    this.maybeFail();
    if (!this.accounts.has(a.ghHash)) throw new StoreError('no_account');
    for (const s of this.sessions.values()) {
      if (s.ghHash === a.ghHash && s.live) await this.depart(s.sessionId);
    }
    this.sessions.set(a.sessionId, { ...a, spent: 0, live: true, prayers: [] });
    this.priests.set(a.priestId, { x: this.nextX++, departing: false });
  }
  async postPrayer(a: { sessionId: string; text: string; tokens: number; tier: TierName }) {
    this.maybeFail();
    const s = this.sessions.get(a.sessionId);
    if (!s) throw new StoreError('no_session');
    if (!s.live) throw new StoreError('not_live');
    s.spent += a.tokens;
    s.tier = a.tier;
    s.prayers.push({ text: a.text, tokens: a.tokens, tier: a.tier });
  }
  async heartbeat(sessionId: string, cancelAt?: Date) {
    this.heartbeats.push({ sessionId, cancelAt });
  }
  async depart(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (s?.live) {
      s.live = false;
      this.departs.push(sessionId);
      const p = this.priests.get(s.priestId);
      if (p) p.departing = true;
    }
  }
  async forget(ghHash: string) {
    this.forgotten.push(ghHash);
    for (const s of this.sessions.values()) if (s.ghHash === ghHash) s.live = false;
    this.accounts.delete(ghHash);
  }
  async priestX(priestId: bigint) {
    return this.priests.get(priestId)?.x;
  }
  live(): FakeSession[] {
    return [...this.sessions.values()].filter((s) => s.live);
  }
}

export interface FakeGitHubUser extends GitHubUser {
  following: number[];
  followers: number[];
}

/** GitHub stand-in: codes map to users; records revoked tokens. */
export class FakeGitHub implements GitHubApi {
  users = new Map<string, FakeGitHubUser>();
  revoked: string[] = [];
  authorizeUrl(state: string, redirectUri: string) {
    const u = new URL('https://github.test/login/oauth/authorize');
    u.searchParams.set('state', state);
    u.searchParams.set('redirect_uri', redirectUri);
    return u.href;
  }
  async exchangeCode(code: string) {
    if (!this.users.has(code)) throw new Error('bad code');
    return `tok-${code}`;
  }
  private userFor(token: string) {
    const u = this.users.get(token.replace(/^tok-/, ''));
    if (!u) throw new Error('bad token');
    return u;
  }
  async user(token: string) {
    const u = this.userFor(token);
    return { id: u.id, login: u.login, name: u.name, created_at: u.created_at };
  }
  async followIds(token: string, kind: 'following' | 'followers') {
    return this.userFor(token)[kind];
  }
  async revoke(token: string) {
    this.revoked.push(token);
  }
}

export const LATIN_PRAYER =
  'Omnipotens sempiterne Deus, qui animas fidelium tuorum misericorditer respicis, ' +
  'exaudi preces nostras pro anima famuli tui, et concede ei lucem perpetuam et requiem aeternam. ' +
  'Per Dominum nostrum Iesum Christum Filium tuum. Amen.';

export const LATIN_PRAYERS = [
  LATIN_PRAYER,
  'Deus, cuius misericordiae non est numerus, suscipe propitius preces humilitatis nostrae, et animae pro qua oramus lucis et pacis tribue sedem. Amen.',
  'Kyrie, eleison. Christe, eleison. Sancta Maria, ora pro ea. Omnes sancti Angeli, orate pro ea. Ut animam eius in pace suscipias, te rogamus, audi nos.',
  'Domine, exaudi orationem meam, et clamor meus ad te veniat. Requiem aeternam dona ei, Domine, et lux perpetua luceat ei. Requiescat in pace. Amen.',
];
