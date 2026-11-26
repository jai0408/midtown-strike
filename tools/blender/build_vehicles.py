"""Builds the Midtown Strike street vehicles (sedan, taxi, police, suv, humvee, van, truck, bus).

NOTE: the generated asset module is post-processed by tools/recompress_assets.py (textures re-encoded as WebP,
GLB images via EXT_texture_webp). Run it after this script; do not hand-edit the output.

    /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/build_vehicles.py

Bodies are lofted from cross-sections with real wheel-arch cut-outs (liner + tyre inside),
multi-segment raked glass, tumblehome and shoulder lines. All painted detail lives in ONE
shared 1024 atlas (albedo, normal, ORM) generated here with a small numpy SDF painter:
grille mesh, lamp reflectors, tail lenses, plates, door seams, handles, sidewalls, alloy /
steel wheels, tyre tread, interior silhouettes behind glass, grime at the sills.
  atlas albedo  : sRGB colour
  atlas normal  : tangent-space normal derived from painted height
  atlas orm     : R = body-paint mask (tinted per car at runtime), G = roughness, B = metalness
Vertex data: position, normal, uv, baked AO x grime (one byte), paint-mask id (0 fixed, 1 paint,
2 second paint). The game material is src/world/vehicle_material.js.

Environment switches (for iterating):
  KINDS=sedan,bus     build only these (the asset file is not written)
  NO_PREVIEW=1        skip the Cycles previews
  SAMPLES=32          preview samples
"""
import base64
import json
import math
import os
import struct
import sys
import time
import traceback
import zlib
from collections import defaultdict

import bmesh
import bpy
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT_JS = os.path.join(ROOT, "src", "world", "vehicles_asset.js")
PREVIEW_DIR = os.path.join(HERE, "preview")
SHEET_PATH = os.path.join(ROOT, "docs", "sheet_vehicles.png")

SCALE = 2000
AO_DIST = 1.0
AO_FLOOR = 0.42
SMOOTH = math.radians(58)
ONLY = [s for s in os.environ.get("KINDS", "").split(",") if s]
NO_PREVIEW = bool(os.environ.get("NO_PREVIEW")) or ("--noprev" in sys.argv)
SAMPLES = int(os.environ.get("SAMPLES", "40"))
ATLAS = 1024
PAD = 5


def s2l(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_lin(h):
    h = h.lstrip("#")
    return tuple(s2l(int(h[i:i + 2], 16) / 255.0) for i in (0, 2, 4))


def rgb(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)])


def lerp(a, b, t):
    return a + (b - a) * t


# ----------------------------------------------------------------------------------------------
# projections: vertex position -> (a, b) -> normalised (u, v), v = 0 at the TOP of the image
# ----------------------------------------------------------------------------------------------
def axes(mode, p):
    x, y, z = p
    if mode == "side":
        return z, y
    if mode in ("front", "rear"):
        return x, y
    return x, z  # top


def uvmaps(mode, bounds):
    a0, a1, b0, b1 = bounds
    if mode in ("side", "front"):
        fu = lambda a: (a1 - a) / (a1 - a0)
    else:
        fu = lambda a: (a - a0) / (a1 - a0)
    if mode == "top":
        fv = lambda b: (b - b0) / (b1 - b0)
    else:
        fv = lambda b: (b1 - b) / (b1 - b0)
    return fu, fv


# ----------------------------------------------------------------------------------------------
# tiny SDF painter
# ----------------------------------------------------------------------------------------------
TILES = {}
SWATCHES = {}


class Tile:
    def __init__(self, name, w, h, mode=None, bounds=None):
        self.name, self.w, self.h, self.mode, self.bounds = name, w, h, mode, bounds
        self.alb = np.zeros((h, w, 3))
        self.hgt = np.zeros((h, w))
        self.rgh = np.full((h, w), 0.5)
        self.met = np.zeros((h, w))
        self.msk = np.zeros((h, w))
        self.X, self.Y = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
        self.arect = None
        if bounds:
            self.fu, self.fv = uvmaps(mode, bounds)
            a0, a1, b0, b1 = bounds
            self.k = w / (a1 - a0)

    # world (axis) -> pixel
    def px(self, a):
        return self.fu(a) * self.w

    def py(self, b):
        return self.fv(b) * self.h

    def put(self, cov, col=None, h=None, add=False, r=None, m=None, k=None, a=1.0):
        a = np.clip(cov, 0, 1) * a
        if col is not None:
            c = np.asarray(col, dtype=float)
            if c.ndim == 1:
                c = c[None, None, :]
            self.alb = self.alb * (1 - a[..., None]) + c * a[..., None]
        if h is not None:
            self.hgt = self.hgt + h * a if add else self.hgt * (1 - a) + h * a
        if r is not None:
            self.rgh = self.rgh * (1 - a) + r * a
        if m is not None:
            self.met = self.met * (1 - a) + m * a
        if k is not None:
            self.msk = self.msk * (1 - a) + k * a

    # --- coverage shapes in PIXEL units
    def c_rrect(self, x0, y0, x1, y1, r=0.0):
        cx, cy, hx, hy = (x0 + x1) / 2, (y0 + y1) / 2, abs(x1 - x0) / 2, abs(y1 - y0) / 2
        r = min(r, hx, hy)
        qx, qy = np.abs(self.X - cx) - hx + r, np.abs(self.Y - cy) - hy + r
        d = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - r
        return np.clip(0.5 - d, 0, 1)

    def c_disc(self, cx, cy, r):
        return np.clip(0.5 - (np.hypot(self.X - cx, self.Y - cy) - r), 0, 1)

    def c_ring(self, cx, cy, r0, r1):
        d = np.abs(np.hypot(self.X - cx, self.Y - cy) - (r0 + r1) / 2) - abs(r1 - r0) / 2
        return np.clip(0.5 - d, 0, 1)

    def c_ellipse(self, cx, cy, rx, ry):
        d = (np.hypot((self.X - cx) / rx, (self.Y - cy) / ry) - 1.0) * min(rx, ry)
        return np.clip(0.5 - d, 0, 1)

    def c_line(self, x0, y0, x1, y1, w):
        dx, dy = x1 - x0, y1 - y0
        L2 = dx * dx + dy * dy + 1e-9
        t = np.clip(((self.X - x0) * dx + (self.Y - y0) * dy) / L2, 0, 1)
        d = np.hypot(self.X - (x0 + t * dx), self.Y - (y0 + t * dy)) - w / 2
        return np.clip(0.5 - d, 0, 1)

    def c_poly(self, pts):
        pts = [np.array(p, dtype=float) for p in pts]
        area = sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))
        sg = 1.0 if area > 0 else -1.0
        d = np.full((self.h, self.w), -1e9)
        for i in range(len(pts)):
            a, b = pts[i], pts[(i + 1) % len(pts)]
            e = b - a
            n = np.array([e[1], -e[0]]) * sg / (np.linalg.norm(e) + 1e-9)
            d = np.maximum(d, (self.X - a[0]) * n[0] + (self.Y - a[1]) * n[1])
        return np.clip(0.5 - d, 0, 1)

    # --- world-unit shortcuts
    def rect(self, a0, a1, b0, b1, r=0.0):
        xa, xb = sorted((self.px(a0), self.px(a1)))
        ya, yb = sorted((self.py(b0), self.py(b1)))
        return self.c_rrect(xa, ya, xb, yb, r * self.k)

    def disc(self, a, b, r):
        return self.c_disc(self.px(a), self.py(b), r * self.k)

    def ring(self, a, b, r0, r1):
        return self.c_ring(self.px(a), self.py(b), r0 * self.k, r1 * self.k)

    def ell(self, a, b, ra, rb):
        return self.c_ellipse(self.px(a), self.py(b), ra * self.k, rb * self.k)

    def line(self, a0, b0, a1, b1, w):
        return self.c_line(self.px(a0), self.py(b0), self.px(a1), self.py(b1), w * self.k)

    def poly(self, pts):
        return self.c_poly([(self.px(a), self.py(b)) for a, b in pts])

    def vgrad(self, b0, b1, v0, v1):
        """Vertical ramp between two world b values (clamped)."""
        y0, y1 = self.py(b0), self.py(b1)
        t = np.clip((self.Y - y0) / (y1 - y0 + 1e-9), 0, 1)
        return v0 + (v1 - v0) * t

    def hgrad(self, a0, a1, v0, v1):
        x0, x1 = self.px(a0), self.px(a1)
        t = np.clip((self.X - x0) / (x1 - x0 + 1e-9), 0, 1)
        return v0 + (v1 - v0) * t

    def mul(self, f):
        self.alb = np.clip(self.alb * (f[..., None] if np.ndim(f) == 2 else f), 0, 1)


def reg(name, mode, bounds, ppm):
    a0, a1, b0, b1 = bounds
    TILES[name] = Tile(name, int(math.ceil((a1 - a0) * ppm)), int(math.ceil((b1 - b0) * ppm)), mode, bounds)


def reg_px(name, w, h):
    TILES[name] = Tile(name, w, h)


# swatch surfaces: name -> (sRGB colour, roughness, metalness, paint mask)
SURF = {
    "paint": ("#ececec", 0.30, 0.35, 1),
    "paint2": ("#ececec", 0.30, 0.35, 2),
    "glass": ("#1a232b", 0.06, 0.90, 0),
    "pillar": ("#0c0d0f", 0.28, 0.45, 0),
    "tyre": ("#18181a", 0.92, 0.0, 0),
    "under": ("#0a0a0b", 0.95, 0.0, 0),
    "plastic": ("#17181a", 0.60, 0.0, 0),
    "plastic_l": ("#2a2c30", 0.55, 0.0, 0),
    "chrome": ("#c9cdd2", 0.14, 1.0, 0),
    "housing": ("#2a2c30", 0.55, 0.1, 0),
    "lamp_t": ("#6e0e0e", 0.10, 0.4, 0),
    "lamp_r": ("#c4202a", 0.10, 0.4, 0),
    "lamp_b": ("#1d46b8", 0.10, 0.4, 0),
    "sign": ("#e6e1c8", 0.20, 0.3, 0),
    "army": ("#6b6248", 0.85, 0.0, 0),
    "army_d": ("#4f4936", 0.85, 0.0, 0),
    "army_k": ("#2b2a22", 0.80, 0.0, 0),
    "galv": ("#7d8288", 0.65, 0.6, 0),
    "white": ("#d8dadc", 0.60, 0.0, 0),
    "seam": ("#07080a", 0.9, 0.0, 0),
}
for _n, (_c, _r, _m, _k) in SURF.items():
    SWATCHES[_n] = (_c, _r, _m, _k)
    reg_px("sw_" + _n, 6, 6)
SURF_NAMES = list(SURF)


def pack_atlas():
    """Shelf-pack all tiles; returns utilisation."""
    tiles = sorted(TILES.values(), key=lambda t: (-t.h, -t.w))
    x = y = rowh = 0
    for t in tiles:
        w, h = t.w + 2 * PAD, t.h + 2 * PAD
        if x + w > ATLAS:
            x, y, rowh = 0, y + rowh, 0
        if y + h > ATLAS:
            raise RuntimeError(f"atlas full at {t.name}")
        t.arect = (x + PAD, y + PAD, t.w, t.h)
        x += w
        rowh = max(rowh, h)
    used = sum((t.w + 2 * PAD) * (t.h + 2 * PAD) for t in tiles)
    return used / (ATLAS * ATLAS), y + rowh


def compose_atlas():
    A = np.zeros((ATLAS, ATLAS, 3))
    O = np.zeros((ATLAS, ATLAS, 3))
    N = np.zeros((ATLAS, ATLAS, 3))
    N[..., 2] = 1.0
    N = N * 0.5 + 0.5
    for t in TILES.values():
        x0, y0, w, h = t.arect
        sl = (slice(y0 - PAD, y0 + h + PAD), slice(x0 - PAD, x0 + w + PAD))
        pad = lambda a: np.pad(a, ((PAD, PAD), (PAD, PAD)) + ((0, 0),) * (a.ndim - 2), mode="edge")
        hg = pad(t.hgt)
        gy, gx = np.gradient(hg)
        k = 0.30
        nv = np.stack([-gx * k, -gy * k, np.ones_like(gx)], axis=-1)
        nv /= np.linalg.norm(nv, axis=-1, keepdims=True)
        N[sl] = nv * 0.5 + 0.5
        A[sl] = pad(t.alb)
        O[sl] = np.stack([pad(t.msk), pad(t.rgh), pad(t.met)], axis=-1)
    return np.clip(A, 0, 1), np.clip(N, 0, 1), np.clip(O, 0, 1)


def png_bytes(arr):
    """8-bit RGB PNG (Up filter) without external libraries."""
    a = np.clip(np.round(arr * 255), 0, 255).astype(np.uint8)
    h, w, _ = a.shape
    up = a.copy().astype(np.int16)
    up[1:] = (a[1:].astype(np.int16) - a[:-1].astype(np.int16))
    up = (up % 256).astype(np.uint8)
    raw = b"".join(b"\x02" + up[y].tobytes() for y in range(h))

    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def tile_uv(spec, p):
    """spec: (tile, mode|None, bounds|None). Returns atlas (u, v) for position p."""
    t = TILES[spec[0]]
    mode = spec[1] or t.mode
    bounds = spec[2] or t.bounds
    fu, fv = uvmaps(mode, bounds)
    a, b = axes(mode, p)
    u = min(max(fu(a), 0.004), 0.996)
    v = min(max(fv(b), 0.004), 0.996)
    x0, y0, w, h = t.arect
    return (x0 + u * w) / ATLAS, (y0 + v * h) / ATLAS


def swatch_uv(name):
    x0, y0, w, h = TILES["sw_" + name].arect
    return (x0 + w / 2) / ATLAS, (y0 + h / 2) / ATLAS


# ----------------------------------------------------------------------------------------------
# geometry container
# ----------------------------------------------------------------------------------------------
class Mesh:
    def __init__(self):
        self.P = []
        self.F = []  # (indices, surf, uvspec)

    def v(self, x, y, z):
        self.P.append((float(x), float(y), float(z)))
        return len(self.P) - 1

    def normal(self, idx):
        n = np.zeros(3)
        pts = [np.array(self.P[i]) for i in idx]
        for i in range(len(pts)):
            a, b = pts[i], pts[(i + 1) % len(pts)]
            n[0] += (a[1] - b[1]) * (a[2] + b[2])
            n[1] += (a[2] - b[2]) * (a[0] + b[0])
            n[2] += (a[0] - b[0]) * (a[1] + b[1])
        return n

    def face(self, idx, surf, hint=None, uv=None):
        """uv: None (swatch) | ('proj', tile, mode, bounds) | ('corner', tile, [(u,v)..]) | dict of
        side/front/rear/top -> tile (picked from the face normal)."""
        idx = list(idx)
        flip = hint is not None and np.dot(self.normal(idx), hint) < 0
        if flip:
            idx.reverse()
            if isinstance(uv, tuple) and uv[0] == "corner":
                uv = ("corner", uv[1], list(reversed(uv[2])))
        n = self.normal(idx)
        ln = np.linalg.norm(n)
        if ln < 1e-9:
            return
        if isinstance(uv, dict):
            n = n / ln
            ax, ay, az = abs(n[0]), abs(n[1]), abs(n[2])
            if ay > ax and ay > az:
                uv = ("proj", uv["top"], None, None) if n[1] > 0 else None
            elif ax >= az:
                uv = ("proj", uv.get("sideR" if n[0] > 0 else "sideL", uv["side"]), None, None)
            else:
                uv = ("proj", uv["front" if n[2] < 0 else "rear"], None, None)
        self.F.append((idx, surf, uv))

    def poly(self, pts, surf, hint, uv=None):
        self.face([self.v(*p) for p in pts], surf, hint, uv)

    def box(self, x0, x1, y0, y1, z0, z1, surf, skip=(), uv=None):
        p = {}
        for sx, x in ((0, x0), (1, x1)):
            for sy, y in ((0, y0), (1, y1)):
                for sz, z in ((0, z0), (1, z1)):
                    p[(sx, sy, sz)] = (x, y, z)
        c = np.array([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2])
        quads = {
            "-x": [(0, 0, 0), (0, 0, 1), (0, 1, 1), (0, 1, 0)], "+x": [(1, 0, 0), (1, 1, 0), (1, 1, 1), (1, 0, 1)],
            "-y": [(0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1)], "+y": [(0, 1, 0), (0, 1, 1), (1, 1, 1), (1, 1, 0)],
            "-z": [(0, 0, 0), (0, 1, 0), (1, 1, 0), (1, 0, 0)], "+z": [(0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)],
        }
        for name, q in quads.items():
            if name in skip:
                continue
            pts = [p[k] for k in q]
            mid = np.mean(np.array(pts), axis=0)
            self.poly(pts, surf, mid - c, uv)

    def convex(self, pts, faces, surf):
        ids = [self.v(*p) for p in pts]
        c = np.mean(np.array(pts), axis=0)
        for f in faces:
            mid = np.mean(np.array([pts[i] for i in f]), axis=0)
            self.face([ids[i] for i in f], surf, mid - c)

    def cyl_y(self, x, z, y0, y1, r, surf, seg=8, cap=True):
        a = [self.v(x + r * math.cos(2 * math.pi * i / seg), y0, z + r * math.sin(2 * math.pi * i / seg)) for i in range(seg)]
        b = [self.v(x + r * math.cos(2 * math.pi * i / seg), y1, z + r * math.sin(2 * math.pi * i / seg)) for i in range(seg)]
        for i in range(seg):
            j = (i + 1) % seg
            ang = 2 * math.pi * (i + 0.5) / seg
            self.face((a[i], a[j], b[j], b[i]), surf, (math.cos(ang), 0, math.sin(ang)))
        if cap:
            self.face(b, surf, (0, 1, 0))


# ----------------------------------------------------------------------------------------------
# parts
# ----------------------------------------------------------------------------------------------
def wheel(m, xo, zc, R, width, side, seg=10, style="alloy"):
    """Wheel on axis X; xo = x of the outer sidewall plane (positive), side = +1 / -1."""
    yc = R
    X = lambda d: side * (xo - d)
    prof = [(0.64 * R, 0.034), (0.86 * R, 0.0), (R * 0.99, 0.050), (R, width - 0.03)]
    rings = []
    for (r, d) in prof:
        rings.append([m.v(X(d), yc + r * math.cos(2 * math.pi * i / seg), zc + r * math.sin(2 * math.pi * i / seg)) for i in range(seg)])
    wspec = ("proj", "wheel_" + style, "side", (zc - R, zc + R, 0.0, 2 * R))
    for k in range(3):
        (r0, d0), (r1, d1) = prof[k], prof[k + 1]
        dr, dd = r1 - r0, d1 - d0
        for i in range(seg):
            j = (i + 1) % seg
            ang = 2 * math.pi * (i + 0.5) / seg
            quad = (rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i])
            if k < 2:
                hint = np.array([side * dr, dd * math.cos(ang), dd * math.sin(ang)])
                if np.linalg.norm(hint) < 1e-9:
                    continue
                m.face(quad, "tyre", hint, wspec)
            else:
                m.face(quad, "tyre", (0, math.cos(ang), math.sin(ang)), ("corner", "tread", [(0, 0), (1, 0), (1, 1), (0, 1)]))
    hub = m.v(X(0.075), yc, zc)
    for i in range(seg):
        j = (i + 1) % seg
        tri = (hub, rings[0][j], rings[0][i]) if side > 0 else (hub, rings[0][i], rings[0][j])
        m.face(tri, "tyre", (side, 0, 0), wspec)


def mirror(m, x, y, z, side, size=1.0, surf="paint", arm=0.0):
    """Wing mirror on a short stalk (convex wedge housing)."""
    w = 0.13 * size
    x2 = x + side * arm
    pts = [
        (x2, y - 0.015, z + 0.04), (x2, y + 0.04, z + 0.028), (x2, y + 0.04, z - 0.03), (x2, y - 0.015, z - 0.04),
        (x2 + side * w, y - 0.035, z + 0.07), (x2 + side * w, y + 0.075 * size, z + 0.055),
        (x2 + side * w, y + 0.075 * size, z - 0.04), (x2 + side * w, y - 0.035, z - 0.05),
    ]
    m.convex(pts, [[0, 1, 5, 4], [1, 2, 6, 5], [3, 0, 4, 7], [4, 5, 6, 7]], surf)
    if arm:
        m.box(min(x, x2), max(x, x2), y - 0.01, y + 0.01, z - 0.02, z + 0.02, "plastic", skip=("-x", "+x"))


# ----------------------------------------------------------------------------------------------
# the body loft
# ----------------------------------------------------------------------------------------------
def build_body(m, S, T):
    hl = S["hl"]
    anch = S["anch"]
    ya, xa = [a[0] for a in anch], [a[1] for a in anch]
    xl = lambda y: float(np.interp(y, ya, xa))
    cab = S["cab"]
    dz_, dy_ = S["deck"][0], None
    deck_z = [d[0] for d in S["deck"]]
    deck_y = [d[1] for d in S["deck"]]
    zcow, zrf, zrb, zd = S["zcow"], S["zrf"], S["zrb"], S["zd"]
    roof_y, crown = S["roof_y"], S["crown"]
    zm, zh = (zrf + zrb) / 2, (zrb - zrf) / 2
    nose, tail = S["nose"], S.get("tail") or []
    wheels = S["wheels"]
    sill0 = S["sill"]

    def sill_at(z):
        y = sill0
        for (zc, R, ar, xo) in wheels:
            d = abs(z - zc)
            if d <= ar + 1e-6:
                y = max(y, R + math.sqrt(max(ar * ar - d * d, 0.0)))
        return y

    zs = []
    for (zc, R, ar, xo) in wheels:
        zs += [zc + ar * f for f in (-1, -0.7, 0, 0.7, 1)]
    zs += [lerp(zcow, zrf, t) for t in S.get("ws_t", (0, 0.33, 0.66, 1))]
    zs += list(S["roof_z"])
    if tail or S.get("rg", True):
        zs += [lerp(zrb, zd, t) for t in S.get("rg_t", (0, 0.2, 0.45, 0.75, 1))]
    zs += list(S.get("extra", []))
    zlo = nose[-1][0] + 0.12
    zhi = (tail[0][0] - 0.12) if tail else zrb + 1e-6
    zs = sorted(z for z in zs if zlo <= z <= zhi + 1e-6)
    keep = []
    for z in zs:
        if not keep or z - keep[-1] >= 0.06:
            keep.append(z)
    ex = lambda t, tag: dict(z=t[0], s=t[1], ys=t[2], yd=t[3], ysh=t[4], c=(t[5] if len(t) > 5 else 0.0), yr=(t[6] if len(t) > 6 else 0.0), tag=tag)
    sts = [ex(t, "nose") for t in nose]
    for z in keep:
        c = 0.0
        if zcow <= z < zrf:
            c = ((z - zcow) / (zrf - zcow)) ** S.get("wsp", 1.0)
        elif zrf <= z <= zrb:
            c = 1.0
        elif zrb < z <= zd:
            c = ((zd - z) / (zd - zrb)) ** S.get("rgp", 1.0)
        yd = float(np.interp(z, deck_z, deck_y))
        zz = min(max(z, zrf), zrb)
        yr = roof_y - crown * ((zz - zm) / max(zh, 1e-6)) ** 2
        ysh = yd - S["dsh"]
        sts.append(dict(z=z, s=1.0, ys=sill_at(z), yd=yd, ysh=ysh, c=c, yr=yr, tag="mid"))
    for t in tail:
        sts.append(ex(t, "tail"))

    fdeck = (0.94, 0.86, 0.76)
    rings = []
    for st in sts:
        s, c = st["s"], st["c"]
        ys, ysh, yd = st["ys"], st["ysh"], st["yd"]
        y1 = ys + (ysh - ys) * 0.42
        side_pts = [(xl(y) * s, y) for y in (ys, y1, ysh)]
        xe = side_pts[2][0]
        deck = [(xe * f, yd - (yd - ysh) * f * f) for f in fdeck] + [(0.0, yd)]
        if c > 0:
            yb = ysh + cab["dyb"]
            cb = [(cab["xb"] * s, yb), (cab["xg"] * s, st["yr"] - cab["gd"]), (cab["xr"] * s, st["yr"] - cab["rd"]), (0.0, st["yr"])]
            top = [(lerp(d[0], q[0], c), lerp(d[1], q[1], c)) for d, q in zip(deck, cb)]
        else:
            top = deck
        st["half"] = side_pts + top
        # make sure the point heights stay monotonic
        h = st["half"]
        for i in range(1, len(h)):
            if h[i][1] < h[i - 1][1] + 0.004 and i <= 4:
                h[i] = (h[i][0], h[i - 1][1] + 0.004)
    ids = []
    for st in sts:
        h = st["half"]
        left = [m.v(-x, y, st["z"]) for x, y in h[:-1]]
        ctr = [m.v(0.0, h[-1][1], st["z"])]
        right = [m.v(x, y, st["z"]) for x, y in reversed(h[:-1])]
        ids.append(left + ctr + right)
    n = 6
    gs = S.get("glass", True)
    ws_first = True
    quads = []
    glass_groups = defaultdict(list)
    gcount = {"L": 0, "R": 0}
    prev_glass = {}
    for k in range(len(sts) - 1):
        a, b = sts[k], sts[k + 1]
        zmid = (a["z"] + b["z"]) / 2
        cm = (a["c"] + b["c"]) / 2
        zone = "hood"
        if a["tag"] == "mid" or b["tag"] == "mid":
            if zcow - 1e-6 <= zmid < zrf and (a["c"] > 0 or b["c"] > 0):
                zone = "ws"
            elif zrf - 1e-6 <= zmid < zrb:
                zone = "roof"
            elif zrb - 1e-6 <= zmid < zd and (a["c"] > 0 or b["c"] > 0):
                zone = "rg"
        ridx = None
        if zone == "roof":
            for (rz0, rz1, tg) in S["roof_tags"]:
                if rz0 - 1e-6 <= zmid <= rz1 + 1e-6:
                    ridx = tg
            ridx = ridx or "p"
        first_ws = zone == "ws" and zmid < lerp(zcow, zrf, 0.3)
        first_rg = zone == "rg" and zmid < lerp(zrb, zd, 0.4)
        for i in range(2 * n):
            h = i if i < n else 2 * n - 1 - i
            sdn = "L" if i < n else "R"
            surf = "paint"
            if zone == "ws":
                if h == 3:
                    surf = "pillar" if (first_ws or not S.get("ws_side_glass", True)) else "glass"
                elif h == 4:
                    surf = "pillar"
                elif h == 5:
                    surf = "glass"
            elif zone == "roof":
                if h == 3:
                    surf = "glass" if ridx == "g" else ("pillar" if ridx == "b" else "paint")
                elif h == 4 and ridx == "b":
                    surf = "pillar"
            elif zone == "rg":
                if h == 3 and first_rg and S.get("quarter", True):
                    surf = "glass"
                elif h == 4:
                    surf = "pillar" if S.get("c_pillar_dark", False) else "paint"
                elif h == 5:
                    surf = "glass"
            if surf == "glass" and not gs:
                surf = "paint"
            r0, r1 = ids[k], ids[k + 1]
            quad = (r0[i], r1[i], r1[i + 1], r0[i + 1]) if False else (r0[i], r1[i], r1[i + 1], r0[i + 1])
            quads.append(dict(q=quad, surf=surf, zone=zone, h=h, side=sdn, k=k))
    # glass UV groups: contiguous glass runs per (zone,h,side)
    P = m.P
    runs = []
    cur = {}
    for qd in quads:
        key = (qd["zone"], qd["h"], qd["side"])
        if qd["surf"] == "glass":
            if key in cur and cur[key]["last"] == qd["k"] - 1 or (key in cur and cur[key]["last"] == qd["k"]):
                cur[key]["items"].append(qd)
                cur[key]["last"] = qd["k"]
            else:
                cur[key] = dict(items=[qd], last=qd["k"])
                runs.append(cur[key])
    for run in runs:
        pts = np.array([P[i] for qd in run["items"] for i in qd["q"]])
        run["b"] = (pts[:, 0].min(), pts[:, 0].max(), pts[:, 2].min(), pts[:, 2].max(), pts[:, 1].min(), pts[:, 1].max())
        for qd in run["items"]:
            qd["run"] = run
    for qd in quads:
        if qd["surf"] == "glass":
            b = qd["run"]["b"]
            if qd["h"] == 3:
                uv = ("proj", "glass_side", "side", (b[2], b[3], b[4], b[5]))
            elif qd["zone"] == "ws":
                uv = ("proj", "glass_ws", "top", (b[0], b[1], b[2], b[3]))
            else:
                uv = ("proj", "glass_rg", "top", (b[0], b[1], b[2], b[3]))
            m.face(qd["q"], "glass", None, uv)
        else:
            m.face(qd["q"], qd["surf"], None, T if qd["surf"] == "paint" else None)
    # caps
    m.face(ids[0], "paint", (0, 0, -1), T)
    m.face(ids[-1], "paint", (0, 0, 1), T)
    # wheel-arch liners
    for (zc, R, ar, xo) in wheels:
        xin = xo - S.get("wheel_w", 0.225) - 0.03
        for k in range(len(sts) - 1):
            za, zb = sts[k]["z"], sts[k + 1]["z"]
            if za >= zc - ar - 1e-6 and zb <= zc + ar + 1e-6:
                for sd in (0, 1):
                    ia = ids[k][0] if sd == 0 else ids[k][-1]
                    ib = ids[k + 1][0] if sd == 0 else ids[k + 1][-1]
                    pa, pb = np.array(m.P[ia]), np.array(m.P[ib])
                    sg = -1 if sd == 0 else 1
                    ina = m.v(sg * xin, pa[1], pa[2])
                    inb = m.v(sg * xin, pb[1], pb[2])
                    mid = (pa + pb) / 2
                    m.face((ia, ib, inb, ina), "under", np.array([0, R, zc]) - np.array([mid[0] * 0 + sg * xin, mid[1], mid[2]]) * 1.0)
    # floor
    y = S["sill"] - 0.02
    zf0, zf1 = nose[0][0] + 0.2, (tail[-1][0] if tail else zrb) - 0.2
    m.poly([(-0.78, y, zf0), (0.78, y, zf0), (0.78, y, zf1), (-0.78, y, zf1)], "under", (0, -1, 0))
    return sts, ids


# ----------------------------------------------------------------------------------------------
# vehicle specs. Station tuples: (z, width scale, sill y, deck y, shoulder y[, cabin factor, roof y])
# ----------------------------------------------------------------------------------------------
# lamp polygons (+x side, axis coordinates x,y) shared by the atlas painter and the glow quads
LAMP = {
    "sedan": dict(head=[(0.42, 0.575), (0.85, 0.600), (0.85, 0.700), (0.44, 0.655)], hg=[(0.47, 0.60), (0.75, 0.615), (0.75, 0.675), (0.48, 0.655)],
                  tail=[(0.46, 0.655), (0.86, 0.700), (0.86, 0.800), (0.48, 0.780)], tg=[(0.52, 0.690), (0.77, 0.715), (0.77, 0.770), (0.53, 0.760)]),
    "suv": dict(head=[(0.44, 0.72), (0.88, 0.76), (0.88, 0.86), (0.46, 0.82)], hg=[(0.50, 0.75), (0.80, 0.77), (0.80, 0.83), (0.50, 0.81)],
                tail=[(0.60, 0.80), (0.90, 0.84), (0.90, 1.02), (0.62, 1.00)], tg=[(0.66, 0.85), (0.86, 0.87), (0.86, 1.0), (0.68, 0.98)]),
    "van": dict(head=[(0.42, 0.74), (0.88, 0.78), (0.88, 0.90), (0.44, 0.86)], hg=[(0.48, 0.77), (0.82, 0.80), (0.82, 0.87), (0.48, 0.84)],
                tail=[(0.70, 0.80), (0.93, 0.80), (0.93, 1.45), (0.70, 1.45)], tg=[(0.76, 0.92), (0.88, 0.92), (0.88, 1.32), (0.76, 1.32)]),
    "truck": dict(head=[(0.60, 0.74), (1.02, 0.74), (1.02, 0.94), (0.60, 0.94)], hg=[(0.66, 0.78), (0.96, 0.78), (0.96, 0.90), (0.66, 0.90)],
                  tail=[(0.74, 1.30), (1.12, 1.30), (1.12, 1.55), (0.74, 1.55)], tg=[(0.80, 1.35), (1.06, 1.35), (1.06, 1.50), (0.80, 1.50)]),
    "bus": dict(head=[(0.70, 0.70), (1.14, 0.70), (1.14, 0.96), (0.70, 0.96)], hg=[(0.76, 0.76), (1.08, 0.76), (1.08, 0.90), (0.76, 0.90)],
                tail=[(0.55, 0.90), (1.10, 0.90), (1.10, 1.20), (0.55, 1.20)], tg=[(0.62, 0.96), (1.04, 0.96), (1.04, 1.14), (0.62, 1.14)]),
    "humvee": dict(head=[(0.70, 0.86), (0.98, 0.86), (0.98, 1.04), (0.70, 1.04)], hg=[(0.74, 0.90), (0.94, 0.90), (0.94, 1.00), (0.74, 1.00)],
                   tail=[(0.78, 0.80), (1.04, 0.80), (1.04, 0.98), (0.78, 0.98)], tg=[(0.82, 0.84), (1.00, 0.84), (1.00, 0.94), (0.82, 0.94)]),
}


def glow_quads(kind, zf, zr):
    L = LAMP[kind]
    out = {"head": [], "tail": []}
    for key, z, k in (("head", zf - 0.006, "hg"), ("tail", zr + 0.006, "tg")):
        for sd in (1, -1):
            out[key].append([[sd * x, y, z] for x, y in L[k]])
    return out


SEDAN = dict(
    hl=2.3, sill=0.29, dsh=0.055,
    anch=[(0.26, 0.82), (0.58, 0.905), (0.91, 0.935)],
    cab=dict(xb=0.79, dyb=0.06, xg=0.69, gd=0.10, xr=0.575, rd=0.038),
    wheels=[(-1.44, 0.34, 0.40, 0.855), (1.40, 0.34, 0.40, 0.855)],
    deck=[(-2.14, 0.80), (-1.44, 0.88), (-0.84, 0.93), (1.56, 0.985), (2.14, 0.975)],
    zcow=-0.84, zrf=-0.10, zrb=0.96, zd=1.56, roof_y=1.47, crown=0.032, wsp=1.1, ws_t=(0, 0.35, 0.70, 1), rg_t=(0, 0.35, 0.70, 1),
    roof_z=[-0.10, 0.22, 0.34, 0.96], roof_tags=[(-0.10, 0.22, "g"), (0.22, 0.34, "b"), (0.34, 0.96, "g")],
    nose=[(-2.30, 0.84, 0.27, 0.72, 0.63), (-2.22, 0.93, 0.26, 0.77, 0.69), (-2.04, 0.985, 0.25, 0.82, 0.74)],
    tail=[(2.14, 0.985, 0.27, 0.97, 0.90), (2.30, 0.87, 0.28, 0.90, 0.75)],
)

SUV = dict(
    hl=2.45, sill=0.34, dsh=0.06, wheel_w=0.245,
    anch=[(0.30, 0.86), (0.66, 0.935), (1.08, 0.96)],
    cab=dict(xb=0.85, dyb=0.08, xg=0.78, gd=0.16, xr=0.66, rd=0.05),
    wheels=[(-1.60, 0.36, 0.43, 0.915), (1.55, 0.36, 0.43, 0.915)],
    deck=[(-2.25, 0.96), (-1.6, 1.0), (-0.95, 1.07), (2.15, 1.12)],
    zcow=-0.95, zrf=-0.12, zrb=1.92, zd=2.18, roof_y=1.80, crown=0.03, wsp=1.1, quarter=False,
    roof_z=[-0.12, 0.42, 0.54, 1.30, 1.42, 1.92],
    roof_tags=[(-0.12, 0.42, "g"), (0.42, 0.54, "b"), (0.54, 1.30, "g"), (1.30, 1.42, "b"), (1.42, 1.92, "g")],
    rg_t=(0, 0.5, 1), ws_t=(0, 0.5, 1),
    nose=[(-2.45, 0.88, 0.30, 0.82, 0.72), (-2.34, 0.95, 0.29, 0.92, 0.82), (-2.18, 0.99, 0.28, 0.97, 0.88)],
    tail=[(2.22, 0.99, 0.30, 1.10, 0.98), (2.45, 0.90, 0.30, 1.00, 0.80)],
)

HUMVEE = dict(
    hl=2.4, sill=0.52, dsh=0.05, wheel_w=0.30,
    anch=[(0.52, 1.0), (0.78, 1.075), (1.15, 1.07)],
    cab=dict(xb=0.97, dyb=0.05, xg=0.95, gd=0.16, xr=0.90, rd=0.06),
    wheels=[(-1.65, 0.47, 0.55, 1.13), (1.65, 0.47, 0.55, 1.13)],
    deck=[(-2.2, 1.0), (-1.5, 1.12), (-0.85, 1.15), (2.3, 1.17)],
    zcow=-0.85, zrf=-0.45, zrb=2.25, zd=2.34, roof_y=1.90, crown=0.01, wsp=1.0, quarter=False,
    roof_z=[-0.45, 0.05, 0.17, 1.30, 1.42, 2.25],
    roof_tags=[(-0.45, 0.05, "g"), (0.05, 0.17, "b"), (0.17, 1.30, "g"), (1.30, 1.42, "b"), (1.42, 2.25, "g")],
    rg_t=(0, 1), ws_t=(0, 0.5, 1),
    nose=[(-2.40, 0.95, 0.52, 0.98, 0.90), (-2.34, 0.98, 0.52, 1.02, 0.95), (-2.2, 1.0, 0.52, 1.06, 1.0)],
    tail=[(2.34, 0.98, 0.52, 1.17, 1.11), (2.40, 0.95, 0.52, 1.10, 1.05)],
)

VAN = dict(
    hl=2.8, sill=0.42, dsh=0.07, wheel_w=0.235, glass=True,
    anch=[(0.42, 0.915), (0.80, 0.985), (1.20, 0.995)],
    cab=dict(xb=0.975, dyb=0.06, xg=0.96, gd=0.14, xr=0.90, rd=0.05),
    wheels=[(-1.85, 0.40, 0.46, 0.925), (1.65, 0.40, 0.46, 0.925)],
    deck=[(-2.6, 1.02), (-2.05, 1.14), (-1.3, 1.2), (2.7, 1.2)],
    zcow=-2.05, zrf=-1.05, zrb=2.72, zd=2.72, roof_y=2.30, crown=0.02, wsp=1.2, rg=False, ws_side_glass=True,
    roof_z=[-1.05, -0.2, 0.9, 2.72], roof_tags=[(-1.05, -0.2, "g")],
    nose=[(-2.80, 0.93, 0.46, 1.00, 0.92), (-2.74, 0.965, 0.44, 1.04, 0.96), (-2.58, 0.99, 0.42, 1.10, 1.02)],
    tail=[(2.74, 0.99, 0.42, 1.2, 1.13, 1.0, 2.29), (2.80, 0.96, 0.44, 1.2, 1.13, 1.0, 2.25)],
)

TRUCKCAB = dict(
    hl=4.1, sill=0.55, dsh=0.07, wheel_w=0.30,
    anch=[(0.55, 1.075), (0.95, 1.12), (1.30, 1.115)],
    cab=dict(xb=1.10, dyb=0.06, xg=1.09, gd=0.12, xr=1.03, rd=0.04),
    wheels=[(-3.15, 0.50, 0.58, 1.15)],
    deck=[(-4.0, 1.30), (-2.0, 1.34)],
    zcow=-4.00, zrf=-3.40, zrb=-2.05, zd=-2.05, roof_y=2.50, crown=0.02, wsp=1.0, rg=False,
    roof_z=[-3.40, -2.55, -2.05], roof_tags=[(-3.40, -2.55, "g")], ws_t=(0, 0.35, 0.7, 1),
    nose=[(-4.10, 0.975, 0.55, 1.30, 1.22)],
    tail=[(-1.97, 0.99, 0.55, 1.30, 1.24, 1.0, 2.48)],
)

BUS = dict(
    hl=6.0, sill=0.44, dsh=0.15, wheel_w=0.30, quarter=False, ws_side_glass=False,
    anch=[(0.44, 1.17), (0.66, 1.272), (2.7, 1.272)],
    cab=dict(xb=1.272, dyb=0.07, xg=1.262, gd=0.55, xr=1.12, rd=0.07),
    wheels=[(-3.70, 0.52, 0.60, 1.31), (3.20, 0.52, 0.60, 1.31)],
    deck=[(-5.9, 1.30), (5.9, 1.30)],
    zcow=-5.95, zrf=-5.55, zrb=5.92, zd=5.92, roof_y=3.06, crown=0.04, wsp=1.0, rg=False,
    roof_z=[-5.55, -2.2, 0.6, 5.92], roof_tags=[], ws_t=(0, 0.5, 1),
    nose=[(-6.0, 0.93, 0.46, 1.24, 1.10), (-5.93, 0.975, 0.45, 1.30, 1.15)],
    tail=[(5.95, 0.975, 0.45, 1.30, 1.15, 1.0, 3.02), (6.0, 0.93, 0.46, 1.30, 1.15, 1.0, 2.96)],
)


def build_car(m, kind):
    S = SEDAN
    T = dict(side="side_" + kind, front="front_sedan", rear="rear_sedan", top="top_paint")
    sts, ids = build_body(m, S, T)
    hl = 2.3
    for (zc, R, ar, xo) in S["wheels"]:
        for sd in (-1, 1):
            wheel(m, xo, zc, R, 0.225, sd, seg=16)
    for sd in (-1, 1):
        mirror(m, sd * 0.80, 1.00, -0.62, sd, 1.0, "paint", arm=0.05)
        # Side rocker sill trim & subtle 3D wheel-arch brow lips so wheels sit in framed arches
        x0r, x1r = (0.86, 0.925) if sd > 0 else (-0.925, -0.86)
        m.box(x0r, x1r, 0.25, 0.33, -0.96, 0.92, "plastic", skip=("-y", "-x" if sd > 0 else "+x"))
        for (zc, R, ar, xo) in S["wheels"]:
            m.box(x0r, x1r, R + ar * 0.84, R + ar * 1.02, zc - 0.24, zc + 0.24, "plastic", skip=("-y", "-x" if sd > 0 else "+x"))
    # Protruding front & rear molded bumpers
    m.box(-0.88, 0.88, 0.26, 0.43, -2.35, -2.26, "plastic", skip=("-y", "+z"))
    m.box(-0.86, 0.86, 0.41, 0.49, -2.33, -2.25, "paint", skip=("-y", "+z"))
    m.box(-0.89, 0.89, 0.27, 0.45, 2.26, 2.35, "plastic", skip=("-y", "-z"))
    m.box(-0.87, 0.87, 0.43, 0.52, 2.24, 2.33, "paint", skip=("-y", "-z"))
    H = 1.47
    roof = []
    if kind == "taxi":
        # Low-profile beveled trapezoidal NYC taxi medallion roof sign
        m.box(-0.22, 0.22, H - 0.01, H + 0.025, 0.02, 0.26, "plastic", skip=("-y",))
        pts = [
            (-0.29, H + 0.025, -0.02), ( 0.29, H + 0.025, -0.02), ( 0.29, H + 0.025, 0.29), (-0.29, H + 0.025, 0.29),
            (-0.22, H + 0.145,  0.04), ( 0.22, H + 0.145,  0.04), ( 0.22, H + 0.145, 0.23), (-0.22, H + 0.145, 0.23),
        ]
        m.convex(pts, [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [4, 5, 6, 7]], "sign")
        roof = [[-0.25, H + 0.035, 0.00, 0.25, H + 0.135, 0.26]]
    elif kind == "police":
        # Sleek beveled split LED lightbar on thin roof stanchions + cross-braced push bumper
        for sx in (-0.36, 0.36):
            m.box(sx - 0.06, sx + 0.06, H - 0.01, H + 0.028, 0.04, 0.18, "plastic", skip=("-y",))
        m.box(-0.54, 0.54, H + 0.024, H + 0.045, 0.01, 0.21, "plastic", skip=("-y",))
        pts_l = [(-0.54, H + 0.042, 0.01), (-0.03, H + 0.042, 0.01), (-0.03, H + 0.042, 0.21), (-0.54, H + 0.042, 0.21),
                 (-0.50, H + 0.105, 0.04), (-0.05, H + 0.105, 0.04), (-0.05, H + 0.105, 0.18), (-0.50, H + 0.105, 0.18)]
        pts_r = [( 0.03, H + 0.042, 0.01), ( 0.54, H + 0.042, 0.01), ( 0.54, H + 0.042, 0.21), ( 0.03, H + 0.042, 0.21),
                 ( 0.05, H + 0.105, 0.04), ( 0.50, H + 0.105, 0.04), ( 0.50, H + 0.105, 0.18), ( 0.05, H + 0.105, 0.18)]
        bf = [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [4, 5, 6, 7]]
        m.convex(pts_l, bf, "lamp_r")
        m.convex(pts_r, bf, "lamp_b")
        m.box(-0.04, 0.04, H + 0.042, H + 0.105, 0.02, 0.20, "chrome", skip=("-y",))
        roof = [[-0.51, H + 0.042, 0.02, -0.05, H + 0.10, 0.19], [0.05, H + 0.042, 0.02, 0.51, H + 0.10, 0.19]]
        for sx in (-0.34, 0.34):
            m.box(sx - 0.022, sx + 0.022, 0.32, 0.68, -hl - 0.09, -hl - 0.04, "plastic", skip=("+z",))
        m.box(-0.37, 0.37, 0.61, 0.67, -hl - 0.09, -hl - 0.04, "plastic", skip=("+z",))
        m.box(-0.34, 0.34, 0.44, 0.49, -hl - 0.085, -hl - 0.04, "plastic", skip=("+z",))
    lights = glow_quads("sedan", -hl, hl)
    lights["roof"] = roof
    return lights


def build_suv(m):
    S = SUV
    T = dict(side="side_suv", front="front_suv", rear="rear_suv", top="top_paint")
    build_body(m, S, T)
    for (zc, R, ar, xo) in S["wheels"]:
        for sd in (-1, 1):
            wheel(m, xo, zc, R, 0.245, sd, seg=10)
    for sd in (-1, 1):
        mirror(m, sd * 0.86, 1.14, -0.98, sd, 1.1, "plastic", arm=0.06)
        # roof rail
        m.box(sd * 0.64 - 0.018, sd * 0.64 + 0.018, 1.76, 1.82, -0.05, 1.85, "plastic_l", skip=("-y", "-z", "+z"))
    lights = glow_quads("suv", -2.45, 2.45)
    lights["roof"] = []
    return lights


def build_humvee(m):
    S = HUMVEE
    T = dict(side="side_humvee", front="front_humvee", rear="rear_humvee", top="top_army")
    build_body(m, S, T)
    for (zc, R, ar, xo) in S["wheels"]:
        for sd in (-1, 1):
            wheel(m, xo, zc, R, 0.30, sd, seg=12, style="steel")
            # fender flare over the wheel
            m.box(min(sd * 1.0, sd * 1.16), max(sd * 1.0, sd * 1.16), 1.01, 1.07, zc - 0.62, zc + 0.62, "army", skip=("-y", "-x" if sd > 0 else "+x"), uv={"side": "side_humvee", "front": "front_humvee", "rear": "rear_humvee", "top": "top_army"})
    # steel front bumper and winch
    m.box(-1.08, 1.08, 0.50, 0.70, -2.40 - 0.12, -2.40, "army_d", skip=("+z", "-y"))
    for sd in (-1, 1):
        m.box(sd * 1.06 + (0.0 if sd > 0 else -0.16), sd * 1.06 + (0.16 if sd > 0 else 0.0), 1.30, 1.50, -0.86, -0.82, "army_k", skip=("-x" if sd > 0 else "+x", "-y"))
        m.box(sd * 0.98 - 0.015, sd * 0.98 + 0.015, 1.18, 1.42, -0.84, -0.80, "army_k", skip=("-y",))
    lights = glow_quads("humvee", -2.4, 2.4)
    lights["roof"] = []
    return lights


def build_van(m):
    S = VAN
    T = dict(side="side_van", front="front_van", rear="rear_van", top="top_paint")
    build_body(m, S, T)
    for (zc, R, ar, xo) in S["wheels"]:
        for sd in (-1, 1):
            wheel(m, xo, zc, R, 0.235, sd, seg=12, style="steel")
    for sd in (-1, 1):
        mirror(m, sd * 0.97, 1.40, -1.75, sd, 1.3, "plastic", arm=0.12)
    lights = glow_quads("van", -2.8, 2.8)
    lights["roof"] = []
    return lights


def build_box(m, hw, z0, z1, y0, y1, T, surf="paint"):
    """Cargo box: slightly rounded loft with a ribbed side / roof tile."""
    sc = lambda f: [(hw * 0.96 * f, y0), (hw * f, y0 + 0.10), (hw * f, y1 - 0.10), (hw * 0.975 * f, y1 - 0.01), (0.0, y1)]
    box = [(z0, sc(0.965)), (z0 + 0.06, sc(1.0)), (z1 - 0.06, sc(1.0)), (z1, sc(0.965))]
    ids = []
    for z, half in box:
        ids.append([m.v(-x, y, z) for x, y in half[:-1]] + [m.v(0.0, half[-1][1], z)] + [m.v(x, y, z) for x, y in reversed(half[:-1])])
    n = 4
    for k in range(len(ids) - 1):
        for i in range(2 * n):
            h = i if i < n else 2 * n - 1 - i
            r0, r1 = ids[k], ids[k + 1]
            m.face((r0[i], r1[i], r1[i + 1], r0[i + 1]), "paint" if h else "under", None, T if h else None)
    m.face(ids[0], "paint", (0, 0, -1), T)
    m.face(ids[-1], "paint", (0, 0, 1), T)


def build_truck(m):
    S = TRUCKCAB
    T = dict(side="side_truckcab", front="front_truck", rear="side_truckcab", top="top_paint")
    sts, ids = build_body(m, S, T)
    # cab surfaces use the second paint
    for fi, (idx, surf, uv) in enumerate(m.F):
        if surf == "paint":
            m.F[fi] = (idx, "paint2", uv)
    build_box(m, 1.225, -1.88, 4.10, 1.10, 3.40, dict(side="side_box", front="rear_box", rear="rear_box", top="top_box"))
    # chassis rails and underrun bar
    m.box(-0.90, 0.90, 0.50, 0.95, -1.9, 3.85, "under", skip=("-y",))
    m.box(-1.08, 1.08, 0.46, 0.62, 3.86, 4.06, "plastic", skip=("-y",))
    m.box(-1.12, 1.12, 0.46, 0.72, -4.2, -4.06, "plastic", skip=("+z", "-y"))
    for az, xo in ((2.45, 1.25), (-3.15, 1.15)):
        for sd in (-1, 1):
            if az > 0:
                wheel(m, xo, az, 0.50, 0.30, sd, seg=12, style="steel")
    for sd in (-1, 1):
        wheel(m, 1.15, -3.15, 0.50, 0.30, sd, seg=12, style="steel")
        # arm mirror
        m.box(sd * 1.13 + (0.0 if sd > 0 else -0.16), sd * 1.13 + (0.16 if sd > 0 else 0.0), 1.55, 1.95, -3.80, -3.74, "plastic", skip=("-x" if sd > 0 else "+x",))
        m.box(sd * 1.17 - 0.02, sd * 1.17 + 0.02, 1.62, 2.0, -3.94, -3.92, "plastic", skip=("-y",))
    # exhaust stack behind the cab
    m.cyl_y(1.02, -1.80, 0.9, 3.0, 0.05, "chrome", seg=6)
    lights = glow_quads("truck", -4.1, 4.1)
    lights["roof"] = []
    return lights


def build_bus(m):
    S = BUS
    T = dict(side="side_bus", front="front_bus", rear="rear_bus", top="top_box", sideR="side_bus", sideL="side_bus_l")
    build_body(m, S, T)
    for (zc, R, ar, xo) in S["wheels"]:
        for sd in (-1, 1):
            wheel(m, xo, zc, R, 0.30, sd, seg=16, style="steel")
    for sd in (-1, 1):
        mirror(m, sd * 1.27, 1.80, -5.70, sd, 1.4, "plastic", arm=0.16)
    # Recessed front destination sign visor & beveled rooftop HVAC pods
    m.box(-0.92, 0.92, 2.74, 2.94, -5.92, -5.84, "plastic", skip=("+z",))
    for z0, z1 in ((-2.5, -0.5), (1.4, 3.4)):
        pts = [
            (-0.84, 3.04, z0), (0.84, 3.04, z0), (0.84, 3.04, z1), (-0.84, 3.04, z1),
            (-0.70, 3.22, z0 + 0.18), (0.70, 3.22, z0 + 0.18), (0.70, 3.22, z1 - 0.18), (-0.70, 3.22, z1 - 0.18),
        ]
        m.convex(pts, [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [4, 5, 6, 7]], "white")
    lights = glow_quads("bus", -6.0, 6.0)
    lights["roof"] = []
    return lights


BUILDERS = {
    "sedan": lambda m: build_car(m, "sedan"),
    "taxi": lambda m: build_car(m, "taxi"),
    "police": lambda m: build_car(m, "police"),
    "suv": build_suv,
    "humvee": build_humvee,
    "van": build_van,
    "truck": build_truck,
    "bus": build_bus,
}
ORDER = ["sedan", "taxi", "police", "suv", "humvee", "van", "truck", "bus"]
BUDGET = {"sedan": 1450, "taxi": 1450, "police": 1450, "suv": 1100, "humvee": 1100, "van": 1300, "truck": 1300, "bus": 2050}


# ----------------------------------------------------------------------------------------------
# atlas tiles
# ----------------------------------------------------------------------------------------------
for _k in ("sedan", "taxi", "police"):
    reg("side_" + _k, "side", (-2.3, 2.3, 0.20, 1.50), 72)
reg("front_sedan", "front", (-0.95, 0.95, 0.20, 0.95), 120)
reg("rear_sedan", "rear", (-0.95, 0.95, 0.20, 0.95), 120)
reg("side_suv", "side", (-2.45, 2.45, 0.20, 1.85), 64)
reg("front_suv", "front", (-1.0, 1.0, 0.20, 1.10), 100)
reg("rear_suv", "rear", (-1.0, 1.0, 0.20, 1.25), 100)
reg("side_humvee", "side", (-2.4, 2.4, 0.40, 1.95), 60)
reg("front_humvee", "front", (-1.1, 1.1, 0.40, 1.20), 80)
reg("rear_humvee", "rear", (-1.1, 1.1, 0.40, 1.20), 80)
reg("side_van", "side", (-2.8, 2.8, 0.30, 2.35), 56)
reg("front_van", "front", (-1.0, 1.0, 0.30, 1.30), 90)
reg("rear_van", "rear", (-1.0, 1.0, 0.30, 2.35), 70)
reg("side_truckcab", "side", (-4.1, -1.9, 0.45, 2.55), 48)
reg("front_truck", "front", (-1.15, 1.15, 0.45, 2.55), 64)
reg("side_box", "side", (-1.9, 4.1, 0.90, 3.45), 40)
reg("rear_box", "rear", (-1.25, 1.25, 0.90, 3.45), 48)
reg("side_bus", "side", (-6.0, 6.0, 0.40, 3.15), 42)
reg("side_bus_l", "side", (-6.0, 6.0, 0.40, 3.15), 42)
reg("front_bus", "front", (-1.3, 1.3, 0.40, 3.2), 52)
reg("rear_bus", "rear", (-1.3, 1.3, 0.40, 3.2), 52)
reg("top_paint", "top", (-1.1, 1.1, -2.5, 2.5), 8)
reg("top_box", "top", (-1.3, 1.3, -6.0, 6.0), 3)
reg("top_army", "top", (-1.1, 1.1, -2.5, 2.5), 8)
reg_px("wheel_alloy", 128, 128)
reg_px("wheel_steel", 128, 128)
reg_px("tread", 32, 24)
reg_px("glass_side", 128, 48)
reg_px("glass_ws", 112, 64)
reg_px("glass_rg", 96, 48)

PAINT = {}
_rs = np.random.RandomState(7)
C_BLACK, C_PLASTIC = rgb("#17181a"), rgb("#1d1e21")


def base(t, col="#ececec", r=0.30, m=0.35, k=1.0):
    t.put(np.ones((t.h, t.w)), col=rgb(col), h=0.0, r=r, m=m, k=k)


def grime(t, b_bottom, b_rise, lo=0.74):
    f = t.vgrad(b_bottom, b_rise, lo, 1.0)
    t.alb = t.alb * f[..., None]
    t.rgh = np.clip(t.rgh + (1 - f) * 0.5, 0, 1)


def speckle(t, amt=0.012):
    n = _rs.normal(size=(t.h, t.w)) * amt
    t.alb = np.clip(t.alb * (1 + n[..., None]), 0, 1)


def groove(t, cov, depth=3.0, col="#0a0b0c", w=1.0):
    t.put(cov, col=rgb(col), h=-depth, r=0.7, a=w * 0.85)


def plate(t, x0, x1, y0, y1):
    t.put(t.rect(x0, x1, y0, y1, 0.012), col=rgb("#b9bcbf"), h=1.0, r=0.5, m=0.2, k=0)
    t.put(t.rect(x0 + 0.01, x1 - 0.01, y0 + 0.01, y1 - 0.01, 0.006), col=rgb("#e3e4e0"), h=-1.0, r=0.5, m=0.0, k=0)
    t.put(t.rect(x0 + 0.015, x1 - 0.015, y1 - 0.045, y1 - 0.02), col=rgb("#2d4f93"), r=0.5, m=0.0, k=0)
    w = x1 - x0 - 0.05
    for i in range(6):
        xa = x0 + 0.025 + i * w / 6.0
        t.put(t.rect(xa, xa + w / 6.0 * 0.62, y0 + 0.02, y1 - 0.06), col=rgb("#27292e"), h=1.2, r=0.6, m=0, k=0)


def lamp_poly(t, pts, sd, housing="#14161a", lens=("#7a828c", "#2c3238"), drl=True, red=False):
    P = [(sd * x, y) for x, y in pts]
    t.put(t.poly(P), col=rgb(housing), h=-2.0, r=0.4, m=0.3, k=0)
    cx = sum(p[0] for p in P) / 4
    cy = sum(p[1] for p in P) / 4
    inner = [(cx + (p[0] - cx) * 0.86, cy + (p[1] - cy) * 0.78) for p in P]
    ys = [p[1] for p in inner]
    top, bot = max(ys), min(ys)
    cov = t.poly(inner)
    g = t.vgrad(top, bot, 0.0, 1.0)
    a, b = rgb(lens[0]), rgb(lens[1])
    col = a[None, None, :] * (1 - g[..., None]) + b[None, None, :] * g[..., None]
    t.put(cov, col=col, h=1.5, r=0.06, m=0.35, k=0)
    return P, cx, cy


def paint_side_car(t, kind):
    base(t)
    t.put(t.rect(-9, 9, -1, 0.405), col=rgb("#202225"), r=0.62, m=0.0, k=0)
    t.put(t.rect(-9, 9, 0.395, 0.42), col=rgb("#08090a"), r=0.9, m=0.0, k=0, a=0.7)
    # character lines
    groove(t, t.line(-1.95, 0.715, 1.95, 0.755, 0.010), 2.0, "#7f8286", 0.45)
    t.put(t.line(-1.95, 0.735, 1.95, 0.775, 0.012), col=rgb("#ffffff"), h=2.5, a=0.18)
    # door cuts: front door, rear door, rear quarter
    for z, y1 in ((-0.60, 0.99), (0.31, 0.99), (1.03, 0.99)):
        groove(t, t.line(z, 0.47, z + 0.015, y1, 0.012), 3.0)
    groove(t, t.line(-0.60, 0.47, 1.03, 0.47, 0.010), 2.5)
    groove(t, t.line(-0.60, 0.465, 1.03, 0.465, 0.012), 0.0, "#000000", 0.0)
    for z0 in (-0.12, 0.66):
        t.put(t.rect(z0, z0 + 0.15, 0.835, 0.862, 0.012), col=rgb("#f4f4f4"), h=3.0, r=0.3, m=0.4, k=1)
        t.put(t.rect(z0, z0 + 0.15, 0.827, 0.835), col=rgb("#000000"), a=0.35)
    # fuel flap, markers
    groove(t, t.rect(1.45, 1.60, 0.84, 0.97, 0.02) - t.rect(1.46, 1.59, 0.85, 0.96, 0.015) * 1.0, 2.0)
    t.put(t.rect(-2.08, -1.98, 0.60, 0.64, 0.01), col=rgb("#d48a1a"), r=0.2, m=0.2, k=0, h=1)
    t.put(t.rect(1.98, 2.08, 0.62, 0.66, 0.01), col=rgb("#b02424"), r=0.2, m=0.2, k=0, h=1)
    # glass trim along the belt
    t.put(t.rect(-0.62, 1.04, 0.972, 0.984), col=rgb("#09090a"), r=0.4, m=0, k=0)
    if kind == "taxi":
        t.put(t.rect(-0.46, -0.04, 0.62, 0.74, 0.015), col=rgb("#141414"), r=0.5, m=0, k=0, h=1)
        for i in range(3):
            t.put(t.rect(-0.42, -0.08 - i * 0.05, 0.69 - i * 0.03, 0.705 - i * 0.03), col=rgb("#e9e4cc"), r=0.5, m=0, k=0)
        t.put(t.rect(0.40, 0.84, 0.62, 0.74, 0.015), col=rgb("#141414"), r=0.5, m=0, k=0, h=1)
        t.put(t.rect(-0.60, 1.03, 0.795, 0.815), col=rgb("#141414"), r=0.5, m=0, k=0, a=0.9)
    elif kind == "police":
        t.put(t.poly([(-1.22, 0.50), (1.15, 0.50), (1.22, 0.66), (-1.12, 0.66)]), col=rgb("#1d3f94"), r=0.3, m=0.2, k=0)
        t.put(t.rect(-1.0, 1.0, 0.54, 0.555), col=rgb("#cfd6e6"), r=0.3, m=0.3, k=0, a=0.8)
        t.put(t.disc(-0.25, 0.80, 0.085), col=rgb("#1d3f94"), r=0.3, m=0.2, k=0)
        t.put(t.disc(-0.25, 0.80, 0.055), col=rgb("#c9ced8"), r=0.3, m=0.5, k=0)
        for i in range(6):
            za = 0.46 + i * 0.075
            t.put(t.rect(za, za + 0.05, 0.71, 0.78), col=rgb("#1d3f94"), r=0.4, m=0.1, k=0, a=0.9)
    grime(t, 0.20, 0.80, 0.72)
    speckle(t)


def paint_side_suv(t):
    base(t)
    t.put(t.rect(-9, 9, -1, 0.52), col=rgb("#232427"), r=0.7, m=0.0, k=0)
    t.put(t.rect(-9, 9, 0.50, 0.53), col=rgb("#7c7f84"), r=0.5, m=0.5, k=0, a=0.7)
    groove(t, t.line(-2.1, 0.80, 2.1, 0.86, 0.010), 2.0, "#7f8286", 0.45)
    for z in (-0.84, 0.48, 1.34):
        groove(t, t.line(z, 0.55, z + 0.02, 1.10, 0.012), 3.0)
    groove(t, t.line(-0.84, 0.55, 1.34, 0.55, 0.010), 2.5)
    groove(t, t.line(1.96, 0.55, 1.98, 1.35, 0.012), 3.0)
    for z0 in (-0.30, 0.64):
        t.put(t.rect(z0, z0 + 0.16, 0.98, 1.006, 0.012), col=rgb("#f4f4f4"), h=3.0, r=0.3, m=0.4, k=1)
    t.put(t.rect(-2.2, -2.08, 0.70, 0.75, 0.01), col=rgb("#d48a1a"), r=0.2, m=0.2, k=0, h=1)
    t.put(t.rect(2.08, 2.2, 0.80, 0.86, 0.01), col=rgb("#b02424"), r=0.2, m=0.2, k=0, h=1)
    groove(t, t.rect(1.55, 1.70, 0.98, 1.10, 0.02) - t.rect(1.56, 1.69, 0.99, 1.09, 0.015), 2.0)
    t.put(t.rect(-0.82, 1.38, 1.095, 1.115), col=rgb("#09090a"), r=0.4, m=0, k=0)
    grime(t, 0.20, 0.95, 0.72)
    speckle(t)


def paint_side_humvee(t):
    base(t, "#6f6a4b", 0.85, 0.0, 0.0)
    for z in (-0.55, 0.11, 0.62, 1.36, 1.9):
        groove(t, t.line(z, 0.58, z + 0.01, 1.62, 0.014), 3.5)
    groove(t, t.line(-0.55, 0.62, 1.9, 0.62, 0.012), 3.0)
    groove(t, t.line(-2.3, 1.18, 2.3, 1.18, 0.012), 2.5)
    for i in range(30):  # rivet rows
        z = -2.25 + i * 0.16
        t.put(t.disc(z, 0.70, 0.013), col=rgb("#2c2a20"), h=2.0, r=0.8, m=0, k=0)
        t.put(t.disc(z, 1.10, 0.013), col=rgb("#2c2a20"), h=2.0, r=0.8, m=0, k=0)
    for z0 in (-0.12, 0.70):
        t.put(t.rect(z0, z0 + 0.16, 1.02, 1.045, 0.01), col=rgb("#25241c"), h=3.0, r=0.7, m=0, k=0)
    t.put(t.rect(-0.45, 0.0, 0.68, 0.90, 0.01), col=rgb("#5b5640"), h=-1, a=0.6, r=0.9)
    t.put(t.rect(-9, 9, -1, 0.52), col=rgb("#2b2a22"), r=0.9, m=0.0, k=0)
    t.put(t.rect(-1.95, -1.10, 0.52, 0.62), col=rgb("#d9d3b0"), r=0.9, m=0.0, k=0, a=0.0)
    grime(t, 0.40, 1.1, 0.62)
    speckle(t, 0.03)


def paint_side_van(t):
    base(t)
    t.put(t.rect(-9, 9, -1, 0.56), col=rgb("#222326"), r=0.65, m=0.0, k=0)
    groove(t, t.line(-2.7, 1.00, 2.7, 1.02, 0.012), 2.5, "#7f8286", 0.5)
    groove(t, t.line(-1.12, 0.60, -1.10, 2.0, 0.012), 3.0)  # front door
    for z in (0.15, 1.65):  # sliding door
        groove(t, t.line(z, 0.60, z + 0.01, 2.10, 0.012), 3.0)
    groove(t, t.line(0.15, 2.10, 1.65, 2.10, 0.012), 3.0)
    groove(t, t.line(0.15, 0.62, 1.65, 0.62, 0.012), 3.0)
    t.put(t.rect(0.15, 1.65, 1.62, 1.66), col=rgb("#7c7f84"), r=0.4, m=0.6, k=0, a=0.7)  # rail
    t.put(t.rect(-1.0, -0.84, 1.22, 1.25, 0.01), col=rgb("#f4f4f4"), h=3.0, k=1)
    t.put(t.rect(0.30, 0.46, 1.22, 1.25, 0.01), col=rgb("#f4f4f4"), h=3.0, k=1)
    t.put(t.rect(2.30, 2.45, 0.60, 0.65), col=rgb("#b02424"), r=0.2, k=0, h=1)
    grime(t, 0.30, 1.1, 0.70)
    speckle(t)


def paint_side_truckcab(t):
    base(t)
    t.put(t.rect(-9, 9, -1, 0.80), col=rgb("#202225"), r=0.7, m=0, k=0)
    for z in (-3.95, -2.55):
        groove(t, t.line(z, 0.8, z + 0.01, 2.40, 0.014), 3.0)
    t.put(t.rect(-3.40, -3.18, 1.28, 1.32, 0.01), col=rgb("#f4f4f4"), h=3, k=1)
    t.put(t.rect(-3.9, -3.5, 0.50, 0.78), col=rgb("#2b2d31"), r=0.5, m=0.5, k=0)
    grime(t, 0.45, 1.5, 0.7)
    speckle(t)


def paint_side_box(t):
    base(t)
    for i in range(20):  # vertical ribs
        z = -1.8 + i * 0.30
        groove(t, t.line(z, 1.2, z, 3.3, 0.04), 3.0, "#555a5e", 0.5)
        t.put(t.line(z + 0.05, 1.2, z + 0.05, 3.3, 0.03), col=rgb("#ffffff"), h=2.5, a=0.15)
    for y in (1.20, 3.30):
        t.put(t.rect(-9, 9, y - 0.04, y + 0.04), col=rgb("#8e9298"), r=0.4, m=0.6, k=0, h=2)
    t.put(t.rect(-9, 9, 0.5, 1.15), col=rgb("#25272a"), r=0.8, m=0, k=0, a=0.0)
    for z in (-1.7, 3.9):
        t.put(t.rect(z, z + 0.12, 1.28, 1.38), col=rgb("#d9801a"), r=0.3, k=0)
    grime(t, 0.9, 1.9, 0.72)
    speckle(t)


def bus_side(t, doors):
    base(t, "#e9ebed", 0.30, 0.30, 1.0)
    t.put(t.rect(-9, 9, 0.80, 1.20), col=rgb("#1d4f91"), r=0.3, m=0.2, k=0)
    t.put(t.rect(-9, 9, 0.84, 0.86), col=rgb("#f0f2f4"), r=0.3, m=0.2, k=0)
    t.put(t.rect(-9, 9, -1, 0.66), col=rgb("#1b1c1f"), r=0.7, m=0, k=0)
    panes = [(-5.35, -4.25), (-4.15, -2.85), (-2.75, -1.45), (-1.35, 0.35), (0.45, 1.65), (1.75, 3.0), (3.1, 4.3), (4.4, 5.55)]
    dr = [(-5.35, -4.25), (0.45, 1.65)]
    if doors:
        panes = [p for p in panes if p not in dr]
    for (a, b) in panes:
        t.put(t.rect(a, b, 1.28, 2.50, 0.07), col=rgb("#1c262e"), h=-2, r=0.06, m=0.9, k=0)
        # seat backs / stanchion silhouettes
        n = max(1, int((b - a) / 0.55))
        for i in range(n):
            za = a + (i + 0.35) * (b - a) / n
            t.put(t.rect(za, za + 0.20, 1.30, 1.92, 0.06), col=rgb("#080b0e"), r=0.4, m=0.3, k=0, a=0.8)
        t.put(t.rect(a, b, 2.30, 2.50, 0.05), col=rgb("#2f4452"), r=0.08, m=0.9, k=0, a=0.30)
    if doors:
        for (a, b) in dr:
            t.put(t.rect(a, b, 0.70, 2.52, 0.04), col=rgb("#aeb3b8"), r=0.4, m=0.6, k=0, h=1)
            for (c0, c1) in ((a + 0.04, (a + b) / 2 - 0.015), ((a + b) / 2 + 0.015, b - 0.04)):
                t.put(t.rect(c0, c1, 0.78, 2.46, 0.03), col=rgb("#1c262e"), h=-2, r=0.06, m=0.9, k=0)
    groove(t, t.rect(-9, 9, 2.56, 2.575), 2.0, "#6d7176", 0.6)
    grime(t, 0.40, 1.0, 0.70)
    speckle(t)


def paint_front_car(t, kind, S):
    """Front fascia for car-like vehicles. S: dict(lamp, grille, intake, plate, style)."""
    paint = S.get("paint", "#ececec")
    base(t, paint, S.get("r", 0.30), S.get("m", 0.35), S.get("k", 1.0))
    L = LAMP[S["lamp"]]
    gx0, gx1, gy0, gy1 = S["grille"]
    if S.get("intake"):
        ix0, ix1, iy0, iy1 = S["intake"]
        t.put(t.poly([(-ix1, iy0), (ix1, iy0), (ix1 - 0.06, iy1), (-ix1 + 0.06, iy1)]), col=rgb("#0a0b0c"), h=-6.0, r=0.8, m=0.0, k=0)
        y = iy0 + 0.02
        while y < iy1 - 0.01:
            t.put(t.rect(-ix1 + 0.05, ix1 - 0.05, y, y + 0.009), col=rgb("#2a2c30"), h=2.0, r=0.5, m=0.3, k=0)
            y += 0.028
    t.put(t.rect(-9, 9, S.get("lip", 0.0), S.get("lip_y", 0.30)), col=rgb("#18191b"), r=0.65, m=0.0, k=0)
    # grille: chrome frame + mesh
    t.put(t.rect(gx0 - 0.014, gx1 + 0.014, gy0 - 0.014, gy1 + 0.014, 0.025), col=rgb("#a7adb4"), r=0.25, m=1.0, k=0, h=2)
    t.put(t.rect(gx0, gx1, gy0, gy1, 0.018), col=rgb("#0c0d0f"), r=0.7, m=0.2, k=0, h=-5)
    n = int((gx1 - gx0) / 0.034)
    for i in range(1, n):
        x = gx0 + i * (gx1 - gx0) / n
        t.put(t.line(x, gy0 + 0.01, x, gy1 - 0.01, 0.007), col=rgb("#2c2f33"), h=2.5, r=0.4, m=0.5, k=0)
    for j in range(1, 4):
        y = gy0 + j * (gy1 - gy0) / 4
        t.put(t.line(gx0 + 0.01, y, gx1 - 0.01, y, 0.007), col=rgb("#2c2f33"), h=2.5, r=0.4, m=0.5, k=0)
    t.put(t.disc(0, (gy0 + gy1) / 2, 0.03), col=rgb("#c9cdd2"), r=0.2, m=1, k=0, h=3)
    for sd in (1, -1):
        P, cx, cy = lamp_poly(t, L["head"], sd, red=False)
        t.put(t.disc(cx, cy, 0.036), col=rgb("#c8d0da"), r=0.05, m=0.9, k=0, h=2)
        t.put(t.disc(cx, cy, 0.022), col=rgb("#f2f6fb"), r=0.05, m=0.2, k=0, h=3)
        xs = [p[0] for p in P]
        ysu = max(p[1] for p in P)
        t.put(t.line(min(xs) + 0.02, ysu - 0.015, max(xs) - 0.02, ysu - 0.015, 0.012), col=rgb("#f3f6ff"), r=0.1, m=0.1, k=0, h=1)
        if S.get("fog"):
            fx, fy, fr = S["fog"]
            t.put(t.disc(sd * fx, fy, fr + 0.008), col=rgb("#2a2c30"), r=0.4, m=0.5, k=0)
            t.put(t.disc(sd * fx, fy, fr), col=rgb("#9aa4ae"), r=0.08, m=0.5, k=0, h=1)
    if S.get("plate"):
        plate(t, *S["plate"])
    grime(t, 0.20, 0.55, 0.78)
    speckle(t)


def paint_rear_car(t, kind, S):
    base(t, S.get("paint", "#ececec"), S.get("r", 0.30), S.get("m", 0.35), S.get("k", 1.0))
    L = LAMP[S["lamp"]]
    t.put(t.rect(-9, 9, -1, S.get("bump", 0.45)), col=rgb("#18191b"), r=0.65, m=0.0, k=0)
    for sd in (1, -1):
        P, cx, cy = lamp_poly(t, L["tail"], sd, housing="#2a0a0c", lens=("#a3202a", "#5e0d14"))
        ys = [p[1] for p in P]
        t.put(t.poly([(sd * x, y) for x, y in L["tg"]]), col=rgb("#e0414c"), r=0.08, m=0.2, k=0, h=1)
        if S.get("rev"):
            rx, ry = S["rev"]
            t.put(t.rect(sd * rx - 0.03, sd * rx + 0.03, ry, ry + 0.05, 0.01), col=rgb("#d6dce2"), r=0.1, m=0.2, k=0)
        if S.get("exhaust"):
            ex, ey = S["exhaust"]
            t.put(t.ell(sd * ex, ey, 0.045, 0.03), col=rgb("#07080a"), h=-5, r=0.6, m=0.2, k=0)
            t.put(t.ring(sd * ex, ey, 0.038, 0.052), col=rgb("#b9bec5"), r=0.2, m=1.0, k=0, h=2) if False else None
        t.put(t.rect(sd * 0.80 - 0.05, sd * 0.80 + 0.05, S.get("bump", 0.45) - 0.09, S.get("bump", 0.45) - 0.05), col=rgb("#b02424"), r=0.3, k=0)
    if S.get("plate"):
        plate(t, *S["plate"])
    if S.get("seam"):
        groove(t, t.line(*S["seam"], 0.012), 3.0)
    groove(t, t.line(-0.80, S.get("trunk", 0.83), 0.80, S.get("trunk", 0.83), 0.012), 2.5)
    t.put(t.line(-0.80, S.get("trunk", 0.83) + 0.015, 0.80, S.get("trunk", 0.83) + 0.015, 0.014), col=rgb("#ffffff"), h=2.0, a=0.12)
    grime(t, 0.20, 0.60, 0.75)
    speckle(t)


def paint_front_big(t, kind):
    k = kind
    if k == "van":
        paint_front_car(t, "van", dict(lamp="van", grille=(-0.34, 0.34, 0.74, 0.93), intake=(-0.70, 0.70, 0.46, 0.66), plate=(-0.16, 0.16, 0.50, 0.62), lip=0.0, lip_y=0.46, fog=(0.76, 0.56, 0.04)))
    elif k == "humvee":
        paint_front_car(t, "humvee", dict(lamp="humvee", grille=(-0.52, 0.52, 0.62, 1.04), plate=None, paint="#6f6a4b", r=0.85, m=0.0, k=0.0, lip=0.0, lip_y=0.52))
        for gx in np.linspace(-0.44, 0.44, 8):
            t.put(t.rect(gx - 0.012, gx + 0.012, 0.64, 1.02), col=rgb("#4f4936"), h=3, r=0.8, m=0, k=0)
    elif k == "truck":
        paint_front_car(t, "truck", dict(lamp="truck", grille=(-0.70, 0.70, 0.98, 1.34), intake=(-0.80, 0.80, 0.50, 0.70), plate=(-0.26, 0.26, 0.52, 0.66), lip=0.0, lip_y=0.50))
        for y in (1.06, 1.16, 1.26):
            t.put(t.rect(-0.69, 0.69, y, y + 0.02), col=rgb("#b9bec5"), r=0.25, m=1.0, k=0, h=2)
    elif k == "bus":
        paint_front_car(t, "bus", dict(lamp="bus", grille=(-0.44, 0.44, 0.76, 1.12), intake=(-1.0, 1.0, 0.46, 0.70), plate=(-0.17, 0.17, 0.48, 0.62), paint="#e9ebed", lip=0.0, lip_y=0.46))
        t.put(t.rect(-9, 9, 1.40, 1.60), col=rgb("#1d4f91"), r=0.3, m=0.2, k=0)


def paint_rear_big(t, kind):
    if kind == "rear_van":
        paint_rear_car(t, "van", dict(lamp="van", plate=(-0.16, 0.16, 0.56, 0.69), bump=0.55, seam=(0, 0.62, 0, 2.15), trunk=1.0))
        t.put(t.rect(0.04, 0.09, 1.0, 1.12, 0.01), col=rgb("#1b1c1f"), h=3, k=0)
        t.put(t.rect(-0.09, -0.04, 1.0, 1.12, 0.01), col=rgb("#1b1c1f"), h=3, k=0)
        groove(t, t.rect(-0.95, 0.95, 0.55, 2.10, 0.03) - t.rect(-0.94, 0.94, 0.56, 2.09, 0.03), 2.0)
        t.put(t.rect(-0.86, 0.86, 1.62, 2.02, 0.05), col=rgb("#1c262e"), h=-2, r=0.06, m=0.9, k=0, a=0.0)
    elif kind == "rear_suv":
        paint_rear_car(t, "suv", dict(lamp="suv", plate=(-0.17, 0.17, 0.60, 0.74), bump=0.52, trunk=1.14, rev=(0.34, 0.60), exhaust=(0.62, 0.30)))
    elif kind == "rear_humvee":
        paint_rear_car(t, "humvee", dict(lamp="humvee", plate=(-0.16, 0.16, 0.82, 0.94), bump=0.55, paint="#6f6a4b", r=0.85, m=0.0, k=0.0, trunk=1.1))
    elif kind == "rear_box":
        base(t)
        for i in range(24):
            y = 1.30 + i * 0.095
            groove(t, t.rect(-1.15, 1.15, y, y + 0.02), 3.0, "#55595e", 0.7)
            t.put(t.rect(-1.15, 1.15, y + 0.02, y + 0.034), col=rgb("#ffffff"), h=2.0, a=0.18)
        t.put(t.rect(-9, 9, -1, 1.28), col=rgb("#1b1c1f"), r=0.7, m=0, k=0)
        for i in range(12):  # reflective chevrons
            x = -1.1 + i * 0.19
            t.put(t.poly([(x, 0.92), (x + 0.10, 0.92), (x + 0.19, 1.06), (x + 0.09, 1.06)]), col=rgb("#c4202a" if i % 2 else "#e6e6e6"), r=0.3, m=0.1, k=0)
        for sd in (1, -1):
            lamp_poly(t, LAMP["truck"]["tail"], sd, housing="#2a0a0c", lens=("#a3202a", "#5e0d14"))
        plate(t, -0.26, 0.26, 1.18, 1.34)
        groove(t, t.rect(-0.012, 0.012, 1.35, 3.35), 3.0)
        t.put(t.rect(-1.2, 1.2, 3.33, 3.44), col=rgb("#8e9298"), r=0.4, m=0.6, k=0)
        grime(t, 0.9, 1.6, 0.7)
        speckle(t)
    elif kind == "rear_bus":
        base(t, "#e9ebed")
        t.put(t.rect(-9, 9, -1, 0.72), col=rgb("#1b1c1f"), r=0.7, m=0, k=0)
        t.put(t.rect(-9, 9, 1.40, 1.60), col=rgb("#1d4f91"), r=0.3, m=0.2, k=0)
        t.put(t.rect(-0.85, 0.85, 2.10, 2.70, 0.07), col=rgb("#1c262e"), h=-2, r=0.06, m=0.9, k=0)
        t.put(t.rect(-0.85, 0.85, 2.52, 2.70, 0.05), col=rgb("#2f4452"), r=0.08, m=0.9, k=0, a=0.3)
        for i in range(12):  # engine louvres
            y = 1.70 + i * 0.03
            t.put(t.rect(-0.7, 0.7, y, y + 0.012), col=rgb("#08090a"), h=-3, r=0.8, m=0, k=0)
        for sd in (1, -1):
            lamp_poly(t, LAMP["bus"]["tail"], sd, housing="#2a0a0c", lens=("#a3202a", "#5e0d14"))
        plate(t, -0.17, 0.17, 0.80, 0.94)
        grime(t, 0.4, 1.0, 0.7)
        speckle(t)


def paint_glass_side(t):
    h = np.linspace(0, 1, t.h)[:, None] * np.ones((1, t.w))
    base_c = rgb("#0e151b") * (1 - h[..., None]) + rgb("#1f2e39") * h[..., None]
    t.put(np.ones((t.h, t.w)), col=base_c * 1.0, r=0.06, m=0.9, k=0)
    for cx in (0.30, 0.68):  # headrests + seat backs
        t.put(t.c_rrect(cx * t.w - 7, t.h * 0.34, cx * t.w + 7, t.h * 0.60, 4), col=rgb("#05070a"), a=0.9)
        t.put(t.c_rrect(cx * t.w - 14, t.h * 0.58, cx * t.w + 14, t.h * 1.1, 4), col=rgb("#06080b"), a=0.9)
    t.put(t.c_line(t.w * 0.1, t.h, t.w * 0.55, 0, 7), col=rgb("#8fb0c4"), a=0.10)
    t.put(t.c_rrect(0, t.h * 0.9, t.w, t.h, 0), col=rgb("#040506"), a=0.8)


def paint_glass_ws(t):
    h = np.linspace(0, 1, t.h)[:, None] * np.ones((1, t.w))
    base_c = rgb("#10171d") * (1 - h[..., None]) + rgb("#20313d") * h[..., None]
    t.put(np.ones((t.h, t.w)), col=base_c, r=0.06, m=0.9, k=0)
    t.put(t.c_rrect(0, 0, t.w, t.h * 0.22, 0), col=rgb("#030405"), a=0.9)  # dash
    t.put(t.c_rrect(t.w * 0.38, t.h * 0.80, t.w * 0.62, t.h * 0.92, 3), col=rgb("#05070a"), a=0.9)  # mirror
    t.put(t.c_rrect(0, t.h * 0.93, t.w, t.h, 0), col=rgb("#1b4766"), a=0.55)  # sun strip
    t.put(t.c_disc(t.w * 0.28, t.h * 0.26, 11), col=rgb("#05070a"), a=0.8)  # wheel
    t.put(t.c_line(t.w * 0.7, t.h, t.w * 0.2, 0, 9), col=rgb("#8fb0c4"), a=0.10)


def paint_glass_rg(t):
    h = np.linspace(0, 1, t.h)[:, None] * np.ones((1, t.w))
    base_c = rgb("#0f161c") * (1 - h[..., None]) + rgb("#1c2a34") * h[..., None]
    t.put(np.ones((t.h, t.w)), col=base_c, r=0.06, m=0.9, k=0)
    for cx in (0.25, 0.5, 0.75):
        t.put(t.c_rrect(cx * t.w - 7, t.h * 0.22, cx * t.w + 7, t.h * 0.50, 4), col=rgb("#05070a"), a=0.85)
    t.put(t.c_rrect(0, t.h * 0.72, t.w, t.h, 0), col=rgb("#040506"), a=0.9)
    t.put(t.c_rrect(t.w * 0.32, t.h * 0.78, t.w * 0.68, t.h * 0.86, 2), col=rgb("#8a141b"), a=0.9)
    t.put(t.c_line(t.w * 0.2, t.h, t.w * 0.6, 0, 8), col=rgb("#8fb0c4"), a=0.10)


def polar(t):
    cx, cy = t.w / 2, t.h / 2
    dx, dy = t.X - cx, t.Y - cy
    return np.hypot(dx, dy) / (t.w / 2 - 1), np.arctan2(dy, dx)


def paint_wheel(t, style):
    r, th = polar(t)
    t.put(np.ones((t.h, t.w)), col=rgb("#141415"), r=0.92, m=0.0, k=0, h=0.0)
    ring = lambda a, b: np.clip(0.5 - (np.abs(r - (a + b) / 2) - (b - a) / 2) * 63, 0, 1)
    disc = lambda a: np.clip(0.5 - (r - a) * 63, 0, 1)
    t.put(ring(0.70, 0.725), col=rgb("#242427"), h=3.0, r=0.85)
    t.put(ring(0.80, 0.805), col=rgb("#0c0c0d"), h=-1.0)
    for i in range(5):  # sidewall text blocks
        a0 = i * 1.25 + 0.2
        t.put(ring(0.84, 0.90) * np.clip(1 - np.abs(((th - a0 + np.pi) % (2 * np.pi)) - np.pi) / 0.22, 0, 1), col=rgb("#2a2a2d"), r=0.8, a=0.9)
    t.put(disc(0.64), col=rgb("#2a2c30"), h=-4.0, r=0.5, m=0.8)  # brake disc / dish
    if style == "alloy":
        t.put(disc(0.40), col=rgb("#3f4146"), h=-5.0, r=0.45, m=0.9)
        t.put(t.c_rrect(t.w * 0.5 + 6, t.h * 0.5 - 22, t.w * 0.5 + 22, t.h * 0.5 - 12, 2), col=rgb("#7a211c"), r=0.5, m=0.3, h=2)  # calliper
        for i in range(5):
            a = i * 2 * np.pi / 5 + 0.3
            x1, y1 = t.w / 2 + np.cos(a) * 38, t.h / 2 + np.sin(a) * 38
            t.put(t.c_line(t.w / 2, t.h / 2, x1, y1, 9.5), col=rgb("#aeb4bb"), r=0.28, m=1.0, h=5.0)
            t.put(t.c_line(t.w / 2, t.h / 2, x1, y1, 4.5), col=rgb("#d6dbe0"), r=0.2, m=1.0, h=6.0, a=0.6)
        t.put(ring(0.575, 0.64), col=rgb("#b6bbc2"), r=0.25, m=1.0, h=4.0)
        t.put(disc(0.13), col=rgb("#9ba1a8"), r=0.3, m=1.0, h=6.0)
        t.put(disc(0.07), col=rgb("#30343a"), r=0.4, m=0.8, h=7.0)
    else:
        t.put(disc(0.62), col=rgb("#3b3e43"), h=2.0, r=0.6, m=0.55)
        t.put(ring(0.56, 0.62), col=rgb("#575b61"), h=4.0, r=0.5, m=0.7)
        for i in range(8):
            a = i * 2 * np.pi / 8
            t.put(t.c_ellipse(t.w / 2 + np.cos(a) * 0.40 * 63, t.h / 2 + np.sin(a) * 0.40 * 63, 8, 5) * 0 + t.c_disc(t.w / 2 + np.cos(a) * 0.40 * 63, t.h / 2 + np.sin(a) * 0.40 * 63, 6.5), col=rgb("#09090a"), h=-6.0, r=0.8, m=0.0)
        t.put(disc(0.25), col=rgb("#6a6e74"), h=5.0, r=0.4, m=0.8)
        for i in range(10):
            a = i * 2 * np.pi / 10
            t.put(t.c_disc(t.w / 2 + np.cos(a) * 0.19 * 63, t.h / 2 + np.sin(a) * 0.19 * 63, 2.3), col=rgb("#b9bec5"), r=0.25, m=1.0, h=7.0)
        t.put(disc(0.08), col=rgb("#30343a"), r=0.4, m=0.8, h=6.0)


def paint_tread(t):
    t.put(np.ones((t.h, t.w)), col=rgb("#121213"), r=0.95, m=0.0, k=0, h=0.0)
    t.put(t.c_rrect(0, 0, 3, t.h, 0), col=rgb("#040405"), h=-5.0)
    t.put(t.c_rrect(0, t.h / 2 - 1.5, t.w, t.h / 2 + 1.5, 0), col=rgb("#050506"), h=-4.0)
    t.put(t.c_line(4, 2, t.w - 4, t.h / 2 - 3, 2), col=rgb("#070708"), h=-3.0)
    t.put(t.c_line(4, t.h - 2, t.w - 4, t.h / 2 + 3, 2), col=rgb("#070708"), h=-3.0)


def paint_top(t, col="#ececec", r=0.30, m=0.35, k=1.0):
    base(t, col, r, m, k)
    speckle(t, 0.008)


def paint_swatch(t, name):
    c, rr, mm, kk = SWATCHES[name]
    t.put(np.ones((t.h, t.w)), col=rgb(c), r=rr, m=mm, k=kk, h=0.0)


def paint_all():
    for k in ("sedan", "taxi", "police"):
        paint_side_car(TILES["side_" + k], k)
    paint_front_car(TILES["front_sedan"], "sedan", dict(lamp="sedan", grille=(-0.34, 0.34, 0.50, 0.62), intake=(-0.62, 0.62, 0.30, 0.46), plate=(-0.15, 0.15, 0.335, 0.445), fog=(0.70, 0.37, 0.036)))
    paint_rear_car(TILES["rear_sedan"], "sedan", dict(lamp="sedan", plate=(-0.17, 0.17, 0.52, 0.66), bump=0.45, trunk=0.83, rev=(0.40, 0.45), exhaust=(0.55, 0.28)))
    paint_side_suv(TILES["side_suv"])
    paint_front_car(TILES["front_suv"], "suv", dict(lamp="suv", grille=(-0.40, 0.40, 0.70, 0.86), intake=(-0.66, 0.66, 0.40, 0.62), plate=(-0.16, 0.16, 0.42, 0.55), fog=(0.74, 0.46, 0.04)))
    paint_side_humvee(TILES["side_humvee"])
    paint_side_van(TILES["side_van"])
    paint_front_big(TILES["front_van"], "van")
    paint_front_big(TILES["front_humvee"], "humvee")
    paint_front_big(TILES["front_truck"], "truck")
    paint_front_big(TILES["front_bus"], "bus")
    for n in ("rear_suv", "rear_van", "rear_humvee", "rear_box", "rear_bus"):
        paint_rear_big(TILES[n], n)
    paint_side_truckcab(TILES["side_truckcab"])
    paint_side_box(TILES["side_box"])
    bus_side(TILES["side_bus"], True)
    bus_side(TILES["side_bus_l"], False)
    paint_top(TILES["top_paint"])
    paint_top(TILES["top_box"], "#e9ebed")
    paint_top(TILES["top_army"], "#6f6a4b", 0.85, 0.0, 0.0)
    paint_wheel(TILES["wheel_alloy"], "alloy")
    paint_wheel(TILES["wheel_steel"], "steel")
    paint_tread(TILES["tread"])
    paint_glass_side(TILES["glass_side"])
    paint_glass_ws(TILES["glass_ws"])
    paint_glass_rg(TILES["glass_rg"])
    for n in SWATCHES:
        paint_swatch(TILES["sw_" + n], n)


# ----------------------------------------------------------------------------------------------
# normals, export
# ----------------------------------------------------------------------------------------------
def noise3(p, seed, freq):
    rs = np.random.RandomState(seed)
    out = np.zeros(len(p))
    for k in range(4):
        d = rs.normal(size=3)
        d /= np.linalg.norm(d)
        out += np.sin(p @ d * freq * (1.0 + 0.4 * k) + rs.uniform(0, 6.28)) / 4.0
    return out


def finalize(m):
    P = np.array(m.P)
    nf = len(m.F)
    fn = np.zeros((nf, 3))
    fa = np.zeros(nf)
    for fi, (idx, _, _) in enumerate(m.F):
        n = m.normal(idx)
        a = np.linalg.norm(n)
        fa[fi] = a * 0.5
        fn[fi] = n / max(a, 1e-12)
    gk = [s for _, s, _ in m.F]
    vf = defaultdict(list)
    corners = []
    cidx = {}
    for fi, (idx, _, _) in enumerate(m.F):
        for vi in idx:
            cidx[(fi, vi)] = len(corners)
            corners.append((fi, vi))
            vf[vi].append(fi)
    parent = list(range(len(corners)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    cosT = math.cos(SMOOTH)
    for vi, fl in vf.items():
        for a in range(len(fl)):
            for b in range(a + 1, len(fl)):
                f, g = fl[a], fl[b]
                if gk[f] == gk[g] and np.dot(fn[f], fn[g]) > cosT:
                    ra, rb = find(cidx[(f, vi)]), find(cidx[(g, vi)])
                    if ra != rb:
                        parent[ra] = rb
    groups = defaultdict(list)
    for ci in range(len(corners)):
        groups[find(ci)].append(ci)
    cnormal = np.zeros((len(corners), 3))
    group_of = np.zeros(len(corners), dtype=np.int64)
    for gi, (root, cl) in enumerate(groups.items()):
        areas = np.array([fa[corners[c][0]] for c in cl])
        amax = areas.max()
        n = np.zeros(3)
        for c, a in zip(cl, areas):
            n += fn[corners[c][0]] * (a / amax) ** 3
        ln = np.linalg.norm(n)
        n = n / ln if ln > 1e-9 else fn[corners[cl[0]][0]]
        for c in cl:
            cnormal[c] = n
            group_of[c] = gi
    # uv per corner
    cuv = np.zeros((len(corners), 2))
    ci = 0
    for fi, (idx, surf, spec) in enumerate(m.F):
        for k, vi in enumerate(idx):
            if spec is None:
                cuv[ci] = swatch_uv(surf)
            elif spec[0] == "proj":
                cuv[ci] = tile_uv((spec[1], spec[2], spec[3]), P[vi])
            else:
                t = TILES[spec[1]]
                u, v = spec[2][k]
                x0, y0, w, h = t.arect
                cuv[ci] = ((x0 + min(max(u, 0.01), 0.99) * w) / ATLAS, (y0 + min(max(v, 0.01), 0.99) * h) / ATLAS)
            ci += 1
    return P, fn, cnormal, corners, group_of, cuv


def bake_ao(m, P, corners):
    me = bpy.data.meshes.new("veh")
    Bv = [(p[0], -p[2], p[1]) for p in P]
    me.from_pydata(Bv, [], [tuple(idx) for idx, _, _ in m.F])
    me.update()
    ob = bpy.data.objects.new("veh", me)
    bpy.context.scene.collection.objects.link(ob)
    ao = np.ones(len(corners))
    gm = bpy.data.meshes.new("ground")
    gm.from_pydata([(-30, -30, 0), (30, -30, 0), (30, 30, 0), (-30, 30, 0)], [], [(0, 1, 2, 3)])
    gob = bpy.data.objects.new("ground", gm)
    bpy.context.scene.collection.objects.link(gob)
    try:
        attr = me.color_attributes.new("ao", "FLOAT_COLOR", "CORNER")
        me.color_attributes.active_color = attr
        sc = bpy.context.scene
        sc.render.engine = "CYCLES"
        sc.cycles.device = "CPU"
        sc.cycles.samples = 48
        sc.world = bpy.data.worlds.new("ao_world")
        sc.world.light_settings.distance = AO_DIST
        bpy.ops.object.select_all(action="DESELECT")
        ob.select_set(True)
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.bake(type="AO", target="VERTEX_COLORS")
        buf = np.zeros(len(corners) * 4, dtype=np.float32)
        me.color_attributes["ao"].data.foreach_get("color", buf)
        ao = np.clip(buf.reshape(-1, 4)[:, :3].mean(axis=1), 0, 1).astype(np.float64)
    except Exception as exc:
        print("WARNING: AO bake failed:", exc)
    bpy.data.objects.remove(gob, do_unlink=True)
    return ob, me, ao


_prev_mat = None


def preview_material():
    global _prev_mat
    if _prev_mat:
        return _prev_mat
    mat = bpy.data.materials.new("veh_preview")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    uvn = nt.nodes.new("ShaderNodeUVMap")
    uvn.uv_map = "UV"

    def tex(name):
        n = nt.nodes.new("ShaderNodeTexImage")
        n.image = bpy.data.images[name]
        n.interpolation = "Linear"
        nt.links.new(uvn.outputs["UV"], n.inputs["Vector"])
        return n
    ta, tn, to = tex("atlas_albedo"), tex("atlas_normal"), tex("atlas_orm")
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(to.outputs["Color"], sep.inputs["Color"])
    tint = nt.nodes.new("ShaderNodeAttribute")
    tint.attribute_name = "Tint"
    ao = nt.nodes.new("ShaderNodeAttribute")
    ao.attribute_name = "Col"
    mix1 = nt.nodes.new("ShaderNodeMix")
    mix1.data_type = "RGBA"
    mix1.blend_type = "MIX"
    mix1.inputs[6].default_value = (1, 1, 1, 1)
    nt.links.new(sep.outputs["Red"], mix1.inputs[0])
    nt.links.new(tint.outputs["Color"], mix1.inputs[7])
    mul1 = nt.nodes.new("ShaderNodeMix")
    mul1.data_type = "RGBA"
    mul1.blend_type = "MULTIPLY"
    mul1.inputs[0].default_value = 1.0
    nt.links.new(ta.outputs["Color"], mul1.inputs[6])
    nt.links.new(mix1.outputs[2], mul1.inputs[7])
    mul2 = nt.nodes.new("ShaderNodeMix")
    mul2.data_type = "RGBA"
    mul2.blend_type = "MULTIPLY"
    mul2.inputs[0].default_value = 1.0
    nt.links.new(mul1.outputs[2], mul2.inputs[6])
    nt.links.new(ao.outputs["Color"], mul2.inputs[7])
    nt.links.new((ta if "a" in os.environ.get("DBG", "") else mul2).outputs["Color" if "a" in os.environ.get("DBG", "") else 2], bsdf.inputs["Base Color"])
    nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nm.uv_map = "UV"
    nt.links.new(tn.outputs["Color"], nm.inputs["Color"])
    if "n" not in os.environ.get("DBG", ""):
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    _prev_mat = mat
    return mat


def make_blender_images(A, N, O):
    def mk(name, arr, cs, flip_g=False):
        a = arr.copy()
        if flip_g:
            a[..., 1] = 1 - a[..., 1]
        img = bpy.data.images.new(name, ATLAS, ATLAS, alpha=False)
        buf = np.ones((ATLAS, ATLAS, 4), dtype=np.float32)
        buf[..., :3] = np.flipud(a)
        img.colorspace_settings.name = cs
        img.pixels.foreach_set(buf.ravel())
        img.update()
        print("  img", name, np.mean(np.array(img.pixels[:4096])), flush=True)
    mk("atlas_albedo", A, "sRGB")
    mk("atlas_normal", N, "Non-Color", True)
    mk("atlas_orm", O, "Non-Color")


def build_asset(m, tint_preview):
    P, fn, cnormal, corners, group_of, cuv = finalize(m)
    ob, me, ao = bake_ao(m, P, corners)
    gsum = np.bincount(group_of, weights=ao)
    gcnt = np.bincount(group_of)
    ao = (gsum / gcnt)[group_of]
    cf = np.array([c[0] for c in corners])
    cv = np.array([c[1] for c in corners])
    pos = P[cv]
    msk = np.array([SURF[s][3] for _, s, _ in m.F])
    h = np.clip((pos[:, 1] - 0.25) / 0.55, 0, 1)
    grime = 0.80 + 0.20 * h * h * (3 - 2 * h)
    var = 1.0 + 0.04 * noise3(pos, 5, 2.3) + 0.025 * noise3(pos, 9, 9.0)
    occ = np.clip((AO_FLOOR + (1 - AO_FLOOR) * ao ** 1.1) * grime * var, 0, 1)
    print('  occ mean', occ.mean(), 'ao mean', ao.mean(), flush=True)
    aob = np.clip(np.round(occ * 255), 0, 255).astype(np.int64)
    qn = np.clip(np.round(cnormal * 127), -127, 127).astype(np.int64)
    uq = np.clip(np.round(cuv * 65535), 0, 65535).astype(np.int64)
    vmap = {}
    out_pos, out_nor, out_ao, out_uv, out_mask, indices = [], [], [], [], [], []
    ci = 0
    for fi, (idx, _, _) in enumerate(m.F):
        ids = []
        for vi in idx:
            key = (vi, tuple(qn[ci]), tuple(uq[ci]), int(aob[ci]), int(msk[fi]))
            j = vmap.get(key)
            if j is None:
                j = len(out_pos)
                vmap[key] = j
                gp = P[vi]
                out_pos.append((int(round(gp[0] * SCALE)), int(round(gp[1] * SCALE)), int(round(gp[2] * SCALE))))
                out_nor.append(tuple(int(x) for x in qn[ci]))
                out_ao.append(int(aob[ci]))
                out_uv.append((int(uq[ci][0]), int(uq[ci][1])))
                out_mask.append(int(msk[fi]))
            ids.append(j)
            ci += 1
        for t in range(1, len(ids) - 1):
            indices.extend((ids[0], ids[t], ids[t + 1]))
    nv, nt = len(out_pos), len(indices) // 3
    assert nv < 65536
    blob = b"".join([
        struct.pack("<%dh" % (nv * 3), *[c for p in out_pos for c in p]),
        struct.pack("<%db" % (nv * 3), *[c for p in out_nor for c in p]),
        struct.pack("<%dB" % nv, *out_ao),
        struct.pack("<%dB" % nv, *out_mask),
        struct.pack("<%dH" % (nv * 2), *[c for p in out_uv for c in p]),
        struct.pack("<%dH" % len(indices), *indices),
    ])
    # ---- preview attributes
    nc = len(corners)
    uvl = me.uv_layers.new(name="UV")
    uvb = np.stack([cuv[:, 0], 1 - cuv[:, 1]], axis=1).astype(np.float32)
    uvl.data.foreach_set("uv", uvb.ravel())
    cattr = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
    cb = np.ones((nc, 4), dtype=np.float32)
    cb[:, :3] = occ[:, None]
    cattr.data.foreach_set("color", cb.ravel())
    tattr = me.color_attributes.new("Tint", "FLOAT_COLOR", "CORNER")
    tb = np.ones((nc, 4), dtype=np.float32)
    for k in (1, 2):
        sel = msk[cf] == k
        tb[sel, :3] = np.array(tint_preview[k - 1])
    tattr.data.foreach_set("color", tb.ravel())
    if os.environ.get("DBG"):
        img = bpy.data.images["atlas_albedo"]
        px = np.array(img.pixels[:]).reshape(ATLAS, ATLAS, 4)
        for fi in (10, 100, 200, 300):
            u, v = uvb[fi * 4 % len(uvb)]
            print("  sample", fi, u, v, px[int(v * (ATLAS - 1)), int(u * (ATLAS - 1))], flush=True)
        for nm in ("top_paint", "side_sedan", "sw_paint"):
            x0, y0, w, h = TILES[nm].arect
            cx, cy = x0 + w // 2, y0 + h // 2
            print("  tile", nm, TILES[nm].arect, px[ATLAS - 1 - cy, cx], flush=True)
        print("  uv range", uvb.min(axis=0), uvb.max(axis=0), "len", len(uvb), "loops", len(me.loops), flush=True)
    me.materials.append(preview_material())
    me.polygons.foreach_set("use_smooth", np.ones(len(me.polygons), dtype=bool))
    cn = [(n[0], -n[2], n[1]) for n in cnormal]
    me.normals_split_custom_set(cn)
    me.update()
    info = {"verts": nv, "tris": nt, "b64": base64.b64encode(blob).decode("ascii"), "bbox": (P.min(axis=0), P.max(axis=0))}
    return ob, info


# ----------------------------------------------------------------------------------------------
# previews
# ----------------------------------------------------------------------------------------------
def setup_studio():
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = SAMPLES
    sc.cycles.use_denoising = True
    sc.cycles.max_bounces = 4
    try:
        sc.view_settings.view_transform = "AgX"
        sc.view_settings.look = "AgX - Medium High Contrast"
        sc.view_settings.exposure = -0.3
    except Exception:
        pass
    sc.render.resolution_x = 900
    sc.render.resolution_y = 506
    sc.render.resolution_percentage = int(os.environ.get("RES", "100"))
    sc.render.image_settings.file_format = "PNG"
    world = bpy.data.worlds.new("studio")
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    mix = nt.nodes.new("ShaderNodeMixShader")
    lp = nt.nodes.new("ShaderNodeLightPath")
    cam_bg = nt.nodes.new("ShaderNodeBackground")
    cam_bg.inputs[0].default_value = (0.20, 0.215, 0.235, 1)
    env_bg = nt.nodes.new("ShaderNodeBackground")
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    mapr = nt.nodes.new("ShaderNodeMapRange")
    mapr.inputs[1].default_value = -1.0
    mapr.inputs[2].default_value = 1.0
    nt.links.new(geo.outputs["Incoming"], sep.inputs[0])
    nt.links.new(sep.outputs["Z"], mapr.inputs[0])
    nt.links.new(mapr.outputs[0], ramp.inputs[0])
    els = ramp.color_ramp.elements
    els[0].position = 0.0
    els[0].color = (0.10, 0.10, 0.10, 1)
    els[1].position = 1.0
    els[1].color = (0.75, 0.88, 1.15, 1)
    e = els.new(0.5)
    e.color = (0.45, 0.47, 0.5, 1)
    e = els.new(0.46)
    e.color = (0.20, 0.20, 0.2, 1)
    nt.links.new(ramp.outputs[0], env_bg.inputs[0])
    env_bg.inputs[1].default_value = 1.1
    nt.links.new(lp.outputs["Is Camera Ray"], mix.inputs[0])
    nt.links.new(env_bg.outputs[0], mix.inputs[1])
    nt.links.new(cam_bg.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs[0])
    sc.world = world
    gm = bpy.data.meshes.new("road")
    gm.from_pydata([(-60, -60, 0), (60, -60, 0), (60, 60, 0), (-60, 60, 0)], [], [(0, 1, 2, 3)])
    g = bpy.data.objects.new("road", gm)
    sc.collection.objects.link(g)
    mat = bpy.data.materials.new("asphalt")
    mat.use_nodes = True
    b = mat.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (0.045, 0.045, 0.05, 1)
    b.inputs["Roughness"].default_value = 0.9
    gm.materials.append(mat)


def add_area(name, loc, target, size, power, color=(1, 1, 1)):
    ld = bpy.data.lights.new(name, "AREA")
    ld.size = size
    ld.energy = power
    ld.color = color
    ob = bpy.data.objects.new(name, ld)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = loc
    ob.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()


def render_previews(kind, info):
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    sc = bpy.context.scene
    setup_studio()
    lo, hi = info["bbox"]
    ctr = Vector(((lo[0] + hi[0]) / 2, -(lo[2] + hi[2]) / 2, (lo[1] + hi[1]) / 2))
    size = max(hi[2] - lo[2], (hi[0] - lo[0]) * 1.6)
    R = size
    add_area("key", ctr + Vector((-0.8 * R, -1.1 * R, 1.2 * R)), ctr, R * 1.3, 90 * R * R)
    add_area("fill", ctr + Vector((1.3 * R, 0.6 * R, 0.7 * R)), ctr, R * 1.6, 35 * R * R, (0.85, 0.92, 1.0))
    add_area("top", ctr + Vector((0, 0, 1.8 * R)), ctr, R * 2.2, 40 * R * R)
    cd = bpy.data.cameras.new("cam")
    cd.lens = 42
    cd.clip_end = 300
    cam = bpy.data.objects.new("cam", cd)
    sc.collection.objects.link(cam)
    sc.camera = cam
    h = (hi[1] - lo[1])
    dist = max(size * 1.15, 4.0) * 1.35
    views = {"": Vector((-0.72, 0.68, 0.34)), "_rear": Vector((0.70, -0.70, 0.32))}
    if os.environ.get("EXTRA_VIEWS"):
        views["_side"] = Vector((-1.0, 0.0, 0.12))
        views["_front"] = Vector((0.0, 1.0, 0.12))
    for suffix, dvec in views.items():
        cam.location = ctr + dvec.normalized() * dist
        cam.rotation_euler = (ctr + Vector((0, 0, -h * 0.05)) - cam.location).to_track_quat("-Z", "Y").to_euler()
        sc.render.filepath = os.path.join(PREVIEW_DIR, f"vehicle_{kind}{suffix}.png")
        bpy.ops.render.render(write_still=True)


def contact_sheet(kinds):
    tw, th = 450, 253
    tiles = []
    for suffix in ("", "_rear"):
        for k in kinds:
            path = os.path.join(PREVIEW_DIR, f"vehicle_{k}{suffix}.png")
            img = bpy.data.images.load(path)
            w, h = img.size
            buf = np.zeros(w * h * 4, dtype=np.float32)
            img.pixels.foreach_get(buf)
            a = buf.reshape(h, w, 4)
            a = a[: (h // th) * th, : (w // tw) * tw]
            a = a.reshape(th, a.shape[0] // th, tw, a.shape[1] // tw, 4).mean(axis=(1, 3))
            tiles.append(a)
            bpy.data.images.remove(img)
    cols, rows = 4, 4
    sheet = np.zeros((rows * th, cols * tw, 4), dtype=np.float32)
    sheet[..., 3] = 1
    sheet[..., :3] = 0.19
    n = len(kinds)
    for ti, t in enumerate(tiles):
        row_group = ti // n
        k = ti % n
        r = row_group * 2 + k // cols
        c = k % cols
        y0 = sheet.shape[0] - (r + 1) * th
        sheet[y0:y0 + th, c * tw:(c + 1) * tw] = t
    out = bpy.data.images.new("sheet", sheet.shape[1], sheet.shape[0], alpha=False)
    out.pixels.foreach_set(sheet.ravel())
    out.filepath_raw = SHEET_PATH
    out.file_format = "PNG"
    out.save()
    print("Wrote", SHEET_PATH)


def cleanup_scene():
    sc = bpy.context.scene
    sc.world = None
    sc.camera = None
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.cameras, bpy.data.lights, bpy.data.worlds):
        for d in list(coll):
            if d.users == 0:
                coll.remove(d)


def tints():
    lin = lambda h: hex_lin(h)
    return {
        "sedan": [lin("#1f3a66")] * 2, "taxi": [lin("#f0b90b")] * 2, "police": [lin("#eef0f2")] * 2,
        "suv": [lin("#3b3f46")] * 2, "humvee": [(1, 1, 1)] * 2, "van": [lin("#e8e8e8")] * 2,
        "truck": [lin("#d9d9d4"), lin("#7a1d1d")], "bus": [lin("#e6e8ea")] * 2,
    }


def round_lights(lights):
    out = {}
    for k, v in lights.items():
        out[k] = [[[round(float(c), 4) for c in p] for p in q] if k in ("head", "tail") else [round(float(c), 4) for c in q] for q in v]
    return out


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    t0 = time.time()
    util, ymax = pack_atlas()
    paint_all()
    A, N, O = compose_atlas()
    print(f"atlas: {util * 100:.0f}% of {ATLAS}^2 used, shelves reach y={ymax}", flush=True)
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    pngs = {}
    for nm, arr in (("albedo", A), ("normal", N), ("orm", O)):
        pngs[nm] = png_bytes(arr)
        with open(os.path.join(PREVIEW_DIR, f"vehicle_atlas_{nm}.png"), "wb") as f:
            f.write(pngs[nm])
        print(f"  atlas {nm}: {len(pngs[nm]) // 1024} KB png", flush=True)
    make_blender_images(A, N, O)
    results = {}
    TT = tints()
    kinds = [k for k in ORDER if k in BUILDERS and (not ONLY or k in ONLY)]
    for kind in kinds:
        t1 = time.time()
        try:
            m = Mesh()
            lights = BUILDERS[kind](m)
            ob, info = build_asset(m, TT[kind])
            lo, hi = info["bbox"]
            print(f"{kind}: {info['verts']} verts, {info['tris']} tris, {len(info['b64']) // 1024} KB b64, "
                  f"x[{lo[0]:.2f},{hi[0]:.2f}] y[{lo[1]:.2f},{hi[1]:.2f}] z[{lo[2]:.2f},{hi[2]:.2f}]", flush=True)
            if info["tris"] > BUDGET[kind]:
                print(f"  WARNING {kind} over budget {info['tris']} > {BUDGET[kind]}", flush=True)
            if not NO_PREVIEW:
                try:
                    render_previews(kind, info)
                except Exception:
                    traceback.print_exc()
            results[kind] = (info, lights)
        except Exception:
            traceback.print_exc()
        finally:
            cleanup_scene()
        print(f"  ({time.time() - t1:.1f}s)", flush=True)
    if ONLY:
        print("Subset build: asset file not written.")
        return
    lines = [
        f"// Generated by tools/blender/build_vehicles.py with Blender {bpy.app.version_string}. Do not edit by hand.",
        "// Atlas: albedo (sRGB), normal (tangent), orm (R paint mask, G roughness, B metalness); v = 0 at the top row.",
        "export const VEHICLE_ATLAS = {",
    ]
    for nm in ("albedo", "normal", "orm"):
        lines.append(f"  {nm}: 'data:image/png;base64,{base64.b64encode(pngs[nm]).decode('ascii')}',")
    lines += ["};", "export const VEHICLE_ASSETS = {"]
    for kind in ORDER:
        info, lights = results[kind]
        meta = json.dumps({"verts": info["verts"], "tris": info["tris"], "scale": SCALE}, separators=(",", ":"))
        ls = json.dumps(round_lights(lights), separators=(",", ":"))
        lines.append(f"  {kind}: {{ meta: {meta}, lights: {ls}, mesh: '{info['b64']}' }},")
    lines += ["};", ""]
    with open(OUT_JS, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"Wrote {OUT_JS} ({os.path.getsize(OUT_JS) // 1024} KB) in {time.time() - t0:.0f}s")
    if not NO_PREVIEW:
        try:
            contact_sheet(ORDER)
        except Exception:
            traceback.print_exc()


if __name__ == "__main__":
    main()
