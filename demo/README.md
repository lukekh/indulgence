# Demo

A scripted, end-to-end run of /indulgence. Every run starts from nothing and cleans up after itself:

1. Starts a fresh in-memory SpacetimeDB on a free port and publishes `module/` to it.
2. Builds `web/` and serves it with `vite preview`.
3. Starts the real gate (`gate/src`), with GitHub replaced by a fake. It seats:
   - **you**;
   - three mutual friends praying (Hildegard, Anselm and Scholastica), whose real prayer text you can read;
   - two mutual friends who already left votive candles (Bede and Clare);
   - 18 strangers saying canned prayers.
   - the thurifer. The recording waits, up to two minutes, so that it processes past just after the cathedral opens.
4. Drives your session through the gate's real MCP tool handler (`begin`, `pray`, `depart`), so the terminal shows the real tool results. The Claude Code pane is a re-enactment: a real session would need a GitHub OAuth App and a deployed gate.
5. In the viewer, the mouse hovers over Hildegard to show her name, picks Anselm out in the key (crimson outline and name), then visits the two votives and the thurifer. Your priest walks up the side aisle, turns into its pew in profile, kneels and recites a sentence per line, then leaves to light its candle.

```sh
cd demo && npm install
npm run gif       # writes demo/out/indulgence-demo.gif (4–5 minutes)
npm run live      # plays the same scene in a visible Chrome window
npm run sandbox   # leaves the cathedral running and prints your viewer link; Ctrl+C to stop
npm run assets    # renders every asset to demo/out/assets/*.jpg (about 15 seconds)
```

Needs the SpacetimeDB CLI, Rust (the module is compiled for each run), Google Chrome, and ffmpeg for `gif`. Run `npm install` in `gate/` and `web/` first.

| Variable | Default | Effect |
| --- | --- | --- |
| `DEMO_WIDTH`, `DEMO_HEIGHT` | 1440, 900 | Stage size. 1440 × 900 draws the cathedral at 2×, 1920 × 1080 at 3× (a bigger GIF) |
| `DEMO_FPS` | 8 | Capture rate (priests move slowly) |
| `DEMO_DEPART_SPEED` | 3 | Playback speed of the slow walks (the rest of the walk in, and the departure) in the GIF |
| `DEMO_SEATED_MS` | 21000 | Real time spent watching your priest recite once it has sat down |
| `DEMO_LOGIN` | `you` | Your name tag |
| `DEMO_INTENTION` | `for the soul of my cat` | The intention typed into `/indulgence` |
| `DEMO_STRANGERS` | 18 | Size of the congregation |
| `DEMO_OUT` | `out/indulgence-demo.gif` | Output path |
| `DEMO_HEADLESS` | | `1` runs `live` headless (for CI) |
| `DEMO_KEEP_TMP` | | `1` keeps the run folder in `.cache/`: logs, raw frames, ffmpeg list |

Two stretches play at 3× speed in the GIF: the rest of your walk to the pew after the hover tour, and the departure from leaving the pew to the closing card. Everything else is real time, including the start of the slow walk in and your priest's recital once it sits down. A run takes about 5 minutes, most of it waiting for the votive-lighters to walk out and for the thurifer to come round.

## Asset sheets

`npm run assets` draws each asset with the viewer's own code and saves a JPEG sheet of it to `out/assets/`. Each sheet shows the asset in game (candlelit and dithered) above the same thing raw (flat greys, before lighting and the dither), scaled up by whole pixels:

| File | What |
| --- | --- |
| `cathedral.jpg`, `cathedral-raw.jpg` | The whole empty view, as on a 1440 × 900 screen |
| `altar.jpg` | Altar, cross and candlesticks before the reredos |
| `pews.jpg` | Three rows of pews between the side aisles |
| `window-light.jpg` | A pool of stained-glass window light down the nave, in game and on its own at 5× strength |
| `votive-stand.jpg` | A stand with tapers, votives, pillars and paschal candles, lit |
| `priest-friar.jpg`, `priest-priest.jpg`, `priest-bishop.jpg`, `priest-cardinal.jpg` | Each vestment in every pose: up the aisle, kneeling, along the pew both ways (profile), walking out, lighting a candle |
| `thurifer.jpg` | The thurifer at three points of the thurible's swing |
| `priests.jpg` | Every vestment from behind and from the front, and the thurifer |

It serves `demo/assets/` with Vite (sprites and font from `web/public/`) and saves each sheet from headless Chrome, so it needs `npm install` in `web/` as well as here, but no SpacetimeDB or Rust.
