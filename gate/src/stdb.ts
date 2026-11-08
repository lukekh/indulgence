// SpacetimeDB-backed Store. The gate connects with its own JWT (role "gate"); the module
// registers that identity in `gate_service` on connect, which authorises reducer calls.

import { SenderError, Timestamp } from 'spacetimedb';
import { DbConnection, tables } from './module_bindings/index.js';
import type { GateConfig } from './config.js';
import type { Keys } from './keys.js';
import { StoreError, type AccountInput, type Store, type TierName } from './store.js';

export class StdbStore implements Store {
  private ready = false;
  private goneListeners: ((priestId: bigint) => void)[] = [];
  private waiters = new Map<bigint, ((x: number) => void)[]>();

  private constructor(private readonly conn: DbConnection) {
    conn.db.priest.onInsert((_ctx, row) => {
      const ws = this.waiters.get(row.priestId);
      if (ws) {
        this.waiters.delete(row.priestId);
        for (const w of ws) w(row.x);
      }
    });
    conn.db.priest.onUpdate((_ctx, oldRow, row) => {
      if (row.state.tag === 'Departing' && oldRow.state.tag !== 'Departing') this.emitGone(row.priestId);
    });
    conn.db.priest.onDelete((_ctx, row) => this.emitGone(row.priestId));
  }

  static connect(cfg: GateConfig, keys: Keys): Promise<StdbStore> {
    return new Promise((resolve, reject) => {
      let store: StdbStore | undefined;
      let settled = false;
      void keys.gateToken(cfg.spacetimedbAudience).then((token) => {
        const conn = DbConnection.builder()
          .withUri(cfg.spacetimedbUri)
          .withDatabaseName(cfg.spacetimedbModule)
          .withToken(token)
          .withTokenProvider(() => keys.gateToken(cfg.spacetimedbAudience))
          .withAutomaticReconnect({ minDelayMs: 1000, maxDelayMs: 15000 })
          .onConnect(() => console.log('[stdb] connected'))
          .onDisconnect((_ctx, err, next) => {
            if (store) store.ready = false;
            console.warn(`[stdb] disconnected${next !== undefined ? `; retry ${next}` : ''}`, err?.message ?? '');
          })
          .onConnectError((_ctx, err) => {
            console.error('[stdb] connect error:', err.message);
            if (!settled) {
              settled = true;
              reject(err);
            }
          })
          .build();
        store = new StdbStore(conn);
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            store!.ready = true;
            if (!settled) {
              settled = true;
              resolve(store!);
            }
          })
          .onError((ctx) => console.error('[stdb] subscription error:', ctx.event?.message ?? 'unknown'))
          .subscribe([tables.priest]);
      }, reject);
    });
  }

  isReady(): boolean {
    return this.ready;
  }

  onPriestGone(cb: (priestId: bigint) => void): void {
    this.goneListeners.push(cb);
  }

  private emitGone(priestId: bigint) {
    for (const cb of this.goneListeners) cb(priestId);
  }

  private async call(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      if (e instanceof SenderError) throw new StoreError(e.message);
      throw new StoreError('unavailable');
    }
  }

  upsertAccount(a: AccountInput) {
    return this.call(() =>
      this.conn.reducers.upsertAccount({
        viewerSub: a.viewerSub,
        ghHash: a.ghHash,
        ghLogin: a.ghLogin,
        ghName: a.ghName,
        labelMode: a.labelMode ? { tag: a.labelMode } : undefined,
        mutualHashes: a.mutualHashes,
      }),
    );
  }

  touchAccount(ghHash: string) {
    return this.call(() => this.conn.reducers.touchAccount({ ghHash }));
  }

  enter(a: { sessionId: string; priestId: bigint; ghHash: string; budget: number; tier: TierName }) {
    return this.call(() =>
      this.conn.reducers.enter({
        sessionId: a.sessionId,
        priestId: a.priestId,
        ghHash: a.ghHash,
        budget: BigInt(a.budget),
        tier: { tag: a.tier },
      }),
    );
  }

  postPrayer(a: { sessionId: string; text: string; tokens: number; tier: TierName }) {
    return this.call(() =>
      this.conn.reducers.postPrayer({ sessionId: a.sessionId, text: a.text, tokens: BigInt(a.tokens), tier: { tag: a.tier } }),
    );
  }

  heartbeat(sessionId: string, cancelAt?: Date) {
    return this.call(() =>
      this.conn.reducers.heartbeat({
        sessionId,
        cancelAt: cancelAt ? Timestamp.fromDate(cancelAt) : undefined,
      }),
    );
  }

  depart(sessionId: string) {
    return this.call(() => this.conn.reducers.depart({ sessionId }));
  }

  forget(ghHash: string) {
    return this.call(() => this.conn.reducers.forget({ ghHash }));
  }

  priestX(priestId: bigint, timeoutMs: number): Promise<number | undefined> {
    const row = this.conn.db.priest.priestId.find(priestId);
    if (row) return Promise.resolve(row.x);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const list = this.waiters.get(priestId)?.filter((w) => w !== done);
        if (list?.length) this.waiters.set(priestId, list);
        else this.waiters.delete(priestId);
        resolve(this.conn.db.priest.priestId.find(priestId)?.x);
      }, timeoutMs);
      const done = (x: number) => {
        clearTimeout(timer);
        resolve(x);
      };
      this.waiters.set(priestId, [...(this.waiters.get(priestId) ?? []), done]);
    });
  }

  disconnect() {
    this.conn.disconnect();
  }
}
