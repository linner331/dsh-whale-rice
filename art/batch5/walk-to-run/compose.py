"""Compose the 4-frame bowl run from one shared upper body + two Gemini leg poses.

    python3 -I art/batch5/walk-to-run/compose.py   (from the repo root)

- Everything above the skirt hem comes from run-1.jpeg, so the bowl and the rice never move.
- legs/leg-1.jpeg (stride) and legs/leg-2c.jpeg (passing) supply the legs for frames 1 and 2.
- Frames 3 and 4 reuse those legs with the near/far shading swapped: the leg that was in front
  becomes the darker far leg, which is how a side-view run shows the other foot leading.
Polygons are in source-image pixels (979x1024, all edits share run-1's framing).
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).parent
W, H = 979, 1024


def disp(points):   # grid sketches were drawn at 2x over the crop starting at (200, 820)
    return [(200 + x / 2, 820 + y / 2) for x, y in points]


# below the hem and under the tail: cleared of run-1's legs before the new ones go in
LEG_ZONE = disp([(0, 15), (90, 15), (200, 45), (300, 80), (400, 100), (500, 100), (580, 95), (660, 85),
                 (720, 40), (760, 62), (845, 72), (900, 70), (1000, 60), (1100, 0),
                 (1400, 0), (1400, 400), (0, 400)])
STRIDE_FRONT = disp([(195, 30), (260, 58), (345, 95), (300, 190), (285, 280), (200, 285), (70, 200),
                     (80, 145), (150, 135), (185, 60)])
BACK = disp([(585, 95), (650, 88), (720, 40), (790, 0), (840, 0), (862, 60), (868, 140),
             (820, 170), (765, 155), (740, 128), (620, 132)])
PASS_SUPPORT = disp([(375, 95), (535, 88), (540, 200), (538, 290), (365, 305), (350, 265), (390, 230),
                     (390, 150)])


def mask(poly, feather=1.5):
    m = Image.new("L", (W, H), 0)
    ImageDraw.Draw(m).polygon(poly, fill=255)
    return m.filter(ImageFilter.GaussianBlur(feather))


def darken(rgb):
    """The far leg: a cool shadow, as if behind the near one."""
    return rgb * 0.62 + np.array([12, 16, 48])


def legless_base():
    """run-1 with its legs removed. Its back shoe sits in front of the tail, so the tail behind
    it is rebuilt row by row from the column just right of the shoe, leftwards until the row
    reaches the skirt's frill or her thigh (so the tail's end tucks behind them)."""
    base = np.asarray(Image.open(HERE / "run-1.jpeg").convert("RGB")).astype(float)
    zone = np.asarray(mask(LEG_ZONE, 0)).astype(float)[..., None] / 255
    out = base * (1 - zone) + 255 * zone
    for y in range(806, 862):
        tail = out[y, 632].copy()
        if tail.min() > 200:            # below the tail's outline: nothing to rebuild
            continue
        for x in range(631, 500, -1):
            r, g, b = base[y, x]
            frill = min(r, g, b) > 200 and max(r, g, b) - min(r, g, b) < 40 and zone[y, x, 0] < 0.5
            skin = r > b + 40                          # her thigh under the hem stays
            if frill or skin:
                break
            out[y, x] = tail
    return out


def shifted(a, dx, dy, fill):
    out = np.full_like(a, float(fill))
    h, w = a.shape[:2]
    out[max(dy, 0):h + min(dy, 0), max(dx, 0):w + min(dx, 0)] = a[max(-dy, 0):h - max(dy, 0), max(-dx, 0):w - max(dx, 0)]
    return out


# The swing leg while passing: Gemini keeps drawing a foot parked behind the body, which then
# hangs in the same spot every frame. Instead the support leg is copied, lifted and tucked
# just behind itself, so only the raised shoe peeks out.
TUCK = (22, -42)


def frame(legs_img, near, far):
    """near/far: (polygon, (dx, dy)) pieces of legs_img; far is shaded and drawn first."""
    legs = np.asarray(Image.open(HERE / legs_img).convert("RGB")).astype(float)
    zone = np.asarray(mask(LEG_ZONE, 0)).astype(float)[..., None] / 255
    out = legless_base()
    for (poly, (dx, dy)), shade in ((far, True), (near, False)):   # far first, near on top
        m = np.asarray(mask(poly)).astype(float)[..., None] / 255   # may reach up behind the tail
        src = darken(legs) if shade else legs
        if dx or dy:   # a moved copy stays under the hem
            m, src = shifted(m, dx, dy, 0) * zone, shifted(src, dx, dy, 255)
        out = out * (1 - m) + src * m
    return Image.fromarray(np.clip(out, 0, 255).astype("uint8"))


STAY = (0, 0)
frames = [
    frame("legs/leg-1.jpeg", near=(STRIDE_FRONT, STAY), far=(BACK, STAY)),           # near foot leads
    frame("legs/leg-2c.jpeg", near=(PASS_SUPPORT, STAY), far=(PASS_SUPPORT, TUCK)),  # near supports, far swings
    frame("legs/leg-1.jpeg", near=(BACK, STAY), far=(STRIDE_FRONT, STAY)),           # far foot leads
    frame("legs/leg-2c.jpeg", near=(PASS_SUPPORT, TUCK), far=(PASS_SUPPORT, STAY)),  # far supports, near swings
]
for k, f in enumerate(frames, 1):
    f.save(HERE / f"final-{k}.png")

# 2x2 sheet for the sprite builder
pad = 120
sheet = Image.new("RGB", ((W + pad) * 2, (H + pad) * 2), "white")
for k, f in enumerate(frames):
    sheet.paste(f, ((k % 2) * (W + pad) + pad // 2, (k // 2) * (H + pad) + pad // 2))
sheet.save(HERE.parent / "run-walkbased.png")
print("wrote final-1..4.png and batch5/run-walkbased.png")
