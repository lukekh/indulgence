#!/usr/bin/env python3
"""Compose the priest sprite sheets from the Universal LPC Spritesheet Character Generator.

    git clone --filter=blob:none https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator lpc
    python3 web/scripts/build-sprites.py --lpc lpc

Writes web/public/sprites/{friar,priest,bishop,cardinal,thurifer}.png in the generator's
standard layout (832 x 3456, 64 px frames, rows up/left/down/right) and CREDITS.txt with the
authors and licences of every layer used. Only the animations the viewer draws are filled
in: spellcast, thrust, walk, idle and sit.

Each recipe is a simple robe: a long-sleeved shirt over a plain ankle-length skirt, recoloured
with the generator's own palettes (or a ramp of our own, below), plus a hood or cap where the
vestment needs one. The generator has no skullcap, so the cardinal's zucchetto is painted
onto the crown of the head here. Requires Pillow. A partial clone works: missing blobs are
read with `git show`.
"""

import argparse
import io
import json
import os
import subprocess
from PIL import Image

FRAME = 64
SHEET_W, SHEET_H = 13 * FRAME, 54 * FRAME
# animation folder -> first row in the standard sheet
ANIMATIONS = {"spellcast": 0, "thrust": 4, "walk": 8, "idle": 22, "sit": 30}

BASE = [
    ("body/body.json", None),
    ("head/heads/human/heads_human_male_elderly.json", None),
    ("head/faces/face_neutral.json", None),
]
LONGSLEEVE = "torso/shirts/longsleeve/torso_clothes_longsleeve.json"
SKIRT = "legs/skirts/legs_skirts_plain.json"
SHOES = "feet/shoes/feet_shoes_basic.json"
BELT = "torso/waist/belt_robe.json"
BALDING = "hair/bald/hair_balding.json"
# Painted on after the layers: a skullcap over the crown, in this ramp.
ZUCCHETTO = "@zucchetto"

# Ramps of our own, six shades dark to light, matched shade for shade to a material's base
# ramp (cloth: "white"), or by brightness for an item that comes only in fixed variants.
RAMPS = {
    "lightgray": ["#1c1a1e", "#4a4850", "#7d7a80", "#a3a0a4", "#c4c2c4", "#e0dfdd"],
    "gold": ["#3a2a0c", "#7a5a16", "#a8801f", "#cfa232", "#e8c55a", "#f8e39a"],
    "scarlet": ["#2a0608", "#5c0c12", "#8e141c", "#b81e26", "#cf2a2e", "#e04440"],
}



def cassock(colour):
    """The priest's robe, in another colour for the bishop and cardinal."""
    return [(SKIRT, colour), (LONGSLEEVE, colour), (SHOES, "black")]


RECIPES = {
    "friar": BASE + [
        (SKIRT, "brown"),
        (LONGSLEEVE, "brown"),
        (BELT, "variant:white"),
        ("feet/feet_sandals.json", None),
        ("headwear/coverings/hoods/hat_hood_cloth.json", "brown"),
    ],
    "priest": BASE + cassock("black") + [(BALDING, "gray")],
    # The priest's robe in white, bareheaded, white-haired.
    "bishop": BASE + cassock("white") + [(BALDING, "white")],
    # The priest's robe in red, with a scarlet zucchetto.
    "cardinal": BASE + cassock("red") + [(BALDING, "white"), (ZUCCHETTO, "scarlet")],
    # Altar server in the friar's habit, in light grey with a gold rope belt.
    "thurifer": [
        ("body/body.json", None),
        ("head/heads/human/heads_human_male.json", None),
        ("head/faces/face_neutral.json", None),
        (SKIRT, "lightgray"),
        (LONGSLEEVE, "lightgray"),
        (BELT, "variant:white>gold"),
        ("feet/feet_sandals.json", None),
        ("hair/short/hair_plain.json", "chestnut"),
    ],
}
HEAD_FACE_DIR = {"heads_human_male_elderly.json": "elderly", "heads_human_male.json": "male"}


class Lpc:
    def __init__(self, root):
        self.root = root
        self.palettes = {}

    def json(self, rel):
        with open(os.path.join(self.root, rel)) as f:
            return json.load(f)

    def image(self, rel):
        path = os.path.join(self.root, rel)
        if os.path.exists(path) and os.path.getsize(path) > 0:
            return Image.open(path).convert("RGBA")
        try:
            blob = subprocess.run(["git", "-C", self.root, "show", f"HEAD:{rel}"], check=True, capture_output=True).stdout
        except subprocess.CalledProcessError:
            return None
        return Image.open(io.BytesIO(blob)).convert("RGBA")

    def palette(self, material):
        if material not in self.palettes:
            meta = self.json(f"palette_definitions/{material}/meta_{material}.json")
            colours = dict(self.json(f"palette_definitions/{material}/{material}_ulpc.json"))
            colours.update(RAMPS)
            self.palettes[material] = (meta["base"], colours)
        return self.palettes[material]


def hex_rgb(h):
    return tuple(int(h[i : i + 2], 16) for i in (1, 3, 5))


def luminance(r, g, b):
    return 0.299 * r + 0.587 * g + 0.114 * b


def shade(ramp, lum, lo, hi):
    """The colour of `ramp` at brightness `lum`, where lo and hi are the darkest and lightest."""
    rgb = [hex_rgb(c) for c in ramp]
    f = 0 if hi <= lo else (lum - lo) / (hi - lo)
    i = max(0, min(len(rgb) - 1, round(f * (len(rgb) - 1))))
    return rgb[i]


def tint(img, ramp):
    """Recolour by brightness onto a ramp (for items that come only in fixed variants)."""
    px = img.load()
    lums = [luminance(*px[x, y][:3]) for y in range(img.height) for x in range(img.width) if px[x, y][3]]
    if not lums:
        return img
    lo, hi = min(lums), max(lums)
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            if a:
                px[x, y] = shade(RAMPS[ramp], luminance(r, g, b), lo, hi) + (a,)
    return img


def paint_zucchetto(sheet, head_mask, ramp):
    """A skullcap over the crown: the top rows of the head and hair in every frame, recoloured
    by brightness, leaving the dark outline as it is."""
    px, mask = sheet.load(), head_mask.load()
    for row in ANIMATIONS.values():
        for r in range(row, row + 4):
            depth = 7 if r - row == 0 else 5  # seen from behind, more of the crown shows
            for col in range(SHEET_W // FRAME):
                x0, y0 = col * FRAME, r * FRAME
                top = next((y for y in range(y0, y0 + FRAME) if any(mask[x, y][3] for x in range(x0, x0 + FRAME))), None)
                if top is None:
                    continue
                for y in range(top, top + depth):
                    for x in range(x0, x0 + FRAME):
                        if not mask[x, y][3]:
                            continue
                        cr, cg, cb, ca = px[x, y]
                        lum = luminance(cr, cg, cb)
                        if lum < 45:
                            continue  # outline
                        px[x, y] = shade(RAMPS[ramp], lum, 45, 250) + (ca,)


def recolour(img, lpc, material, target):
    base, colours = lpc.palette(material)
    if target == base:
        return img
    mapping = {}
    for src, dst in zip(colours[base], colours[target]):
        mapping[hex_rgb(src)] = hex_rgb(dst)
    px = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            if a and (r, g, b) in mapping:
                px[x, y] = mapping[(r, g, b)] + (a,)
    return img


def layers_for(lpc, recipe):
    """(zPos, base path, item def, colour) for every layer of every item."""
    face_dir = "male"
    for rel, _ in recipe:
        face_dir = HEAD_FACE_DIR.get(os.path.basename(rel), face_dir)
    out = []
    for rel, colour in recipe:
        if rel.startswith("@"):
            continue  # painted on afterwards
        d = lpc.json(f"sheet_definitions/{rel}")
        for n in range(1, 10):
            layer = d.get(f"layer_{n}")
            if not layer:
                break
            if layer.get("custom_animation") or "male" not in layer:
                continue
            out.append((layer.get("zPos", 100), layer["male"].replace("${head}", face_dir), d, colour))
    return sorted(out, key=lambda t: t[0])


def compose(lpc, recipe):
    sheet = Image.new("RGBA", (SHEET_W, SHEET_H), (0, 0, 0, 0))
    # Head and hair alone, to find the crown for a painted-on cap.
    head = Image.new("RGBA", (SHEET_W, SHEET_H), (0, 0, 0, 0))
    used = []
    for _, base, d, colour in layers_for(lpc, recipe):
        used.append((base, d))
        # "variant:white>gold": the white variant, tinted onto the gold ramp.
        colour, _, ramp = (colour or "").partition(">")
        variant = colour[len("variant:") :] if colour.startswith("variant:") else None
        for anim, row in ANIMATIONS.items():
            rel = f"spritesheets/{base}{anim}/{variant}.png" if variant else f"spritesheets/{base}{anim}.png"
            img = lpc.image(rel)
            if img is None:
                continue  # this item has no frames for this animation
            rec = d.get("recolors") or {}
            material = rec.get("material") or (rec.get("color_1") or {}).get("material")
            if colour and not variant and material:
                img = recolour(img, lpc, material, colour)
            if ramp:
                img = tint(img, ramp)
            part = img.crop((0, 0, min(img.width, SHEET_W), min(img.height, 4 * FRAME)))
            sheet.alpha_composite(part, (0, row * FRAME))
            if base.startswith(("head/heads/", "hair/")):
                head.alpha_composite(part, (0, row * FRAME))
    for rel, colour in recipe:
        if rel == ZUCCHETTO:
            paint_zucchetto(sheet, head, colour)
    return sheet, used


def credits_for(used):
    seen, lines = set(), []
    for base, d in used:
        for c in d.get("credits", []):
            f = c.get("file", "").rstrip("/")
            if not (base.rstrip("/").startswith(f) or f.startswith(base.rstrip("/"))) or f in seen:
                continue
            seen.add(f)
            lines += [f, f"  - Note: {c.get('notes', '')}", f"  - Licenses: {', '.join(c.get('licenses', []))}", f"  - Authors: {', '.join(c.get('authors', []))}", f"  - Links: {', '.join(c.get('urls', []))}", ""]
    return lines


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lpc", required=True, help="path to a clone of Universal-LPC-Spritesheet-Character-Generator")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "public", "sprites"))
    args = ap.parse_args()
    lpc = Lpc(args.lpc)
    commit = subprocess.run(["git", "-C", args.lpc, "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
    credits = [
        "Character sprites",
        "",
        "Composed by web/scripts/build-sprites.py from the Universal LPC Spritesheet Character Generator",
        f"(https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator, commit {commit or 'unknown'}).",
        "Each sprite sheet is a derivative work of the layers credited below and is offered under the same",
        "licences (where a layer offers several, any one may be chosen).",
        "",
    ]
    all_used = []
    for name, recipe in RECIPES.items():
        sheet, used = compose(lpc, recipe)
        sheet.save(os.path.join(args.out, f"{name}.png"), optimize=True)
        all_used += used
        print(f"wrote {name}.png ({len(used)} layers)")
    with open(os.path.join(args.out, "CREDITS.txt"), "w") as f:
        f.write("\n".join(credits + credits_for(all_used)))
    print("wrote CREDITS.txt")


if __name__ == "__main__":
    main()
