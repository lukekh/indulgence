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

```sh
cd demo && npm install
npm run gif       # writes demo/out/indulgence-demo.gif (4–5 minutes)
npm run live      # plays the same scene in a visible Chrome window
npm run sandbox   # leaves the cathedral running and prints your viewer link; Ctrl+C to stop
```

Needs the SpacetimeDB CLI, Rust (the module is compiled for each run), Google Chrome, and ffmpeg for `gif`. Run `npm install` in `gate/` and `web/` first.

| Variable | Default | Effect |
| --- | --- | --- |
| `DEMO_WIDTH`, `DEMO_HEIGHT` | 1440, 900 | Stage size. 1440 × 900 draws the cathedral at 3×, 1000 × 660 at 2× (a smaller GIF) |
| `DEMO_FPS` | 8 | Capture rate (priests move slowly) |
| `DEMO_DEPART_SPEED` | 2 | Playback speed of the departure in the GIF |
| `DEMO_LOGIN` | `you` | Your name tag |
| `DEMO_INTENTION` | `for the soul of my cat` | The intention typed into `/indulgence` |
| `DEMO_STRANGERS` | 18 | Size of the congregation |
| `DEMO_OUT` | `out/indulgence-demo.gif` | Output path |
| `DEMO_HEADLESS` | | `1` runs `live` headless (for CI) |
| `DEMO_KEEP_TMP` | | `1` keeps the run folder in `.cache/`: logs, raw frames, ffmpeg list |

The departure, from leaving the pew to the closing card, plays at 2× speed in the GIF. Everything else is real time, including the slow walk in. A run takes about 4 to 5 minutes, most of it waiting for the votive-lighters to walk out and for the thurifer to come round.
