import { readFileSync } from 'node:fs';

// Gate configuration from environment variables. Secrets (GitHub client secret,
// EDGE_HMAC_KEY, signing key) are expected to be injected by a secret manager.

export interface GateConfig {
  /** Public base URL of the gate, no trailing slash. Also the JWT issuer. */
  publicUrl: string;
  /** Public URL of the web client (viewer). */
  siteUrl: string;
  port: number;
  host: string;
  /** e.g. wss://maincloud.spacetimedb.com */
  spacetimedbUri: string;
  /** Database name on SpacetimeDB. */
  spacetimedbModule: string;
  /** `aud` claim for SpacetimeDB tokens; must match the module's INDULGENCE_AUDIENCE. */
  spacetimedbAudience: string;
  githubClientId: string;
  githubClientSecret: string;
  /** Keys every HMAC the gate computes (account and edge hashes, client ids). */
  edgeHmacKey: string;
  /** ES256 private key, PKCS#8 PEM (GATE_SIGNING_KEY, or a file via GATE_SIGNING_KEY_FILE). */
  signingKeyPem?: string;
  /** Development only: where to keep a generated key so restarts reuse it. */
  devKeyFile?: string;
  signingKid: string;
  /**
   * Extra public keys (JWK or JSON array of JWKs, each with its own kid) published in the
   * JWKS: the previous key after a rotation, or the next key before one. SpacetimeDB caches
   * an issuer's JWKS for about 5 minutes, so publish a new key at least that long before
   * signing with it.
   */
  extraPublicJwks?: string;
  /** Number of reverse-proxy hops to trust for client IPs (Express `trust proxy`). */
  trustProxy: number;
  /** Development only: skip the GitHub account-age check. */
  devSkipAgeCheck: boolean;
  /**
   * https origins, besides loopback http (which Claude Code uses), that OAuth clients may
   * register as redirect URIs (GATE_ALLOWED_REDIRECT_ORIGINS, comma-separated). Empty by
   * default: a client that can receive codes anywhere on the internet could be used to
   * phish sign-ins.
   */
  allowedRedirectOrigins: string[];
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required environment variable ${key}`);
  return v;
}

function stripSlash(u: string): string {
  return u.replace(/\/+$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GateConfig {
  const publicUrl = stripSlash(required(env, 'GATE_PUBLIC_URL'));
  if (Buffer.byteLength(publicUrl) >= 128) throw new Error('GATE_PUBLIC_URL must be under 128 bytes (JWT issuer limit)');
  const module = required(env, 'SPACETIMEDB_MODULE');
  const edgeHmacKey = required(env, 'EDGE_HMAC_KEY');
  if (env.NODE_ENV === 'production' && !env.GATE_SIGNING_KEY && !env.GATE_SIGNING_KEY_FILE) {
    throw new Error('GATE_SIGNING_KEY or GATE_SIGNING_KEY_FILE is required in production');
  }
  if (edgeHmacKey.length < 32) throw new Error('EDGE_HMAC_KEY must be at least 32 characters');
  return {
    publicUrl,
    siteUrl: stripSlash(required(env, 'SITE_URL')),
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '0.0.0.0',
    spacetimedbUri: env.SPACETIMEDB_URI ?? 'wss://maincloud.spacetimedb.com',
    spacetimedbModule: module,
    spacetimedbAudience: env.SPACETIMEDB_AUDIENCE ?? module,
    githubClientId: required(env, 'GITHUB_CLIENT_ID'),
    githubClientSecret: required(env, 'GITHUB_CLIENT_SECRET'),
    edgeHmacKey,
    signingKeyPem:
      env.GATE_SIGNING_KEY?.replace(/\\n/g, '\n') ||
      (env.GATE_SIGNING_KEY_FILE ? readFileSync(env.GATE_SIGNING_KEY_FILE, 'utf8') : undefined),
    devKeyFile: env.NODE_ENV === 'production' ? undefined : (env.GATE_DEV_KEY_FILE ?? '.dev-signing-key.pem'),
    signingKid: env.GATE_SIGNING_KID ?? 'gate-1',
    extraPublicJwks: env.GATE_EXTRA_PUBLIC_JWKS || undefined,
    trustProxy: Number(env.TRUST_PROXY ?? 0),
    devSkipAgeCheck: env.DEV_SKIP_AGE_CHECK === '1',
    allowedRedirectOrigins: parseOrigins(env.GATE_ALLOWED_REDIRECT_ORIGINS),
  };
}

function parseOrigins(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const u = new URL(s);
      if (u.protocol !== 'https:') throw new Error(`GATE_ALLOWED_REDIRECT_ORIGINS: ${s} is not https`);
      return u.origin;
    });
}
