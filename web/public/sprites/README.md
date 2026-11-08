# Priest sprites

The viewer loads one sheet per vestment from this folder:

| File | Vestment | Spend (budget pledged) |
| --- | --- | --- |
| `friar.png` | Brown habit | under 10,000 |
| `priest.png` | Black cassock, white stole | 10,000–49,999 |
| `bishop.png` | Mitre and crozier | 50,000–199,999 |
| `cardinal.png` | Scarlet | 200,000 and over |

A missing sheet falls back to a procedural placeholder, so you can add them one at a time.

## Making a sheet

Use the [Universal LPC Spritesheet Character Generator](https://liberatedpixelcup.github.io/Universal-LPC-Spritesheet-Character-Generator/). Open the link for a vestment, adjust it, then choose **Download → Spritesheet** (`character-spritesheet.png`). Rename the file and drop it here. Keep the standard layout: 64 × 64 frames, 832 px wide, at least 54 rows, with directions ordered up, left, down, right. Oversize weapon blocks below row 54 are ignored.

The generator has no mitre, cassock, stole, zucchetto or crozier, so these recipes use the closest items it has. All four share the base `#sex=male&body=Body_Color_light&head=Human_Male_Elderly_light&expression=Neutral_light`:

- **Friar:** `…&clothes=Longsleeve_brown&legs=Plain_skirt_brown&hat=Hood_brown&belt=Robe_Belt_white&shoes=Sandals_brown`
- **Priest:** `…&hair=Balding_gray&clothes=Longsleeve_black&legs=Plain_skirt_black&neck=Scarf_white&shoes=Basic_Shoes_black`. Tabard `white` gives a surplice instead of a collar.
- **Bishop:** `…&hair=Balding_white&clothes=Longsleeve_white&legs=Plain_skirt_white&shoulders=Mantal_purple&charm=Cross_amulet_gold_red&hat=Wizard_Hat_Base_white&weapon=S_staff_gold&shoes=Basic_Shoes_white`. The wizard hat stands in for a mitre, and the S staff for a crozier. The S staff exists only for walk, hurt and oversize thrust, so it vanishes while kneeling.
- **Cardinal:** `…&hair=Balding_white&clothes=Longsleeve_red&legs=Plain_skirt_red&shoulders=Mantal_red&charm=Cross_amulet_gold_red&hat=Bonnie_red&shoes=Basic_Shoes_red`

Prefix each with `https://liberatedpixelcup.github.io/Universal-LPC-Spritesheet-Character-Generator/`.

## Animations used

The renderer (`src/sprites.ts`) uses these rows, scaled to half size for the 16 × 8 tile grid:

| Action | LPC rows | Frames |
| --- | --- | --- |
| Walking in and out | walk, rows 8–11 | 1–8 at 10 fps |
| Kneeling in the pew, facing the altar | sit, rows 30–33 | 0 |
| Lighting the candle | thrust, rows 4–7 | the generator's "watering" cycle 0, 1, 4, 4, 4, 4, 5 |

Some items (Robe Belt, Tabard, Cross amulet) have no sit frames, so they disappear while kneeling. Check the generator's preview of the **sit** animation before exporting.

## Licences and credits

LPC art is CC-BY-SA, CC-BY, OGA-BY, GPL or CC0, depending on the asset. Every author except CC0 ones must be credited where players can reach it. The generator exports `credits.txt` and `credits.csv` with each sheet. Merge the credits for all four sheets into `CREDITS.txt` in this folder; the site footer links to it. The friar and cardinal recipes can be used entirely under OGA-BY or CC0. The scarf (priest) and wizard hat (bishop) are CC-BY-SA or GPL only, which means share-alike obligations for those sheets.
