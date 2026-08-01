"""
Screenshot every route under every skin.

Run with the Schedules venv — it already has Selenium and Pillow, so this adds no dependency
to RatesApp and installs no browser:

    "C:/Users/Mike/OneDrive - Prime Time Packaging/Schedules/schedulesenv/Scripts/python.exe" \
        tools/skins/shoot.py --skins maritime --out .skins-out/before

WHY A LINK SWAP AND NOT A FILE WRITE
Skins are static files under public/skins/, loaded by <link id="skin"> in index.html. Changing
a skin is therefore `link.href = ...` executed in the page: instant, no rebuild, no HMR round
trip, and — the part that matters — nothing on disk is mutated, so a run killed halfway cannot
leave the repo wearing a variant. There is no cleanup step because there is nothing to clean up.

WHY THE DEV SERVER
public/ is served live, so a new variant appears without rebuilding. It also runs on :5173,
which is the origin already in the geo brain's CORS allowlist — Apply Rates makes real geo
calls, and from any other port every one of them fails.
"""

import argparse
import base64
import json
import os
import pathlib
import sys
import time

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

BASE = "http://localhost:5173"

# Internal routes. Forwarder routes need a second login and are deliberately out of scope.
ROUTES = [
    ("rates",            "/internal/rates"),
    ("apply",            "/internal/apply"),
    ("requests",         "/internal/requests"),
    ("upload",           "/internal/upload"),
    ("new",              "/internal/new"),
    ("bookings",         "/internal/bookings"),
    ("analytics",        "/internal/analytics"),
    ("analytics-dray",   "/internal/analytics/drayage"),
    ("dray-rates",       "/internal/drayage/rates"),
    ("dray-requests",    "/internal/drayage/requests"),
    ("dray-new",         "/internal/drayage/new"),
    ("dray-upload",      "/internal/drayage/upload"),
]

VIEWPORTS = {"desktop": (1440, 900), "mobile": (390, 844)}


def driver_for(width, height, scale):
    o = Options()
    o.add_argument("--headless=new")
    o.add_argument("--hide-scrollbars")
    o.add_argument(f"--window-size={width},{height}")
    o.add_argument(f"--force-device-scale-factor={scale}")
    d = webdriver.Chrome(options=o)
    # --window-size includes browser chrome, so the viewport lands short (1424x749 for 1440x900).
    # CDP sets the *viewport* exactly, which is what makes shots comparable across runs.
    d.execute_cdp_cmd("Emulation.setDeviceMetricsOverride",
                      {"width": width, "height": height, "deviceScaleFactor": scale,
                       "mobile": width < 500})
    return d


def sign_in(d, email, password):
    d.get(BASE + "/")
    wait = WebDriverWait(d, 30)
    wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "input[type=email]")))
    d.find_element(By.CSS_SELECTOR, "input[type=email]").send_keys(email)
    d.find_element(By.CSS_SELECTOR, "input[type=password]").send_keys(password)
    d.find_element(By.CSS_SELECTOR, "form button[type=submit]").click()
    # The email field disappearing is the signal the gate opened — a fixed sleep either
    # races a slow session or wastes time on a fast one.
    wait.until(EC.invisibility_of_element_located((By.CSS_SELECTOR, "input[type=email]")))


def set_skin(d, name):
    """Swap the stylesheet and wait for it to actually LOAD, not merely for href to change.

    Must be execute_async_script: the callback arrives as the last argument. Under a sync
    execute_script that callback is undefined, the wait silently does nothing, and the shot
    catches the page mid-restyle — which looks like a broken variant rather than a race.
    """
    ok = d.execute_async_script("""
        const name = arguments[0], done = arguments[arguments.length - 1];
        const link = document.getElementById('skin');
        if (!link) return done('no <link id="skin"> in index.html');
        link.addEventListener('load', () => done(null), { once: true });
        link.addEventListener('error', () => done('failed to load skin ' + name), { once: true });
        link.href = `/skins/${name}.css?v=${Date.now()}`;
    """, name)
    if ok:
        raise RuntimeError(ok)


def settle(d, timeout=25):
    """Wait for the page to be genuinely ready, not merely for a fixed number of seconds.

    A fixed sleep is the wrong tool here and produced a false diff on first use: the Rates grid
    was still showing its spinner in one run and fully populated in the next, so 34% of pixels
    differed and the comparison blamed the refactor. Screenshots meant for pixel comparison have
    to wait on a CONDITION, or the diff measures load timing instead of design.
    """
    end = time.time() + timeout
    while time.time() < end:
        busy = d.execute_script("""
            return !!document.querySelector('.MuiCircularProgress-root, [role=progressbar]')
                || !!document.querySelector('.MuiDataGrid-overlayWrapper .MuiCircularProgress-root')
                || document.readyState !== 'complete';
        """)
        if not busy:
            break
        time.sleep(0.25)

    # Fonts resolved, then two frames so any entrance animation has committed its final state.
    d.execute_async_script("""
        const done = arguments[arguments.length - 1];
        document.fonts.ready.then(() =>
            requestAnimationFrame(() => requestAnimationFrame(done)));
    """)


def shoot(d, path):
    m = d.execute_cdp_cmd("Page.getLayoutMetrics", {})
    size = m["cssContentSize"]
    png = d.execute_cdp_cmd("Page.captureScreenshot", {
        "format": "png",
        "captureBeyondViewport": True,   # full page, not just the fold
        "clip": {"x": 0, "y": 0, "width": size["width"],
                 "height": min(size["height"], 12000), "scale": 1},
    })["data"]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(base64.b64decode(png))
    return size["width"], size["height"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skins", nargs="+", required=True)
    ap.add_argument("--out", default=".skins-out")
    ap.add_argument("--viewports", nargs="+", default=["desktop"], choices=list(VIEWPORTS))
    ap.add_argument("--routes", nargs="*", help="route names to limit to")
    ap.add_argument("--scale", type=int, default=2)
    ap.add_argument("--email", default=os.environ.get("SKIN_EMAIL", ""))
    ap.add_argument("--password", default=os.environ.get("SKIN_PASSWORD", ""))
    a = ap.parse_args()

    if not a.email or not a.password:
        sys.exit("set --email/--password or SKIN_EMAIL/SKIN_PASSWORD")

    routes = [r for r in ROUTES if not a.routes or r[0] in a.routes]
    out = pathlib.Path(a.out)
    manifest = []

    for vp in a.viewports:
        w, h = VIEWPORTS[vp]
        d = driver_for(w, h, a.scale)
        d.set_script_timeout(60)
        try:
            sign_in(d, a.email, a.password)
            print(f"[{vp}] signed in")
            for skin in a.skins:
                for name, path in routes:
                    d.get(BASE + path)
                    # `_current` shoots whatever the page already loaded, without touching the
                    # <link>. That is how the pre-conversion baseline is captured — at that
                    # commit no skin element exists yet, so a swap would simply fail.
                    if skin != "_current":
                        # Set AFTER navigation: a page load resets the <link> to index.html's
                        # default, so swapping first would silently shoot maritime every time.
                        set_skin(d, skin)
                    settle(d)   # waits on a condition, not a clock — see settle()
                    f = out / skin / vp / f"{name}.png"
                    size = shoot(d, f)
                    manifest.append({"skin": skin, "viewport": vp, "route": name,
                                     "path": str(f).replace("\\", "/"),
                                     "w": size[0], "h": size[1]})
                    print(f"  {skin:16} {vp:8} {name:16} {size[0]:>5.0f}x{size[1]:<6.0f}")
        finally:
            d.quit()

    out.mkdir(parents=True, exist_ok=True)
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{len(manifest)} shots -> {out}")


if __name__ == "__main__":
    main()
