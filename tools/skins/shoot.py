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
    d._vp = (width, height, scale)   # force_repaint needs to restore exactly this
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
    """Apply a skin by writing its tokens INLINE on <html>, not by swapping the <link>.

    Swapping the href is what a human does and it works fine in a real browser — but under
    headless Chrome it does not invalidate styles that DEPEND on the custom properties. Measured
    directly: after the swap, :root's --c-signal-500 read `8 162 162` and the correct sheet was
    the only skins/ sheet attached, yet the sidebar badge's computed backgroundColor was still
    rgb(245, 165, 36). Every screenshot came back wearing the previous skin while every probe
    said the swap had worked.

    Setting the properties inline forces recomputation, because an inline style change is an
    invalidation Chrome cannot elide. Previous properties are removed first, so switching from a
    skin that defines a token to one that does not cannot leave the old value behind.
    """
    err = d.execute_async_script("""
        const name = arguments[0], done = arguments[arguments.length - 1];
        fetch(`/skins/${name}.css?v=${Date.now()}`)
          .then(r => r.ok ? r.text() : Promise.reject(`HTTP ${r.status}`))
          .then(css => {
            const block = css.match(/:root\\s*\\{([\\s\\S]*?)\\n\\}/);
            if (!block) return done('no :root block in ' + name);
            const props = [];
            for (const line of block[1].split('\\n')) {
              const m = line.match(/^\\s*(--[\\w-]+)\\s*:\\s*(.+?);\\s*(?:\\/\\*.*)?$/);
              if (m) props.push([m[1], m[2]]);
            }
            if (!props.length) return done('no tokens parsed from ' + name);
            const el = document.documentElement;
            for (const p of JSON.parse(el.dataset.skinProps || '[]')) el.style.removeProperty(p);
            for (const [k, v] of props) el.style.setProperty(k, v);
            el.dataset.skinProps = JSON.stringify(props.map(p => p[0]));
            // keep the <link> in step so the page is coherent if a human opens it mid-run
            const link = document.getElementById('skin');
            if (link) link.href = `/skins/${name}.css?v=${Date.now()}`;
            requestAnimationFrame(() => requestAnimationFrame(() => done(null)));
          })
          .catch(e => done(String(e)));
    """, name)
    if err:
        raise RuntimeError(f"set_skin({name}): {err}")


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
            // The app shell must exist. Every d.get() is a full reload, so each route re-runs
            // auth and shows LoadingScreen ("Establishing session…") first — which is neither a
            // MUI spinner nor a progressbar, so waiting on those alone photographed the splash.
            if (!document.querySelector('header') || !document.querySelector('aside nav'))
                return true;
            // .animate-spin is THIS app's loading idiom — a lucide Loader2, not a MUI spinner.
            // Waiting only on MUI selectors photographed every grid mid-fetch, which emptied the
            // densest surface on the page and made all five skins look interchangeable.
            if (document.querySelector('.animate-spin, .MuiCircularProgress-root, [role=progressbar]'))
                return true;
            if (document.readyState !== 'complete') return true;

            // A grid that has mounted but not yet fetched looks "ready" — no spinner exists
            // until the request is in flight. Screenshots taken in that window show an empty
            // card, which hides the densest surface in the app and makes every skin look alike.
            // Wait for the grid to actually resolve: rows, or an explicit empty-state overlay.
            const grid = document.querySelector('.MuiDataGrid-root');
            if (grid && !grid.querySelector('.MuiDataGrid-row, .MuiDataGrid-overlay')) return true;
            return false;
        """)
        if not busy:
            break
        time.sleep(0.25)
    else:
        raise TimeoutError("page never became ready — shell or spinner still present")

    # Fonts resolved, then two frames so any entrance animation has committed its final state.
    d.execute_async_script("""
        const done = arguments[arguments.length - 1];
        document.fonts.ready.then(() =>
            requestAnimationFrame(() => requestAnimationFrame(done)));
    """)


def preflight(d):
    """Refuse to shoot unless the served CSS is actually variable-driven.

    This exists because of a genuinely silent failure. `pkill` does not kill Windows processes
    from Git Bash, so every dev-server "restart" failed with `Port 5173 is already in use` while
    curl still answered — from the ORIGINAL server, started before the token refactor. It served
    CSS with colours baked in (`background-color: rgb(245 165 36 / …)`), so no skin could apply,
    every variant photographed identically, and a pixel-identity gate compared old output against
    old output and reported PASS.

    Nothing about that was visible from the outside. One assertion on the emitted rule turns a
    whole afternoon of plausible-looking wrong results into an immediate, obvious stop.
    """
    rule = d.execute_script("""
        for (const sheet of document.styleSheets) {
          let list; try { list = sheet.cssRules } catch (e) { continue }
          for (const r of list) if (r.selectorText === '.bg-signal-500') return r.cssText;
        } return '';""")
    if not rule:
        raise RuntimeError("preflight: .bg-signal-500 not found — is the app built with Tailwind?")
    if "var(--c-signal-500)" not in rule:
        raise RuntimeError(
            "preflight: the served CSS has colours BAKED IN, not variable-driven:\n"
            f"    {rule}\n"
            "  The dev server is running the pre-refactor tailwind.config.js. Kill it for real\n"
            "  (PowerShell: Get-NetTCPConnection -LocalPort 5173 | Stop-Process) and restart —\n"
            "  `pkill` silently fails on Windows and the old server keeps answering.")


def force_repaint(d):
    """Invalidate the compositor surface so the capture reflects the CURRENT styles.

    Page.captureScreenshot with captureBeyondViewport reuses a cached full-page surface. A skin
    swap changes only custom properties on :root, which repaints on screen but does not
    invalidate that cached surface — so the screenshot comes back showing the PREVIOUS skin
    while getComputedStyle reports the new one. Measured exactly that: --c-signal-500 read
    `8 162 162` while the captured logo pixel was still `245 165 36`.

    Resizing the viewport by one pixel and back forces a fresh surface. Nothing else reliably
    did: scrolling, extra rAFs and reflow reads all left the stale raster in place.
    """
    w, h, scale = d._vp
    for height in (h + 1, h):
        d.execute_cdp_cmd("Emulation.setDeviceMetricsOverride",
                          {"width": w, "height": height, "deviceScaleFactor": scale,
                           "mobile": w < 500})
    d.execute_async_script(
        "const done = arguments[arguments.length-1];"
        "requestAnimationFrame(() => requestAnimationFrame(done));")


def shoot(d, path):
    force_repaint(d)
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
            preflight(d)
            print(f"[{vp}] signed in, CSS is variable-driven")
            for skin in a.skins:
                for name, path in routes:
                    d.get(BASE + path)

                    # ORDER MATTERS: boot first, THEN skin.
                    # Every navigation is a full reload, so the app re-runs auth and paints its
                    # "Establishing session…" splash before the shell exists. Swapping the skin
                    # before that settles gets undone by the boot, and the shot comes back
                    # wearing the default — which reads as "the variant does not work" rather
                    # than "the screenshot was early".
                    settle(d)
                    if skin != "_current":
                        # `_current` shoots whatever loaded, untouched — that is how the
                        # pre-conversion baseline is captured, where no <link id="skin"> exists.
                        set_skin(d, skin)
                    settle(d)   # runs again: the grid starts fetching only once the shell mounts
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
