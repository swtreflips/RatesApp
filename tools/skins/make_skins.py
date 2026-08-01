"""
Generate skin variants.

Ramps are built in OKLCH, not picked by hand. A hand-picked ramp drifts in hue and lightness
between steps — 400 reads warmer than 500, 700 is barely darker than 600 — and the result looks
sampled rather than designed. OKLCH is perceptually uniform, so an even lightness sequence
actually *looks* even, and the same chroma curve applied to two hues yields two families of
matching intensity. That is what makes a palette read as one system.

Each skin defines the identical variable contract, so any of them can be swapped in with no
other change. Semantic roles, constant across skins:

    harbor   primary dark surface and body text (the sidebar, headings)
    signal   accent: primary actions, active states  <- the per-module knob
    sea      positive / secondary status
    fog      neutrals: page background, hairlines, muted text
    brand    legacy alias of signal, kept so stray brand-* classes still resolve

Run:  python tools/skins/make_skins.py
"""

import pathlib

# ── OKLCH -> sRGB ────────────────────────────────────────────────────────────────────────────
# Björn Ottosson's Oklab, then the standard linear-sRGB transfer. Out-of-gamut colours are
# reduced in chroma until they fit rather than clipped per channel — clipping shifts hue, which
# is exactly the drift this whole approach exists to avoid.

def _oklab_to_lrgb(L, a, b):
    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_**3, m_**3, s_**3
    return (
        +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    )


def _encode(c):
    c = 1.055 * (c ** (1 / 2.4)) - 0.055 if c > 0.0031308 else 12.92 * c
    return round(max(0.0, min(1.0, c)) * 255)


def oklch(L, C, H):
    """L 0..1, C chroma, H degrees -> 'R G B' channel string."""
    import math
    for _ in range(60):
        a = C * math.cos(math.radians(H))
        b = C * math.sin(math.radians(H))
        rgb = _oklab_to_lrgb(L, a, b)
        if all(-1e-4 <= v <= 1 + 1e-4 for v in rgb):
            break
        C *= 0.96                      # desaturate toward the gamut, preserving hue
    return " ".join(str(_encode(v)) for v in _oklab_to_lrgb(L, a, b))


SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]

# Lightness per shade — the spine of every ramp, so harbor-700 and sea-700 carry equal weight.
LIGHT = [0.975, 0.945, 0.885, 0.808, 0.712, 0.637, 0.563, 0.487, 0.412, 0.348, 0.243]

# NEUTRALS RUN DARKER FROM 400 DOWN. Not a stylistic choice — a contrast requirement. The app
# renders muted copy as text-fog-500 on white and text-fog-600 on the page, and on the shared
# curve those land at 3.4:1 and 3.9:1, under the 4.5:1 floor. The components cannot be edited
# to use a darker shade without breaking the "a skin changes nothing but tokens" property, so
# the shade itself has to be dark enough.
FOG_LIGHT = [0.975, 0.945, 0.880, 0.790, 0.660, 0.545, 0.480, 0.415, 0.350, 0.290, 0.215]

# ANY FAMILY USED AS A FILL gets this curve — signal, its brand alias, and sea. Fills serve two
# opposing roles at adjacent shades and the ramp has to satisfy both:
#   *-500 is a button FILL under near-black text  -> must be light enough
#   *-600 is a toast FILL under white text        -> must be dark enough
# Hence a deliberately steep 500->600 step. On the shared curve one of the two always failed:
# sea-600 landed at 4.3:1 behind white toast text, which is the kind of miss nobody notices
# until the one screen that uses it.
FILL_LIGHT = [0.975, 0.945, 0.885, 0.815, 0.730, 0.645, 0.550, 0.475, 0.405, 0.340, 0.240]

# Chroma multiplier — peaks mid-ramp. Pale tints and near-blacks at full chroma look synthetic.
CHROMA = [0.12, 0.22, 0.45, 0.68, 0.88, 1.00, 0.98, 0.88, 0.74, 0.62, 0.45]

LIGHT_FOR = {"fog": FOG_LIGHT, "signal": FILL_LIGHT, "brand": FILL_LIGHT, "sea": FILL_LIGHT}


def ramp(hue, peak, family="harbor"):
    light = LIGHT_FOR.get(family, LIGHT)
    return {s: oklch(light[i], peak * CHROMA[i], hue) for i, s in enumerate(SHADES)}


# ── the four directions ──────────────────────────────────────────────────────────────────────
# Each varies palette temperature, type, radius, depth AND motion together. A skin that only
# changes colour is a hue rotation, not an alternative.

SKINS = {
    "atlas": dict(
        title="Atlas — refined maritime",
        note="The current direction, disciplined. Cooler navy, gold rather than orange, tighter "
             "radii, softer shadows. The safe evolution: recognisably the same product.",
        harbor=(255, 0.075), signal=(78, 0.155), sea=(178, 0.105), fog=(250, 0.012),
        fonts=dict(display='"Bricolage Grotesque", ui-serif, Georgia, serif',
                   sans='"Inter", ui-sans-serif, system-ui, sans-serif',
                   mono='"JetBrains Mono", ui-monospace, monospace'),
        tracking="-0.035em", radius=("0.375rem", "0.625rem", "0.875rem"),
        shadow_alpha=(0.05, 0.16), grain="0.04",
        motion=("140ms", "260ms", "440ms"), ease="cubic-bezier(0.22, 1, 0.36, 1)",
    ),
    "meridian": dict(
        title="Meridian — editorial mono",
        note="Near-monochrome, hairlines instead of shadows, one decisive accent. Closest to "
             "Schedules today, so it is the strongest candidate if the three apps converge.",
        harbor=(265, 0.018), signal=(28, 0.170), sea=(165, 0.080), fog=(265, 0.005),
        fonts=dict(display='"Newsreader", ui-serif, Georgia, serif',
                   sans='"Public Sans", ui-sans-serif, system-ui, sans-serif',
                   mono='"IBM Plex Mono", ui-monospace, monospace'),
        tracking="-0.02em", radius=("0.125rem", "0.25rem", "0.375rem"),
        shadow_alpha=(0.0, 0.0), grain="0.0",
        motion=("110ms", "180ms", "300ms"), ease="cubic-bezier(0.4, 0, 0.2, 1)",
    ),
    "console": dict(
        title="Console — dense operations terminal",
        note="High contrast, cool slate, electric accent, square corners, no depth at all. "
             "Maximum data per pixel — the look of a tool you live in all day.",
        harbor=(240, 0.045), signal=(195, 0.145), sea=(150, 0.140), fog=(240, 0.008),
        fonts=dict(display='"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif',
                   sans='"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif',
                   mono='"IBM Plex Mono", ui-monospace, monospace'),
        tracking="-0.01em", radius=("0.125rem", "0.1875rem", "0.25rem"),
        shadow_alpha=(0.0, 0.10), grain="0.0",
        motion=("80ms", "140ms", "220ms"), ease="cubic-bezier(0.2, 0, 0, 1)",
    ),
    "linen": dict(
        title="Linen — soft warm modern",
        note="Warm neutrals, muted teal primary, generous radii and diffuse depth. The furthest "
             "from today: calmer, less industrial, easier on a long day of reading grids.",
        harbor=(195, 0.055), signal=(45, 0.130), sea=(155, 0.095), fog=(75, 0.014),
        fonts=dict(display='"Fraunces", ui-serif, Georgia, serif',
                   sans='"DM Sans", ui-sans-serif, system-ui, sans-serif',
                   mono='"DM Mono", ui-monospace, monospace'),
        tracking="-0.025em", radius=("0.625rem", "0.875rem", "1.25rem"),
        shadow_alpha=(0.06, 0.20), grain="0.06",
        motion=("180ms", "340ms", "560ms"), ease="cubic-bezier(0.34, 1.2, 0.64, 1)",
    ),
}

GRAIN = ("url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' "
         "height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' "
         "baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect "
         "width='100%25' height='100%25' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E\")")


def render(name, s):
    fams = {k: ramp(*s[k], family=k) for k in ("harbor", "signal", "sea", "fog")}
    fams["brand"] = fams["signal"]        # legacy alias

    lines = []
    for fam in ("harbor", "signal", "sea", "fog", "brand"):
        lines.append(f"  /* {fam} */")
        for sh in SHADES:
            lines.append(f"  --c-{fam}-{sh}: {fams[fam][sh]};")
        lines.append("")
    colours = "\n".join(lines).rstrip()

    lo, hi = s["shadow_alpha"]
    if hi == 0:
        # No depth at all: a hairline does the separating. Emitting a 0-alpha shadow instead
        # would still cost a paint layer for nothing.
        card = "0 0 0 1px rgb(var(--c-fog-200))"
        card_hover = "0 0 0 1px rgb(var(--c-fog-300))"
    else:
        card = (f"0 1px 2px rgb(var(--c-harbor-950) / {lo}), "
                f"0 8px 24px -12px rgb(var(--c-harbor-950) / {hi})")
        card_hover = (f"0 2px 4px rgb(var(--c-harbor-950) / {lo + 0.02:.2f}), "
                      f"0 16px 40px -16px rgb(var(--c-harbor-950) / {hi + 0.10:.2f})")

    r_lg, r_xl, r_2xl = s["radius"]
    m_fast, m_base, m_slow = s["motion"]

    return f"""/*
  SKIN: {name} — {s['title']}

  {s['note']}

  Generated by tools/skins/make_skins.py. Ramps are built in OKLCH so lightness steps are
  perceptually even and every family carries matching weight at the same shade. Edit the recipe
  in that script rather than these values, or the next run overwrites your changes.

  Colours are space-separated RGB CHANNELS. Tailwind composes them as
  `rgb(var(--c-x) / <alpha-value>)`, which is what keeps opacity modifiers working.
*/

:root {{
{colours}

  /* ── type ──────────────────────────────────────────────────────────── */
  --font-display: {s['fonts']['display']};
  --font-sans: {s['fonts']['sans']};
  --font-mono: {s['fonts']['mono']};
  --tracking-display: {s['tracking']};

  /* ── shape ─────────────────────────────────────────────────────────── */
  --radius-lg: {r_lg};
  --radius-xl: {r_xl};
  --radius-2xl: {r_2xl};

  /* ── depth ─────────────────────────────────────────────────────────── */
  --shadow-card: {card};
  --shadow-card-hover: {card_hover};
  --shadow-rail: inset -1px 0 0 rgb(255 255 255 / 0.04);
  --shadow-signal: 0 6px 20px -8px rgb(var(--c-signal-600) / 0.6);

  /* ── motion ────────────────────────────────────────────────────────── */
  --motion-fast: {m_fast};
  --motion-base: {m_base};
  --motion-slow: {m_slow};
  --ease-out-expo: {s['ease']};

  /* ── texture ───────────────────────────────────────────────────────── */
  --grain: {GRAIN};
  --grain-opacity: {s['grain']};
  --bg-harbor-mesh: radial-gradient(110% 120% at 0% 0%, rgb(var(--c-harbor-800)) 0%, rgb(var(--c-harbor-900)) 45%, rgb(var(--c-harbor-950)) 100%);
  --bg-chart-grid: linear-gradient(rgb(255 255 255 / 0.035) 1px, transparent 1px), linear-gradient(90deg, rgb(255 255 255 / 0.035) 1px, transparent 1px);
}}
"""


if __name__ == "__main__":
    out = pathlib.Path("public/skins")
    out.mkdir(parents=True, exist_ok=True)
    for name, spec in SKINS.items():
        (out / f"{name}.css").write_text(render(name, spec), encoding="utf-8")
        print(f"  {name:10} {spec['title']}")
    print(f"\n{len(SKINS)} skins -> {out}")
