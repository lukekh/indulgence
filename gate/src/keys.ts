// Signing keys, JWKS, HMACs and every token the gate issues.
//
// One ES256 key signs all JWTs. Each kind carries a distinct `tt` (token type) claim and
// audience, and every verifier checks both, so no token can stand in for another:
//   access  — MCP bearer token (aud = <gate>/mcp), 1 h
//   refresh — MCP refresh token (aud = <gate>#refresh), 30 d
//   state   — GitHub OAuth state (aud = <gate>#state), 10 min
//   client  — stateless dynamic client registration (aud = <gate>#client), no expiry
//   viewer  — SpacetimeDB token for browsers (aud = module), role viewer, 4 h
//   gate    — SpacetimeDB token for the gate itself (aud = module), role gate, sub "gate"

import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  SignJWT,
  jwtVerify,
  importPKCS8,
  exportPKCS8,
  exportJWK,
  generateKeyPair,
  createLocalJWKSet,
  type JWK,
  type JWTPayload,
  type CryptoKey,
} from 'jose';
import type { GateConfig } from './config.js';

export type TokenType = 'access' | 'refresh' | 'state' | 'client' | 'viewer' | 'gate';

export interface Claims extends JWTPayload {
  tt: TokenType;
  [k: string]: unknown;
}

export class Keys {
  private constructor(
    readonly issuer: string,
    private readonly kid: string,
    private readonly privateKey: CryptoKey,
    readonly jwks: { keys: JWK[] },
    private readonly hmacKey: string,
  ) {}

  static async create(
    cfg: Pick<GateConfig, 'publicUrl' | 'signingKeyPem' | 'devKeyFile' | 'signingKid' | 'extraPublicJwks' | 'edgeHmacKey'>,
  ): Promise<Keys> {
    let pem = cfg.signingKeyPem;
    if (!pem) {
      if (cfg.devKeyFile && existsSync(cfg.devKeyFile)) {
        pem = readFileSync(cfg.devKeyFile, 'utf8');
      } else {
        const pair = await generateKeyPair('ES256', { extractable: true });
        pem = await exportPKCS8(pair.privateKey);
        if (cfg.devKeyFile) writeFileSync(cfg.devKeyFile, pem, { mode: 0o600 });
      }
      console.warn(`[keys] GATE_SIGNING_KEY not set: using a development key${cfg.devKeyFile ? ` (${cfg.devKeyFile})` : ''}.`);
    }
    const privateKey = await importPKCS8(pem, 'ES256', { extractable: true });
    const full = await exportJWK(privateKey);
    const keys: JWK[] = [{ kty: full.kty, crv: full.crv, x: full.x, y: full.y, kid: cfg.signingKid, alg: 'ES256', use: 'sig' }];
    if (cfg.extraPublicJwks) {
      const parsed = JSON.parse(cfg.extraPublicJwks) as JWK | JWK[];
      for (const k of Array.isArray(parsed) ? parsed : [parsed]) {
        if (!k.kid || keys.some((existing) => existing.kid === k.kid)) throw new Error('GATE_EXTRA_PUBLIC_JWKS entries need distinct kids');
        keys.push({ kty: k.kty, crv: k.crv, x: k.x, y: k.y, kid: k.kid, alg: 'ES256', use: 'sig' });
      }
    }
    return new Keys(cfg.publicUrl, cfg.signingKid, privateKey, { keys }, cfg.edgeHmacKey);
  }

  /** HMAC-SHA256 with a domain label, hex. */
  hmac(label: string, data: string): string {
    return createHmac('sha256', this.hmacKey).update(`${label}\u0000${data}`).digest('hex');
  }

  /** Account hash for a GitHub numeric id (also used for follow edges). 128 bits. */
  ghHash(githubId: number | string): string {
    return this.hmac('gh', String(githubId)).slice(0, 32);
  }

  /** Stable viewer subject for a GitHub numeric id: SpacetimeDB identity = f(iss, sub). */
  viewerSub(githubId: number | string): string {
    return `v.${this.hmac('viewer', String(githubId)).slice(0, 32)}`;
  }

  async sign(claims: Claims, opts: { aud: string; sub?: string; ttlSeconds?: number }): Promise<string> {
    let jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: this.kid, typ: 'JWT' })
      .setIssuer(this.issuer)
      .setAudience(opts.aud)
      .setIssuedAt();
    if (opts.sub) jwt = jwt.setSubject(opts.sub);
    if (opts.ttlSeconds) jwt = jwt.setExpirationTime(Math.floor(Date.now() / 1000) + opts.ttlSeconds);
    return jwt.sign(this.privateKey);
  }

  async verify(token: string, tt: TokenType, aud: string): Promise<Claims> {
    const { payload } = await jwtVerify(token, createLocalJWKSet(this.jwks), {
      issuer: this.issuer,
      audience: aud,
      algorithms: ['ES256'],
      clockTolerance: 30,
    });
    if (payload.tt !== tt) throw new Error('wrong token type');
    return payload as Claims;
  }

  /** SpacetimeDB token for the gate's own connection. */
  gateToken(audience: string): Promise<string> {
    return this.sign({ tt: 'gate', role: 'gate' }, { aud: audience, sub: 'gate', ttlSeconds: 12 * 3600 });
  }
}

export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}
