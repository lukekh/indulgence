// End to end over HTTP with fakes for GitHub and SpacetimeDB: dynamic client registration,
// the page naming the client, PKCE authorization through GitHub and the consent screen,
// token exchange, refresh and revocation, the MCP endpoint via the official client,
// viewer tokens, and deleting the account.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { decodeJwt } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Keys } from '../src/keys.js';
import { SessionManager } from '../src/sessions.js';
import { GateOAuthProvider, redirectAllowed } from '../src/oauth/provider.js';
import { C } from '../../shared/constants.js';
import { createApp, spectatorX } from '../src/server.js';
import type { GateConfig } from '../src/config.js';
import { FakeGitHub, FakeStore } from './fakes.js';

const REDIRECT = 'http://localhost:9999/callback';
let base = '';
let server: http.Server;
let store: FakeStore;
let github: FakeGitHub;
let keys: Keys;

const DAY = 86400_000;

beforeAll(async () => {
  let handler: http.RequestListener = () => {};
  server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cfg: GateConfig = {
    publicUrl: base,
    siteUrl: 'https://site.test',
    port: 0,
    host: '127.0.0.1',
    spacetimedbUri: 'wss://stdb.test',
    spacetimedbModule: 'indulgence',
    spacetimedbAudience: 'indulgence',
    githubClientId: 'gh-client',
    githubClientSecret: 'gh-secret',
    edgeHmacKey: 'k'.repeat(32),
    signingKid: 'test-1',
    trustProxy: 0,
    devSkipAgeCheck: false,
    allowedRedirectOrigins: [],
  };
  keys = await Keys.create(cfg);
  store = new FakeStore();
  github = new FakeGitHub();
  github.users.set('alice-code', {
    id: 1,
    login: 'alice',
    name: 'Alice Liddell',
    created_at: new Date(Date.now() - 30 * DAY).toISOString(),
    following: [2, 3],
    followers: [3, 4],
  });
  github.users.set('newbie-code', { id: 9, login: 'newbie', name: null, created_at: new Date().toISOString(), following: [], followers: [] });
  github.users.set('bob-code', { id: 5, login: 'bob', name: 'Bob', created_at: new Date(Date.now() - 30 * DAY).toISOString(), following: [], followers: [] });
  const sessions = new SessionManager(store, cfg.siteUrl);
  const oauth = new GateOAuthProvider({ keys, store, github, publicUrl: base });
  sessions.onForgotten = (h) => oauth.markForgotten(h);
  sessions.gateUrl = base;
  const { app } = createApp({ cfg, keys, oauth, sessions, isStoreReady: () => true, occupiedXs: () => store.occupiedXs() });
  handler = app;
});

afterAll(() => {
  server.closeAllConnections();
  return new Promise<void>((r) => server.close(() => r()));
});

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

async function register(redirectUris = [REDIRECT], name = 'test'): Promise<string> {
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: redirectUris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_name: name }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** The test's browser: the gate's cookies, kept between requests. */
const jar = new Map<string, string>();
function keepCookies(res: Response) {
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(';')[0]!;
    const i = pair.indexOf('=');
    if (/Max-Age=0\b/.test(c)) jar.delete(pair.slice(0, i));
    else jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
}
const cookies = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

function authorizeUrl(clientId: string, challenge: string, redirectUri = REDIRECT) {
  const auth = new URL(`${base}/authorize`);
  Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state: 'st8' }).forEach(([k, v]) =>
    auth.searchParams.set(k, v),
  );
  return auth;
}

/** The page naming the client: its form's signed request. */
async function approvalPage(clientId: string, challenge: string): Promise<{ res: Response; request?: string; html: string }> {
  const res = await fetch(authorizeUrl(clientId, challenge), { redirect: 'manual', headers: { cookie: cookies() } });
  keepCookies(res);
  const html = res.status === 200 ? await res.text() : '';
  return { res, html, request: /name="request" value="([^"]+)"/.exec(html)?.[1] };
}

function decide(request: string, decision: 'allow' | 'deny', headers: Record<string, string> = { 'Sec-Fetch-Site': 'same-origin' }, cookie = cookies()) {
  return fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie, ...headers },
    body: form({ request, decision }),
  });
}

/** Open /authorize in the test's browser, approving the client if asked; returns the response. */
async function authorize(clientId: string, challenge: string): Promise<Response> {
  const page = await approvalPage(clientId, challenge);
  if (!page.request) return page.res;
  const res = await decide(page.request, 'allow');
  keepCookies(res);
  return res;
}

/** Authorise through the fake GitHub; returns the redirect back to the client. */
async function signIn(clientId: string, githubCode: string, consent?: 'username' | 'fullname') {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const r1 = await authorize(clientId, challenge);
  expect(r1.status).toBe(302);
  const gh = new URL(r1.headers.get('location')!);
  expect(gh.origin).toBe('https://github.test');
  const cb = await fetch(`${base}/oauth/github/callback?code=${githubCode}&state=${gh.searchParams.get('state')}`, { redirect: 'manual' });
  let back = cb;
  if (cb.status === 200) {
    const html = await cb.text();
    expect(html).toContain('will be shown publicly on your candle');
    const pending = /name="pending" value="([^"]+)"/.exec(html)![1]!;
    back = await fetch(`${base}/oauth/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ pending, choice: consent ?? 'username' }),
      redirect: 'manual',
    });
  }
  return { res: back, verifier };
}

async function token(body: Record<string, string>) {
  const res = await fetch(`${base}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('OIDC issuer', () => {
  it('publishes discovery and an ES256 JWKS with a kid', async () => {
    const conf = (await (await fetch(`${base}/.well-known/openid-configuration`)).json()) as Record<string, string>;
    expect(conf.issuer).toBe(base);
    const jwks = (await (await fetch(conf.jwks_uri!)).json()) as { keys: Record<string, string>[] };
    expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', kid: 'test-1' });
    expect(jwks.keys[0]!.d).toBeUndefined();
    const prm = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    expect(prm).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [`${base}/`] });
  });
});

describe('sign-in, MCP and viewer tokens', () => {
  let clientId = '';
  let access = '';
  let refresh = '';
  let mcp: Client;

  it('requires a bearer token on /mcp', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('registers clients statelessly and rejects tampered ids', async () => {
    clientId = await register();
    expect(clientId.startsWith('ic1.')).toBe(true);
    const tampered = clientId.slice(0, -2) + (clientId.endsWith('a') ? 'bb' : 'aa');
    const res = await fetch(`${base}/authorize?response_type=code&client_id=${encodeURIComponent(tampered)}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=x&code_challenge_method=S256`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
  });

  it('signs in through GitHub with a one-time consent screen, storing only hashes', async () => {
    const { res, verifier } = await signIn(clientId, 'alice-code', 'fullname');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get('state')).toBe('st8');
    const t = await token({ grant_type: 'authorization_code', code: loc.searchParams.get('code')!, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT });
    expect(t.status).toBe(200);
    access = t.body.access_token as string;
    refresh = t.body.refresh_token as string;
    expect(t.body.expires_in).toBe(3600);

    const acct = store.accounts.get(keys.ghHash(1))!;
    expect(acct).toMatchObject({ ghLogin: 'alice', ghName: 'Alice Liddell', labelMode: 'FullName', viewerSub: keys.viewerSub(1) });
    expect(acct.mutualHashes).toEqual([keys.ghHash(3)]); // following ∩ followers
    expect(github.revoked).toEqual(['tok-alice-code']); // GitHub token discarded

    // Codes are single use.
    const again = await token({ grant_type: 'authorization_code', code: loc.searchParams.get('code')!, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT });
    expect(again.status).toBe(400);
  });

  it('does not show the consent screen to returning users', async () => {
    const { res } = await signIn(clientId, 'alice-code');
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).searchParams.get('code')).toBeTruthy();
  });

  it('refuses GitHub accounts younger than 7 days', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const r1 = await authorize(clientId, challenge);
    const state = new URL(r1.headers.get('location')!).searchParams.get('state');
    const cb = await fetch(`${base}/oauth/github/callback?code=newbie-code&state=${state}`, { redirect: 'manual' });
    expect(cb.status).toBe(403);
    expect(await cb.text()).toContain('at least 7 days old');
    expect(store.accounts.has(keys.ghHash(9))).toBe(false);
  });

  it('serves MCP tools to the official client', async () => {
    mcp = new Client({ name: 'test', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${access}` } } }));
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['begin', 'delete_account', 'depart', 'pray', 'vigil']);
  });

  let ticket = '';
  let sessionId = '';
  it('begin seats a priest in pray mode (client did not declare sampling)', async () => {
    const res = await mcp.callTool({ name: 'begin', arguments: { intention: 'for the soul of my cat', budget_tokens: 20000 } });
    const sc = res.structuredContent as { session_id: string; url: string; mode: string; budget_tokens: number };
    expect(sc.mode).toBe('pray');
    expect(sc.budget_tokens).toBe(20000);
    expect(sc.url.startsWith('https://site.test/#t=')).toBe(true);
    expect(JSON.stringify(res)).not.toContain('cat');
    ticket = sc.url.split('#t=')[1]!;
    sessionId = sc.session_id;
    expect(store.live()).toHaveLength(1);
  });

  let viewerToken = '';
  it('trades the ticket for a view-only SpacetimeDB token, as often as it is opened', async () => {
    const res = await fetch(`${base}/viewer-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://site.test' },
      body: JSON.stringify({ ticket }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://site.test');
    const body = (await res.json()) as { token: string; px: number; priest_id: string; uri: string; module: string };
    viewerToken = body.token;
    const claims = decodeJwt(viewerToken);
    expect(claims).toMatchObject({ iss: base, aud: 'indulgence', sub: keys.viewerSub(1), role: 'viewer', tt: 'viewer', px: body.px, pid: body.priest_id });
    expect((claims.exp! - claims.iat!) / 3600).toBe(4);
    expect(body).toMatchObject({ uri: 'wss://stdb.test', module: 'indulgence' });

    const again = await fetch(`${base}/viewer-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { priest_id: string }).priest_id).toBe(body.priest_id);
    const wrong = await fetch(`${base}/viewer-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: 'x'.repeat(22) }) });
    expect(wrong.status).toBe(410);
  });

  it('a viewer token is not an MCP access token, and vice versa', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${viewerToken}` }, body: '{}' });
    expect(res.status).toBe(401);
    const r2 = await fetch(`${base}/viewer-token/refresh`, { method: 'POST', headers: { Authorization: `Bearer ${access}` } });
    expect(r2.status).toBe(401);
  });

  it('refreshes the viewer token while the session is live', async () => {
    const res = await fetch(`${base}/viewer-token/refresh`, { method: 'POST', headers: { Authorization: `Bearer ${viewerToken}` } });
    expect(res.status).toBe(200);
  });

  it('gives a visitor with no link a view-only token for an occupied bay, tied to no account', async () => {
    store.occupied = [1234];
    const res = await fetch(`${base}/spectator-token`, { method: 'POST', headers: { Origin: 'https://site.test' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://site.test');
    const body = (await res.json()) as { token: string; px: number; priest_id: string };
    expect(body).toMatchObject({ px: 1234, priest_id: '0' });
    const claims = decodeJwt(body.token);
    expect(claims).toMatchObject({ iss: base, aud: 'indulgence', role: 'viewer', tt: 'viewer', px: 1234, pid: '0' });
    expect(claims.sub).toMatch(/^spectator:[0-9a-f-]{36}$/);
    expect(claims.sub).not.toBe(keys.viewerSub(1));
    // It refreshes to the same bay, and is no more an MCP token than any viewer token.
    const again = await fetch(`${base}/viewer-token/refresh`, { method: 'POST', headers: { Authorization: `Bearer ${body.token}` } });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { px: number }).px).toBe(1234);
    const mcpRes = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${body.token}` }, body: '{}' });
    expect(mcpRes.status).toBe(401);
    store.occupied = [];
  });

  it("accepts Antigravity's hosted callback only when its origin is listed", () => {
    const relay = 'https://antigravity.google/oauth-callback';
    expect(redirectAllowed(relay)).toBe(false);
    expect(redirectAllowed(relay, ['https://antigravity.google'])).toBe(true);
    // The listing is by origin: another host, or plain http, is still refused.
    expect(redirectAllowed('https://antigravity.google.evil.example/oauth-callback', ['https://antigravity.google'])).toBe(false);
    expect(redirectAllowed('http://antigravity.google/oauth-callback', ['https://antigravity.google'])).toBe(false);
    // An application on this computer never needed listing.
    expect(redirectAllowed('http://127.0.0.1:56465/callback')).toBe(true);
  });

  it('shows a visitor an empty bay near the first when nobody is praying', () => {
    expect(spectatorX([10, 20, 30], () => 0.5)).toBe(20);
    const xs = [0, 0.5, 0.999].map((r) => spectatorX([], () => r));
    expect(xs.map((x) => Math.floor(x / C.BAY_W))).toEqual([-12, 0, 12]);
  });

  it('refresh tokens keep their original 30-day expiry', async () => {
    const t = await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
    expect(t.status).toBe(200);
    expect(decodeJwt(t.body.refresh_token as string).exp).toBe(decodeJwt(refresh).exp);
  });

  it('depart ends the session; the viewer token can no longer be refreshed', async () => {
    const res = await mcp.callTool({ name: 'depart', arguments: { session_id: sessionId } });
    expect(res.structuredContent).toEqual({ ok: true });
    expect(store.departs).toEqual([sessionId]);
    const r = await fetch(`${base}/viewer-token/refresh`, { method: 'POST', headers: { Authorization: `Bearer ${viewerToken}` } });
    expect(r.status).toBe(410);
  });

  it('closing the MCP session (DELETE /mcp) departs a live priest at once', async () => {
    const res = await mcp.callTool({ name: 'begin', arguments: { intention: 'pro anima' } });
    const sid = (res.structuredContent as { session_id: string }).session_id;
    await (mcp.transport as StreamableHTTPClientTransport).terminateSession();
    await mcp.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(store.departs).toContain(sid);
  });

  it('delete_account deletes nothing; confirming on its page deletes the account and invalidates its tokens', async () => {
    const c = new Client({ name: 'test', version: '1.0.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${access}` } } }));
    expect((await c.callTool({ name: 'forget', arguments: {} })).isError).toBe(true); // the old name is gone
    const res = await c.callTool({ name: 'delete_account', arguments: {} });
    const out = res.structuredContent as { url: string; deleted: boolean };
    expect(out.deleted).toBe(false);
    expect(out.url).toMatch(new RegExp(`^${base}/delete-account\\?t=[A-Za-z0-9_-]{22}$`));
    expect(store.forgotten).toEqual([]);
    // Still signed in.
    expect((await c.callTool({ name: 'depart', arguments: { session_id: 'none' } })).isError).toBeFalsy();

    // The page asks; looking at it deletes nothing, however often.
    for (let i = 0; i < 2; i++) {
      const page = await fetch(out.url);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('Delete my account');
      expect(html).toContain('keep burning');
    }
    expect(store.forgotten).toEqual([]);
    const form = (fields: Record<string, string>) =>
      fetch(`${base}/delete-account`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
    const link = new URL(out.url).searchParams.get('t')!;
    // Neither a made-up link nor a post without the button deletes anything.
    expect((await form({ t: 'x'.repeat(22), decision: 'delete' })).status).toBe(410);
    expect((await form({ t: link })).status).toBe(400);
    expect(store.forgotten).toEqual([]);

    // A second request replaces the first link.
    const res2 = await c.callTool({ name: 'delete_account', arguments: {} });
    const url2 = (res2.structuredContent as { url: string }).url;
    expect((await fetch(out.url)).status).toBe(410);
    const link2 = new URL(url2).searchParams.get('t')!;

    // Pressing the button deletes it, once.
    const done = await form({ t: link2, decision: 'delete' });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('Your account is deleted');
    expect(store.forgotten).toEqual([keys.ghHash(1)]);
    expect((await form({ t: link2, decision: 'delete' })).status).toBe(410);
    expect(store.forgotten).toEqual([keys.ghHash(1)]);
    const after = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` }, body: '{}' });
    expect(after.status).toBe(401);
    const t = await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
    expect(t.status).toBe(400);
    expect(t.body.error).toBe('invalid_grant');
  });
});

describe('who may sign in (the gate is a proxy for one GitHub app)', () => {
  const challenge = createHash('sha256').update('v'.repeat(43)).digest('base64url');

  it('registers only clients that receive codes on this computer (loopback http)', async () => {
    for (const uri of ['https://evil.example/cb', 'http://evil.example/cb', 'http://user:pw@localhost/cb', 'custom-scheme://cb']) {
      const res = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [uri], token_endpoint_auth_method: 'none' }),
      });
      expect(res.status, uri).toBe(400);
    }
    for (const uri of ['http://127.0.0.1:5555/callback', 'http://[::1]:7/cb', 'http://localhost/cb']) expect(await register([uri])).toMatch(/^ic1\./);
  });

  it('refuses, without redirecting, clients registered before the restriction', async () => {
    // A stateless client id minted with an outside redirect URI, as an attacker might hold.
    const body = Buffer.from(
      JSON.stringify({ redirect_uris: ['https://evil.example/cb'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'], iat: 1 }),
    ).toString('base64url');
    const old = `ic1.${body}.${keys.hmac('client', body).slice(0, 32)}`;
    const res = await fetch(authorizeUrl(old, challenge, 'https://evil.example/cb'), { redirect: 'manual' });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toContain('does not allow');
  });

  it('names the client and where the access goes before sending anyone to GitHub', async () => {
    jar.clear();
    const id = await register([REDIRECT], 'Suspicious <b>Helper</b>');
    const { res, html, request } = await approvalPage(id, challenge);
    expect(res.status).toBe(200);
    expect(html).toContain('“Suspicious &lt;b&gt;Helper&lt;/b&gt;”');
    expect(html).toContain('not verified by /indulgence');
    expect(html).toContain('an application on this computer (localhost:9999)');
    expect(request).toBeTruthy();
    const set = res.headers.getSetCookie().find((c) => c.startsWith('indulgence-authz='))!;
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
  });

  it('accepts the answer only from this browser, on this site', async () => {
    jar.clear();
    const id = await register();
    const a = await approvalPage(id, challenge);
    const cookieA = cookies();
    // No cookie: a form posted from elsewhere.
    expect((await decide(a.request!, 'allow', { 'Sec-Fetch-Site': 'same-origin' }, '')).status).toBe(403);
    // The right cookie, but posted from another site.
    expect((await decide(a.request!, 'allow', { 'Sec-Fetch-Site': 'cross-site' }, cookieA)).status).toBe(403);
    // A page opened in another browser (its own cookie) cannot be answered with this one's.
    jar.clear();
    await approvalPage(id, challenge);
    expect((await decide(a.request!, 'allow')).status).toBe(403);
    // Tampered request.
    expect((await decide(`${a.request!.slice(0, -4)}AAAA`, 'allow', undefined, cookieA)).status).toBe(400);
  });

  it('cancelling returns access_denied to the client', async () => {
    jar.clear();
    const id = await register();
    const page = await approvalPage(id, challenge);
    const res = await decide(page.request!, 'deny');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('st8');
  });

  it('remembers an approved client in this browser, and only that client', async () => {
    jar.clear();
    const id = await register();
    const first = await authorize(id, challenge);
    expect(new URL(first.headers.get('location')!).origin).toBe('https://github.test');
    const remembered = jar.get('indulgence-clients');
    expect(remembered).toBeTruthy();
    // The same client again goes straight to GitHub...
    const again = await fetch(authorizeUrl(id, challenge), { redirect: 'manual', headers: { cookie: cookies() } });
    expect(again.status).toBe(302);
    // ...but a different client is asked about, and so is the same client in another browser.
    expect((await approvalPage(await register([REDIRECT], 'another app'), challenge)).res.status).toBe(200);
    jar.clear();
    expect((await approvalPage(id, challenge)).res.status).toBe(200);
    // A forged approval cookie counts for nothing.
    jar.set('indulgence-clients', 'forged.jwt.value');
    expect((await approvalPage(id, challenge)).res.status).toBe(200);
  });

  it('revokes a grant: its refresh and access tokens stop working, other clients are unaffected', async () => {
    const mine = await register([REDIRECT], 'mine');
    const other = await register([REDIRECT], 'other');
    const signedIn = async (id: string) => {
      const { res, verifier } = await signIn(id, 'bob-code');
      const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
      const t = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: id, redirect_uri: REDIRECT });
      expect(t.status).toBe(200);
      return { access: t.body.access_token as string, refresh: t.body.refresh_token as string };
    };
    const a = await signedIn(mine);
    const b = await signedIn(other);
    // Tokens are issued with second precision: let the revocation fall in a later second.
    await new Promise((r) => setTimeout(r, 1100));

    const revoke = (tokenValue: string, clientId: string) =>
      fetch(`${base}/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ token: tokenValue, client_id: clientId }) });
    // Another client cannot revoke this client's token (RFC 7009: answered 200 regardless).
    expect((await revoke(a.refresh, other)).status).toBe(200);
    expect((await token({ grant_type: 'refresh_token', refresh_token: a.refresh, client_id: mine })).status).toBe(200);

    expect((await revoke(a.refresh, mine)).status).toBe(200);
    const refused = await token({ grant_type: 'refresh_token', refresh_token: a.refresh, client_id: mine });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('invalid_grant');
    const mcp = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.access}` }, body: '{}' });
    expect(mcp.status).toBe(401);
    // Recorded durably, so a gate restart still refuses the refresh token.
    expect(store.revoked.size).toBe(1);

    expect((await token({ grant_type: 'refresh_token', refresh_token: b.refresh, client_id: other })).status).toBe(200);
    // Unknown tokens are not an error.
    expect((await revoke('not-a-token', mine)).status).toBe(200);
  });

  it('advertises the revocation endpoint', async () => {
    const meta = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, string>;
    expect(meta.revocation_endpoint).toBe(`${base}/revoke`);
  });
});
