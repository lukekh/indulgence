// The gate as an OAuth 2.1 authorization server for MCP, delegating sign-in to GitHub.
//
// Client registrations, access tokens and refresh tokens are stateless (signed), so a
// gate restart does not log anyone out. Authorization codes and pending consent screens
// live in memory for minutes.
//
// The gate is a proxy in front of one GitHub OAuth app, with open dynamic registration,
// so it must not let a client it has never seen ride on that app's standing approval (the
// "confused deputy" of the MCP security best practices). So:
//   - clients may only register loopback http redirect URIs (Claude Code), or https ones
//     on an explicit allowlist, so codes cannot be delivered to an attacker's server;
//   - every sign-in by a client this browser has not approved first shows a gate page
//     naming the client and where the access goes, approved with a POST that is bound to
//     a cookie only this browser holds;
//   - tokens can be revoked (RFC 7009): refresh tokens durably, through the module.

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
import type { OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { randomId, type Claims, type Keys } from '../keys.js';
import { StoreError, type LabelModeName, type Store } from '../store.js';
import { cleanDisplayName, validLogin } from '../safety/index.js';
import { mutualIds, type GitHubApi } from './github.js';
import { authorizePage, consentPage, messagePage, PAGE_HEADERS } from './pages.js';
import { clearCookie, cookieNames, readCookie, setCookie, type CookieNames } from './cookies.js';

const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 86400;
const CODE_TTL_MS = 5 * 60_000;
const PENDING_TTL_MS = 15 * 60_000;
const STATE_TTL_S = 10 * 60;
const MIN_ACCOUNT_AGE_MS = 7 * 86400_000;
const MAX_FOLLOWS = 5000;
/** How long the page naming the client stays valid, and how long approvals are remembered. */
const AUTHZ_TTL_S = 10 * 60;
const APPROVALS_TTL_S = 90 * 86400;
const MAX_APPROVALS = 20;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether a client may have its authorization codes sent to `uri`: loopback http on any
 * port and path (what Claude Code listens on), or an https origin on the allowlist.
 */
export function redirectAllowed(uri: string, allowedOrigins: readonly string[] = []): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.username || u.password || u.hash) return false;
  if (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname)) return true;
  return u.protocol === 'https:' && allowedOrigins.includes(u.origin);
}

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
  /** https origins clients may register redirect URIs on, besides loopback http. */
  allowedRedirectOrigins?: string[];
}

export class GateOAuthProvider implements OAuthServerProvider {
  readonly resourceUrl: string;
  private readonly callbackUrl: string;
  private codes = new Map<string, CodeEntry>();
  private pending = new Map<string, { flow: Flow; draft: AccountDraft; expires: number }>();
  /** Accounts deleted with `forget`: tokens issued before this time are refused. */
  private forgottenAt = new Map<string, number>();
  /**
   * Grants revoked at /revoke while this process runs (seconds): refuses their access tokens
   * at once. Refresh tokens are refused durably by the module (touch_account); access tokens
   * expire within an hour anyway.
   */
  private revokedAt = new Map<string, number>();
  private readonly allowed: readonly string[];
  private readonly cookies: CookieNames;

  constructor(private readonly o: OAuthOptions) {
    this.resourceUrl = `${o.publicUrl}/mcp`;
    this.callbackUrl = `${o.publicUrl}/oauth/github/callback`;
    this.allowed = o.allowedRedirectOrigins ?? [];
    this.cookies = cookieNames(o.publicUrl);
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
    if (uris.some((u) => !redirectAllowed(u, this.allowed))) {
      throw new InvalidClientMetadataError('redirect_uris must be loopback http URIs (localhost, 127.0.0.1 or [::1])');
    }
    const meta = {
      redirect_uris: uris,
      token_endpoint_auth_method: client.token_endpoint_auth_method ?? 'client_secret_post',
      grant_types: client.grant_types ?? ['authorization_code', 'refresh_token'],
      response_types: client.response_types ?? ['code'],
      client_name: typeof client.client_name === 'string' ? client.client_name.slice(0, 100) : undefined,
      iat: Math.floor(Date.now() / 1000),
      // Every registration is its own client, even with identical metadata, so approvals
      // and revocations apply to exactly one.
      n: randomId(9),
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
  // Authorization: name the client, then redirect to GitHub with a signed state
  // ---------------------------------------------------------------------------

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // Clients registered before redirect URIs were restricted carry their own (signed) list,
    // so check the URI in use as well as at registration. Never redirect to a refused one.
    if (!redirectAllowed(params.redirectUri, this.allowed)) {
      return page(res, 400, messagePage('Application not allowed', 'This application asked for access to be sent somewhere /indulgence does not allow. Only Claude Code and other applications on this computer can sign in.'));
    }
    if (params.resource && params.resource.href !== this.resourceUrl) {
      res.redirect(clientRedirect(params.redirectUri, { error: 'invalid_target', state: params.state }));
      return;
    }
    const flow: Flow = { cid: client.client_id, ru: params.redirectUri, cc: params.codeChallenge, st: params.state };
    if (await this.approvedHere(res.req, client.client_id)) return this.toGitHub(res, flow);

    // Ask first. The form carries the flow, bound to a nonce held only in this browser's
    // cookie, so another site cannot submit it on the user's behalf.
    const nonce = randomId(24);
    const request = await this.o.keys.sign({ tt: 'authz', ...flow, nh: sha256(nonce) }, { aud: `${this.o.publicUrl}#authz`, ttlSeconds: AUTHZ_TTL_S });
    setCookie(res, this.cookies, this.cookies.authz, nonce, { maxAgeS: AUTHZ_TTL_S, sameSite: 'Strict' });
    page(res, 200, authorizePage(request, clientLabel(client), destination(params.redirectUri)));
  }

  private async toGitHub(res: Response, flow: Flow) {
    const state = await this.o.keys.sign({ tt: 'state', ...flow }, { aud: `${this.o.publicUrl}#state`, ttlSeconds: STATE_TTL_S });
    res.redirect(this.o.github.authorizeUrl(state, this.callbackUrl));
  }

  /** The user's answer on the page naming the client. */
  private async authorizeDecision(req: Request, res: Response) {
    // Defence in depth on top of the cookie: browsers that send Sec-Fetch-Site must say the
    // form came from this origin.
    const site = req.get('sec-fetch-site');
    if (site && site !== 'same-origin') {
      return page(res, 403, messagePage('Not allowed', 'This request did not come from the /indulgence sign-in page. Start again from Claude Code.'));
    }
    let claims: Claims;
    try {
      claims = await this.o.keys.verify(String(req.body?.request ?? ''), 'authz', `${this.o.publicUrl}#authz`);
    } catch {
      return page(res, 400, messagePage('Sign-in expired', 'This page has expired. Start again from Claude Code.'));
    }
    const nonce = readCookie(req, this.cookies.authz);
    clearCookie(res, this.cookies, this.cookies.authz);
    if (!nonce || !safeEqual(sha256(nonce), String(claims.nh))) {
      return page(res, 403, messagePage('Sign-in expired', 'This page was not opened in this browser, or has expired. Start again from Claude Code.'));
    }
    const flow: Flow = { cid: String(claims.cid), ru: String(claims.ru), cc: String(claims.cc), st: claims.st === undefined ? undefined : String(claims.st) };
    if (!redirectAllowed(flow.ru, this.allowed)) {
      return page(res, 400, messagePage('Application not allowed', 'This application is not allowed to sign in.'));
    }
    if (req.body?.decision !== 'allow') return res.redirect(clientRedirect(flow.ru, { error: 'access_denied', state: flow.st }));
    await this.rememberApproval(req, res, flow.cid);
    return this.toGitHub(res, flow);
  }

  /** Has this browser approved this client before (signed cookie)? */
  private async approvedHere(req: Request, clientId: string): Promise<boolean> {
    return (await this.approvals(req)).includes(this.clientTag(clientId));
  }

  private async approvals(req: Request): Promise<string[]> {
    const raw = readCookie(req, this.cookies.clients);
    if (!raw) return [];
    try {
      const claims = await this.o.keys.verify(raw, 'approved', `${this.o.publicUrl}#approved`);
      return Array.isArray(claims.cids) ? claims.cids.filter((c): c is string => typeof c === 'string') : [];
    } catch {
      return [];
    }
  }

  private async rememberApproval(req: Request, res: Response, clientId: string) {
    const tag = this.clientTag(clientId);
    const cids = [...(await this.approvals(req)).filter((c) => c !== tag), tag].slice(-MAX_APPROVALS);
    const token = await this.o.keys.sign({ tt: 'approved', cids }, { aud: `${this.o.publicUrl}#approved`, ttlSeconds: APPROVALS_TTL_S });
    setCookie(res, this.cookies, this.cookies.clients, token, { maxAgeS: APPROVALS_TTL_S, sameSite: 'Lax' });
  }

  private clientTag(clientId: string): string {
    return this.o.keys.hmac('approved-client', clientId).slice(0, 24);
  }

  /** Express routes for the page naming the client, the GitHub callback and the consent form. */
  routes(): Router {
    const r = express.Router();
    r.post('/oauth/authorize', express.urlencoded({ extended: false, limit: '8kb' }), (req, res) => void this.authorizeDecision(req, res));
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
    const grant = this.grantKey(claims.sub, client.client_id);
    if (this.isRevoked(grant, claims.iat)) throw new InvalidGrantError('token revoked');
    try {
      await this.o.store.touchAccount(claims.sub, grant, claims.iat ?? 0);
    } catch (e) {
      if (e instanceof StoreError && e.code === 'no_account') throw new InvalidGrantError('account deleted');
      if (e instanceof StoreError && e.code === 'revoked') throw new InvalidGrantError('token revoked');
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
    if (this.isRevoked(this.grantKey(claims.sub, String(claims.cid)), claims.iat)) throw new InvalidTokenError('token revoked');
    return {
      token,
      clientId: String(claims.cid),
      scopes: [],
      expiresAt: claims.exp,
      resource: new URL(this.resourceUrl),
      extra: { ghHash: claims.sub, viewerSub: claims.vs },
    };
  }

  // ---------------------------------------------------------------------------
  // Revocation (RFC 7009)
  // ---------------------------------------------------------------------------

  /**
   * Revoke the grant a token belongs to: that account signed in through that client. Only
   * the client the token was issued to may revoke it. Unknown or invalid tokens are not an
   * error (RFC 7009 §2.2).
   */
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const claims = await this.tokenClaims(request.token, request.token_type_hint);
    if (!claims || typeof claims.sub !== 'string' || claims.cid !== client.client_id) return;
    const grant = this.grantKey(claims.sub, client.client_id);
    this.revokedAt.set(grant, Math.floor(Date.now() / 1000));
    try {
      await this.o.store.revokeGrant(claims.sub, grant);
    } catch {
      throw new ServerError('temporarily unavailable');
    }
  }

  private async tokenClaims(token: string, hint?: string): Promise<Claims | undefined> {
    const kinds: [TokenKind, string][] = [
      ['refresh', `${this.o.publicUrl}#refresh`],
      ['access', this.resourceUrl],
    ];
    if (hint === 'access_token') kinds.reverse();
    for (const [tt, aud] of kinds) {
      try {
        return await this.o.keys.verify(token, tt, aud);
      } catch {
        // try the other kind
      }
    }
    return undefined;
  }

  /** One account signed in through one client: what revocation applies to. */
  grantKey(ghHash: string, clientId: string): string {
    return this.o.keys.hmac('grant', `${ghHash}\n${clientId}`).slice(0, 48);
  }

  private isRevoked(grant: string, iat: number | undefined): boolean {
    const t = this.revokedAt.get(grant);
    return t !== undefined && (iat ?? 0) <= t;
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

type TokenKind = 'access' | 'refresh';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** How the client names itself, which nobody has verified. */
function clientLabel(client: OAuthClientInformationFull): string {
  const name = typeof client.client_name === 'string' ? client.client_name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 80) : '';
  return name ? `“${name}”` : 'An unnamed application';
}

/** Where the authorization code (and so the access) will be delivered. */
function destination(redirectUri: string): string {
  const u = new URL(redirectUri);
  return LOOPBACK_HOSTS.has(u.hostname) ? `an application on this computer (${u.host})` : u.host;
}

function clientRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.href;
}

function page(res: Response, status: number, html: string) {
  res.status(status).set(PAGE_HEADERS).send(html);
}
