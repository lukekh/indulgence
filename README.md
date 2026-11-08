# indulgence
𝔖𝔬𝔟𝔞𝔩𝔡 𝔡𝔞𝔰 𝔗𝔬𝔨𝔢𝔫 𝔦𝔪 𝔎𝔬𝔫𝔱𝔢𝔵𝔱 𝔨𝔩𝔦𝔫𝔤𝔱, 𝔡𝔦𝔢 𝔖𝔢𝔢𝔩𝔢 𝔞𝔲𝔰 𝔡𝔢𝔪 𝔉𝔢𝔤𝔢𝔣𝔢𝔲𝔢𝔯 𝔰𝔭𝔯𝔦𝔫𝔤𝔱.

`/indulgence` is a satirical Claude Code plugin. It spends your own model tokens on Latin prayers, which a pixel-art priest recites in a shared cathedral that goes on forever sideways. When the budget runs out or you leave, the priest lights a candle and walks out. The candle burns for about a day.

![A /indulgence session: the gate boots, /indulgence runs, and in a dark, candlelit cathedral your priest walks slowly up the side aisle to kneel with three friends near two friends' votives while a thurifer swings incense past; then it lights a candle and leaves](demo/out/indulgence-demo.gif)

Regenerate this recording with `cd demo && npm run gif` (see [`demo/`](demo)).

The design is in [`indulgence — Technical Spec.md`](indulgence%20—%20Technical%20Spec.md). This repository implements it with SpacetimeDB Maincloud as the database. [Differences from the spec](#differences-from-the-spec) lists where it departs and why.

## Layout

| Path | What | Tech |
| --- | --- | --- |
| [`shared/`](shared) | Geometry, pacing and spend constants, plus the canned prayers. One source for all three runtimes | JSON (+ TS wrapper; Rust reads it in `build.rs`) |
| [`module/`](module) | SpacetimeDB module: tables, reducers, scheduled jobs, seating, per-viewer views | Rust, `spacetimedb` 2.14 |
| [`gate/`](gate) | Gate: remote MCP server, OAuth 2.1 authorization server (GitHub sign-in), OIDC issuer for SpacetimeDB JWTs, spend, pacing, disconnect detection, viewer tickets | TypeScript on Node 22, MCP SDK 1.32, `jose`, SpacetimeDB SDK |
| [`web/`](web) | Viewer: full-screen, candlelit isometric Canvas 2D renderer with LPC sprites, the thurifer, field-of-view subscription, hover cards, canned prayers | TypeScript, Vite, SpacetimeDB SDK |
| [`demo/`](demo) | Scripted end-to-end demo: boots everything from scratch, then records a GIF, plays it in Chrome, or leaves a sandbox running | TypeScript, Playwright, ffmpeg |
| [`plugin/`](plugin) | Claude Code plugin: `/indulgence` command, `priest` subagent, remote MCP registration. Markdown and JSON only | |
| [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) | Marketplace, so the repo installs with `/plugin marketplace add lukekh/indulgence` | |

## Answers to the spec's open items

- **Does Claude Code support MCP sampling?** No. Claude Code doesn't declare the `sampling` capability, and [anthropics/claude-code#1785](https://github.com/anthropics/claude-code/issues/1785) is still open. Claude Code users get the **subagent tier**. The sampling path (`vigil`) is implemented and tested for clients that support it.
- **Do plugin subagents receive CLAUDE.md?** Yes, unless the agent sets `omitClaudeMd: true`, which `agents/priest.md` does. Its only tool is `pray`.
- **SpacetimeDB row-level security?** It isn't usable. In 2.14, `client_visibility_filter` sits behind the `unstable` feature, and the source documents it as "currently unimplemented, and not enforced". The per-viewer data uses SpacetimeDB **views** instead (see below). The spec's custom-WebSocket fallback isn't needed.
- **Plugin layout and timeouts:** the layout is `.claude-plugin/plugin.json`, a root `.mcp.json`, `commands/` and `agents/`, and `claude plugin validate` passes. Plugin MCP tools are named `mcp__plugin_indulgence_indulgence__<tool>`. Claude Code's HTTP MCP idle timeout is 5 minutes, and progress notifications count as activity, so `vigil` sends one per accepted prayer. The hard per-call limit (`MCP_TOOL_TIMEOUT`) defaults to about 28 hours.
- **Hosting:** SpacetimeDB Maincloud. The gate runs anywhere it can serve public HTTPS.

## Running locally

Prerequisites: Node 22+, the [SpacetimeDB CLI](https://spacetimedb.com/install) (2.14), and Rust with the `wasm32-unknown-unknown` target. `module/rust-toolchain.toml` pins Rust 1.99, the minimum for `spacetimedb` 2.14 is 1.97, and rustup installs the pin automatically without touching your default toolchain.

```sh
(cd gate && npm install) && (cd web && npm install) && (cd demo && npm install)
cd demo
npm run sandbox   # fresh local SpacetimeDB + module + viewer + gate, seeded with friends; prints your viewer link
npm run live      # the scripted demo in a visible Chrome window
npm run gif       # the scripted demo, recorded to demo/out/indulgence-demo.gif
```

The demo needs no GitHub OAuth App or Claude Code. To run the real gate locally, see `gate/.env.example`. Use `GATE_PUBLIC_URL=http://localhost:8787`, and point the plugin at it with `INDULGENCE_GATE_URL=http://localhost:8787 claude`.

SpacetimeDB caches the gate's JWKS for about 5 minutes. When the gate's key changes (a new dev key, a rotation), SpacetimeDB refuses its tokens until the cache refreshes. The gate retries until it connects, and in development it saves its key to `gate/.dev-signing-key.pem` so restarts reuse it.

## Tests

```sh
(cd module && cargo test)          # seating, stands, tiers: 14 tests, including the acceptance properties
(cd gate && npm test)              # safety filters, sessions/pacing/disconnects, tool-result property test, full OAuth+MCP HTTP flow: 65 tests
(cd web && npm test)               # projection and movement: 8 tests
(cd gate && npm run test:stdb)     # 17 checks against a real SpacetimeDB (setup in the header of gate/test-integration/stdb.it.ts)
```

How the spec's acceptance checks are covered:

| Check | Where |
| --- | --- |
| No tool result contains user-written text | `gate/test/tool-results.test.ts`: about 900 randomized calls across all tools, with marked input in every argument |
| A viewer JWT cannot call reducers or see others' `viewer_label`/`prayer_text` | `stdb.it.ts` checks 7, 8, 10, 11 |
| Two mutuals joining one after the other share a bay; with 3+ mutuals the newcomer is within 4 tiles of one | `module/src/geometry.rs` tests and `stdb.it.ts` check 5 |
| Killing Claude Code departs the priest within 180 s, and a candle appears | `sessions.test.ts` (silence, cancellation, `DELETE /mcp`) and `stdb.it.ts` check 14 |
| A candle expires within 5 minutes of `expires_at` | `expire_candles` runs every 5 minutes on an indexed range. Not integration-tested, because the shortest burn is 24 h |
| After `forget`, no table holds the user's identity or hashes | `stdb.it.ts` check 15 (owner SQL over the private tables) |

## Deploying on Maincloud

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

## The look

- **Full screen.** The viewer fills the window. Its 480 × 270 pixel-art canvas is scaled up by a whole number (3× at 1440 × 900) and then grown to cover the screen, so wider windows see more of the nave. A tall back wall with lancet, rose and clerestory windows rises behind the altars, and the floor continues past the door.
- **From the entrance.** The camera looks from the door toward the altar. Priests come in through the door, along the back of the nave and up the side aisle on their half, then side-step into their pew. All of that is seen from behind. They turn around only when they leave: along the pew, to the votive stand beside the aisle, where they kneel, light their candle and walk out toward the camera.
- **Slowly.** Priests walk at 1 tile per second, and the thurifer at 0.75. The candle is lit 20 s after a priest leaves its pew, and the priest is gone by 42 s.
- **Four long pews** per bay span the nave between the side aisles. They are plain wood in a muted, unsaturated brown.
- **Dark.** A light map dims everything to about a third of full brightness. The candles let warm, flickering pools of light through: one on every pew end, sconces on the arcade columns, two on each altar, the votive stands, and the glowing thurible. Faint cool light falls through the windows.
- **The thurifer.** A server in cassock and surplice processes along the front of the nave, swinging a smoking thurible. It isn't stored anywhere: its position is a pure function of server time, so every viewer sees the same procession, and it passes any spot exactly every two minutes. Hover over it for the incensation prayer.
- **Sprites** are simple robes composed from the Universal LPC generator by `web/scripts/build-sprites.py`. Recipes, regeneration and credits are in [`web/public/sprites/README.md`](web/public/sprites/README.md).

## Differences from the spec

- **Per-viewer tables are views, not row-level security.** RLS isn't enforced in SpacetimeDB 2.14. `viewer_label` and `prayer_text` are now public **views** over private tables (`viewer_label_store`, `prayer_text_store`), filtered on `ctx.sender()`. The client's subscription SQL is unchanged.
- **Module configuration.** The module reads `INDULGENCE_ISSUER` and `INDULGENCE_AUDIENCE` as SpacetimeDB 2.x publish-time environment variables. `client_connected` refuses every connection except the database owner and tokens from that issuer and audience. The gate's identity enters `gate_service` automatically when it connects with `role: "gate"`, `sub: "gate"`.
- **Extra columns and tables.** These are `priest.candle_id`, so the client knows which candle the priest walks to; a private `candle_owner`, so `forget` can find candles without a public owner column; `owner`; and a `touch_account` reducer, which refreshes tokens only for accounts that still exist. The consent screen is triggered when `upsert_account` with no name choice fails with `consent_required`.
- **Seating.** Before scoring, the candidate seats narrow to those within 4 tiles of some mutual whenever any exist. With two mutuals far apart, every seat between them has the same distance sum, so the formula alone can seat you in empty space between them. With 3+ mutuals, "within 4 tiles of one of them" can only be guaranteed while such a seat is free, and the property test checks exactly that.
- **Pace and routes.** Priests walk at 1 tile/s instead of 4, so `CANDLE_LIT_AFTER_MS` is 20 s (was 8) and `PRIEST_REMOVE_AFTER_MS` is 42 s (was 20). The pews no longer split at a centre aisle: they run continuously between the side aisles, and priests walk the side aisles. Seat coordinates and the seating algorithm are unchanged; the three middle tiles of each pew simply have no seats.
- **Done on the last prayer.** `pray` returns `done: true` on the call that exhausts the budget, rather than on the call after it, so the model doesn't write a prayer that would be thrown away. The priest still departs once that prayer's 20-second slot ends.
- **Runaway protection.** After 10 rejected prayers in a row the session ends, so a model that keeps writing rejected text can't run forever without being charged. A rejected `pray` is held for 3 seconds.
- **Leak filter.** Besides the spec's list, it rejects parentheses, angle brackets ("brackets" in the British sense) and `` ` | $ # * ^ ~ ``. The prompts tell the model to avoid them, and the semicolon.
- **Denylist and wordlist.** The denylist is [LDNOOBW](https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words) (CC BY 4.0, 27 languages), minus entries that are ordinary Latin words, such as *cum*, *regina*, *vacca* and *satan*. The Latin wordlist is the 20,000 most frequent word forms in the public-domain Clementine Vulgate ([eBible.org](https://ebible.org/Scriptures/latVUC_readaloud.zip)), plus the canned prayers. Rebuild both with `npm run build:data` in `gate/`.
- **GitHub token.** The gate revokes the user's GitHub token (`DELETE /applications/{id}/token`) rather than just discarding it.
- **Stateless OAuth.** Client registrations, access tokens and refresh tokens are signed, not stored, so redeploying the gate signs no one out. A refreshed refresh token keeps its original 30-day expiry, which keeps the spec's "edges at most 30 days stale". Authorization codes, consent screens, live sessions and viewer tickets are in memory. After a gate restart, live priests are departed by `reap_stale` within 5 minutes, and on SIGTERM the gate departs them at once.
- **CSP.** The viewer's Content-Security-Policy needs `'unsafe-eval'`, because the SpacetimeDB SDK compiles its (de)serialisers with `Function()`. The generated code comes from the schema, never from data, and no database string reaches the DOM.

## Licence

MIT for the code. Bundled data: canned prayers and the Vulgate wordlist are in the public domain, and the denylist derives from LDNOOBW (CC BY 4.0). LPC sprites, once added, carry their own licences (see `web/public/sprites/`).
