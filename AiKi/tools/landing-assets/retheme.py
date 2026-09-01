"""Retheme the CC0 KayKit atlas to AiKi's paper/ink/orange family.

One small PNG colours every model in the kit, so the whole town is rethemed by
remapping this atlas: baked detail (windows, trims, shading) survives because
only hue/saturation move, never the value structure.
"""
import colorsys
from PIL import Image

SRC = "/Users/mac/Documents/codes/bnb/AiKi/tools/landing-assets/citybits_texture.orig.png"
DST = "/Users/mac/Documents/codes/bnb/AiKi/apps/web/public/landing/models/kaykit-city/citybits_texture.png"

img = Image.open(SRC).convert("RGBA")
pixels = img.load()
w, h = img.size

def remap(r, g, b):
    hue, light, sat = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
    deg = hue * 360

    if sat < 0.12:
        # Greys and whites: warm them so they sit on the paper page.
        hue, sat = 36 / 360, min(sat + 0.05, 0.10)
    elif deg < 20 or deg >= 340:
        # Saturated reds -> muted clay brick, adjacent to the brand orange.
        hue, sat = 14 / 360, sat * 0.52
    elif deg < 65:
        # Oranges and yellows -> tan/terracotta, calmer.
        hue, sat = 32 / 360, sat * 0.55
    elif deg < 170:
        # The kit's bright greens -> sage/olive.
        hue, sat, light = 72 / 360, sat * 0.38, light * 0.97
    elif deg < 210:
        # Teals -> grey-teal.
        hue, sat = 182 / 360, sat * 0.30
    elif deg < 275:
        # Blues -> slate ink.
        hue, sat, light = 220 / 360, sat * 0.30, light * 0.95
    else:
        # Purples/magentas -> quiet mauve-grey.
        hue, sat = 300 / 360, sat * 0.22

    nr, ng, nb = colorsys.hls_to_rgb(hue, light, sat)
    return round(nr * 255), round(ng * 255), round(nb * 255)

cache = {}
for y in range(h):
    for x in range(w):
        r, g, b, a = pixels[x, y]
        key = (r, g, b)
        if key not in cache:
            cache[key] = remap(r, g, b)
        nr, ng, nb = cache[key]
        pixels[x, y] = (nr, ng, nb, a)

img.save(DST)
print(f"rethemed {w}x{h}, {len(cache)} distinct colours")
