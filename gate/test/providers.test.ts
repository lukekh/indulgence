// The ways in other than GitHub, against stand-ins for their servers: OpenID Connect for
// Google, Microsoft and LinkedIn (ID tokens signed with a local key), and Discord.

import { describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload } from 'jose';
import { Keys } from '../src/keys.js';
import { GOOGLE, LINKEDIN, MICROSOFT, MICROSOFT_CONSUMER_TENANT, OidcProvider, nonceFor, type OidcSpec } from '../src/oauth/oidc.js';
import { DISCORD_MAX_SERVER_MEMBERS, DiscordProvider } from '../src/oauth/discord.js';
import { snowflakeTime } from '../src/oauth/identity.js';

const STATE = 'signed-state';
const REDIRECT = 'https://gate.test/oauth/x/callback';

const signer = await generateKeyPair('RS256');
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(signer.publicKey)), kid: 'k1', alg: 'RS256' }] });

function idToken(claims: JWTPayload, opts: { aud?: string; alg?: string } = {}) {
  return new SignJWT({ nonce: nonceFor(STATE), ...claims })
    .setProtectedHeader({ alg: opts.alg ?? 'RS256', kid: 'k1' })
    .setAudience(opts.aud ?? 'client-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signer.privateKey);
}

/** A provider whose token endpoint hands back `token`, recording what it was sent. */
function oidc(spec: OidcSpec, token: () => Promise<string>) {
  const sent: URLSearchParams[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    expect(String(url)).toBe(spec.tokenEndpoint);
    sent.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify({ id_token: await token(), access_token: 'at' }), { status: 200 });
  }) as typeof fetch;
  return { provider: new OidcProvider(spec, 'client-1', 'secret-1', { jwks, fetch: fetchImpl }), sent };
}

describe('OpenID Connect sign-in', () => {
  it('asks only for openid and profile, bound to our state by a nonce', () => {
    const u = new URL(oidc(GOOGLE, async () => '').provider.authorizeUrl(STATE, REDIRECT));
    expect(u.origin + u.pathname).toBe(GOOGLE.authorizationEndpoint);
    expect(u.searchParams.get('scope')).toBe('openid profile');
    expect(u.searchParams.get('state')).toBe(STATE);
    expect(u.searchParams.get('nonce')).toBe(nonceFor(STATE));
    expect(u.searchParams.get('client_id')).toBe('client-1');
  });

  it("Google: a Workspace account's domain is its network; a personal account has none", async () => {
    const work = oidc(GOOGLE, () => idToken({ iss: 'https://accounts.google.com', sub: 'g-1', name: 'Ada Lovelace', given_name: 'Ada', hd: 'Example.COM' }));
    const p = await work.provider.callback({ code: 'c' }, STATE, REDIRECT);
    expect(p).toMatchObject({ provider: 'google', id: 'g-1', login: 'Ada', name: 'Ada Lovelace', networks: ['google-hd:example.com'], public: false, mutualIds: [] });
    expect(work.sent[0]!.get('code')).toBe('c');
    expect(work.sent[0]!.get('redirect_uri')).toBe(REDIRECT);

    const personal = oidc(GOOGLE, () => idToken({ iss: 'https://accounts.google.com', sub: 'g-2', name: 'Bo Peep' }));
    expect((await personal.provider.callback({ code: 'c' }, STATE, REDIRECT)).networks).toEqual([]);
  });

  it("Microsoft: the issuer must be the token's own tenant, and the personal-account tenant is no network", async () => {
    const tid = '11111111-2222-3333-4444-555555555555';
    const ok = oidc(MICROSOFT, () => idToken({ iss: `https://login.microsoftonline.com/${tid}/v2.0`, tid, sub: 'm-1', name: 'Grace Hopper' }));
    expect(await ok.provider.callback({ code: 'c' }, STATE, REDIRECT)).toMatchObject({ login: 'Grace', networks: [`entra-tid:${tid}`] });

    const other = oidc(MICROSOFT, () => idToken({ iss: 'https://login.microsoftonline.com/99999999-2222-3333-4444-555555555555/v2.0', tid, sub: 'm-1', name: 'X' }));
    await expect(other.provider.callback({ code: 'c' }, STATE, REDIRECT)).rejects.toThrow(/issuer/);

    const consumer = oidc(MICROSOFT, () =>
      idToken({ iss: `https://login.microsoftonline.com/${MICROSOFT_CONSUMER_TENANT}/v2.0`, tid: MICROSOFT_CONSUMER_TENANT, sub: 'm-2', name: 'Pat' }),
    );
    expect((await consumer.provider.callback({ code: 'c' }, STATE, REDIRECT)).networks).toEqual([]);
  });

  it('LinkedIn: no network, so public', async () => {
    const li = oidc(LINKEDIN, () => idToken({ iss: 'https://www.linkedin.com/oauth', sub: 'l-1', name: 'Mary Somerville', given_name: 'Mary' }));
    expect(await li.provider.callback({ code: 'c' }, STATE, REDIRECT)).toMatchObject({ provider: 'linkedin', login: 'Mary', networks: [], public: true });
  });

  it('refuses a token for another sign-in, another app or another issuer, or not signed by the provider', async () => {
    const iss = 'https://accounts.google.com';
    const cases: [string, () => Promise<string>][] = [
      ['nonce', () => idToken({ iss, sub: 's', name: 'A', nonce: nonceFor('another-state') })],
      ['audience', () => idToken({ iss, sub: 's', name: 'A' }, { aud: 'someone-else' })],
      ['issuer', () => idToken({ iss: 'https://evil.test', sub: 's', name: 'A' })],
      [
        'signature',
        async () => {
          const other = await generateKeyPair('RS256');
          return new SignJWT({ iss, sub: 's', nonce: nonceFor(STATE) }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setAudience('client-1').setExpirationTime('5m').sign(other.privateKey);
        },
      ],
    ];
    for (const [, token] of cases) {
      await expect(oidc(GOOGLE, token).provider.callback({ code: 'c' }, STATE, REDIRECT)).rejects.toThrow();
    }
  });

  it('shows a fallback name when the first name is unusable', async () => {
    const p = await oidc(GOOGLE, () => idToken({ iss: 'https://accounts.google.com', sub: 's', name: '' })).provider.callback({ code: 'c' }, STATE, REDIRECT);
    expect(p.login).toBe('pilgrim');
  });
});

describe('Discord sign-in', () => {
  const id = '175928847299117063'; // made in 2016
  function discord(guilds: { id: string; approximate_member_count: number }[]) {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'at' }));
      if (u.endsWith('/users/@me')) return new Response(JSON.stringify({ id, username: 'hildegard', global_name: 'Hildegard of Bingen' }));
      if (u.includes('/users/@me/guilds')) return new Response(JSON.stringify(guilds));
      if (u.endsWith('/oauth2/token/revoke')) return new Response('', { status: 200 });
      return new Response('', { status: 404 });
    }) as typeof fetch;
    return { provider: new DiscordProvider('client-1', 'secret-1', fetchImpl), calls };
  }

  it('asks for identify and guilds only', () => {
    const u = new URL(discord([]).provider.authorizeUrl(STATE, REDIRECT));
    expect(u.searchParams.get('scope')).toBe('identify guilds');
    expect(u.searchParams.get('state')).toBe(STATE);
  });

  it('counts only small servers as networks, dates the account from its id, and revokes the token', async () => {
    const d = discord([
      { id: '1', approximate_member_count: 12 },
      { id: '2', approximate_member_count: DISCORD_MAX_SERVER_MEMBERS },
      { id: '3', approximate_member_count: DISCORD_MAX_SERVER_MEMBERS + 1 },
      { id: '4', approximate_member_count: 2_000_000 },
    ]);
    const p = await d.provider.callback({ code: 'c' }, STATE, REDIRECT);
    expect(p).toMatchObject({ provider: 'discord', id, login: 'hildegard', name: 'Hildegard of Bingen', networks: ['discord-guild:1', 'discord-guild:2'], public: false });
    expect(p.createdAt!.getUTCFullYear()).toBe(2016);
    await new Promise((r) => setTimeout(r, 0));
    expect(d.calls.some((u) => u.endsWith('/oauth2/token/revoke'))).toBe(true);
    expect(d.calls.every((u) => u.startsWith('https://discord.com/api/v10/'))).toBe(true);
  });

  it('reads the time from a snowflake', () => {
    expect(snowflakeTime('0')!.getTime()).toBe(1420070400000);
    expect(snowflakeTime('not a number')).toBeUndefined();
  });
});

const keys = await Keys.create({ publicUrl: 'https://gate.test', edgeHmacKey: 'k'.repeat(32), signingKid: 't', devKeyFile: undefined });

describe('account and network hashes', () => {
  it("keeps GitHub's hashes as they were, so existing accounts and edges still match", () => {
    expect(keys.accountHash('github', '42')).toBe(keys.ghHash(42));
    expect(keys.viewerSubFor('github', '42')).toBe(keys.viewerSub(42));
  });

  it('never gives the same id at two providers the same account', () => {
    expect(keys.accountHash('google', '42')).not.toBe(keys.accountHash('github', '42'));
    expect(keys.accountHash('google', '42')).not.toBe(keys.accountHash('microsoft', '42'));
    expect(keys.viewerSubFor('discord', '42')).not.toBe(keys.viewerSubFor('github', '42'));
  });

  it('keeps no network in the clear, and gives everyone in one the same check', () => {
    const c = keys.networkCheck('google-hd:example.com');
    expect(c).toMatch(/^[0-9a-f]{32}$/);
    expect(c).not.toContain('example');
    expect(keys.networkCheck('google-hd:example.com')).toBe(c);
    expect(keys.networkCheck('google-hd:example.org')).not.toBe(c);
  });
});
