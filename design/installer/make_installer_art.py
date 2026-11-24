#!/usr/bin/env python3
"""Draws the installer artwork from the app icon.

    npm install                                   # the wordmark font comes from node_modules
    python3 design/installer/make_installer_art.py

Writes to src-tauri/installer/ (referenced from src-tauri/tauri.conf.json):

    dmg-background.png   660 x 400   macOS disk image window
    nsis-header.bmp      150 x 57    Windows setup (.exe): top-right of every page
    nsis-sidebar.bmp     164 x 314   Windows setup (.exe): welcome and finish pages
    wix-banner.bmp       493 x 58    Windows installer (.msi): top of every page
    wix-dialog.bmp       493 x 312   Windows installer (.msi): welcome and finish pages

The Windows files are 24-bit bitmaps because that is what NSIS and WiX read. Needs Pillow.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "src-tauri" / "installer"
ICON = ROOT / "design" / "app-icon.png"
FONT = ROOT / "node_modules" / "@fontsource" / "barlow-condensed" / "files" / "barlow-condensed-latin-600-normal.woff"

NAVY = (27, 37, 54)       # the icon's own background
PAPER = (242, 242, 243)   # --color-bg
INK = (29, 31, 32)        # --color-text
ACCENT = (89, 128, 166)   # --color-accent
WHITE = (255, 255, 255)
SCALE = 4                 # everything is drawn large and reduced once, for clean edges


def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def font(size):
    return ImageFont.truetype(str(FONT), size * SCALE)


def canvas(width, height, colour):
    return Image.new("RGB", (width * SCALE, height * SCALE), colour)


def finish(img, width, height):
    return img.resize((width, height), Image.LANCZOS)


def place_icon(img, x, y, size):
    icon = Image.open(ICON).convert("RGBA").resize((size * SCALE, size * SCALE), Image.LANCZOS)
    img.paste(icon, (x * SCALE, y * SCALE), icon)


def marks(draw, box, colour, arm=5):
    """The design's "+" registration marks at the four corners of a box."""
    x0, y0, x1, y1 = box
    for x, y in ((x0, y0), (x1, y0), (x0, y1), (x1, y1)):
        draw.line([((x - arm) * SCALE, y * SCALE), ((x + arm) * SCALE, y * SCALE)], fill=colour, width=SCALE)
        draw.line([(x * SCALE, (y - arm) * SCALE), (x * SCALE, (y + arm) * SCALE)], fill=colour, width=SCALE)


def spaced(draw, xy, text, fnt, fill, spacing=0.0):
    """Text with letter spacing; returns its width in final pixels."""
    x, y = xy[0] * SCALE, xy[1] * SCALE
    start = x
    for ch in text:
        draw.text((x, y), ch, font=fnt, fill=fill)
        x += draw.textlength(ch, font=fnt) + spacing * SCALE
    return (x - start) / SCALE


def spaced_width(draw, text, fnt, spacing=0.0):
    return sum(draw.textlength(ch, font=fnt) + spacing * SCALE for ch in text) / SCALE


def dmg_background():
    w, h = 660, 400
    img = canvas(w, h, PAPER)
    d = ImageDraw.Draw(img)
    line = mix(PAPER, INK, 0.16)
    d.rectangle([24 * SCALE, 24 * SCALE, (w - 24) * SCALE, (h - 24) * SCALE], outline=line, width=SCALE)
    marks(d, (24, 24, w - 24, h - 24), mix(PAPER, INK, 0.55))

    title = font(22)
    text = "DRAG NEXORA AI TO APPLICATIONS"
    tw = spaced_width(d, text, title, 1.6)
    spaced(d, ((w - tw) / 2, 52), text, title, INK, 1.6)

    # The app icon sits at x=180 and the Applications folder at x=480 (see tauri.conf.json); the arrow joins them.
    y = 190
    d.line([(262 * SCALE, y * SCALE), (392 * SCALE, y * SCALE)], fill=ACCENT, width=3 * SCALE)
    d.polygon([(404 * SCALE, y * SCALE), (388 * SCALE, (y - 9) * SCALE), (388 * SCALE, (y + 9) * SCALE)], fill=ACCENT)

    note = font(13)
    text = "LINKEDIN GROWTH AND LEAD INTELLIGENCE"
    tw = spaced_width(d, text, note, 1.2)
    spaced(d, ((w - tw) / 2, 338), text, note, mix(PAPER, INK, 0.6), 1.2)
    return finish(img, w, h)


def nsis_header():
    w, h = 150, 57
    img = canvas(w, h, WHITE)
    place_icon(img, w - 51, 6, 45)
    return finish(img, w, h)


def side_panel(w, h):
    """Navy panel with the icon and the wordmark, used on the welcome and finish pages."""
    img = canvas(w, h, NAVY)
    d = ImageDraw.Draw(img)
    line = mix(NAVY, WHITE, 0.14)
    d.rectangle([12 * SCALE, 12 * SCALE, (w - 12) * SCALE, (h - 12) * SCALE], outline=line, width=SCALE)
    marks(d, (12, 12, w - 12, h - 12), mix(NAVY, WHITE, 0.5), arm=4)
    icon = 84
    place_icon(img, (w - icon) // 2, 62, icon)
    name = font(26)
    tw = spaced_width(d, "NEXORA AI", name, 2.2)
    spaced(d, ((w - tw) / 2, 160), "NEXORA AI", name, WHITE, 2.2)
    small = font(11)
    for i, text in enumerate(("LINKEDIN GROWTH", "LEAD INTELLIGENCE")):
        tw = spaced_width(d, text, small, 1.1)
        spaced(d, ((w - tw) / 2, 198 + i * 16), text, small, mix(NAVY, WHITE, 0.62), 1.1)
    return img


def nsis_sidebar():
    w, h = 164, 314
    return finish(side_panel(w, h), w, h)


def wix_banner():
    # The installer prints the page title in black over the left of this image.
    w, h = 493, 58
    img = canvas(w, h, WHITE)
    place_icon(img, w - 52, 6, 46)
    return finish(img, w, h)


def wix_dialog():
    # The installer prints its welcome text in black over everything right of the panel.
    w, h = 493, 312
    img = canvas(w, h, WHITE)
    img.paste(side_panel(164, h), (0, 0))
    return finish(img, w, h)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    dmg_background().save(OUT / "dmg-background.png", optimize=True)
    for name, image in (
        ("nsis-header.bmp", nsis_header()),
        ("nsis-sidebar.bmp", nsis_sidebar()),
        ("wix-banner.bmp", wix_banner()),
        ("wix-dialog.bmp", wix_dialog()),
    ):
        image.convert("RGB").save(OUT / name, format="BMP")
    for path in sorted(OUT.iterdir()):
        with Image.open(path) as im:
            print(f"{path.relative_to(ROOT)}  {im.size[0]} x {im.size[1]}  {im.mode}")


if __name__ == "__main__":
    main()
