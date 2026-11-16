// Over HTTP, with more than one way in: choosing a provider, what each consent screen says,
// what is kept (hashes of networks, never the networks), public LinkedIn accounts, and the
// livestream's token.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { decodeJwt } from 'jose';
import { Keys } from '../src/keys.js';
import { SessionManager } from '../src/sessions.js';
import { GateOAuthProvider } from '../src/oauth/provider.js';
import type { IdentityProvider, Person, ProviderId } from '../src/oauth/identity.js';
import { BROADCAST_SUB, createApp } from '../src/server.js';
import type { GateConfig } from '../src/config.js';
import { FakeGitHub, FakeStore } from './fakes.js';

const REDIRECT = 'http://localhost:9999/callback';
const STREAM_KEY = 's'.repeat(32);

/** A provider stand-in: codes map to people. */
class FakeProvider implements IdentityProvider {
  people = new Map<string, Omit<Person, 'provider'>>();
  constructor(
    readonly id: ProviderId,
    readonly label: string,
  ) {}
  authorizeUrl(state: string, redirectUri: string) {
    const u = new URL(`https://${this.id}.test/auth`);
    u.searchParams.set('state', state);
    u.searchParams.set('redirect_uri', redirectUri);
    return u.href;
  }
  async callback(query: Record<string, unknown>): Promise<Person> {
    const p = this.people.get(String(query.code));
    if (!p) throw new Error('bad code');
    return { provider: this.id, ...p };
  }
}

let base = '';
let server: http.Server;
let store: FakeStore;
let keys: Keys;
const google = new FakeProvider('google', 'Google');
const linkedin = new FakeProvider('linkedin', 'LinkedIn');

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
    streamKey: STREAM_KEY,
    edgeHmacKey: 'k'.repeat(32),
    signingKid: 'test-1',
    trustProxy: 0,
    devSkipAgeCheck: false,
    allowedRedirectOrigins: [],
  };
  keys = await Keys.create(cfg);
  store = new FakeStore();
  google.people.set('ada', { id: 'g-ada', login: 'Ada', name: 'Ada Lovelace', mutualIds: [], networks: ['google-hd:example.com'], public: false });
  linkedin.people.set('mary', { id: 'l-mary', login: 'Mary', name: 'Mary Somerville', mutualIds: [], networks: [], public: true });
  const sessions = new SessionManager(store, cfg.siteUrl);
  const oauth = new GateOAuthProvider({ keys, store, github: new FakeGitHub(), providers: [google, linkedin], publicUrl: base });
  const { app } = createApp({ cfg, keys, oauth, sessions, isStoreReady: () => true, setBroadcaster: (sub) => store.setBroadcaster(sub) });
  handler = app;
});

afterAll(() => {
  server.closeAllConnections();
  return new Promise<void>((r) => server.close(() => r()));
});

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
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

async function register(): Promise<string> {
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_name: 'agent' }),
  });
  return ((await res.json()) as { client_id: string }).client_id;
}

/** Open /authorize: the page, and its form's signed request. */
async function open(clientId: string) {
  const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
  const auth = new URL(`${base}/authorize`);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st8' })) auth.searchParams.set(k, v);
  const res = await fetch(auth, { redirect: 'manual', headers: { cookie: cookies() } });
  keepCookies(res);
  const html = await res.text();
  return { res, html, request: /name="request" value="([^"]+)"/.exec(html)?.[1] };
}

/** Choose a way in on the page: where the gate sends the browser. */
async function choose(request: string, provider: string): Promise<URL> {
  const res = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: cookies(), 'Sec-Fetch-Site': 'same-origin' },
    body: form({ request, decision: 'allow', provider }),
  });
  keepCookies(res);
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location')!);
}

/** Through a provider's sign-in to its consent screen. */
async function signIn(provider: string, code: string) {
  const page = await open(await register());
  const away = await choose(page.request!, provider);
  const cb = await fetch(`${base}/oauth/${provider}/callback?code=${code}&state=${away.searchParams.get('state')}`, { redirect: 'manual' });
  return { cb, html: await cb.text(), state: away.searchParams.get('state')! };
}

async function consent(html: string, choice: string) {
  const pending = /name="pending" value="([^"]+)"/.exec(html)![1]!;
  return fetch(`${base}/oauth/consent`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ pending, choice }) });
}

describe('more than one way in', () => {
  it('offers every configured provider, GitHub first', async () => {
    const page = await open(await register());
    const offered = [...page.html.matchAll(/name="provider" value="([a-z]+)"><svg[^]*?<\/svg><span>Continue with ([A-Za-z]+)</g)].map((m) => `${m[1]}:${m[2]}`);
    expect(offered).toEqual(['github:GitHub', 'google:Google', 'linkedin:LinkedIn']);
    expect(page.html).toContain('wants to act as you');
  });

  it('signs in with Google, keeping a keyed hash of the Workspace and never the Workspace itself', async () => {
    const { cb, html } = await signIn('google', 'ada');
    expect(cb.status).toBe(200);
    expect(html).toContain('same Google Workspace');
    expect(html).toContain('administrators can see that you signed in');
    expect(html).toContain('Show my first name (Ada)');
    expect(html).toContain('livestream');
    const back = await consent(html, 'fullname');
    expect(back.status).toBe(302);
    expect(new URL(back.headers.get('location')!).searchParams.get('code')).toBeTruthy();

    const account = store.accounts.get(keys.accountHash('google', 'g-ada'))!;
    expect(account).toMatchObject({ ghLogin: 'Ada', ghName: 'Ada Lovelace', labelMode: 'FullName', public: false, mutualHashes: [] });
    expect(account.networkChecks).toEqual([keys.networkCheck('google-hd:example.com')]);
    expect(JSON.stringify(account)).not.toContain('example.com');
    expect(JSON.stringify(account)).not.toContain('g-ada');
  });

  it('makes a LinkedIn account public, and says so first', async () => {
    const { html } = await signIn('linkedin', 'mary');
    expect(html).toContain('everyone who opens the site will see your name');
    await consent(html, 'username');
    expect(store.accounts.get(keys.accountHash('linkedin', 'l-mary'))).toMatchObject({ public: true, ghLogin: 'Mary', networkChecks: [] });
  });

  it('asks a client approved before only which way in', async () => {
    const clientId = await register();
    const first = await open(clientId);
    await choose(first.request!, 'google');
    const again = await open(clientId);
    expect(again.res.status).toBe(200);
    expect(again.html).toContain('Choose how to sign in');
    expect(again.html).not.toContain('wants to act as you');
  });

  it("refuses one provider's state at another's callback, and an unknown provider", async () => {
    const { state } = await signIn('google', 'ada');
    const wrong = await fetch(`${base}/oauth/linkedin/callback?code=mary&state=${state}`, { redirect: 'manual' });
    expect(wrong.status).toBe(400);
    const page = await open(await register());
    const res = await fetch(`${base}/oauth/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: cookies(), 'Sec-Fetch-Site': 'same-origin' },
      body: form({ request: page.request!, decision: 'allow', provider: 'myspace' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('the livestream token', () => {
  const ask = (key: unknown) =>
    fetch(`${base}/broadcast-token`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://site.test' }, body: JSON.stringify({ key }) });

  it('is refused without the right key', async () => {
    expect((await ask('wrong')).status).toBe(401);
    expect((await ask(undefined)).status).toBe(401);
    expect(store.broadcasters).toEqual([]);
  });

  it('is a viewer token for the one broadcaster identity, registered with the module', async () => {
    const res = await ask(STREAM_KEY);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://site.test');
    const body = (await res.json()) as { token: string; priest_id: string; px: number };
    const claims = decodeJwt(body.token);
    expect(claims).toMatchObject({ sub: BROADCAST_SUB, role: 'viewer', aud: 'indulgence' });
    expect(body.priest_id).toBe('0');
    expect(store.broadcasters).toEqual([BROADCAST_SUB]);
  });
});
