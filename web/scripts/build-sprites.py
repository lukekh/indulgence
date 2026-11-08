#!/usr/bin/env python3
"""Compose the priest sprite sheets from the Universal LPC Spritesheet Character Generator.

    git clone --filter=blob:none https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator lpc
    python3 web/scripts/build-sprites.py --lpc lpc

Writes web/public/sprites/{friar,priest,bishop,cardinal,thurifer}.png in the generator's
standard layout (832 x 3456, 64 px frames, rows up/left/down/right) and CREDITS.txt with the
authors and licences of every layer used. Only the animations the viewer draws are filled
in: spellcast, thrust, walk, idle and sit.

Each recipe is a simple robe: a long-sleeved shirt over a plain ankle-length skirt, recoloured
with the generator's own palettes, plus a hat or hood where the vestment needs one.
Requires Pillow. A partial clone works: missing blobs are read with `git show`.
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

RECIPES = {
    "friar": BASE + [
        (SKIRT, "brown"),
        (LONGSLEEVE, "brown"),
        ("torso/waist/belt_robe.json", "variant:white"),
        ("feet/feet_sandals.json", None),
        ("headwear/coverings/hoods/hat_hood_cloth.json", "brown"),
    ],
    "priest": BASE + [
        (SKIRT, "black"),
        (LONGSLEEVE, "black"),
        (SHOES, "black"),
        ("hair/bald/hair_balding.json", "gray"),
    ],
    "bishop": BASE + [
        (SKIRT, "white"),
        (LONGSLEEVE, "white"),
        ("arms/shoulders/shoulders_mantal.json", "purple"),
        (SHOES, "white"),
        ("hair/bald/hair_balding.json", "white"),
        ("headwear/hats/magic/hat_magic_wizard.json", "variant:white"),
    ],
    "cardinal": BASE + [
        (SKIRT, "red"),
        (LONGSLEEVE, "red"),
        ("arms/shoulders/shoulders_mantal.json", "red"),
        (SHOES, "red"),
        ("hair/bald/hair_balding.json", "white"),
        ("headwear/hats/caps/hat_cap_bonnie.json", "variant:red"),
    ],
    # Altar server in black cassock and white surplice.
    "thurifer": [
        ("body/body.json", None),
        ("head/heads/human/heads_human_male.json", None),
        ("head/faces/face_neutral.json", None),
        (SKIRT, "black"),
        (LONGSLEEVE, "white"),
        (SHOES, "black"),
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
            colours = self.json(f"palette_definitions/{material}/{material}_ulpc.json")
            self.palettes[material] = (meta["base"], colours)
        return self.palettes[material]


def recolour(img, lpc, material, target):
    base, colours = lpc.palette(material)
    if target == base:
        return img
    mapping = {}
    for src, dst in zip(colours[base], colours[target]):
        mapping[tuple(int(src[i : i + 2], 16) for i in (1, 3, 5))] = tuple(int(dst[i : i + 2], 16) for i in (1, 3, 5))
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
    used = []
    for _, base, d, colour in layers_for(lpc, recipe):
        used.append((base, d))
        for anim, row in ANIMATIONS.items():
            variant = colour[len("variant:") :] if colour and colour.startswith("variant:") else None
            rel = f"spritesheets/{base}{anim}/{variant}.png" if variant else f"spritesheets/{base}{anim}.png"
            img = lpc.image(rel)
            if img is None:
                continue  # this item has no frames for this animation
            rec = d.get("recolors") or {}
            material = rec.get("material") or (rec.get("color_1") or {}).get("material")
            if colour and not variant and material:
                img = recolour(img, lpc, material, colour)
            sheet.alpha_composite(img.crop((0, 0, min(img.width, SHEET_W), min(img.height, 4 * FRAME))), (0, row * FRAME))
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
