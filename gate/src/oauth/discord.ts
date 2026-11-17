// Discord: OAuth2 with the `identify` and `guilds` scopes. The network is the servers the
// person is in, but only small ones: anyone with an invite can join a server, so a large or
// public one would let strangers in just to see who in it is praying. The user token is used
// for these two calls and then revoked.

import { cleanDisplayName } from '../safety/index.js';
import { snowflakeTime, type IdentityProvider, type Person } from './identity.js';
import { FALLBACK_LOGIN } from './oidc.js';

/** Servers bigger than this are not a network. */
export const DISCORD_MAX_SERVER_MEMBERS = 200;
/** At most this many servers count, as the module allows. */
const MAX_NETWORKS = 200;
/** Pinned: without a version, Discord serves its oldest, deprecated one. */
const API = 'https://discord.com/api/v10';

/** Discord usernames: 2–32 of lower-case letters, digits, `_` and `.`. */
const USERNAME = /^[a-z0-9_.]{2,32}$/;

export class DiscordProvider implements IdentityProvider {
  readonly id = 'discord' as const;
  readonly label = 'Discord';

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  authorizeUrl(state: string, redirectUri: string): string {
    const u = new URL('https://discord.com/oauth2/authorize');
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: this.clientId, redirect_uri: redirectUri, scope: 'identify guilds', state })) {
      u.searchParams.set(k, v);
    }
    return u.href;
  }

  private async get(token: string, path: string): Promise<unknown> {
    const res = await this.fetchImpl(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`discord ${path.split('?')[0]} ${res.status}`);
    return res.json();
  }

  async callback(query: Record<string, unknown>, _state: string, redirectUri: string): Promise<Person> {
    if (typeof query.code !== 'string') throw new Error('no code');
    const res = await this.fetchImpl(`${API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: query.code, redirect_uri: redirectUri, client_id: this.clientId, client_secret: this.clientSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: unknown };
    if (!res.ok || typeof body.access_token !== 'string') throw new Error('discord code exchange failed');
    const token = body.access_token;
    try {
      const user = (await this.get(token, '/users/@me')) as { id?: unknown; username?: unknown; global_name?: unknown };
      if (typeof user.id !== 'string' || !/^\d{1,20}$/.test(user.id) || typeof user.username !== 'string') throw new Error('discord user malformed');
      const guilds = (await this.get(token, '/users/@me/guilds?with_counts=true')) as { id?: unknown; approximate_member_count?: unknown }[];
      const small = (Array.isArray(guilds) ? guilds : [])
        .filter((g) => typeof g.id === 'string' && typeof g.approximate_member_count === 'number' && g.approximate_member_count <= DISCORD_MAX_SERVER_MEMBERS)
        .slice(0, MAX_NETWORKS)
        .map((g) => `discord-guild:${g.id as string}`);
      return {
        provider: 'discord',
        id: user.id,
        login: USERNAME.test(user.username) ? user.username : cleanDisplayName(user.username) || FALLBACK_LOGIN,
        name: typeof user.global_name === 'string' ? user.global_name : null,
        mutualIds: [],
        networks: small,
        public: false,
        createdAt: snowflakeTime(user.id),
      };
    } finally {
      void this.fetchImpl(`${API}/oauth2/token/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, token_type_hint: 'access_token', client_id: this.clientId, client_secret: this.clientSecret }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
    }
  }
}
