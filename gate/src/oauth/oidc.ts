// Google, Microsoft and LinkedIn: OpenID Connect sign-in with the authorization code flow.
// Only the ID token is used. It is checked against the provider's published keys, its
// audience (our client id), its issuer and a nonce derived from our signed state, so a token
// minted for another app or another sign-in is refused. No access token is kept, and no API
// is called with it.
//
// Scopes are `openid profile` only: names, never email addresses. The network comes from the
// ID token itself: Google's `hd` (the Workspace domain) and Microsoft's `tid` (the tenant).
// LinkedIn gives no network, so people who sign in with it are public instead.

import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { cleanDisplayName } from '../safety/index.js';
import type { IdentityProvider, Person, ProviderId } from './identity.js';

/** Microsoft's tenant for personal accounts: everyone in it is a stranger to everyone else. */
export const MICROSOFT_CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
/** The name shown for someone whose own cannot be used. */
export const FALLBACK_LOGIN = 'pilgrim';

export interface OidcSpec {
  id: ProviderId;
  label: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  /** Whether the token's issuer is this provider. */
  issuerOk(iss: string, claims: JWTPayload): boolean;
  /** Extra authorization parameters, such as asking which account to use. */
  extra?: Record<string, string>;
  /** Who the claims describe: the networks they are in, and whether they are public. */
  networks(claims: JWTPayload): string[];
  public: boolean;
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** The first name: `given_name`, or the first word of `name`. */
export function firstName(claims: JWTPayload): string {
  const given = str(claims.given_name)?.trim();
  if (given) return given;
  return str(claims.name)?.trim().split(/\s+/)[0] ?? '';
}

export const GOOGLE: OidcSpec = {
  id: 'google',
  label: 'Google',
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
  issuerOk: (iss) => iss === 'https://accounts.google.com' || iss === 'accounts.google.com',
  extra: { prompt: 'select_account' },
  // `hd` is there only for a Google Workspace account: a personal one has no network.
  networks: (c) => (str(c.hd) ? [`google-hd:${str(c.hd)!.toLowerCase()}`] : []),
  public: false,
};

export const MICROSOFT: OidcSpec = {
  id: 'microsoft',
  label: 'Microsoft',
  authorizationEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  jwksUri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
  // Signed per tenant: the issuer names the tenant the token says it is from.
  issuerOk: (iss, c) => typeof c.tid === 'string' && /^[0-9a-f-]{36}$/.test(c.tid) && iss === `https://login.microsoftonline.com/${c.tid}/v2.0`,
  extra: { prompt: 'select_account' },
  networks: (c) => (str(c.tid) && c.tid !== MICROSOFT_CONSUMER_TENANT ? [`entra-tid:${str(c.tid)!.toLowerCase()}`] : []),
  public: false,
};

export const LINKEDIN: OidcSpec = {
  id: 'linkedin',
  label: 'LinkedIn',
  authorizationEndpoint: 'https://www.linkedin.com/oauth/v2/authorization',
  tokenEndpoint: 'https://www.linkedin.com/oauth/v2/accessToken',
  jwksUri: 'https://www.linkedin.com/oauth/openid/jwks',
  issuerOk: (iss) => iss === 'https://www.linkedin.com/oauth',
  // LinkedIn will not share connections, so instead everyone sees these priests.
  networks: () => [],
  public: true,
};

/** The nonce for a sign-in: bound to our signed state, so it needs no storage. */
export function nonceFor(state: string): string {
  return createHash('sha256').update(`nonce\u0000${state}`).digest('base64url');
}

export class OidcProvider implements IdentityProvider {
  readonly id: ProviderId;
  readonly label: string;
  private readonly jwks: JWTVerifyGetKey;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly spec: OidcSpec,
    private readonly clientId: string,
    private readonly clientSecret: string,
    opts: { jwks?: JWTVerifyGetKey; fetch?: typeof fetch } = {},
  ) {
    this.id = spec.id;
    this.label = spec.label;
    this.jwks = opts.jwks ?? createRemoteJWKSet(new URL(spec.jwksUri), { timeoutDuration: 10_000 });
    this.fetchImpl = opts.fetch ?? fetch;
  }

  authorizeUrl(state: string, redirectUri: string): string {
    const u = new URL(this.spec.authorizationEndpoint);
    const params: Record<string, string> = {
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: redirectUri,
      scope: 'openid profile',
      state,
      nonce: nonceFor(state),
      ...this.spec.extra,
    };
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.href;
  }

  async callback(query: Record<string, unknown>, state: string, redirectUri: string): Promise<Person> {
    if (typeof query.code !== 'string') throw new Error('no code');
    const res = await this.fetchImpl(this.spec.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: query.code,
        redirect_uri: redirectUri,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id_token?: unknown };
    if (!res.ok || typeof body.id_token !== 'string') throw new Error(`${this.id} code exchange failed`);

    const { payload } = await jwtVerify(body.id_token, this.jwks, { audience: this.clientId, algorithms: ['RS256'] });
    if (typeof payload.iss !== 'string' || !this.spec.issuerOk(payload.iss, payload)) throw new Error(`${this.id} issuer`);
    if (payload.nonce !== nonceFor(state)) throw new Error(`${this.id} nonce`);
    if (typeof payload.sub !== 'string' || !payload.sub) throw new Error(`${this.id} subject`);

    return {
      provider: this.id,
      id: payload.sub,
      login: cleanDisplayName(firstName(payload)) || FALLBACK_LOGIN,
      name: str(payload.name) ?? null,
      mutualIds: [],
      networks: this.spec.networks(payload),
      public: this.spec.public,
    };
  }
}
