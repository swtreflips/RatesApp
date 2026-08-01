"""
WCAG contrast audit for every skin.

A palette that fails contrast is not a candidate, however good it looks in a screenshot — so
this runs BEFORE any variant earns a place in the comparison. The pairs below are the ones the
app actually renders, read off the components rather than invented: body text on the page
background, muted labels, the amber primary button, the navy sidebar, and grid cell text.

Thresholds: 4.5:1 normal text, 3:1 large/bold text and UI boundaries (WCAG 2.1 AA).
"""

import pathlib
import re
import sys

# (label, foreground token, background token, required ratio)
PAIRS = [
    ("body text on page",        "harbor-900", "fog-100",    4.5),
    ("body text on card",        "harbor-900", "white",      4.5),
    ("headings on card",         "harbor-950", "white",      4.5),
    ("muted label on card",      "fog-500",    "white",      4.5),
    ("muted label on page",      "fog-600",    "fog-100",    4.5),
    ("grid header text",         "fog-600",    "fog-50",     4.5),
    ("grid cell text",           "harbor-900", "white",      4.5),
    ("primary button label",     "harbor-950", "signal-500", 4.5),
    ("sidebar nav text",         "fog-100",    "harbor-950", 4.5),
    ("sidebar muted text",       "harbor-300", "harbor-950", 4.5),
    ("positive status text",     "sea-700",    "sea-50",     4.5),
    ("hairline vs card",         "fog-200",    "white",      1.2),   # visible, not text
    ("focus ring vs card",       "signal-500", "white",      3.0),
    ("warning toast text",       "white",      "signal-600", 4.5),
    ("success toast text",       "white",      "sea-600",    4.5),
]

WHITE = (255, 255, 255)


def parse(path):
    out = {}
    for m in re.finditer(r"--c-([a-z]+)-(\d+):\s*([\d]+)\s+([\d]+)\s+([\d]+)\s*;", path.read_text(encoding="utf-8")):
        out[f"{m[1]}-{m[2]}"] = (int(m[3]), int(m[4]), int(m[5]))
    return out


def lum(rgb):
    def ch(c):
        c /= 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (ch(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def main():
    skins = sorted(pathlib.Path("public/skins").glob("*.css"))
    failed = {}
    for f in skins:
        c = parse(f)
        c["white"] = WHITE
        rows, bad = [], 0
        for label, fg, bg, need in PAIRS:
            if fg not in c or bg not in c:
                rows.append((label, "—", "MISSING TOKEN")); bad += 1; continue
            r = ratio(c[fg], c[bg])
            ok = r >= need
            if not ok:
                bad += 1
            rows.append((label, f"{r:5.2f}:1", ("ok " if ok else "FAIL") + f" (needs {need})"))
        print(f"\n{f.stem.upper()}")
        for label, r, verdict in rows:
            mark = "  " if verdict.startswith("ok") else "->"
            print(f"  {mark} {label:24} {r:>9}  {verdict}")
        if bad:
            failed[f.stem] = bad

    print()
    if failed:
        for k, n in failed.items():
            print(f"{k}: {n} failing pair(s)")
        sys.exit(1)
    print("all skins pass WCAG AA on every rendered pair")


if __name__ == "__main__":
    main()
