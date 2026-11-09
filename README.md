# indulgence
𝔖𝔬𝔟𝔞𝔩𝔡 𝔡𝔞𝔰 𝔗𝔬𝔨𝔢𝔫 𝔦𝔪 𝔎𝔬𝔫𝔱𝔢𝔵𝔱 𝔨𝔩𝔦𝔫𝔤𝔱, 𝔡𝔦𝔢 𝔖𝔢𝔢𝔩𝔢 𝔞𝔲𝔰 𝔡𝔢𝔪 𝔉𝔢𝔤𝔢𝔣𝔢𝔲𝔢𝔯 𝔰𝔭𝔯𝔦𝔫𝔤𝔱.

`/indulgence` is a satirical Claude Code plugin. It spends your own model tokens on Latin prayers, which a pixel-art priest recites in a shared cathedral that goes on forever sideways. When the budget runs out or you leave, the priest lights a candle and walks out. The candle burns for about a day.

![A /indulgence session: the gate boots and /indulgence runs; then, looking straight up a dark, dithered nave toward the altar, your priest walks slowly up the side aisle and along its pew to kneel near three friends while a thurifer swings incense across the front and a coloured shaft of light falls on the pews; finally it lights a candle and leaves](demo/out/indulgence-demo.gif)

Regenerate this recording with `npm run gif` (see [`demo/`](demo)). Sheets of every asset (the cathedral, altar, pews, votive stand, each priest and the thurifer, in game and raw) are in [`demo/out/assets/`](demo/out/assets); regenerate them with `npm run assets`.

The design is in [`indulgence — Technical Spec.md`](indulgence%20—%20Technical%20Spec.md). This repository implements it with SpacetimeDB Maincloud as the database. [Differences from the spec](#differences-from-the-spec) lists where it departs and why.

## Layout

| Path | What | Tech |
| --- | --- | --- |
| [`shared/`](shared) | Geometry, pacing and spend constants, plus the canned prayers. One source for all three runtimes | JSON (+ TS wrapper; Rust reads it in `build.rs`) |
| [`module/`](module) | SpacetimeDB module: tables, reducers, scheduled jobs, seating, per-viewer views | Rust, `spacetimedb` 2.14 |
| [`gate/`](gate) | Gate: remote MCP server, OAuth 2.1 authorization server (GitHub sign-in), OIDC issuer for SpacetimeDB JWTs, spend, pacing, disconnect detection, viewer tickets | TypeScript on Node 22, MCP SDK 1.32, `jose`, SpacetimeDB SDK |
| [`web/`](web) | Viewer: full-screen, front-facing, Obra Dinn–style dithered Canvas 2D renderer with LPC sprites, the thurifer, field-of-view subscription, hover details, canned prayers | TypeScript, Vite, SpacetimeDB SDK |
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

From the repo root (the demo scripts run in `demo/`, so `cd demo` first works too):

```sh
npm run install:all   # npm install in gate/, web/ and demo/
npm run sandbox       # fresh local SpacetimeDB + module + viewer + gate, seeded with friends; prints your viewer link
npm run live          # the scripted demo in a visible Chrome window
npm run gif           # the scripted demo, recorded to demo/out/indulgence-demo.gif
npm run quick         # ~25 s of the cathedral with your priest praying, for quick visual checks (about a minute)
npm run assets        # asset sheets, rendered to demo/out/assets/*.jpg
npm test              # gate and web unit tests
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

- **Straight up the nave.** The camera stands at the back of the cathedral looking toward the altar. Pews are horizontal and parallel, stacked up the screen, with your bay's altar at the very top. The view repeats without end: neighbouring bays continue to the left and right, and the pews run on past the bottom of the screen, so you never see where the cathedral begins.
- **Obra Dinn–style dither.** The scene is drawn in plain greys with hard ink outlines. It is then candlelit and reduced, pixel by pixel, to four dark greys with a 4 × 4 Bayer ordered dither, like an 8-bit game. The pixel-art canvas is about 640 × 360, scaled up by a whole number to fill the window.
- **Dark, with colour only from the windows.** The only colour is window light, laid over the dithered scene as a soft, low-opacity glow (14% on the floor, 3% in the rays) in narrow bands of rose, orange, green and blue, as if through stained glass. Each pool covers 3 to 4 rows of pews, from a third of the way along the pews from its window to the far wall, with faint rays, one per colour of glass, slanting down onto it from the window. It is arranged around your own bay: two pools down your column of pews with 5 rows between, and one in each column beside it, lying in that gap. Elsewhere there is dim light from a candle on every pew end, the altar candles and the votive stands.
- **Priests from behind.** Priests come up the side aisles from below the screen, seen from behind, turn into their pews and walk along them in profile, then turn to kneel facing the altar. Leaving, they walk back along the pew in profile, go to the votive stand in the arcade, kneel, light a candle and walk back down out of view toward the camera. They walk at a solemn 1 tile per second. Each sprite has a pale outline so it reads against the dark.
- **Window light on the priests.** The side of each figure that faces the windows catches their light, for a faux-3D look: a faint pale edge everywhere, and an edge in the glass colour where it kneels or walks in a pool of light. In your bay and those to its left the windows are on the left; bays to your right take their light from the right. It is drawn after the dither, so it stays crisp.
- **Votive stands face your pews.** The stands in the arcades on either side of your column of pews step up away from it, so both face in toward you.
- **Prayers written over the scene**, with no bubbles, in Grenze Gotisch, a readable blackletter. A priest starts reciting only once it has sat down in its pew. The prayer is typed a clause at a time: the model's own line breaks are ignored, and every comma or full stop starts a new line, so no line runs too long. When a new line begins, the one before it rises above it at 50% opacity, sways a couple of pixels as it drifts off, and is gone after 2 s, or straight away if a third line starts first. Prayers are white for everyone except your own priest, which speaks in gold with the TuringOS shimmer: a pale band sweeping through the gold every 3.4 s over a soft gold glow.
- **Gold titles over the scene.** As the cathedral first appears, *Indulgence* and *Mea Culpa, Pater* are written over it in shimmering gold for five seconds, then fade. When your priest has lit its candle and gone, *Ite, missa est* and *Your votive is lit. Deo gratias.* are written over the cathedral the same way, and it carries on behind them.
- **Repudiationes · Merita.** The bottom left holds two words, which turn crimson under the mouse. Each opens a panel over the cathedral, in Latin first with English a click away: the disclaimers, and the credits for every open-source asset and library. Its close button reads *Claude*, which is Latin for "close!".
- **Names on hover, and the key.** Other priests' names appear only while the mouse is over them, written under the priest and named for its vestment (*Hildegard's bishop*, or *a friar* for a stranger) so they are never mistaken for its prayers; your own is always marked the same way in gold (*Your priest*, *Your cardinal*). A small key at the top right lists the friends (mutuals) currently in the cathedral. Click a name there to pick that friend out: a crimson outline round their priest, and their name and prayers written in crimson, until you click it again. Clicking a priest in the scene still mutes or unmutes it.
- **The thurifer.** A server in a light grey habit with a gold rope belt walks across the front of the nave, swinging a smoking thurible. Its position is a pure function of server time, so every viewer sees the same procession, and it passes any spot every two minutes.
- **Sprites** are simple robes composed from the Universal LPC generator: a brown habit for the friar, and one cut of cassock for the priest (black), bishop (white) and cardinal (red, with a scarlet zucchetto), and the friar's habit in light grey with a gold rope belt for the thurifer. They are composed by `web/scripts/build-sprites.py` (see [`web/public/sprites/README.md`](web/public/sprites/README.md)).

## Differences from the spec

- **Per-viewer tables are views, not row-level security.** RLS isn't enforced in SpacetimeDB 2.14. `viewer_label` and `prayer_text` are now public **views** over private tables (`viewer_label_store`, `prayer_text_store`), filtered on `ctx.sender()`. The client's subscription SQL is unchanged.
- **Module configuration.** The module reads `INDULGENCE_ISSUER` and `INDULGENCE_AUDIENCE` as SpacetimeDB 2.x publish-time environment variables. `client_connected` refuses every connection except the database owner and tokens from that issuer and audience. The gate's identity enters `gate_service` automatically when it connects with `role: "gate"`, `sub: "gate"`.
- **Extra columns and tables.** These are `priest.candle_id`, so the client knows which candle the priest walks to; a private `candle_owner`, so `forget` can find candles without a public owner column; `owner`; and a `touch_account` reducer, which refreshes tokens only for accounts that still exist. The consent screen is triggered when `upsert_account` with no name choice fails with `consent_required`.
- **Seating.** Before scoring, the candidate seats narrow to those within 4 tiles of some mutual whenever any exist. With two mutuals far apart, every seat between them has the same distance sum, so the formula alone can seat you in empty space between them. With 3+ mutuals, "within 4 tiles of one of them" can only be guaranteed while such a seat is free, and the property test checks exactly that.
- **View, rows and pace.** The view is a front-facing 3/4 projection (16 × 12 px tiles), not the spec's 2:1 isometric one. Each bay has 8 rows of pews (128 seats, soft cap 96) instead of 4, with empty pews drawn beyond them without end. The pews run continuously between the side aisles, and priests walk the side aisles; the three middle tiles of each pew have no seats. Priests walk at 1 tile/s instead of 4, so `CANDLE_LIT_AFTER_MS` is 26 s (was 8) and `PRIEST_REMOVE_AFTER_MS` is 48 s (was 20). The public `priest` row gains `entered_at`, so a viewer that connects mid-walk sees the priest finish its walk rather than jump to its pew.
- **Done on the last prayer.** `pray` returns `done: true` on the call that exhausts the budget, rather than on the call after it, so the model doesn't write a prayer that would be thrown away. The priest still departs once that prayer's 20-second slot ends.
- **Runaway protection.** After 10 rejected prayers in a row the session ends, so a model that keeps writing rejected text can't run forever without being charged. A rejected `pray` is held for 3 seconds.
- **Leak filter.** Besides the spec's list, it rejects parentheses, angle brackets ("brackets" in the British sense) and `` ` | $ # * ^ ~ ``. The prompts tell the model to avoid them, and the semicolon.
- **Denylist and wordlist.** The denylist is [LDNOOBW](https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words) (CC BY 4.0, 27 languages), minus entries that are ordinary Latin words, such as *cum*, *regina*, *vacca* and *satan*. The Latin wordlist is the 20,000 most frequent word forms in the public-domain Clementine Vulgate ([eBible.org](https://ebible.org/Scriptures/latVUC_readaloud.zip)), plus the canned prayers. Rebuild both with `npm run build:data` in `gate/`.
- **GitHub token.** The gate revokes the user's GitHub token (`DELETE /applications/{id}/token`) rather than just discarding it.
- **Stateless OAuth.** Client registrations, access tokens and refresh tokens are signed, not stored, so redeploying the gate signs no one out. A refreshed refresh token keeps its original 30-day expiry, which keeps the spec's "edges at most 30 days stale". Authorization codes, consent screens, live sessions and viewer tickets are in memory. After a gate restart, live priests are departed by `reap_stale` within 5 minutes, and on SIGTERM the gate departs them at once.
- **CSP.** The viewer's Content-Security-Policy needs `'unsafe-eval'`, because the SpacetimeDB SDK compiles its (de)serialisers with `Function()`. The generated code comes from the schema, never from data, and no database string reaches the DOM.

## Licence

MIT for the code. Third-party assets and libraries, also credited in the viewer under *Merita*:

- **Sprites:** composed with the [Universal LPC Spritesheet Character Generator](https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator) from Liberated Pixel Cup and OpenGameArt.org art. Used under OGA-BY 3.0, which every layer offers (most also offer CC-BY-SA 3.0 and GPL 3.0). Each layer's artists, licences and sources are listed in [`web/public/sprites/CREDITS.txt`](web/public/sprites/CREDITS.txt).
- **Type:** [Grenze Gotisch](https://github.com/Omnibus-Type/Grenze-Gotisch) by Omnibus-Type, under the SIL Open Font License 1.1 ([`web/public/fonts/OFL.txt`](web/public/fonts/OFL.txt)).
- **Data:** the canned prayers are traditional texts in the public domain. The Latin wordlist comes from the public-domain Clementine Vulgate (via eBible.org), and the denylist derives from [LDNOOBW](https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words) (CC BY 4.0).
- **Libraries:** SpacetimeDB by Clockwork Labs (TypeScript SDK under ISC, Rust crate under Apache 2.0), the Model Context Protocol TypeScript SDK (MIT), jose (MIT), Express (MIT) and Vite (MIT). The demo uses Playwright (Apache 2.0) and FFmpeg.
- **Gold shimmer:** borrowed from TuringOS.
