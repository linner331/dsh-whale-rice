#!/usr/bin/env python3
"""
Build the treasure assets from the generated artwork (art/batch6).

    python3 scripts/sprites/build_treasure.py

  items      the icon sheets → assets/treasure/items.webp, one cell per item. The image model rarely
             keeps a 3x3 layout (it repeats items, adds columns), so icons are found as blobs on the
             white sheet, numbered in reading order, and picked by number (ITEM_PICKS below).
  glass      crack / hole / shards were drawn light-on-black; black becomes transparent (alpha = the
             brightest channel), so the glass shows over any desktop. The hole's inside is flood-filled
             from the centre into hole-mask.webp: the beach shows through exactly that shape.
  beach      the seaside seen through the hole; its horizon and shoreline are measured so she walks
             on the sand and dives where the water starts.
Everything lands in assets/treasure/ plus treasure.json (cells, measurements, content hash).
"""
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from build_sprites import components, cut_out, dilate

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / 'art' / 'batch6'
OUT = ROOT / 'assets' / 'treasure'
PREVIEW = ROOT / 'art' / 'previews'
CELL = 128          # icon cell, px
ICON_COLS = 8
SHARD_CELL = 192

# Blob numbers (reading order) of the icons to keep, per sheet; see art/previews/items-blobs.png.
ITEM_PICKS = {
    'items-a.png': {0: 'flip-flop', 1: 'seaweed', 2: 'soda-can', 3: 'lan-cable', 4: 'fish-hook', 5: 'manual',
                    6: 'blue-coral', 7: 'onigiri', 8: 'soy-fish'},
    'items-b.png': {0: 'scallop', 1: 'starfish', 2: 'crab', 5: 'conch', 6: 'pebble', 7: 'glass-bottle',
                    10: 'message-bottle', 11: 'pearl', 12: 'sea-glass'},
    'items-c.png': {0: 'golden-bowl', 1: 'whale-heart', 2: 'jellyfish-lamp', 5: 'mermaid-comb', 6: 'chest-key',
                    7: 'h800', 8: 'octopus', 9: 'compass', 11: 'rice-paddle'},
    'items-d.png': {0: 'busy-server', 1: 'queue-ticket', 2: 'whale-coin', 3: 'cache-onigiri', 6: 'whale-plush',
                    8: 'hourglass', 10: 'chain-of-thought', 12: 'mit-scroll', 13: 'moe-hats'},
}


def save(img: Image.Image, name: str) -> bytes:
    path = OUT / name
    img.save(path, 'WEBP', quality=88, method=6)
    return path.read_bytes()


# ---- items ------------------------------------------------------------------------------------

def blobs(rgb: np.ndarray) -> list[tuple[int, int, int, int]]:
    """Icon bounding boxes in reading order. Only clear ink counts (the faint panel dividers some
    sheets have stay out); nearby pieces of one icon (smoke puffs, a strap, three bits of sea glass)
    are joined by a small dilation. Each crop is cut out properly afterwards."""
    ink = rgb.min(2) < 200
    h, w = ink.shape
    boxes = []
    for c in components(dilate(ink, 6)):
        if c.sum() < 900:
            continue
        ys, xs = np.nonzero(c)
        if ys.max() - ys.min() > 0.9 * h or xs.max() - xs.min() > 0.9 * w:
            continue   # a divider that survived
        boxes.append((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
    # reading order: band by row (centres within half an icon height), then left to right
    boxes.sort(key=lambda b: (b[1] + b[3]) / 2)
    ordered, band = [], []
    for b in boxes:
        if band and (b[1] + b[3]) / 2 - (band[0][1] + band[0][3]) / 2 > (band[0][3] - band[0][1]) / 2:
            ordered += sorted(band, key=lambda b: b[0])
            band = []
        band.append(b)
    return ordered + sorted(band, key=lambda b: b[0])


def build_items() -> dict[str, int]:
    icons: dict[str, Image.Image] = {}
    for sheet, picks in ITEM_PICKS.items():
        rgb = np.asarray(Image.open(ART / sheet).convert('RGB'))
        found = blobs(rgb)
        preview(rgb, found, PREVIEW / f'blobs-{Path(sheet).stem}.png')
        for k, item in picks.items():
            x0, y0, x1, y1 = found[k]
            pad = 6
            crop = rgb[max(0, y0 - pad):y1 + pad, max(0, x0 - pad):x1 + pad]
            rgba = Image.fromarray(cut_out(np.ascontiguousarray(crop)))
            rgba = rgba.crop(rgba.getbbox())
            rgba.thumbnail((CELL - 12, CELL - 12), Image.LANCZOS)
            icons[item] = rgba
    known = [i['id'] for i in json.loads((ROOT / 'assets' / 'items' / 'items.json').read_text())['items']]
    missing = sorted(set(known) - set(icons))
    if missing:
        raise SystemExit(f'items without an icon: {missing}')
    order = [i for i in known if i in icons]
    rows = (len(order) + ICON_COLS - 1) // ICON_COLS
    atlas = Image.new('RGBA', (ICON_COLS * CELL, rows * CELL), (0, 0, 0, 0))
    for n, item in enumerate(order):
        im = icons[item]
        x = (n % ICON_COLS) * CELL + (CELL - im.width) // 2
        y = (n // ICON_COLS) * CELL + (CELL - im.height) // 2
        atlas.alpha_composite(im, (x, y))
    save(atlas, 'items.webp')
    return {item: n for n, item in enumerate(order)}


def preview(rgb: np.ndarray, boxes, path: Path) -> None:
    im = Image.fromarray(rgb).copy()
    d = ImageDraw.Draw(im)
    for n, (x0, y0, x1, y1) in enumerate(boxes):
        d.rectangle((x0, y0, x1, y1), outline=(255, 0, 0), width=2)
        d.text((x0 + 3, y0 + 2), str(n), fill=(255, 0, 0))
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path)


# ---- glass ------------------------------------------------------------------------------------

def light_on_black(rgb: np.ndarray) -> Image.Image:
    """Black → transparent: alpha is the brightest channel, colour un-premultiplied from it."""
    f = rgb.astype(np.float32) / 255
    a = f.max(2)
    a = np.clip((a - 0.06) / 0.94, 0, 1)          # the model's "black" is never quite 0
    col = np.where(a[..., None] > 0, np.clip(f / np.maximum(f.max(2, keepdims=True), 1e-3), 0, 1), 0)
    out = np.dstack([col * 255, a * 255]).astype(np.uint8)
    return Image.fromarray(out, 'RGBA')


def build_glass() -> dict:
    crack = np.asarray(Image.open(ART / 'glass-crack.png').convert('RGB'))
    save(light_on_black(crack).resize((640, 640), Image.LANCZOS), 'glass-crack.webp')

    hole = np.asarray(Image.open(ART / 'glass-hole.png').convert('RGB'))
    save(light_on_black(hole).resize((640, 640), Image.LANCZOS), 'glass-rim.webp')
    # The hole: dark pixels connected to the centre (the rim is lit, so the fill stops at it).
    h, w = hole.shape[:2]
    # The rim is thickened first so the fill can't leak out through a gap between two teeth.
    rim = dilate(hole.max(2) >= 60, 6)
    dark = Image.fromarray((~rim * 255).astype(np.uint8)).copy()
    ImageDraw.floodfill(dark, (w // 2, h // 2), 128)
    inside = dilate(np.asarray(dark) == 128, 10)   # back out to the rim, and just under its inner edge
    if inside.mean() > 0.8:
        raise SystemExit('glass-hole: the hole is not closed (the fill leaked outside the rim)')
    ys, xs = np.nonzero(inside)
    mask = np.zeros((h, w, 4), np.uint8)
    mask[inside] = (255, 255, 255, 255)
    save(Image.fromarray(mask, 'RGBA').resize((640, 640), Image.LANCZOS), 'hole-mask.webp')

    shards = np.asarray(Image.open(ART / 'glass-shards.png').convert('RGB'))
    sh, sw = shards.shape[:2]
    atlas = Image.new('RGBA', (3 * SHARD_CELL, 3 * SHARD_CELL), (0, 0, 0, 0))
    for k in range(9):
        cx, cy = k % 3, k // 3
        inset = 6   # skip the drawn panel dividers
        cell = shards[cy * sh // 3 + inset:(cy + 1) * sh // 3 - inset, cx * sw // 3 + inset:(cx + 1) * sw // 3 - inset]
        im = light_on_black(cell)
        im = im.crop(im.getbbox())
        im.thumbnail((SHARD_CELL - 8, SHARD_CELL - 8), Image.LANCZOS)
        atlas.alpha_composite(im, (cx * SHARD_CELL + (SHARD_CELL - im.width) // 2, cy * SHARD_CELL + (SHARD_CELL - im.height) // 2))
    save(atlas, 'glass-shards.webp')
    return {'top': ys.min() / h, 'bottom': ys.max() / h, 'left': xs.min() / w, 'right': xs.max() / w}


# ---- beach ------------------------------------------------------------------------------------

def build_beach() -> dict:
    im = Image.open(ART / 'beach.png').convert('RGB')
    rgb = np.asarray(im).astype(np.int32)
    h = rgb.shape[0]
    blue = (rgb[..., 2] - rgb[..., 0]).mean(1)     # per row: how much bluer than red
    sat = (rgb.max(2) - rgb.min(2)).mean(1)
    # horizon: the first row in the top half where the sea's strong saturation starts
    horizon = next(y for y in range(int(h * 0.15), int(h * 0.6)) if sat[y] > sat[int(h * 0.1)] + 40)
    # shoreline: the first row below the horizon where the rows stop being blue (sand)
    shore = next(y for y in range(horizon + 10, h) if blue[y] < 10)
    save(im.resize((640, 640), Image.LANCZOS), 'beach.webp')
    return {'horizon': horizon / h, 'shore': shore / h}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    items = build_items()
    hole = build_glass()
    beach = build_beach()
    digest = hashlib.sha256(b''.join(p.read_bytes() for p in sorted(OUT.glob('*.webp')))).hexdigest()[:12]
    meta = {'version': digest, 'cell': CELL, 'cols': ICON_COLS, 'items': items, 'shardCell': SHARD_CELL,
            'hole': {k: round(v, 3) for k, v in hole.items()}, 'beach': {k: round(v, 3) for k, v in beach.items()}}
    (OUT / 'treasure.json').write_text(json.dumps(meta, indent=2) + '\n')
    print(f"items: {len(items)}  hole: {meta['hole']}  beach: {meta['beach']}")


if __name__ == '__main__':
    main()
