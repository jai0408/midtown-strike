"""Builds the Cedar Lodge vegetation: pine x2, spruce, birch x2, bush x2, fern and a grass tuft.

    /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/build_foliage.py

Everything is procedural (no downloaded assets):
  * Two baked atlases, painted here with a small numpy stroke painter and saved as JPEG:
      bark  1024x1024 : colour + normal. Left half = conifer bark tile, right half = birch bark
                        tile (both tile vertically; each trunk segment maps v 0..1 once).
      leaf  1024x1024 : colour + alpha + normal, 4x4 cells of 256 px (see CELLS below).
    Alpha ships as its own greyscale JPEG so three.js can rebuild an RGBA texture for alphaTest.
  * Trees have a real trunk, branch whorls (conifers) or ascending limbs and twigs (birch).
    LOD0 <= 2500 triangles, LOD1 150..300 (layered skirts / crossed blob cards).
  * Vertex data: position, normal (bent up / spherical for soft canopy light), uv, baked AO
    (darker inner canopy) and a wind weight (0 trunk base .. 1 branch tips).
  * Output: src/world/foliage_asset.js (base64) and a Cycles review sheet docs/sheet_foliage.png.

Environment switches:  NO_PREVIEW=1 (skip the render)  SAMPLES=32  KEEP_TMP=1
"""
import base64
import json
import math
import os
import struct
import tempfile
import time

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT_JS = os.path.join(ROOT, "src", "world", "foliage_asset.js")
SHEET_PATH = os.path.join(ROOT, "docs", "sheet_foliage.png")
TMP = os.environ.get("FOLIAGE_TMP") or tempfile.mkdtemp(prefix="foliage_")
NO_PREVIEW = bool(os.environ.get("NO_PREVIEW"))
SAMPLES = int(os.environ.get("SAMPLES", "32"))
JPEG_Q = {"bark": 80, "barkN": 76, "leaf": 80, "leafA": 90, "leafN": 74, "imp": 82, "impA": 90}

ATLAS = 1024  # bark atlas and normal maps
LEAF = 2048  # leaf colour + alpha atlas (cells of CELL px)
CELL = 512
SS = 2  # painter supersampling
UP = np.array([0.0, 1.0, 0.0])

# leaf atlas cells (index = col + 4 * row, row 0 at the BOTTOM of the image / v = 0)
CELLS = {
    "pine_a": 0, "pine_b": 1, "spruce_a": 2, "spruce_b": 3,
    "birch_dense": 4, "birch_sparse": 5, "bush_a": 6, "bush_b": 7,
    "fern": 8, "grass_a": 9, "grass_b": 10, "spruce_skirt": 11,
    "birch_blob": 12, "bush_blob": 13, "grass_c": 14, "pine_skirt": 15,
}
LOG = lambda *a: print(*a, flush=True)


# ----------------------------------------------------------------------------------------------
# small math
# ----------------------------------------------------------------------------------------------
def nrm(v):
    v = np.asarray(v, dtype=np.float64)
    l = float(np.linalg.norm(v))
    return v / l if l > 1e-9 else UP.copy()


def smooth(x, a, b):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def rot_about(v, axis, ang):
    axis = nrm(axis)
    c, s = math.cos(ang), math.sin(ang)
    return v * c + np.cross(axis, v) * s + axis * np.dot(axis, v) * (1 - c)


def lerp(a, b, t):
    return np.asarray(a, dtype=np.float64) * (1 - t) + np.asarray(b, dtype=np.float64) * t


def gblur(img, sigma):
    """Periodic gaussian blur via FFT (img is HxW or HxWxC)."""
    if img.ndim == 3:
        return np.stack([gblur(img[..., k], sigma) for k in range(img.shape[2])], axis=-1)
    h, w = img.shape
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.rfftfreq(w)[None, :]
    g = np.exp(-2 * (math.pi ** 2) * (sigma ** 2) * (fx ** 2 + fy ** 2))
    return np.fft.irfft2(np.fft.rfft2(img) * g, s=(h, w)).astype(np.float32)


def pnoise(w, h, sx, sy, rng):
    """Periodic (tileable) anisotropic noise, zero mean / unit variance."""
    n = rng.standard_normal((h, w))
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.rfftfreq(w)[None, :]
    g = np.exp(-2 * (math.pi ** 2) * ((sx * fx) ** 2 + (sy * fy) ** 2))
    o = np.fft.irfft2(np.fft.rfft2(n) * g, s=(h, w))
    return ((o - o.mean()) / (o.std() + 1e-9)).astype(np.float32)


def normal_from_height(hgt, k, wrap=True):
    """Tangent-space (OpenGL, +Y = +v) normal map from a bottom-up height array."""
    if wrap:
        gx = (np.roll(hgt, -1, 1) - np.roll(hgt, 1, 1)) * 0.5
        gy = (np.roll(hgt, -1, 0) - np.roll(hgt, 1, 0)) * 0.5
    else:
        gy, gx = np.gradient(hgt)
    n = np.stack([-gx * k, -gy * k, np.ones_like(hgt)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


# ----------------------------------------------------------------------------------------------
# stroke painter (u right, v up, both 0..1 in a cell)
# ----------------------------------------------------------------------------------------------
class Cell:
    def __init__(self, n=CELL, ss=SS):
        self.n, self.ss, self.N = n, ss, n * ss
        self.P = np.zeros((self.N, self.N, 3), np.float32)  # premultiplied colour
        self.A = np.zeros((self.N, self.N), np.float32)
        self.H = np.zeros((self.N, self.N), np.float32)

    def _comp(self, sl, cov, col, hgt):
        self.P[sl] = self.P[sl] * (1 - cov[..., None]) + col * cov[..., None]
        self.A[sl] = self.A[sl] * (1 - cov) + cov
        self.H[sl] = np.maximum(self.H[sl] * (1 - 0.0), cov * hgt)

    def seg(self, a, b, w0, w1, c0, c1, hg=1.0):
        """Capsule from a to b, diameters w0..w1 and colours c0..c1 (cell units)."""
        N = self.N
        ax, ay, bx, by = a[0] * N, a[1] * N, b[0] * N, b[1] * N
        pad = max(w0, w1) * N * 0.5 + 2
        x0, x1 = int(max(0, min(ax, bx) - pad)), int(min(N, max(ax, bx) + pad + 1))
        y0, y1 = int(max(0, min(ay, by) - pad)), int(min(N, max(ay, by) + pad + 1))
        if x1 <= x0 or y1 <= y0:
            return
        ys, xs = np.mgrid[y0:y1, x0:x1]
        px, py = xs + 0.5, ys + 0.5
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy + 1e-9
        t = np.clip(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1)
        d = np.hypot(px - (ax + t * dx), py - (ay + t * dy))
        w = np.maximum((w0 + (w1 - w0) * t) * N * 0.5, 0.25)
        cov = np.clip(w - d + 0.5, 0, 1).astype(np.float32)
        if not cov.any():
            return
        col = np.asarray(c0, np.float32) + (np.asarray(c1, np.float32) - np.asarray(c0, np.float32)) * t[..., None]
        sl = (slice(y0, y1), slice(x0, x1))
        prof = np.clip(1 - (d / w) ** 2, 0, 1) * hg
        self.P[sl] = self.P[sl] * (1 - cov[..., None]) + col * cov[..., None]
        self.A[sl] = self.A[sl] * (1 - cov) + cov
        self.H[sl] = np.maximum(self.H[sl], cov * prof)

    def segw(self, a, b, *args, **kw):
        for o in (-1, 0, 1):
            self.seg((a[0] + o, a[1]), (b[0] + o, b[1]), *args, **kw)

    def leaf(self, base, ang, L, W, c0, c1, serr=0.0, rib=0.18, hg=1.0, wrap=False):
        """Pointed ovate leaf from `base`, direction `ang` (rad from +u), length L, width W."""
        for off in ((-1, 0, 1) if wrap else (0,)):
            self._leaf((base[0] + off, base[1]), ang, L, W, c0, c1, serr, rib, hg)

    def _leaf(self, base, ang, L, W, c0, c1, serr, rib, hg):
        N = self.N
        bx, by, Lp, Wp = base[0] * N, base[1] * N, L * N, W * N
        ca, sa = math.cos(ang), math.sin(ang)
        ex, ey = bx + ca * Lp, by + sa * Lp
        pad = Wp * 0.6 + 2
        x0, x1 = int(max(0, min(bx, ex) - pad)), int(min(N, max(bx, ex) + pad + 1))
        y0, y1 = int(max(0, min(by, ey) - pad)), int(min(N, max(by, ey) + pad + 1))
        if x1 <= x0 or y1 <= y0:
            return
        ys, xs = np.mgrid[y0:y1, x0:x1]
        rx, ry = xs + 0.5 - bx, ys + 0.5 - by
        t = (rx * ca + ry * sa) / Lp
        s = (-rx * sa + ry * ca) / (Wp * 0.5)
        tt = np.clip(t, 0, 1)
        hw = np.sin(np.pi * tt ** 0.72) ** 0.75
        if serr:
            hw = hw * (1 + serr * np.sin(tt * Lp * 0.55))
        cov = np.clip((hw - np.abs(s)) * Wp * 0.5 + 0.5, 0, 1) * ((t > -0.01) & (t < 1.0))
        cov = cov.astype(np.float32)
        if not cov.any():
            return
        col = np.asarray(c0, np.float32) + (np.asarray(c1, np.float32) - np.asarray(c0, np.float32)) * tt[..., None]
        vein = np.clip(1 - np.abs(s) * Wp * 0.5 / 1.1, 0, 1) * (1 - tt) ** 0.3
        col = col * (1 - 0.10 * np.sign(s)[..., None] * 0.5) + (vein[..., None] * rib * 0.35)
        sl = (slice(y0, y1), slice(x0, x1))
        self.P[sl] = self.P[sl] * (1 - cov[..., None]) + col * cov[..., None]
        self.A[sl] = self.A[sl] * (1 - cov) + cov
        self.H[sl] = np.maximum(self.H[sl], cov * (1 - 0.55 * np.abs(s)) * hg)

    def dab(self, c, r, col, hg=0.4):
        self.seg(c, c, r * 2, r * 2, col, col, hg)

    def done(self):
        n, ss = self.n, self.ss
        A = self.A.reshape(n, ss, n, ss).mean(axis=(1, 3))
        P = self.P.reshape(n, ss, n, ss, 3).mean(axis=(1, 3))
        H = self.H.reshape(n, ss, n, ss).mean(axis=(1, 3))
        rgb = P / np.maximum(A[..., None], 1e-4)
        return np.clip(rgb, 0, 1), np.clip(A, 0, 1), H


def jit(c, rng, amt=0.06):
    return np.clip(np.asarray(c) * (1 + rng.uniform(-amt, amt, 3)), 0, 1)


def poly(a, b, c, n=9):
    """Quadratic bezier points."""
    t = np.linspace(0, 1, n)[:, None]
    a, b, c = (np.asarray(x, np.float64) for x in (a, b, c))
    return (1 - t) ** 2 * a + 2 * (1 - t) * t * b + t ** 2 * c


def needle_twig(cl, rng, o, ang, length, nlen, cdark, clight, tw=0.007, dens=0.0105, spread=1.12, wrap=False):
    """A twig with paired needles (spruce / fir style)."""
    sg = cl.segw if wrap else cl.seg
    d = np.array([math.cos(ang), math.sin(ang)])
    e = np.asarray(o) + d * length
    sg(o, e, tw, tw * 0.45, (0.22, 0.15, 0.09), (0.18, 0.13, 0.08), 0.5)
    n = max(2, int(length / dens))
    for i in range(n):
        s = (i + rng.uniform(0, 1)) / n
        base = np.asarray(o) + d * s * length
        env = 0.35 + 0.65 * math.sin(math.pi * min(1, s * 0.85 + 0.12)) ** 0.8
        for side in (-1, 1):
            a2 = ang + side * spread * rng.uniform(0.82, 1.15) - side * 0.3
            ln = nlen * rng.uniform(0.7, 1.1) * env
            t = rng.uniform(0.25, 1.0) * (0.55 + 0.45 * s)
            col = lerp(cdark, clight, t)
            sg(base, base + np.array([math.cos(a2), math.sin(a2)]) * ln, 0.0085, 0.0025, jit(col, rng) * 0.85, jit(col, rng) * 1.12, 0.6)


def spruce_spray(cl, rng, o, ang, length, bend, nlen, cdark, clight, shoots, shoot_len, wrap=False):
    """Main twig (curved) with many needle-carrying side shoots: a spruce / fir branchlet."""
    pts = poly(o, np.asarray(o) + np.array([math.cos(ang), math.sin(ang)]) * length * 0.55,
               np.asarray(o) + np.array([math.cos(ang + bend), math.sin(ang + bend)]) * length * 1.0 + np.array([math.cos(ang), math.sin(ang)]) * length * 0.2, 12)
    sg = cl.segw if wrap else cl.seg
    for i in range(len(pts) - 1):
        sg(pts[i], pts[i + 1], 0.01, 0.006, (0.22, 0.15, 0.09), (0.2, 0.14, 0.09), 0.6)
    for k in range(shoots):
        s = 0.1 + 0.9 * (k + rng.uniform(0, 0.8)) / shoots
        i = min(len(pts) - 2, int(s * (len(pts) - 1)))
        tang = pts[i + 1] - pts[i]
        ta = math.atan2(tang[1], tang[0])
        side = 1 if k % 2 == 0 else -1
        sa = ta + side * rng.uniform(0.85, 1.15)
        sl = shoot_len * (0.3 + 0.7 * math.sin(math.pi * min(1, s * 0.9 + 0.08)) ** 0.7) * rng.uniform(0.8, 1.15)
        needle_twig(cl, rng, pts[i] + tang * (s * (len(pts) - 1) - i), sa, sl, nlen, cdark, clight, wrap=wrap)
    # terminal shoot
    needle_twig(cl, rng, pts[-2], math.atan2(*(pts[-1] - pts[-2])[::-1]), shoot_len * 0.5, nlen, cdark, clight, wrap=wrap)


def needle_tuft(cl, rng, p, ang, n, ln, cdark, clight, fan=0.62):
    for _ in range(n):
        a2 = ang + rng.uniform(-fan, fan)
        l2 = ln * rng.uniform(0.7, 1.12)
        t = rng.uniform(0.15, 1.0)
        col = lerp(cdark, clight, t)
        cl.seg(p, np.asarray(p) + np.array([math.cos(a2), math.sin(a2)]) * l2, 0.0105, 0.0025, jit(col, rng) * 0.8, jit(col, rng) * 1.15, 0.6)


def paint_pine(cl, rng, variant):
    cd = (0.05, 0.15, 0.09) if variant == 0 else (0.06, 0.17, 0.1)
    cb = (0.16, 0.33, 0.2) if variant == 0 else (0.2, 0.37, 0.22)
    drift = 0.07 if variant == 0 else -0.09
    pts = poly((0.5, 0.01), (0.5 + drift * 0.5, 0.5), (0.5 + drift, 0.9), 14)
    for i in range(len(pts) - 1):
        cl.seg(pts[i], pts[i + 1], 0.016, 0.01, (0.3, 0.2, 0.12), (0.26, 0.18, 0.11), 0.7)
    nsh = 18
    for k in range(nsh):
        s = 0.2 + 0.78 * k / nsh
        i = min(len(pts) - 2, int(s * (len(pts) - 1)))
        base = pts[i]
        tang = pts[i + 1] - pts[i]
        ta = math.atan2(tang[1], tang[0])
        side = 1 if k % 2 == 0 else -1
        sa = ta + side * rng.uniform(0.55, 0.95)
        ln = (0.32 - 0.2 * s) * rng.uniform(0.85, 1.15)
        e = base + np.array([math.cos(sa), math.sin(sa)]) * ln
        cl.seg(base, e, 0.01, 0.006, (0.28, 0.19, 0.11), (0.24, 0.17, 0.1), 0.6)
        needle_tuft(cl, rng, e, sa, 34, 0.17 - 0.05 * s, cd, cb)
        m = base + (e - base) * 0.55
        needle_tuft(cl, rng, m, sa + side * 0.35, 20, 0.12, cd, cb, 0.75)
        needle_tuft(cl, rng, base, sa - side * 0.5, 14, 0.1, cd, cb, 0.8)
    top = pts[-1]
    needle_tuft(cl, rng, top, math.atan2(*(pts[-1] - pts[-3])[::-1]), 40, 0.17, cd, cb, 0.8)
    needle_tuft(cl, rng, pts[len(pts) // 2], math.pi / 2 + 0.4 * (1 if variant == 0 else -1), 10, 0.11, cd, cb, 0.8)


def paint_spruce(cl, rng, variant):
    cd = (0.055, 0.16, 0.085)
    cb = (0.15, 0.32, 0.14) if variant == 0 else (0.2, 0.38, 0.14)
    bend = 0.35 if variant == 0 else -0.55
    spruce_spray(cl, rng, (0.5, 0.0), math.pi / 2 - 0.12 * np.sign(bend), 0.92, bend, 0.062, cd, cb, 30, 0.34)
    if variant == 1:  # fresh light-green growth tips
        for _ in range(26):
            p = (rng.uniform(0.3, 0.7), rng.uniform(0.45, 0.95))
            needle_tuft(cl, rng, p, rng.uniform(0.3, 2.8), 6, 0.05, (0.3, 0.46, 0.16), (0.5, 0.64, 0.22), 1.0)


def paint_skirt(cl, rng, pine):
    """Horizontally tileable conifer skirt (top opaque, ragged hanging bottom) for LOD1 cones."""
    cd = (0.06, 0.17, 0.085) if not pine else (0.05, 0.16, 0.1)
    cb = (0.16, 0.33, 0.14) if not pine else (0.17, 0.34, 0.21)
    for i in range(34):  # solid top band
        x = rng.uniform(0, 1)
        cl.segw((x, 0.97), (x + rng.uniform(-0.04, 0.04), rng.uniform(0.5, 0.7)), 0.12, 0.1, jit(cd, rng, 0.1), jit(cd, rng, 0.1) * 1.1, 0.3)
    for i in range(46):
        x = rng.uniform(0, 1)
        y = rng.uniform(0.62, 0.97)
        ang = -math.pi / 2 + rng.uniform(-0.35, 0.35)
        ln = rng.uniform(0.28, 0.6) * (1.0 if i % 3 else 0.8)
        y0 = rng.uniform(0.62, 0.99) if i % 2 else y
        if pine:
            e = np.array([x, y0]) + np.array([math.cos(ang), math.sin(ang)]) * ln
            cl.segw((x, y0), e, 0.01, 0.006, (0.25, 0.17, 0.1), (0.2, 0.15, 0.09), 0.5)
            for w in (0.55, 1.0):
                p = np.array([x, y0]) + (e - np.array([x, y0])) * w
                for o in (-1, 0, 1):
                    needle_tuft(cl, rng, (p[0] + o, p[1]), ang, 10, 0.12, cd, cb, 0.8)
        else:
            needle_twig(cl, rng, (x, y0), ang, ln, 0.07, cd, cb, wrap=True)


def paint_birch(cl, rng, kind):
    """kind: 'dense' (cell 4), 'sparse' (cell 5, hanging twig), 'blob' (LOD1 canopy blob)."""
    def leafcol():
        t = rng.uniform(0, 1)
        y = rng.uniform(0, 1) ** 3 * 0.7  # a few yellowing leaves
        c0 = lerp(lerp((0.2, 0.3, 0.09), (0.33, 0.45, 0.13), t), (0.5, 0.48, 0.14), y)
        c1 = lerp(lerp((0.28, 0.4, 0.12), (0.45, 0.55, 0.18), t), (0.62, 0.6, 0.2), y)
        return jit(c0 * 1.18, rng, 0.08), jit(c1 * 1.18, rng, 0.08)
    if kind == "blob":
        for _ in range(26):
            a = rng.uniform(0, 2 * math.pi); r = rng.uniform(0, 0.2)
            cl.dab((0.5 + math.cos(a) * r, 0.5 + math.sin(a) * r), rng.uniform(0.14, 0.2), jit((0.13, 0.27, 0.06), rng, 0.1), 0.3)
        for i in range(520):
            a = rng.uniform(0, 2 * math.pi)
            r = 0.46 * math.sqrt(rng.uniform(0.05, 1.0))
            b = (0.5 + math.cos(a) * r * 0.6, 0.5 + math.sin(a) * r * 0.6)
            c0, c1 = leafcol()
            shade = 0.62 + 0.5 * smooth(r / 0.46, 0.1, 1.0)
            cl.leaf(b, a + rng.normal(0, 0.5), 0.07, 0.05, c0 * shade, c1 * shade, 0.08)
        return
    if kind == "dense":
        tw = [poly((0.5, 0.0), (0.47 + rng.uniform(-0.1, 0.1), 0.35), (0.5 + rng.uniform(-0.25, 0.25), 0.66))]
        for s in range(6):
            o = tw[0][int(rng.uniform(3, 8))]
            a = math.pi / 2 + (1 if s % 2 else -1) * rng.uniform(0.5, 1.1)
            tw.append(poly(o, o + np.array([math.cos(a), math.sin(a)]) * 0.14, o + np.array([math.cos(a), math.sin(a)]) * rng.uniform(0.25, 0.34)))
        nleaf = 170
    else:  # short drooping leafy spray
        tw = [poly((0.5, 0.0), (0.5, 0.5), (0.34 + rng.uniform(-0.05, 0.1), 0.78)), poly((0.5, 0.2), (0.62, 0.45), (0.7, 0.55))]
        nleaf = 75
    for t in tw:
        for i in range(len(t) - 1):
            cl.seg(t[i], t[i + 1], 0.011, 0.007, (0.3, 0.27, 0.22), (0.26, 0.2, 0.15), 0.5)
    for i in range(nleaf):
        t = tw[i % len(tw)] if kind == "dense" else tw[0]
        k = rng.uniform(0.15 if kind == "dense" else 0.2, 1.0)
        j = min(len(t) - 2, int(k * (len(t) - 1)))
        tang = t[j + 1] - t[j]
        ta = math.atan2(tang[1], tang[0])
        side = 1 if i % 2 else -1
        la = ta + side * rng.uniform(0.35, 1.2)
        c0, c1 = leafcol()
        sz = rng.uniform(0.9, 1.15) * (0.072 if kind == "dense" else 0.08)
        cl.leaf(t[j], la, sz, sz * 0.68, c0, c1, 0.1)
    for t in tw:  # terminal leaves
        c0, c1 = leafcol()
        cl.leaf(t[-1], math.atan2(*(t[-1] - t[-2])[::-1]), 0.09, 0.06, c0, c1, 0.1)


def paint_bush(cl, rng, kind):
    """kind 0: broad glossy leaves (laurel / privet), 1: small lanceolate leaves, 2: LOD1 blob."""
    if kind == 2:
        for _ in range(30):
            a = rng.uniform(0, 2 * math.pi); r = rng.uniform(0, 0.22)
            cl.dab((0.5 + math.cos(a) * r, 0.5 + math.sin(a) * r), rng.uniform(0.14, 0.2), jit((0.09, 0.2, 0.06), rng, 0.1), 0.3)
        for i in range(170):
            a = rng.uniform(0, 2 * math.pi); r = 0.46 * math.sqrt(rng.uniform(0.04, 1.0))
            t = rng.uniform(0, 1)
            sh = 0.5 + 0.6 * smooth(r / 0.46, 0.1, 1.0)
            cl.leaf((0.5 + math.cos(a) * r * 0.62, 0.5 + math.sin(a) * r * 0.62), a + rng.normal(0, 0.6), 0.14, 0.08,
                    lerp((0.1, 0.27, 0.07), (0.18, 0.4, 0.1), t) * sh, lerp((0.14, 0.34, 0.08), (0.28, 0.5, 0.14), t) * sh, 0.0)
        return
    big = kind == 0
    stems = [poly((0.5 + rng.uniform(-0.04, 0.04), 0.0), (0.5 + x * 0.5, 0.4), (0.5 + x, 0.8)) for x in rng.uniform(-0.3, 0.3, 5)]
    for t in stems:
        for i in range(len(t) - 1):
            cl.seg(t[i], t[i + 1], 0.012, 0.007, (0.26, 0.19, 0.12), (0.22, 0.16, 0.1), 0.5)
    n = 44 if big else 105
    for i in range(n):
        t = stems[i % len(stems)]
        k = rng.uniform(0.18, 1.0)
        j = min(len(t) - 2, int(k * (len(t) - 1)))
        tang = t[j + 1] - t[j]
        ta = math.atan2(tang[1], tang[0])
        la = ta + (1 if i % 2 else -1) * rng.uniform(0.3, 1.25)
        s = rng.uniform(0, 1)
        if big:
            c0 = jit(lerp((0.09, 0.24, 0.07), (0.15, 0.34, 0.09), s), rng); c1 = jit(lerp((0.14, 0.32, 0.09), (0.26, 0.46, 0.14), s), rng)
            cl.leaf(t[j], la, rng.uniform(0.17, 0.23), rng.uniform(0.09, 0.12), c0, c1, 0.0, 0.25)
        else:
            c0 = jit(lerp((0.16, 0.36, 0.08), (0.28, 0.5, 0.1), s), rng); c1 = jit(lerp((0.26, 0.5, 0.12), (0.42, 0.62, 0.18), s), rng)
            cl.leaf(t[j], la, rng.uniform(0.11, 0.15), rng.uniform(0.04, 0.06), c0, c1, 0.0, 0.2)
    for t in stems:
        cl.leaf(t[-1], math.atan2(*(t[-1] - t[-2])[::-1]), 0.18 if big else 0.13, 0.1 if big else 0.055, (0.12, 0.3, 0.08), (0.24, 0.46, 0.13), 0.0)


def paint_fern(cl, rng):
    n = 30
    rach = poly((0.46, 0.0), (0.46, 0.5), (0.6, 0.97), 24)
    for i in range(len(rach) - 1):
        cl.seg(rach[i], rach[i + 1], 0.016 * (1 - i / 30), 0.012, (0.2, 0.32, 0.1), (0.17, 0.3, 0.09), 0.6)
    for k in range(n):
        s = 0.07 + 0.92 * k / n
        i = min(len(rach) - 2, int(s * (len(rach) - 1)))
        base = rach[i] + (rach[i + 1] - rach[i]) * (s * (len(rach) - 1) - i)
        tang = rach[i + 1] - rach[i]
        ta = math.atan2(tang[1], tang[0])
        ln = 0.215 * (1 - s ** 1.5) ** 0.75 * min(1.0, 0.45 + s * 4) + 0.02
        for side in (-1, 1):
            a2 = ta + side * (1.15 - 0.45 * s) * rng.uniform(0.92, 1.08)
            t = rng.uniform(0, 1) * 0.5 + s * 0.5
            cl.leaf(base, a2, ln, 0.05 + 0.02 * (1 - s), jit(lerp((0.07, 0.25, 0.06), (0.12, 0.33, 0.08), t), rng), jit(lerp((0.14, 0.38, 0.09), (0.27, 0.52, 0.15), t), rng), 0.18, 0.2)
    cl.leaf(rach[-1], math.atan2(*(rach[-1] - rach[-2])[::-1]), 0.08, 0.04, (0.12, 0.33, 0.08), (0.25, 0.5, 0.14), 0.1)


def paint_grass(cl, rng, nb, hmin, hmax, spread, dry, seeds=0, flowers=0):
    cols = [((0.1, 0.17, 0.07), (0.33, 0.43, 0.17)), ((0.11, 0.18, 0.07), (0.4, 0.46, 0.19)), ((0.09, 0.15, 0.06), (0.27, 0.37, 0.15))]
    for b in range(nb):
        x0 = 0.5 + rng.normal(0, spread)
        h = rng.uniform(hmin, hmax)
        lean = rng.normal(0, 0.1) + (x0 - 0.5) * 0.45
        curve = rng.normal(0, 0.1)
        p = poly((x0, -0.02), (x0 + lean * 0.3, h * 0.55), (x0 + lean + curve, h), 10)
        cb, ct = cols[b % 3]
        ct = lerp(ct, (0.6, 0.54, 0.25), dry * rng.uniform(0, 1))
        w0 = rng.uniform(0.02, 0.034)
        k = rng.uniform(0.9, 1.15)
        for i in range(len(p) - 1):
            t0, t1 = i / (len(p) - 1), (i + 1) / (len(p) - 1)
            cl.seg(p[i], p[i + 1], w0 * (1 - t0 * 0.92), w0 * (1 - t1 * 0.92), np.clip(lerp(cb, ct, t0) * k, 0, 1), np.clip(lerp(cb, ct, t1) * k, 0, 1), 0.7)
    for s in range(seeds):
        x0 = 0.5 + rng.normal(0, spread)
        top = (x0 + rng.normal(0, 0.05), rng.uniform(0.7, 0.93))
        cl.seg((x0, -0.02), top, 0.008, 0.006, (0.3, 0.38, 0.12), (0.5, 0.5, 0.22), 0.5)
        cl.leaf(top, math.pi / 2 + rng.normal(0, 0.2), 0.1, 0.03, (0.42, 0.4, 0.17), (0.6, 0.52, 0.24), 0.0)


def paint_flowers(cl, rng, n):
    cols = [(0.92, 0.92, 0.86), (0.9, 0.78, 0.22), (0.62, 0.5, 0.78), (0.88, 0.88, 0.8)]
    for k in range(n):
        x0 = 0.5 + rng.normal(0, 0.2)
        top = (x0 + rng.normal(0, 0.05), rng.uniform(0.38, 0.7))
        cl.seg((x0, -0.02), top, 0.008, 0.006, (0.15, 0.25, 0.08), (0.25, 0.36, 0.12), 0.5)
        col = cols[k % len(cols)]
        for q in range(5):
            cl.leaf(top, q * 1.2566 + rng.uniform(0, 0.3), 0.04, 0.026, col, np.clip(np.asarray(col) * 0.95, 0, 1), 0.0)
        cl.dab(top, 0.011, (0.85, 0.65, 0.1), 0.5)


def paint_leaf_atlas(rng):
    """Returns colour rgb (A,A,3), alpha (A,A), normal (A,A,3), all bottom-up."""
    cells = {}
    t0 = time.time()
    c = Cell(); paint_pine(c, rng, 0); cells["pine_a"] = c.done()
    c = Cell(); paint_pine(c, rng, 1); cells["pine_b"] = c.done()
    c = Cell(); paint_spruce(c, rng, 0); cells["spruce_a"] = c.done()
    c = Cell(); paint_spruce(c, rng, 1); cells["spruce_b"] = c.done()
    LOG("  conifer cells %.1fs" % (time.time() - t0))
    c = Cell(); paint_birch(c, rng, "dense"); cells["birch_dense"] = c.done()
    c = Cell(); paint_birch(c, rng, "droop"); cells["birch_sparse"] = c.done()
    c = Cell(); paint_bush(c, rng, 0); cells["bush_a"] = c.done()
    c = Cell(); paint_bush(c, rng, 1); cells["bush_b"] = c.done()
    c = Cell(); paint_fern(c, rng); cells["fern"] = c.done()
    c = Cell(); paint_grass(c, rng, 30, 0.55, 0.97, 0.16, 0.1, seeds=2); cells["grass_a"] = c.done()
    c = Cell(); paint_grass(c, rng, 22, 0.5, 0.95, 0.2, 0.55, seeds=5); cells["grass_b"] = c.done()
    c = Cell(); paint_grass(c, rng, 34, 0.3, 0.6, 0.2, 0.2); paint_flowers(c, rng, 8); cells["grass_c"] = c.done()
    LOG("  broadleaf/grass cells %.1fs" % (time.time() - t0))
    c = Cell(); paint_skirt(c, rng, False); cells["spruce_skirt"] = c.done()
    c = Cell(); paint_skirt(c, rng, True); cells["pine_skirt"] = c.done()
    c = Cell(); paint_birch(c, rng, "blob"); cells["birch_blob"] = c.done()
    c = Cell(); paint_bush(c, rng, 2); cells["bush_blob"] = c.done()
    LOG("  all cells %.1fs" % (time.time() - t0))
    rgb = np.zeros((LEAF, LEAF, 3), np.float32)
    alp = np.zeros((LEAF, LEAF), np.float32)
    hgt = np.zeros((LEAF, LEAF), np.float32)
    for name, k in CELLS.items():
        r, a, h = cells[name]
        cx, cy = (k % 4) * CELL, (k // 4) * CELL
        rgb[cy:cy + CELL, cx:cx + CELL] = r
        alp[cy:cy + CELL, cx:cx + CELL] = a
        hgt[cy:cy + CELL, cx:cx + CELL] = h
    # transparent texels carry the cell's mean leaf colour (no dark / light halos when filtered)
    out = rgb.copy()
    for name, k in CELLS.items():
        cx, cy = (k % 4) * CELL, (k // 4) * CELL
        sl = (slice(cy, cy + CELL), slice(cx, cx + CELL))
        a_, r_ = alp[sl], rgb[sl]
        mean = (r_ * a_[..., None]).sum(axis=(0, 1)) / max(float(a_.sum()), 1.0)
        out[sl] = a_[..., None] * r_ + (1 - a_[..., None]) * mean
    alp = np.clip((alp - 0.5) * 1.35 + 0.5, 0, 1)  # slightly crisper edges for alphaTest
    nor = normal_from_height(gblur(hgt, 1.2), 7.0, wrap=False)
    nor[alp < 0.02] = (0.5, 0.5, 1.0)
    nor = nor.reshape(ATLAS, 2, ATLAS, 2, 3).mean(axis=(1, 3))  # normals ship at 1024
    nor /= np.maximum(np.linalg.norm(nor * 2 - 1, axis=-1, keepdims=True), 1e-4) * 0 + 1
    return out, alp, nor


def paint_bark_atlas(rng):
    """Left tile (u 0..0.5) conifer bark, right tile (0.5..1) birch bark; both W=512 x H=1024, periodic."""
    W, H = 512, 1024
    # --- conifer bark: deep vertical furrows broken into plates
    n1 = pnoise(W, H, 13, 85, rng)
    n2 = pnoise(W, H, 16, 20, rng)
    n3 = pnoise(W, H, 40, 70, rng)
    n4 = pnoise(W, H, 3, 4, rng)
    valley = np.exp(-(n1 / 0.33) ** 2) * smooth(n2, -0.9, 0.35)  # broad furrows, broken up
    valley = np.clip(gblur(valley, 1.2) * 1.15, 0, 1)
    hp = 1 - valley + 0.10 * n4 + 0.12 * n3 + 0.12 * np.tanh(n1 * 2)
    t = np.clip(hp, 0, 1)[..., None]
    mot = (0.5 + 0.5 * np.tanh(n3))[..., None]
    plate = (0.88 + 0.16 * np.tanh(n1 * 1.6))[..., None]
    base = lerp((0.27, 0.19, 0.14), (0.46, 0.3, 0.2), mot) * plate
    col_p = lerp(np.array((0.055, 0.04, 0.032)), base, smooth(t, 0.05, 0.7))
    col_p = col_p * (0.92 + 0.1 * n4[..., None])
    nor_p = normal_from_height(gblur(hp * 6.0, 1.2), 1.5)
    # --- birch bark: white paper-like with dark horizontal lenticels / scars
    m1 = pnoise(W, H, 90, 60, rng)
    m2 = pnoise(W, H, 22, 1.8, rng)
    m3 = pnoise(W, H, 55, 6, rng)
    m4 = pnoise(W, H, 5, 5, rng)
    m5 = pnoise(W, H, 120, 3, rng)
    white = lerp((0.84, 0.82, 0.76), (0.94, 0.93, 0.89), (0.5 + 0.5 * np.tanh(m1))[..., None])
    white = white * (0.95 + 0.05 * m4[..., None])
    lent = smooth(m2, 1.6, 2.4)  # thin dark dashes
    scar = smooth(m3, 2.0, 2.7)  # big dark patches
    edge = smooth(m3, 1.5, 2.2) * (1 - scar)  # grey margin round scars
    peel = smooth(m5, 1.4, 2.2) * 0.35
    col_b = white * (1 - 0.34 * edge[..., None]) * (1 - 0.14 * peel[..., None])
    dark = np.clip(np.maximum(lent, scar), 0, 1)[..., None]
    col_b = lerp(col_b, np.array((0.05, 0.045, 0.04)), dark * 0.96)
    hb = 0.25 * m4 - 0.8 * dark[..., 0] + 0.4 * peel - 0.25 * lent
    nor_b = normal_from_height(gblur(hb * 3, 0.9), 1.7)
    col = np.concatenate([col_p, col_b], axis=1)
    nor = np.concatenate([nor_p, nor_b], axis=1)
    return np.clip(col, 0, 1).astype(np.float32), nor.astype(np.float32)


# ----------------------------------------------------------------------------------------------
# mesh builder
# ----------------------------------------------------------------------------------------------
class MB:
    def __init__(self):
        self.p, self.n, self.uv, self.ao, self.sw, self.i = [], [], [], [], [], []

    @property
    def nv(self):
        return len(self.p)

    @property
    def tris(self):
        return len(self.i) // 3

    def v(self, p, n, uv, ao, sw):
        self.p.append(np.asarray(p, np.float64)); self.n.append(nrm(n)); self.uv.append(uv)
        self.ao.append(float(np.clip(ao, 0, 1))); self.sw.append(float(np.clip(sw, 0, 1)))
        return self.nv - 1

    def fix_winding(self):
        """Make triangle winding agree with the vertex normals (for front-face-only bark)."""
        P = np.array(self.p); N = np.array(self.n)
        for t in range(0, len(self.i), 3):
            a, b, c = self.i[t:t + 3]
            fn = np.cross(P[b] - P[a], P[c] - P[a])
            if np.dot(fn, N[a] + N[b] + N[c]) < 0:
                self.i[t + 1], self.i[t + 2] = c, b


def cell_uv(k, inset=2.0 / LEAF):
    cx, cy = k % 4, k // 4
    return (cx / 4 + inset, cy / 4 + inset, (cx + 1) / 4 - inset, (cy + 1) / 4 - inset)


IMPW, IMPH, IMPT = 1024, 512, 256
IMP = {}


def imp_rect(tile, top=False):
    cx, cy = tile % 4, tile // 4
    e = 1.5 / IMPH
    if top:  # a flat canopy-top card samples the middle of the tile
        return (cx / 4 + 0.08, cy / 2 + 0.2, (cx + 1) / 4 - 0.08, (cy + 1) / 2 - 0.2)
    return (cx / 4 + e, cy / 2 + e, (cx + 1) / 4 - e, (cy + 1) / 2 - e)


def card(B, ctr, ux, vx, w, h, cell, ao_fn, nf, sw_fn, flip=False, vb=0.35, rect=None):
    """One leaf card. v axis `vx` runs base -> tip; bottom edge sits `vb*h` behind ctr."""
    u0, v0, u1, v1 = rect if rect else cell_uv(cell)
    if flip:
        u0, u1 = u1, u0
    ctr = np.asarray(ctr, np.float64)
    pts = [ctr - ux * w / 2 - vx * h * vb, ctr + ux * w / 2 - vx * h * vb, ctr + ux * w / 2 + vx * h * (1 - vb), ctr - ux * w / 2 + vx * h * (1 - vb)]
    uvs = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
    tip = [0, 0, 1, 1]
    ids = [B.v(p, nf(p), uv, ao_fn(p), sw_fn(p, tp)) for p, uv, tp in zip(pts, uvs, tip)]
    B.i += [ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]]


def tube(B, pts, radii, sides, rect, vs, ao_fn, sw_fn):
    """Tapered bark tube. rect = (u0, u1, v0, v1) atlas tile; vs = per-ring v in 0..1."""
    pts = [np.asarray(p, np.float64) for p in pts]
    u0, u1, vb0, vb1 = rect
    base = B.nv
    t0 = nrm(pts[1] - pts[0])
    n = nrm(np.cross(UP if abs(t0[1]) < 0.95 else np.array([1.0, 0, 0]), t0))
    for i, p in enumerate(pts):
        a, b = pts[max(0, i - 1)], pts[min(len(pts) - 1, i + 1)]
        t = nrm(b - a)
        n = n - t * np.dot(n, t)
        n = nrm(n) if np.linalg.norm(n) > 1e-6 else nrm(np.cross(UP, t))
        bb = np.cross(t, n)
        for s in range(sides + 1):
            an = s / sides * 2 * math.pi
            d = n * math.cos(an) + bb * math.sin(an)
            B.v(p + d * radii[i], d, (u0 + (u1 - u0) * s / sides, vb0 + (vb1 - vb0) * vs[i]), ao_fn(p), sw_fn(p, i / max(1, len(pts) - 1)))
    ring = sides + 1
    for i in range(len(pts) - 1):
        for s in range(sides):
            a = base + i * ring + s
            B.i += [a, a + ring, a + ring + 1, a, a + ring + 1, a + 1]


CONIFER_RECT = (0.004, 0.496, 0.003, 0.997)
BIRCH_RECT = (0.504, 0.996, 0.003, 0.997)


def trunk_tubes(B, spine, radius, H, seg_len, sides, rect, ao_fn, sw_fn, y0=0.0, y1=None):
    y1 = H if y1 is None else y1
    n = max(1, int(math.ceil((y1 - y0) / seg_len)))
    ys = np.linspace(y0, y1, n + 1)
    for k in range(n):
        pts = [spine(ys[k]), spine(ys[k + 1])]
        tube(B, pts, [radius(ys[k]), radius(ys[k + 1])], sides, rect, [0.0, 1.0], ao_fn, sw_fn)


def branch_curve(o, az, e_fn, L, M):
    """Polyline of a branch leaving `o` at azimuth az; e_fn(s) = elevation (rad) at s in 0..1."""
    pts = [np.asarray(o, np.float64)]
    for j in range(M):
        s = (j + 0.5) / M
        e = e_fn(s)
        d = np.array([math.cos(e) * math.cos(az), math.sin(e), math.cos(e) * math.sin(az)])
        pts.append(pts[-1] + d * L / M)
    return pts


def sample_curve(pts, s):
    """Position and tangent on a polyline at fraction s (by index)."""
    f = np.clip(s, 0, 1) * (len(pts) - 1)
    i = min(int(f), len(pts) - 2)
    t = nrm(pts[i + 1] - pts[i])
    return pts[i] + (pts[i + 1] - pts[i]) * (f - i), t


def side_of(t):
    s = np.cross(t, UP)
    return nrm(s) if np.linalg.norm(s) > 1e-4 else np.array([1.0, 0, 0])


# ----------------------------------------------------------------------------------------------
# models
# ----------------------------------------------------------------------------------------------
CONIFERS = {
    "pine0": dict(seed=11, H=15.0, r0=0.30, crown0=0.36, whorls=23, nb=(4.6, 3.2), L=4.4, prof="pine", cells=(CELLS["pine_a"], CELLS["pine_b"]),
                  stations=(0.45, 0.72, 1.0), clen=2.4, cwid=2.4, vang=0.75, lean=(0.5, 0.2), skirt=CELLS["pine_skirt"], tiers=8, tube_min=2.0, stubs=7, ymid=0.65),
    "pine1": dict(seed=29, H=19.0, r0=0.34, crown0=0.5, whorls=21, nb=(4.5, 3.2), L=4.9, prof="pine", cells=(CELLS["pine_b"], CELLS["pine_a"]),
                  stations=(0.4, 0.68, 0.95), clen=2.6, cwid=2.5, vang=0.8, lean=(-0.7, 0.5), skirt=CELLS["pine_skirt"], tiers=8, tube_min=2.0, stubs=8, ymid=0.74),
    "spruce0": dict(seed=47, H=16.0, r0=0.28, crown0=0.14, whorls=15, nb=(6.2, 3.2), L=3.5, prof="spruce", cells=(CELLS["spruce_a"], CELLS["spruce_b"]),
                    stations=(0.3, 0.55, 0.8, 1.0), clen=1.6, cwid=1.7, vang=0.62, lean=(0.2, -0.1), skirt=CELLS["spruce_skirt"], tiers=10, tube_min=1.3, stubs=0, ymid=0.5),
}


def build_conifer(name, lod):
    P = CONIFERS[name]
    rng = np.random.default_rng(P["seed"])
    H, r0 = P["H"], P["r0"]
    lx, lz = P["lean"]
    ph1, ph2 = rng.uniform(0, 6.28, 2)

    def spine(y):
        k = (y / H) ** 1.5
        w = min(1.0, y / 3.0) * 0.12
        return np.array([lx * k + w * math.sin(y * 0.37 + ph1), y, lz * k + w * math.sin(y * 0.29 + ph2)])

    def radius(y):
        t = y / H
        r = r0 * (1 - t) ** 0.85 * (1.15 if y < 1 else 1.0) + 0.02 * (1 - t)
        return max(0.016, r)

    ycs = P["crown0"] * H
    ytop = H * 0.965

    def prof(t):
        if P["prof"] == "spruce":
            return (1 - t) ** 0.85 * 0.92 + 0.08
        return 0.3 + 0.7 * (1 - t) ** 0.65

    def tcrown(y):
        return float(np.clip((y - ycs) / (ytop - ycs), 0, 1))

    def ao_fn(p):
        sp = spine(p[1])
        r = math.hypot(p[0] - sp[0], p[2] - sp[2])
        t = tcrown(p[1])
        R = max(0.7, P["L"] * prof(t) * 0.9)
        rn = float(smooth(r / R, 0.0, 1.0))
        a = 0.30 + 0.70 * rn ** 0.85
        a *= 0.8 + 0.2 * float(smooth(t, 0.0, 0.6))
        if p[1] < ycs:
            a = max(a, 0.55 + 0.45 * float(smooth(r, 0.0, 0.5))) if r > 0.4 else 0.55 + 0.45 * (1 - p[1] / max(ycs, 1e-3)) * 0.0 + 0.3 * (1 - p[1] / max(ycs, 1e-3))
        return min(1.0, a)

    ymid = P["ymid"] * H

    def nf(p):
        sp = spine(p[1])
        rad = np.array([p[0] - sp[0], (p[1] - ymid) * 0.07, p[2] - sp[2]])
        return nrm(nrm(rad) * 0.8 + UP * 0.62)

    def swl(p, tip):
        return 0.16 + 0.52 * (p[1] / H) ** 1.2 + 0.3 * tip

    def swb(p, t):
        return 0.4 * (p[1] / H) ** 2 + 0.25 * t * (p[1] / H)

    bark, leaf = MB(), MB()
    if lod == 1:
        trunk_tubes(bark, spine, radius, H, H / 3.0, 5, CONIFER_RECT, lambda p: 0.7, swb, 0.0, H * 0.97)
        bark.fix_winding()
        K = P["tiers"]
        sides = 8
        k0 = P["skirt"]
        u0, v0, u1, v1 = cell_uv(k0)
        for k in range(K):
            t = (k + 0.5) / K
            y = ycs + (ytop - ycs) * (t ** 0.95) - 0.2
            R = max(0.6, P["L"] * prof(t) * (0.95 if P["prof"] == "spruce" else 0.85) * rng.uniform(0.9, 1.1))
            hh = max(1.1, (ytop - ycs) / K * 2.1) * (1.15 if P["prof"] == "pine" else 1.0)
            ytopring = y + hh * 0.62
            rt = R * 0.22 if k < K - 1 else 0.03
            sp = spine(y)
            rings = [(ytopring, rt, 0.55 + 0.1 * t, 0.97), (y - hh * 0.38, R, 1.0, 0.04)]
            ids = []
            az0 = rng.uniform(0, 6.28)
            for (yy, rr, ao, vv) in rings:
                row = []
                for s in range(sides + 1):
                    a = az0 + s / sides * 2 * math.pi
                    d = np.array([math.cos(a), 0, math.sin(a)])
                    pos = np.array([sp[0], yy, sp[2]]) + d * rr
                    n = nrm(d * 0.7 + UP * 0.75)
                    uu = (u0 + (u1 - u0) * (s / sides))
                    row.append(leaf.v(pos, n, (uu, v0 + (v1 - v0) * vv), ao * (0.55 + 0.45 * float(smooth(t, 0, 0.5))) if vv > 0.5 else min(1.0, 0.45 + 0.6 * t * 0 + 0.55 * (1 - 0.0)) * (0.75 + 0.25 * t), swl(pos, 0.0 if vv > 0.5 else 1.0)))
                ids.append(row)
            for s in range(sides):
                a, b, c, d = ids[0][s], ids[0][s + 1], ids[1][s + 1], ids[1][s]
                leaf.i += [a, b, c, a, c, d]
        # leader cone
        sp = spine(ytop)
        row = [leaf.v(np.array([sp[0], H, sp[2]]), UP, ((u0 + u1) / 2, v1), 0.8, 1.0)]
        for s in range(sides + 1):
            a = s / sides * 2 * math.pi
            d = np.array([math.cos(a), 0, math.sin(a)])
            row.append(leaf.v(np.array([sp[0], ytop - 1.4, sp[2]]) + d * 0.7, nrm(d * 0.6 + UP), (u0 + (u1 - u0) * s / sides, v0 + (v1 - v0) * 0.4), 0.8, 0.9))
        for s in range(sides):
            leaf.i += [row[0], row[1 + s], row[2 + s]]
        return bark, leaf

    # ---- LOD0
    trunk_tubes(bark, spine, radius, H, 1.8, 7, CONIFER_RECT, ao_fn, swb, 0.0, H * 0.985)
    # dead stubs on the bare lower trunk (pines)
    for k in range(P["stubs"]):
        y = rng.uniform(0.12 * H, ycs)
        az = rng.uniform(0, 6.28)
        o = spine(y) + np.array([math.cos(az), 0, math.sin(az)]) * radius(y) * 0.6
        pts = branch_curve(o, az, lambda s: 0.1 - 0.15 * s, rng.uniform(0.4, 0.9), 1)
        tube(bark, pts, [0.045, 0.012], 3, CONIFER_RECT, [0.0, 0.3], ao_fn, swb)
    nw = P["whorls"]
    for w in range(nw):
        t = (w + 0.5) / nw
        y = ycs + (ytop - ycs) * t ** 0.9 + rng.uniform(-0.15, 0.15)
        nb = int(np.clip(round(P["nb"][0] + (P["nb"][1] - P["nb"][0]) * t + rng.uniform(-0.6, 0.6)), 2, 9))
        az0 = rng.uniform(0, 6.28)
        for k in range(nb):
            az = az0 + k * 2 * math.pi / nb + rng.normal(0, 0.28)
            L = P["L"] * prof(t) * rng.uniform(0.78, 1.15)
            if P["prof"] == "pine":
                L *= rng.uniform(0.65, 1.2)
            L = max(L, 0.7)
            if P["prof"] == "spruce":
                e0, droop, tipup = -0.12 + 0.6 * t, 0.5 * (1 - t) + 0.1, 0.4
            else:
                e0, droop, tipup = rng.normal(0.05, 0.22) + 0.35 * t, rng.uniform(0.2, 0.7), rng.uniform(0.3, 0.8)
            e_fn = lambda s, e0=e0, droop=droop, tipup=tipup: e0 - droop * s ** 1.2 + tipup * s ** 3
            M = 3 if L > 3.2 else 2
            o = spine(y) + np.array([math.cos(az), 0, math.sin(az)]) * radius(y) * 0.5
            pts = branch_curve(o, az, e_fn, L, M)
            if L > P["tube_min"]:
                rb = 0.022 + 0.026 * L
                tube(bark, pts, list(np.linspace(rb, 0.009, M + 1)), 3, CONIFER_RECT,
                     list(np.linspace(0, 0.35, M + 1)), ao_fn, swb)
            ns = len(P["stations"]) if L > 2.4 else max(2, len(P["stations"]) - 1)
            sts = P["stations"][-ns:]
            f = 0.55 + 0.45 * min(1.0, L / P["L"])
            for si, s in enumerate(sts):
                p, tg = sample_curve(pts, s)
                sd = side_of(tg)
                cell = P["cells"][(w + k + si) % 2]
                for sgn in (1, -1):
                    ang = sgn * P["vang"] * rng.uniform(0.8, 1.15)
                    ux = rot_about(sd, tg, ang)
                    vx = nrm(tg + UP * -0.12)
                    card(leaf, p + tg * 0.1, ux, vx, P["cwid"] * f * rng.uniform(0.9, 1.1), P["clen"] * f * rng.uniform(0.9, 1.1), cell,
                         ao_fn, nf, swl, flip=bool(rng.integers(0, 2)))
    # leader tuft
    sp = spine(H * 0.985)
    for a in (0.0, math.pi / 2, math.pi / 4, 3 * math.pi / 4):
        ux = np.array([math.cos(a), 0, math.sin(a)])
        card(leaf, np.array([sp[0], H * 0.9, sp[2]]), ux, UP, 1.1, H * 0.12 + 0.8, P["cells"][0], ao_fn, nf, swl, vb=0.3)
    bark.fix_winding()
    return bark, leaf


BIRCHES = {
    "birch0": dict(seed=61, H=10.5, r0=0.15, limbs=16, L=4.0, cs=1.15, lean=(0.5, 0.3), fork=False, cr=3.4),
    "birch1": dict(seed=73, H=9.0, r0=0.13, limbs=12, L=4.2, cs=1.2, lean=(-0.9, 0.5), fork=True, cr=3.6),
}


def build_birch(name, lod):
    P = BIRCHES[name]
    rng = np.random.default_rng(P["seed"])
    H, r0 = P["H"], P["r0"]
    lx, lz = P["lean"]
    ph1, ph2 = rng.uniform(0, 6.28, 2)

    def spine(y, off=(0, 0), k2=0.0):
        k = (y / H) ** 1.4
        return np.array([off[0] + lx * k + k2 * y + 0.22 * math.sin(y * 0.55 + ph1) * min(1, y / 2.5),
                         y, off[1] + lz * k + 0.22 * math.sin(y * 0.47 + ph2) * min(1, y / 2.5)])

    def radius(y, hh=None):
        hh = hh or H
        return max(0.014, r0 * (1 - y / hh) ** 0.8 * (1.12 if y < 0.8 else 1.0))

    cyc = 0.72 * H
    cr = P["cr"]

    def ao_fn(p):
        d = math.sqrt(((p[0] - lx * 0.6) / cr) ** 2 + ((p[1] - cyc) / (0.36 * H)) ** 2 + ((p[2] - lz * 0.6) / cr) ** 2)
        a = 0.56 + 0.44 * float(smooth(d, 0.1, 1.0)) ** 0.9
        if p[1] < 0.3 * H:
            a = max(a, 0.6 + 0.4 * (1 - p[1] / (0.3 * H)))
        return min(1.0, a)

    def nf(p):
        c = np.array([lx * 0.6, cyc, lz * 0.6])
        r = (np.asarray(p) - c) * np.array([1.0, 0.8, 1.0])
        return nrm(nrm(r) * 0.78 + UP * 0.5)

    def swl(p, tip):
        return 0.22 + 0.5 * (p[1] / H) + 0.28 * tip

    def swb(p, t):
        return 0.35 * (p[1] / H) ** 2 + 0.3 * t * (p[1] / H)

    bark, leaf = MB(), MB()
    stems = [(lambda y: spine(y), H, r0)]
    if P["fork"]:
        stems.append((lambda y: spine(y * 0.88 + 0.5, (0.1, 0.0), 0.0) + np.array([0.28 * y / 3.0 * min(1, y / 1.5) + 0.1 * y, -0.5 * y, 0.0]) * 0 + np.array([0.075 * y * y / 3.0, 0, 0.04 * y]), H * 0.88, r0 * 0.78))
    if lod == 1:
        trunk_tubes(bark, spine, radius, H, H / 3.0, 5, BIRCH_RECT, lambda p: 0.8, swb, 0.0, H * 0.9)
        bark.fix_winding()
        im = IMP[name]
        for (tile, az) in im["tiles"]:
            ux = np.cross(-np.array([math.cos(az), 0, math.sin(az)]), UP)
            card(leaf, im["c"], ux, UP, im["S"], im["S"], None, lambda p: 1.0, nf, swl, vb=0.5, rect=imp_rect(tile))
        return bark, leaf

    # ---- LOD0
    clusters = []  # (center, size)
    hangers = []
    for si, (sf, hh, rs) in enumerate(stems):
        n = max(2, int(math.ceil(hh * 0.985 / 1.5)))
        ys = np.linspace(0, hh * 0.985, n + 1)
        for kseg in range(n):
            tube(bark, [sf(ys[kseg]), sf(ys[kseg + 1])], [radius(ys[kseg], hh) * rs / r0, radius(ys[kseg + 1], hh) * rs / r0], 6, BIRCH_RECT, [0.0, 1.0], ao_fn, swb)
        nl = P["limbs"] if si == 0 else P["limbs"] - 3
        for l in range(nl):
            t = (l + 0.5) / nl
            y = hh * (0.3 + 0.62 * t) + rng.uniform(-0.2, 0.2)
            az = l * 2.39996 + si * 1.1 + rng.uniform(-0.25, 0.25)
            L = P["L"] * (1.0 - 0.45 * t) * rng.uniform(0.8, 1.15)
            e0 = math.radians(46 - 12 * t + rng.uniform(-6, 6))
            e_fn = lambda s, e0=e0: e0 + 0.45 * s - 1.05 * s ** 3
            o = sf(y) + np.array([math.cos(az), 0, math.sin(az)]) * radius(y, hh) * 0.5
            M = 3
            pts = branch_curve(o, az, e_fn, L, M)
            tube(bark, pts, list(np.linspace(0.02 + 0.012 * L, 0.01, M + 1)), 4 if L > 2.2 else 3, BIRCH_RECT, list(np.linspace(0, 0.4, M + 1)), ao_fn, swb)
            clusters.append((pts[-1] + UP * 0.1, rng.uniform(2.1, 2.8)))
            hangers.append(pts[-1])
            p, tg = sample_curve(pts, 0.72)
            clusters.append((p + UP * 0.25, rng.uniform(1.9, 2.5)))
            for sidx, s in enumerate((0.34, 0.52, 0.68)):
                p, tg = sample_curve(pts, s)
                a2 = az + (1 if sidx % 2 == 0 else -1) * rng.uniform(0.7, 1.2)
                el = math.radians(35 + rng.uniform(-10, 15))
                tl = L * rng.uniform(0.3, 0.42)
                tp = branch_curve(p, a2, lambda q, el=el: el + 0.3 * q - 0.6 * q * q, tl, 1)
                tube(bark, tp, [0.012, 0.006], 3, BIRCH_RECT, [0.0, 0.3], ao_fn, swb)
                clusters.append((tp[-1] + UP * 0.15, rng.uniform(1.7, 2.3)))
                hangers.append(tp[-1])
    for ci, (c, s) in enumerate(clusters):
        s *= P["cs"]
        th = rng.uniform(0, 3.14)
        for j in range(3):
            a = th + j * (1.05 + rng.uniform(-0.25, 0.25))
            ux = np.array([math.cos(a), 0, math.sin(a)])
            vx = nrm(UP + np.array([math.cos(a + 1.57), 0, math.sin(a + 1.57)]) * rng.uniform(-0.25, 0.25))
            card(leaf, c, ux, vx, s, s, CELLS["birch_dense"], ao_fn, nf, swl, flip=bool((ci + j) % 2), vb=0.5)
        if True:  # roughly horizontal card for the view from above
            ux = np.array([math.cos(th + 0.8), 0, math.sin(th + 0.8)])
            card(leaf, c + UP * 0.05, ux, nrm(np.cross(UP, ux) + UP * 0.15), s * 0.9, s * 0.9, CELLS["birch_dense"], ao_fn, nf, swl, vb=0.5)
    for hp in hangers[::2]:
        a = rng.uniform(0, 6.28)
        ux = np.array([math.cos(a), 0, math.sin(a)])
        card(leaf, hp - UP * 0.35, ux, nrm(-UP + ux * 0.0 + np.array([0.3, 0, 0.2])), 1.5, 1.5, CELLS["birch_sparse"], ao_fn, nf, lambda p, tip: 0.3 + 0.5 * (p[1] / H) + 0.45 * tip, vb=0.05)
    bark.fix_winding()
    return bark, leaf


BUSHES = {
    "bush0": dict(seed=83, R=1.15, Hh=1.35, n=64, cell=CELLS["bush_a"], csz=0.95, stems=7),
    "bush1": dict(seed=97, R=1.0, Hh=1.1, n=70, cell=CELLS["bush_b"], csz=0.8, stems=8),
}


def build_bush(name, lod):
    P = BUSHES[name]
    rng = np.random.default_rng(P["seed"])
    R, Hh = P["R"], P["Hh"]
    bark, leaf = MB(), MB()

    def ao_fn(p):
        d = math.sqrt((p[0] / R) ** 2 + (p[2] / R) ** 2 + (p[1] / Hh) ** 2)
        return 0.36 + 0.64 * float(smooth(d, 0.15, 1.0)) ** 0.9 * (0.7 + 0.3 * min(1.0, p[1] / (Hh * 0.8)) + 0.0)

    def nf(p):
        c = np.array([0.0, Hh * 0.25, 0.0])
        return nrm(nrm((np.asarray(p) - c) * np.array([1.0, 0.7, 1.0])) * 0.8 + UP * 0.5)

    def swl(p, tip):
        return 0.2 + 0.55 * min(1.0, p[1] / Hh) + 0.2 * tip

    if lod == 1:
        for k in range(6):
            a = k * 1.047 + rng.uniform(-0.2, 0.2)
            ux = np.array([math.cos(a), 0, math.sin(a)])
            s = R * 2.1
            card(leaf, np.array([0, Hh * 0.45, 0]), ux, UP, s, Hh * 1.1, CELLS["bush_blob"], ao_fn, nf, swl, vb=0.45)
        card(leaf, np.array([0, Hh * 0.7, 0]), np.array([1.0, 0, 0]), np.array([0, 0, 1.0]), R * 1.7, R * 1.7, CELLS["bush_blob"], ao_fn, nf, swl, vb=0.5)
        return bark, leaf
    for s in range(P["stems"]):
        a = s / P["stems"] * 6.283 + rng.uniform(-0.3, 0.3)
        d = np.array([math.cos(a), 0, math.sin(a)])
        pts = [np.zeros(3) + d * 0.04, d * R * 0.2 + UP * Hh * 0.35, d * R * 0.4 + UP * Hh * 0.62]
        tube(bark, pts, [0.03, 0.02, 0.008], 3, CONIFER_RECT, [0.0, 0.5, 1.0], ao_fn, lambda p, t: 0.3 * t)
    cells = P["cell"]
    for i in range(P["n"]):
        a = rng.uniform(0, 6.283)
        u = rng.uniform(0.0, 1.0)
        el = math.acos(1 - u * 0.98)  # 0 = top .. ~pi/2 = side
        r = R * math.sin(el) * rng.uniform(0.55, 1.0)
        c = np.array([math.cos(a) * r, Hh * (math.cos(el) * 0.92 + 0.08) * rng.uniform(0.75, 1.0), math.sin(a) * r])
        out = nrm(np.array([math.cos(a) * math.sin(el), math.cos(el), math.sin(a) * math.sin(el)]))
        vx = nrm(UP - out * np.dot(UP, out) + out * 0.0) if abs(np.dot(UP, out)) < 0.97 else np.array([1.0, 0, 0])
        ux = nrm(np.cross(vx, out))
        roll = rng.uniform(-0.6, 0.6)
        ux, vx = ux * math.cos(roll) + vx * math.sin(roll), vx * math.cos(roll) - ux * math.sin(roll)
        sz = P["csz"] * rng.uniform(0.75, 1.15)
        card(leaf, c, ux, vx, sz, sz, cells, ao_fn, nf, swl, flip=bool(i % 2), vb=0.5)
    # ground skirt
    for i in range(6):
        a = i * 1.047 + rng.uniform(-0.2, 0.2)
        d = np.array([math.cos(a), 0, math.sin(a)])
        card(leaf, d * R * 0.6 + UP * 0.12, nrm(np.cross(UP, d)), nrm(d * 0.6 + UP * 0.5), R * 0.9, R * 0.8, cells, ao_fn, nf, swl, vb=0.3)
    bark.fix_winding()
    return bark, leaf


def build_fern(name, lod):
    rng = np.random.default_rng(101)
    bark, leaf = MB(), MB()
    nf_fr = 13 if lod == 0 else 6
    segs = 4 if lod == 0 else 2
    u0, v0, u1, v1 = cell_uv(CELLS["fern"])

    def ao_fn(p):
        return 0.45 + 0.55 * float(smooth(math.hypot(p[0], p[2]), 0.0, 0.8))

    for k in range(nf_fr):
        a = k / nf_fr * 6.283 + rng.uniform(-0.2, 0.2)
        d = np.array([math.cos(a), 0, math.sin(a)])
        sd = np.array([-d[2], 0, d[0]])
        Lf = rng.uniform(1.35, 1.8)
        W = 0.55 * Lf
        e0 = rng.uniform(1.0, 1.3)
        rows = []
        pos = d * 0.04
        for j in range(segs + 1):
            s = j / segs
            if j:
                e = e0 - 2.1 * (s - 0.5 / segs) ** 1.25
                pos = pos + (d * math.cos(e) + UP * math.sin(e)) * Lf / segs
            w = W * (0.5 + 0.5 * math.sin(math.pi * min(1, s * 0.92 + 0.08)))
            n = nrm(UP * 0.9 + d * 0.2)
            swv = 0.15 + 0.85 * s
            row = [leaf.v(pos - sd * w / 2, n, (u0, v0 + (v1 - v0) * s), ao_fn(pos) * (0.65 + 0.35 * s), swv),
                   leaf.v(pos + sd * w / 2, n, (u1, v0 + (v1 - v0) * s), ao_fn(pos) * (0.65 + 0.35 * s), swv)]
            rows.append(row)
        for j in range(segs):
            a0, a1, b0, b1 = rows[j][0], rows[j][1], rows[j + 1][0], rows[j + 1][1]
            leaf.i += [a0, a1, b1, a0, b1, b0]
    return bark, leaf


def build_grass(name, lod):
    """Three crossed cards (60 degrees apart), 1.0 wide x 0.7 high, each a different tuft cell."""
    bark, leaf = MB(), MB()
    for k, cell in enumerate((CELLS["grass_a"], CELLS["grass_b"], CELLS["grass_c"])):
        a = k * math.pi / 3 + 0.2
        ux = np.array([math.cos(a), 0, math.sin(a)])
        u0, v0, u1, v1 = cell_uv(cell)
        w, h = 1.0, 0.72 if k != 2 else 0.5
        for j, (vv, ao) in enumerate(((v0, 0.38), (v1, 1.0))):
            pass
        ids = []
        for (vv, hv, ao) in ((v0, 0.0, 0.34), (v1, h, 1.0)):
            for (uu, sg) in ((u0, -1), (u1, 1)):
                p = ux * sg * w / 2 + UP * hv
                ids.append(leaf.v(p, nrm(UP * 1.0 + ux * 0.0), (uu, vv), ao, hv / 0.72))
        leaf.i += [ids[0], ids[1], ids[3], ids[0], ids[3], ids[2]]
    return bark, leaf


MODELS = [
    ("pine0", build_conifer, 2), ("pine1", build_conifer, 2), ("spruce0", build_conifer, 2),
    ("birch0", build_birch, 2), ("birch1", build_birch, 2),
    ("bush0", build_bush, 2), ("bush1", build_bush, 2), ("fern0", build_fern, 2), ("grass0", build_grass, 1),
]


# ----------------------------------------------------------------------------------------------
# encoding
# ----------------------------------------------------------------------------------------------
def encode(B):
    if B.nv == 0:
        return None
    P = np.array(B.p)
    s = float(np.abs(P).max()) / 32767.0
    q = np.round(P / s).astype(np.int16)
    N = np.round(np.array(B.n) * 127).astype(np.int8)
    uv = np.round(np.clip(np.array(B.uv), 0, 1) * 65535).astype(np.uint16)
    assert B.nv < 65536
    ao = np.round(np.array(B.ao) * 255).astype(np.uint8)
    sw = np.round(np.array(B.sw) * 255).astype(np.uint8)
    idx = np.array(B.i, dtype=np.uint16)
    blob = q.astype("<i2").tobytes() + uv.astype("<u2").tobytes() + idx.astype("<u2").tobytes() + N.tobytes() + ao.tobytes() + sw.tobytes()
    return {"v": B.nv, "t": B.tris, "s": round(s, 7), "d": base64.b64encode(blob).decode("ascii")}


def save_jpeg(arr, name, mode):
    """arr bottom-up float array (H,W,3) or (H,W); returns the jpeg bytes."""
    sc = bpy.context.scene
    sc.render.image_settings.file_format = "JPEG"
    sc.render.image_settings.quality = JPEG_Q[name]
    sc.render.image_settings.color_mode = mode
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    h, w = arr.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=False)
    img.colorspace_settings.name = "Non-Color"
    px = np.ones((h, w, 4), np.float32)
    if arr.ndim == 2:
        px[..., :3] = arr[..., None]
    else:
        px[..., :3] = arr
    img.pixels.foreach_set(px.ravel())
    path = os.path.join(TMP, name + ".jpg")
    img.save_render(path, scene=sc)
    with open(path, "rb") as f:
        return f.read(), path


# ----------------------------------------------------------------------------------------------
# preview
# ----------------------------------------------------------------------------------------------
def to_blender(a):
    return (a[0], -a[2], a[1])


def make_obj(name, B, mat, loc, scale=1.0):
    me = bpy.data.meshes.new(name)
    verts = [to_blender(p) for p in B.p]
    faces = [tuple(B.i[t:t + 3]) for t in range(0, len(B.i), 3)]
    me.from_pydata(verts, [], faces)
    me.update()
    uvl = me.uv_layers.new(name="UV")
    uvs = np.array(B.uv, np.float32)
    li = np.array([i for f in faces for i in f])
    uvl.data.foreach_set("uv", uvs[li].ravel())
    ca = me.color_attributes.new("ao", "FLOAT_COLOR", "POINT")
    cb = np.ones((len(B.p), 4), np.float32)
    cb[:, :3] = np.array(B.ao)[:, None]
    ca.data.foreach_set("color", cb.ravel())
    me.polygons.foreach_set("use_smooth", np.ones(len(faces), dtype=bool))
    me.normals_split_custom_set_from_vertices([to_blender(n) for n in B.n])
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    ob.location = loc
    ob.scale = (scale,) * 3
    return ob


def preview_material(name, color_path, nor_path, alpha_path=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bs = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bs.inputs["Roughness"].default_value = 0.85
    bs.inputs["Specular IOR Level"].default_value = 0.15
    nt.links.new(bs.outputs[0], out.inputs[0])

    def img(path, cs):
        n = nt.nodes.new("ShaderNodeTexImage")
        n.image = bpy.data.images.load(path)
        n.image.colorspace_settings.name = cs
        n.interpolation = "Linear"
        return n

    ci = img(color_path, "sRGB")
    ao = nt.nodes.new("ShaderNodeAttribute")
    ao.attribute_name = "ao"
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.inputs[0].default_value = 1.0
    nt.links.new(ci.outputs["Color"], mix.inputs[6])
    nt.links.new(ao.outputs["Color"], mix.inputs[7])
    nt.links.new(mix.outputs[2], bs.inputs["Base Color"])
    if nor_path:
        ni = img(nor_path, "Non-Color")
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.inputs["Strength"].default_value = 0.7
        nt.links.new(ni.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bs.inputs["Normal"])
    if alpha_path:
        ai = img(alpha_path, "Non-Color")
        th = nt.nodes.new("ShaderNodeMath")
        th.operation = "GREATER_THAN"
        th.inputs[1].default_value = 0.5
        nt.links.new(ai.outputs["Color"], th.inputs[0])
        nt.links.new(th.outputs[0], bs.inputs["Alpha"])
    return m


def render_impostors(paths):
    """Renders the LOD0 birches from 4 azimuths (flat ambient light, transparent film) into an
    impostor atlas (8 tiles of 256 px in 1024x512). Fills IMP and returns (rgb, alpha)."""
    from mathutils import Vector
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.samples = 24
    sc.cycles.use_denoising = False
    sc.cycles.device = "CPU"
    sc.cycles.transparent_max_bounces = 16
    sc.render.film_transparent = True
    sc.render.resolution_x = sc.render.resolution_y = IMPT
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    sc.view_settings.view_transform = "Standard"
    w = bpy.data.worlds.new("wimp")
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs[0].default_value = (1, 1, 1, 1)
    w.node_tree.nodes["Background"].inputs[1].default_value = 1.0
    sc.world = w
    mat = preview_material("impleaf", paths["leaf"], None, paths["leafA"])
    cam = bpy.data.cameras.new("icam")
    cam.type = "ORTHO"
    co = bpy.data.objects.new("icam", cam)
    bpy.context.collection.objects.link(co)
    sc.camera = co
    rgb = np.zeros((IMPH, IMPW, 3), np.float32)
    alp = np.zeros((IMPH, IMPW), np.float32)
    tile = 0
    for name in ("birch0", "birch1"):
        _, lf = build_birch(name, 0)
        P = np.array(lf.p)
        lo, hi = P.min(axis=0), P.max(axis=0)
        c = (lo + hi) / 2
        S = float(max(hi[0] - lo[0], hi[2] - lo[2], hi[1] - lo[1])) * 1.04
        ob = make_obj(name + "_imp", lf, mat, (0, 0, 0))
        tiles = []
        for az in np.radians([0, 45, 90, 135]):
            d = np.array([math.cos(az), 0, math.sin(az)])
            co.location = to_blender(c + d * 60)
            co.rotation_euler = Vector(to_blender(-d)).to_track_quat("-Z", "Y").to_euler()
            cam.ortho_scale = S
            path = os.path.join(TMP, "imp_%d.png" % tile)
            sc.render.filepath = path
            bpy.ops.render.render(write_still=True)
            img = bpy.data.images.load(path)
            img.colorspace_settings.name = "Non-Color"
            px = np.array(img.pixels[:], np.float32).reshape(IMPT, IMPT, 4)
            assert px.max() > 0, "impostor render read back empty"
            a = px[..., 3]
            col = px[..., :3] / np.maximum(a[..., None], 1e-3)
            mean = (np.clip(col, 0, 1) * a[..., None]).sum(axis=(0, 1)) / max(float(a.sum()), 1.0)
            out = np.clip((a[..., None] * np.clip(col, 0, 1) + (1 - a[..., None]) * mean) * 1.3, 0, 1)  # runtime light darkens again
            x0, y0 = (tile % 4) * IMPT, (tile // 4) * IMPT
            rgb[y0:y0 + IMPT, x0:x0 + IMPT] = out
            alp[y0:y0 + IMPT, x0:x0 + IMPT] = np.clip((a - 0.5) * 1.5 + 0.5, 0, 1)
            tiles.append((tile, float(az)))
            tile += 1
        bpy.data.objects.remove(ob)
        IMP[name] = {"c": c, "S": S, "tiles": tiles}
        LOG("  impostor %s: crown %.1f m, tiles %s" % (name, S, [t for t, _ in tiles]))
    bpy.data.objects.remove(co)
    return rgb, alp


def render_sheet(models, paths):
    sc = bpy.context.scene
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob)
    sc.render.engine = "CYCLES"
    sc.cycles.samples = SAMPLES
    sc.cycles.use_denoising = True
    sc.cycles.device = "CPU"
    sc.cycles.max_bounces = 4
    sc.cycles.transparent_max_bounces = 16
    sc.render.film_transparent = False
    sc.render.resolution_x, sc.render.resolution_y = 1800, 2000
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGB"
    sc.view_settings.view_transform = "Standard"
    w = bpy.data.worlds.new("w")
    w.use_nodes = True
    bgn = w.node_tree.nodes["Background"]
    bgn.inputs[0].default_value = (0.34, 0.5, 0.68, 1)
    bgn.inputs[1].default_value = 0.9
    sc.world = w
    mats = {
        "imp": preview_material("imp", paths["imp"], None, paths["impA"]),
        "bark": preview_material("bark", paths["bark"], paths["barkN"]),
        "leaf": preview_material("leaf", paths["leaf"], paths["leafN"], paths["leafA"]),
    }
    gm = bpy.data.materials.new("ground")
    gm.diffuse_color = (0.2, 0.28, 0.1, 1)
    gm.use_nodes = True
    gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.16, 0.2, 0.07, 1)
    gm.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 1.0
    # layout (blender coords: x right, z up, y depth); rows from the top
    rows = [("lod0", 0.0, 1.0, ["pine0", "pine1", "spruce0", "birch0", "birch1"]),
            ("lod1", -23.0, 1.0, ["pine0", "pine1", "spruce0", "birch0", "birch1"]),
            ("small", -41.0, 5.0, ["bush0", "bush1", "fern0", "grass0", "bush1"])]
    for ri, (lodn, z0, sc_, names) in enumerate(rows):
        gb = bpy.data.objects.new("g%d" % ri, bpy.data.meshes.new("g%d" % ri))
        bm_v = [(-40, -10, 0), (40, -10, 0), (40, 6, 0), (-40, 6, 0)]
        gb.data.from_pydata(bm_v, [], [(0, 1, 2, 3)])
        gb.data.materials.append(gm)
        bpy.context.collection.objects.link(gb)
        gb.location = (22, 0, z0 - 0.02)
        for ci, nm in enumerate(names):
            lod = 0 if ri != 1 else 1
            if ri == 2 and ci == 4:
                lod = 1
            lods = models[nm]
            lod = min(lod, len(lods) - 1)
            bk, lf = lods[lod]
            leafmat = mats["imp"] if (lod == 1 and nm in IMP) else mats["leaf"]
            loc = (ci * 11.0, 0, z0)
            if bk.nv:
                make_obj("%s_%d_b" % (nm, lod), bk, mats["bark"], loc, sc_)
            if lf.nv:
                make_obj("%s_%d_l" % (nm, lod), lf, leafmat, loc, sc_)
    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = 2.6
    sun.angle = math.radians(1.5)
    so = bpy.data.objects.new("sun", sun)
    bpy.context.collection.objects.link(so)
    so.rotation_euler = (math.radians(48), 0, math.radians(30))
    cam = bpy.data.cameras.new("cam")
    cam.type = "ORTHO"
    cam.ortho_scale = 66
    co = bpy.data.objects.new("cam", cam)
    bpy.context.collection.objects.link(co)
    co.location = (22, -100, -11)
    co.rotation_euler = (math.radians(90), 0, 0)
    sc.camera = co
    os.makedirs(os.path.dirname(SHEET_PATH), exist_ok=True)
    sc.render.filepath = SHEET_PATH
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    LOG("sheet rendered in %.0fs -> %s" % (time.time() - t0, SHEET_PATH))


# ----------------------------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------------------------
def main():
    t0 = time.time()
    rng = np.random.default_rng(2024)
    LOG("painting leaf atlas ...")
    leaf_rgb, leaf_a, leaf_n = paint_leaf_atlas(rng)
    LOG("painting bark atlas ...")
    bark_rgb, bark_n = paint_bark_atlas(rng)
    # the bark atlas is 1024 wide (two 512 tiles) x 1024 tall
    files, paths = {}, {}
    for key, arr, mode in (("bark", bark_rgb, "RGB"), ("barkN", bark_n, "RGB"), ("leaf", leaf_rgb, "RGB"), ("leafA", leaf_a, "BW"), ("leafN", leaf_n, "RGB")):
        data, path = save_jpeg(arr, key, mode)
        files[key] = data
        paths[key] = path
        LOG("  %-6s %4d KB" % (key, len(data) // 1024))
    LOG("rendering birch impostors ...")
    imp_rgb, imp_a = render_impostors(paths)
    for key, arr, mode in (("imp", imp_rgb, "RGB"), ("impA", imp_a, "BW")):
        data, path = save_jpeg(arr, key, mode)
        files[key] = data
        paths[key] = path
        LOG("  %-6s %4d KB" % (key, len(data) // 1024))
    models, out = {}, {}
    tot = 0
    for name, fn, nlod in MODELS:
        lods = []
        entry = {"lod": []}
        for lod in range(nlod):
            bk, lf = fn(name, lod)
            lods.append((bk, lf))
            tri = bk.tris + lf.tris
            entry["lod"].append({"bark": encode(bk), "leaf": encode(lf), "tris": tri, **({"imp": True} if (lod == 1 and name in IMP) else {})})
            LOG("  %-8s LOD%d: %5d tris (bark %4d, leaf %4d), %5d verts" % (name, lod, tri, bk.tris, lf.tris, bk.nv + lf.nv))
            if lod == 0 and name[:4] in ("pine", "spru", "birc"):
                assert tri <= 2500, "%s LOD0 too heavy (%d)" % (name, tri)
            if lod == 1 and name[:4] in ("pine", "spru"):
                assert 150 <= tri <= 300, "%s LOD1 outside 150..300 (%d)" % (name, tri)
        models[name] = lods
        out[name] = entry
    meta = {
        "pine0": dict(h=15.0, r=4.6, trunk=0.30), "pine1": dict(h=19.0, r=5.0, trunk=0.34), "spruce0": dict(h=16.0, r=3.8, trunk=0.28),
        "birch0": dict(h=10.5, r=3.2, trunk=0.15), "birch1": dict(h=9.0, r=3.4, trunk=0.14),
        "bush0": dict(h=1.35, r=1.2, trunk=0.0), "bush1": dict(h=1.1, r=1.05, trunk=0.0), "fern0": dict(h=1.05, r=1.4, trunk=0.0), "grass0": dict(h=0.72, r=0.55, trunk=0.0),
    }
    for k, m in meta.items():
        out[k].update(m)
    tex = {k: "data:image/jpeg;base64," + base64.b64encode(v).decode("ascii") for k, v in files.items()}
    lines = [
        "// Generated by tools/blender/build_foliage.py. Do not edit by hand.",
        "// FOLIAGE_TEX : JPEG data URIs. bark/barkN = 1024x1024 conifer (left) + birch (right) tiles,",
        "//               leaf = 2048x2048 4x4 cell atlas, leafA = greyscale alpha of it, leafN = its 1024 normal map.",
        "// FOLIAGE_MODELS : per model { h, r, trunk, lod: [{ bark, leaf, tris }] }. Each bark/leaf is",
        "//   { v, t, s, d }: v vertices, t triangles, s position scale, d base64 of little-endian",
        "//   int16 pos*3*v | uint16 uv*2*v | uint16 idx*3*t | int8 normal*3*v | uint8 ao*v | uint8 sway*v",
        "// (see decodeFoliageMesh in foliage.js).",
        "export const FOLIAGE_TEX = " + json.dumps({"size": {"bark": [1024, 1024], "leaf": [2048, 2048], "leafN": [1024, 1024], "imp": [1024, 512]}, **tex}, indent=1) + ";",
        "export const FOLIAGE_MODELS = " + json.dumps(out) + ";",
        "",
    ]
    txt = "\n".join(lines)
    with open(OUT_JS, "w") as f:
        f.write(txt)
    LOG("wrote %s: %.0f KB (limit 2560 KB)" % (OUT_JS, len(txt) / 1024))
    assert len(txt) <= 2.5 * 1024 * 1024, "foliage_asset.js too large"
    if not NO_PREVIEW:
        render_sheet(models, paths)
    LOG("done in %.0fs" % (time.time() - t0))


main()
