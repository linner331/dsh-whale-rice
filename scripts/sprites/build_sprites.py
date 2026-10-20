#!/usr/bin/env python3
"""
Build the whale sprite atlas from the generated artwork.

    python3 scripts/sprites/build_sprites.py            # uses art/sprites.json

Pipeline per source image (white background, single pose or 2x2 grid):
  1. split grids along their white gutters
  2. cut the white background out (flood fill from the border + enclosed pure-white pockets),
     soften the edge and un-premultiply the white fringe
  3. optional inpainting (removes stray onomatopoeia text drawn by the image model)
  4. scale every frame of a source by one factor (so poses inside a grid keep their relative size),
     put the feet on a shared ground line and the head on a shared vertical axis
Then pack all frames into one atlas + JSON (frame ids, animations with per-frame durations).
"""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
WHITE = 236            # min(r,g,b) at or above this counts as background white
BULK_MIN_WIDTH = 0.25  # body rows narrower than this share of the widest row are protrusions
FACE_MIN_SHARE = 0.012  # a skin blob smaller than this share of the body is a hand, not the face
DARK = 200             # gutter detection: a pixel below this is "ink"


# ---- connected components (4-connected, via PIL flood fill; no scipy needed) -----------------

def components(mask: np.ndarray) -> list[np.ndarray]:
    m = Image.fromarray(mask.astype(np.uint8) * 255).copy()
    out = []
    for y, x in zip(*np.nonzero(mask)):
        if m.getpixel((int(x), int(y))) != 255:
            continue
        ImageDraw.floodfill(m, (int(x), int(y)), 100)
        a = np.asarray(m)
        comp = a == 100
        out.append(comp)
        m = Image.fromarray(np.where(comp, 50, a).astype(np.uint8)).copy()
    return out


def dilate(mask: np.ndarray, n: int) -> np.ndarray:
    for _ in range(n):
        o = mask.copy()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            o |= np.roll(np.roll(mask, dy, 0), dx, 1)
        mask = o
    return mask


# ---- 1. grid splitting -----------------------------------------------------------------------

def split(rgb: np.ndarray, grid: list[int] | None) -> list[tuple[int, int, np.ndarray]]:
    """
    Return [(x0, y0, crop)] in reading order for a `[cols, rows]` grid.

    Panels from the image model often touch (a tail reaching into the next row, an ahoge poking up
    past a neighbour), so no straight gutter separates them. Instead every non-white blob is
    assigned to the cell its centre falls in; a frame is the bounding box of its own blobs, with any
    pieces of neighbouring characters inside that box painted white.
    """
    if not grid:
        return [(0, 0, rgb)]
    cols, rows = grid
    h, w = rgb.shape[:2]
    blobs = [c for c in components(rgb.min(2) < WHITE) if c.sum() >= 20]
    owner = np.full((h, w), -1, np.int32)
    by_cell: dict[int, list[np.ndarray]] = {}
    for c in blobs:
        ys, xs = np.nonzero(c)
        bh, bw = ys.max() - ys.min() + 1, xs.max() - xs.min() + 1
        thin_line = (bh <= 9 and bw >= 40) or (bw <= 9 and bh >= 40)   # drawn floor / panel divider
        grid_frame = bw >= w * 0.9 or bh >= h * 0.9                      # a divider spanning the sheet
        if thin_line or grid_frame and c.sum() < 0.03 * h * w:
            owner[c] = -2
            continue
        cell = min(int(ys.mean() * rows / h), rows - 1) * cols + min(int(xs.mean() * cols / w), cols - 1)
        by_cell.setdefault(cell, []).append(c)
        owner[c] = cell
    cells = []
    for cell in range(cols * rows):
        mine = by_cell.get(cell)
        if not mine:                       # an empty panel (list it as null in "frames")
            cells.append((0, 0, None))
            continue
        ys, xs = np.nonzero(np.logical_or.reduce(mine))
        pad = 6
        y0, y1 = max(0, ys.min() - pad), min(h, ys.max() + pad + 1)
        x0, x1 = max(0, xs.min() - pad), min(w, xs.max() + pad + 1)
        crop = rgb[y0:y1, x0:x1].copy()
        box = owner[y0:y1, x0:x1]
        others = dilate(((box >= 0) & (box != cell)) | (box == -2), 2)
        crop[others] = 255
        cells.append((x0, y0, crop))
    return cells


# ---- 2. background removal -------------------------------------------------------------------

def cut_out(rgb_u8: np.ndarray) -> np.ndarray:
    rgb = rgb_u8.astype(np.float32)
    mn = rgb.min(2)
    m = Image.fromarray(np.pad((mn >= WHITE).astype(np.uint8) * 255, 1, constant_values=255)).copy()
    ImageDraw.floodfill(m, (0, 0), 128)
    bg = np.asarray(m)[1:-1, 1:-1] == 128
    # enclosed pockets (gaps between hair strands): pure, unshaded white
    sat = rgb.max(2) - mn
    for c in components((mn >= WHITE) & ~bg):
        if c.sum() >= 30 and mn[c].mean() >= 249 and sat[c].mean() < 4.5:
            bg |= c
    ring = dilate(bg, 2) & ~bg
    alpha = np.where(bg, 0.0, 1.0)
    alpha = np.where(ring, np.minimum(1.0, np.clip((255 - mn) / (255 - 150), 0, 1)), alpha)
    a3 = np.maximum(alpha, 1e-3)[..., None]
    col = np.clip((rgb - (1 - a3) * 255) / a3, 0, 255)       # un-premultiply against white
    return np.dstack([col, alpha * 255]).astype(np.uint8)


def strip_floor_line(rgba: np.ndarray) -> np.ndarray:
    """Remove a drawn floor line under the feet: a thin, wide band of opaque rows near the bottom.
    Columns that are opaque just above the band (the shoes) are kept."""
    a = rgba[..., 3] > 128
    h, w = a.shape
    widths = a.sum(1)
    xs = np.nonzero(a.any(0))[0]
    span = xs.max() - xs.min() + 1
    band = [y for y in range(int(h * 0.6), h) if widths[y] >= 0.4 * span and widths[max(0, y - 8)] < 0.7 * widths[y]]
    if not band:
        return rgba
    y0, y1 = min(band), max(band)
    if y1 - y0 > 10:            # not a thin line: leave it alone
        return rgba
    keep = a[max(0, y0 - 3)]    # shoe columns right above the line
    out = rgba.copy()
    out[y0:y1 + 1, ~keep, 3] = 0
    return out


def keep_main(rgba: np.ndarray) -> np.ndarray:
    """Drop everything not attached to the character (drawn shadows, motion lines, puffs)."""
    main = max(components(rgba[..., 3] > 40), key=lambda c: c.sum())
    out = rgba.copy()
    out[~dilate(main, 2), 3] = 0
    return out


# ---- 3. inpainting ---------------------------------------------------------------------------

def inpaint(rgba: np.ndarray, boxes: list[dict]) -> np.ndarray:
    """Diffuse surrounding colour into small text/mark areas. Box coords are frame-local."""
    im = rgba.astype(np.float32)
    rgb = im[..., :3]
    sat = rgb.max(2) - rgb.min(2)
    mask = np.zeros(im.shape[:2], bool)
    for spec in boxes:
        x0, y0, x1, y1 = spec["box"]
        box = np.zeros_like(mask)
        box[y0:y1, x0:x1] = True
        box &= im[..., 3] > 0
        if spec["mode"] == "marks":      # white marks with dark outline over hair
            mask |= dilate(box & (sat < 40), 2)
        else:                            # dark/white lettering over hair and skin
            mask |= dilate(box & ((sat < 22) | (rgb.max(2) < 115)), 1)
    known = ~mask
    im[mask] = 0
    for _ in range(400):
        acc = np.zeros_like(im)
        cnt = np.zeros(mask.shape, np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            k = np.roll(np.roll(known, dy, 0), dx, 1)
            acc += np.roll(np.roll(im, dy, 0), dx, 1) * k[..., None]
            cnt += k
        upd = mask & (cnt > 0)
        im[upd] = acc[upd] / cnt[upd][:, None]
        known |= upd
    return im.clip(0, 255).astype(np.uint8)


# ---- 4. measuring and placing ----------------------------------------------------------------

def measure(rgba: np.ndarray) -> dict:
    """
    Where the character itself is, ignoring things that vary from pose to pose:
      height  – top of the hair mass to the feet: rows of the body narrower than BULK_MIN_WIDTH of
                its widest row (the ahoge, a hand raised above the head) don't count
      head_x  – centre of the face (largest skin-coloured blob in the upper body); falls back to the
                centre of the hair mass when the face is hidden
      head_h  – top of the hair mass to the chin: the head size as it reads, unlike the face width
                not inflated by closed eyes (the skin is not split by the eyes)
      body_cx – centre of the body's bounding box (anchor for lying / rolling poses)
    Floating effects and props on the floor are separate blobs and are ignored entirely.
    """
    main = max(components(rgba[..., 3] > 128), key=lambda c: c.sum())
    widths = main.sum(1)
    rows = np.nonzero(widths)[0]
    bottom = int(rows.max())
    top = int(np.nonzero(widths >= widths.max() * BULK_MIN_WIDTH)[0].min())

    r, g, b = (rgba[..., k].astype(int) for k in range(3))
    skin = main & (r > 215) & (r - b > 18) & (r - b < 75) & (g > 170) & (r >= g) & (g >= b - 5)
    upper = np.zeros_like(main)
    upper[top:top + int((bottom - top) * 0.55)] = True
    blobs = sorted(components(skin & upper), key=lambda c: -c.sum())
    face_w = head_h = None
    if blobs and blobs[0].sum() >= main.sum() * FACE_MIN_SHARE:
        head_x = float(np.nonzero(blobs[0])[1].mean())
        fy, fx = np.nonzero(blobs[0])
        face_w = float(fx.max() - fx.min() + 1)
        head_h = float(fy.max() - top + 1)    # top of the hair mass → chin
    else:
        head_x = float(np.nonzero(main[top:top + int((bottom - top) * 0.3)])[1].mean())
    cols = np.nonzero(main.any(0))[0]
    body_cx = (cols.min() + cols.max()) / 2
    return {"top": top, "bottom": bottom, "height": bottom - top + 1, "head_x": head_x,
            "body_cx": float(body_cx), "face_w": face_w, "head_h": head_h}


def pin_point(alpha: np.ndarray) -> tuple[float, int]:
    """Top of the silhouette, searched in the middle half of its width (the scruff when held)."""
    xs = np.nonzero(alpha.any(0))[0]
    lo, hi = xs.min() + (xs.max() - xs.min()) // 4, xs.max() - (xs.max() - xs.min()) // 4
    band = alpha[:, lo:hi + 1]
    top = int(np.nonzero(band.any(1))[0].min())
    return lo + float(np.nonzero(band[top])[0].mean()), top


def place(rgba: np.ndarray, m: dict, scale: float, ground: int, cfg: dict, frame_id: str,
          pin: tuple[int, int] | None = None) -> Image.Image:
    cw, ch = cfg["cell"]["w"], cfg["cell"]["h"]
    ax, ay = cfg["anchor"]["x"], cfg["anchor"]["y"]
    img = Image.fromarray(rgba, "RGBA")
    img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    if pin:   # held frames: face centre and top of the head go on fixed points, so the body
              # doesn't jump between panels (the silhouette top moves with the ahoge and the tail)
        ox, oy = round(pin[2] - m["head_x"] * scale), round(pin[3] - m["top"] * scale)
    else:
        ox, oy = round(ax - m["head_x"] * scale), round(ay - (ground + 1) * scale)
    cell = Image.new("RGBA", (cw, ch))
    cell.alpha_composite(img, (max(ox, 0), max(oy, 0)), (max(-ox, 0), max(-oy, 0)))
    a = np.asarray(img)[..., 3] > 20
    ys, xs = np.nonzero(a)
    clipped = [s for s, bad in (("left", xs.min() + ox < 0), ("right", xs.max() + ox >= cw),
                                ("top", ys.min() + oy < 0), ("bottom", ys.max() + oy >= ch)) if bad]
    if clipped:
        print(f"  ! {frame_id}: clipped on {', '.join(clipped)}")
    return cell


# ---- manifest helpers ------------------------------------------------------------------------

def frame_ids(spec) -> list:
    """A list of ids (None = skip that cell), or {"prefix": "roll", "count": 36} → roll-00 … roll-35."""
    if isinstance(spec, dict):
        return [f"{spec['prefix']}-{i:02d}" for i in range(spec["count"])]
    return spec


def expand(ids: list[str]) -> list[str]:
    """Expand "kick-1..kick-4" / "roll-02..roll-32" into the ids in between (digit width as written)."""
    out = []
    for item in ids:
        if ".." in item:
            a, b = item.split("..")
            prefix, first = a.rsplit("-", 1)
            width = len(first)
            out += [f"{prefix}-{i:0{width}d}" for i in range(int(first), int(b.rsplit("-", 1)[1]) + 1)]
        else:
            out.append(item)
    return out


# ---- main ------------------------------------------------------------------------------------

def main(manifest_path: Path) -> None:
    cfg = json.loads(manifest_path.read_text())
    art = manifest_path.parent
    body_h = cfg["bodyHeight"]

    # pass 1: cut and measure every frame
    sources = []
    for src in cfg["sources"]:
        rgb = np.asarray(Image.open(art / src["file"]).convert("RGB"))
        frames = []
        ids_here = frame_ids(src["frames"])
        standing = set(expand(src["standing"])) if "standing" in src else None
        sitting = set(expand(src.get("sitting", [])))
        mirror = set(expand(src.get("mirror", [])))
        for k, ((x0, y0, crop), fid) in enumerate(zip(split(rgb, src.get("grid")), ids_here)):
            if fid is None:
                continue
            if crop is None:
                sys.exit(f"{src['file']}: panel {k + 1} is empty but is listed as {fid}")
            row = k // src["grid"][0] if src.get("grid") else 0
            rgba = cut_out(crop)
            if src.get("floorLines"):
                rgba = strip_floor_line(rgba)
            if fid in set(expand(src.get("mainOnly", []))):
                rgba = keep_main(rgba)
            boxes = [dict(b, box=[b["box"][0] - x0, b["box"][1] - y0, b["box"][2] - x0, b["box"][3] - y0])
                     for b in src.get("inpaint", []) if b["frame"] == fid]
            if boxes:
                rgba = inpaint(rgba, boxes)
            # "mirror": frames the model drew facing the other way, flipped so a sequence keeps one direction
            if fid in mirror:
                rgba = np.ascontiguousarray(rgba[:, ::-1])
            m = measure(rgba)
            m["row"] = row
            m["sitting"] = (fid not in standing) if standing is not None else fid in sitting
            frames.append((fid, rgba, m))
        # "anchor": "body" (tumbling): faces jump around in curled / upside-down poses, so those are
        # placed by their body centre plus one fixed offset taken from the sheet's standing frames
        # (which keep the usual face anchor), so the sequence starts and ends in line with every pose.
        if src.get("anchor") == "body":
            offsets = [m["head_x"] - m["body_cx"] for _, _, m in frames if not m["sitting"]]
            off = float(np.mean(offsets)) if offsets else 0.0
            for _, _, m in frames:
                if m["sitting"]:
                    m["head_x"] = m["body_cx"] + off
        sources.append((src, frames))
        print(f"cut {src['file']}: {', '.join(f for f, _, _ in frames)}")

    # Scale. The image model draws panels of one grid at slightly different sizes (the top row is
    # often 5-8% smaller), so every standing frame is normalised to bodyHeight on its own.
    # Sitting/lying frames can't be measured that way; they borrow the mean scale of the standing
    # frames in their grid (same row first), or — for a sheet with no standing pose at all —
    # "scaleMatch": {frame, to} makes `frame` exactly as tall as the already-placed frame `to`.
    frames_of = {src["file"]: frames for src, frames in sources}
    scale, height, face = {}, {}, {}
    for _, frames in sources:
        for fid, _, m in frames:
            height[fid] = m["height"]
            face[fid] = m["face_w"]
            if not m["sitting"]:
                scale[fid] = body_h / m["height"]
    # Across sheets, equal heights are not enough: every sheet was drawn with its own head-to-body
    # proportion, so the face would jump in size whenever playback moves from one sheet's frames to
    # another's (a landing → the rest pose). Each sheet with standing frames therefore gets one extra
    # factor that brings its median head height to the median over all sheets. "faceMatch" (0..1)
    # chooses the balance: 1 = equal heads (bodies may differ a little), 0 = equal heights.
    alpha = float(cfg.get("faceMatch", 1.0))
    sheet_face = {}
    for src, frames in sources:
        heads = [m["head_h"] * scale[f] for f, _, m in frames if not m["sitting"] and m["head_h"] is not None]
        if heads:
            sheet_face[src["file"]] = float(np.median(heads))
    if sheet_face and alpha:
        target = float(np.median(list(sheet_face.values())))
        for src, frames in sources:
            if src["file"] in sheet_face:
                k = (target / sheet_face[src["file"]]) ** alpha
                for f, _, m in frames:
                    if not m["sitting"]:
                        scale[f] *= k

    pending = [(src, fid, m) for src, frames in sources for fid, _, m in frames if m["sitting"]]
    for _ in range(3):   # later passes resolve scaleMatch chains (sheet → sheet → standing frame)
        for src, fid, m in pending:
            if fid in scale:
                continue
            same_sheet = [(scale[f], mm["row"] == m["row"])
                          for f, _, mm in frames_of[src["file"]] if not mm["sitting"]]
            same_row = [v for v, r in same_sheet if r]
            if same_row or same_sheet:
                scale[fid] = float(np.mean(same_row or [v for v, _ in same_sheet]))
            elif "scaleMatch" in src and src["scaleMatch"]["to"] in scale:
                ref, mine = src["scaleMatch"]["to"], src["scaleMatch"]["frame"]
                # by "height" (similar poses) or "face" (face width; pick frames with open eyes)
                size = face if src["scaleMatch"].get("by") == "face" else height
                if size.get(ref) is None or size.get(mine) is None:
                    sys.exit(f"scaleMatch {mine} → {ref}: no measurable {src['scaleMatch'].get('by', 'height')}")
                sheet_scale = scale[ref] * size[ref] / size[mine]
                for f, _, _ in frames_of[src["file"]]:
                    scale[f] = sheet_scale
    # "scaleAdjust": a manual factor for sheets the measurements misjudge (e.g. bangs hiding the
    # face in a hanging pose); tuned by eye against a neighbouring sheet.
    # "uniform": a cycle (running) must keep the size and rise/fall the artist drew between its frames,
    # so the whole sheet shares one scale — the median of its frames' individual scales.
    for src, frames in sources:
        if src.get("uniform"):
            k = float(np.median([scale[f] for f, _, _ in frames if f in scale]))
            for f, _, _ in frames:
                scale[f] = k

    # "frameScale": the same, per frame (a few panels drawn with a smaller head than their neighbours).
    for src, frames in sources:
        for f, _, _ in frames:
            if f in scale:
                scale[f] *= src.get("scaleAdjust", 1.0) * src.get("frameScale", {}).get(f, 1.0)

    missing = [fid for _, fid, _ in pending if fid not in scale]
    if missing:
        sys.exit(f"no scale for sitting frames {missing}: add a standing frame to the grid or a scaleMatch")

    # pass 2: place and pack. Feet go on the ground; frames listed in "airborne" (a jump) keep their
    # height above the floor line of their grid row instead.
    pinned = {fid: (spec.get("x", cfg["anchor"]["x"]), spec.get("y", 40), spec["faceX"], spec["headTop"])
              for spec in cfg.get("pins", {}).values() for fid in expand(spec["frames"])}
    cells, ids = [], []
    for src, frames in sources:
        airborne = set(expand(src.get("airborne", [])))
        floor, any_floor = {}, {}
        for fid, _, m in frames:
            any_floor[m["row"]] = max(any_floor.get(m["row"], 0), m["bottom"])
            if fid not in airborne:
                floor[m["row"]] = max(floor.get(m["row"], 0), m["bottom"])
        for fid, rgba, m in frames:
            # an airborne frame keeps its height above its row's floor line (the lowest foot in the
            # row when every frame of a cycle is listed)
            ground = floor.get(m["row"], any_floor[m["row"]]) if fid in airborne else m["bottom"]
            # "raise": {frame: px} lifts a grounded frame off the floor (a flight pose drawn standing)
            lift = src.get("raise", {}).get(fid, 0)
            cells.append(place(rgba, m, scale[fid], ground + lift / scale[fid], cfg, fid, pinned.get(fid)))
            ids.append(fid)
    if len(set(ids)) != len(ids):
        sys.exit("duplicate frame ids in manifest")

    cw, ch, cols = cfg["cell"]["w"], cfg["cell"]["h"], cfg["columns"]
    rows = (len(cells) + cols - 1) // cols
    atlas = Image.new("RGBA", (cw * cols, ch * rows))
    for i, cell in enumerate(cells):
        atlas.alpha_composite(cell, ((i % cols) * cw, (i // cols) * ch))

    out = cfg["output"]
    image_path = ROOT / out["image"]
    image_path.parent.mkdir(parents=True, exist_ok=True)

    index = {fid: i for i, fid in enumerate(ids)}
    animations = {}
    for name, a in cfg["animations"].items():
        seq = expand(a["frames"])
        missing = [f for f in seq if f not in index]
        if missing:
            sys.exit(f"animation {name}: unknown frames {missing}")
        ms = list(a["ms"]) if isinstance(a["ms"], list) else [a["ms"]] * len(seq)
        # "hold": extra time on the last frame, so the mood / pose lingers before the rest pose
        ms[-1] += a.get("hold", 0)
        if len(ms) != len(seq):
            sys.exit(f"animation {name}: {len(seq)} frames but {len(ms)} durations")
        animations[name] = {"frames": [index[f] for f in seq], "durations": ms}
    # "spin": the same curled-up ball drawn at 0/90/180/270° (rolling direction). The runtime turns
    # it like a wheel around one pivot, so the four frames are re-centred on a shared centre exactly
    # one rolling radius above the floor; distance travelled = angle × radius, so nothing slides.
    spin = None
    if "spin" in cfg:
        ids_ = [index[f] for f in cfg["spin"]["frames"]]
        boxes, radii = {}, []
        for i in ids_:
            ys, xs = np.nonzero(np.asarray(cells[i])[..., 3] > 128)
            boxes[i] = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
            radii.append(((xs.max() - xs.min() + 1) + (ys.max() - ys.min() + 1)) / 4)
        radius = float(np.mean(radii))
        cx = float(np.mean([(b[0] + b[2]) / 2 for b in boxes.values()]))
        cy = cfg["anchor"]["y"] - radius
        for i in ids_:
            b = boxes[i]
            dx, dy = round(cx - (b[0] + b[2]) / 2), round(cy - (b[1] + b[3]) / 2)
            moved = Image.new("RGBA", cells[i].size)
            moved.alpha_composite(cells[i], (max(dx, 0), max(dy, 0)), (max(-dx, 0), max(-dy, 0)))
            cells[i] = moved
            atlas.paste(moved, ((i % cols) * cw, (i // cols) * ch))
        spin = {"frames": ids_, "cx": round(cx, 1), "cy": round(cy, 1), "radius": round(radius, 1)}

    # "pins": frames held up by the scruff are placed with their face centre on `faceX` and the top
    # of their head on `headTop` (see place()); `x`/`y` is the grab point the runtime keeps under
    # the pointer.
    pins = {name: {"x": spec.get("x", cfg["anchor"]["x"]), "y": spec.get("y", 40)}
            for name, spec in cfg.get("pins", {}).items()}

    atlas.save(image_path, quality=90, method=6)

    meta = {
        "image": image_path.name,
        # Content hash: clients request the atlas as `whale.webp?v=<version>` so a rebuild is never
        # shadowed by a cached copy of the old image (the frame layout ships inside the JS bundle).
        "version": hashlib.sha256(image_path.read_bytes()).hexdigest()[:12],
        "cell": cfg["cell"],
        "columns": cols,
        "anchor": cfg["anchor"],
        "frames": ids,
        "poses": {k: index[v] for k, v in cfg["poses"].items()},
        "walkFacing": cfg.get("walkFacing", "right"),   # which way the walk frames face as drawn
        "rollFacing": cfg.get("rollFacing", "left"),    # which way the roll moves as drawn
        "runFacing": cfg.get("runFacing", "left"),      # which way the run frames face as drawn
        "animations": animations,
        "spin": spin,
        "pins": pins,
    }
    (ROOT / out["meta"]).write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n")

    # preview: contact sheet with frame ids on a light background
    if "preview" in out:
        sheet = Image.new("RGB", atlas.size, (238, 243, 250))
        sheet.paste(atlas, (0, 0), atlas)
        d = ImageDraw.Draw(sheet)
        for i, fid in enumerate(ids):
            d.text(((i % cols) * cw + 6, (i // cols) * ch + 4), f"{i} {fid}", fill=(60, 80, 120))
        prev = ROOT / out["preview"]
        prev.parent.mkdir(parents=True, exist_ok=True)
        sheet.save(prev)
    print(f"wrote {out['image']} ({len(cells)} frames, {atlas.width}x{atlas.height}) and {out['meta']}")


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "art" / "sprites.json")
