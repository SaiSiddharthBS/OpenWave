"""Renders every OpenWave icon from assets/logo-mark.png with headless Chrome.

    python assets/icon/render_icons.py      (needs: pip install playwright; Google Chrome)

Outputs the macOS app icon (assets/icon-macos-1024.png), PWA / favicon / Apple touch icons
(openwave/web/icons/) and the menu-bar template icon (macos/Resources/).
"""

import base64
import math
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MARK = base64.b64encode((ROOT / "assets/logo-mark.png").read_bytes()).decode()
WEB = ROOT / "openwave/web/icons"


def squircle(size: float, n: float = 5.0, steps: int = 720) -> str:
    """Apple-style continuous-corner shape (superellipse) as an SVG path."""
    a = size / 2
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        pts.append(f"{a + a * math.copysign(abs(c) ** (2 / n), c):.2f},{a + a * math.copysign(abs(s) ** (2 / n), s):.2f}")
    return "M" + " L".join(pts) + " Z"


def icon_html(body: int, offset: int, shape: str, mark_w: float, shadow: bool, layer: str = "all") -> str:
    """layer: "all", "background" (no wave) or "foreground" (wave only, transparent)."""
    clip = f"clip-path:path('{squircle(body)}');" if shape == "squircle" else ""
    rim = (f'<svg class="rim" viewBox="0 0 {body} {body}"><defs><linearGradient id="r" x1="0" y1="0" x2="0" y2="1">'
           '<stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".5" stop-color="#fff" stop-opacity=".08"/>'
           f'<stop offset="1" stop-color="#c45cff" stop-opacity=".35"/></linearGradient></defs><path d="{squircle(body)}" '
           f'fill="none" stroke="url(#r)" stroke-width="{body / 165:.1f}"/></svg>') if shape == "squircle" else ""
    k = body / 824
    return f"""<!doctype html><html><head><style>
    html,body{{margin:0;background:transparent}}
    .canvas{{width:1024px;height:1024px;position:relative}}
    .shadow{{position:absolute;left:{offset}px;top:{offset + 18}px;width:{body}px;height:{body}px;filter:blur(22px);opacity:.55;background:#000;{clip}}}
    .body{{position:absolute;left:{offset}px;top:{offset}px;width:{body}px;height:{body}px;overflow:hidden;{clip}
      background:radial-gradient(60% 50% at 22% 18%, rgba(47,200,255,.55), transparent 70%),
        radial-gradient(55% 55% at 85% 88%, rgba(196,92,255,.6), transparent 70%),
        radial-gradient(70% 60% at 50% 55%, rgba(79,107,255,.35), transparent 75%),
        linear-gradient(160deg, #1b2260 0%, #0c0f2e 48%, #160a33 100%)}}
    .glass{{position:absolute;inset:0;background:linear-gradient(180deg, rgba(255,255,255,.18) 0%, rgba(255,255,255,.05) 34%, rgba(255,255,255,0) 50%)}}
    .rim{{position:absolute;inset:0;width:100%;height:100%}}
    .glow{{position:absolute;left:50%;top:50%;width:{mark_w * 1.02}px;transform:translate(-50%,-46%);filter:blur({46 * k}px) saturate(1.6);opacity:.95}}
    .mark{{position:absolute;left:50%;top:50%;width:{mark_w}px;transform:translate(-50%,-56%);filter:drop-shadow(0 {18 * k}px {30 * k}px rgba(10,10,40,.55))}}
    .reflection{{position:absolute;left:50%;top:50%;width:{mark_w}px;transform:translate(-50%,38%) scaleY(-1);opacity:.22;filter:blur({3 * k}px);
      -webkit-mask-image:linear-gradient(to top, rgba(0,0,0,.9), transparent 55%)}}
    </style></head><body><div class="canvas">
    {'<div class="shadow"></div>' if shadow else ''}
    <div class="body" {'style="background:transparent"' if layer == "foreground" else ''}>
      {'' if layer == "background" else f'<img class="glow" src="data:image/png;base64,{MARK}"><img class="reflection" src="data:image/png;base64,{MARK}"><img class="mark" src="data:image/png;base64,{MARK}">'}
      {'' if layer == "foreground" else '<div class="glass"></div>'}{rim}</div>
    </div></body></html>"""


def main():
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome")
        pg = b.new_page(viewport={"width": 1024, "height": 1024})

        def render(html, out, size=None):
            pg.set_content(html)
            pg.wait_for_timeout(300)
            pg.screenshot(path=str(out), omit_background=True)
            if size:
                from PIL import Image
                Image.open(out).resize((size, size), Image.LANCZOS).save(out)

        # macOS: 824 px body on Apple's 1024 grid, with drop shadow
        render(icon_html(824, 100, "squircle", 690, True), ROOT / "assets/icon-macos-1024.png")
        # Browser / Android "any" icons and favicons: squircle filling the canvas
        for size, name in [(512, "icon-512.png"), (192, "icon-192.png"), (64, "favicon-64.png"), (32, "favicon-32.png")]:
            render(icon_html(1024, 0, "squircle", 860, False), WEB / name, size)
        # iOS home screen and Android adaptive icons: full-bleed square, platform applies the mask
        render(icon_html(1024, 0, "square", 860, False), WEB / "apple-touch-icon.png", 180)
        render(icon_html(1024, 0, "square", 700, False), WEB / "maskable-512.png", 512)
        # Android adaptive icon layers (108dp canvas, wave inside the 66dp safe zone) + legacy icons
        res = ROOT / "android/app/src/main/res"
        layers = {"background": icon_html(1024, 0, "square", 600, False, "background"),
                  "foreground": icon_html(1024, 0, "square", 600, False, "foreground")}
        for name, html in layers.items():
            render(html, ROOT / f"assets/android-{name}.png")
        legacy = ROOT / "assets/android-legacy.png"
        render(icon_html(1024, 0, "squircle", 860, False), legacy)
        b.close()
        from PIL import Image
        for density, scale in {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}.items():
            d = res / f"mipmap-{density}"
            d.mkdir(parents=True, exist_ok=True)
            px = round(108 * scale)
            for name in layers:
                Image.open(ROOT / f"assets/android-{name}.png").resize((px, px), Image.LANCZOS).save(d / f"ic_launcher_{name}.png")
            Image.open(legacy).resize((round(48 * scale),) * 2, Image.LANCZOS).save(d / "ic_launcher.png")
        # Themed-icon (Android 13+) layer: white wave silhouette in the safe zone
        mark = Image.open(ROOT / "assets/logo-mark.png").convert("RGBA")
        sil = Image.new("RGBA", mark.size, (255, 255, 255, 0))
        sil.putalpha(mark.split()[3].point(lambda v: 255 if v > 90 else 0))
        canvas = Image.new("RGBA", (432, 432), (0, 0, 0, 0))
        w = 250
        canvas.alpha_composite(sil.resize((w, round(mark.height * w / mark.width)), Image.LANCZOS), ((432 - w) // 2, (432 - round(mark.height * w / mark.width)) // 2))
        (res / "mipmap-xxxhdpi").mkdir(parents=True, exist_ok=True)
        canvas.save(res / "mipmap-xxxhdpi/ic_launcher_monochrome.png")
        for f in ("android-background.png", "android-foreground.png", "android-legacy.png"):
            (ROOT / "assets" / f).unlink()

    menubar_icon()


def menubar_icon():
    """Menu-bar icon: the silver glass wave (assets/menubar-mark.png, trimmed from
    assets/menubar-source.png) in its own colours, with a faint shadow so it stays
    visible on light menu bars too."""
    from PIL import Image, ImageFilter
    mark = Image.open(ROOT / "assets/menubar-mark.png").convert("RGBA")
    out = ROOT / "macos/Resources"
    out.mkdir(exist_ok=True)
    for scale, suffix in [(1, ""), (2, "@2x")]:
        h = 16 * scale
        w = round(mark.width * h / mark.height)
        pad = 2 * scale
        icon = mark.resize((w, h), Image.LANCZOS)
        shadow = Image.new("RGBA", icon.size, (0, 0, 0, 0))
        shadow.putalpha(icon.split()[3].point(lambda v: v * 0.45))
        canvas = Image.new("RGBA", (w + 2 * pad, h + 2 * pad), (0, 0, 0, 0))
        canvas.alpha_composite(shadow, (pad, pad + max(1, scale // 2)))
        canvas = canvas.filter(ImageFilter.GaussianBlur(0.6 * scale))
        canvas.alpha_composite(icon, (pad, pad))
        canvas.save(out / f"MenuBarIcon{suffix}.png")


if __name__ == "__main__":
    main()
