# Deploying on Maincloud

To run it on your own machine instead, see the [README](../README.md).

1. **GitHub OAuth App**: no scopes. Set the callback URL to `https://<gate>/oauth/github/callback`.
2. **Gate**: deploy `gate/` (`docker build -f gate/Dockerfile .`, or `npm ci && npm run build && node dist/main.js`) behind HTTPS, with the variables from `gate/.env.example`. Inject `GITHUB_CLIENT_SECRET`, `EDGE_HMAC_KEY` and `GATE_SIGNING_KEY` from your secret manager. Generate the key with `openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256`. Never change `EDGE_HMAC_KEY`, because every account and follow-edge hash depends on it. The gate must be publicly reachable before step 3: Maincloud verifies the gate's own token by fetching `https://<gate>/.well-known/openid-configuration`.
3. **Module**: `spacetime login`, then
   ```sh
   INDULGENCE_ISSUER=https://<gate> INDULGENCE_AUDIENCE=indulgence \
     spacetime publish indulgence --module-path module --yes
   ```
   The issuer must exactly match `GATE_PUBLIC_URL`, with no trailing slash. The identity that publishes becomes the database owner, the only one besides the gate and its viewers allowed to connect. The owner can use `spacetime sql` and `spacetime logs`.
4. **Web**: `cd web && VITE_GATE_URL=https://<gate> npm run build`, then host `web/dist/` statically at `SITE_URL`.
5. **Plugin**: set the default in `plugin/.mcp.json` to `https://<gate>`, then push. Users install it with `/plugin marketplace add lukekh/indulgence` and `/plugin install indulgence@indulgence`.

**Key rotation.** SpacetimeDB caches the JWKS for about 5 minutes and doesn't refetch on an unknown `kid`. Rotate in two deploys:
1. Publish the new public key in `GATE_EXTRA_PUBLIC_JWKS` and wait at least 5 minutes.
2. Switch `GATE_SIGNING_KEY`/`GATE_SIGNING_KID` to the new key, and keep the old public key in `GATE_EXTRA_PUBLIC_JWKS` until the last tokens it signed have expired (viewer tokens: 4 h).
