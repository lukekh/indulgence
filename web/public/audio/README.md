# Music

Six recordings of Gregorian chant, and a synthesised cathedral to sing them in. `web/src/music.ts`
plays them in the order below from when the page opens, and starts again after the last. The
recordings here are dry: the viewer adds the cathedral as they play, by convolving each with
`impulse-response.m4a` (Web Audio's ConvolverNode).

| File | Chant | Recording | Licence |
| --- | --- | --- | --- |
| `dies-irae-opus.mp4`, `dies-irae-aac.m4a` | *Dies irae*, the sequence of the Requiem | [Membeth, 2010](https://commons.wikimedia.org/wiki/File:Dies.irae.ogg) | Public domain |
| `pueri-hebraeorum-portantes-opus.mp4`, `pueri-hebraeorum-portantes-aac.m4a` | *Pueri Hebraeorum, portantes ramos olivarum*, for Palm Sunday | [Adabo60ge, 2014](https://commons.wikimedia.org/wiki/File:Pueri_hebraeorum,_portantes_ramos_olivarum.ogg) | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| `pueri-hebraeorum-vestimenta-opus.mp4`, `pueri-hebraeorum-vestimenta-aac.m4a` | *Pueri Hebraeorum, vestimenta prosternebant*, for Palm Sunday | [Adabo60ge, 2014](https://commons.wikimedia.org/wiki/File:Pueri_hebraeorum,_vestimenta.ogg) | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| `improperia-opus.mp4`, `improperia-aac.m4a` | The *Improperia*, complete | [Membeth, 2010](https://commons.wikimedia.org/wiki/File:Improperia.ogg) | Public domain |
| `lamentatio-opus.mp4`, `lamentatio-aac.m4a` | The third Lamentation for Holy Saturday | [Membeth, 2015](https://commons.wikimedia.org/wiki/File:Lamentation.III.Karsamstag.ogg) | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `resurrexi-opus.mp4`, `resurrexi-aac.m4a` | The introit *Resurrexi et adhuc tecum sum*, with the Gloria Patri | [The Tudor Consort](https://commons.wikimedia.org/wiki/File:The_Tudor_Consort_-_02_-_Introit_-_Resurrexi_et_Adhuc_Tecum_Sum.ogg) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |

All six come from Wikimedia Commons; each link is to the original file and its licence
statement. The chants themselves are traditional and in the public domain.

**Changes made.** Every recording here is an altered version of its original: loudness evened
out, re-encoded as Opus and as AAC, and the cathedral's reverb added by the viewer as it plays.
The two *Pueri Hebraeorum* antiphons are therefore adaptations under CC BY-SA 3.0, and their
files are offered under that same licence, not under the project's MIT licence. The *Resurrexi*
is an adaptation under CC BY 3.0, which asks that The Tudor Consort be credited and the changes
noted, as here and in *Merita* in the viewer.

## How they were made

Each chant is here twice: Opus (16 kbps, in MP4), which most browsers play, and HE-AAC (24 kbps),
for a browser that cannot. The Opus is in MP4 rather than WebM because Safari plays WebM in a
way that Web Audio cannot hear, which would leave the nave silent. The bitrate was chosen by
ear, against the 96 kbps files with the reverb baked in that these replace: with the reverb
added after decoding, far less is needed, since a reverb tail is noise, which compresses badly,
and the reverb covers what compressing the dry chant loses. All six together are 6.7 MB as
Opus (and 9.6 MB as AAC), where they were 38 MB.

[`demo/cathedral_reverb.py`](../../../demo/cathedral_reverb.py) makes the impulse response, and
levels each original so that, mixed as the viewer mixes it, it comes out at -20 LUFS:

```sh
python3 demo/cathedral_reverb.py --ir impulse-response.wav
ffmpeg -i impulse-response.wav -c:a aac_at -b:a 128k -movflags +faststart web/public/audio/impulse-response.m4a

python3 demo/cathedral_reverb.py --dry Improperia.ogg improperia.wav
ffmpeg -i improperia.wav -c:a libopus -b:a 16k -application audio -movflags +faststart \
  web/public/audio/improperia-opus.mp4
ffmpeg -i improperia.wav -af aresample=32000 -c:a aac_at -profile:a 4 -aac_at_mode cvbr -b:a 24k \
  -movflags +faststart web/public/audio/improperia-aac.m4a
```

`aac_at` is macOS's AAC encoder, which ffmpeg has on a Mac (`-profile:a 4` is HE-AAC); elsewhere,
ffmpeg built with `libfdk_aac` can make the same with `-c:a libfdk_aac -profile:a aac_he`. The
impulse response is AAC at 128 kbps: convolved with a chant, it gives a reverb within a fraction
of a decibel, in every third of an octave, of the uncompressed one.

If the mix in `web/src/music.ts` (`DRY`, `WET`) changes, change `VIEWER_DRY` and `VIEWER_WET` in
the script to match, and level the recordings again.
