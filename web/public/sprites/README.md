# Priest sprites

These sheets are built from the [Universal LPC Spritesheet Character Generator](https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator) by `web/scripts/build-sprites.py`. Each is a simple pixel-art robe: a long-sleeved shirt over a plain ankle-length skirt, recoloured with the generator's own palettes or a ramp defined in the script.

| File | Who | Recipe |
| --- | --- | --- |
| `friar.png` | under 10,000 prayer tokens | brown robe, cloth hood, white rope belt, sandals |
| `priest.png` | 10,000–49,999 | black robe, black shoes, balding grey hair |
| `bishop.png` | 50,000–199,999 | the priest's robe in white, black shoes, bareheaded, white balding hair |
| `cardinal.png` | 200,000 and over | the priest's robe in red, black shoes, white balding hair, scarlet zucchetto |
| `thurifer.png` | the incense-bearer who processes every two minutes | the friar's habit in light grey, gold rope belt, sandals, no hood |

Every character uses the light male body and the neutral face. The four clergy have the elderly head; the thurifer has the young head with plain chestnut hair.

The generator has no skullcap, so the script paints the zucchetto on: the top rows of the head and hair in every frame are recoloured onto a scarlet ramp by brightness, keeping the outline. The gold belt is the generator's white robe belt, tinted onto a gold ramp the same way.

To regenerate (for example after changing a recipe in the script):

```sh
git clone --filter=blob:none https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator /tmp/lpc
python3 web/scripts/build-sprites.py --lpc /tmp/lpc     # needs Pillow
```

The script writes the sheets in the generator's standard layout: 832 × 3456, 64 × 64 frames, with rows ordered up, left, down, right. It also writes `CREDITS.txt` with the authors and licences of every layer it used. You can replace any sheet with one exported from the [generator site](https://liberatedpixelcup.github.io/Universal-LPC-Spritesheet-Character-Generator/) in the same layout. If you do, paste its credits into `CREDITS.txt`.

## Animations used

The renderer (`src/sprites.ts`) draws these rows at half size for the 16 × 8 tile grid:

| Action | LPC rows | Frames |
| --- | --- | --- |
| Walking: from behind on the way in, any direction on the way out | walk, rows 8–11 | 1–8 at 5 fps (priests walk slowly) |
| Kneeling in the pew, from behind | sit, rows 30–33 | 0 |
| Lighting the candle | thrust, rows 4–7 | the generator's "watering" cycle 0, 1, 4, 4, 4, 4, 5 |

## Licences

The art is a derivative of LPC layers under OGA-BY 3.0, CC-BY-SA 3.0, CC-BY 3.0 and GPL; see `CREDITS.txt` for which applies to each layer. Where a layer offers several licences, any one may be chosen. The bishop's pointed hat is CC-BY-SA 3.0 or GPL only, so `bishop.png` carries share-alike terms. The other sheets can be used entirely under OGA-BY. The site footer links to `CREDITS.txt`.
