// Express app: OAuth/OIDC endpoints, the MCP endpoint and viewer tokens.

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { GateConfig } from './config.js';
import type { Keys } from './keys.js';
import type { GateOAuthProvider } from './oauth/provider.js';
import { createMcpServer } from './mcp.js';
import type { SessionManager } from './sessions.js';
import { deleteAccountPage, messagePage, PAGE_HEADERS } from './oauth/pages.js';
import { C } from '../../shared/constants.js';

const VIEWER_TTL_S = 4 * 3600;
/** With nobody in the cathedral, a visitor is shown one of this many bays either side of the first. */
const EMPTY_BAY_SPREAD = 12;
const MCP_IDLE_CLOSE_MS = 60 * 60_000;

export interface AppDeps {
  cfg: GateConfig;
  keys: Keys;
  oauth: GateOAuthProvider;
  sessions: SessionManager;
  isStoreReady: () => boolean;
  /** The x of every priest in a pew, for choosing the bay a visitor without a link is shown. */
  occupiedXs?: () => number[];
}

interface TransportEntry {
  transport: StreamableHTTPServerTransport;
  ghHash: string;
  lastRequest: number;
}

/** Fixed-window per-IP limiter. IPs live only in memory and in rate-limit log lines. */
export function rateLimit(name: string, perMinute: number) {
  const hits = new Map<string, { n: number; window: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? 'unknown';
    const window = Math.floor(Date.now() / 60_000);
    const h = hits.get(ip);
    if (!h || h.window !== window) {
      if (hits.size > 50_000) hits.clear();
      hits.set(ip, { n: 1, window });
      return next();
    }
    if (++h.n > perMinute) {
      if (h.n === perMinute + 1) console.warn(`[ratelimit] ${name} ${ip}`);
      res.status(429).set('Retry-After', '60').json({ error: 'rate_limited' });
      return;
    }
    next();
  };
}

const SPECTATOR_PREFIX = 'spectator:';
const isSpectator = (sub: unknown) => typeof sub === 'string' && sub.startsWith(SPECTATOR_PREFIX);

/** Where a visitor looks: at a priest chosen at random, or at an empty bay if there is none. */
export function spectatorX(occupied: number[], random: () => number = Math.random): number {
  if (occupied.length > 0) return occupied[Math.floor(random() * occupied.length)]!;
  const bay = Math.floor(random() * (2 * EMPTY_BAY_SPREAD + 1)) - EMPTY_BAY_SPREAD;
  return bay * C.BAY_W + Math.floor(C.BAY_W / 2);
}

export function createApp(deps: AppDeps): { app: Express; closeIdleTransports: () => void; transportCount: () => number } {
  const { cfg, keys, oauth, sessions } = deps;
  const app = express();
  app.set('trust proxy', cfg.trustProxy);
  app.disable('x-powered-by');

  // --- OIDC issuer for SpacetimeDB ------------------------------------------
  app.get('/.well-known/openid-configuration', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json({
      issuer: cfg.publicUrl,
      jwks_uri: `${cfg.publicUrl}/.well-known/jwks.json`,
      authorization_endpoint: `${cfg.publicUrl}/authorize`,
      token_endpoint: `${cfg.publicUrl}/token`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['ES256'],
    });
  });
  app.get('/.well-known/jwks.json', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json(keys.jwks);
  });

  // --- OAuth 2.1 authorization server (MCP authorization spec) ---------------
  app.use(['/authorize', '/token', '/register', '/oauth'], rateLimit('auth', 60));
  app.use(
    mcpAuthRouter({
      provider: oauth,
      issuerUrl: new URL(cfg.publicUrl),
      resourceServerUrl: new URL(oauth.resourceUrl),
      resourceName: '/indulgence',
      clientRegistrationOptions: { clientIdGeneration: false },
    }),
  );
  app.use(oauth.routes());

  // --- MCP endpoint -----------------------------------------------------------
  const transports = new Map<string, TransportEntry>();
  const bearer = requireBearerAuth({
    verifier: oauth,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(oauth.resourceUrl)),
  });

  app.all('/mcp', rateLimit('mcp', 600), bearer, express.json({ limit: '64kb' }), async (req, res) => {
    const ghHash = (req.auth?.extra as { ghHash?: string } | undefined)?.ghHash;
    if (!ghHash) return void res.status(401).end();
    const sid = req.header('mcp-session-id');

    if (sid) {
      const entry = transports.get(sid);
      if (!entry) {
        return void res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
      }
      if (entry.ghHash !== ghHash) return void res.status(403).json({ jsonrpc: '2.0', error: { code: -32003, message: 'Forbidden' }, id: null });
      entry.lastRequest = Date.now();
      sessions.touchMcp(sid);
      return void (await entry.transport.handleRequest(req, res, req.body));
    }

    if (req.method === 'POST' && isInitializeRequest(req.body)) {
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, { transport, ghHash, lastRequest: Date.now() });
        },
        onsessionclosed: (id) => {
          // Clean shutdown: DELETE /mcp. Depart at once.
          transports.delete(id);
          void sessions.onMcpClosed(id);
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id && transports.delete(id)) void sessions.onMcpClosed(id);
      };
      const server = createMcpServer(sessions, () => transport.sessionId);
      await server.connect(transport);
      return void (await transport.handleRequest(req, res, req.body));
    }

    res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session' }, id: null });
  });

  const closeIdleTransports = () => {
    const now = Date.now();
    for (const e of transports.values()) {
      if (now - e.lastRequest > MCP_IDLE_CLOSE_MS) void e.transport.close();
    }
  };

  // --- Viewer tokens ------------------------------------------------------------
  const siteOrigin = new URL(cfg.siteUrl).origin;
  const cors = (req: Request, res: Response, next: NextFunction) => {
    res.set({
      'Access-Control-Allow-Origin': siteOrigin,
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '600',
      'Cache-Control': 'no-store',
    });
    if (req.method === 'OPTIONS') return void res.status(204).end();
    next();
  };

  const viewerResponse = async (info: { viewerSub: string; priestId: bigint; px: number }) => {
    const token = await keys.sign(
      { tt: 'viewer', role: 'viewer', px: info.px, pid: info.priestId.toString() },
      { aud: cfg.spacetimedbAudience, sub: info.viewerSub, ttlSeconds: VIEWER_TTL_S },
    );
    return {
      token,
      uri: cfg.spacetimedbUri,
      module: cfg.spacetimedbModule,
      px: info.px,
      priest_id: info.priestId.toString(),
      server_time: Date.now(),
      expires_at: Date.now() + VIEWER_TTL_S * 1000,
    };
  };

  app.use('/viewer-token', rateLimit('viewer', 60), cors);
  app.post('/viewer-token', express.json({ limit: '1kb' }), async (req, res) => {
    const info = await sessions.redeemTicket((req.body as { ticket?: unknown } | undefined)?.ticket);
    if (!info) return void res.status(410).json({ error: 'invalid_ticket' });
    res.json(await viewerResponse(info));
  });
  app.post('/viewer-token/refresh', async (req, res) => {
    const token = req.header('authorization')?.replace(/^Bearer /, '') ?? '';
    try {
      const claims = await keys.verify(token, 'viewer', cfg.spacetimedbAudience);
      if (isSpectator(claims.sub)) return void res.json(await viewerResponse({ viewerSub: String(claims.sub), priestId: 0n, px: Number(claims.px) || 0 }));
      const info = await sessions.viewerInfoForPriest(String(claims.sub), BigInt(String(claims.pid)));
      if (!info) return void res.status(410).json({ error: 'session_ended' });
      res.json(await viewerResponse(info));
    } catch {
      res.status(401).json({ error: 'invalid_token' });
    }
  });

  // A visitor with no link: a view-only token for a bay chosen at random, an occupied one
  // if there is any. It names no account and no priest, so the module shows it only what
  // every stranger sees: the public scene and pre-generated prayers.
  app.use('/spectator-token', rateLimit('spectator', 20), cors);
  app.post('/spectator-token', async (_req, res) => {
    res.json(await viewerResponse({ viewerSub: `${SPECTATOR_PREFIX}${randomUUID()}`, priestId: 0n, px: spectatorX(deps.occupiedXs?.() ?? []) }));
  });

  // --- Deleting an account ---------------------------------------------------------
  // The delete_account tool only hands out a one-time link to here. The account is deleted
  // when the person presses the button on this page, never by a tool call alone.
  const BAD_LINK = 'This link has already been used or has expired. Nothing was deleted. To try again, run /indulgence delete-account.';
  app.use('/delete-account', rateLimit('delete', 30));
  app.get('/delete-account', (req, res) => {
    const t = req.query.t;
    if (typeof t !== 'string' || !sessions.deletionPending(t)) return void res.status(410).set(PAGE_HEADERS).send(messagePage('/indulgence', BAD_LINK));
    res.status(200).set(PAGE_HEADERS).send(deleteAccountPage(t));
  });
  app.post('/delete-account', express.urlencoded({ extended: false, limit: '1kb' }), async (req, res) => {
    const body = req.body as { t?: unknown; decision?: unknown } | undefined;
    if (body?.decision !== 'delete') return void res.status(400).set(PAGE_HEADERS).send(messagePage('/indulgence', 'Nothing was deleted.'));
    const r = await sessions.confirmDeletion(body.t);
    if ('error' in r) {
      const gone = r.error === 'invalid_link';
      return void res
        .status(gone ? 410 : 503)
        .set(PAGE_HEADERS)
        .send(messagePage('/indulgence', gone ? BAD_LINK : 'The cathedral could not be reached, so nothing was deleted. Run /indulgence delete-account again in a moment.'));
    }
    console.log('[gate] an account was deleted');
    res.status(200).set(PAGE_HEADERS).send(messagePage('/indulgence', 'Your account is deleted. Any candles you lit keep burning until they go out.'));
  });

  // --- Misc ---------------------------------------------------------------------
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, spacetimedb: deps.isStoreReady(), live: sessions.liveCount(), transports: transports.size });
  });
  app.get('/', (_req, res) => {
    res.status(200).set(PAGE_HEADERS).send(messagePage('/indulgence', 'This is the gate. Install the Claude Code plugin and run /indulgence.', cfg.siteUrl));
  });

  return { app, closeIdleTransports, transportCount: () => transports.size };
}
