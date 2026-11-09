// GitHub OAuth App calls. No scopes are requested: the public profile and public follow
// lists need none. The user token is used for these calls only and then revoked.

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  created_at: string;
}

export interface GitHubApi {
  authorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<string>;
  user(token: string): Promise<GitHubUser>;
  /** Numeric ids of accounts the user follows or is followed by, 100 per page. */
  followIds(token: string, kind: 'following' | 'followers', maxCount: number): Promise<number[]>;
  /** Best effort: revoke the single user token. */
  revoke(token: string): Promise<void>;
}

const API = 'https://api.github.com';

export class RealGitHub implements GitHubApi {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  authorizeUrl(state: string, redirectUri: string): string {
    const u = new URL('https://github.com/login/oauth/authorize');
    u.searchParams.set('client_id', this.clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('scope', '');
    u.searchParams.set('state', state);
    u.searchParams.set('allow_signup', 'false');
    return u.href;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<string> {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'indulgence-gate' },
      body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret, code, redirect_uri: redirectUri }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: unknown };
    if (!res.ok || typeof body.access_token !== 'string') throw new Error('github code exchange failed');
    return body.access_token;
  }

  private async get(token: string, path: string): Promise<unknown> {
    const res = await fetch(`${API}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'indulgence-gate',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`github ${path.split('?')[0]} ${res.status}`);
    return res.json();
  }

  async user(token: string): Promise<GitHubUser> {
    const u = (await this.get(token, '/user')) as Partial<GitHubUser>;
    if (typeof u.id !== 'number' || typeof u.login !== 'string' || typeof u.created_at !== 'string') {
      throw new Error('github user response malformed');
    }
    return { id: u.id, login: u.login, name: typeof u.name === 'string' ? u.name : null, created_at: u.created_at };
  }

  async followIds(token: string, kind: 'following' | 'followers', maxCount: number): Promise<number[]> {
    const ids: number[] = [];
    for (let page = 1; ids.length < maxCount; page++) {
      const batch = (await this.get(token, `/user/${kind}?per_page=100&page=${page}`)) as { id?: unknown }[];
      if (!Array.isArray(batch)) break;
      for (const u of batch) if (typeof u.id === 'number') ids.push(u.id);
      if (batch.length < 100) break;
    }
    return ids.slice(0, maxCount);
  }

  async revoke(token: string): Promise<void> {
    await fetch(`${API}/applications/${this.clientId}/token`, {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
        'User-Agent': 'indulgence-gate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ access_token: token }),
      signal: AbortSignal.timeout(10_000),
    });
  }
}

/** Mutuals: the intersection of following and followers by numeric id. */
export function mutualIds(following: number[], followers: number[]): number[] {
  const f = new Set(following);
  return [...new Set(followers.filter((id) => f.has(id)))];
}
