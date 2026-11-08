// End to end over HTTP with fakes for GitHub and SpacetimeDB: dynamic client registration,
// PKCE authorization through GitHub and the consent screen, token exchange and refresh,
// the MCP endpoint via the official client, viewer tokens, and forget.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { decodeJwt } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Keys } from '../src/keys.js';
import { SessionManager } from '../src/sessions.js';
import { GateOAuthProvider } from '../src/oauth/provider.js';
import { createApp } from '../src/server.js';
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
  const sessions = new SessionManager(store, cfg.siteUrl);
  const oauth = new GateOAuthProvider({ keys, store, github, publicUrl: base });
  sessions.onForgotten = (h) => oauth.markForgotten(h);
  const { app } = createApp({ cfg, keys, oauth, sessions, isStoreReady: () => true });
  handler = app;
});

afterAll(() => {
  server.closeAllConnections();
  return new Promise<void>((r) => server.close(() => r()));
});

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

async function register(): Promise<string> {
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_name: 'test' }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** Authorise through the fake GitHub; returns the redirect back to the client. */
async function signIn(clientId: string, githubCode: string, consent?: 'username' | 'fullname') {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const auth = new URL(`${base}/authorize`);
  Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st8' }).forEach(([k, v]) =>
    auth.searchParams.set(k, v),
  );
  const r1 = await fetch(auth, { redirect: 'manual' });
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
    const r1 = await fetch(
      `${base}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256`,
      { redirect: 'manual' },
    );
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
    expect(tools.map((t) => t.name).sort()).toEqual(['begin', 'depart', 'forget', 'pray', 'vigil']);
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
  it('trades the ticket once for a view-only SpacetimeDB token', async () => {
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
    expect(again.status).toBe(410);
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

  it('forget deletes the account and invalidates its tokens', async () => {
    const c = new Client({ name: 'test', version: '1.0.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${access}` } } }));
    const res = await c.callTool({ name: 'forget', arguments: {} });
    expect(res.structuredContent).toEqual({ ok: true });
    expect(store.forgotten).toEqual([keys.ghHash(1)]);
    const after = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` }, body: '{}' });
    expect(after.status).toBe(401);
    const t = await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
    expect(t.status).toBe(400);
    expect(t.body.error).toBe('invalid_grant');
  });
});
