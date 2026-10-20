"""Expression patches: swap the face of existing frames for another mood without redrawing them.

    python3 -I scripts/sprites/faces.py <base.png> <edited.png> <out_dir> <frame.png>...

<base> is one frame as drawn; <edited> is the same frame with only the expression changed (an
image-model edit of <base>, same framing up to a uniform scale). The edited face is lifted out as
a patch and laid onto every <frame>: aligned on each frame's face row by row (its
left/right cheek contour), and kept under that frame's own bangs wherever they cover what was skin in <base>.
Writes <out_dir>/<frame name> plus a side-by-side preview (<out_dir>/preview.png). The sprite
build (build_sprites.py, manifest "faces") calls apply_face() directly.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


def load(path: Path, size=None) -> np.ndarray:
    im = Image.open(path).convert('RGB')
    if size and im.size != size:
        im = im.resize(size, Image.LANCZOS)
    return np.asarray(im).astype(np.int16)


def skin(a: np.ndarray) -> np.ndarray:
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    return (r > 205) & (g > 160) & (b > 130) & (r - b > 12) & (r < 256)


def hairlike(a: np.ndarray) -> np.ndarray:
    r, b = a[..., 0], a[..., 2]
    return (b - r > 25) & (a.max(axis=2) < 215)


def face_hull(a: np.ndarray) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    """The face: the largest skin blob in the upper half, filled row by row between its edges."""
    h, w = a.shape[:2]
    s = skin(a)
    s[h // 2:] = False                       # the face is in the upper half; hands and legs are not
    ys, xs = np.nonzero(s)
    # keep the dense core: rows/columns that hold a fair share of skin (drops stray skin-coloured bits)
    rows = np.bincount(ys, minlength=h)
    good_rows = np.nonzero(rows > rows.max() * 0.15)[0]
    y0, y1 = good_rows.min(), good_rows.max()
    s[:y0] = False
    s[y1 + 1:] = False
    cols = np.bincount(np.nonzero(s)[1], minlength=w)
    good_cols = np.nonzero(cols > cols.max() * 0.15)[0]
    x0, x1 = good_cols.min(), good_cols.max()
    hull = np.zeros_like(s)
    for y in range(y0, y1 + 1):
        xs_row = np.nonzero(s[y, x0:x1 + 1])[0]
        if len(xs_row):
            hull[y, x0 + xs_row.min():x0 + xs_row.max() + 1] = True
    return hull, (x0, y0, x1, y1)


def grow(m: np.ndarray, n: int) -> np.ndarray:
    m = m.copy()
    for _ in range(n):
        m[1:] |= m[:-1]; m[:-1] |= m[1:]; m[:, 1:] |= m[:, :-1]; m[:, :-1] |= m[:, 1:]
    return m


def shrink(m: np.ndarray, n: int) -> np.ndarray:
    return ~grow(~m, n)


def warp(a: np.ndarray, src_box, dst_box, shape) -> np.ndarray:
    """Move/scale `a` so that src_box lands on dst_box (nearest neighbour; masks and pixels)."""
    sx0, sy0, sx1, sy1 = src_box
    dx0, dy0, dx1, dy1 = dst_box
    k = ((dx1 - dx0) / (sx1 - sx0) + (dy1 - dy0) / (sy1 - sy0)) / 2
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w]
    # destination centre ← source centre
    cx_s, cy_s = (sx0 + sx1) / 2, (sy0 + sy1) / 2
    cx_d, cy_d = (dx0 + dx1) / 2, (dy0 + dy1) / 2
    src_x = np.clip(np.round((xx - cx_d) / k + cx_s).astype(int), 0, a.shape[1] - 1)
    src_y = np.clip(np.round((yy - cy_d) / k + cy_s).astype(int), 0, a.shape[0] - 1)
    return a[src_y, src_x]


def row_edges(hull: np.ndarray, box) -> tuple[np.ndarray, np.ndarray]:
    """Left/right face edge for every row of the face box (rows without skin borrow their neighbour)."""
    x0, y0, x1, y1 = box
    left = np.full(y1 - y0 + 1, np.nan)
    right = np.full(y1 - y0 + 1, np.nan)
    for i, y in enumerate(range(y0, y1 + 1)):
        xs = np.nonzero(hull[y])[0]
        if len(xs):
            left[i], right[i] = xs.min(), xs.max()
    idx = np.arange(len(left))
    width = right - left
    # only rows that span (nearly) the whole face are trusted: on the forehead the bangs leave just
    # scattered gaps of skin, whose edges say nothing about the face; those rows borrow the nearest
    # trusted row (np.interp clamps at the ends)
    ok = ~np.isnan(width) & (width >= np.nanmax(width) * 0.7)
    # The edge rows also catch the tips of hair strands lying on the cheek, so a raw per-row edge
    # zigzags. Fit a smooth curve (quadratic) through the trusted rows instead.
    fl = np.polyfit(idx[ok], left[ok], 2)
    fr = np.polyfit(idx[ok], right[ok], 2)
    return np.polyval(fl, idx), np.polyval(fr, idx)


def fit(a: np.ndarray, src, dst, shape) -> np.ndarray:
    """Map `a` from the source face onto the destination face row by row: each destination row's
    left/right face edges land on the matching source row's edges, so the patch follows the cheek
    contour of every frame. Rows above/below the face reuse the nearest face row's mapping."""
    (s_hull, s_box), (d_hull, d_box) = src, dst
    sl, sr = row_edges(s_hull, s_box)
    dl, dr = row_edges(d_hull, d_box)
    h, w = shape
    sy0, sy1 = s_box[1], s_box[3]
    dy0, dy1 = d_box[1], d_box[3]
    ky = (sy1 - sy0) / (dy1 - dy0)
    yy, xx = np.mgrid[0:h, 0:w]
    src_y = (yy - dy0) * ky + sy0
    di = np.clip(yy - dy0, 0, len(dl) - 1)                       # destination face row
    si = np.clip(np.round(src_y - sy0).astype(int), 0, len(sl) - 1)   # matching source face row
    t = (xx - dl[di]) / np.maximum(dr[di] - dl[di], 1)
    fitted_x = sl[si] + t * (sr[si] - sl[si])
    # Eyes and brows move rigidly (one scale for the whole face, so their shape is kept); from the
    # cheeks down the mapping follows the contour. Blend between the two across the lower eye area.
    kx = (s_box[2] - s_box[0]) / (d_box[2] - d_box[0])
    rigid_x = (xx - (d_box[0] + d_box[2]) / 2) * kx + (s_box[0] + s_box[2]) / 2
    rel = (yy - dy0) / max(dy1 - dy0, 1)
    wgt = np.clip((rel - 0.45) / 0.25, 0, 1)
    src_x = rigid_x * (1 - wgt) + fitted_x * wgt
    src_x = np.clip(np.round(src_x).astype(int), 0, a.shape[1] - 1)
    src_y = np.clip(np.round(src_y).astype(int), 0, a.shape[0] - 1)
    return a[src_y, src_x]


def apply_face(base_p: Path, edit_p: Path, frame_paths: list[Path]) -> list[Image.Image]:
    """The edited face of <base_p> laid onto each frame; returns the new frames (RGB, frame size)."""
    base_img = Image.open(base_p)
    base = load(base_p)
    edit = load(edit_p, base_img.size)
    hull0, box0 = face_hull(base)
    # The patch: what the edit actually changed (brows, eyes, mouth, blush) near the face, plus the
    # inner face, but never the face outline: each frame keeps its own jaw and cheek line.
    x0, y0, x1, y1 = box0
    fw, fh = x1 - x0, y1 - y0
    near = np.zeros_like(hull0)
    near[max(0, y0 - int(fh * 0.35)):y1 + int(fh * 0.05), max(0, x0 - int(fw * 0.1)):x1 + int(fw * 0.1)] = True
    changed = (np.abs(edit - base).sum(axis=2) > 60) & near
    changed = grow(shrink(changed, 1), 4)                 # drop specks, then take a little margin
    area0 = (changed | shrink(hull0, 6)) & grow(hull0, 30) & near
    base_skin = skin(base)
    out = []
    for fp in frame_paths:
        tgt = load(fp)
        hull, box = face_hull(tgt)
        shape = tgt.shape[:2]
        src, dst = (hull0, box0), (hull, box)
        area = fit(area0, src, dst, shape)
        patch = fit(edit, src, dst, shape)
        was_skin = fit(base_skin, src, dst, shape)
        # Below the eyes the patch stays inside this frame's own jaw/cheek line.
        x0, y0, x1, y1 = box
        lower = np.zeros_like(area)
        lower[y0 + int((y1 - y0) * 0.55):] = True
        area = area & ~(lower & ~grow(hull, 2))
        # The frame's own hair stays on top: bangs where <base> showed skin, and the strands lying
        # along the cheek edge. Inside the face (eyes) blue is iris, not hair, so it is replaced.
        edge = ~shrink(hull, 6) & lower      # side strands only; the top edge runs through the eyes
        keep = hairlike(tgt) & ~hairlike(patch) & (was_skin | edge)
        # soft edge: blend the patch in over ~3 px
        alpha = np.asarray(Image.fromarray((area * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2))) / 255.0
        alpha = np.where(keep, 0.0, alpha)[..., None]
        res = tgt * (1 - alpha) + patch * alpha
        out.append(Image.fromarray(res.astype(np.uint8)))
    return out


def main(base_p: str, edit_p: str, out_dir: str, *frames: str) -> None:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    results = apply_face(Path(base_p), Path(edit_p), [Path(f) for f in frames])
    previews = []
    for fp, img in zip(frames, results):
        img.save(out / Path(fp).name)
        tgt = Image.open(fp).convert('RGB')
        _, (x0, y0, x1, y1) = face_hull(load(Path(fp)))
        pad = (x1 - x0) // 2
        crop = (max(0, x0 - pad), max(0, y0 - pad * 2), min(tgt.width, x1 + pad), min(tgt.height, y1 + pad))
        pair = Image.new('RGB', ((crop[2] - crop[0]) * 2, crop[3] - crop[1]), 'white')
        pair.paste(tgt.crop(crop), (0, 0))
        pair.paste(img.crop(crop), (crop[2] - crop[0], 0))
        previews.append(pair.resize((600, round(600 * pair.height / pair.width))))
    sheet = Image.new('RGB', (600, sum(p.height for p in previews)), 'white')
    y = 0
    for p in previews:
        sheet.paste(p, (0, y)); y += p.height
    sheet.save(out / 'preview.png')


if __name__ == '__main__':
    main(*sys.argv[1:])
