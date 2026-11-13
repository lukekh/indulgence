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
5. In the viewer, *Indulgence* is written over the cathedral as it opens. The mouse hovers over Hildegard to show her name, picks Anselm out in the key (crimson outline, name and prayers), visits the two votives and the thurifer, then opens *Repudiationes* (in Latin, then English) and *Merita*. Your priest walks up the side aisle, turns into its pew in profile, kneels and recites a clause per line, then leaves to light its candle, and *Ite, missa est* is written over the cathedral.

```sh
cd demo && npm install
npm run gif       # writes demo/out/indulgence-demo.gif (about 3 minutes)
npm run quick     # writes demo/out/quick.gif: 25 s of the cathedral with your priest praying (about 1 minute)
npm run live      # plays the same scene in a visible Chrome window
npm run sandbox   # leaves the cathedral running and prints your viewer link; Ctrl+C to stop
npm run assets    # renders every asset to demo/out/assets/*.jpg (about 15 seconds)
```

Needs the SpacetimeDB CLI, Rust (the module is compiled for each run), Google Chrome, and ffmpeg for `gif`. Run `npm install` in `gate/` and `web/` first.

| Variable | Default | Effect |
| --- | --- | --- |
| `DEMO_WIDTH`, `DEMO_HEIGHT` | 1440, 900 | Stage size. 1440 × 900 draws the cathedral at 2×, 1920 × 1080 at 3× (a bigger GIF) |
| `DEMO_FPS` | 7 | Capture rate (priests move slowly) |
| `DEMO_DEPART_SPEED` | 4 | Playback speed of the slow walks (the rest of the walk in, and the departure) in the GIF |
| `DEMO_SEATED_MS` | 13000 | Real time spent watching your priest recite once it has sat down |
| `DEMO_QUICK_MS` | 25000 | Length of the `quick` recording |
| `DEMO_LOGIN` | `you` | Your GitHub login in the demo (the name your friends see) |
| `DEMO_INTENTION` | `for the soul of my cat` | The intention typed into `/indulgence` |
| `DEMO_STRANGERS` | 18 | Size of the congregation |
| `DEMO_OUT` | `out/indulgence-demo.gif` | Output path |
| `DEMO_HEADLESS` | | `1` runs `live` headless (for CI) |
| `DEMO_KEEP_TMP` | | `1` keeps the run folder in `.cache/`: logs, raw frames, ffmpeg list |

Two stretches play at 4× speed in the GIF: the rest of your walk to the pew after the hover tour, and the departure from leaving the pew to the closing card. Everything else is real time, including the start of the slow walk in and your priest's recital once it sits down.

### Why it takes a few minutes, and the shortcuts

Most of a run is real time: priests walk at a solemn 1 tile per second, and the server removes a departing priest 48 s after it stands. Two waits are cut short:

- **The thurifer.** It passes any spot every two minutes, as a function of the clock. The demo builds the viewer with `VITE_DEMO_THURIFER_SHIFT_MS`, which shifts the procession so one is crossing the front of your bay when the tour reaches it. Production builds leave it at zero.
- **The votive-lighters.** Bede and Clare must have walked out before the cathedral appears, which takes about 50 s. The terminal scene plays during the last 11 s of that wait.

`npm run quick` skips the terminal, the tour and the departure. Your priest starts walking in while the congregation is seated, and the recording opens on the cathedral just before it sits down. It runs about 25 s, with a friend hovered, Anselm picked out in the key and a thurifer passing, so a visual change can be checked in about a minute. `npm run assets` (15 s) covers anything that doesn't move. The output, `out/quick.gif`, is not committed.

## Asset sheets

`npm run assets` draws each asset with the viewer's own code and saves a JPEG sheet of it to `out/assets/`. Each sheet shows the asset in game (candlelit and dithered) above the same thing raw (flat greys, before lighting and the dither), scaled up by whole pixels:

| File | What |
| --- | --- |
| `cathedral.jpg`, `cathedral-raw.jpg` | The whole empty view, as on a 1440 × 900 screen |
| `altar.jpg` | Altar, cross and candlesticks before the reredos |
| `pews.jpg` | Three rows of pews between the side aisles |
| `window-light.jpg` | The stained-glass window light around your bay, in game and on its own at 5× strength |
| `stained-glass.jpg` | All fifteen window designs, crisp and upright as designed |
| `stained-glass-floor.jpg` | Each design as its light lies on the floor of your bay, in game and on its own at 5× |
| `votive-stand.jpg` | The stands either side of your pews, both facing in, with tapers, votives, pillars and paschal candles, lit |
| `votive-close-up.jpg` | The close-up of a stand you get by clicking it, in its carved stone archway: candles of every size at every stage of burning |
| `votive-old-wax.jpg` | Three empty stands, each with old wax generated from a hash of where it stands |
| `../candle-melt.gif` | A 10 s hyperlapse of that close-up: a candle of each size burning down over 72 hours |
| `window-rim.jpg` | The window light on the side of each figure: in the pews with and without it, and close up without it, with the faint edge, and in a pool of light |
| `priest-friar.jpg`, `priest-priest.jpg`, `priest-bishop.jpg`, `priest-cardinal.jpg` | Each vestment in every pose: up the aisle, kneeling, along the pew both ways (profile), walking out, lighting a candle |
| `thurifer.jpg` | The thurifer at three points of the thurible's swing |
| `priests.jpg` | Every vestment from behind and from the front, and the thurifer |

It serves `demo/assets/` with Vite (sprites and font from `web/public/`) and saves each sheet from headless Chrome, so it needs `npm install` in `web/` as well as here, but no SpacetimeDB or Rust.

## The video

`npm run video` makes a 1080p video of a longer, more faithful session for YouTube: Claude Code alone in the terminal, the cathedral at 2× so the next bay shows on either side, a visible mouse that tours the scene (a friend, the key, a votive, the thurifer, the notices), your priest praying for most of a minute, and then departing to light its candle. It is `video.ts`, built like `record.ts` (a fresh SpacetimeDB, the module, the viewer and the real gate), with Chrome's screencast at about 30 fps encoded by ffmpeg to H.264 + AAC. It takes about 10 minutes and writes `~/Movies/indulgence-demo.mp4`.

```sh
VIDEO_AUDIO=/path/to/music.wav npm run video
```

The music is yours to supply: none is in the repository. To put it in a cathedral first, run it through `cathedral_reverb.py`:

```sh
python3 -m pip install -r requirements.txt        # numpy, scipy
python3 cathedral_reverb.py music.ogg music-cathedral.wav [seconds] [--loop]
```

`--loop` wraps the reverb tail round onto the start so the result is exactly as long as the recording and repeats with no gap. The viewer's own music (`web/public/audio/`) was made with this script.

It convolves the recording with a synthesised room impulse response for a long gothic nave (90 × 28 × 30 m, choir in the chancel, listener halfway down). The late tail is decaying noise in seven octave bands, each decaying at the rate set by the walls' absorption (Eyring) and the air's, which dominates at high frequencies, about 5.6 s at 1 kHz; the early reflections are the first- and second-order image sources of the shoebox, panned by direction and darkened by each bounce. The result is mixed 55% dry, 85% wet. `video.ts` then fades the track in and out and normalises it to about −18 LUFS.

The video recasts the cathedral so the words over each priest have room, without changing it for anyone else. `video: true` in `scenario.ts` gives two friends who go by their GitHub usernames and don't know each other, strangers with ordinary handles, and a longer list of prayers for you; and the module is built with `INDULGENCE_VIDEO_SEATING=1` (see `module/build.rs`), which seats priests apart and fills bays of five. **Never publish a module built that way to a real database**; the build prints a warning when it is on.

| Variable | Default | Effect |
| --- | --- | --- |
| `VIDEO_AUDIO` | | The music, a `.wav` (required) |
| `VIDEO_OUT` | `~/Movies/indulgence-demo.mp4` | Output path |
| `VIDEO_LOGIN` | `lukekh` | Your GitHub login in the video |
| `VIDEO_SITE` | `https://indulgence.example` | The address shown in place of the demo's localhost links |
| `VIDEO_SEATED_MS` | 55000 | Real time spent watching your priest recite once it has sat down |
| `VIDEO_STRANGERS` | 13 | Size of the congregation |
| `VIDEO_KEEP_TMP` | | `1` keeps the run folder in `.cache/` |

The viewer plays music of its own (see [`web/public/audio/README.md`](../web/public/audio/README.md)). The GIF and the video are recorded with it off (`VITE_MUSIC=off` when the demo builds the viewer); the sandbox keeps it.
