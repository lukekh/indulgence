// The gate as an OAuth 2.1 authorization server for MCP, delegating sign-in to GitHub.
//
// Client registrations, access tokens and refresh tokens are stateless (signed), so a
// gate restart does not log anyone out. Authorization codes and pending consent screens
// live in memory for minutes.

import express, { type Response, type Router } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  InvalidGrantError,
  InvalidTokenError,
  InvalidClientMetadataError,
  ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { timingSafeEqual } from 'node:crypto';
import { randomId, type Keys } from '../keys.js';
import { StoreError, type LabelModeName, type Store } from '../store.js';
import { cleanDisplayName, validLogin } from '../safety/index.js';
import { mutualIds, type GitHubApi } from './github.js';
import { consentPage, messagePage, PAGE_HEADERS } from './pages.js';

const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 86400;
const CODE_TTL_MS = 5 * 60_000;
const PENDING_TTL_MS = 15 * 60_000;
const STATE_TTL_S = 10 * 60;
const MIN_ACCOUNT_AGE_MS = 7 * 86400_000;
const MAX_FOLLOWS = 5000;

/** Pending authorization, carried through GitHub in the signed `state`. */
interface Flow {
  cid: string;
  ru: string;
  cc: string;
  st?: string;
}

interface AccountDraft {
  ghHash: string;
  viewerSub: string;
  login: string;
  name: string;
  mutualHashes: string[];
}

interface CodeEntry {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  ghHash: string;
  viewerSub: string;
  expires: number;
}

export interface OAuthOptions {
  keys: Keys;
  store: Store;
  github: GitHubApi;
  publicUrl: string;
  devSkipAgeCheck?: boolean;
}

export class GateOAuthProvider implements OAuthServerProvider {
  readonly resourceUrl: string;
  private readonly callbackUrl: string;
  private codes = new Map<string, CodeEntry>();
  private pending = new Map<string, { flow: Flow; draft: AccountDraft; expires: number }>();
  /** Accounts deleted with `forget`: tokens issued before this time are refused. */
  private forgottenAt = new Map<string, number>();

  constructor(private readonly o: OAuthOptions) {
    this.resourceUrl = `${o.publicUrl}/mcp`;
    this.callbackUrl = `${o.publicUrl}/oauth/github/callback`;
  }

  // ---------------------------------------------------------------------------
  // Stateless dynamic client registration
  // ---------------------------------------------------------------------------

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.decodeClient(clientId),
      registerClient: (client) => this.encodeClient(client),
    };
  }

  private encodeClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): OAuthClientInformationFull {
    const uris = client.redirect_uris.map(String);
    if (uris.length === 0 || uris.length > 5 || uris.some((u) => u.length > 512)) {
      throw new InvalidClientMetadataError('redirect_uris must list 1 to 5 URIs of at most 512 characters');
    }
    const meta = {
      redirect_uris: uris,
      token_endpoint_auth_method: client.token_endpoint_auth_method ?? 'client_secret_post',
      grant_types: client.grant_types ?? ['authorization_code', 'refresh_token'],
      response_types: client.response_types ?? ['code'],
      client_name: typeof client.client_name === 'string' ? client.client_name.slice(0, 100) : undefined,
      iat: Math.floor(Date.now() / 1000),
    };
    const body = Buffer.from(JSON.stringify(meta)).toString('base64url');
    const clientId = `ic1.${body}.${this.o.keys.hmac('client', body).slice(0, 32)}`;
    return this.decodeClient(clientId)!;
  }

  private decodeClient(clientId: string): OAuthClientInformationFull | undefined {
    const [v, body, mac] = clientId.split('.');
    if (v !== 'ic1' || !body || !mac) return undefined;
    const expected = this.o.keys.hmac('client', body).slice(0, 32);
    if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return undefined;
    const meta = JSON.parse(Buffer.from(body, 'base64url').toString()) as {
      redirect_uris: string[];
      token_endpoint_auth_method: string;
      grant_types: string[];
      response_types: string[];
      client_name?: string;
      iat: number;
    };
    const isPublic = meta.token_endpoint_auth_method === 'none';
    return {
      client_id: clientId,
      client_id_issued_at: meta.iat,
      redirect_uris: meta.redirect_uris,
      token_endpoint_auth_method: meta.token_endpoint_auth_method,
      grant_types: meta.grant_types,
      response_types: meta.response_types,
      client_name: meta.client_name,
      // Derived, so it never needs storing; 0 = does not expire.
      ...(isPublic ? {} : { client_secret: this.o.keys.hmac('client-secret', clientId), client_secret_expires_at: 0 }),
    } as OAuthClientInformationFull;
  }

  // ---------------------------------------------------------------------------
  // Authorization: redirect to GitHub with a signed state
  // ---------------------------------------------------------------------------

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource && params.resource.href !== this.resourceUrl) {
      res.redirect(clientRedirect(params.redirectUri, { error: 'invalid_target', state: params.state }));
      return;
    }
    const flow: Flow = { cid: client.client_id, ru: params.redirectUri, cc: params.codeChallenge, st: params.state };
    const state = await this.o.keys.sign({ tt: 'state', ...flow }, { aud: `${this.o.publicUrl}#state`, ttlSeconds: STATE_TTL_S });
    res.redirect(this.o.github.authorizeUrl(state, this.callbackUrl));
  }

  /** Express routes for the GitHub callback and the consent form. */
  routes(): Router {
    const r = express.Router();
    r.get('/oauth/github/callback', (req, res) => void this.githubCallback(req.query, res));
    r.post('/oauth/consent', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => void this.consent(req.body, res));
    return r;
  }

  private async githubCallback(query: Record<string, unknown>, res: Response) {
    let flow: Flow;
    try {
      const claims = await this.o.keys.verify(String(query.state ?? ''), 'state', `${this.o.publicUrl}#state`);
      flow = { cid: String(claims.cid), ru: String(claims.ru), cc: String(claims.cc), st: claims.st === undefined ? undefined : String(claims.st) };
    } catch {
      return page(res, 400, messagePage('Sign-in expired', 'This sign-in link is invalid or has expired. Start again from Claude Code.'));
    }
    if (query.error || typeof query.code !== 'string') {
      return res.redirect(clientRedirect(flow.ru, { error: 'access_denied', state: flow.st }));
    }

    let draft: AccountDraft;
    try {
      const token = await this.o.github.exchangeCode(query.code, this.callbackUrl);
      try {
        const user = await this.o.github.user(token);
        if (!validLogin(user.login)) throw new Error('unexpected login');
        const age = Date.now() - Date.parse(user.created_at);
        if (!this.o.devSkipAgeCheck && !(age >= MIN_ACCOUNT_AGE_MS)) {
          const to = clientRedirect(flow.ru, { error: 'access_denied', state: flow.st });
          return page(res, 403, messagePage('Account too new', 'GitHub accounts must be at least 7 days old to use /indulgence.', to));
        }
        const [following, followers] = await Promise.all([
          this.o.github.followIds(token, 'following', MAX_FOLLOWS),
          this.o.github.followIds(token, 'followers', MAX_FOLLOWS),
        ]);
        draft = {
          ghHash: this.o.keys.ghHash(user.id),
          viewerSub: this.o.keys.viewerSub(user.id),
          login: user.login,
          name: cleanDisplayName(user.name),
          mutualHashes: mutualIds(following, followers).map((id) => this.o.keys.ghHash(id)),
        };
      } finally {
        // The user token is never stored or logged; revoke it now that mutuals are known.
        void this.o.github.revoke(token).catch(() => {});
      }
    } catch {
      const to = clientRedirect(flow.ru, { error: 'server_error', state: flow.st });
      return page(res, 502, messagePage('Sign-in failed', 'GitHub could not be reached. Try again in a moment.', to));
    }

    try {
      await this.o.store.upsertAccount({ ...draft, ghName: draft.name, ghLogin: draft.login });
      return this.finish(res, flow, draft);
    } catch (e) {
      if (e instanceof StoreError && e.code === 'consent_required') {
        const id = randomId(24);
        this.pending.set(id, { flow, draft, expires: Date.now() + PENDING_TTL_MS });
        return page(res, 200, consentPage(id, draft.login, draft.name));
      }
      const to = clientRedirect(flow.ru, { error: 'temporarily_unavailable', state: flow.st });
      return page(res, 503, messagePage('Cathedral unavailable', 'The cathedral could not be reached. Try again later.', to));
    }
  }

  private async consent(body: Record<string, unknown> | undefined, res: Response) {
    const id = typeof body?.pending === 'string' ? body.pending : '';
    const entry = this.pending.get(id);
    this.pending.delete(id);
    if (!entry || entry.expires < Date.now()) {
      return page(res, 400, messagePage('Consent expired', 'This page has expired. Start again from Claude Code.'));
    }
    const { flow, draft } = entry;
    const choice = body?.choice;
    let mode: LabelModeName;
    if (choice === 'username') mode = 'Username';
    else if (choice === 'fullname' && draft.name) mode = 'FullName';
    else return res.redirect(clientRedirect(flow.ru, { error: 'access_denied', state: flow.st }));

    try {
      await this.o.store.upsertAccount({ ...draft, ghName: draft.name, ghLogin: draft.login, labelMode: mode });
    } catch {
      const to = clientRedirect(flow.ru, { error: 'temporarily_unavailable', state: flow.st });
      return page(res, 503, messagePage('Cathedral unavailable', 'The cathedral could not be reached. Try again later.', to));
    }
    return this.finish(res, flow, draft);
  }

  private finish(res: Response, flow: Flow, draft: AccountDraft) {
    const code = randomId(32);
    this.codes.set(code, {
      clientId: flow.cid,
      redirectUri: flow.ru,
      codeChallenge: flow.cc,
      ghHash: draft.ghHash,
      viewerSub: draft.viewerSub,
      expires: Date.now() + CODE_TTL_MS,
    });
    this.sweep();
    res.redirect(clientRedirect(flow.ru, { code, state: flow.st }));
  }

  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.codes) if (v.expires < now) this.codes.delete(k);
    for (const [k, v] of this.pending) if (v.expires < now) this.pending.delete(k);
  }

  // ---------------------------------------------------------------------------
  // Tokens
  // ---------------------------------------------------------------------------

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const entry = this.codes.get(code);
    if (!entry || entry.clientId !== client.client_id) throw new InvalidGrantError('invalid authorization code');
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const entry = this.codes.get(code);
    this.codes.delete(code); // single use
    if (!entry || entry.expires < Date.now() || entry.clientId !== client.client_id) {
      throw new InvalidGrantError('invalid authorization code');
    }
    if (redirectUri !== undefined && redirectUri !== entry.redirectUri) throw new InvalidGrantError('redirect_uri mismatch');
    if (resource && resource.href !== this.resourceUrl) throw new InvalidGrantError('invalid resource');
    const refreshExp = Math.floor(Date.now() / 1000) + REFRESH_TTL_S;
    return this.issue(client.client_id, entry.ghHash, entry.viewerSub, refreshExp);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, _scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    let claims;
    try {
      claims = await this.o.keys.verify(refreshToken, 'refresh', `${this.o.publicUrl}#refresh`);
    } catch {
      throw new InvalidGrantError('invalid refresh token');
    }
    if (claims.cid !== client.client_id || typeof claims.sub !== 'string' || typeof claims.vs !== 'string') {
      throw new InvalidGrantError('invalid refresh token');
    }
    if (resource && resource.href !== this.resourceUrl) throw new InvalidGrantError('invalid resource');
    if (this.isForgotten(claims.sub, claims.iat)) throw new InvalidGrantError('account deleted');
    try {
      await this.o.store.touchAccount(claims.sub);
    } catch (e) {
      if (e instanceof StoreError && e.code === 'no_account') throw new InvalidGrantError('account deleted');
      throw new ServerError('temporarily unavailable');
    }
    // The refresh token keeps its original expiry: follow edges are re-read from GitHub
    // when the user signs in again after it lapses (at most 30 days).
    return this.issue(client.client_id, claims.sub, claims.vs, claims.exp!);
  }

  private async issue(clientId: string, ghHash: string, viewerSub: string, refreshExp: number): Promise<OAuthTokens> {
    const access = await this.o.keys.sign({ tt: 'access', vs: viewerSub, cid: clientId }, { aud: this.resourceUrl, sub: ghHash, ttlSeconds: ACCESS_TTL_S });
    const refresh = await this.o.keys.sign(
      { tt: 'refresh', vs: viewerSub, cid: clientId, exp: refreshExp },
      { aud: `${this.o.publicUrl}#refresh`, sub: ghHash },
    );
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let claims;
    try {
      claims = await this.o.keys.verify(token, 'access', this.resourceUrl);
    } catch {
      throw new InvalidTokenError('invalid access token');
    }
    if (typeof claims.sub !== 'string' || typeof claims.vs !== 'string' || this.isForgotten(claims.sub, claims.iat)) {
      throw new InvalidTokenError('invalid access token');
    }
    return {
      token,
      clientId: String(claims.cid),
      scopes: [],
      expiresAt: claims.exp,
      resource: new URL(this.resourceUrl),
      extra: { ghHash: claims.sub, viewerSub: claims.vs },
    };
  }

  /** After `forget`, refuse tokens issued before now. */
  markForgotten(ghHash: string) {
    this.forgottenAt.set(ghHash, Math.floor(Date.now() / 1000));
  }

  private isForgotten(ghHash: string, iat: number | undefined): boolean {
    const t = this.forgottenAt.get(ghHash);
    return t !== undefined && (iat ?? 0) <= t;
  }
}

function clientRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.href;
}

function page(res: Response, status: number, html: string) {
  res.status(status).set(PAGE_HEADERS).send(html);
}
