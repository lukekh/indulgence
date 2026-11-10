// The gate's view of SpacetimeDB: reducer calls plus the public `priest` table.
// `StdbStore` (stdb.ts) is the real implementation; tests use an in-memory fake.

export type TierName = 'Pending' | 'Sampling' | 'Subagent' | 'InSession';
export type LabelModeName = 'Username' | 'FullName';

/** A reducer returned Err(code). Codes are short identifiers set by the module. */
export class StoreError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface AccountInput {
  viewerSub: string;
  ghHash: string;
  ghLogin: string;
  ghName: string;
  /** undefined keeps the stored choice; a new account then fails with `consent_required`. */
  labelMode?: LabelModeName;
  mutualHashes: string[];
}

export interface Store {
  upsertAccount(a: AccountInput): Promise<void>;
  /**
   * On every token refresh: fails with `no_account` once the account is deleted, or
   * `revoked` if the grant (`grant`, see GateOAuthProvider.grantKey) was revoked after the
   * refresh token was issued (`issuedAtS`, seconds).
   */
  touchAccount(ghHash: string, grant: string, issuedAtS: number): Promise<void>;
  /** Revoke a grant: its refresh tokens issued until now stop working. */
  revokeGrant(ghHash: string, grant: string): Promise<void>;
  enter(a: { sessionId: string; priestId: bigint; ghHash: string; budget: number; tier: TierName; share: boolean }): Promise<void>;
  postPrayer(a: { sessionId: string; text: string; tokens: number; tier: TierName }): Promise<void>;
  heartbeat(sessionId: string, cancelAt?: Date): Promise<void>;
  depart(sessionId: string): Promise<void>;
  forget(ghHash: string): Promise<void>;
  /** Resolves with the priest's x once its row is visible, or undefined on timeout. */
  priestX(priestId: bigint, timeoutMs: number): Promise<number | undefined>;
  /** Called when a priest row starts departing or is deleted (takeover, reaper). */
  onPriestGone(cb: (priestId: bigint) => void): void;
  isReady(): boolean;
}
