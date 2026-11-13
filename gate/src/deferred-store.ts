// SpacetimeDB validates the gate's JWT by fetching the gate's own OIDC discovery document,
// so the HTTP server must be listening before the gate can connect. This wrapper lets the
// rest of the gate start first and reports `unavailable` until the connection is up.

import { StoreError, type AccountInput, type Store, type TierName } from './store.js';

export class DeferredStore implements Store {
  private inner?: Store;
  private listeners: ((priestId: bigint) => void)[] = [];

  attach(store: Store) {
    this.inner = store;
    for (const cb of this.listeners) store.onPriestGone(cb);
  }

  private get s(): Store {
    if (!this.inner) throw new StoreError('unavailable');
    return this.inner;
  }

  isReady() {
    return this.inner?.isReady() ?? false;
  }
  onPriestGone(cb: (priestId: bigint) => void) {
    this.listeners.push(cb);
    this.inner?.onPriestGone(cb);
  }
  async upsertAccount(a: AccountInput) {
    return this.s.upsertAccount(a);
  }
  async touchAccount(ghHash: string, grant: string, issuedAtS: number) {
    return this.s.touchAccount(ghHash, grant, issuedAtS);
  }
  async revokeGrant(ghHash: string, grant: string) {
    return this.s.revokeGrant(ghHash, grant);
  }
  async enter(a: { sessionId: string; priestId: bigint; ghHash: string; budget: number; tier: TierName; share: boolean }) {
    return this.s.enter(a);
  }
  async postPrayer(a: { sessionId: string; text: string; tokens: number; tier: TierName }) {
    return this.s.postPrayer(a);
  }
  async heartbeat(sessionId: string, cancelAt?: Date) {
    return this.s.heartbeat(sessionId, cancelAt);
  }
  async depart(sessionId: string) {
    return this.s.depart(sessionId);
  }
  async forget(ghHash: string) {
    return this.s.forget(ghHash);
  }
  async priestX(priestId: bigint, timeoutMs: number) {
    return this.inner ? this.inner.priestX(priestId, timeoutMs) : undefined;
  }
}
