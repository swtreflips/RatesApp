"""
Compose contact sheets: one image per route, every skin side by side.

The comparison that decides a design is ONE SCREEN ACROSS ALL SKINS, not one skin's tour.
Flipping between full-screen variants makes you judge them serially, and serial judgement
reliably favours whichever you saw last. Differences in weight, density and temperature only
become arguable when the same screen sits beside itself.

    python tools/skins/sheet.py --in .skins-out/variants --out .skins-out/sheets
"""

import argparse
import pathlib

from PIL import Image, ImageDraw, ImageFont

LABEL_H = 56
GAP = 20
PAD = 24
BG = (247, 248, 250)
INK = (17, 21, 26)
MUTED = (110, 120, 132)


def font(size, bold=False):
    for name in (("seguisb.ttf", "segoeuib.ttf") if bold else ("segoeui.ttf",)):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def build(route, shots, out, width):
    """shots: [(skin_name, Path)] in the order they should be compared."""
    ims = []
    for skin, p in shots:
        im = Image.open(p).convert("RGB")
        h = round(im.height * width / im.width)
        ims.append((skin, im.resize((width, h), Image.LANCZOS)))

    tall = max(im.height for _, im in ims)
    W = PAD * 2 + width * len(ims) + GAP * (len(ims) - 1)
    H = PAD * 2 + LABEL_H + tall

    sheet = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(sheet)
    f_name, f_sub = font(23, bold=True), font(15)

    x = PAD
    for skin, im in ims:
        d.text((x, PAD), skin, font=f_name, fill=INK)
        d.text((x, PAD + 27), f"{im.width}×{im.height}", font=f_sub, fill=MUTED)
        sheet.paste(im, (x, PAD + LABEL_H))
        # hairline so a light skin's edge is still findable against a light sheet
        d.rectangle([x, PAD + LABEL_H, x + im.width - 1, PAD + LABEL_H + im.height - 1],
                    outline=(222, 226, 232))
        x += im.width + GAP

    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out, optimize=True)
    return sheet.size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", default=".skins-out/variants")
    ap.add_argument("--out", default=".skins-out/sheets")
    ap.add_argument("--width", type=int, default=760, help="per-shot width in the sheet")
    # Explicit order, weakest-to-strongest departure from today, so scanning left to right
    # reads as a progression rather than a shuffle.
    ap.add_argument("--order", nargs="+",
                    default=["maritime", "atlas", "meridian", "console", "linen"])
    a = ap.parse_args()

    src, out = pathlib.Path(a.src), pathlib.Path(a.out)
    routes = sorted({p.stem for p in src.glob("*/desktop/*.png")})
    if not routes:
        raise SystemExit(f"no screenshots under {src}")

    for route in routes:
        shots = [(s, src / s / "desktop" / f"{route}.png") for s in a.order
                 if (src / s / "desktop" / f"{route}.png").exists()]
        if len(shots) < 2:
            print(f"  {route:16} skipped — need at least two skins")
            continue
        size = build(route, shots, out / f"{route}.png", a.width)
        print(f"  {route:16} {len(shots)} skins  {size[0]}×{size[1]}")

    print(f"\ncontact sheets -> {out}")


if __name__ == "__main__":
    main()
