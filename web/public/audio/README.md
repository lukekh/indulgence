# Music

Six recordings of Gregorian chant, each put through a synthesised cathedral. `web/src/music.ts`
plays them in the order below from when the page opens, and starts again after the last.

| File | Chant | Recording | Licence |
| --- | --- | --- | --- |
| `dies-irae-cathedral.m4a` | *Dies irae*, the sequence of the Requiem | [Membeth, 2010](https://commons.wikimedia.org/wiki/File:Dies.irae.ogg) | Public domain |
| `pueri-hebraeorum-portantes-cathedral.m4a` | *Pueri Hebraeorum, portantes ramos olivarum*, for Palm Sunday | [Adabo60ge, 2014](https://commons.wikimedia.org/wiki/File:Pueri_hebraeorum,_portantes_ramos_olivarum.ogg) | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| `pueri-hebraeorum-vestimenta-cathedral.m4a` | *Pueri Hebraeorum, vestimenta prosternebant*, for Palm Sunday | [Adabo60ge, 2014](https://commons.wikimedia.org/wiki/File:Pueri_hebraeorum,_vestimenta.ogg) | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| `improperia-cathedral.m4a` | The *Improperia*, complete | [Membeth, 2010](https://commons.wikimedia.org/wiki/File:Improperia.ogg) | Public domain |
| `lamentatio-cathedral.m4a` | The third Lamentation for Holy Saturday | [Membeth, 2015](https://commons.wikimedia.org/wiki/File:Lamentation.III.Karsamstag.ogg) | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `resurrexi-cathedral.m4a` | The introit *Resurrexi et adhuc tecum sum*, with the Gloria Patri | [The Tudor Consort](https://commons.wikimedia.org/wiki/File:The_Tudor_Consort_-_02_-_Introit_-_Resurrexi_et_Adhuc_Tecum_Sum.ogg) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |

All six come from Wikimedia Commons; each link is to the original file and its licence
statement. The chants themselves are traditional and in the public domain.

**Changes made.** Every file here is an altered version of its original: reverb added,
loudness evened out, re-encoded as AAC. The two *Pueri Hebraeorum* files are therefore
adaptations under CC BY-SA 3.0 and are offered under that same licence, not under the
project's MIT licence. The *Resurrexi* file is an adaptation under CC BY 3.0, which asks that
The Tudor Consort be credited and the changes noted, as here and in *Merita* in the viewer.

## How they were made

Each original was run through [`demo/cathedral_reverb.py`](../../../demo/cathedral_reverb.py)
and encoded with ffmpeg:

```sh
python3 demo/cathedral_reverb.py Improperia.ogg improperia.wav
ffmpeg -i improperia.wav -af "loudnorm=I=-20:TP=-2:LRA=11,aresample=48000" \
  -c:a aac -b:a 96k -movflags +faststart web/public/audio/improperia-cathedral.m4a
```

The *Dies irae* was made with `--loop`, from when it played alone on repeat: that wraps the
reverb tail round onto the start. Its recording ends in several seconds of silence, so the
result differs from the others only in having no ring-out after the end. The other five let
the last note ring out in the nave before the next chant begins.
