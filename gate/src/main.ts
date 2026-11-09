// Gate entry point.

import { loadConfig } from './config.js';
import { Keys } from './keys.js';
import { DeferredStore } from './deferred-store.js';
import { StdbStore } from './stdb.js';
import { SessionManager } from './sessions.js';
import { GateOAuthProvider } from './oauth/provider.js';
import { RealGitHub } from './oauth/github.js';
import { createApp } from './server.js';

const cfg = loadConfig();
const keys = await Keys.create(cfg);
const store = new DeferredStore();
const sessions = new SessionManager(store, cfg.siteUrl);
const oauth = new GateOAuthProvider({
  keys,
  store,
  github: new RealGitHub(cfg.githubClientId, cfg.githubClientSecret),
  publicUrl: cfg.publicUrl,
  devSkipAgeCheck: cfg.devSkipAgeCheck,
  allowedRedirectOrigins: cfg.allowedRedirectOrigins,
});
sessions.onForgotten = (ghHash) => oauth.markForgotten(ghHash);

const { app, closeIdleTransports } = createApp({ cfg, keys, oauth, sessions, isStoreReady: () => store.isReady() });
const http = app.listen(cfg.port, cfg.host, () => {
  console.log(`[gate] listening on ${cfg.host}:${cfg.port} as ${cfg.publicUrl}`);
});

// Connect to SpacetimeDB once our OIDC endpoints are reachable; retry until it works.
async function connect(attempt = 1): Promise<void> {
  try {
    const stdb = await StdbStore.connect(cfg, keys);
    store.attach(stdb);
    shutdownHooks.push(() => stdb.disconnect());
  } catch (e) {
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
    console.error(`[gate] SpacetimeDB connection failed (${(e as Error).message}); retrying in ${delay} ms`);
    await new Promise((r) => setTimeout(r, delay));
    return connect(attempt + 1);
  }
}
const shutdownHooks: (() => void)[] = [];
void connect();

const ticker = setInterval(() => {
  void sessions.tick();
  closeIdleTransports();
}, 5000);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[gate] ${signal}: departing live sessions`);
  clearInterval(ticker);
  http.close();
  await Promise.race([sessions.shutdown(), new Promise((r) => setTimeout(r, 10_000))]);
  for (const h of shutdownHooks) h();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
