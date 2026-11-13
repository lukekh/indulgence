# Music

`dies-irae-cathedral.m4a` is the *Dies irae*, put through a synthesised cathedral and looped by
`web/src/music.ts` when the page opens.

How it was made: a recording of the *Dies irae* was run through
[`demo/cathedral_reverb.py`](../../../demo/cathedral_reverb.py) with `--loop`, so the reverb tail
wraps round onto the start and the loop has no gap, then encoded with ffmpeg:

```sh
python3 demo/cathedral_reverb.py Dies.irae.ogg dies-irae-loop.wav --loop
ffmpeg -i dies-irae-loop.wav -af "loudnorm=I=-20:TP=-2:LRA=11,aresample=48000" \
  -c:a aac -b:a 96k -movflags +faststart web/public/audio/dies-irae-cathedral.m4a
```

The chant itself is traditional and in the public domain, but a recording of it is not
automatically: **the performer, source and licence of the recording used here are not
recorded.** Add them here and to *Merita* in `web/index.html` before publishing the site.
