"""Cedar Lodge map builder (Blender 5 headless).

NOTE: the generated asset module is post-processed by tools/recompress_assets.py (textures re-encoded as WebP,
GLB images via EXT_texture_webp). Run it after this script; do not hand-edit the output.

Run:  /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/build_lodge.py

Everything is procedural (numpy + Blender built-ins only):
  - tileable PBR textures (albedo / normal / ORM) generated from procedural noise, saved as JPEG
  - geometry built from primitives (logs, stone, shingles, planks ...) in game space
  - terrain splat baked at 2048 (grass/soil/gravel/mud/rock) from a height function
  - glTF binary written directly (KHR_mesh_quantization for normals)
  - src/maps/lodge_asset.js (LODGE_GLB + LODGE_DATA) and docs/sheet_lodge.png (review renders)
Env: LODGE_QUICK=1 skips renders; LODGE_NOTEX=1 uses tiny textures (debug).
"""
import base64
import io
import json
import math
import os
import struct
import sys
import time
import zlib

import bpy
import numpy as np
np.seterr(all='ignore')

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
TMP = os.environ.get("LODGE_TMP", "/private/tmp/claude-501/s/lodge_tmp")
os.makedirs(TMP, exist_ok=True)
T0 = time.time()


def log(*a):
    print("[lodge %5.1fs]" % (time.time() - T0), *a, flush=True)


rng_global = np.random.RandomState(7)

# ----------------------------------------------------------------------------------------------
# noise
# ----------------------------------------------------------------------------------------------


def _hash(ix, iy, seed):
    h = (ix.astype(np.int64) * 73856093) ^ (iy.astype(np.int64) * 19349663) ^ (seed * 83492791 + 12345)
    h = (h ^ (h >> 13)) * 1274126177
    h = (h ^ (h >> 16)) & 0xFFFFFFFF
    return (h & 0xFFFF) / 65535.0


def vnoise(x, y, seed=0, period=None):
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    x0 = np.floor(x)
    y0 = np.floor(y)
    fx = x - x0
    fy = y - y0
    fx = fx * fx * (3 - 2 * fx)
    fy = fy * fy * (3 - 2 * fy)
    ix0, iy0 = x0.astype(np.int64), y0.astype(np.int64)
    ix1, iy1 = ix0 + 1, iy0 + 1
    if period:
        px, py = (period, period) if np.isscalar(period) else period
        ix0, ix1 = ix0 % px, ix1 % px
        iy0, iy1 = iy0 % py, iy1 % py
    a = _hash(ix0, iy0, seed)
    b = _hash(ix1, iy0, seed)
    c = _hash(ix0, iy1, seed)
    d = _hash(ix1, iy1, seed)
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def fbm(x, y, octs=4, seed=0, period=None, gain=0.5):
    tot = 0.0
    amp = 1.0
    norm = 0.0
    f = 1
    for o in range(octs):
        p = None
        if period:
            p = (period[0] * f, period[1] * f) if not np.isscalar(period) else period * f
        tot = tot + amp * vnoise(x * f, y * f, seed + o * 17, p)
        norm += amp
        amp *= gain
        f *= 2
    return tot / norm


def smooth(a, b, x):
    t = np.clip((np.asarray(x, dtype=np.float64) - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


def srgb_to_lin(c):
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def hexc(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)])


def voronoi(N, cells, seed, jitter=0.9):
    """Periodic voronoi on an N x N tile. Returns F1, F2, cell value (0..1), cell centre offset."""
    rs = np.random.RandomState(seed)
    cx = (np.arange(cells)[None, :].repeat(cells, 0) + 0.5 + (rs.rand(cells, cells) - 0.5) * jitter)
    cy = (np.arange(cells)[:, None].repeat(cells, 1) + 0.5 + (rs.rand(cells, cells) - 0.5) * jitter)
    val = rs.rand(cells, cells)
    px = (np.arange(N)[None, :] + 0.5) / N * cells
    py = (np.arange(N)[:, None] + 0.5) / N * cells
    px = np.broadcast_to(px, (N, N))
    py = np.broadcast_to(py, (N, N))
    ci = np.floor(px).astype(int)
    cj = np.floor(py).astype(int)
    f1 = np.full((N, N), 9.0)
    f2 = np.full((N, N), 9.0)
    v1 = np.zeros((N, N))
    for dj in (-1, 0, 1):
        for di in (-1, 0, 1):
            ii = (ci + di) % cells
            jj = (cj + dj) % cells
            x = cx[jj, ii] + (ci + di - ii)
            y = cy[jj, ii] + (cj + dj - jj)
            d = np.hypot(px - x, py - y)
            closer = d < f1
            f2 = np.where(closer, f1, np.minimum(f2, d))
            v1 = np.where(closer, val[jj, ii], v1)
            f1 = np.where(closer, d, f1)
    return f1, f2, v1


def normal_from_height(h, strength=2.0):
    """Tangent-space normal map (glTF: +Y toward image up) from a height map in 0..1."""
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5
    nx = -dx * strength * h.shape[0] / 64.0
    ny = dy * strength * h.shape[0] / 64.0
    nz = np.ones_like(h)
    L = np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.stack([nx / L, ny / L, nz / L], -1) * 0.5 + 0.5


def blur(a, k=1):
    for _ in range(k):
        a = (a + np.roll(a, 1, 0) + np.roll(a, -1, 0) + np.roll(a, 1, 1) + np.roll(a, -1, 1)) / 5.0
    return a


# ----------------------------------------------------------------------------------------------
# procedural tileable materials: each returns dict(alb[N,N,3] sRGB, h, rough, metal, ao)
# ----------------------------------------------------------------------------------------------
GRID = {}


def grid(N):
    if N not in GRID:
        GRID[N] = (np.arange(N)[None, :] / N, np.arange(N)[:, None] / N)
    return GRID[N]


def mix3(a, b, t):
    return a * (1 - t[..., None]) + b * t[..., None]


def tex_log(N=512):
    X, Y = grid(N)
    g = fbm(X * 10, Y * 2, 4, 1, (10, 2))
    g2 = fbm(X * 40, Y * 3, 3, 2, (40, 3))
    ridge = np.abs(fbm(X * 6, Y * 1, 3, 3, (6, 1)) - 0.5) * 2
    crack = smooth(0.12, 0.0, ridge) * smooth(0.35, 0.6, fbm(X * 3, Y * 2, 2, 4, (3, 2)))
    c1, c2, c3 = hexc("#5c3a20"), hexc("#926a44"), hexc("#9a9183")
    alb = mix3(c1[None, None, :] + 0 * g[..., None], c2, smooth(0.25, 0.75, g * 0.7 + g2 * 0.3))
    weather = smooth(0.55, 0.85, fbm(X * 4, Y * 2, 3, 5, (4, 2)))
    alb = mix3(alb, c3, weather * 0.45)
    alb = alb * (1 - 0.65 * crack[..., None])
    h = 0.5 * g2 + 0.3 * g - 0.5 * crack
    ao = 1 - 0.7 * crack
    return dict(alb=alb, h=h, rough=0.78 + 0.15 * weather, metal=0 * g, ao=ao, nstr=2.2)


def tex_stone(N=512):
    f1, f2, v = voronoi(N, 6, 11, 0.75)
    X, Y = grid(N)
    edge = f2 - f1
    mort = smooth(0.0, 0.16, edge)  # 0 at mortar
    rs = np.random.RandomState(3)
    pal = [hexc(c) for c in ("#6e6b66", "#80796c", "#5b5a58", "#8a8173", "#716a60", "#97908a")]
    idx = (v * len(pal)).astype(int) % len(pal)
    base = np.array(pal)[idx]
    n1 = fbm(X * 24, Y * 24, 4, 21, (24, 24))
    alb = base * (0.78 + 0.45 * n1[..., None])
    mortar = hexc("#9a958a")[None, None, :] * (0.8 + 0.3 * fbm(X * 30, Y * 30, 2, 8, (30, 30)))[..., None]
    alb = mix3(mortar, alb, mort)
    moss = smooth(0.55, 0.78, fbm(X * 5, Y * 5, 4, 31, (5, 5))) * (0.35 + 0.65 * (1 - mort))
    alb = mix3(alb, hexc("#4c5f2a")[None, None, :] * (0.7 + 0.5 * n1)[..., None], moss * 0.7)
    h = mort * (0.45 + 0.5 * smooth(0, 0.6, edge) + 0.25 * n1) + 0.0
    ao = 0.45 + 0.55 * mort
    return dict(alb=alb, h=h, rough=0.9 - 0.15 * moss, metal=0 * h, ao=ao, nstr=3.0)


def tex_shingle(N=512):
    X, Y = grid(N)
    rows = 8
    r = Y * rows
    ri = np.floor(r).astype(int)
    fr = r - ri
    per = 6
    xo = X * per + (ri % 2) * 0.5 + (ri * 0.37)
    ci = np.floor(xo).astype(int)
    fc = xo - ci
    cell = _hash(ci % per + ri * 11, ri % rows, 5)
    pal = [hexc(c) for c in ("#3d3a37", "#4a433b", "#34322f", "#52483c", "#3a3f40")]
    base = np.array(pal)[(cell * 5).astype(int) % 5]
    shade = 0.75 + 0.5 * smooth(0, 1, fr)
    n = fbm(X * 30, Y * 30, 3, 9, (30, 30))
    alb = base * (shade * (0.8 + 0.4 * n))[..., None]
    gap = np.minimum(smooth(0.0, 0.07, fc), smooth(1.0, 0.93, fc))
    lip = smooth(0.0, 0.08, 1 - fr)
    alb = alb * (0.35 + 0.65 * gap * lip)[..., None]
    moss = smooth(0.62, 0.8, fbm(X * 3, Y * 3, 4, 14, (3, 3)))
    alb = mix3(alb, hexc("#47562a"), moss * 0.55)
    h = fr * 0.8 * gap + 0.2 * n
    ao = 0.5 + 0.5 * gap * lip
    return dict(alb=alb, h=h, rough=0.85 + 0 * h, metal=0 * h, ao=ao, nstr=3.0)


def tex_planks(N=512):
    X, Y = grid(N)
    pl = 5
    r = Y * pl
    ri = np.floor(r).astype(int)
    fr = r - ri
    off = _hash(ri, ri * 0, 2)
    grain = fbm((X + off) * 6, Y * 40, 4, 41, (6, 40)) * 0.7 + fbm((X + off) * 20, Y * 90, 2, 43, (20, 90)) * 0.3
    tone = _hash(ri, ri * 0 + 1, 7)
    c1, c2 = hexc("#6a4a2e"), hexc("#8d6a45")
    alb = mix3(c1[None, None, :] + 0 * grain[..., None], c2, tone * 0.6 + grain * 0.5)
    grey = smooth(0.5, 0.8, fbm(X * 3, Y * 3, 3, 8, (3, 3)))
    alb = mix3(alb, hexc("#8e8a80"), grey * 0.4)
    gap = smooth(0.0, 0.06, fr) * smooth(1.0, 0.94, fr)
    alb = alb * (0.5 + 0.5 * gap)[..., None] * (0.85 + 0.3 * grain)[..., None]
    seam = np.abs(((X + off) * 1.0) % 1.0 - 0.0)
    h = 0.5 * gap + 0.25 * grain
    ao = 0.55 + 0.45 * gap
    return dict(alb=alb, h=h, rough=0.82 + 0 * h, metal=0 * h, ao=ao, nstr=2.0)


def tex_paint(N=512):
    X, Y = grid(N)
    br = fbm(X * 8, Y * 90, 3, 51, (8, 90))
    chip = smooth(0.72, 0.78, fbm(X * 32, Y * 32, 4, 52, (32, 32))) * 0.6
    dirt = smooth(0.45, 0.85, fbm(X * 3, Y * 14, 4, 53, (3, 14)))
    alb = np.ones((N, N, 3)) * 0.86
    alb = alb * (0.94 + 0.1 * br)[..., None]
    alb = alb * (1 - 0.35 * dirt)[..., None]
    alb = mix3(alb, hexc("#5a4a3a"), chip * 0.8)
    h = 0.5 + 0.1 * br - 0.3 * chip
    return dict(alb=alb, h=h, rough=0.6 + 0.3 * chip + 0.1 * dirt, metal=0 * h, ao=1 - 0.4 * chip, nstr=1.0)


def tex_metal(N=512):
    X, Y = grid(N)
    wave = 0.5 + 0.5 * np.sin(X * 2 * math.pi * 10)
    n = fbm(X * 12, Y * 12, 4, 61, (12, 12))
    rust = smooth(0.5, 0.7, fbm(X * 4, Y * 4, 5, 62, (4, 4)) * 0.7 + n * 0.3)
    base = np.ones((N, N, 3)) * np.array(hexc("#9aa0a2"))[None, None, :] * (0.8 + 0.3 * n)[..., None]
    alb = mix3(base, hexc("#7b3f1d") * (0.6 + 0.8 * n)[..., None], rust)
    h = wave * 0.6 + 0.1 * n - 0.2 * rust
    return dict(alb=alb, h=h, rough=0.45 + 0.45 * rust, metal=(1 - rust) * 0.85, ao=0.6 + 0.4 * wave, nstr=2.0)


def tex_rock(N=512):
    X, Y = grid(N)
    f1, f2, v = voronoi(N, 4, 71, 0.9)
    n = fbm(X * 8, Y * 8, 5, 72, (8, 8))
    crack = smooth(0.14, 0.0, f2 - f1) * 0.9 * smooth(0.3, 0.6, n)
    strata = 0.5 + 0.5 * np.sin((Y * 12 + n * 3) * 2 * math.pi)
    base = mix3(hexc("#5f5e5b")[None, None, :] + 0 * n[..., None], hexc("#8c877e"), n * 0.7 + 0.15 * strata)
    alb = base * (0.85 + 0.25 * v)[..., None]
    lichen = smooth(0.62, 0.8, fbm(X * 6, Y * 6, 4, 73, (6, 6)))
    alb = mix3(alb, hexc("#a3a05a"), lichen * 0.35)
    moss = smooth(0.7, 0.88, fbm(X * 4, Y * 4, 4, 74, (4, 4)))
    alb = mix3(alb, hexc("#43562a"), moss * 0.6)
    alb = alb * (1 - 0.6 * crack)[..., None]
    h = n * 0.6 + 0.2 * strata - 0.7 * crack + 0.3 * f1
    return dict(alb=alb, h=h, rough=0.88 + 0 * h, metal=0 * h, ao=1 - 0.7 * crack, nstr=3.0)


def tex_cloth(N=256):
    X, Y = grid(N)
    wv = 0.5 + 0.5 * np.sin(X * 2 * math.pi * 40) * np.sin(Y * 2 * math.pi * 40)
    n = fbm(X * 10, Y * 10, 3, 81, (10, 10))
    alb = np.ones((N, N, 3)) * (0.7 + 0.15 * wv + 0.2 * n)[..., None]
    return dict(alb=alb, h=wv * 0.5, rough=0.95 + 0 * wv, metal=0 * wv, ao=0.8 + 0.2 * wv, nstr=1.5)


def tex_groundfar(N=512):
    X, Y = grid(N)
    n1 = fbm(X * 6, Y * 6, 5, 91, (6, 6))
    n2 = fbm(X * 60, Y * 60, 2, 92, (60, 60))
    alb = mix3(hexc("#4f6a2e")[None, None, :] + 0 * n1[..., None], hexc("#7d8a45"), n1)
    alb = mix3(alb, hexc("#5d4a32"), smooth(0.62, 0.8, fbm(X * 4, Y * 4, 3, 93, (4, 4))) * 0.7)
    alb = alb * (0.8 + 0.4 * n2)[..., None]
    h = n1 * 0.4 + n2 * 0.6
    return dict(alb=alb, h=h, rough=0.95 + 0 * h, metal=0 * h, ao=0.7 + 0.3 * n2, nstr=1.5)


# layers for the baked terrain splat (small tiles, world sized TILE_M each)
def layer_grass(N=256):
    X, Y = grid(N)
    clump = fbm(X * 6, Y * 6, 4, 101, (6, 6))
    blades = fbm(X * 64, Y * 64, 2, 102, (64, 64))
    dry = smooth(0.55, 0.8, fbm(X * 3, Y * 3, 3, 103, (3, 3)))
    a = mix3(hexc("#3e5c22")[None, None, :] + 0 * clump[..., None], hexc("#6f8a38"), clump)
    a = mix3(a, hexc("#8a8a4a"), dry * 0.55)
    a = a * (0.7 + 0.6 * blades)[..., None]
    return dict(alb=a, h=0.5 * clump + 0.5 * blades, rough=0.95 + 0 * clump)


def layer_soil(N=256):
    X, Y = grid(N)
    n = fbm(X * 8, Y * 8, 5, 111, (8, 8))
    f1, f2, v = voronoi(N, 10, 112, 0.9)
    a = mix3(hexc("#4a3524")[None, None, :] + 0 * n[..., None], hexc("#7a6045"), n)
    a = a * (0.75 + 0.35 * v)[..., None] * (0.7 + 0.5 * smooth(0, 0.5, f1))[..., None]
    needles = fbm(X * 30, Y * 6, 2, 113, (30, 6))
    a = a * (0.85 + 0.3 * needles)[..., None]
    return dict(alb=a, h=n * 0.6 + 0.4 * (1 - f1), rough=0.93 + 0 * n)


def layer_gravel(N=256):
    X, Y = grid(N)
    f1, f2, v = voronoi(N, 22, 121, 0.95)
    pal = np.array([hexc(c) for c in ("#8d8a82", "#a39d90", "#767570", "#b0a590", "#6a6862", "#9b9488")])
    base = pal[(v * 6).astype(int) % 6]
    n = fbm(X * 16, Y * 16, 3, 122, (16, 16))
    a = base * (0.8 + 0.4 * n)[..., None]
    a = a * (0.35 + 0.65 * smooth(0.0, 0.35, 0.6 - f1 + 0.1))[..., None]
    sand = smooth(0.5, 0.75, fbm(X * 4, Y * 4, 3, 123, (4, 4)))
    a = mix3(a, hexc("#9b8b6b"), sand * 0.35) * 0.78
    return dict(alb=a, h=smooth(0.6, 0.0, f1) * 0.9 + 0.1 * n, rough=0.85 + 0 * n)


def layer_mud(N=256):
    X, Y = grid(N)
    n = fbm(X * 7, Y * 7, 5, 131, (7, 7))
    puddle = smooth(0.5, 0.65, fbm(X * 3, Y * 3, 3, 132, (3, 3)))
    a = mix3(hexc("#3a2b1d")[None, None, :] + 0 * n[..., None], hexc("#5e4630"), n)
    a = a * (1 - 0.25 * puddle)[..., None]
    return dict(alb=a, h=n * 0.7 - puddle * 0.3, rough=0.55 + 0.35 * (1 - puddle))


def layer_rock(N=256):
    t = tex_rock(N)
    return dict(alb=t["alb"], h=t["h"], rough=t["rough"])


# ----------------------------------------------------------------------------------------------
# image / glTF output
# ----------------------------------------------------------------------------------------------
def jpeg_bytes(arr, quality, name):
    """arr: HxWx3 floats 0..1 stored raw (no colour management)."""
    h, w = arr.shape[:2]
    im = bpy.data.images.new(name, w, h, alpha=False, float_buffer=False)
    im.colorspace_settings.name = "Non-Color"
    buf = np.ones((h, w, 4), np.float32)
    buf[..., :3] = np.clip(arr, 0, 1)
    buf = buf[::-1]  # blender images are bottom-up
    im.pixels.foreach_set(buf.ravel())
    im.file_format = "JPEG"
    path = os.path.join(TMP, name + ".jpg")
    im.save(filepath=path, quality=quality)
    data = open(path, "rb").read()
    bpy.data.images.remove(im)
    return data


def png_bytes(arr):
    a = np.clip(np.round(arr * 255), 0, 255).astype(np.uint8)
    h, w, c = a.shape
    raw = b"".join(b"\x00" + a[i].tobytes() for i in range(h))

    def chunk(t, d):
        c_ = struct.pack(">I", len(d)) + t + d
        return c_ + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    ct = {3: 2, 4: 6}[c]
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, ct, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


class GLB:
    def __init__(self):
        self.bin = bytearray()
        self.views = []
        self.acc = []
        self.images = []
        self.textures = []
        self.materials = []
        self.meshes = []
        self.nodes = []

    def _view(self, data, target=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        v = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(data)}
        if target:
            v["target"] = target
        self.bin += data
        self.views.append(v)
        return len(self.views) - 1

    def accessor(self, arr, ctype, atype, target, normalized=False, minmax=False):
        a = np.ascontiguousarray(arr)
        vi = self._view(a.tobytes(), target)
        d = {"bufferView": vi, "componentType": ctype, "count": int(a.shape[0]), "type": atype}
        if normalized:
            d["normalized"] = True
        if minmax:
            d["min"] = [float(x) for x in a.min(0)]
            d["max"] = [float(x) for x in a.max(0)]
        self.acc.append(d)
        return len(self.acc) - 1

    def image(self, jpg, mime="image/jpeg"):
        vi = self._view(jpg)
        self.images.append({"bufferView": vi, "mimeType": mime})
        self.textures.append({"sampler": 0, "source": len(self.images) - 1})
        return len(self.textures) - 1

    def finish(self, extras_root=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        g = {
            "asset": {"version": "2.0", "generator": "build_lodge.py"},
            "extensionsUsed": ["KHR_mesh_quantization"], "extensionsRequired": ["KHR_mesh_quantization"],
            "scene": 0, "scenes": [{"nodes": list(range(len(self.nodes)))}], "nodes": self.nodes,
            "meshes": self.meshes, "materials": self.materials, "textures": self.textures, "images": self.images,
            "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}],
            "accessors": self.acc, "bufferViews": self.views, "buffers": [{"byteLength": len(self.bin)}],
        }
        js = json.dumps(g, separators=(",", ":")).encode()
        while len(js) % 4:
            js += b" "
        bn = bytes(self.bin)
        total = 12 + 8 + len(js) + 8 + len(bn)
        return (struct.pack("<4sII", b"glTF", 2, total) + struct.pack("<I4s", len(js), b"JSON") + js
                + struct.pack("<I4s", len(bn), b"BIN\x00") + bn)

# ----------------------------------------------------------------------------------------------
# constants shared with the game
# ----------------------------------------------------------------------------------------------
F_SOLID, F_BULLET, F_CAMERA, F_BUILDING, F_SEE = 1, 2, 4, 8, 16
F_DEFAULT = F_SOLID | F_BULLET | F_CAMERA | F_SEE
F_WALL = F_DEFAULT | F_BUILDING
F_GLASS = F_SOLID | F_BULLET | F_CAMERA  # does not block AI sight
S_CONCRETE, S_METAL, S_GLASS, S_WOOD, S_GROUND, S_DIRT = 0, 1, 2, 3, 4, 5
WATER_Y = -1.2
HALF = 160.0
BOUNDS = dict(x0=-55, x1=55, z0=-65, z1=65)

# ----------------------------------------------------------------------------------------------
# layout lists (filled before the terrain is generated)
# ----------------------------------------------------------------------------------------------
# pads: (cx, cz, hx, hz, margin, height)
PADS = [
    (0, 1.5, 13.5, 10.5, 8, 0.0),     # lodge + porch
    (-38, 25, 5.5, 4.5, 5, 0.25),     # cabin
    (38, -10, 8, 6, 5, 0.1),          # greenhouse
    (40, 11, 11, 8, 4, 0.15),         # garden
    (46, -28, 4.5, 3.5, 4, 0.2),      # tool shed
    (4, 51, 26, 12, 7, -0.1),         # parking
    (-20, 29, 10, 13, 4, 0.0),        # pond + buses (engine objects)
    (0, -33, 18, 4, 6, -0.05),        # team B approach
    (44, 27, 7, 6, 4, 0.2),           # tractor field
    (33, 52, 5, 4, 3, -0.1),          # woodshed
]
# paths: (width, [(x,z) ...])
PATHS = [
    (3.2, [(0, 40), (0, 25), (0, 11)]),
    (5.0, [(0, 60), (0, 70), (7, 92), (1, 118), (-6, 160)]),
    (1.9, [(-5, -7.5), (-8, -20), (-17, -37), (-20, -46)]),
    (1.9, [(-5, -7.5), (4, -24), (15, -38), (18, -46)]),
    (1.9, [(10.5, 0), (21, -3), (32, -9.5)]),
    (1.9, [(-9, 11), (-24, 6), (-34, 1), (-40, 0)]),
    (1.6, [(-40, 2), (-37, 12), (-38, 21.5)]),
    (1.7, [(22, 12), (29, 10.5)]),
    (1.7, [(34, -12), (42, -22), (44.5, -25)]),
    (1.7, [(12, 14), (24, 22), (38, 25)]),
]
FOOT = []     # building footprints (name, x0, z0, x1, z1)
KEEP = []     # circles/rects where foliage must not grow: ('r', x0, z0, x1, z1) or ('c', x, z, r)
COL = []      # colliders
PROPS_INFO = {}


def reserve(x0, z0, x1, z1, m=0.0):
    KEEP.append(("r", min(x0, x1) - m, min(z0, z1) - m, max(x0, x1) + m, max(z0, z1) + m))


def reserve_c(x, z, r):
    KEEP.append(("c", x, z, r))


def footprint(name, x0, z0, x1, z1, m=1.5):
    FOOT.append((name, x0, z0, x1, z1))
    reserve(x0, z0, x1, z1, m)


YO = [0.0]


def col(x0, y0, z0, x1, y1, z1, flags=F_DEFAULT, surf=S_WOOD):
    y0 += YO[0]
    y1 += YO[0]
    if x1 - x0 < 1e-3 or y1 - y0 < 1e-3 or z1 - z0 < 1e-3:
        return
    COL.append([round(float(v), 3) for v in (min(x0, x1), min(y0, y1), min(z0, z1), max(x0, x1), max(y0, y1), max(z0, z1))] + [flags, surf])


def col_rot(cx, cz, hx, hz, rot, y0, y1, flags=F_DEFAULT, surf=S_WOOD):
    c, s = abs(math.cos(rot)), abs(math.sin(rot))
    ex, ez = hx * c + hz * s, hx * s + hz * c
    col(cx - ex, y0, cz - ez, cx + ex, y1, cz + ez, flags, surf)


# ----------------------------------------------------------------------------------------------
# terrain height function (game space)
# ----------------------------------------------------------------------------------------------
LAKE_Z = [-200, -100, -70, -52, -48, -44, -40, -36, 0]
LAKE_H = [-4.5, -4.0, -3.2, -1.9, -1.2, -0.55, -0.1, 0.0, 0.0]


def creek_cx(Z):
    return -40.0 - 10.0 * smooth(8, 35, Z) + 2.0 * np.sin(0.1 * np.asarray(Z))


def pad_mask(X, Z):
    m = np.zeros_like(X, dtype=np.float64)
    hh = np.zeros_like(m)
    for (cx, cz, hx, hz, mg, h) in PADS:
        dx = np.maximum(np.abs(X - cx) - hx, 0)
        dz = np.maximum(np.abs(Z - cz) - hz, 0)
        d = np.hypot(dx, dz)
        w = 1 - smooth(0, mg, d)
        hh = np.where(w > m, h, hh)
        m = np.maximum(m, w)
    return m, hh


def terrain_h(X, Z):
    X = np.asarray(X, dtype=np.float64)
    Z = np.asarray(Z, dtype=np.float64)
    X, Z = np.broadcast_arrays(X, Z)
    base = 0.9 * (fbm(X * 0.018 + 30, Z * 0.018 + 70, 3, 201) - 0.5) + 0.12 * (fbm(X * 0.09, Z * 0.09, 3, 202) - 0.5)
    dx = np.maximum(np.abs(X) - 56, 0)
    dz = np.maximum(np.abs(Z) - 66, 0)
    d = np.hypot(dx, dz)
    rise = (0.0035 * d * d + 0.13 * d) * (0.75 + 0.7 * fbm(X * 0.03 + 9, Z * 0.03 + 4, 3, 203)) + 1.2 * smooth(0, 40, d) * (fbm(X * 0.07, Z * 0.07, 4, 204) - 0.5)
    land = base + rise
    lake = np.interp(Z, LAKE_Z, LAKE_H)
    lm = smooth(-36, -46, Z) * (1 - smooth(58, 92, np.abs(X)))
    h = land * (1 - lm) + lake * lm
    # creek (runs north into the lake)
    dc = np.abs(X - creek_cx(Z))
    depth = 1.55 * (1 - smooth(1.8, 5.2, dc)) * smooth(52, 36, Z) * (1 - smooth(-44, -52, Z)) * (1 - smooth(60, 75, np.abs(X)))
    rough = 0.18 * (fbm(X * 0.9, Z * 0.9, 3, 205) - 0.5) * (depth > 0.01)
    # pads
    pm, ph = pad_mask(X, Z)
    h = h * (1 - pm) + ph * pm
    h = h - depth * (1 - pm * 0.5) + rough * (depth / 1.55)
    return h


class HeightGrid:
    def __init__(self, x0, z0, size, n):
        self.x0, self.z0, self.size, self.n = x0, z0, size, n
        self.step = size / (n - 1)
        xs = x0 + np.arange(n) * self.step
        zs = z0 + np.arange(n) * self.step
        self.data = terrain_h(xs[None, :], zs[:, None]).astype(np.float32)

    def at(self, x, z):
        x = np.asarray(x, dtype=np.float64)
        z = np.asarray(z, dtype=np.float64)
        fx = np.clip((x - self.x0) / self.step, 0, self.n - 1.001)
        fz = np.clip((z - self.z0) / self.step, 0, self.n - 1.001)
        ix, iz = fx.astype(int), fz.astype(int)
        tx, tz = fx - ix, fz - iz
        d = self.data
        return ((d[iz, ix] * (1 - tx) + d[iz, ix + 1] * tx) * (1 - tz) + (d[iz + 1, ix] * (1 - tx) + d[iz + 1, ix + 1] * tx) * tz)


HG = None


def gh(x, z):
    return HG.at(x, z)


# ----------------------------------------------------------------------------------------------
# geometry accumulation
# ----------------------------------------------------------------------------------------------
class Acc:
    def __init__(self):
        self.P, self.N, self.UV, self.C, self.I = [], [], [], [], []
        self.n = 0
        self.extras = {}

    def add(self, P, N, UV, C, I):
        self.P.append(P)
        self.N.append(N)
        self.UV.append(UV)
        self.C.append(C)
        self.I.append(I + self.n)
        self.n += len(P)


G = {}
TX = [(np.eye(3), np.zeros(3))]


def rotx(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def roty(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rotz(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def push(R=None, t=(0, 0, 0)):
    R0, t0 = TX[-1]
    R = np.eye(3) if R is None else R
    TX.append((R0 @ R, R0 @ np.asarray(t, dtype=np.float64) + t0))


def pop():
    TX.pop()


def hexl(h):
    return srgb_to_lin(hexc(h)) if isinstance(h, str) else np.asarray(h, dtype=np.float64)


def vcolor(Pw, tint, dirt=True, var=0.10):
    n = len(Pw)
    t = hexl(tint) if isinstance(tint, str) else np.asarray(tint, dtype=np.float64) * np.ones(3)
    c = np.ones((n, 3)) * t
    v = 1.0 - var + 2 * var * vnoise(Pw[:, 0] * 0.35 + Pw[:, 2] * 0.21, Pw[:, 1] * 0.5 + Pw[:, 2] * 0.3 + Pw[:, 0] * 0.1, 301)
    c = c * v[:, None]
    if dirt and HG is not None:
        hh = Pw[:, 1] - gh(Pw[:, 0], Pw[:, 2])
        k = smooth(-0.1, 0.9, hh)
        wet = 0.74 + 0.26 * k
        sp = 0.85 + 0.15 * vnoise(Pw[:, 0] * 3.1, Pw[:, 2] * 3.1 + Pw[:, 1] * 2.0, 302)
        c = c * (wet * np.where(hh < 0.9, sp, 1.0))[:, None]
    return np.clip(c, 0, 1)


def emit(mat, P, N, UV, I, tint="#ffffff", dirt=True, var=0.10, colors=None):
    R, t = TX[-1]
    Pw = P @ R.T + t
    Nw = N @ R.T
    C = colors if colors is not None else vcolor(Pw, tint, dirt, var)
    if mat not in G:
        G[mat] = Acc()
    G[mat].add(Pw.astype(np.float32), Nw.astype(np.float32), UV.astype(np.float32), C.astype(np.float32), np.asarray(I, dtype=np.int64))


def _uvproj(P, proj, tile, uvo):
    if proj == "x":
        uv = np.stack([P[:, 2], -P[:, 1]], 1)
    elif proj == "z":
        uv = np.stack([P[:, 0], -P[:, 1]], 1)
    else:
        uv = np.stack([P[:, 0], P[:, 2]], 1)
    return uv / tile + np.asarray(uvo)


def quad(mat, a, b, c, d, proj="z", tint="#ffffff", tile=1.0, uvo=(0, 0), nu=1, nv=1, dirt=True, var=0.10, uvs=None, vsplit=True):
    a, b, c, d = (np.asarray(v, dtype=np.float64) for v in (a, b, c, d))
    n = np.cross(b - a, d - a)
    ln = np.linalg.norm(n)
    if ln < 1e-9:
        return
    n = n / ln
    us = np.linspace(0, 1, nu + 1)
    vs = list(np.linspace(0, 1, nv + 1))
    R, t = TX[-1]
    if vsplit and dirt and HG is not None and abs((d - a)[0]) < 1e-9 and abs((d - a)[2]) < 1e-9 and (d - a)[1] > 0.4:
        wa, wd = R @ a + t, R @ d + t
        if abs((R @ (d - a))[0]) < 1e-6 and abs((R @ (d - a))[2]) < 1e-6:
            g = float(gh(wa[0], wa[2]))
            for off in (0.15, 0.6):
                f = (g + off - wa[1]) / (wd[1] - wa[1])
                if 0.03 < f < 0.97:
                    vs.append(f)
            vs = sorted(set(vs))
    vs = np.array(vs)
    U, V = np.meshgrid(us, vs)
    P = (a[None, None, :] * ((1 - U) * (1 - V))[..., None] + b[None, None, :] * (U * (1 - V))[..., None]
         + c[None, None, :] * (U * V)[..., None] + d[None, None, :] * ((1 - U) * V)[..., None]).reshape(-1, 3)
    uv = _uvproj(P, proj, tile, uvo) if uvs is None else (np.asarray(uvs[0]) * ((1 - U) * (1 - V))[..., None] + np.asarray(uvs[1]) * (U * (1 - V))[..., None] + np.asarray(uvs[2]) * (U * V)[..., None] + np.asarray(uvs[3]) * ((1 - U) * V)[..., None]).reshape(-1, 2)
    nvv, nuu = len(vs), len(us)
    I = []
    for j in range(nvv - 1):
        for i in range(nuu - 1):
            k = j * nuu + i
            I.append((k, k + 1, k + nuu + 1))
            I.append((k, k + nuu + 1, k + nuu))
    emit(mat, P, np.tile(n, (len(P), 1)), uv, np.array(I), tint, dirt, var)


def tri(mat, a, b, c, proj="z", tint="#ffffff", tile=1.0, uvo=(0, 0), dirt=True):
    a, b, c = (np.asarray(v, dtype=np.float64) for v in (a, b, c))
    n = np.cross(b - a, c - a)
    n = n / (np.linalg.norm(n) + 1e-12)
    P = np.array([a, b, c])
    emit(mat, P, np.tile(n, (3, 1)), _uvproj(P, proj, tile, uvo), np.array([[0, 1, 2]]), tint, dirt)


def _face_mat(mat, key):
    if isinstance(mat, str):
        return mat
    if key in mat:
        return mat[key]
    if key[1] in "xz" and "side" in mat:
        return mat["side"]
    return mat.get("all")


def box(mat, x0, y0, z0, x1, y1, z1, tint="#ffffff", tile=1.0, uvo=(0, 0), bottom=False, dirt=True, var=0.10, split=4.0, tints=None, skip=()):
    xa, xb = min(x0, x1), max(x0, x1)
    ya, yb = min(y0, y1), max(y0, y1)
    za, zb = min(z0, z1), max(z0, z1)
    x0, x1, y0, y1, z0, z1 = xa, xb, ya, yb, za, zb
    ux = max(1, int((x1 - x0) / split))
    uz = max(1, int((z1 - z0) / split))
    uy = max(1, int((y1 - y0) / (split * 1.5)))
    if not dirt:
        ux = uz = uy = 1

    def tt(k):
        return tints.get(k, tint) if tints else tint

    faces = [
        ("+y", (x0, y1, z1), (x1, y1, z1), (x1, y1, z0), (x0, y1, z0), "y", ux, uz),
        ("+z", (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1), "z", ux, uy),
        ("-z", (x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0), "z", ux, uy),
        ("+x", (x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1), "x", uz, uy),
        ("-x", (x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0), "x", uz, uy),
    ]
    if bottom or (isinstance(mat, dict) and "-y" in mat):
        faces.append(("-y", (x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1), "y", ux, uz))
    for key, a, b, c, d, pj, nu, nv in faces:
        if key in skip:
            continue
        m = _face_mat(mat, key)
        if m:
            quad(m, a, b, c, d, pj, tt(key), tile, uvo, nu, nv, dirt, var)


def cyl(mat, r0, r1, y0, y1, seg=8, tint="#ffffff", tile=1.0, caps=True, uvo=(0, 0), dirt=True, var=0.08, cap_mat=None, circ_tile=None, cap_tile=None, cap_uvo=None):
    ang = np.linspace(0, 2 * math.pi, seg + 1)
    ca, sa = np.cos(ang), np.sin(ang)
    P = np.concatenate([np.stack([r0 * ca, np.full_like(ca, y0), r0 * sa], 1), np.stack([r1 * ca, np.full_like(ca, y1), r1 * sa], 1)])
    Nn = np.concatenate([np.stack([ca, np.zeros_like(ca), sa], 1)] * 2)
    circ = 2 * math.pi * max(r0, r1)
    u = ang / (2 * math.pi) * circ / tile
    v0, v1 = y0 / tile, y1 / tile
    UV = np.concatenate([np.stack([u, np.full_like(u, v0)], 1), np.stack([u, np.full_like(u, v1)], 1)]) + np.asarray(uvo)
    s1 = seg + 1
    I = []
    for i in range(seg):
        I.append((i, i + s1, i + s1 + 1))
        I.append((i, i + s1 + 1, i + 1))
    emit(mat, P, Nn, UV, np.array(I), tint, dirt, var)
    if caps:
        for top, y, r in ([c_ for c_ in ((True, y1, r1), (False, y0, r0)) if caps is True or (caps == 'top') == c_[0]]):
            if r < 1e-4:
                continue
            Pc = np.concatenate([[[0, y, 0]], np.stack([r * ca[:-1], np.full(seg, y), r * sa[:-1]], 1)])
            Nc = np.tile([0, 1.0 if top else -1.0, 0], (seg + 1, 1))
            UVc = _uvproj(Pc, "y", cap_tile or tile, cap_uvo if cap_uvo is not None else uvo)
            Ic = []
            for i in range(seg):
                j = 1 + i
                k = 1 + (i + 1) % seg
                Ic.append((0, k, j) if top else (0, j, k))
            emit(cap_mat or mat, Pc, Nc, UVc, np.array(Ic), tint, dirt, var)


def cylx(mat, x0, x1, y, z, r, **kw):
    push(rotz(-math.pi / 2), (x0, y, z))
    cyl(mat, r, kw.pop("r1", r), 0, x1 - x0, **kw)
    pop()


def cylz(mat, x, y, z0, z1, r, **kw):
    push(rotx(math.pi / 2), (x, y, z0))
    cyl(mat, r, kw.pop("r1", r), 0, z1 - z0, **kw)
    pop()


def cyly(mat, x, y0, y1, z, r, **kw):
    push(None, (x, 0, z))
    cyl(mat, r, kw.pop("r1", r), y0, y1, **kw)
    pop()


def smooth_normals(P, I):
    N = np.zeros_like(P)
    f = np.cross(P[I[:, 1]] - P[I[:, 0]], P[I[:, 2]] - P[I[:, 0]])
    for k in range(3):
        np.add.at(N, I[:, k], f)
    return N / (np.linalg.norm(N, axis=1, keepdims=True) + 1e-12)


_ICO = {}


def sphere_mesh(rings=5, segs=8):
    key = (rings, segs)
    if key in _ICO:
        return _ICO[key]
    P = [[0, 1, 0]]
    for r in range(1, rings):
        th = math.pi * r / rings
        for s in range(segs):
            ph = 2 * math.pi * s / segs
            P.append([math.sin(th) * math.cos(ph), math.cos(th), math.sin(th) * math.sin(ph)])
    P.append([0, -1, 0])
    P = np.array(P)
    I = []
    for s in range(segs):
        I.append((0, 1 + (s + 1) % segs, 1 + s))
    for r in range(rings - 2):
        for s in range(segs):
            a = 1 + r * segs + s
            b = 1 + r * segs + (s + 1) % segs
            c = a + segs
            d = b + segs
            I.append((a, b, d))
            I.append((a, d, c))
    last = len(P) - 1
    for s in range(segs):
        I.append((last, 1 + (rings - 2) * segs + s, 1 + (rings - 2) * segs + (s + 1) % segs))
    _ICO[key] = (P, np.array(I))
    return _ICO[key]


def rock(mat, cx, cy, cz, rx, ry, rz, seed=0, rings=5, segs=8, tint="#ffffff", rough=0.28, rot=0.0, tile=2.0, sink=0.0):
    P0, I = sphere_mesh(rings, segs)
    rs = np.random.RandomState(seed)
    d = 1 + rough * (rs.rand(len(P0)) - 0.5) * 2
    d[0] = d[-1] = 1
    P = P0 * d[:, None] * np.array([rx, ry, rz])
    P = P @ roty(rot).T
    N = smooth_normals(P, I)
    Pw = P + np.array([cx, cy, cz])
    # triplanar-ish uv: pick projection by dominant normal
    uv = np.where((np.abs(N[:, 1]) > 0.55)[:, None], np.stack([Pw[:, 0], Pw[:, 2]], 1), np.where((np.abs(N[:, 0]) > np.abs(N[:, 2]))[:, None], np.stack([Pw[:, 2], -Pw[:, 1]], 1), np.stack([Pw[:, 0], -Pw[:, 1]], 1))) / tile
    emit(mat, Pw, N, uv, I, tint, True, 0.12)


# ----------------------------------------------------------------------------------------------
# materials
# ----------------------------------------------------------------------------------------------
MATS = {
    # name: (generator, N_albedo, N_norm_orm, glass/alpha, extras)
    "log": (tex_log, 512, 512),
    "stone": (tex_stone, 512, 512),
    "shingle": (tex_shingle, 512, 512),
    "planks": (tex_planks, 512, 512),
    "paint": (tex_paint, 256, 256),
    "metal": (tex_metal, 256, 256),
    "rock": (tex_rock, 512, 256),
    "cloth": (tex_cloth, 128, 128),
    "ground": (tex_groundfar, 512, 256),
}

# ----------------------------------------------------------------------------------------------
# building helpers
# ----------------------------------------------------------------------------------------------
RS = np.random.RandomState(1234)
LOGTINTS = ["#ffffff", "#e9dccb", "#d7c3a8", "#f3e6d3", "#c9b08f"]
WALLT = {"N": ["#cdbfa6", "#c2ad90", "#d6c6aa"], "S": ["#f6f2ea", "#ece5d8", "#e2d9c6"], "W": LOGTINTS, "E": LOGTINTS}


def hexa(mat, P8, proj_auto=True, tint="#ffffff", tile=1.0, faces="all", tints=None, dirt=True):
    """General 8 corner hexahedron. P8: bottom 4 (ccw seen from above: (x0,z0),(x1,z0),(x1,z1),(x0,z1)) then top 4."""
    P8 = [np.asarray(p, dtype=np.float64) for p in P8]
    b0, b1, b2, b3, t0, t1, t2, t3 = P8
    F = {
        "+y": (t3, t2, t1, t0),
        "+z": (b3, b2, t2, t3),
        "-z": (b1, b0, t0, t1),
        "+x": (b2, b1, t1, t2),
        "-x": (b0, b3, t3, t0),
        "-y": (b0, b1, b2, b3),
    }
    for k, (a, b, c, d) in F.items():
        if k == "-y" and not (isinstance(mat, dict) and "-y" in mat):
            continue
        m = _face_mat(mat, k)
        if not m:
            continue
        n = np.cross(b - a, d - a)
        ax = int(np.argmax(np.abs(n)))
        pj = ["x", "y", "z"][ax]
        quad(m, a, b, c, d, pj, (tints or {}).get(k, tint), tile, (0, 0), 1, 1, dirt)


def stone_base_ring(x0, z0, x1, z1, ytop, ops_by_wall, t=0.5, yb=-0.6, tint="#ffffff"):
    # four walls, split at door openings (sill at base)
    for wall, (a0, a1, fixed_lo, fixed_hi, axis) in {
        "N": (x0, x1, z0, z0 + t, "x"), "S": (x0, x1, z1 - t, z1, "x"),
        "W": (z0 + t, z1 - t, x0, x0 + t, "z"), "E": (z0 + t, z1 - t, x1 - t, x1, "z")}.items():
        ops = [o for o in ops_by_wall.get(wall, []) if o["y0"] < 0.5]
        cuts = sorted((o["c"] - o["w"] / 2, o["c"] + o["w"] / 2) for o in ops)
        segs, cur = [], a0
        for lo, hi in cuts:
            if lo > cur:
                segs.append((cur, lo))
            cur = max(cur, hi)
        if cur < a1:
            segs.append((cur, a1))
        for s0, s1 in segs:
            if axis == "x":
                box("stone", s0, yb, fixed_lo, s1, ytop, fixed_hi, tint, 1.5)
            else:
                box("stone", fixed_lo, yb, s0, fixed_hi, ytop, s1, tint, 1.5)
        for lo, hi in cuts:  # threshold slab
            if axis == "x":
                box("stone", lo, yb, fixed_lo, hi, 0.06, fixed_hi, tint, 1.5)
            else:
                box("stone", fixed_lo, yb, lo, fixed_hi, 0.06, hi, tint, 1.5)


def log_run(axis, fixed, a0, a1, yc, r, ops, seg=6, tints=None):
    cuts = sorted((o["c"] - o["w"] / 2, o["c"] + o["w"] / 2) for o in ops if o["y0"] < yc + r and o["y1"] > yc - r)
    segs, cur = [], a0
    for lo, hi in cuts:
        if lo > cur:
            segs.append((cur, lo))
        cur = max(cur, hi)
    if cur < a1:
        segs.append((cur, a1))
    for s0, s1 in segs:
        if s1 - s0 < 0.08:
            continue
        rr = r * (0.94 + 0.12 * RS.rand())
        tt_ = tints or LOGTINTS
        tint = tt_[RS.randint(len(tt_))]
        uvo = (RS.rand(), RS.rand())
        e0, e1 = abs(s0 - a0) < 1e-6, abs(s1 - a1) < 1e-6
        cp = True if (e0 and e1) else ('top' if e1 else ('bottom' if e0 else False))
        if axis == "x":
            cylx("log", s0, s1, yc, fixed, rr, seg=seg, tint=tint, uvo=uvo, caps=cp, cap_mat="endgrain", cap_tile=2 * rr, cap_uvo=(0.5, 0.5))
        else:
            cylz("log", fixed, yc, s0, s1, rr, seg=seg, tint=tint, uvo=uvo, caps=cp, cap_mat="endgrain", cap_tile=2 * rr, cap_uvo=(0.5, 0.5))


def log_walls(x0, z0, x1, z1, ybase, ytop, ops, gable=None, r=0.17, inset=0.2, ext=0.32, pitch=0.5):
    """Notched log walls. gable=(ridge_y) raises the W/E walls to a gable (ridge along X)."""
    k = 0
    while True:
        yc = ybase + r + k * 0.30
        if yc + r > ytop + 1e-6:
            break
        for wall, fixed in (("N", z0 + inset), ("S", z1 - inset)):
            log_run("x", fixed, x0 - ext, x1 + ext, yc, r, ops.get(wall, []), tints=WALLT[wall])
        k += 1
    k = 0
    ztop = gable if gable else ytop
    while True:
        yc = ybase + r + 0.15 + k * 0.30
        if yc + r > ztop + 1e-6:
            break
        zm = (z0 + z1) / 2
        if gable and yc + r > ytop:
            hs = (gable - (yc + r)) / pitch
            hs = min(hs, (z1 - z0) / 2 + ext)
            if hs < 0.15:
                k += 1
                continue
            a0, a1 = zm - hs, zm + hs
        else:
            a0, a1 = z0 - ext, z1 + ext
        for wall, fixed in (("W", x0 + inset), ("E", x1 - inset)):
            log_run("z", fixed, a0, a1, yc, r, ops.get(wall, []), tints=WALLT[wall])
        k += 1


def wall_colliders(wall, x0, z0, x1, z1, t, ops, ylo, yhi, glass=True, flags=F_WALL):
    """Wall boxes with holes for the openings. Windows get a glass pane box."""
    if wall in "NS":
        a0, a1 = x0, x1
        lo_f, hi_f = (z0, z0 + t) if wall == "N" else (z1 - t, z1)
    else:
        a0, a1 = z0 + t, z1 - t
        lo_f, hi_f = (x0, x0 + t) if wall == "W" else (x1 - t, x1)

    def B(s0, s1, ya, yb, fl=flags, sf=S_WOOD):
        if yb - ya < 1e-3 or s1 - s0 < 1e-3:
            return
        if wall in "NS":
            col(s0, ya, lo_f, s1, yb, hi_f, fl, sf)
        else:
            col(lo_f, ya, s0, hi_f, yb, s1, fl, sf)

    cuts = sorted(((o["c"] - o["w"] / 2, o["c"] + o["w"] / 2, o) for o in ops if o["y1"] > ylo and o["y0"] < yhi), key=lambda v: v[0])
    cur = a0
    for lo, hi, o in cuts:
        B(cur, lo, ylo, yhi)
        B(lo, hi, ylo, max(ylo, o["y0"]))
        B(lo, hi, min(yhi, o["y1"]), yhi)
        if o["kind"] == "win" and glass:
            B(lo, hi, max(ylo, o["y0"]), min(yhi, o["y1"]), F_GLASS, S_GLASS)
        cur = max(cur, hi)
    B(cur, a1, ylo, yhi)


def face(key, x0, y0, z0, x1, y1, z1, mat="paint", tint="#ffffff", tile=1.0, dirt=True):
    F = {
        "+y": ((x0, y1, z1), (x1, y1, z1), (x1, y1, z0), (x0, y1, z0), "y"),
        "-y": ((x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1), "y"),
        "+z": ((x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1), "z"),
        "-z": ((x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0), "z"),
        "+x": ((x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1), "x"),
        "-x": ((x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0), "x"),
    }[key]
    quad(mat, F[0], F[1], F[2], F[3], F[4], tint, tile, (0, 0), 1, 1, dirt, vsplit=False)


def frame_opening(wall, outer, c, w, y0, y1, kind="win", tint="#e8e2d2", depth=0.5, glass=True, mull=True):
    """Window/door frame built from single faces (cheap): reveals, casing, sill, glass, mullions."""
    s = {"N": -1, "S": 1, "W": -1, "E": 1}[wall]
    fx = wall in "NS"
    cw = 0.10
    inn = outer - s * depth
    hw = w / 2

    def F(which, a0, a1, ya, yb, o0, o1, mat="paint", tn=tint):
        lo, hi = min(o0, o1), max(o0, o1)
        if fx:
            key = {"front": "+z" if s > 0 else "-z", "left": "+x", "right": "-x", "top": "+y", "bot": "-y"}[which]
            face(key, a0, ya, lo, a1, yb, hi, mat, tn)
        else:
            key = {"front": "+x" if s > 0 else "-x", "left": "+z", "right": "-z", "top": "+y", "bot": "-y"}[which]
            face(key, lo, ya, a0, hi, yb, a1, mat, tn)

    F("left", c - hw, c - hw, y0, y1, outer, inn)
    F("right", c + hw, c + hw, y0, y1, outer, inn)
    F("bot", c - hw, c + hw, y1, y1, outer, inn)
    if kind == "win":
        F("top", c - hw, c + hw, y0, y0, outer, inn, "planks", "#d9cdb8")
    ys0 = y0 if kind == "door" else y0 - cw
    p1 = outer + s * 0.05
    F("front", c - hw - cw, c - hw, ys0, y1 + cw, p1, p1)
    F("front", c + hw, c + hw + cw, ys0, y1 + cw, p1, p1)
    F("front", c - hw - cw, c + hw + cw, y1, y1 + cw, p1, p1)
    if kind == "win":
        F("front", c - hw - cw, c + hw + cw, y0 - cw, y0, p1, p1)
        F("top", c - hw - 0.14, c + hw + 0.14, y0 - cw, y0 - cw, outer, outer + s * 0.16, "planks", "#d9cdb8")
        F("front", c - hw - 0.14, c + hw + 0.14, y0 - cw - 0.05, y0 - cw, outer + s * 0.16, outer + s * 0.16, "planks", "#d9cdb8")
        om = outer - s * depth * 0.5
        if glass:
            if fx:
                quad("glass", (c - hw, y0, om), (c + hw, y0, om), (c + hw, y1, om), (c - hw, y1, om), "z", dirt=False)
            else:
                quad("glass", (om, y0, c - hw), (om, y0, c + hw), (om, y1, c + hw), (om, y1, c - hw), "x", dirt=False)
        if mull:
            nvm = 1 if w < 2.0 else 3
            for i in range(1, nvm + 1):
                cc = c - hw + w * i / (nvm + 1)
                for sg in (1, -1):
                    pp = om + sg * s * 0.02
                    F("front" if sg > 0 else "front", cc - 0.02, cc + 0.02, y0, y1, pp, pp) if sg > 0 else F("front", cc - 0.02, cc + 0.02, y0, y1, pp, pp)
            ym = (y0 + y1) / 2
            for sg in (1, -1):
                pp = om + sg * s * 0.02
                F("front", c - hw, c + hw, ym - 0.02, ym + 0.02, pp, pp)


def door_leaf(wall, outer, c, w, h, hinge_side=1, tint="#7a5a3c"):
    s = {"N": -1, "S": 1, "W": -1, "E": 1}[wall]
    off = outer + s * 0.16
    a0 = c + hinge_side * (w / 2 + 0.12)
    a1 = a0 + hinge_side * (w - 0.1)
    lo, hi = min(a0, a1), max(a0, a1)
    if wall in "NS":
        box({"side": "planks", "+y": "planks", "+z": "planks", "-z": "planks"}, lo, 0.05, off - 0.025, hi, h, off + 0.025, tint, 0.9, dirt=True)
    else:
        box({"side": "planks", "+y": "planks", "+x": "planks", "-x": "planks"}, off - 0.025, 0.05, lo, off + 0.025, h, hi, tint, 0.9, dirt=True)


def railing(x0, z0, x1, z1, y0, h=1.0, tint="#5a3d25", sp=0.16, post_every=2.4, collide=True, end_posts=True):
    L = math.hypot(x1 - x0, z1 - z0)
    if L < 0.05:
        return
    ang = math.atan2(-(z1 - z0), x1 - x0)
    push(roty(ang), (x0, y0, z0))
    box("planks", 0, h - 0.07, -0.05, L, h + 0.02, 0.05, tint, 0.8)
    box("planks", 0, 0.28, -0.04, L, 0.34, 0.04, tint, 0.8)
    n = max(2, int(L / 0.27))
    for i in range(1, n):
        x = L * i / n
        box("planks", x - 0.02, 0.34, -0.02, x + 0.02, h - 0.07, 0.02, tint, 0.8, dirt=False, skip=("+y",))
    np_ = max(1, int(round(L / post_every)))
    for i in range(np_ + 1):
        if not end_posts and i in (0, np_):
            continue
        x = L * i / np_
        box("log", x - 0.06, 0, -0.06, x + 0.06, h + 0.06, 0.06, tint, 0.8)
    pop()
    if collide:
        col_rot((x0 + x1) / 2, (z0 + z1) / 2, L / 2, 0.06, ang, y0, y0 + h, F_SOLID | F_CAMERA, S_WOOD)


def gable_roof(cx, cz, w, d, yeave, pitch, over, axis="x", thick=0.18, mats=None, ridge_cap=True, tint="#ffffff", fascia="#3b2a1c", slice_col=True, flags=F_WALL, gutter=True, rafters=True):
    """Gable roof; ridge along axis. w = length along ridge, d = span across. yeave = wall top height."""
    half = d / 2
    hs = half + over
    ridge = yeave + half * math.tan(pitch)
    L = hs / math.cos(pitch)
    wl = w / 2 + over
    mats = mats or {"+y": "shingle", "-y": "planks", "side": "paint"}
    for sgn in (1, -1):
        base = roty(0 if axis == "x" else -math.pi / 2)
        push(base, (cx, 0, cz))
        push(roty(0 if sgn > 0 else math.pi), (0, ridge, 0))
        push(rotx(pitch), (0, 0, 0))
        box(mats, -wl, -thick, 0, wl, 0, L, tint, 1.0, tints={"+x": fascia, "-x": fascia, "+z": fascia, "-z": fascia}, dirt=False, split=99)
        pop()
        pop()
        pop()
    # ridge cap
    push(roty(0 if axis == "x" else -math.pi / 2), (cx, ridge, cz))
    push(rotx(math.pi / 4), (0, 0, 0))
    box("shingle", -wl, -0.17, -0.17, wl, 0.17, 0.17, "#7a7a7a", 1.0, dirt=False)
    pop()
    pop()
    # rafters visible below (every 1.6m) + ridge beam
    if rafters:
        push(roty(0 if axis == "x" else -math.pi / 2), (cx, 0, cz))
        n = int(w // 1.8)
        for i in range(n + 1):
            x = -w / 2 + w * i / max(n, 1)
            for sgn in (1, -1):
                push(roty(0 if sgn > 0 else math.pi), (x, ridge - 0.2, 0))
                push(rotx(pitch), (0, 0, 0))
                box("log", -0.07, -0.26, 0.2, 0.07, -0.16, L - 0.25, "#d0b898", 1.0, dirt=False, split=99)
                pop()
                pop()
        box("log", -wl, ridge - 0.45, -0.12, wl, ridge - 0.25, 0.12, "#c8ad8a", 1.0, dirt=False)
        pop()
    # gutters
    if gutter:
        ylow = ridge - hs * math.tan(pitch) - thick * 0.9
        for sgn in (1, -1):
            if axis == "x":
                cylx("metal", cx - wl, cx + wl, ylow - 0.03, cz + sgn * (hs + 0.03), 0.065, seg=6, tint="#3a3d3f", caps=True, dirt=False)
            else:
                cylz("metal", cx + sgn * (hs + 0.03), ylow - 0.03, cz - wl, cz + wl, 0.065, seg=6, tint="#3a3d3f", caps=True, dirt=False)
    if slice_col:
        # stepped colliders that stay below the roof surface
        nsl = max(3, int(hs / 0.9))
        for sgn in (1, -1):
            for i in range(nsl):
                s0 = hs * i / nsl
                s1 = hs * (i + 1) / nsl
                yt = ridge - s1 * math.tan(pitch) - thick * 0.5
                yb = yt - 0.35
                if axis == "x":
                    zz0, zz1 = (cz + sgn * s0, cz + sgn * s1)
                    col(cx - wl, yb, min(zz0, zz1), cx + wl, yt, max(zz0, zz1), flags, S_WOOD)
                else:
                    xx0, xx1 = (cx + sgn * s0, cx + sgn * s1)
                    col(min(xx0, xx1), yb, cz - wl, max(xx0, xx1), yt, cz + wl, flags, S_WOOD)
    return ridge


def shed_roof(x0, z0, x1, z1, y_hi, y_lo, axis="z", over=0.3, mat="metal", thick=0.1, tint="#ffffff", col_flags=F_WALL):
    """Mono-pitch roof sloping along `axis` from high (min side) to low (max side)."""
    if axis == "z":
        L = (z1 - z0) + 2 * over
        a = math.atan2(y_hi - y_lo, z1 - z0)
        Ls = L / math.cos(a)
        push(rotx(a), (0, 0, 0))
        pop()
        push(None, (0, y_hi + math.tan(a) * over, z0 - over))
        push(rotx(a))
        box({"+y": mat, "-y": "planks", "side": "paint"}, x0 - over, -thick, 0, x1 + over, 0, Ls, tint, 1.0, dirt=False, split=99, tints={"+x": "#3b2a1c", "-x": "#3b2a1c", "+z": "#3b2a1c", "-z": "#3b2a1c"})
        pop()
        pop()
        n = 3
        for i in range(n):
            za, zb = z0 + (z1 - z0) * i / n, z0 + (z1 - z0) * (i + 1) / n
            yt = y_hi - (zb - z0) * (y_hi - y_lo) / (z1 - z0) - thick
            col(x0 - over, yt - 0.3, za, x1 + over, yt, zb, col_flags, S_METAL)
    else:
        L = (x1 - x0) + 2 * over
        a = math.atan2(y_hi - y_lo, x1 - x0)
        Ls = L / math.cos(a)
        push(roty(-math.pi / 2), (x0 - over, y_hi + math.tan(a) * over, 0))
        push(rotx(a))
        box({"+y": mat, "-y": "planks", "side": "paint"}, -z1 - over, -thick, 0, -z0 + over, 0, Ls, tint, 1.0, dirt=False, split=99)
        pop()
        pop()
        n = 3
        for i in range(n):
            xa, xb = x0 + (x1 - x0) * i / n, x0 + (x1 - x0) * (i + 1) / n
            yt = y_hi - (xb - x0) * (y_hi - y_lo) / (x1 - x0) - thick
            col(xa, yt - 0.3, z0 - over, xb, yt, z1 + over, col_flags, S_METAL)


def stairs_box(x0, z0, x1, z1, rise_total, n, axis="x", dirn=1, mat="planks", tint="#8a6a48", ybase=0.0, collide=True, width_trim=True):
    """Box stairs. axis x: climbing along +x if dirn=1."""
    rh = rise_total / n
    if axis == "x":
        run = (x1 - x0) / n
        for i in range(n):
            xa = x0 + run * i if dirn > 0 else x1 - run * (i + 1)
            xb = xa + run
            top = ybase + rh * (i + 1)
            box({"+y": mat, "side": "planks"}, xa, ybase, z0, xb, top, z1, tint, 0.8, dirt=False)
            if collide:
                col(xa, ybase, z0, xb, top, z1, F_WALL, S_WOOD)
    else:
        run = (z1 - z0) / n
        for i in range(n):
            za = z0 + run * i if dirn > 0 else z1 - run * (i + 1)
            zb = za + run
            top = ybase + rh * (i + 1)
            box({"+y": mat, "side": "planks"}, x0, ybase, za, x1, top, zb, tint, 0.8, dirt=False)
            if collide:
                col(x0, ybase, za, x1, top, zb, F_WALL, S_WOOD)


# ----------------------------------------------------------------------------------------------
# props
# ----------------------------------------------------------------------------------------------
def crate(x, z, s=0.9, rot=0.0, tint="#b99466", stack=1, cover=True):
    y = float(gh(x, z))
    push(roty(rot), (x, y, z))
    for k in range(stack):
        yy = k * s
        h = s / 2
        box("planks", -h, yy, -h, h, yy + s, h, tint, 0.9, dirt=(k == 0))
        for sx in (-1, 1):
            for sz in (-1, 1):
                box("planks", sx * h - 0.04 * 1, yy, sz * h - 0.04, sx * h + 0.04, yy + s, sz * h + 0.04, "#6e5236", 0.5, dirt=False)
        box("planks", -h - 0.01, yy + s * 0.46, -h - 0.01, h + 0.01, yy + s * 0.54, h + 0.01, "#6e5236", 0.5, dirt=False)
    pop()
    if cover:
        col_rot(x, z, s / 2, s / 2, rot, y, y + s * stack, F_DEFAULT, S_WOOD)
    reserve_c(x, z, s * 0.9)


def barrel(x, z, h=0.95, r=0.31, tint="#3b5a7a", mat="metal", cover=True):
    y = float(gh(x, z))
    cyly(mat, x, y, y + h, z, r, seg=12, tint=tint, tile=1.0)
    for f in (0.18, 0.5, 0.82):
        cyly("metal", x, y + h * f - 0.02, y + h * f + 0.02, z, r * 1.025, seg=12, tint="#2b2d2e", tile=1.0, dirt=False)
    cyly("metal", x, y + h, y + h + 0.015, z, r * 0.92, seg=12, tint="#44484a", dirt=False)
    if cover:
        col(x - r * 0.9, y, z - r * 0.9, x + r * 0.9, y + h, z + r * 0.9, F_DEFAULT, S_METAL)
    reserve_c(x, z, r * 1.5)


def firewood(x, z, rot=0.0, L=1.0, cols=8, rows=5, r=0.075):
    y = float(gh(x, z))
    push(roty(rot), (x, y, z))
    for j in range(rows):
        for i in range(cols):
            xx = (i - (cols - 1) / 2) * r * 2.05 + (r if j % 2 else 0)
            yy = r + j * r * 1.8
            cylz("log", xx, yy, -L / 2, L / 2, r * (0.85 + 0.3 * RS.rand()), seg=5, tint=LOGTINTS[RS.randint(5)], uvo=(RS.rand(), RS.rand()), caps='top', dirt=(j == 0))
    # stake posts
    for sx in (-1, 1):
        box("log", sx * (cols * r * 1.05 + 0.04) - 0.04, 0, -L / 2 - 0.0, sx * (cols * r * 1.05 + 0.04) + 0.04, rows * r * 1.9, -L / 2 + 0.08, "#8a6a48", 0.6, dirt=False)
    pop()
    col_rot(x, z, cols * r * 1.05, L / 2, rot, y, y + rows * r * 1.8 + 0.1, F_DEFAULT, S_WOOD)
    reserve_c(x, z, L * 0.8)


def bench(x, z, rot=0.0, L=1.8, y=None, tint="#7a5a3c", back=False, cover=False):
    y = float(gh(x, z)) if y is None else y
    push(roty(rot), (x, y, z))
    box("planks", -L / 2, 0.42, -0.2, L / 2, 0.47, 0.2, tint, 0.7)
    for sx in (-1, 1):
        box("planks", sx * (L / 2 - 0.15) - 0.04, 0, -0.17, sx * (L / 2 - 0.15) + 0.04, 0.42, 0.17, tint, 0.7)
    if back:
        box("planks", -L / 2, 0.75, -0.21, L / 2, 0.9, -0.17, tint, 0.7)
        for sx in (-1, 1):
            box("planks", sx * (L / 2 - 0.15) - 0.04, 0.42, -0.22, sx * (L / 2 - 0.15) + 0.04, 0.95, -0.16, tint, 0.7)
    pop()
    if cover:
        col_rot(x, z, L / 2, 0.2, rot, y, y + 0.5, F_SOLID | F_CAMERA, S_WOOD)


def picnic_table(x, z, rot=0.0):
    y = float(gh(x, z))
    push(roty(rot), (x, y, z))
    box("planks", -1.0, 0.72, -0.4, 1.0, 0.77, 0.4, "#8a6a48", 0.7)
    for sz in (-1, 1):
        box("planks", -1.0, 0.43, sz * 0.78 - 0.14, 1.0, 0.47, sz * 0.78 + 0.14, "#7c5d3c", 0.7)
    for sx in (-0.7, 0.7):
        for sgn in (-1, 1):
            push(rotx(sgn * 0.5), (sx, 0, 0))
            box("planks", -0.04, 0.0, -0.04, 0.04, 0.85, 0.04, "#6a4e32", 0.7, dirt=False)
            pop()
        box("planks", sx - 0.04, 0.4, -0.85, sx + 0.04, 0.46, 0.85, "#6a4e32", 0.7, dirt=False)
    pop()
    col_rot(x, z, 1.0, 0.95, rot, y, y + 0.8, F_SOLID | F_CAMERA, S_WOOD)
    reserve_c(x, z, 1.8)


def lantern_post(x, z, h=2.6, hang=False, y=None):
    y = float(gh(x, z)) if y is None else y
    if not hang:
        cyly("log", x, y, y + h, z, 0.07, seg=6, tint="#5a4128")
        box("paint", x - 0.14, y + h - 0.02, z - 0.14, x + 0.14, y + h + 0.03, z + 0.14, "#1e2022", 1.0, dirt=False)
        col(x - 0.08, y, z - 0.08, x + 0.08, y + h, z + 0.08, F_SOLID | F_BULLET | F_CAMERA, S_WOOD)
        reserve_c(x, z, 0.6)
        yl = y + h - 0.32
    else:
        yl = y
    box("glow", x - 0.09, yl, z - 0.09, x + 0.09, yl + 0.26, z + 0.09, "#ffffff", 1.0, dirt=False, bottom=True)
    for sx in (-1, 1):
        for sz in (-1, 1):
            box("paint", x + sx * 0.1 - 0.012, yl - 0.02, z + sz * 0.1 - 0.012, x + sx * 0.1 + 0.012, yl + 0.28, z + sz * 0.1 + 0.012, "#1e2022", 1.0, dirt=False)
    box("paint", x - 0.12, yl - 0.04, z - 0.12, x + 0.12, yl - 0.0, z + 0.12, "#1e2022", 1.0, dirt=False)
    box("paint", x - 0.12, yl + 0.28, z - 0.12, x + 0.12, yl + 0.32, z + 0.12, "#1e2022", 1.0, dirt=False)


def power_pole(x, z, h=9.0):
    y = float(gh(x, z))
    cyly("log", x, y - 0.3, y + h, z, 0.16, r1=0.12, seg=8, tint="#6a5a48", tile=1.2)
    box("planks", x - 1.2, y + h - 0.5, z - 0.05, x + 1.2, y + h - 0.35, z + 0.05, "#5a4a38", 0.8, dirt=False)
    box("planks", x - 0.9, y + h - 1.4, z - 0.04, x + 0.9, y + h - 1.27, z + 0.04, "#5a4a38", 0.8, dirt=False)
    col(x - 0.2, y, z - 0.2, x + 0.2, y + h, z + 0.2, F_DEFAULT, S_WOOD)
    reserve_c(x, z, 0.8)
    return [(x + dx, y + h - 0.35 + 0.1) for dx in (-1.0, 0.0, 1.0)]


def wire(p0, p1, sag=0.6, r=0.012, n=6):
    pts = []
    for i in range(n + 1):
        t = i / n
        p = np.array(p0) * (1 - t) + np.array(p1) * t
        p[1] -= sag * 4 * t * (1 - t)
        pts.append(p)
    for a, b in zip(pts[:-1], pts[1:]):
        d = b - a
        L = np.linalg.norm(d)
        # thin box oriented along d
        yaw = math.atan2(-d[2], d[0])
        pitch = math.asin(d[1] / L)
        push(roty(yaw), a)
        push(rotz(pitch))
        box("metal", 0, -r, -r, L, r, r, "#111111", 1.0, dirt=False, split=99)
        pop()
        pop()


def boulder(x, z, r, seed, flat=0.7, collide=None, tint="#ffffff", sink=0.25, rot=0.0):
    y = float(gh(x, z))
    rock("rock", x, y + r * flat * (0.5 - sink), z, r, r * flat, r * (0.8 + 0.3 * ((seed * 7) % 10) / 10), seed, 5 if r < 0.8 else 6, 8 if r < 0.8 else 10, tint, 0.28, rot, 2.5)
    if collide is None:
        collide = r >= 0.75
    if collide:
        col_rot(x, z, r * 0.78, r * 0.7, rot, y - 0.2, y + r * flat * 0.9, F_DEFAULT, S_CONCRETE)
    if r >= 0.5:
        reserve_c(x, z, r * 1.2)


def stone_wall(x0, z0, x1, z1, h=1.0, t=0.55, cap=True):
    L = math.hypot(x1 - x0, z1 - z0)
    ang = math.atan2(-(z1 - z0), x1 - x0)
    y = float(gh((x0 + x1) / 2, (z0 + z1) / 2))
    push(roty(ang), (x0, 0, z0))
    box("stone", 0, -0.5, -t / 2, L, h, t / 2, "#ffffff", 1.3, uvo=(RS.rand(), 0))
    if cap:
        box("stone", -0.03, h, -t / 2 - 0.04, L + 0.03, h + 0.1, t / 2 + 0.04, "#d8d0c4", 1.3)
    pop()
    col_rot((x0 + x1) / 2, (z0 + z1) / 2, L / 2, t / 2, ang, y - 0.3, y + h + 0.1, F_DEFAULT, S_CONCRETE)
    reserve_rot = max(L / 2, t)
    reserve_c((x0 + x1) / 2, (z0 + z1) / 2, reserve_rot * 0.9)


def hay_bale(x, z, rot=0.0, stack=1):
    y = float(gh(x, z))
    push(roty(rot), (x, y, z))
    for k in range(stack):
        box("cloth", -0.45, k * 0.45, -0.3, 0.45, (k + 1) * 0.45, 0.3, "#c9a85a", 0.6, dirt=(k == 0), var=0.18)
        for sx in (-0.2, 0.2):
            box("cloth", sx - 0.012, k * 0.45 - 0.0, -0.31, sx + 0.012, (k + 1) * 0.45 + 0.01, 0.31, "#8c6a2a", 0.6, dirt=False)
    pop()
    col_rot(x, z, 0.45, 0.3, rot, y, y + 0.45 * stack, F_DEFAULT, S_DIRT)
    reserve_c(x, z, 0.7)


def canoe(x, z, rot, L=4.6, tint="#b5472f"):
    y = float(gh(x, z))
    push(roty(rot), (x, y + 0.04, z))
    nseg = 8
    for i in range(nseg):
        t0, t1 = i / nseg, (i + 1) / nseg
        def prof(t):
            u = 2 * t - 1
            return L * (t - 0.5), 0.32 * (1 - abs(u) ** 2.2) + 0.03, 0.42 * (1 - abs(u) ** 2.4) + 0.02, 0.18 * abs(u) ** 2.0
        x0_, hw0, wd0, up0 = prof(t0)
        x1_, hw1, wd1, up1 = prof(t1)
        # hull sides (outer), flat tinted
        for sg in (-1, 1):
            quad("paint", (x0_, 0.1 + up0, sg * wd0), (x1_, 0.1 + up1, sg * wd1), (x1_, 0.1 + 0.32 + up1, sg * wd1), (x0_, 0.1 + 0.32 + up0, sg * wd0), "z", tint, 1.0) if sg < 0 else quad("paint", (x1_, 0.1 + up1, sg * wd1), (x0_, 0.1 + up0, sg * wd0), (x0_, 0.1 + 0.32 + up0, sg * wd0), (x1_, 0.1 + 0.32 + up1, sg * wd1), "z", tint, 1.0)
        # bottom
        quad("paint", (x0_, 0.1 + up0, -wd0 * 0.4), (x1_, 0.1 + up1, -wd1 * 0.4), (x1_, 0.1 + up1, wd1 * 0.4), (x0_, 0.1 + up0, wd0 * 0.4), "y", "#2b1a12", 1.0)
        # inside floor + gunwale
        quad("planks", (x0_, 0.16 + up0, wd0 * 0.4), (x1_, 0.16 + up1, wd1 * 0.4), (x1_, 0.16 + up1, -wd1 * 0.4), (x0_, 0.16 + up0, -wd0 * 0.4), "y", "#9a7a50", 1.0, dirt=False)
        for sg in (-1, 1):
            box("planks", x0_, 0.42 + up0, sg * wd0 - 0.02, x1_, 0.45 + up1, sg * wd0 + 0.02, "#8a6a48", 0.5, dirt=False) if False else None
    for sx in (-0.9, 0.0, 0.9):
        box("planks", sx - 0.05, 0.32, -0.42 * (1 - abs(sx / (L / 2)) ** 2.4), sx + 0.05, 0.37, 0.42 * (1 - abs(sx / (L / 2)) ** 2.4), "#8a6a48", 0.5, dirt=False)
    pop()
    col_rot(x, z, L / 2 * 0.9, 0.42, rot, y, y + 0.5, F_SOLID | F_CAMERA | F_BULLET, S_WOOD)
    reserve_c(x, z, L * 0.5)


def tire_stack(x, z, n=3):
    y = float(gh(x, z))
    for i in range(n):
        cyly("paint", x, y + i * 0.22, y + (i + 1) * 0.22, z, 0.36, seg=10, tint="#16171a", dirt=(i == 0))
    col(x - 0.34, y, z - 0.34, x + 0.34, y + n * 0.22, z + 0.34, F_DEFAULT, S_METAL)


def sign_post(x, z, rot=0.0, tint="#6b4a2a", w=1.2, boards=1):
    y = float(gh(x, z))
    push(roty(rot), (x, y, z))
    box("log", -0.07, 0, -0.07, 0.07, 2.2, 0.07, "#6a4e32", 0.6)
    for b in range(boards):
        yy = 1.95 - b * 0.38
        box("planks", -w / 2, yy - 0.16, -0.05, w / 2, yy + 0.16, 0.05, tint if b == 0 else "#4b6a3a", 0.5, dirt=False)
        tri("paint", (w / 2, yy + 0.16, 0.052), (w / 2, yy - 0.16, 0.052), (w / 2 + 0.25, yy, 0.052), "z", "#e8e0c8", dirt=False)
        box("paint", -w / 2 + 0.1, yy - 0.015, 0.052, w / 2 - 0.1, yy + 0.015, 0.058, "#e8e0c8", 0.5, dirt=False)
        box("paint", -w / 2 + 0.1, yy - 0.08, 0.052, w / 2 - 0.3, yy - 0.06, 0.058, "#e8e0c8", 0.5, dirt=False)
        box("paint", -w / 2 + 0.1, yy + 0.06, 0.052, w / 2 - 0.5, yy + 0.08, 0.058, "#e8e0c8", 0.5, dirt=False)
    pop()
    col(x - 0.09, y, z - 0.09, x + 0.09, y + 2.2, z + 0.09, F_SOLID | F_CAMERA, S_WOOD)
    reserve_c(x, z, 0.6)


def vehicle(x, z, rot, kind, tint):
    y = float(gh(x, z))
    push(roty(rot), (x, y, z))
    if kind == "pickup":
        L, W = 5.4, 1.95
        hexa("paint", [(-L / 2, 0.38, -W / 2), (L / 2, 0.38, -W / 2), (L / 2, 0.38, W / 2), (-L / 2, 0.38, W / 2), (-L / 2, 1.0, -W / 2), (L / 2, 1.0, -W / 2), (L / 2, 1.0, W / 2), (-L / 2, 1.0, W / 2)], tint=tint, tile=1.2)
        hexa("paint", [(-0.1, 1.0, -W / 2 + 0.05), (1.9, 1.0, -W / 2 + 0.05), (1.9, 1.0, W / 2 - 0.05), (-0.1, 1.0, W / 2 - 0.05), (0.35, 1.72, -W / 2 + 0.2), (1.35, 1.72, -W / 2 + 0.2), (1.35, 1.72, W / 2 - 0.2), (0.35, 1.72, W / 2 - 0.2)], tint=tint, tile=1.2, tints={"+x": "#12171b", "-x": "#12171b", "+z": "#12171b", "-z": "#12171b"})
        box("paint", -L / 2 + 0.05, 1.0, -W / 2 + 0.05, -0.9, 1.35, -W / 2 + 0.12, tint, 1.2)  # bed sides
        box("paint", -L / 2 + 0.05, 1.0, W / 2 - 0.12, -0.9, 1.35, W / 2 - 0.05, tint, 1.2)
        box("paint", -L / 2 + 0.05, 1.0, -W / 2 + 0.05, -L / 2 + 0.12, 1.35, W / 2 - 0.05, tint, 1.2)
        box("planks", -L / 2 + 0.12, 0.9, -W / 2 + 0.12, -0.9, 1.0, W / 2 - 0.12, "#4a3c30", 0.8)
        wx = (-1.6, 1.6)
    else:
        L, W = 4.7, 1.95
        hexa("paint", [(-L / 2, 0.38, -W / 2), (L / 2, 0.38, -W / 2), (L / 2, 0.38, W / 2), (-L / 2, 0.38, W / 2), (-L / 2, 1.05, -W / 2), (L / 2, 1.05, -W / 2), (L / 2, 1.05, W / 2), (-L / 2, 1.05, W / 2)], tint=tint, tile=1.2)
        hexa("paint", [(-L / 2 + 0.2, 1.05, -W / 2 + 0.06), (L / 2 - 0.9, 1.05, -W / 2 + 0.06), (L / 2 - 0.9, 1.05, W / 2 - 0.06), (-L / 2 + 0.2, 1.05, W / 2 - 0.06), (-L / 2 + 0.45, 1.8, -W / 2 + 0.2), (L / 2 - 1.5, 1.8, -W / 2 + 0.2), (L / 2 - 1.5, 1.8, W / 2 - 0.2), (-L / 2 + 0.45, 1.8, W / 2 - 0.2)], tint=tint, tile=1.2, tints={"+x": "#12171b", "-x": "#12171b", "+z": "#12171b", "-z": "#12171b", "+y": tint})
        wx = (-1.45, 1.45)
    for xw in wx:
        for sz in (-1, 1):
            cylz("paint", xw, 0.38, sz * (W / 2 - 0.2) - 0.12, sz * (W / 2 - 0.2) + 0.12, 0.38, seg=12, tint="#111214", dirt=False)
            cylz("metal", xw, 0.38, sz * (W / 2 - 0.2) + (0.125 if sz > 0 else -0.125) - 0.01, sz * (W / 2 - 0.2) + (0.125 if sz > 0 else -0.125) + 0.01, 0.22, seg=8, tint="#aab0b3", dirt=False)
    box("metal", L / 2 - 0.05, 0.4, -W / 2 + 0.1, L / 2 + 0.1, 0.62, W / 2 - 0.1, "#2a2c2e", 1.0, dirt=False)
    box("glow", L / 2 - 0.02, 0.72, -W / 2 + 0.1, L / 2 + 0.01, 0.84, -W / 2 + 0.4, "#ffffff", 1.0, dirt=False)
    box("glow", L / 2 - 0.02, 0.72, W / 2 - 0.4, L / 2 + 0.01, 0.84, W / 2 - 0.1, "#ffffff", 1.0, dirt=False)
    pop()
    col_rot(x, z, L / 2, W / 2, rot, y, y + (1.75 if kind == "pickup" else 1.8), F_DEFAULT, S_METAL)
    reserve_rect_rot(x, z, L / 2 + 0.4, W / 2 + 0.4, rot)


def reserve_rect_rot(x, z, hx, hz, rot):
    c, s = abs(math.cos(rot)), abs(math.sin(rot))
    ex, ez = hx * c + hz * s, hx * s + hz * c
    reserve(x - ex, z - ez, x + ex, z + ez, 0.3)


def tractor(x, z, rot):
    y = float(gh(x, z))
    push(roty(rot), (x, y, z))
    red = "#8f2d1f"
    box("paint", -1.4, 0.55, -0.45, 0.9, 1.15, 0.45, red, 1.0)           # engine block
    hexa("paint", [(0.9, 0.55, -0.5), (1.5, 0.55, -0.5), (1.5, 0.55, 0.5), (0.9, 0.55, 0.5), (1.0, 1.1, -0.45), (1.4, 1.1, -0.45), (1.4, 1.1, 0.45), (1.0, 1.1, 0.45)], tint=red)
    box("paint", 0.5, 1.15, -0.5, 1.6, 1.25, 0.5, "#4a4f52", 1.0, dirt=False)  # seat deck
    for sx in (0.55, 1.5):
        for sz in (-1, 1):
            box("paint", sx - 0.03, 1.25, sz * 0.5 - 0.03, sx + 0.03, 2.5, sz * 0.5 + 0.03, "#2c3033", 1.0, dirt=False)
    box("metal", 0.45, 2.5, -0.55, 1.65, 2.58, 0.55, "#7a2a1c", 1.0, dirt=False)  # canopy
    cyly("metal", -1.1, 1.1, 1.95, 0.0, 0.05, seg=6, tint="#2a2a2a", dirt=False)
    for (xw, rw, wd) in ((-1.15, 0.5, 0.2), (1.1, 0.8, 0.38)):
        for sz in (-1, 1):
            zc = sz * (0.62 + (0.1 if rw > 0.6 else 0.0))
            cylz("paint", xw, rw, zc - wd / 2, zc + wd / 2, rw, seg=14, tint="#17181a", tile=1.5)
            cylz("paint", xw, rw, zc + sz * wd / 2 - 0.01 * sz - 0.015, zc + sz * wd / 2 + 0.015, rw * 0.55, seg=10, tint="#c9aa3a" if rw < 0.6 else "#8f2d1f", dirt=False)
    box("metal", -1.9, 0.4, -0.12, 0.0, 0.6, 0.12, "#3a3d3f", 1.0, dirt=False)
    pop()
    col_rot(x, z, 1.9, 0.9, rot, y, y + 2.0, F_DEFAULT, S_METAL)
    col_rot(x, z, 0.6, 0.6, rot, y + 2.0, y + 2.6, F_DEFAULT, S_METAL)
    reserve_rect_rot(x, z, 2.4, 1.3, rot)


def sofa(x, z, rot, L=2.0, tint="#7a3a30"):
    y = 0.04
    push(roty(rot), (x, y, z))
    box("cloth", -L / 2, 0.0, -0.45, L / 2, 0.38, 0.45, tint, 0.8, dirt=False)
    box("cloth", -L / 2, 0.38, -0.45, L / 2, 0.9, -0.28, tint, 0.8, dirt=False)
    for sx in (-1, 1):
        box("cloth", sx * (L / 2 - 0.11) - 0.11, 0.38, -0.45, sx * (L / 2 - 0.11) + 0.11, 0.62, 0.45, tint, 0.8, dirt=False)
    pop()
    col_rot(x, z, L / 2, 0.45, rot, y, y + 0.9, F_SOLID | F_CAMERA, S_WOOD)


def table(x, z, rot, L=2.0, W=0.9, h=0.76, tint="#8a6a48", chairs=True):
    y = 0.04
    push(roty(rot), (x, y, z))
    box("planks", -L / 2, h - 0.06, -W / 2, L / 2, h, W / 2, tint, 0.7, dirt=False)
    for sx in (-1, 1):
        for sz in (-1, 1):
            box("log", sx * (L / 2 - 0.1) - 0.04, 0, sz * (W / 2 - 0.1) - 0.04, sx * (L / 2 - 0.1) + 0.04, h - 0.06, sz * (W / 2 - 0.1) + 0.04, "#6a4e32", 0.7, dirt=False)
    if chairs:
        for sx in (-0.5, 0.5):
            for sz in (-1, 1):
                push(roty(0 if sz < 0 else math.pi), (sx * L * 0.5, 0, sz * (W / 2 + 0.3)))
                box("planks", -0.2, 0.43, -0.2, 0.2, 0.47, 0.2, "#7a5a3c", 0.5, dirt=False)
                box("planks", -0.2, 0.47, 0.17, 0.2, 0.95, 0.2, "#7a5a3c", 0.5, dirt=False)
                for a in (-1, 1):
                    for b in (-1, 1):
                        box("planks", a * 0.17 - 0.015, 0, b * 0.17 - 0.015, a * 0.17 + 0.015, 0.43, b * 0.17 + 0.015, "#6a4e32", 0.5, dirt=False)
                pop()
    pop()
    col_rot(x, z, L / 2, W / 2, rot, y, y + h, F_SOLID | F_CAMERA | F_BULLET, S_WOOD)


def potted(x, z, y, r=0.18, h=0.3):
    cyly("paint", x, y, y + h, z, r, r1=r * 1.25, seg=8, tint="#a8532f", tile=0.5, dirt=False)
    cyly("ground", x, y + h - 0.02, y + h, z, r * 1.1, seg=8, tint="#2a1f16", dirt=False)

# ----------------------------------------------------------------------------------------------
# more helpers + buildings
# ----------------------------------------------------------------------------------------------
def op(c, w, y0, y1, kind="win"):
    return dict(c=c, w=w, y0=y0, y1=y1, kind=kind)


def beam(p0, p1, t=0.05, mat="planks", tint="#6a4e32", t2=None):
    p0, p1 = np.array(p0, float), np.array(p1, float)
    d = p1 - p0
    L = np.linalg.norm(d)
    yaw = math.atan2(-d[2], d[0])
    pitch = math.asin(d[1] / L) if L > 1e-6 else 0
    push(roty(yaw), p0)
    push(rotz(pitch))
    box(mat, 0, -t, -(t2 or t), L, t, (t2 or t), tint, 0.7, dirt=False, split=99)
    pop()
    pop()


def shed_roof(x0, z0, x1, z1, y_hi, y_lo, high="-z", over=0.3, mat="metal", thick=0.1, tint="#ffffff", flags=F_WALL):
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    if high in ("-z", "+z"):
        span, wid = z1 - z0, x1 - x0
    else:
        span, wid = x1 - x0, z1 - z0
    rot = {"-z": 0.0, "+z": math.pi, "-x": math.pi / 2, "+x": -math.pi / 2}[high]
    edge = {"-z": (cx, z0), "+z": (cx, z1), "-x": (x0, cz), "+x": (x1, cz)}[high]
    a = math.atan2(y_hi - y_lo, span)
    Ls = (span + 2 * over) / math.cos(a)
    push(roty(rot), (edge[0], y_hi, edge[1]))
    push(None, (0, math.tan(a) * over, -over))
    push(rotx(a))
    box({"+y": mat, "-y": "planks", "side": "paint"}, -wid / 2 - over, -thick, 0, wid / 2 + over, 0, Ls, tint, 1.0, dirt=False, split=99,
        tints={"+x": "#3b2a1c", "-x": "#3b2a1c", "+z": "#3b2a1c", "-z": "#3b2a1c"})
    pop()
    pop()
    pop()
    n = 3
    for i in range(n):
        s0, s1 = span * i / n, span * (i + 1) / n
        yt = y_hi - (y_hi - y_lo) * s1 / span - thick
        if high == "-z":
            col(x0 - over, yt - 0.3, z0 + s0, x1 + over, yt, z0 + s1, flags, S_WOOD)
        elif high == "+z":
            col(x0 - over, yt - 0.3, z1 - s1, x1 + over, yt, z1 - s0, flags, S_WOOD)
        elif high == "-x":
            col(x0 + s0, yt - 0.3, z0 - over, x0 + s1, yt, z1 + over, flags, S_WOOD)
        else:
            col(x1 - s1, yt - 0.3, z0 - over, x1 - s0, yt, z1 + over, flags, S_WOOD)


def wall_pieces(wall, x0, z0, x1, z1, t, ops, ylo, yhi):
    """Yield (a0, a1, ya, yb, op) wall boxes with openings removed."""
    if wall in "NS":
        a0, a1 = x0, x1
    else:
        a0, a1 = z0 + t, z1 - t
    cuts = sorted(((o["c"] - o["w"] / 2, o["c"] + o["w"] / 2, o) for o in ops if o["y1"] > ylo and o["y0"] < yhi), key=lambda v: v[0])
    cur = a0
    for lo, hi, o in cuts:
        if lo > cur:
            yield (cur, lo, ylo, yhi, None)
        if o["y0"] > ylo:
            yield (lo, hi, ylo, o["y0"], None)
        if o["y1"] < yhi:
            yield (lo, hi, o["y1"], yhi, None)
        yield (lo, hi, max(ylo, o["y0"]), min(yhi, o["y1"]), o)
        cur = max(cur, hi)
    if cur < a1:
        yield (cur, a1, ylo, yhi, None)


def wall_colliders(wall, x0, z0, x1, z1, t, ops, ylo, yhi, glass=True, flags=F_WALL, surf=S_WOOD):
    if wall in "NS":
        lo_f, hi_f = (z0, z0 + t) if wall == "N" else (z1 - t, z1)
    else:
        lo_f, hi_f = (x0, x0 + t) if wall == "W" else (x1 - t, x1)
    for s0, s1, ya, yb, o in wall_pieces(wall, x0, z0, x1, z1, t, ops, ylo, yhi):
        if o is not None:
            if o["kind"] != "win" or not glass:
                continue
            fl, sf = F_GLASS, S_GLASS
        else:
            fl, sf = flags, surf
        if wall in "NS":
            col(s0, ya, lo_f, s1, yb, hi_f, fl, sf)
        else:
            col(lo_f, ya, s0, hi_f, yb, s1, fl, sf)


def plank_walls(x0, z0, x1, z1, t, ops_by, ylo, yhi, tint="#9a7a56", mat="planks", frame_tint="#d9d2c0", colliders=True, outer_only=False, glass=True):
    for wall in "NSWE":
        ops = ops_by.get(wall, [])
        for s0, s1, ya, yb, o in wall_pieces(wall, x0, z0, x1, z1, t, ops, ylo, yhi):
            if o is not None:
                continue
            if wall in "NS":
                lo, hi = (z0, z0 + t) if wall == "N" else (z1 - t, z1)
                box(mat, s0, ya, lo, s1, yb, hi, tint, 1.0, uvo=(RS.rand(), 0))
            else:
                lo, hi = (x0, x0 + t) if wall == "W" else (x1 - t, x1)
                box(mat, lo, ya, s0, hi, yb, s1, tint, 1.0, uvo=(RS.rand(), 0))
        outer = {"N": z0, "S": z1, "W": x0, "E": x1}[wall]
        for o in ops:
            frame_opening(wall, outer, o["c"], o["w"], o["y0"], o["y1"], o["kind"], frame_tint, depth=t, glass=glass)
        if colliders:
            wall_colliders(wall, x0, z0, x1, z1, t, ops, ylo, yhi)


def stoop(wall, c, outer, y_top=0.26, hood_y=3.0, w=2.6, d=1.6):
    s = {"N": -1, "S": 1, "W": -1, "E": 1}[wall]
    fx = wall in "NS"

    def B(a0, a1, ya, yb, o0, o1, mat="planks", tn="#8a6a48"):
        lo, hi = min(o0, o1), max(o0, o1)
        if fx:
            box(mat, a0, ya, lo, a1, yb, hi, tn, 0.8)
            col(a0, ya, lo, a1, yb, hi, F_DEFAULT, S_WOOD) if mat == "planks" and yb > 0.05 else None
        else:
            box(mat, lo, ya, a0, hi, yb, a1, tn, 0.8)
            col(lo, ya, a0, hi, yb, a1, F_DEFAULT, S_WOOD) if mat == "planks" and yb > 0.05 else None

    B(c - w / 2, c + w / 2, -0.15, y_top, outer, outer + s * d)
    B(c - w / 2 + 0.3, c + w / 2 - 0.3, -0.15, y_top / 2 + 0.02, outer + s * d, outer + s * (d + 0.4))
    reserve_rect_pt(wall, c, outer, w, d + 0.5)
    for sx in (-1, 1):
        px = c + sx * (w / 2 - 0.1)
        po = outer + s * (d - 0.15)
        if fx:
            cyly("log", px, y_top, hood_y + 0.15, po, 0.09, seg=6, tint="#d7c3a8")
            col(px - 0.09, y_top, po - 0.09, px + 0.09, hood_y, po + 0.09, F_SOLID | F_CAMERA, S_WOOD)
        else:
            cyly("log", po, y_top, hood_y + 0.15, px, 0.09, seg=6, tint="#d7c3a8")
            col(po - 0.09, y_top, px - 0.09, po + 0.09, hood_y, px + 0.09, F_SOLID | F_CAMERA, S_WOOD)
    if fx:
        z_in, z_out = (outer, outer + s * (d + 0.2))
        shed_roof(c - w / 2 - 0.1, min(z_in, z_out), c + w / 2 + 0.1, max(z_in, z_out), hood_y + 0.35, hood_y - 0.1, high="-z" if s > 0 else "+z", over=0.1, mat="shingle", flags=F_WALL)
    else:
        x_in, x_out = (outer, outer + s * (d + 0.2))
        shed_roof(min(x_in, x_out), c - w / 2 - 0.1, max(x_in, x_out), c + w / 2 + 0.1, hood_y + 0.35, hood_y - 0.1, high="-x" if s > 0 else "+x", over=0.1, mat="shingle", flags=F_WALL)


def reserve_rect_pt(wall, c, outer, w, d):
    s = {"N": -1, "S": 1, "W": -1, "E": 1}[wall]
    if wall in "NS":
        reserve(c - w / 2, outer, c + w / 2, outer + s * d, 0.5)
    else:
        reserve(outer, c - w / 2, outer + s * d, c + w / 2, 0.5)


# ----------------------------------------------------------------------------------------------
# THE LODGE
# ----------------------------------------------------------------------------------------------
def build_lodge():
    X0, X1, Z0, Z1 = -10.0, 10.0, -6.0, 6.0
    T = 0.5
    YB, YT = 1.0, 5.8
    PITCH = math.radians(28)
    RIDGE = YT + 6 * math.tan(PITCH)
    GW = (1.0, 2.15)
    UW = (3.9, 5.2)
    ops = {
        "N": [op(-5, 1.4, 0, 2.1, "door")] + [op(c, 1.3, GW[0], GW[1]) for c in (-8.2, -1.8, 2.6, 7.4)] + [op(c, 1.2, UW[0], UW[1]) for c in (-7.5, -2.5, 2.5, 7.5)],
        "S": [op(-4, 1.4, 0, 2.1, "door"), op(4, 1.4, 0, 2.1, "door"), op(-8.2, 1.3, GW[0], GW[1]), op(0, 2.4, 0.9, 2.2), op(8.2, 1.3, GW[0], GW[1])] + [op(c, 1.2, UW[0], UW[1]) for c in (-8, -4, 0, 4, 8)],
        "E": [op(0, 1.4, 0, 2.1, "door"), op(-3.6, 1.3, GW[0], GW[1]), op(3.6, 1.3, GW[0], GW[1]), op(-2.6, 1.2, UW[0], UW[1]), op(2.6, 1.2, UW[0], UW[1])],
        "W": [op(-3.8, 1.3, GW[0], GW[1]), op(3.8, 1.3, GW[0], GW[1]), op(-3.2, 1.2, UW[0], UW[1]), op(3.2, 1.2, UW[0], UW[1])],
    }
    footprint("LODGE", X0 - 1.5, Z0 - 1.2, X1 + 1.5, Z1 + 3.8, 1.0)
    # foundation + logs
    stone_base_ring(X0, Z0, X1, Z1, YB, ops, T)
    log_walls(X0, Z0, X1, Z1, YB, YT, ops, gable=8.75, pitch=math.tan(PITCH))
    chinking(X0, Z0, X1, Z1, YB, 3.0, ops)
    chinking(X0, Z0, X1, Z1, 3.0, YT, ops)
    # frames
    for wall, outer in (("N", Z0), ("S", Z1), ("W", X0), ("E", X1)):
        for o in ops[wall]:
            frame_opening(wall, outer, o["c"], o["w"], o["y0"], o["y1"], o["kind"], "#e4dcc8" if o["kind"] == "win" else "#8a6a48")
            if o["kind"] == "win" and o["y0"] < 1.5 and o["w"] < 1.6 and wall != "S":
                # window shutters (open) on ground floor windows
                for sg in (-1, 1):
                    sx = o["c"] + sg * (o["w"] / 2 + 0.1 + 0.28)
                    s = {"N": -1, "S": 1, "W": -1, "E": 1}[wall]
                    if wall in "NS":
                        box("planks", sx - 0.28, o["y0"] - 0.05, outer + s * 0.04 - 0.02, sx + 0.28, o["y1"] + 0.05, outer + s * 0.04 + 0.02 + 0.03 * s, "#3f5a46", 0.6)
                    else:
                        box("planks", outer + s * 0.04 - 0.02, o["y0"] - 0.05, sx - 0.28, outer + s * 0.04 + 0.02 + 0.03 * s, o["y1"] + 0.05, sx + 0.28, "#3f5a46", 0.6)
    door_leaf("N", Z0, -5, 1.4, 2.05, 1)
    door_leaf("E", X1, 0, 1.4, 2.05, -1)
    door_leaf("S", Z1, -4, 1.4, 2.05, -1)
    # colliders for walls (ground + upper)
    for wall in "NSWE":
        wall_colliders(wall, X0, Z0, X1, Z1, T, ops[wall], -0.6, 3.0)
        wall_colliders(wall, X0, Z0, X1, Z1, T, ops[wall], 3.0, YT)
    for sgn, (xa, xb) in ((-1, (X0, X0 + T)), (1, (X1 - T, X1))):
        n = 4
        for i in range(n):
            y0 = YT + i * (8.75 - YT) / n
            y1 = YT + (i + 1) * (8.75 - YT) / n
            hs = (8.75 - y1) / math.tan(PITCH)
            if i == n - 1:
                hs = max(hs, 0.3)
            col(xa, y0, -hs, xb, y1, hs, F_WALL, S_WOOD)
    # ground floor planks + upper slabs
    quad("planks", (X0 + T, 0.04, Z1 - T), (X1 - T, 0.04, Z1 - T), (X1 - T, 0.04, Z0 + T), (X0 + T, 0.04, Z0 + T), "y", "#a88862", 2.0, nu=4, nv=3, dirt=False, var=0.14)
    slabs = [(X0 + T, Z0 + T, X1 - T, -1.5), (7.3, -1.5, X1 - T, Z1 - T), (X0 + T, -1.5, -7.0, Z1 - T)]
    for (a, b, c_, d_) in slabs:
        box({"+y": "planks", "-y": "planks", "side": "planks"}, a, 2.75, b, c_, 3.0, d_, "#a88862", 1.8, dirt=False)
        col(a, 2.75, b, c_, 3.0, d_, F_WALL, S_WOOD)
        nb = max(2, int((c_ - a) / 2.4)) if (c_ - a) > (d_ - b) else max(2, int((d_ - b) / 2.4))
        for i in range(nb + 1):
            if (c_ - a) > (d_ - b):
                xx = a + (c_ - a) * i / nb
                box("log", xx - 0.1, 2.5, b, xx + 0.1, 2.75, d_, "#b79a76", 0.8, dirt=False)
            else:
                zz = b + (d_ - b) * i / nb
                box("log", a, 2.5, zz - 0.1, c_, 2.75, zz + 0.1, "#b79a76", 0.8, dirt=False)
    # stairs (17 risers of 0.1765)
    stairs_box(2.5, 3.6, 7.3, 5.55, 3.0, 17, "x", 1, ybase=0.0)
    beam((2.5, 0.95, 3.52), (7.3, 3.95, 3.52), 0.045, "planks", "#6a4e32", 0.045)
    for i in range(0, 17, 2):
        xs = 2.5 + (7.3 - 2.5) * (i + 0.5) / 17
        box("planks", xs - 0.025, 0.1765 * (i + 1) - 0.0, 3.5, xs + 0.025, 0.1765 * (i + 1) + 0.9, 3.55, "#6a4e32", 0.6, dirt=False)
    for i in range(17):
        xa = 2.5 + 4.8 / 17 * i
        col(xa, 0.1765 * (i + 1), 3.5, xa + 4.8 / 17, 0.1765 * (i + 1) + 0.95, 3.6, F_SOLID | F_CAMERA, S_WOOD)
    # gallery railings (void edge) + posts
    railing(-7.0, -1.5, 7.3, -1.5, 3.0, 1.05, "#6a4e32", post_every=2.4)
    railing(-7.0, -1.5, -7.0, 5.55, 3.0, 1.05, "#6a4e32", post_every=2.4)
    railing(7.3, -1.5, 7.3, 3.55, 3.0, 1.05, "#6a4e32", post_every=2.4)
    for (px, pz) in ((-7.0, -1.5), (-2.3, -1.5), (2.4, -1.5), (7.3, -1.5), (-7.0, 2.0), (-7.0, 5.3)):
        cyly("log", px, 0.04, 2.75, pz, 0.16, seg=8, tint="#d7c3a8", tile=1.0)
        col(px - 0.16, 0, pz - 0.16, px + 0.16, 2.75, pz + 0.16, F_DEFAULT, S_WOOD)
    # tie beams under roof
    for xx in ():
        pass
        for sg in (-1, 1):
            beam((xx, 6.1, sg * 4.0), (xx, 7.6 + 0.0, sg * 1.2), 0.07, "log", "#c8ad8a", 0.07) if False else None
    # fireplace + chimney
    box("stone", -9.55, 0, -1.7, -8.1, 3.0, 1.7, "#ffffff", 1.2)
    box("stone", -9.55, 3.0, -1.2, -8.6, 5.8, 1.2, "#ffffff", 1.2)
    box("stone", -8.1, 0, -2.1, -7.55, 0.22, 2.1, "#d8d0c4", 1.2)
    quad("paint", (-8.09, 0.2, 0.75), (-8.09, 0.2, -0.75), (-8.09, 1.25, -0.75), (-8.09, 1.25, 0.75), "x", "#0c0a09", dirt=False)
    box("glow", -9.0, 0.2, -0.35, -8.5, 0.5, 0.35, "#ffffff", 1.0, dirt=False)
    box("log", -8.45, 1.5, -1.95, -8.0, 1.75, 1.95, "#9a7a56", 0.8, dirt=False)
    for sg in (-1, 1):
        box("log", -8.3, 0.22, sg * 0.86 - 0.04, -8.1, 1.3, sg * 0.86 + 0.04, "#2a2623", 0.8, dirt=False)
    col(-9.55, 0, -1.7, -8.1, 5.8, 1.7, F_WALL, S_CONCRETE)
    box("stone", -11.1, -0.6, -1.55, -9.5, 4.0, 1.55, "#ffffff", 1.3)
    box("stone", -10.9, 4.0, -1.25, -9.6, 7.2, 1.25, "#ffffff", 1.3)
    box("stone", -10.7, 7.2, -0.95, -9.6, 10.3, 0.95, "#ffffff", 1.3)
    box("stone", -10.85, 10.3, -1.1, -9.5, 10.5, 1.1, "#c8c0b4", 1.3)
    box("paint", -10.55, 10.5, -0.8, -9.85, 10.55, 0.8, "#0e0d0c", 1.0, dirt=False)
    for yy in (4.0, 7.2):
        box("stone", -11.0, yy - 0.12, -1.6 if yy < 5 else -1.3, -9.5, yy, 1.6 if yy < 5 else 1.3, "#cfc7ba", 1.3)
    col(-11.1, 0, -1.55, -9.5, 4.0, 1.55, F_WALL, S_CONCRETE)
    col(-10.9, 4.0, -1.25, -9.6, 10.5, 1.25, F_WALL, S_CONCRETE)
    # roof
    gable_roof(0, 0, 20, 12, YT, PITCH, 1.0, "x", 0.2, rafters=False)
    for sx in (-1, 1):
        for sz in (-1, 1):
            cyly("metal", sx * 9.8, 0.05, 5.3, sz * 7.05, 0.045, seg=6, tint="#3a3d3f", dirt=False)
    # south porch
    PD = 0.30
    box("planks", -8.6, -0.2, 6.0, 8.6, PD, 9.3, "#8f7050", 1.6, var=0.14)
    col(-8.6, -0.3, 6.0, 8.6, PD, 9.3, F_DEFAULT, S_WOOD)
    for sx in (-8.0, -5.3, -2.65, 2.65, 5.3, 8.0):
        cyly("log", sx, PD, 3.4, 9.0, 0.12, seg=8, tint="#d2b894")
        box("log", sx - 0.2, 3.1, 8.8, sx + 0.2, 3.28, 9.2, "#c9ad88", 0.8, dirt=False)
        col(sx - 0.12, PD, 8.88, sx + 0.12, 3.4, 9.12, F_SOLID | F_CAMERA | F_BULLET, S_WOOD)
        beam((sx, 3.2, 8.9), (sx - 0.6 * (1 if sx > 0 else -1) * 0 + (0.6 if sx > 0 else -0.6) * -1, 2.6, 8.9), 0.04, "log", "#c9ad88", 0.05) if False else None
    box("log", -8.4, 3.2, 8.92, 8.4, 3.5, 9.12, "#c9ad88", 0.8, dirt=False)
    shed_roof(-8.6, 6.0, 8.6, 9.45, 3.55, 3.1, high="-z", over=0.35, mat="shingle", thick=0.14, flags=F_WALL)
    railing(-8.4, 9.05, -1.3, 9.05, PD, 1.0, "#6a4e32")
    railing(1.3, 9.05, 8.4, 9.05, PD, 1.0, "#6a4e32")
    railing(-8.4, 6.05, -8.4, 9.05, PD, 1.0, "#6a4e32")
    railing(8.4, 6.05, 8.4, 9.05, PD, 1.0, "#6a4e32")
    box("planks", -1.3, 0.0, 9.3, 1.3, 0.16, 9.75, "#8a6a48", 0.8)
    col(-1.3, 0, 9.3, 1.3, 0.16, 9.75, F_DEFAULT, S_WOOD)
    reserve(-9, 6, 9, 10, 0.5)
    for sx in (-6.6, 6.6):  # porch benches + lanterns hanging
        bench(sx, 8.6, 0, 1.6, y=PD, back=True)
    for sx in (-5.3, 5.3, 0.0):
        lantern_post(sx, 8.7, y=2.6, hang=True)
    # stoops N and E
    stoop("N", -5, Z0)
    stoop("E", 0, X1)
    # ---- interior furniture
    rug_c = hexl("#7a2f2a")
    quad("cloth", (-7.4, 0.05, 2.7), (-3.2, 0.05, 2.7), (-3.2, 0.05, -2.7), (-7.4, 0.05, -2.7), "y", "#8a3a30", 1.0, dirt=False, var=0.08)
    quad("cloth", (-7.2, 0.052, 2.5), (-3.4, 0.052, 2.5), (-3.4, 0.052, -2.5), (-7.2, 0.052, -2.5), "y", "#c9a76a", 1.0, dirt=False, var=0.08)
    sofa(-3.6, 0.0, math.pi / 2, 2.3, "#6c3a2e")
    sofa(-6.0, -3.4, 0, 2.0, "#4e5a3a")
    sofa(-6.0, 3.4, math.pi, 2.0, "#4e5a3a")
    box("planks", -6.3, 0.3, -0.6, -5.3, 0.38, 0.6, "#6a4e32", 0.7, dirt=False)
    for sx in (-6.2, -5.4):
        for sz in (-0.5, 0.5):
            box("log", sx - 0.04, 0.04, sz - 0.04, sx + 0.04, 0.3, sz + 0.04, "#4a3622", 0.6, dirt=False)
    col(-6.3, 0.04, -0.6, -5.3, 0.4, 0.6, F_SOLID | F_CAMERA, S_WOOD)
    table(-0.8, -3.4, 0.0, 2.4, 0.95)
    table(3.0, -3.0, 0.0, 2.4, 0.95)
    table(-0.5, 2.6, 0.0, 2.0, 0.9)
    # bar counter along the NE
    box("planks", 5.4, 0.04, -5.0, 9.4, 1.1, -4.1, "#7a5638", 0.8, dirt=False)
    box("planks", 5.3, 1.1, -5.05, 9.45, 1.18, -4.0, "#4a3220", 0.8, dirt=False)
    col(5.3, 0.04, -5.05, 9.45, 1.18, -4.0, F_DEFAULT, S_WOOD)
    box("planks", 9.4, 0.04, -4.1, 9.5, 1.1, -2.6, "#7a5638", 0.8, dirt=False)
    for yy in (1.3, 1.75, 2.2):
        box("planks", 5.5, yy, -5.5, 9.4, yy + 0.04, -5.15, "#6a4e32", 0.7, dirt=False)
        for i in range(10):
            cx_ = 5.7 + i * 0.37
            cyly("paint", cx_, yy + 0.04, yy + 0.04 + 0.22 + 0.04 * (i % 3), -5.33, 0.04, seg=6, tint=["#3f6a3a", "#6a4a2a", "#2d4a6a", "#7a3a30"][i % 4], dirt=False)
    for i in range(4):
        cyly("log", 6.0 + i * 1.0, 0.04, 0.72, -3.5, 0.17, seg=8, tint="#7a5638", dirt=False)
        col(5.83 + i * 1.0, 0.04, -3.67, 6.17 + i * 1.0, 0.75, -3.33, F_SOLID | F_CAMERA, S_WOOD)
    # pendant lamps
    for (lx, lz) in ((-0.8, -3.4), (3.0, -3.0), (-0.5, 2.6), (-5.3, 0.0), (7.3, -3.6)):
        box("paint", lx - 0.01, 2.0, lz - 0.01, lx + 0.01, 2.75, lz + 0.01, "#222222", 1.0, dirt=False)
        lantern_post(lx, lz, hang=True, y=1.7)
    # shelves + books on W wall interior, trophy plaque
    box("planks", -9.55, 0.04, 3.6, -9.05, 2.6, 5.4, "#6a4e32", 0.7, dirt=False)
    col(-9.55, 0.04, 3.6, -9.05, 2.6, 5.4, F_SOLID | F_CAMERA, S_WOOD)
    # upper floor props
    push(None, (0, 2.96, 0))
    YO[0] = 2.96
    sofa(3.0, -3.3, 0, 2.1, "#3e4f60")
    pop()
    YO[0] = 0.0
    table(-3.0, -3.4, 0.0, 1.8, 0.8, chairs=False) if False else None
    push(None, (0, 3.0, 0))
    YO[0] = 3.0 - 0.04
    for (bx, bz, br) in ((8.7, 1.0, math.pi / 2), (8.7, 3.6 - 3.0, math.pi / 2)):
        pass
    pop()
    YO[0] = 0.0
    # bed + desk on the upper landing (east block), bookshelf on north wall
    push(None, (0, 3.0, 0))
    box("planks", 8.2, 0.0, -0.9, 9.5, 0.35, 1.5, "#6a4e32", 0.7, dirt=False)
    box("cloth", 8.25, 0.35, -0.85, 9.45, 0.55, 1.45, "#8a3a30", 0.7, dirt=False)
    box("cloth", 8.25, 0.55, -0.85, 9.45, 0.7, -0.2, "#d8d2c4", 0.7, dirt=False)
    box("planks", -9.4, 0.0, -5.45, -6.0, 2.0, -5.05, "#6a4e32", 0.7, dirt=False)
    for i in range(14):
        box("cloth", -9.3 + i * 0.24, 0.5 + 0.5 * (i % 3), -5.4, -9.3 + i * 0.24 + 0.18, 0.5 + 0.5 * (i % 3) + 0.38, -5.12, ["#7a3a30", "#2d4a6a", "#4e6a3a", "#8a6a3a"][i % 4], 0.5, dirt=False)
    box("planks", 4.5, 0.0, -5.4, 6.7, 0.78, -4.6, "#7a5638", 0.7, dirt=False)
    pop()
    col(8.2, 3.0, -0.9, 9.5, 3.55, 1.5, F_SOLID | F_CAMERA, S_WOOD)
    col(-9.4, 3.0, -5.45, -6.0, 5.0, -5.05, F_SOLID | F_CAMERA, S_WOOD)
    col(4.5, 3.0, -5.4, 6.7, 3.78, -4.6, F_SOLID | F_CAMERA, S_WOOD)
    # roof stays visible for sightlines; zones
    PROPS_INFO["lodge_ridge"] = RIDGE


# ----------------------------------------------------------------------------------------------
# CABIN (west lane)
# ----------------------------------------------------------------------------------------------
def build_cabin():
    X0, X1, Z0, Z1 = -41.0, -35.0, 22.5, 27.5
    y0 = float(gh(-38, 25))
    ops = {"N": [op(-38, 1.3, 0, 2.05, "door"), op(-40.0, 0.9, 1.0, 1.9)],
           "S": [op(-38, 1.2, 0.95, 2.0), op(-35.9, 0.8, 1.0, 1.9)],
           "W": [op(25, 1.0, 1.0, 1.95)], "E": [op(25, 1.0, 1.0, 1.95)]}
    footprint("CABIN", X0 - 1.0, Z0 - 2.2, X1 + 1.0, Z1 + 1.0, 1.0)
    push(None, (0, y0, 0))
    YO[0] = y0
    stone_base_ring(X0, Z0, X1, Z1, 0.55, ops, 0.45)
    log_walls(X0, Z0, X1, Z1, 0.55, 2.65, ops, gable=3.9, pitch=math.tan(math.radians(30)))
    chinking(X0, Z0, X1, Z1, 0.55, 2.65, ops)
    for wall, outer in (("N", Z0), ("S", Z1), ("W", X0), ("E", X1)):
        for o in ops[wall]:
            frame_opening(wall, outer, o["c"], o["w"], o["y0"], o["y1"], o["kind"], "#e4dcc8" if o["kind"] == "win" else "#8a6a48", depth=0.45)
    door_leaf("N", Z0, -38, 1.3, 2.0, 1)
    for wall in "NSWE":
        wall_colliders(wall, X0, Z0, X1, Z1, 0.45, ops[wall], -0.6, 2.65)
    for sgn, (xa, xb) in ((-1, (X0, X0 + 0.45)), (1, (X1 - 0.45, X1))):
        for i in range(2):
            ya = 2.65 + i * 0.6
            hs = (3.9 - (ya + 0.6)) / math.tan(math.radians(30))
            col(xa, ya, Z0 + 2.5 - max(hs, 0.3), xb, ya + 0.6, Z0 + 2.5 + max(hs, 0.3), F_WALL, S_WOOD)
    gable_roof(-38, 25, 6, 5, 2.65, math.radians(30), 0.75, "x", 0.16)
    quad("planks", (X0 + 0.45, 0.04, Z1 - 0.45), (X1 - 0.45, 0.04, Z1 - 0.45), (X1 - 0.45, 0.04, Z0 + 0.45), (X0 + 0.45, 0.04, Z0 + 0.45), "y", "#a88862", 1.5, dirt=False)
    # front deck
    box("planks", -40.2, -0.2, 20.7, -35.8, 0.22, 22.5, "#8f7050", 1.2)
    col(-40.2, -0.3, 20.7, -35.8, 0.22, 22.5, F_DEFAULT, S_WOOD)
    box("planks", -39.0, 0.0, 20.0, -37.0, 0.11, 20.7, "#8a6a48", 0.8)
    col(-39.0, 0.0, 20.0, -37.0, 0.11, 20.7, F_DEFAULT, S_WOOD)
    for sx in (-40.0, -36.0):
        cyly("log", sx, 0.22, 2.55, 20.9, 0.09, seg=6, tint="#d2b894")
        col(sx - 0.09, 0.22, 20.81, sx + 0.09, 2.55, 20.99, F_SOLID | F_CAMERA, S_WOOD)
    shed_roof(-40.4, 20.5, -35.6, 22.5, 2.85, 2.5, high="+z", over=0.1, mat="shingle", thick=0.12)
    railing(-40.0, 20.9, -39.0, 20.9, 0.22, 0.95, "#6a4e32")
    railing(-37.0, 20.9, -36.0, 20.9, 0.22, 0.95, "#6a4e32")
    # stove pipe, interior
    box("metal", -36.4, 0.04, 26.3, -35.7, 1.0, 27.0, "#2b2b2c", 1.0, dirt=False)
    cyly("metal", -36.05, 1.0, 4.5, 26.65, 0.07, seg=8, tint="#2b2b2c", dirt=False)
    col(-36.4, 0.04, 26.3, -35.7, 1.0, 27.0, F_DEFAULT, S_METAL)
    box("planks", -40.5, 0.0, 23.0, -38.9, 0.45, 25.0, "#6a4e32", 0.7, dirt=False)
    box("cloth", -40.45, 0.45, 23.05, -38.95, 0.6, 24.95, "#7a3a30", 0.7, dirt=False)
    box("cloth", -40.4, 0.6, 23.1, -39.8, 0.7, 24.9, "#d8d2c4", 0.7, dirt=False)
    col(-40.5, 0.04, 23.0, -38.9, 0.7, 25.0, F_SOLID | F_CAMERA, S_WOOD)
    pop()
    YO[0] = 0.0
    table(-37.6, 25.6, 0.0, 1.2, 0.8, chairs=False) if False else None
    # table + stools (world)
    yy = y0
    box("planks", -38.6, yy + 0.7, 25.3, -37.4, yy + 0.76, 26.1, "#8a6a48", 0.7, dirt=False)
    for sx in (-38.5, -37.5):
        for sz in (25.4, 26.0):
            box("log", sx - 0.03, yy + 0.04, sz - 0.03, sx + 0.03, yy + 0.7, sz + 0.03, "#6a4e32", 0.6, dirt=False)
    col(-38.6, yy + 0.04, 25.3, -37.4, yy + 0.76, 26.1, F_SOLID | F_CAMERA, S_WOOD)
    firewood(-33.8, 25.0, math.pi / 2, 1.0, 6, 4)
    firewood(-42.3, 23.5, math.pi / 2, 1.0, 6, 4)


# ----------------------------------------------------------------------------------------------
# GREENHOUSE (east lane)
# ----------------------------------------------------------------------------------------------
def build_greenhouse():
    X0, X1, Z0, Z1 = 33.0, 43.0, -13.0, -7.0
    y0 = float(gh(38, -10))
    footprint("GREENHOUSE", X0, Z0, X1, Z1, 1.0)
    YO[0] = y0
    push(None, (0, y0, 0))
    BH, WH = 0.55, 2.5
    pitch = math.radians(32)
    ridge = WH + 3.0 * math.tan(pitch)
    # low plinth
    for (a, b, c_, d_) in ((X0, Z0, X1, Z0 + 0.25), (X0, Z1 - 0.25, X1, Z1), (X0, Z0 + 0.25, X0 + 0.25, Z1 - 0.25), (X1 - 0.25, Z0 + 0.25, X1, Z1 - 0.25)):
        if a == X0 and c_ == X0 + 0.25:
            box("stone", a, -0.5, b, c_, BH, d_, "#ffffff", 1.0)
        else:
            box("stone", a, -0.5, b, c_, BH, d_, "#ffffff", 1.0)
    frame = "#e8ece6"
    nx = 8
    # side glass walls (N and S) with mullions every 1.25m
    for z in (Z0 + 0.12, Z1 - 0.12):
        for i in range(nx):
            xa = X0 + 10 * i / nx
            xb = X0 + 10 * (i + 1) / nx
            quad("glass", (xa, BH, z), (xb, BH, z), (xb, WH, z), (xa, WH, z), "z", dirt=False)
        for i in range(nx + 1):
            xm = X0 + 10 * i / nx
            box("paint", xm - 0.03, BH, z - 0.04, xm + 0.03, WH, z + 0.04, frame, 0.5, dirt=False)
        box("paint", X0, BH, z - 0.05, X1, BH + 0.05, z + 0.05, frame, 0.5, dirt=False)
        box("paint", X0, WH - 0.05, z - 0.05, X1, WH, z + 0.05, frame, 0.5, dirt=False)
        box("paint", X0, 1.5, z - 0.03, X1, 1.54, z + 0.03, frame, 0.5, dirt=False)
    # end walls (W has door at z=-10.0, w 1.4)
    for xe in (X0 + 0.12, X1 - 0.12):
        nz = 5
        for i in range(nz):
            za = Z0 + 6 * i / nz
            zb = Z0 + 6 * (i + 1) / nz
            if xe < X0 + 1 and za <= -9.3 and zb >= -10.7 - 0.2 and abs((za + zb) / 2 + 10.0) < 0.7:
                continue
            quad("glass", (xe, BH, zb), (xe, BH, za), (xe, WH, za), (xe, WH, zb), "x", dirt=False)
            quad("glass", (xe, BH, za), (xe, BH, zb), (xe, WH, zb), (xe, WH, za), "x", dirt=False) if False else None
        for i in range(nz + 1):
            zm = Z0 + 6 * i / nz
            box("paint", xe - 0.04, BH, zm - 0.03, xe + 0.04, WH, zm + 0.03, frame, 0.5, dirt=False)
        # gable triangle glass + frame
        tri("glass", (xe, WH, Z0), (xe, WH, Z1), (xe, ridge, (Z0 + Z1) / 2), "x", dirt=False) if xe < X0 + 1 else tri("glass", (xe, WH, Z1), (xe, WH, Z0), (xe, ridge, (Z0 + Z1) / 2), "x", dirt=False)
    # door frame (west wall) with the two glass panes of the door removed
    box("paint", X0, 0, -10.75, X0 + 0.25, 2.1, -10.67, frame, 0.5, dirt=False)
    box("paint", X0, 0, -9.33, X0 + 0.25, 2.1, -9.25, frame, 0.5, dirt=False)
    box("paint", X0, 2.1, -10.75, X0 + 0.25, 2.2, -9.25, frame, 0.5, dirt=False)
    # roof: glass slopes with rafters
    L = 3.0 / math.cos(pitch)
    for sgn in (1, -1):
        zc = (Z0 + Z1) / 2
        for i in range(nx):
            xa = X0 + 10 * i / nx
            xb = X0 + 10 * (i + 1) / nx
            zr, ze = zc, zc + sgn * 3.0
            if sgn > 0:
                quad("glass", (xa, ridge, zr), (xb, ridge, zr), (xb, WH, ze), (xa, WH, ze), "y", dirt=False)
            else:
                quad("glass", (xb, ridge, zr), (xa, ridge, zr), (xa, WH, ze), (xb, WH, ze), "y", dirt=False)
        for i in range(nx + 1):
            xm = X0 + 10 * i / nx
            beam((xm, ridge, zc), (xm, WH, zc + sgn * 3.0), 0.03, "paint", frame, 0.03)
    box("paint", X0, ridge - 0.04, (Z0 + Z1) / 2 - 0.05, X1, ridge + 0.04, (Z0 + Z1) / 2 + 0.05, frame, 0.5, dirt=False)
    # colliders: plinth, glass walls, roof, end walls
    col(X0, -0.5, Z0, X1, BH, Z0 + 0.25, F_WALL, S_CONCRETE)
    col(X0, -0.5, Z1 - 0.25, X1, BH, Z1, F_WALL, S_CONCRETE)
    col(X1 - 0.25, -0.5, Z0, X1, BH, Z1, F_WALL, S_CONCRETE)
    col(X0, -0.5, Z0, X0 + 0.25, BH, -10.7, F_WALL, S_CONCRETE)
    col(X0, -0.5, -9.3, X0 + 0.25, BH, Z1, F_WALL, S_CONCRETE)
    col(X0, BH, Z0, X1, WH, Z0 + 0.25, F_GLASS, S_GLASS)
    col(X0, BH, Z1 - 0.25, X1, WH, Z1, F_GLASS, S_GLASS)
    col(X1 - 0.25, BH, Z0, X1, WH, Z1, F_GLASS, S_GLASS)
    col(X0, BH, Z0, X0 + 0.25, WH, -10.7, F_GLASS, S_GLASS)
    col(X0, BH, -9.3, X0 + 0.25, WH, Z1, F_GLASS, S_GLASS)
    col(X0, 2.1, -10.7, X0 + 0.25, WH, -9.3, F_GLASS, S_GLASS)
    for sgn in (1, -1):
        for i in range(3):
            s0, s1 = i, i + 1
            yt = ridge - s1 * math.tan(pitch)
            zz0, zz1 = (-10 + sgn * s0, -10 + sgn * s1)
            col(X0, yt - 0.25, min(zz0, zz1), X1, yt, max(zz0, zz1), F_GLASS, S_GLASS)
    col(X0, WH, Z0, X0 + 0.25, ridge, Z1, F_GLASS, S_GLASS)
    col(X1 - 0.25, WH, Z0, X1, ridge, Z1, F_GLASS, S_GLASS)
    # interior floor + benches + pots
    quad("ground", (X0 + 0.25, 0.04, Z1 - 0.25), (X1 - 0.25, 0.04, Z1 - 0.25), (X1 - 0.25, 0.04, Z0 + 0.25), (X0 + 0.25, 0.04, Z0 + 0.25), "y", "#b8a890", 2.0, dirt=False, uvs=None)
    quad("planks", (X0 + 1.5, 0.05, -9.2), (X1 - 0.5, 0.05, -9.2), (X1 - 0.5, 0.05, -10.8), (X0 + 1.5, 0.05, -10.8), "y", "#8f7050", 1.5, dirt=False)
    for (bx0, bz0, bx1, bz1) in ((X0 + 1.5, Z0 + 0.35, X1 - 0.6, Z0 + 1.15), (X0 + 1.5, Z1 - 1.15, X1 - 0.6, Z1 - 0.35)):
        box("planks", bx0, 0.7, bz0, bx1, 0.78, bz1, "#8a6a48", 0.8, dirt=False)
        for xx in np.linspace(bx0 + 0.1, bx1 - 0.1, 5):
            for zz in (bz0 + 0.08, bz1 - 0.08):
                box("log", xx - 0.04, 0.04, zz - 0.03, xx + 0.04, 0.7, zz + 0.03, "#6a4e32", 0.6, dirt=False)
        col(bx0, 0.04, bz0, bx1, 0.9, bz1, F_SOLID | F_CAMERA | F_BULLET, S_WOOD)
        for xx in np.arange(bx0 + 0.3, bx1 - 0.2, 0.7):
            potted(xx, (bz0 + bz1) / 2, 0.78, 0.15 + 0.03 * RS.rand(), 0.26)
    for (px, pz) in ((X1 - 1.4, -10.0), (X1 - 1.4, -11.2)):
        potted(px, pz, 0.04, 0.28, 0.5)
    pop()
    YO[0] = 0.0


# ----------------------------------------------------------------------------------------------
# BOATHOUSE + DOCK (north)
# ----------------------------------------------------------------------------------------------
def build_boathouse():
    X0, X1, Z0, Z1 = 12.0, 24.0, -56.0, -46.0
    T = 0.22
    footprint("BOATHOUSE", X0 - 1, Z0 - 3, X1 + 1, Z1 + 1, 0.5)
    ops = {"S": [op(18, 1.4, 0, 2.1, "door"), op(14.3, 1.2, 1.0, 2.1), op(21.7, 1.2, 1.0, 2.1)],
           "N": [op(18, 5.0, 0, 2.9, "door")],
           "W": [op(-51, 1.2, 1.0, 2.1), op(-54, 1.0, 1.0, 2.1)], "E": [op(-51, 1.2, 1.0, 2.1)]}
    ops["W"] = [op(-50.5, 1.2, 1.0, 2.1)]
    ops["E"] = [op(-50.5, 1.2, 1.0, 2.1)]
    # floor deck (walkable) on stilts
    box("planks", X0 - 0.3, -0.35, Z0 - 2.0, X1 + 0.3, 0.0, Z1 + 0.3, "#8a6a48", 1.4, var=0.12)
    col(X0 - 0.3, -0.5, Z0 - 2.0, X1 + 0.3, 0.0, Z1 + 0.3, F_DEFAULT, S_WOOD)
    for sx in (X0 + 0.2, 16.0, 20.0, X1 - 0.2):
        for sz in (Z0 - 1.7, -54.0, -50.0, Z1 - 0.2, Z1 + 0.05):
            cyly("log", sx, -3.6, -0.3, sz, 0.17, seg=8, tint="#6a5848", tile=1.2)
    for sz in (-54.0, -50.0):
        box("log", X0 - 0.2, -1.0, sz - 0.1, X1 + 0.2, -0.75, sz + 0.1, "#6a5848", 0.8, dirt=False)
    plank_walls(X0, Z0, X1, Z1, T, ops, 0.0, 3.2, "#8a6c4c", "planks", "#d8d0bc")
    # gable triangles
    tri("planks", (X0, 3.2, Z0), (X0, 3.2, Z1), (X0, 3.2 + 5 * math.tan(0.44), (Z0 + Z1) / 2), "x", "#8a6c4c", 1.0)
    tri("planks", (X1, 3.2, Z1), (X1, 3.2, Z0), (X1, 3.2 + 5 * math.tan(0.44), (Z0 + Z1) / 2), "x", "#8a6c4c", 1.0)
    for sgn in (-1, 1):
        xa, xb = (X0, X0 + T) if sgn < 0 else (X1 - T, X1)
        for i in range(2):
            ya = 3.2 + i * 1.1
            hs = (5 * math.tan(0.44) - (i + 1) * 1.1) / math.tan(0.44)
            col(xa, ya, (Z0 + Z1) / 2 - max(hs, 0.3), xb, ya + 1.1, (Z0 + Z1) / 2 + max(hs, 0.3), F_WALL, S_WOOD)
    gable_roof(18, -51, 12, 10, 3.2, 0.44, 0.7, "x", 0.12, mats={"+y": "metal", "-y": "planks", "side": "paint"}, tint="#b7a894", rafters=False)
    # big door beam + hanging lantern
    box("log", 15.3, 2.9, Z0 - 0.1, 20.7, 3.2, Z0 + 0.15, "#6a4e32", 0.8)
    lantern_post(18.0, Z1 + 0.3, y=2.3, hang=True)
    # interior
    quad("planks", (X0 + T, 0.02, Z1 - T), (X1 - T, 0.02, Z1 - T), (X1 - T, 0.02, Z0 + T), (X0 + T, 0.02, Z0 + T), "y", "#9a7a56", 1.5, dirt=False) if False else None
    box("planks", 12.8, 0.0, -55.5, 15.2, 0.9, -54.7, "#7a5638", 0.7, dirt=False)
    col(12.8, 0, -55.5, 15.2, 0.95, -54.7, F_DEFAULT, S_WOOD)
    crate_fixed = [(22.9, -48.2), (22.8, -49.4), (22.9, -53.0)]
    for (cx_, cz_) in crate_fixed:
        crate(cx_, cz_, 0.8, RS.rand(), "#a98760", 1)
    barrel(22.7, -51.0, 0.95, 0.3, "#6a4e3a", "planks")
    # canoes on racks
    for k, zc in enumerate((-48.0, -49.8)):
        yb = 2.2 + 0.0
        box("log", 12.5, 1.4 + k * 0.0, zc - 0.05, 14.8, 1.46, zc + 0.05, "#6a4e32", 0.6, dirt=False)
    # boardwalk from shore
    box("planks", 16.8, -0.3, -46.0, 19.2, 0.0, -39.5, "#8a6a48", 1.2)
    col(16.8, -0.5, -46.0, 19.2, 0.0, -39.5, F_DEFAULT, S_WOOD)
    for zz in (-45.5, -42.5, -40.0):
        for xx in (16.95, 19.05):
            cyly("log", xx, -1.8, 0.7, zz, 0.08, seg=6, tint="#6a5848")
    lantern_post(16.85, -41.0, 2.0)


def build_dock():
    DX0, DX1, DZ0, DZ1 = -21.2, -18.8, -62.0, -42.0
    footprint("DOCK", DX0, DZ0, DX1, DZ1, 0.3)
    box("planks", DX0, -0.2, DZ0, DX1, 0.0, DZ1, "#85684a", 1.2, var=0.14)
    col(DX0, -0.4, DZ0, DX1, 0.0, DZ1, F_DEFAULT, S_WOOD)
    for z in np.arange(DZ1 - 1.0, DZ0 + 0.5, -3.0):
        for x in (DX0 + 0.1, DX1 - 0.1):
            cyly("log", x, -3.4, 0.55, z, 0.13, seg=8, tint="#5c4b3a", tile=1.2)
        box("log", DX0 - 0.1, -0.5, z - 0.08, DX1 + 0.1, -0.2, z + 0.08, "#5c4b3a", 0.8, dirt=False)
    for z in np.arange(DZ1 - 2.0, DZ0 + 1.0, -6.0):
        box("planks", DX0 - 0.0, 0.0, z - 0.04, DX0 + 0.12, 0.12, z + 0.04, "#2b2d2e", 0.5, dirt=False)
    # fingers + mooring
    box("planks", DX1, -0.2, -52.0, DX1 + 2.6, 0.0, -50.8, "#85684a", 1.2)
    col(DX1, -0.4, -52.0, DX1 + 2.6, 0.0, -50.8, F_DEFAULT, S_WOOD)
    for x in (DX1 + 2.4,):
        for z in (-51.9, -50.9):
            cyly("log", x, -3.2, 0.5, z, 0.1, seg=6, tint="#5c4b3a")
    lantern_post(-19.2, -61.5, 2.4)
    lantern_post(-20.8, -45.0, 2.4)
    bench(-20.6, -58.0, math.pi / 2, 1.6, y=0.0)
    crate(-19.5, -56.0, 0.7, 0.3, "#8c6d4a", 1)
    barrel(-20.6, -53.4, 0.9, 0.28, "#2f5e4a", "metal")
    # rowboat tied at the finger
    canoe(-15.6, -51.6, 0.0 + math.pi / 2, 4.0, "#3a6a8a") if False else None


def build_bridge():
    cx = float(creek_cx(0.0))
    x0, x1 = cx - 6.4, cx + 6.4
    z0, z1 = -1.0, 1.0
    yb = 0.14
    footprint("BRIDGE", x0, z0, x1, z1, 0.5)
    box("planks", x0, yb - 0.18, z0, x1, yb, z1, "#7c6040", 1.0, var=0.14)
    col(x0, yb - 0.4, z0, x1, yb, z1, F_DEFAULT, S_WOOD)
    for sz in (z0 + 0.25, z1 - 0.25):
        box("log", x0 - 0.2, yb - 0.5, sz - 0.14, x1 + 0.2, yb - 0.18, sz + 0.14, "#5c4b3a", 0.8)
    for xx in np.arange(x0 + 0.5, x1, 2.0):
        for sz in (z0 + 0.05, z1 - 0.05):
            cyly("log", xx, yb - 1.6, yb + 1.1, sz, 0.1, seg=6, tint="#5c4b3a")
    railing(x0 + 0.2, z0 + 0.06, x1 - 0.2, z0 + 0.06, yb, 1.05, "#6a4e32", post_every=2.0)
    railing(x0 + 0.2, z1 - 0.06, x1 - 0.2, z1 - 0.06, yb, 1.05, "#6a4e32", post_every=2.0)
    # abutments
    for xa in (x0 - 0.2, x1 - 0.5):
        box("stone", xa, -1.8, z0 - 0.2, xa + 0.7, yb, z1 + 0.2, "#ffffff", 1.2)


def build_shed():
    X0, X1, Z0, Z1 = 44.0, 48.0, -29.5, -26.5
    y0 = float(gh(46, -28))
    footprint("SHED", X0, Z0, X1, Z1, 1.0)
    ops = {"W": [op(-28, 1.2, 0, 2.0, "door")], "N": [op(46, 0.8, 1.0, 1.8)], "S": [], "E": []}
    YO[0] = y0
    push(None, (0, y0, 0))
    box("stone", X0, -0.5, Z0, X1, 0.2, Z1, "#ffffff", 1.0)
    plank_walls(X0, Z0, X1, Z1, 0.2, ops, 0.0, 2.4, "#7b6a58", "planks", "#cfc8b8")
    shed_roof(X0, Z0, X1, Z1, 2.9, 2.45, high="-z", over=0.35, mat="metal", tint="#c9c0b0")
    # interior bench + tools
    box("planks", 46.8, 0.04, -29.3, 47.8, 0.9, -27.0, "#6a4e32", 0.6, dirt=False)
    col(46.8, 0.04, -29.3, 47.8, 0.9, -27.0, F_SOLID | F_CAMERA | F_BULLET, S_WOOD)
    pop()
    YO[0] = 0.0
    barrel(43.2, -27.0, 0.95, 0.3, "#8a2f25", "metal")
    firewood(46, -25.2, 0.0, 1.8, 10, 4)
    door_leaf("W", X0, -28, 1.2, 1.95, -1)


def build_woodshed():
    X0, X1, Z0, Z1 = 33.0, 39.0, 48.5, 51.5
    y0 = float(gh(36, 50))
    footprint("WOODSHED", X0, Z0, X1, Z1, 0.8)
    YO[0] = y0
    push(None, (0, y0, 0))
    box("planks", X0, 0.0, Z0, X1, 2.2, Z0 + 0.15, "#7b6a58", 1.0)
    box("planks", X0, 0.0, Z0, X0 + 0.15, 2.2, Z1, "#7b6a58", 1.0)
    box("planks", X1 - 0.15, 0.0, Z0, X1, 2.2, Z1, "#7b6a58", 1.0)
    col(X0, 0, Z0, X1, 2.2, Z0 + 0.15, F_WALL, S_WOOD)
    col(X0, 0, Z0, X0 + 0.15, 2.2, Z1, F_WALL, S_WOOD)
    col(X1 - 0.15, 0, Z0, X1, 2.2, Z1, F_WALL, S_WOOD)
    for sx in (X0 + 0.1, 36.0, X1 - 0.1):
        cyly("log", sx, 0, 2.5, Z1 - 0.1, 0.1, seg=6, tint="#c9ad88")
    col(X0, 0, Z1 - 0.2, X0 + 0.2, 2.5, Z1, F_SOLID | F_CAMERA, S_WOOD)
    col(X1 - 0.2, 0, Z1 - 0.2, X1, 2.5, Z1, F_SOLID | F_CAMERA, S_WOOD)
    shed_roof(X0, Z0, X1, Z1, 2.75, 2.35, high="-z", over=0.4, mat="metal", tint="#b9a898")
    pop()
    YO[0] = 0.0
    # firewood rows inside
    for k, xx in enumerate((34.0, 35.45, 36.9, 38.2)):
        firewood(xx, 49.4, math.pi / 2, 1.0, 5, 6) if False else None
    firewood(34.6, 49.5, 0.0, 1.2, 8, 8, 0.075)
    firewood(36.9, 49.5, 0.0, 1.2, 8, 8, 0.075)


def build_garden():
    X0, X1, Z0, Z1 = 30.0, 48.0, 3.0, 19.0
    footprint("GARDEN", X0, Z0, X1, Z1, 0.3)
    # fence with gate gap on the west side
    def fence(xa, za, xb, zb):
        L = math.hypot(xb - xa, zb - za)
        ang = math.atan2(-(zb - za), xb - xa)
        ym = float(gh((xa + xb) / 2, (za + zb) / 2))
        push(roty(ang), (xa, ym, za))
        n = max(1, int(L / 2.4))
        for i in range(n + 1):
            box("log", L * i / n - 0.06, -0.1, -0.06, L * i / n + 0.06, 1.25, 0.06, "#8a6a48", 0.6, dirt=False)
        box("planks", 0, 0.35, -0.03, L, 0.42, 0.03, "#8a6a48", 0.6, dirt=False)
        box("planks", 0, 0.85, -0.03, L, 0.92, 0.03, "#8a6a48", 0.6, dirt=False)
        m = int(L / 0.34)
        for i in range(m):
            x = (i + 0.5) * L / m
            box("planks", x - 0.035, 0.0, 0.03, x + 0.035, 1.05 + 0.06 * (i % 2), 0.05, "#d5cdb8" if i % 5 else "#cbbfa5", 0.4, dirt=False, var=0.1, skip=("+y",))
        pop()
        col_rot((xa + xb) / 2, (za + zb) / 2, L / 2, 0.06, ang, ym, ym + 1.1, F_SOLID | F_CAMERA, S_WOOD)
    fence(X0, Z0, X1, Z0)
    fence(X0, Z1, X1, Z1)
    fence(X1, Z0, X1, Z1)
    fence(X0, Z0, X0, 9.8)
    fence(X0, 11.2, X0, Z1)
    # gate posts
    for zz in (9.8, 11.2):
        box("log", X0 - 0.1, -0.1, zz - 0.1, X0 + 0.1, 1.5, zz + 0.1, "#6a4e32", 0.6, dirt=False)
    # raised beds
    for r in range(3):
        for c in range(2):
            bx = 32.0 + c * 8.2
            bz = 5.2 + r * 4.4
            y = float(gh(bx + 3.5, bz + 0.6))
            box("planks", bx, y - 0.05, bz, bx + 7.0, y + 0.42, bz + 1.2, "#8a6a48", 0.7)
            quad("ground", (bx + 0.1, y + 0.38, bz + 1.1), (bx + 6.9, y + 0.38, bz + 1.1), (bx + 6.9, y + 0.38, bz + 0.1), (bx + 0.1, y + 0.38, bz + 0.1), "y", "#3a2a1c", 1.5, dirt=False)
            col(bx, y, bz, bx + 7.0, y + 0.45, bz + 1.2, F_SOLID | F_CAMERA, S_DIRT)
            for k in range(9):
                bpos = bx + 0.4 + k * 0.76
                beam((bpos, y + 0.38, bz + 0.6), (bpos + 0.03, y + 1.5, bz + 0.6), 0.015, "planks", "#7a6a50", 0.015)
    # scarecrow
    sy = float(gh(44.0, 16.0))
    cyly("log", 44.0, sy, sy + 1.9, 16.0, 0.04, seg=5, tint="#6a4e32")
    box("planks", 43.4, sy + 1.45, 15.97, 44.6, sy + 1.5, 16.03, "#6a4e32", 0.5, dirt=False)
    box("cloth", 43.7, sy + 0.8, 15.9, 44.3, sy + 1.5, 16.1, "#6a7a9a", 0.5, dirt=False)
    cyly("cloth", 44.0, sy + 1.75, sy + 2.0, 16.0, 0.12, seg=8, tint="#c9a85a", dirt=False)


def build_parking_props():
    vehicle(-8, 52.5, math.radians(15), "pickup", "#2f4a6b")
    vehicle(10.5, 49.5, math.radians(-12), "suv", "#7a7f82")
    # barrier gate + fallen tree across the road
    gy = float(gh(0, 62.5))
    for sx in (-3.2, 3.2):
        cyly("log", sx, gy, gy + 1.5, 62.5, 0.12, seg=8, tint="#d2b894")
        col(sx - 0.12, gy, 62.38, sx + 0.12, gy + 1.5, 62.62, F_DEFAULT, S_WOOD)
    for k in range(3):
        box("paint", -3.1 + 0.0, gy + 0.55 + k * 0.28, 62.44, 3.1, gy + 0.55 + k * 0.28 + 0.2, 62.56, "#d2d0c8" if k % 2 == 0 else "#a03a2a", 0.5, dirt=False)
    col(-3.1, gy + 0.5, 62.4, 3.1, gy + 1.3, 62.6, F_DEFAULT, S_WOOD)
    # fallen tree across the road (bowed organic multi-segment log, splintered root flare, irregular branch stubs)
    def round_limb(p0, p1, r0, r1, tint, seg=8, caps=False):
        p0, p1 = np.array(p0, float), np.array(p1, float)
        d = p1 - p0
        L = float(np.linalg.norm(d))
        if L < 1e-5:
            return
        yaw = math.atan2(-d[2], d[0])
        pitch = math.asin(max(-1.0, min(1.0, d[1] / L)))
        push(roty(yaw), p0)
        push(rotz(pitch))
        cylx("log", 0, L, 0, 0, r0, r1=r1, seg=seg, tint=tint, tile=1.0, caps=caps, cap_mat="endgrain", cap_tile=2 * max(r0, r1), cap_uvo=(0.5, 0.5))
        pop()
        pop()

    pts_log = [(-9.1, 64.55, 0.54), (-6.2, 64.22, 0.50), (-3.0, 63.98, 0.47), (0.2, 64.10, 0.44), (3.4, 64.34, 0.40), (6.4, 64.25, 0.36), (9.0, 64.05, 0.31)]
    for (ax, az, r0), (bx, bz, r1) in zip(pts_log[:-1], pts_log[1:]):
        ya, yb = float(gh(ax, az)) + r0 * 0.78, float(gh(bx, bz)) + r1 * 0.78
        round_limb((ax, ya, az), (bx, yb, bz), r0, r1, "#8b7a62", seg=10, caps=(bx > 8.5))
    # Splintered upturned root flare & earth mound at left butt end
    fyL = float(gh(-9.1, 64.55))
    cyly("log", -9.25, fyL - 0.12, fyL + 0.62, 64.55, 0.78, r1=0.52, seg=10, tint="#75644e", caps="top", cap_mat="endgrain", cap_tile=1.1, cap_uvo=(0.5, 0.5))
    for rx, ry, rz, tx, ty, tz in [
        (-9.15, 0.52, 64.55, -10.05, 1.05, 64.05),
        (-9.15, 0.48, 64.60, -9.95, 0.20, 65.25),
        (-9.15, 0.65, 64.50, -9.65, 1.38, 64.85),
    ]:
        round_limb((rx, fyL + ry, rz), (tx, fyL + ty, tz), 0.14, 0.04, "#6a5a44", seg=6, caps=True)
    # Irregular gnarly broken branch stubs (varied spacing, angle, thickness)
    for bx, bz, r_b, dx, dy, dz in [
        (-6.8, 64.28, 0.12, -0.5, 0.95, 0.68),
        (-4.1, 64.05, 0.10, 0.4, 0.78, -0.75),
        (-0.8, 64.06, 0.11, -0.3, 0.85, 0.62),
        (2.5,  64.28, 0.09, 0.6, 0.72, -0.52),
        (5.6,  64.28, 0.08, 0.5, 0.58, 0.58),
    ]:
        by = float(gh(bx, bz)) + r_b * 3.0
        round_limb((bx, by, bz), (bx + dx, by + dy, bz + dz), r_b, r_b * 0.38, "#6f5d47", seg=6, caps=True)
    rock("rock", -9.35, fyL + 0.30, 65.05, 0.62, 0.42, 0.58, 33, 5, 8, "#777268", 0.25)
    rock("rock", -8.35, fyL + 0.18, 63.82, 0.38, 0.24, 0.36, 41, 4, 6, "#6e695f", 0.25)
    fy = float(gh(0, 64.0))
    col(-9.0, fy, 63.5, 9.0, fy + 1.05, 64.9, F_DEFAULT, S_WOOD)
    reserve(-10, 60.8, 10, 65, 0.5)
    # log pile (stacked logs)
    for j in range(4):
        for i in range(7 - j):
            xx = 24.0 + i * 0.52 + j * 0.26
            cylz("log", xx, float(gh(27, 58.5)) + 0.26 + j * 0.45, 56.5, 60.5, 0.25, seg=8, tint=LOGTINTS[RS.randint(5)], uvo=(RS.rand(), RS.rand()), dirt=(j == 0))
    yl = float(gh(26, 58.5))
    col(23.7, yl, 56.5, 27.7, yl + 1.7, 60.5, F_DEFAULT, S_WOOD)
    reserve(23.5, 56.2, 28, 61, 0.5)
    # crates, barrels
    for (x, z, s, r, st) in ((-14, 45, 0.9, 0.4, 2), (-13.0, 46.0, 0.8, 1.2, 1), (16, 44, 0.9, 0.2, 1), (17.2, 44.4, 0.9, 0.5, 2), (-3, 44, 0.8, 0.0, 1), (22, 52, 0.9, 0.3, 3)):
        crate(x, z, s, r, "#a98760", st)
    for (x, z, c) in ((-12.2, 47.8, "#3b5a7a"), (-11.4, 47.2, "#8a2f25"), (18.8, 46.4, "#2f5e4a"), (4.5, 47.0, "#8a2f25")):
        barrel(x, z, 0.95, 0.31, c)
    tire_stack(-3.8, 51.0, 3)
    tire_stack(0.5, 40.6, 2)
    sign_post(2.8, 41.5, math.radians(-20), boards=2)
    sign_post(-4.5, 12.5, math.radians(25), boards=1)


def build_east_props():
    tractor(46.0, 26.0, math.radians(200))
    picnic_table(32.0, 20.5, math.radians(15))
    picnic_table(49.0, -1.5, math.radians(-70))
    for (x, z, r, s) in ((26.5, -3.0, 0.2, 2), (28.2, -2.2, 0.6, 1), (27.0, 8.0, 1.0, 2), (30.0, -17.5, 0.0, 1), (35, -19, 0.7, 2)):
        hay_bale(x, z, r, s)
    for (x, z, s, r, st) in ((24.5, 3.5, 0.9, 0.2, 2), (25.7, 3.0, 0.8, 0.9, 1), (38.0, -18.5, 0.9, 0.3, 1), (50, 8, 0.9, 0.0, 2), (42, 23, 0.8, 0.5, 1), (52.5, -14.0, 1.0, 0.1, 2)):
        crate(x, z, s, r, "#a98760", st)
    barrel(30.3, 21.5, 0.95, 0.3, "#3b5a7a")
    barrel(31.2, 21.9, 0.95, 0.3, "#8a2f25")
    for (x0, z0, x1, z1) in ((22, 14, 27, 14.2), (48.8, -24, 52, -20)):
        stone_wall(x0, z0, x1, z1, 0.9, 0.5)
    stone_wall(26, -10, 26, -4, 0.9, 0.5)


def build_north_props():
    canoe(-8.5, -43.5, math.radians(10))
    canoe(5.5, -45.3, math.radians(-15))
    canoe(-30.0, -44.0, math.radians(80))
    stone_wall(-14, -12, -8, -12, 1.0, 0.55)
    stone_wall(8, -12, 14, -12, 1.0, 0.55)
    stone_wall(-3, -20, 3, -20, 0.9, 0.5)
    for (x, z, s, r, st) in ((-12, -25, 0.9, 0.2, 2), (-11, -24.3, 0.8, 1.0, 1), (10, -27, 0.9, 0.5, 1), (11.1, -27.2, 0.9, 0.1, 2), (0, -30, 0.9, 0.0, 1)):
        crate(x, z, s, r, "#a98760", st)
    barrel(-9.5, -26, 0.95, 0.31, "#3b5a7a")
    barrel(8.6, -28.4, 0.95, 0.31, "#2f5e4a")
    firewood(-12.0, -8.5, 0.0, 1.8, 10, 6)
    firewood(12.5, -8.0, 0.0, 1.8, 10, 6)
    bench(0, -9.2, 0, 2.0, back=True)
    bench(-20, 5, 0.3, 1.8, back=True, cover=True)
    sign_post(-3.0, -10.0, 0.2, boards=2)
    for (x, z) in ((-8, -9), (8, -9), (-12, 8), (12, 10), (-20, 14), (20, 16)):
        lantern_post(x, z, 2.4)


def build_west_props():
    boulders = [(-30, -12, 1.6), (-31.5, -10.5, 1.0), (-28, 12, 1.4), (-52, 8, 1.8), (-51, -12, 1.5), (-33, -27, 1.5), (-29.5, 34, 1.3), (-47, 34, 2.0), (-52, 22, 1.2),
                (-35, 9, 1.0), (-44, -3.5, 1.2), (-43.5, 4.5, 1.4), (-47, 14, 1.1), (-45, -20, 1.7)]
    for i, (x, z, r) in enumerate(boulders):
        boulder(x, z, r, 100 + i, rot=RS.rand() * 6)
    # creek bed boulders
    for i in range(9):
        z = RS.uniform(-40, 40)
        x = float(creek_cx(z)) + RS.uniform(-3.2, 3.2)
        if abs(z) < 3:
            continue
        r = RS.uniform(0.25, 0.7)
        boulder(x, z, r, 200 + i, collide=False, sink=0.4, rot=RS.rand() * 6)
    crate(-30, 4, 0.9, 0.3, "#a98760", 2)
    crate(-29.2, 4.7, 0.8, 0.9, "#a98760", 1)
    barrel(-28.5, 3.2, 0.95, 0.3, "#8a2f25")
    stone_wall(-33, 18, -28, 18, 0.9, 0.5)
    stone_wall(-36, -18, -30, -18, 0.9, 0.5)
    # fallen birch across creek bank
    fy = float(gh(-32, -3.5))
    cylx("log", -39.0, -26.5, fy + 0.3, -5.5, 0.28, r1=0.2, seg=8, tint="#e8e4dc", tile=1.0)
    col(-39.0, fy, -5.9, -26.5, fy + 0.65, -5.1, F_DEFAULT, S_WOOD)
    reserve(-40, -6, -26, -5, 0.3)
    firewood(-33.0, 29.5, 0.0, 1.8, 8, 4)
    bench(-31.2, 24.0, math.pi / 2, 1.8, back=True)
    for (x, z) in ((-34.5, 21.0), (-40, 21.5), (-26, 6)):
        lantern_post(x, z, 2.4)
    sign_post(-30.0, 12.0, -0.3, boards=2)
    power_line()


def power_line():
    poles = [(24, 62), (24, 38), (24, 14), (21, -10), (14, -30), (8, -32)]
    prev = None
    for (x, z) in poles:
        arms = power_pole(x, z)
        if prev is not None:
            for a, b in zip(prev, arms):
                wire((a[0], a[1], prev_z), (b[0], b[1], z), 0.7)
        prev = arms
        prev_z = z

# ----------------------------------------------------------------------------------------------
# terrain meshes
# ----------------------------------------------------------------------------------------------
SPL_N, SPL_SIZE, SPL_X0, SPL_Z0 = 2048, 176.0, -88.0, -88.0
TERR_INNER = (-60.0, 60.0, -68.0, 68.0)


def terrain_region(x0, x1, z0, z1, step, hole=None, splat=True, adapt=False):
    xs = np.arange(x0, x1 + 1e-6, step)
    zs = np.arange(z0, z1 + 1e-6, step)
    H = terrain_h(xs[None, :], zs[:, None])
    nz, nx = H.shape
    gy, gx = np.gradient(H, step)
    Nn = np.stack([-gx, np.ones_like(H), -gy], -1)
    Nn /= np.linalg.norm(Nn, axis=-1, keepdims=True)
    mask = np.ones((nz - 1, nx - 1), bool)
    if hole:
        cxs = (xs[:-1] + xs[1:]) / 2
        czs = (zs[:-1] + zs[1:]) / 2
        inx = (cxs > hole[0]) & (cxs < hole[1])
        inz = (czs > hole[2]) & (czs < hole[3])
        mask &= ~(inz[:, None] & inx[None, :])
    quads = []
    if adapt:
        cov = ~mask
        for s_ in (4, 2):
            for j in range(0, nz - 1 - s_ + 1, s_):
                for i in range(0, nx - 1 - s_ + 1, s_):
                    if cov[j:j + s_, i:i + s_].any():
                        continue
                    blk = H[j:j + s_ + 1, i:i + s_ + 1]
                    u = np.linspace(0, 1, s_ + 1)
                    bil = (blk[0, 0] * (1 - u)[None, :] + blk[0, -1] * u[None, :]) * (1 - u)[:, None] + (blk[-1, 0] * (1 - u)[None, :] + blk[-1, -1] * u[None, :]) * u[:, None]
                    if np.abs(blk - bil).max() < 0.04 and np.abs(blk[1:-1, 1:-1] - np.gradient(blk)[0][1:-1, 1:-1] * 0).max() > -1:
                        quads.append((j, i, s_))
                        cov[j:j + s_, i:i + s_] = True
        for j, i in zip(*np.nonzero(~cov)):
            quads.append((j, i, 1))
    else:
        for j, i in zip(*np.nonzero(mask)):
            quads.append((j, i, 1))
    q = np.array(quads)
    jj, ii, ss = q[:, 0], q[:, 1], q[:, 2]
    a = jj * nx + ii
    b = a + ss
    d = a + ss * nx
    c = d + ss
    alt = ((ii // ss + jj // ss) % 2) == 0
    t1 = np.where(alt[:, None], np.stack([a, d, c], 1), np.stack([a, d, b], 1))
    t2 = np.where(alt[:, None], np.stack([a, c, b], 1), np.stack([b, d, c], 1))
    I = np.concatenate([t1, t2])
    used, inv = np.unique(I.ravel(), return_inverse=True)
    I2 = inv.reshape(-1, 3)
    Xg, Zg = np.meshgrid(xs, zs)
    P = np.stack([Xg.ravel(), H.ravel(), Zg.ravel()], 1)[used]
    N = Nn.reshape(-1, 3)[used]
    if splat:
        UV = np.stack([(P[:, 0] - SPL_X0) / SPL_SIZE, (P[:, 2] - SPL_Z0) / SPL_SIZE], 1)
        emit("terrain", P, N, UV, I2, colors=np.ones((len(P), 3)))
    else:
        slope = 1 - N[:, 1]
        h = P[:, 1]
        n = vnoise(P[:, 0] * 0.05, P[:, 2] * 0.05, 5)
        base = np.array(hexl("#8a9a68"))
        rockc = np.array(hexl("#9a948a"))
        dark = np.array(hexl("#52603c"))
        wet = np.array(hexl("#5a4a38"))
        col_ = base * (0.7 + 0.5 * n)[:, None]
        col_ = col_ * (1 - smooth(8, 40, h))[:, None] + dark * smooth(8, 40, h)[:, None] * (0.8 + 0.4 * n)[:, None]
        col_ = col_ * (1 - smooth(0.15, 0.45, slope))[:, None] + rockc * smooth(0.15, 0.45, slope)[:, None]
        col_ = np.where((h < -0.3)[:, None], wet * 0.8, col_)
        emit("ground", P, N, np.stack([P[:, 0] / 8, P[:, 2] / 8], 1), I2, colors=np.clip(col_, 0, 1))
    return xs, zs, H


def terrain_skirt(x0, x1, z0, z1, step, depth=2.0, mat="terrain"):
    def edge(pts):
        P = np.array(pts)
        for p, q in zip(P[:-1], P[1:]):
            Q = np.array([p, q, q - [0, depth, 0], p - [0, depth, 0]])
            n = np.array([0, 0, 1.0])
            if mat == "terrain":
                uv = np.stack([(Q[:, 0] - SPL_X0) / SPL_SIZE, (Q[:, 2] - SPL_Z0) / SPL_SIZE], 1)
                colr = np.ones((4, 3)) * 0.6
            else:
                uv = np.stack([Q[:, 0] / 8, Q[:, 2] / 8], 1)
                colr = np.ones((4, 3)) * 0.35
            emit(mat, Q, np.tile([0, 1.0, 0], (4, 1)), uv, np.array([[0, 1, 2], [0, 2, 3], [0, 3, 2], [0, 2, 1]]), colors=colr)
    xs = np.arange(x0, x1 + 1e-6, step)
    zs = np.arange(z0, z1 + 1e-6, step)
    for z in (z0, z1):
        edge([(x, float(terrain_h(x, z)), z) for x in xs])
    for x in (x0, x1):
        edge([(x, float(terrain_h(x, z)), z) for z in zs])


# ----------------------------------------------------------------------------------------------
# terrain splat bake
# ----------------------------------------------------------------------------------------------
def seg_mask(X, Z, pts, width, soft=0.35, jitter=None):
    S = X.shape[1]
    dmin = np.full((S, S), 99.0, dtype=np.float32)
    pad = width + 2
    step = SPL_SIZE / S
    for (ax, az), (bx, bz) in zip(pts[:-1], pts[1:]):
        x_lo, x_hi = min(ax, bx) - pad, max(ax, bx) + pad
        z_lo, z_hi = min(az, bz) - pad, max(az, bz) + pad
        i0 = max(0, int((x_lo - SPL_X0) / step))
        i1 = min(S, int((x_hi - SPL_X0) / step) + 1)
        j0 = max(0, int((z_lo - SPL_Z0) / step))
        j1 = min(S, int((z_hi - SPL_Z0) / step) + 1)
        if i1 <= i0 or j1 <= j0:
            continue
        xx = X[:, i0:i1]
        zz = Z[j0:j1, :]
        dx, dz = bx - ax, bz - az
        L2 = dx * dx + dz * dz + 1e-9
        t = np.clip(((xx - ax) * dx + (zz - az) * dz) / L2, 0, 1)
        d = np.hypot(xx - (ax + t * dx), zz - (az + t * dz))
        dmin[j0:j1, i0:i1] = np.minimum(dmin[j0:j1, i0:i1], d)
    if jitter is not None:
        dmin = dmin + jitter
    return 1 - smooth(width / 2 - 0.1, width / 2 + soft, dmin)


def rect_sdf(X, Z, x0, z0, x1, z1):
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    dx = np.abs(X - cx) - (x1 - x0) / 2
    dz = np.abs(Z - cz) - (z1 - z0) / 2
    return np.hypot(np.maximum(dx, 0), np.maximum(dz, 0)) + np.minimum(np.maximum(dx, dz), 0)


def sample_layer(L, tile_m, X, Z):
    N = L.shape[0]
    u = (X / tile_m % 1.0) * N
    v = (Z / tile_m % 1.0) * N
    i0 = np.floor(u).astype(np.int32)
    j0 = np.floor(v).astype(np.int32)
    fu = (u - i0).astype(np.float32)[..., None]
    fv = (v - j0).astype(np.float32)[..., None]
    i0 %= N
    j0 %= N
    i1 = (i0 + 1) % N
    j1 = (j0 + 1) % N
    a = L[j0, i0] * (1 - fu) + L[j0, i1] * fu
    b = L[j1, i0] * (1 - fu) + L[j1, i1] * fu
    return a * (1 - fv) + b * fv


def bake_terrain():
    S = SPL_N
    step = SPL_SIZE / S
    px = (SPL_X0 + (np.arange(S) + 0.5) * step).astype(np.float32)
    pz = (SPL_Z0 + (np.arange(S) + 0.5) * step).astype(np.float32)
    X = px[None, :]
    Z = pz[:, None]
    t0 = time.time()
    H = terrain_h(X, Z).astype(np.float32)
    gy, gx = np.gradient(H, step)
    slope = np.hypot(gx, gy).astype(np.float32)
    log("  splat height", time.time() - t0)
    nz1 = fbm(X * 0.9, Z * 0.9, 3, 401).astype(np.float32)
    nz2 = fbm(X * 0.12, Z * 0.12, 4, 402).astype(np.float32)
    nz3 = fbm(X * 0.04, Z * 0.04, 3, 403).astype(np.float32)
    # layers: (alb[3], h, rough) packed, downsampled to 128
    def pack(d, N=256):
        a = np.concatenate([d["alb"], d["h"][..., None], np.broadcast_to(d["rough"], d["h"].shape)[..., None]], -1).astype(np.float32)
        a = a.reshape(N // 2, 2, N // 2, 2, 5).mean((1, 3))
        return a
    LG, LS, LV, LM, LR = (pack(f()) for f in (layer_grass, layer_soil, layer_gravel, layer_mud, layer_rock))
    # masks (soft organic edges so gravel yard & hill trails blend naturally into soil/grass)
    jit = ((nz1 - 0.5) * 1.1 + (nz2 - 0.5) * 0.6).astype(np.float32)
    paths = np.zeros((S, S), np.float32)
    road = np.zeros((S, S), np.float32)
    for k, (w, pts) in enumerate(PATHS):
        m = seg_mask(X, Z, pts, w, 1.15, jit)
        if w >= 4:
            road = np.maximum(road, m)
        else:
            paths = np.maximum(paths, m)
    pk = 1 - smooth(-0.6, 2.2, rect_sdf(X, Z, -22, 39.5, 27, 62.5) + (nz1 - 0.5) * 2.2 + (nz2 - 0.5) * 1.0)
    apron = np.zeros((S, S), np.float32)
    inside = np.zeros((S, S), np.float32)
    for (nm, x0, z0, x1, z1) in FOOT:
        d = rect_sdf(X, Z, x0, z0, x1, z1)
        apron = np.maximum(apron, 1 - smooth(0.0, 2.2, d + (nz1 - 0.5) * 1.0))
        inside = np.maximum(inside, (d < 0).astype(np.float32))
    garden = 1 - smooth(-0.2, 0.6, rect_sdf(X, Z, 30, 3, 48, 19))
    rut = np.zeros((S, S), np.float32)
    for off in (-0.95, 0.95):
        rut = np.maximum(rut, seg_mask(X, Z, [(x + off, z) for (x, z) in PATHS[1][1]], 0.56, 0.45, jit * 0.7))
    for off in (-0.7, 0.7):
        rut = np.maximum(rut, seg_mask(X, Z, [(x + off, z) for (x, z) in PATHS[0][1]], 0.48, 0.42, jit * 0.7) * 0.78)
    field = 1 - smooth(2.0, 6.0, np.hypot(X - 46, Z - 26) + (nz1 - 0.5) * 3)
    dc = np.abs(X - creek_cx(Z)).astype(np.float32)
    creek_active = ((Z > -52) & (Z < 55)).astype(np.float32)
    bed = (1 - smooth(0.8, 2.6, dc + (nz1 - 0.5) * 1.2)) * creek_active
    bank = (1 - smooth(2.2, 5.2, dc + (nz1 - 0.5) * 1.5)) * creek_active
    wet = smooth(-0.1, -0.7, H)
    under = smooth(-0.9, -1.4, H)
    dout = np.hypot(np.maximum(np.abs(X) - 55, 0), np.maximum(np.abs(Z) - 65, 0)).astype(np.float32)
    forest = smooth(1.0, 10.0, dout) * (1 - under)
    rock_s = smooth(0.34, 0.7, slope + 0.2 * (nz2 - 0.5))
    rock = np.maximum(rock_s, bed * smooth(0.35, 0.6, nz1) * 0.9)
    rock = np.maximum(rock, smooth(25, 60, H) * 0.8)
    rock = np.maximum(rock, under * 0.5)
    gravel = np.clip(pk + road + paths * 0.85 + apron * 0.35 + wet * 0.15 + (bed * 0.45), 0, 1)
    gravel = gravel * (1 - 0.3 * (nz1 > 0.78) * (pk < 0.5))
    gravel = gravel * (1 - 0.75 * rut)
    mud = np.clip(bank * 0.7 + wet * 0.8 + under * 0.6 + (paths * 0.12) * smooth(0.5, 0.8, nz2) + rut * 0.85, 0, 1)
    soil = np.clip(apron * 0.55 + garden * 0.95 + field * 0.85 + forest * 0.75 + smooth(0.62, 0.82, nz2) * 0.45 + paths * 0.15, 0, 1)
    soil = soil * (1 - np.clip(pk + road * 0.8, 0, 1))
    # weights, priority rock > gravel > mud > soil > grass
    wr = rock
    wv = gravel * (1 - wr)
    wm = mud * (1 - wr) * (1 - wv)
    ws = soil * (1 - wr) * (1 - wv) * (1 - wm)
    wg = np.clip(1 - wr - wv - wm - ws, 0, 1)
    tot = wg + ws + wv + wm + wr + 1e-6
    wg, ws, wv, wm, wr = wg / tot, ws / tot, wv / tot, wm / tot, wr / tot
    log("  masks done", time.time() - t0)
    tiles = dict(g=3.2, s=3.6, v=2.4, m=3.0, r=4.8)
    alb = np.zeros((S, S, 3), np.float32)
    hgt = np.zeros((S, S), np.float32)
    rgh = np.zeros((S, S), np.float32)
    for w, L, tm, amp in ((wg, LG, tiles["g"], 0.05), (ws, LS, tiles["s"], 0.05), (wv, LV, tiles["v"], 0.07), (wm, LM, tiles["m"], 0.04), (wr, LR, tiles["r"], 0.2)):
        sm = sample_layer(L, tm, X, Z)
        alb += w[..., None] * sm[..., :3]
        hgt += w * sm[..., 3] * amp
        rgh += w * sm[..., 4]
    # macro colour variation
    dry = smooth(0.45, 0.75, nz3)[..., None]
    alb = alb * (0.88 + 0.28 * nz2[..., None]) * (1 - 0.1 * dry) + dry * wg[..., None] * np.array([0.05, 0.03, -0.02], np.float32)
    alb = alb * (1 - 0.25 * np.clip(wet + under, 0, 1) - 0.22 * rut)[..., None]
    alb = np.clip(alb, 0, 1)
    # normal from composite height (metres)
    hy, hx = np.gradient(hgt, step)
    nxv, nyv = -hx, hy
    nl = np.sqrt(nxv * nxv + nyv * nyv + 1)
    nrm = np.stack([nxv / nl, nyv / nl, 1 / nl], -1) * 0.5 + 0.5
    # occlusion: cavities of the macro height + under foundations
    cav = blur(H.astype(np.float32), 6) - H
    ao = np.clip(1 - 1.2 * np.maximum(cav, 0) * 2 - 0.2 * inside, 0.3, 1) * (0.9 + 0.1 * (hgt / (hgt.max() + 1e-6)))
    orm = np.stack([ao, np.clip(rgh, 0, 1), np.zeros_like(ao)], -1)
    # grass density source (resampled later)
    return alb, nrm, orm, dict(wg=wg, ws=ws, wr=wr, wv=wv, wm=wm, H=H, slope=slope, inside=inside, apron=apron)


def detail_tile():
    d = layer_grass(256)
    g = d["alb"].mean(-1)
    g = (g / g.mean()) * 0.5
    return np.clip(np.repeat(g[..., None], 3, -1), 0, 1)


# ----------------------------------------------------------------------------------------------
# backdrop: mountains + forest silhouette
# ----------------------------------------------------------------------------------------------
def build_backdrop():
    # High-resolution 360-degree seamless alpine mountain amphitheatre with foothills,
    # glacially carved valleys, layered secondary ridges, and jagged Cascade-style peaks.
    nth = 220
    dists = [0, 18, 42, 72, 108, 150, 198, 250, 305, 365, 430, 500, 575, 655]
    th = np.linspace(0, 2 * math.pi, nth, endpoint=False)
    ct, st = np.cos(th), np.sin(th)
    R = 160.0 / np.maximum(np.abs(ct), np.abs(st))

    def ridged(xx, zz, octs, seed, gain=0.5):
        tot = np.zeros_like(xx)
        amp = 1.0
        norm = 0.0
        freq = 1.0
        w = np.ones_like(xx)
        for o in range(octs):
            n = 1.0 - np.abs(vnoise(xx * freq, zz * freq, seed + o * 17) * 2.0 - 1.0)
            n = n * n * w
            w = np.clip(n * 1.85, 0.15, 1.0)
            tot += amp * n
            norm += amp
            amp *= gain
            freq *= 2.05
        return tot / norm

    # Seamless angular massif envelope (evaluated on unit circle so th=0..2pi has zero seam)
    massif = 0.55 + 0.75 * ridged(ct * 2.1 + 3.4, st * 2.1 - 1.8, 4, 511)
    saddles = 0.55 + 0.60 * fbm(ct * 3.2 - 5.1, st * 3.2 + 2.7, 3, 519)

    P = []
    for j, d in enumerate(dists):
        rr = R + d
        x, z = rr * ct, rr * st
        if j == 0:
            y = terrain_h(160 * np.clip(ct * R / 160, -1, 1), 160 * np.clip(st * R / 160, -1, 1))
        else:
            base = terrain_h(np.clip(R * ct, -160, 160), np.clip(R * st, -160, 160))
            t = smooth(0.0, 655.0, d)
            # Gentle rolling forested foothills close in, rising into sculpted alpine peaks
            foothill = (26.0 * smooth(0.0, 165.0, d) + 32.0 * smooth(60.0, 260.0, d)) * (
                0.55 + 0.65 * fbm(x * 0.0055 + 1.2, z * 0.0055 - 2.3, 4, 501)
            )
            # Multi-scale ridged alpine range with cross-cutting glacial spurs and valleys
            r_main = ridged(x * 0.0031 + 4.7, z * 0.0031 - 2.9, 5, 503)
            r_spur = ridged(x * 0.0068 - 3.1, z * 0.0068 + 6.4, 4, 507)
            valley_cut = smooth(0.18, 0.78, fbm(x * 0.0024 - 1.5, z * 0.0024 + 3.8, 3, 523))
            # Rise steeply between d=120..520, crest naturally near d=480..580
            range_env = smooth(45.0, 440.0, d) ** 1.15 * (1.0 - 0.14 * smooth(540.0, 655.0, d))
            alpine = (275.0 * range_env) * massif * (0.42 + 0.58 * saddles) * (
                0.32 + 0.52 * r_main + 0.24 * r_spur
            ) * (0.58 + 0.42 * valley_cut)
            # Fine rocky ridge detail along upper slopes
            detail = (9.0 + 18.0 * t) * (fbm(x * 0.019, z * 0.019, 3, 529) - 0.45) * smooth(20.0, 140.0, d)
            y = base * (1.0 - 0.5 * t) + foothill + alpine + detail
        P.append(np.stack([x, y, z], -1))
    P = np.array(P)  # (rings, nth, 3)
    rings = len(dists)
    V = P.reshape(-1, 3)
    I = []
    for j in range(rings - 1):
        for i in range(nth):
            i2 = (i + 1) % nth
            a, b = j * nth + i, j * nth + i2
            c, d_ = (j + 1) * nth + i2, (j + 1) * nth + i
            # Alternate diagonal per cell so ridge silhouettes never show stair-stepped biases
            if (i + j) & 1:
                I.append((a, d_, c))
                I.append((a, c, b))
            else:
                I.append((a, d_, b))
                I.append((b, d_, c))
    I = np.array(I)
    N = smooth_normals(V, I)
    if N[:, 1].mean() < 0:
        I = I[:, ::-1]
        N = -N
    # Fallback vertex colours (the runtime mountain shader paints procedural granite/forest/snow)
    h = V[:, 1]
    n = vnoise(V[:, 0] * 0.01, V[:, 2] * 0.01, 7)
    forest = np.array(hexl("#263f2a"))
    rockc = np.array(hexl("#666a70"))
    snow = np.array(hexl("#e4eaf0"))
    c = forest[None, :] * (0.85 + 0.3 * n)[:, None]
    c = c * (1 - smooth(65, 130, h))[:, None] + rockc[None, :] * (0.85 + 0.3 * n)[:, None] * smooth(65, 130, h)[:, None]
    c = c * (1 - smooth(175, 240, h + 30 * (n - 0.5)))[:, None] + snow[None, :] * smooth(175, 240, h + 30 * (n - 0.5))[:, None]
    emit("mountain", V, N, np.zeros((len(V), 2)), I, colors=np.clip(c * 0.9, 0, 1))
    # (the forest beyond the playable area used to be pale 5-sided cones here; it is now
    # real trees in the foliage list, see the far forest in place_foliage(), drawn as impostors)


# ----------------------------------------------------------------------------------------------
# foliage placement
# ----------------------------------------------------------------------------------------------
def keepout_mask(res=0.5, ext=110.0, extra_path=0.9):
    n = int(2 * ext / res)
    xs = -ext + (np.arange(n) + 0.5) * res
    X = xs[None, :]
    Z = xs[:, None]
    blocked = np.zeros((n, n), bool)
    for k in KEEP:
        if k[0] == "r":
            blocked |= (X >= k[1]) & (X <= k[3]) & (Z >= k[2]) & (Z <= k[4])
        else:
            blocked |= (np.hypot(X - k[1], Z - k[2]) <= k[3])
    S = n
    for (w, pts) in PATHS:
        dm = np.full((n, n), 99.0)
        for (ax, az), (bx, bz) in zip(pts[:-1], pts[1:]):
            dx, dz = bx - ax, bz - az
            t = np.clip(((X - ax) * dx + (Z - az) * dz) / (dx * dx + dz * dz + 1e-9), 0, 1)
            dm = np.minimum(dm, np.hypot(X - (ax + t * dx), Z - (az + t * dz)))
        blocked |= dm < (w / 2 + extra_path)
    for (nm, x0, z0, x1, z1) in FOOT:
        blocked |= (X >= x0 - 2.5) & (X <= x1 + 2.5) & (Z >= z0 - 2.5) & (Z <= z1 + 2.5)
    blocked |= (np.abs(X - 2) < 26) & (Z > 38) & (Z < 66)   # parking
    H = terrain_h(X, Z)
    blocked |= H < -0.5
    return blocked, xs


def place_foliage(slopes=None):
    rs = np.random.RandomState(2024)
    blocked, xs = keepout_mask()
    res = 0.5
    ext = 110.0

    def ok(x, z, extra=0.0):
        i = int((x + ext) / res)
        j = int((z + ext) / res)
        if i < 0 or j < 0 or i >= blocked.shape[1] or j >= blocked.shape[0]:
            return False
        return not blocked[j, i]

    def creek_dist(x, z):
        return abs(x - float(creek_cx(z)))

    trees, bushes = [], []
    taken = {}

    def free(x, z, r, grid=4.0):
        gx, gz = int(x // grid), int(z // grid)
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                for (px, pz, pr) in taken.get((gx + dx, gz + dz), []):
                    if math.hypot(px - x, pz - z) < (r + pr):
                        return False
        return True

    def take(x, z, r, grid=4.0):
        taken.setdefault((int(x // grid), int(z // grid)), []).append((x, z, r))

    def add_tree(x, z, kind=None, sc=None):
        h = float(gh(x, z))
        if h < -0.3 or not ok(x, z):
            return False
        if abs(z) < 66 and abs(x) < 56 and creek_dist(x, z) < 5.5 and -48 < z < 55:
            return False
        r = 1.6 if kind != "birch" else 1.3
        if not free(x, z, r):
            return False
        if kind is None:
            u = rs.rand()
            kind = "pine" if u < 0.5 else ("spruce" if u < 0.82 else "birch")
        s = sc if sc else rs.uniform(0.85, 1.45) * (0.8 if kind == "birch" else 1.0)
        trees.append([round(x, 2), round(h, 2), round(z, 2), round(s, 2), round(rs.uniform(0, 6.283), 2), kind])
        take(x, z, r)
        return True

    # 1) dense edge band (inside the playable box rim and beyond)
    tries = 0
    while len(trees) < 215 and tries < 40000:
        tries += 1
        side = rs.randint(4)
        d = rs.uniform(0, 1) ** 1.6 * 38
        if side == 0:
            x, z = rs.uniform(-100, 100), -(65 + d - 12)
            if z > -55:
                continue
        elif side == 1:
            x, z = rs.uniform(-100, 100), 65 + d - 12
        elif side == 2:
            x, z = -(55 + d - 6), rs.uniform(-95, 95)
        else:
            x, z = 55 + d - 6, rs.uniform(-95, 95)
        if abs(x) < 52 and abs(z) < 62:
            continue
        add_tree(x, z)
    # 2) groves inside the lanes
    groves = [(-29, -26, 6.5, 12, "birch"), (-51, 20, 5, 10, None), (-50, -30, 5, 9, None), (-27, 45, 5.5, 9, None), (-48, 52, 6, 10, None),
              (50, -22, 4.5, 8, None), (51, 20, 4.5, 8, None), (49, -48, 5, 8, None), (-44, -48, 5, 7, None), (47, 56, 5, 8, None),
              (30, 30, 3.5, 5, "birch"), (-33, 5, 3.0, 4, "birch"), (28, -44, 3.5, 5, None), (-8, 25, 2.5, 3, "birch"), (22, 30, 3.0, 4, "birch")]
    for (gx, gz, gr, n, kind) in groves:
        c = 0
        t = 0
        while c < n and t < 400:
            t += 1
            a = rs.uniform(0, 6.283)
            rr = gr * math.sqrt(rs.rand())
            if add_tree(gx + rr * math.cos(a), gz + rr * math.sin(a), kind if kind else None):
                c += 1
    # 3) top up to >= 260
    tries = 0
    while len(trees) < 290 and tries < 20000:
        tries += 1
        x, z = rs.uniform(-100, 100), rs.uniform(-100, 100)
        if abs(x) < 58 and abs(z) < 68:
            continue
        add_tree(x, z)
    # bushes
    def add_bush(x, z, kind, sc=None):
        h = float(gh(x, z))
        if h < -0.4 or not ok(x, z):
            return False
        if kind != "fern" and abs(x) < 58 and creek_dist(x, z) < 2.5 and -48 < z < 55:
            return False
        if not free(x, z, 0.5, 4.0):
            return False
        s = sc or rs.uniform(0.7, 1.4)
        bushes.append([round(x, 2), round(h, 2), round(z, 2), round(s, 2), round(rs.uniform(0, 6.283), 2), kind])
        take(x, z, 0.5)
        return True
    # hedges along porch front and garden outer fence
    for x in np.arange(-8.2, 8.3, 1.5):
        if abs(x) < 1.9:
            continue
        add_bush(x, 10.9, "hedge", 1.0)
    for x in np.arange(31, 47, 2.0):
        add_bush(x, 20.4, "hedge", 0.9)
    for z in np.arange(4, 18, 2.0):
        add_bush(49.4, z, "hedge", 0.9)
    # fern strips along the creek
    for _ in range(160):
        z = rs.uniform(-46, 52)
        side = rs.choice([-1, 1])
        add_bush(float(creek_cx(z)) + side * rs.uniform(3.2, 6.5), z, "fern", rs.uniform(0.8, 1.3))
    # edge + grove undergrowth
    for t in trees:
        if rs.rand() < 0.75 and len(bushes) < 560:
            for _ in range(2):
                a = rs.uniform(0, 6.283)
                add_bush(t[0] + 2.0 * math.cos(a), t[2] + 2.0 * math.sin(a), "bush" if rs.rand() < 0.55 else "fern")
    tries = 0
    while len(bushes) < 430 and tries < 20000:
        tries += 1
        x, z = rs.uniform(-62, 62), rs.uniform(-72, 72)
        if abs(x) < 20 and abs(z) < 22:
            continue
        add_bush(x, z, ["bush", "fern", "bush"][rs.randint(3)])
    # 4) far forest on the slopes outside the playable area (where the old cone silhouette
    # stood): real pines and spruce, which the engine draws as 8-triangle impostors at range
    rf = np.random.RandomState(77)
    far = 0
    for _ in range(6000):
        x, z = rf.uniform(-158, 158, 2)
        if max(abs(x) - 70, abs(z) - 80) < 0 or (z < -50 and abs(x) < 80):
            continue
        h = float(gh(x, z))
        if h < -0.5:
            continue
        kind = "pine" if rf.rand() < 0.55 else "spruce"
        trees.append([round(x, 2), round(h, 2), round(z, 2), round(rf.uniform(1.0, 1.6), 2), round(rf.uniform(0, 6.283), 2), kind])
        far += 1
        if far >= 320:
            break
    return trees, bushes

# ----------------------------------------------------------------------------------------------
# ROUND 2: terrain splat layers (high detail 1024 tiles), vehicles, rocks, lodge interior
# ----------------------------------------------------------------------------------------------
def png_bytes(arr, filt=True):
    a = np.clip(np.round(arr * 255) if arr.dtype != np.uint8 else arr, 0, 255).astype(np.uint8)
    h, w, c = a.shape
    if filt:
        d = a.astype(np.int16).copy()
        d[1:] = (a[1:].astype(np.int16) - a[:-1].astype(np.int16)) & 255
        d = d.astype(np.uint8)
        raw = b"".join(b"\x02" + d[i].tobytes() for i in range(h))
    else:
        raw = b"".join(b"\x00" + a[i].tobytes() for i in range(h))

    def chunk(t, dd):
        c_ = struct.pack(">I", len(dd)) + t + dd
        return c_ + struct.pack(">I", zlib.crc32(t + dd) & 0xFFFFFFFF)

    ct = {3: 2, 4: 6}[c]
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, ct, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def _strokes(N, count, seed, L0, L1, wid, angle0=None, spread=3.14, bend=0.25):
    rs = np.random.RandomState(seed)
    x0 = rs.uniform(0, N, count)
    y0 = rs.uniform(0, N, count)
    ang = rs.uniform(0, 2 * math.pi, count) if angle0 is None else angle0 + rs.uniform(-spread, spread, count)
    L = rs.uniform(L0, L1, count)
    bd = rs.uniform(-bend, bend, count) * L
    K = 14
    t = np.linspace(0, 1, K)[None, :]
    dx, dy = np.cos(ang)[:, None], np.sin(ang)[:, None]
    px = x0[:, None] + dx * L[:, None] * t - dy * bd[:, None] * t * t
    py = y0[:, None] + dy * L[:, None] * t + dx * bd[:, None] * t * t
    T = np.broadcast_to(t, px.shape)
    idv = np.broadcast_to(rs.rand(count, 1), px.shape)
    return px, py, T, idv


def _paint(buf, px, py, vals, stamps=((0, 0), (1, 0), (0, 1))):
    N = buf.shape[0]
    for (ox, oy) in stamps:
        ix = (np.floor(px).astype(np.int64) + ox) % N
        iy = (np.floor(py).astype(np.int64) + oy) % N
        buf[iy.ravel(), ix.ravel()] = vals.reshape(-1, buf.shape[2]) if buf.ndim == 3 else vals.ravel()


def hr_grass(N=1024):
    X, Y = grid(N)
    rs = np.random.RandomState(5)
    bg = fbm(X * 6, Y * 6, 4, 11, (6, 6))
    alb = np.zeros((N, N, 3))
    alb[:] = mix3(hexc("#26331a")[None, None, :] + 0 * bg[..., None], hexc("#4a4a26"), bg)
    h = np.zeros((N, N))
    # three passes of blades: dark undergrowth, mid, bright tops
    for (cnt, L0, L1, seed, bright) in ((16000, 22, 46, 21, 0.62), (16000, 26, 58, 22, 0.85), (9000, 30, 62, 23, 1.05)):
        px, py, T, idv = _strokes(N, cnt, seed, L0, L1, 1.5, None, 3.14, 0.32)
        base = np.array([hexc("#2e4a1c"), hexc("#4f7a2a"), hexc("#6e8c34"), hexc("#7a8a3a"), hexc("#3d5f22")])
        ci = (idv * 5).astype(int) % 5
        col_ = base[ci] * (0.55 + 0.6 * T[..., None]) * bright * (0.85 + 0.3 * rs.rand(*T.shape, 1))
        _paint(alb, px, py, col_.reshape(-1, 3))
        hv = (0.15 + 0.85 * T) * bright
        _paint(h, px, py, hv)
    # leaf litter: small ellipses of dry leaves / clover leaves
    for k in range(420):
        cx, cy = rs.uniform(0, N, 2)
        a = rs.uniform(0, 6.283)
        lw, ll = rs.uniform(3, 6), rs.uniform(8, 17)
        colr = [hexc("#8a6a2a"), hexc("#a08a3a"), hexc("#5b7a2a"), hexc("#6a4a22")][rs.randint(4)] * rs.uniform(0.75, 1.1)
        u = np.arange(-20, 21)
        gx, gy = np.meshgrid(u, u)
        ca, sa = math.cos(a), math.sin(a)
        lu = gx * ca + gy * sa
        lv = -gx * sa + gy * ca
        m = (lu / ll) ** 2 + (lv / lw) ** 2 < 1
        ix = ((gx[m] + int(cx)) % N).astype(int)
        iy = ((gy[m] + int(cy)) % N).astype(int)
        vein = np.abs(lv[m]) < 0.7
        alb[iy, ix] = np.where(vein[:, None], colr * 0.7, colr)
        h[iy, ix] = 0.55 + 0.1 * (1 - np.abs(lv[m]) / lw)
    ao = 0.5 + 0.5 * np.clip(h, 0, 1)
    alb = alb * ao[..., None] * 1.15
    hb = blur(h, 1)
    return dict(alb=np.clip(alb, 0, 1), h=blur(hb, 1), nstr=1.3)


def hr_soil(N=1024):
    X, Y = grid(N)
    rs = np.random.RandomState(6)
    n1 = fbm(X * 8, Y * 8, 5, 31, (8, 8))
    n2 = fbm(X * 40, Y * 40, 3, 32, (40, 40))
    alb = mix3(hexc("#3b2a1c")[None, None, :] + 0 * n1[..., None], hexc("#6e5238"), n1)
    alb = alb * (0.75 + 0.5 * n2)[..., None]
    h = 0.5 * n1 + 0.35 * n2
    # clods
    f1, f2, v = voronoi(N, 14, 33, 0.95)
    clod = smooth(0.0, 0.5, f1) * 0
    h = h + 0.35 * (1 - smooth(0.0, 0.7, f1)) * (v > 0.35)
    # pebbles
    f1, f2, v = voronoi(N, 36, 34, 0.95)
    peb = (v > 0.72)
    rad = 0.30 + 0.12 * ((v * 977) % 1)
    dome = np.clip(1 - (f1 / rad) ** 2, 0, 1) * peb
    pc = np.array([hexc(c) for c in ("#8a857b", "#a89e8a", "#6c675f", "#b9afa0", "#7b6a58")])[(((v * 1000) % 5).astype(int))]
    light = 0.7 + 0.5 * np.clip(dome, 0, 1)
    pm = (dome > 0.05)[..., None]
    alb = np.where(pm, pc * light[..., None] * (0.85 + 0.3 * n2[..., None]), alb)
    h = h + 0.9 * np.sqrt(dome)
    # grit
    grit = rs.rand(N, N)
    alb = alb * (0.88 + 0.2 * grit)[..., None]
    h = h + 0.08 * grit
    # dead needles / twigs
    px, py, T, idv = _strokes(N, 900, 35, 14, 40, 1.2, None, 3.14, 0.1)
    twig = np.array([hexc("#5a4126"), hexc("#7a5a34"), hexc("#3f2e1c")])[(idv * 3).astype(int) % 3]
    _paint(alb, px, py, twig.reshape(-1, 3), ((0, 0),))
    _paint(h, px, py, np.full(px.shape, 0.75), ((0, 0),))
    return dict(alb=np.clip(alb, 0, 1), h=blur(h, 1), nstr=2.4)


def hr_gravel(N=1024):
    X, Y = grid(N)
    rs = np.random.RandomState(7)
    f1, f2, v = voronoi(N, 30, 41, 0.95)
    rad = 0.55 + 0.35 * ((v * 811) % 1)
    dome = np.clip(1 - (f1 / (rad * 0.9)) ** 2.0, 0, 1)
    stone = dome > 0.02
    pal = np.array([hexc(c) for c in ("#8d8a82", "#a39d90", "#6f6e6a", "#b4aa94", "#5f5d58", "#9b9488", "#c2baa6", "#7a6f60")])
    sc = pal[((v * 1000) % 8).astype(int)]
    n = fbm(X * 50, Y * 50, 3, 42, (50, 50))
    # fake directional light on dome
    gy_, gx_ = np.gradient(dome)
    lit = np.clip(0.8 + 14 * (-gx_ * 0.6 - gy_ * 0.8), 0.45, 1.35)
    stonec = sc * (0.6 + 0.6 * np.sqrt(dome))[..., None] * lit[..., None] * (0.8 + 0.4 * n)[..., None]
    sand = hexc("#4a3f33")[None, None, :] * (0.7 + 0.6 * fbm(X * 90, Y * 90, 2, 43, (90, 90)))[..., None]
    alb = np.where(stone[..., None], stonec, sand)
    h = np.sqrt(dome) * 0.9 + 0.1 * n
    # a few small chips in the gaps
    grit = rs.rand(N, N)
    alb = alb * (0.9 + 0.2 * grit)[..., None]
    return dict(alb=np.clip(alb, 0, 1), h=blur(h, 1), nstr=3.0)


def hr_rock(N=1024):
    X, Y = grid(N)
    f1, f2, v = voronoi(N, 6, 51, 0.9)
    g1, g2, w = voronoi(N, 20, 52, 0.95)
    n = fbm(X * 8, Y * 8, 5, 53, (8, 8))
    n2 = fbm(X * 48, Y * 48, 3, 54, (48, 48))
    crack = smooth(0.12, 0.0, f2 - f1) * smooth(0.25, 0.6, n)
    crack2 = smooth(0.05, 0.0, g2 - g1) * 0.5 * smooth(0.45, 0.7, n2)
    strata = 0.5 + 0.5 * np.sin((Y * 14 + n * 4 + v * 2) * 2 * math.pi)
    base = mix3(hexc("#575652")[None, None, :] + 0 * n[..., None], hexc("#8d877c"), 0.3 * n + 0.45 * n2 + 0.25 * strata)
    alb = base * (0.85 + 0.3 * v)[..., None]
    lichen = smooth(0.6, 0.78, fbm(X * 10, Y * 10, 4, 55, (10, 10)))
    alb = mix3(alb, hexc("#a09c58"), lichen * 0.4)
    moss = smooth(0.0, 0.2, crack + crack2) * smooth(0.45, 0.65, fbm(X * 6, Y * 6, 3, 56, (6, 6)))
    alb = mix3(alb, hexc("#3f5326"), moss * 0.7)
    alb = alb * (1 - 0.8 * np.maximum(crack, crack2))[..., None]
    h = 0.4 * n + 0.25 * strata + 0.25 * n2 - 0.9 * np.maximum(crack, crack2) + 0.3 * smooth(0, 0.5, g1)
    return dict(alb=np.clip(alb, 0, 1), h=blur(h, 1), nstr=3.4)


HR_LAYERS = [("grass", hr_grass, 2.4, 0.95), ("soil", hr_soil, 2.0, 0.92), ("gravel", hr_gravel, 2.0, 0.85), ("rock", hr_rock, 3.0, 0.8)]


def build_terrain_layers(aux, NOTEX=False):
    layers = []
    for (nm, fn, tile, rough) in HR_LAYERS:
        N = 128 if NOTEX else 1024
        d = fn(N)
        a = jpeg_bytes(np.clip(d["alb"], 0, 1), 48, "L_" + nm + "_a")
        nm_ = normal_from_height(d["h"], d["nstr"])
        n = jpeg_bytes(nm_, 34, "L_" + nm + "_n")
        layers.append(dict(name=nm, tile=tile, albedo=b64(a), normal=b64(n), rough=rough))
        log("  layer", nm, len(a) // 1024, "KB", len(n) // 1024, "KB")
    wg, ws, wv, wm, wr = (aux[k] for k in ("wg", "ws", "wv", "wm", "wr"))
    W = np.stack([wg, ws + wm, wv, wr], -1)
    W = W / np.maximum(W.sum(-1, keepdims=True), 1e-6)
    W = down(W, 1024)
    W8 = (np.clip(np.round(W * 31), 0, 31) * 8).astype(np.uint8)
    # rebalance rounding so that the four weights sum to 255
    W8[..., 0] = np.clip(256 - W8[..., 1].astype(int) - W8[..., 2].astype(int) - W8[..., 3].astype(int), 0, 255).astype(np.uint8)
    png = png_bytes(W8)
    log("  splat png KB", len(png) // 1024)
    return dict(x0=SPL_X0, z0=SPL_Z0, size=SPL_SIZE, splat=b64(png), layers=layers)


# ----------------------------------------------------------------------------------------------
# rocks: displaced cube-sphere with per-face planar UVs, moss on top
# ----------------------------------------------------------------------------------------------
_CSPH = {}


def cube_sphere(n):
    if n in _CSPH:
        return _CSPH[n]
    D, UVs, I = [], [], []
    for ax in range(3):
        for sg in (-1, 1):
            base = len(D)
            for j in range(n + 1):
                for i in range(n + 1):
                    u, v = 2.0 * i / n - 1, 2.0 * j / n - 1
                    vec = [0, 0, 0]
                    vec[ax] = sg
                    vec[(ax + 1) % 3] = u
                    vec[(ax + 2) % 3] = v
                    D.append(vec)
                    UVs.append((u, v))
            for j in range(n):
                for i in range(n):
                    a = base + j * (n + 1) + i
                    I.append((a, a + 1, a + n + 2))
                    I.append((a, a + n + 2, a + n + 1))
    D = np.array(D, float)
    D /= np.linalg.norm(D, axis=1, keepdims=True)
    UVs = np.array(UVs)
    I = np.array(I)
    # orient outward
    p = D[I]
    nrm = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
    out = (nrm * p.mean(1)).sum(1) < 0
    I[out] = I[out][:, ::-1]
    key = np.round(D * 1e5).astype(np.int64)
    _, weld = np.unique(key, axis=0, return_inverse=True)
    _CSPH[n] = (D, UVs, I, weld.ravel(), np.repeat(np.arange(6), (n + 1) ** 2))
    return _CSPH[n]


def n3(d, k, s):
    return (vnoise(d[:, 0] * k + s, d[:, 1] * k, 61) + vnoise(d[:, 1] * k + 5, d[:, 2] * k + s, 62) + vnoise(d[:, 2] * k, d[:, 0] * k + 9 + s, 63)) / 3.0


def rock(mat, cx, cy, cz, rx, ry, rz, seed=0, rings=5, segs=8, tint="#ffffff", rough=0.28, rot=0.0, tile=2.0, sink=0.0):
    rmax = max(rx, ry, rz)
    n = 2 if rmax < 0.25 else (3 if rmax < 1.7 else 4)
    D, UVs, I, weld, fid = cube_sphere(n)
    s = (seed % 97) * 0.37
    rad = 1 + rough * 1.6 * (n3(D, 1.3, s) - 0.5) + rough * 0.7 * (n3(D, 3.1, s + 4) - 0.5)
    P = D * rad[:, None] * np.array([rx, ry, rz])
    P[:, 1] = np.maximum(P[:, 1], -0.45 * ry)
    P = P @ roty(rot).T
    # welded smooth normals
    Pw = np.zeros((weld.max() + 1, 3))
    Pw[weld] = P
    Nw = np.zeros_like(Pw)
    f = np.cross(Pw[weld[I[:, 1]]] - Pw[weld[I[:, 0]]], Pw[weld[I[:, 2]]] - Pw[weld[I[:, 0]]])
    for k in range(3):
        np.add.at(Nw, weld[I[:, k]], f)
    Nw /= np.linalg.norm(Nw, axis=1, keepdims=True) + 1e-12
    N = Nw[weld]
    Pwld = P + np.array([cx, cy, cz])
    sc = (rx + ry + rz) / 3.0 * 1.7 / tile
    uv = UVs * sc + np.stack([fid * 0.37 + s, fid * 0.61 + s * 0.5], 1)
    # colour: rock tint, moss on top-facing parts, dirt at the base
    nn = vnoise(Pwld[:, 0] * 2.3, Pwld[:, 2] * 2.3 + Pwld[:, 1], 71)
    moss = smooth(0.45, 0.8, N[:, 1] + 0.7 * (nn - 0.5)) * 0.85
    base = hexl(tint) * (0.85 + 0.3 * vnoise(Pwld[:, 0] * 1.1, Pwld[:, 1] * 1.4 + Pwld[:, 2], 72))[:, None]
    col_ = base * (1 - moss[:, None]) + np.array(hexl("#5a7a30")) * 0.9 * moss[:, None] * (0.8 + 0.4 * nn)[:, None]
    gy = np.clip((P[:, 1] + 0.5 * ry) / ry, 0, 1)
    col_ = col_ * (0.6 + 0.4 * gy)[:, None]
    emit(mat, Pwld, N, uv, I, colors=np.clip(col_, 0, 1))


# ----------------------------------------------------------------------------------------------
# vehicle building blocks
# ----------------------------------------------------------------------------------------------
def emit_smooth(mat, P, I, center, tint, uvs=0.5, var=0.04, flat_override=None):
    P = np.asarray(P, float)
    I = np.asarray(I)
    N = smooth_normals(P, I)
    if ((N * (P - center)).sum(1)).mean() < 0:
        I = I[:, ::-1]
        N = -N
    uv = np.stack([P[:, 0], P[:, 1] + P[:, 2] * 0.5], 1) * uvs
    emit(mat, P, N, uv, I, tint, False, var)


def loft(mat, secs, M=18, p=0.55, tint="#ffffff", roof_mat=None, roof_y=None, caps=True, uvs=1.6, var=0.04):
    th = np.linspace(0, 2 * math.pi, M, endpoint=False)
    sy, cz = np.sin(th), np.cos(th)
    ry_ = np.sign(sy) * np.abs(sy) ** p
    rz_ = np.sign(cz) * np.abs(cz) ** p
    rings = []
    for (x, yb, yt, w) in secs:
        yc, a, b = (yb + yt) / 2, (yt - yb) / 2, w / 2
        rings.append(np.stack([np.full(M, x), yc + a * ry_, b * rz_], 1))
    S = len(rings)
    P = np.concatenate(rings)
    I = []
    for s_ in range(S - 1):
        for j in range(M):
            a_, b_ = s_ * M + j, s_ * M + (j + 1) % M
            c_, d_ = (s_ + 1) * M + (j + 1) % M, (s_ + 1) * M + j
            I.append((a_, d_, c_))
            I.append((a_, c_, b_))
    I = np.array(I)
    center = P.mean(0)
    N = smooth_normals(P, I)
    cen = np.concatenate([np.tile(r.mean(0), (M, 1)) for r in rings])
    if ((N * (P - cen)).sum(1)).mean() < 0:
        I = I[:, ::-1]
        N = -N
    uv = np.stack([P[:, 0], P[:, 1] + P[:, 2] * 0.4], 1) * uvs
    if roof_mat and roof_y is not None:
        cy_ = P[I].mean(1)[:, 1]
        isroof = cy_ > roof_y
        emit(mat, P, N, uv, I[~isroof], tint, False, var)
        emit(roof_mat[0], P, N, uv, I[isroof], roof_mat[1], False, var)
    else:
        emit(mat, P, N, uv, I, tint, False, var)
    if caps:
        for end, sgn in ((0, -1), (S - 1, 1)):
            r = rings[end]
            c = r.mean(0)
            Pc = np.concatenate([[c], r])
            Ic = []
            for j in range(M):
                Ic.append((0, 1 + j, 1 + (j + 1) % M))
            Ic = np.array(Ic)
            nn = np.cross(Pc[Ic[:, 1]] - Pc[Ic[:, 0]], Pc[Ic[:, 2]] - Pc[Ic[:, 0]])
            flip = nn[:, 0] * sgn < 0
            Ic[flip] = Ic[flip][:, ::-1]
            emit(mat if not roof_mat else mat, Pc, np.tile([sgn, 0, 0], (len(Pc), 1)), np.stack([Pc[:, 2], Pc[:, 1]], 1) * uvs, Ic, tint, False, var)


def rbox(mat, x0, y0, z0, x1, y1, z1, tint="#ffffff", k=None, p=0.4, M=12):
    k = k or min(x1 - x0, y1 - y0, z1 - z0) * 0.28
    w, h = z1 - z0, y1 - y0
    zc = (z0 + z1) / 2
    push(None, (0, 0, zc))
    loft(mat, [(x0, y0 + k, y1 - k, w - 2 * k), (x0 + k * 0.5, y0 + k * 0.2, y1 - k * 0.2, w - k * 0.6), (x0 + k * 1.5, y0, y1, w), (x1 - k * 1.5, y0, y1, w), (x1 - k * 0.5, y0 + k * 0.2, y1 - k * 0.2, w - k * 0.6), (x1, y0 + k, y1 - k, w - 2 * k)], M=M, p=p, tint=tint, caps=True)
    pop()


def lathe(mat, prof, seg, tint, axis_center=None, var=0.03):
    ang = np.linspace(0, 2 * math.pi, seg, endpoint=False)
    P = []
    for (r, z) in prof:
        P.append(np.stack([r * np.cos(ang), r * np.sin(ang), np.full(seg, z)], 1))
    P = np.concatenate(P)
    I = []
    for k in range(len(prof) - 1):
        for j in range(seg):
            a_, b_ = k * seg + j, k * seg + (j + 1) % seg
            c_, d_ = (k + 1) * seg + (j + 1) % seg, (k + 1) * seg + j
            I.append((a_, d_, c_))
            I.append((a_, c_, b_))
    cen = np.array([0, 0, np.mean([z for _, z in prof])])
    emit_smooth(mat, P, np.array(I), cen, tint, 0.8, var)


def wheel(x, y, z, side, R=0.38, W=0.24, rim=0.22, seg=20, tint="#1a1c20", lugs=0, ribs=False, rimtint="#cfd5db"):
    """3D sculpted tire + machined 6-spoke alloy wheel centred at (x,y,z), outer face toward `side` (+1/-1)."""
    push(roty(0 if side > 0 else math.pi), (x, y, z))
    hw = W / 2
    prof = [
        (rim * 0.92, -hw * 0.92), (R * 0.78, -hw * 1.0), (R * 0.92, -hw * 0.94),
        (R * 0.985, -hw * 0.72), (R, -hw * 0.44), (R, hw * 0.44),
        (R * 0.985, hw * 0.72), (R * 0.92, hw * 0.94), (R * 0.78, hw * 1.0), (rim * 0.92, hw * 0.92),
    ]
    lathe("cartrim", prof, seg, tint, var=0.02)
    if ribs:
        for kk in range(seg):
            a = kk * 2 * math.pi / seg
            push(rotz(a), (0, 0, 0))
            box("cartrim", R - 0.02, -0.028, -hw * 0.45, R + 0.032, 0.028, hw * 0.45, tint, 0.3, dirt=False, skip=("-y",))
            pop()
    for kk in range(lugs):
        a = kk * 2 * math.pi / lugs
        push(rotz(a), (0, 0, 0))
        box("cartrim", R - 0.01, -0.055, -hw * 0.88, R + 0.085, 0.055, hw * 0.88, tint, 0.3, dirt=False, skip=("-y",))
        pop()
    # Machined alloy rim lip, dished barrel, brake rotor, hub & 6 spokes
    push(rotx(math.pi / 2), (0, 0, 0))
    cyl("carchrome", rim * 1.02, rim * 0.92, hw * 0.56, hw * 0.94, seg=seg, tint=rimtint, caps=False, dirt=False, var=0.02)
    cyl("carchrome", rim * 0.92, rim * 0.82, hw * 0.56, hw * 0.64, seg=seg, tint=rimtint, caps=False, dirt=False, var=0.02)
    cyl("cartrim", rim * 0.84, rim * 0.84, -hw * 0.65, hw * 0.56, seg=seg, tint="#1d1f23", caps=True, dirt=False, var=0.01)  # dark inner barrel
    cyl("carchrome", rim * 0.64, rim * 0.64, hw * 0.10, hw * 0.32, seg=14, tint="#7e848b", caps=True, dirt=False, var=0.02)  # brake disc
    cyl("carchrome", 0.075, 0.068, hw * 0.48, hw * 0.88, seg=12, tint="#9da4ac", caps=True, dirt=False, var=0.02)  # center hub cap
    pop()
    for kk in range(6):
        a = kk * 2 * math.pi / 6 + 0.25
        push(rotz(a), (0, 0, 0))
        box("carchrome", 0.055, -0.024, hw * 0.54, rim * 0.88, 0.024, hw * 0.82, rimtint, 0.3, dirt=False)
        pop()
    pop()


def _arch_arc(mat, prof, seg, tint, a0=-0.08, a1=math.pi + 0.08, var=0.02):
    """Open upper-half lathe sweep around +Z axis (angles a0..a1) so fender flares never clip underground."""
    ang = np.linspace(a0, a1, seg)
    P = []
    for (r, z) in prof:
        P.append(np.stack([r * np.cos(ang), r * np.sin(ang), np.full(seg, z)], 1))
    P = np.concatenate(P)
    I = []
    for k in range(len(prof) - 1):
        for j in range(seg - 1):
            a_, b_ = k * seg + j, k * seg + j + 1
            c_, d_ = (k + 1) * seg + j + 1, (k + 1) * seg + j
            I.append((a_, d_, c_))
            I.append((a_, c_, b_))
    I = np.array(I)
    N = smooth_normals(P, I)
    # orient outward away from arc centerline
    rm = np.mean([r for r, _ in prof])
    zm = np.mean([z for _, z in prof])
    c_arr = np.tile(np.stack([rm * np.cos(ang), rm * np.sin(ang), np.full(seg, zm)], 1), (len(prof), 1))
    if ((N * (P - c_arr)).sum(1)).mean() < 0:
        I = I[:, ::-1]
        N = -N
    uv = np.stack([P[:, 0], P[:, 1] + P[:, 2] * 0.5], 1) * 0.8
    emit(mat, P, N, uv, I, tint, False, var)


def fender_cutout(xw, y_ax, z_out, side, Ra, y_top, x_pad, tint, flare_tint="#202328", seg=16):
    """True circular wheel-well opening in bodywork + recessed dark inner liner + top-half fender flare."""
    push(roty(0 if side > 0 else math.pi), (xw, y_ax, z_out))
    half_x = Ra + x_pad
    h_top = y_top - y_ax
    ang = np.linspace(0.0, math.pi, seg)
    ca, sa = np.cos(ang), np.sin(ang)
    # Project each arch angle outward onto the enclosing fender rectangle [-half_x..half_x] x [0..h_top]
    ox, oy = np.empty(seg), np.empty(seg)
    for k in range(seg):
        c, s = ca[k], sa[k]
        tx = (half_x / abs(c)) if abs(c) > 1e-4 else 1e9
        ty = (h_top / s) if s > 1e-4 else 1e9
        t = min(tx, ty)
        ox[k] = np.clip(c * t, -half_x, half_x)
        oy[k] = np.clip(s * t, 0.0, h_top)
    ix, iy = Ra * ca, Ra * sa
    # Outer painted fender spandrel face (at z=0, pointing +z outward)
    P_out = np.concatenate([
        np.stack([ix, iy, np.zeros(seg)], 1),
        np.stack([ox, oy, np.zeros(seg)], 1),
    ])
    I_sp = []
    for k in range(seg - 1):
        I_sp.append((k, k + 1, seg + k + 1))
        I_sp.append((k, seg + k + 1, seg + k))
    I_sp = np.array(I_sp)
    n_sp = np.cross(P_out[I_sp[:, 1]] - P_out[I_sp[:, 0]], P_out[I_sp[:, 2]] - P_out[I_sp[:, 0]])
    if n_sp[:, 2].mean() < 0:
        I_sp = I_sp[:, ::-1]
    N_out = np.tile([0.0, 0.0, 1.0], (len(P_out), 1))
    emit("carpaint", P_out, N_out, P_out[:, :2] * 0.8, I_sp, tint, False, 0.02)

    # Dark recessed wheel-well tunnel (goes inward -0.34 behind the tire, never covering the wheel!)
    well_prof = [(Ra, 0.0), (Ra, -0.34), (0.04, -0.34)]
    _arch_arc("cartrim", well_prof, seg, "#121417", a0=-0.04, a1=math.pi + 0.04, var=0.01)

    # Sculpted matte-black off-road fender flare (top semicircle ONLY, clean automotive edge)
    fl_prof = []
    for k in range(8):
        a = -math.pi * 0.5 + math.pi * k / 7
        fl_prof.append((Ra + 0.028 + 0.042 * math.cos(a), 0.016 + 0.036 * math.sin(a)))
    _arch_arc("cartrim", fl_prof, seg, flare_tint, a0=-0.04, a1=math.pi + 0.04, var=0.02)
    pop()


def arch(x, y, z, side, R=0.48, tint="#222528", lip_tint="#ffffff", thick=0.05):
    """Upper-half fender flare arch (never clips underground or hides the wheel)."""
    push(roty(0 if side > 0 else math.pi), (x, y, z))
    prof = []
    for k in range(7):
        a = -math.pi / 2 + math.pi * k / 6
        prof.append((R + 0.04 * math.cos(a) + 0.015, 0.028 * math.sin(a) + 0.018))
    _arch_arc("cartrim", prof, 16, lip_tint, a0=-0.05, a1=math.pi + 0.05, var=0.02)
    pop()


def vlight(x, y, z, kind, side=1, tint="#ffffff"):
    """Clean automotive headlight (chrome reflector + amber marker + glass) or ruby taillight."""
    if kind == "head":
        rbox("carchrome", x - 0.04, y - 0.085, z - 0.20, x + 0.03, y + 0.085, z + 0.20, "#d8dee4", p=0.45, M=8)
        rbox("glass", x + 0.02, y - 0.072, z - 0.185, x + 0.06, y + 0.072, z + 0.185, "#eef4fa", p=0.45, M=8)
        # outer amber corner marker
        sz = 1 if z > 0 else -1
        za, zb = sorted((z + sz * 0.15, z + sz * 0.23))
        rbox("carpaint", x - 0.02, y - 0.065, za, x + 0.05, y + 0.065, zb, "#dc8218", p=0.4, M=8)
    else:
        rbox("carpaint", x - 0.04, y - 0.16, z - 0.07, x + 0.03, y + 0.16, z + 0.07, "#bf1616", p=0.4, M=8)
        rbox("carchrome", x - 0.046, y - 0.05, z - 0.048, x + 0.01, y + 0.02, z + 0.048, "#e6ecf2", p=0.4, M=8)


def mirror(x, y, z, side, tint="#1d2024"):
    beam((x, y, z), (x - 0.04, y + 0.04, z + side * 0.18), 0.014, "cartrim", "#17191d", 0.014)
    za, zb = sorted((z + side * 0.15, z + side * 0.24))
    rbox("carpaint", x - 0.11, y - 0.01, za, x + 0.03, y + 0.14, zb, tint, p=0.5, M=8)
    rbox("cartrim", x - 0.115, y + 0.005, za + 0.006, x - 0.08, y + 0.125, zb - 0.006, "#17191d", p=0.4, M=8)


def side_slit(x, y0, y1, zface):
    for sg in (-1, 1):
        face("+z" if sg > 0 else "-z", x - 0.007, y0, sg * zface, x + 0.007, y1, sg * zface, "cartrim", "#101216", 0.3, False)


def _quad_glass(p0, p1, p2, p3, tint="#ffffff"):
    """Emit a flat tinted automotive window quad with clean outward normal."""
    P = np.array([p0, p1, p2, p3], float)
    n = np.cross(P[1] - P[0], P[2] - P[0])
    nl = np.linalg.norm(n)
    n = n / (nl + 1e-9)
    N = np.tile(n, (4, 1))
    UV = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], float)
    emit("glass_dark", P, N, UV, np.array([[0, 1, 2], [0, 2, 3]]), tint, False, 0.0)


def vehicle(x, z, rot, kind, tint):
    y = float(gh(x, z))
    push(roty(rot), (x, y, z))
    W = 1.98
    hw = W / 2.0
    if kind == "pickup":
        Rw = 0.41
        Ra = Rw + 0.085
        wxs = (-1.72, 1.68)
        y_arch_top = 0.95

        # ---- 1. LOWER BODYWORK WITH REAL CIRCULAR WHEEL-ARCH CUTOUTS ----
        # Mid-body cab & doors: ONE continuous sculpted side from rocker (0.42) to beltline (1.15)
        loft("carpaint", [
            (-1.18, 0.42, 1.15, W), (-0.50, 0.42, 1.15, W), (0.35, 0.42, 1.15, W), (1.14, 0.42, 1.15, W),
        ], 20, 0.24, tint, caps=True, var=0.015)
        # Sculpted front fenders & hood smoothly continuing beltline forward from cowl (x = 1.12..2.70)
        loft("carpaint", [
            (1.12, 0.93, 1.15, W),
            (1.70, 0.93, 1.12, W * 0.99),
            (2.26, 0.91, 1.05, W * 0.96),
            (2.58, 0.86, 0.97, W * 0.90),
            (2.70, 0.78, 0.90, W * 0.82),
        ], 20, 0.28, tint, caps=True, var=0.015)
        # Subtle sculpted hood power-dome
        loft("carpaint", [
            (1.20, 1.11, 1.185, 0.94), (1.85, 1.08, 1.15, 0.84), (2.46, 1.00, 1.06, 0.68),
        ], 14, 0.50, tint, caps=True, var=0.012)
        # Front nose apron ahead of front wheels (x = 2.24..2.68)
        loft("carpaint", [
            (2.24, 0.48, 0.95, W * 0.96), (2.56, 0.50, 0.92, W * 0.90), (2.68, 0.54, 0.88, W * 0.82),
        ], 16, 0.28, tint, caps=True, var=0.015)
        # Rear quarter apron behind rear wheels (x = -2.66..-2.26)
        loft("carpaint", [
            (-2.66, 0.48, 0.95, W * 0.97), (-2.46, 0.46, 0.96, W * 0.995), (-2.26, 0.44, 0.96, W),
        ], 16, 0.24, tint, caps=True, var=0.015)

        # ---- 2. LEVEL SPORTY PICKUP BED (seamless flush beltline y = 1.15 matching doors) ----
        # Dark spray-in bed floor + front bulkhead
        box("cartrim", -2.60, 0.68, -0.84, -0.90, 0.76, 0.84, "#202226", 0.6, dirt=False)
        box("carpaint", -0.94, 0.74, -0.94, -0.86, 1.15, 0.94, tint, 0.6, dirt=False)
        # Left & right flush bed upper walls (y = 0.93..1.15) + matte black bed-rail caps
        for sg in (-1, 1):
            z_in, z_out = sorted((sg * 0.84, sg * hw))
            rbox("carpaint", -2.68, 0.92, z_in, -0.88, 1.15, z_out, tint, k=0.014, p=0.22, M=10)
            # Matte black bed-rail top trim cap
            rbox("cartrim", -2.66, 1.14, min(sg * 0.84, sg * 0.985), -0.88, 1.182, max(sg * 0.84, sg * 0.985), "#1d2024", k=0.012, p=0.35, M=8)
            # Inner bed wheel-well humps
            rbox("cartrim", -2.12, 0.74, min(sg * 0.60, sg * 0.84), -1.32, 0.96, max(sg * 0.60, sg * 0.84), "#1f2226", k=0.04, p=0.5, M=8)
        # Sculpted tailgate with dark handle, chrome strip & license plate
        rbox("carpaint", -2.72, 0.56, -0.96, -2.58, 1.15, 0.96, tint, k=0.02, p=0.25, M=10)
        rbox("cartrim", -2.74, 1.00, -0.14, -2.69, 1.07, 0.14, "#191b1f", k=0.01, p=0.3, M=8)  # tailgate latch handle
        box("carchrome", -2.735, 0.86, -0.34, -2.71, 0.90, 0.34, "#c8cfd6", 0.3, dirt=False)   # badge bar
        box("cartrim", -2.74, 0.62, -0.18, -2.71, 0.76, 0.18, "#d8dde4", 0.3, dirt=False)      # license plate

        # ---- 3. PROPER FRAMED CAB (tapered flush C-pillars, solid roof, A/B pillars, dark tinted glass) ----
        # Solid painted roof crown (y = 1.73..1.83)
        loft("carpaint", [
            (-0.84, 1.72, 1.80, 1.56), (-0.50, 1.72, 1.83, 1.60), (0.28, 1.72, 1.83, 1.58), (0.60, 1.72, 1.79, 1.50),
        ], 18, 0.42, tint, caps=True, var=0.012)
        # Solid cab back wall below/above rear window
        rbox("carpaint", -0.88, 1.12, -0.88, -0.72, 1.28, 0.88, tint, k=0.02, p=0.35, M=8)
        rbox("carpaint", -0.84, 1.65, -0.78, -0.68, 1.77, 0.78, tint, k=0.02, p=0.35, M=8)
        rbox("carpaint", -0.86, 1.68, -0.16, -0.81, 1.73, 0.16, "#b81818", k=0.01, p=0.3, M=6)  # 3rd brake light
        for sg in (-1, 1):
            # Flush inward-tapered C-pillar matching side-window tumblehome (z = 0.89 at belt -> 0.77 at roof)
            for cx_ in (-0.82, -0.74, -0.66):
                beam((cx_, 1.13, sg * 0.89), (cx_ + 0.02, 1.76, sg * 0.77), 0.055, "carpaint", tint, 0.055)
            # Inner rear corner filler beside rear sliding glass
            beam((-0.82, 1.15, sg * 0.72), (-0.80, 1.74, sg * 0.65), 0.075, "carpaint", tint, 0.075)
            # Sloped A-pillar (painted)
            beam((1.16, 1.14, sg * 0.89), (0.58, 1.76, sg * 0.76), 0.046, "carpaint", tint, 0.046)
            # Blackout B-pillar between front & rear cab windows
            beam((-0.08, 1.14, sg * 0.89), (-0.12, 1.75, sg * 0.77), 0.036, "cartrim", "#15171b", 0.036)
            # Roof side rail header
            beam((-0.72, 1.75, sg * 0.77), (0.58, 1.75, sg * 0.76), 0.036, "carpaint", tint, 0.036)
            # Flush recessed side windows (dark privacy glass)
            _quad_glass(
                (1.10, 1.15, sg * 0.87), (-0.64, 1.15, sg * 0.87),
                (-0.62, 1.73, sg * 0.76), (0.56, 1.73, sg * 0.75),
            )
            # Wing mirror + horizontal door handles
            mirror(0.76, 1.24, sg * 0.95, sg, tint=tint)
            hz0, hz1 = sorted((sg * 0.97, sg * 1.015))
            rbox("cartrim", -0.02, 0.97, hz0, 0.14, 1.02, hz1, "#191c20", k=0.01, p=0.3, M=6)
            rbox("cartrim", -0.52, 0.97, hz0, -0.38, 1.02, hz1, "#191c20", k=0.01, p=0.3, M=6)
            # Running boards / tubular side steps
            rbox("cartrim", -0.92, 0.34, min(sg * 0.90, sg * 1.08), 0.96, 0.40, max(sg * 0.90, sg * 1.08), "#1f2226", k=0.014, p=0.4, M=8)
            box("carchrome", -0.88, 0.395, min(sg * 0.98, sg * 1.06), 0.92, 0.41, max(sg * 0.98, sg * 1.06), "#a8b0b8", 0.3, dirt=False)
            # Lower charcoal rocker cladding strip
            cz0, cz1 = sorted((sg * (hw - 0.01), sg * (hw + 0.015)))
            box("cartrim", -1.16, 0.42, cz0, 1.12, 0.54, cz1, "#22252a", 0.3, dirt=False)
        # Sloped front windshield (dark tinted glass) + rear sliding cab glass
        _quad_glass((1.16, 1.15, -0.86), (1.16, 1.15, 0.86), (0.58, 1.75, 0.76), (0.58, 1.75, -0.76))
        _quad_glass((-0.82, 1.26, 0.58), (-0.82, 1.26, -0.58), (-0.80, 1.66, -0.58), (-0.80, 1.66, 0.58))
        # Matte-black off-road bed sports bar behind cab
        for sg in (-1, 1):
            beam((-0.94, 1.16, sg * 0.86), (-0.94, 1.74, sg * 0.74), 0.034, "cartrim", "#1c1f24", 0.034)
            beam((-0.94, 1.72, sg * 0.74), (-1.52, 1.17, sg * 0.86), 0.030, "cartrim", "#1c1f24", 0.030)
        beam((-0.94, 1.74, -0.74), (-0.94, 1.74, 0.74), 0.034, "cartrim", "#1c1f24", 0.034)

        # Interior silhouette (seats, headrests, dash) visible subtly through tinted glass
        rbox("cartrim", -0.28, 1.06, -0.68, 0.16, 1.48, -0.10, "#1c1f24", k=0.04, p=0.4, M=8)
        rbox("cartrim", -0.28, 1.06, 0.10, 0.16, 1.48, 0.68, "#1c1f24", k=0.04, p=0.4, M=8)
        rbox("cartrim", -0.26, 1.48, -0.50, -0.10, 1.64, -0.26, "#1c1f24", k=0.03, p=0.5, M=8)
        rbox("cartrim", -0.26, 1.48, 0.26, -0.10, 1.64, 0.50, "#1c1f24", k=0.03, p=0.5, M=8)
        rbox("cartrim", 0.56, 1.08, -0.78, 1.06, 1.32, 0.78, "#181a1e", k=0.04, p=0.4, M=8)
        side_slit(0.24, 0.54, 1.12, hw + 0.004)
        side_slit(-0.62, 0.54, 1.12, hw + 0.004)

        # ---- 4. FRONT & REAR BUMPERS, GRILLE, LIGHTS ----
        # Rugged matte-black front bumper + brushed alloy skid plate + fog lamps
        rbox("cartrim", 2.58, 0.44, -0.94, 2.82, 0.66, 0.94, "#202328", k=0.035, p=0.35, M=10)
        rbox("carchrome", 2.52, 0.36, -0.46, 2.74, 0.47, 0.46, "#9aa3ac", k=0.02, p=0.35, M=8)
        # Chrome rear step bumper + black center step pad
        rbox("carchrome", -2.84, 0.43, -0.95, -2.66, 0.60, 0.95, "#b8c0c8", k=0.03, p=0.35, M=10)
        rbox("cartrim", -2.85, 0.54, -0.42, -2.67, 0.62, 0.42, "#1c1f24", k=0.015, p=0.3, M=8)
        # Wide framed radiator grille with horizontal chrome slats
        rbox("carchrome", 2.62, 0.68, -0.56, 2.74, 0.94, 0.56, "#bcc4cc", k=0.02, p=0.3, M=8)
        box("cartrim", 2.66, 0.71, -0.52, 2.755, 0.91, 0.52, "#14161a", 0.3, dirt=False)
        for gy_ in (0.76, 0.81, 0.86):
            box("carchrome", 2.74, gy_ - 0.012, -0.50, 2.775, gy_ + 0.012, 0.50, "#ced5dc", 0.3, dirt=False)
        for sg in (-1, 1):
            vlight(2.68, 0.83, sg * 0.72, "head")
            vlight(-2.72, 0.94, sg * 0.87, "tail")
            rbox("glass", 2.78, 0.51, sg * 0.64 - 0.07, 2.83, 0.59, sg * 0.64 + 0.07, "#eef4fa", k=0.015, p=0.4, M=6)
    else:
        Rw = 0.39
        Ra = Rw + 0.08
        wxs = (-1.45, 1.45)
        y_arch_top = 0.92

        # ---- SUV: CONTINUOUS BELTLINE + REAL WHEEL-ARCH CUTOUTS ----
        # Continuous mid-body side between axles (y = 0.40..1.18)
        loft("carpaint", [(-0.92, 0.40, 1.18, W), (0.0, 0.40, 1.18, W), (0.94, 0.40, 1.16, W)], 20, 0.24, tint, caps=True, var=0.015)
        # Front & rear upper fenders over wheel arches
        loft("carpaint", [
            (0.92, 0.90, 1.16, W), (1.50, 0.90, 1.12, W * 0.985), (1.96, 0.89, 1.05, W * 0.95),
            (2.24, 0.86, 0.98, W * 0.88), (2.36, 0.78, 0.90, W * 0.78),
        ], 20, 0.28, tint, caps=True, var=0.015)
        loft("carpaint", [
            (-2.34, 0.90, 1.12, W * 0.88), (-2.16, 0.90, 1.18, W * 0.96), (-1.50, 0.90, 1.18, W), (-0.90, 0.90, 1.18, W),
        ], 20, 0.26, tint, caps=True, var=0.015)
        loft("carpaint", [(1.98, 0.46, 0.92, W * 0.94), (2.26, 0.48, 0.88, W * 0.88), (2.36, 0.54, 0.85, W * 0.78)], 16, 0.28, tint, caps=True, var=0.015)
        loft("carpaint", [(-2.34, 0.48, 0.92, W * 0.88), (-2.16, 0.44, 0.92, W * 0.96), (-1.98, 0.42, 0.92, W)], 16, 0.24, tint, caps=True, var=0.015)

        # Solid sculpted SUV roof + solid rear tailgate surround & tapered D-pillars + tinted glass
        loft("carpaint", [
            (-2.08, 1.82, 1.90, 1.56), (-1.65, 1.82, 1.94, 1.62), (0.0, 1.82, 1.94, 1.62), (0.48, 1.82, 1.89, 1.54),
        ], 18, 0.42, tint, caps=True, var=0.012)
        rbox("carpaint", -2.26, 1.12, -0.88, -2.02, 1.32, 0.88, tint, k=0.02, p=0.35, M=8)
        rbox("carpaint", -2.12, 1.74, -0.78, -1.96, 1.88, 0.78, tint, k=0.02, p=0.35, M=8)
        for sg in (-1, 1):
            beam((1.12, 1.15, sg * 0.89), (0.46, 1.85, sg * 0.77), 0.046, "carpaint", tint, 0.046)
            beam((-0.38, 1.16, sg * 0.89), (-0.42, 1.85, sg * 0.78), 0.036, "cartrim", "#16181c", 0.036)
            beam((-1.32, 1.16, sg * 0.89), (-1.34, 1.85, sg * 0.78), 0.040, "cartrim", "#16181c", 0.040)
            for cx_ in (-2.12, -2.02):
                beam((cx_, 1.16, sg * 0.88), (cx_ + 0.08, 1.84, sg * 0.77), 0.055, "carpaint", tint, 0.055)
            beam((-1.98, 1.84, sg * 0.78), (0.46, 1.84, sg * 0.77), 0.036, "carpaint", tint, 0.036)
            # Alloy roof rails
            beam((-1.82, 1.97, sg * 0.62), (0.34, 1.97, sg * 0.62), 0.024, "carchrome", "#a8b0b8", 0.024)
            _quad_glass((1.06, 1.17, sg * 0.87), (-1.96, 1.17, sg * 0.87), (-1.96, 1.83, sg * 0.77), (0.44, 1.83, sg * 0.77))
            mirror(0.84, 1.26, sg * 0.95, sg, tint=tint)
            rbox("cartrim", -0.88, 0.34, min(sg * 0.90, sg * 1.06), 0.88, 0.39, max(sg * 0.90, sg * 1.06), "#1f2226", k=0.014, p=0.4, M=8)
            cz0, cz1 = sorted((sg * (hw - 0.01), sg * (hw + 0.015)))
            box("cartrim", -0.92, 0.40, cz0, 0.92, 0.52, cz1, "#22252a", 0.3, dirt=False)
        _quad_glass((1.12, 1.16, -0.86), (1.12, 1.16, 0.86), (0.46, 1.85, 0.76), (0.46, 1.85, -0.76))
        _quad_glass((-2.16, 1.30, 0.64), (-2.16, 1.30, -0.64), (-2.06, 1.76, -0.62), (-2.06, 1.76, 0.62))
        rbox("cartrim", -0.35, 1.08, -0.68, 0.15, 1.54, 0.68, "#1c1f24", k=0.04, p=0.4, M=8)
        rbox("cartrim", -1.45, 1.08, -0.68, -1.05, 1.56, 0.68, "#1c1f24", k=0.04, p=0.4, M=8)
        rbox("cartrim", 0.62, 1.10, -0.76, 1.02, 1.34, 0.76, "#181a1e", k=0.04, p=0.4, M=8)
        side_slit(0.28, 0.52, 1.14, hw + 0.004)
        side_slit(-0.92, 0.52, 1.14, hw + 0.004)
        rbox("cartrim", 2.26, 0.42, -0.90, 2.48, 0.64, 0.90, "#202328", k=0.03, p=0.35, M=10)
        rbox("cartrim", -2.48, 0.42, -0.92, -2.26, 0.64, 0.92, "#202328", k=0.03, p=0.35, M=10)
        rbox("carchrome", 2.28, 0.68, -0.52, 2.42, 0.91, 0.52, "#bcc4cc", k=0.02, p=0.3, M=8)
        box("cartrim", 2.34, 0.71, -0.48, 2.435, 0.88, 0.48, "#14161a", 0.3, dirt=False)
        for sg in (-1, 1):
            vlight(2.35, 0.84, sg * 0.70, "head")
            vlight(-2.38, 0.96, sg * 0.84, "tail")

    # ---- 5. REAL 3D WHEELS, FENDER CUTOUTS & INNER CHASSIS ----
    for xw in wxs:
        # Narrow dark inner engine/chassis bay behind wheel wells (z = -0.66..+0.66)
        box("cartrim", xw - Ra - 0.08, 0.38, -0.66, xw + Ra + 0.08, y_arch_top, 0.66, "#141619", 0.5, dirt=False)
        for sg in (-1, 1):
            fender_cutout(xw, Rw, sg * hw, sg, Ra=Ra, y_top=y_arch_top, x_pad=0.065, tint=tint)
            wheel(xw, Rw, sg * (hw - 0.13), sg, R=Rw, W=0.27, rim=Rw * 0.60)
    # Dark undercarriage & axles
    box("cartrim", wxs[0], 0.32, -0.66, wxs[1], 0.48, 0.66, "#141619", 0.5, dirt=False)
    for xw in wxs:
        cylz("cartrim", xw, Rw, -0.78, 0.78, 0.048, seg=8, tint="#1d2024", dirt=False)
    pop()
    Lh = 2.8 if kind == "pickup" else 2.45
    col_rot(x, z, Lh, W / 2, rot, y, y + (1.8 if kind == "pickup" else 1.95), F_DEFAULT, S_METAL)
    reserve_rect_rot(x, z, Lh + 0.4, W / 2 + 0.4, rot)


def tractor(x, z, rot):
    y = float(gh(x, z))
    push(roty(rot), (x, y, z))
    red, rust = "#8f2d1f", "#6a2a1a"
    # engine hood (tapered) + grille + side panels
    loft("paint", [(0.1, 0.62, 1.38, 0.78), (0.6, 0.6, 1.52, 0.86), (1.3, 0.6, 1.5, 0.84), (1.75, 0.62, 1.36, 0.8), (1.88, 0.7, 1.2, 0.66)], 18, 0.55, red, caps=True, var=0.08)
    rbox("metal", 1.86, 0.7, -0.3, 1.98, 1.28, 0.3, "#202224", p=0.4)
    for k in range(5):
        box("metal", 1.99, 0.76 + k * 0.1, -0.26, 2.01, 0.8 + k * 0.1, 0.26, "#8a8d90", 0.3, dirt=False, skip=("-z", "+z"))
    # transmission / rear body
    rbox("paint", -1.0, 0.55, -0.42, 0.2, 1.3, 0.42, red, p=0.5)
    rbox("paint", -1.6, 0.5, -0.38, -1.0, 1.05, 0.38, "#4a4f52", p=0.4)
    # axles
    cylz("metal", -1.25, 0.78, -1.05, 1.05, 0.09, seg=10, tint="#2a2c2e", dirt=False)
    cylz("metal", 1.25, 0.45, -0.75, 0.75, 0.06, seg=8, tint="#2a2c2e", dirt=False)
    # seat, deck, steering
    rbox("paint", -0.95, 1.3, -0.3, -0.45, 1.42, 0.3, "#2c2f31", p=0.5)
    rbox("paint", -0.98, 1.38, -0.28, -0.84, 1.8, 0.28, "#2c2f31", p=0.5)
    cyly("metal", 0.15, 1.5, 1.95, 0.0, 0.025, seg=6, tint="#2a2a2a", dirt=False)
    prof = [(0.17 + 0.02 * math.cos(a), 0.02 * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 7)]
    push(roty(0), (0.1, 1.88, 0.0))
    push(rotz(0.9), (0, 0, 0))
    lathe("paint", prof, 14, "#1a1b1c")
    pop()
    pop()
    # ROPS frame + canopy
    for sx in (-0.25, -1.05):
        for sg in (-1, 1):
            cyly("metal", sx, 1.3, 2.55, sg * 0.5, 0.035, seg=6, tint="#2c3033", dirt=False)
    rbox("paint", -1.15, 2.52, -0.62, -0.1, 2.62, 0.62, "#7a2a1c", p=0.4)
    # exhaust stack + air filter
    cyly("metal", 1.3, 1.45, 2.3, 0.28, 0.045, seg=8, tint="#2a2a2a", dirt=False)
    cyly("metal", 1.3, 2.3, 2.36, 0.28, 0.07, seg=8, tint="#2a2a2a", dirt=False)
    # lights
    for sg in (-1, 1):
        vlight(1.92, 1.1, sg * 0.4, "head")
    rbox("paint", 1.55, 0.4, -0.4, 2.1, 0.55, 0.4, "#2a2c2f", p=0.5)
    # fenders over rear wheels
    for sg in (-1, 1):
        for k in range(8):
            a = math.pi * (0.1 + 0.8 * k / 7)
            pass
        prof = []
        for k in range(9):
            a = math.pi * 0.05 + math.pi * 0.9 * k / 8
            prof.append((0.86 * math.cos(a), 0.86 * math.sin(a)))
        push(None, (-1.25, 0.78, sg * 0.82))
        arc = [(0.0, 0.0)]
        P_ = []
        for k in range(10):
            a = math.pi * 0.08 + math.pi * 0.84 * k / 9
            for zz in (-0.2, 0.2):
                P_.append((0.84 * math.cos(a), 0.84 * math.sin(a) + 0.03, zz))
        P_ = np.array(P_)
        I_ = []
        for k in range(9):
            a_, b_, c_, d_ = 2 * k, 2 * k + 1, 2 * k + 3, 2 * k + 2
            I_.append((a_, b_, c_))
            I_.append((a_, c_, d_))
        emit_smooth("paint", P_ * [1, 1.0, 1], np.array(I_), np.array([0, 0.0, 0]), red, 0.8, 0.08)
        pop()
    # wheels: big lugged rears, small ribbed fronts
    for sg in (-1, 1):
        wheel(-1.25, 0.78, sg * 0.95, sg, R=0.78, W=0.42, rim=0.44, seg=18, tint="#18191a", lugs=14, rimtint="#c9aa3a")
        wheel(1.25, 0.45, sg * 0.62, sg, R=0.45, W=0.2, rim=0.26, seg=14, tint="#18191a", ribs=True, rimtint="#b09030")
    pop()
    col_rot(x, z, 1.9, 0.9, rot, y, y + 2.0, F_DEFAULT, S_METAL)
    col_rot(x, z, 0.6, 0.6, rot, y + 2.0, y + 2.6, F_DEFAULT, S_METAL)
    reserve_rect_rot(x, z, 2.4, 1.3, rot)


# ----------------------------------------------------------------------------------------------
# lodge interior extras: rugs, wall details, ceiling with beams
# ----------------------------------------------------------------------------------------------
def rug(x0, z0, x1, z1, y, c1, c2, b=0.18):
    quad("cloth", (x0, y, z1), (x1, y, z1), (x1, y, z0), (x0, y, z0), "y", c1, 1.0, dirt=False, var=0.06)
    quad("cloth", (x0 + b, y + 0.004, z1 - b), (x1 - b, y + 0.004, z1 - b), (x1 - b, y + 0.004, z0 + b), (x0 + b, y + 0.004, z0 + b), "y", c2, 1.0, dirt=False, var=0.06)
    quad("cloth", (x0 + 2 * b, y + 0.008, z1 - 2 * b), (x1 - 2 * b, y + 0.008, z1 - 2 * b), (x1 - 2 * b, y + 0.008, z0 + 2 * b), (x0 + 2 * b, y + 0.008, z0 + 2 * b), "y", c1, 1.0, dirt=False, var=0.06)


def picture(wall_x=None, wall_z=None, c=0, y=1.6, w=0.8, h=0.6, canvas="#7a8a6a", frame="#4a3220", sgn=1):
    """Framed picture on an interior wall. wall_z: picture hangs on z-wall plane facing sgn; wall_x likewise."""
    if wall_z is not None:
        z = wall_z
        box("planks", c - w / 2 - 0.05, y - h / 2 - 0.05, z, c + w / 2 + 0.05, y + h / 2 + 0.05, z + sgn * 0.05, frame, 0.5, dirt=False)
        face("+z" if sgn > 0 else "-z", c - w / 2, y - h / 2, z + sgn * 0.052, c + w / 2, y + h / 2, z + sgn * 0.052, "cloth", canvas, 0.6, False)
    else:
        x = wall_x
        box("planks", x, y - h / 2 - 0.05, c - w / 2 - 0.05, x + sgn * 0.05, y + h / 2 + 0.05, c + w / 2 + 0.05, frame, 0.5, dirt=False)
        face("+x" if sgn > 0 else "-x", x + sgn * 0.052, y - h / 2, c - w / 2, x + sgn * 0.052, y + h / 2, c + w / 2, "cloth", canvas, 0.6, False)


def antlers(x, y, z, facing):
    # rack mounted on a plaque; facing: unit direction (dx,dz) pointing into the room
    dx, dz = facing
    push(roty(math.atan2(-dz, dx)), (x, y, z))
    box("planks", -0.04, -0.2, -0.22, 0.04, 0.2, 0.22, "#4a3220", 0.5, dirt=False)
    for sg in (-1, 1):
        pts = [(0.05, 0.1, sg * 0.1), (0.2, 0.3, sg * 0.25), (0.28, 0.55, sg * 0.38), (0.25, 0.8, sg * 0.5)]
        for a, b in zip(pts[:-1], pts[1:]):
            beam(a, b, 0.022, "planks", "#d8cbb0", 0.022)
        for (a, b) in (((0.2, 0.3, sg * 0.25), (0.38, 0.5, sg * 0.2)), ((0.28, 0.55, sg * 0.38), (0.4, 0.78, sg * 0.34)), ((0.25, 0.8, sg * 0.5), (0.3, 1.0, sg * 0.46))):
            beam(a, b, 0.016, "planks", "#d8cbb0", 0.016)
    pop()


def build_lodge_extra():
    # ceiling with beams (flat, just above the wall tops, under the roof)
    CY = 5.86
    quad({"paint": "planks"}["paint"], (-9.55, CY, 5.55), (9.55, CY, 5.55), (9.55, CY, -5.55), (-9.55, CY, -5.55), "y", "#b79a74", 1.6, dirt=False, nu=4, nv=3, var=0.12)
    for xb in np.arange(-9.0, 9.1, 2.25):
        box("log", xb - 0.13, CY - 0.34, -5.55, xb + 0.13, CY, 5.55, "#c4a781", 0.8, dirt=False, skip=("+y",))
    for zb in (-3.0, 0.0, 3.0):
        box("log", -9.55, CY - 0.26, zb - 0.12, 9.55, CY - 0.0, zb + 0.12, "#b79a74", 0.8, dirt=False, skip=("+y",))
    # chandelier in the open void (antler-ring with candles)
    cx_, cz_ = -1.0, 2.4
    for sx in (-0.4, 0.4):
        beam((cx_ + sx, CY - 0.34, cz_), (cx_ + sx * 0.6, 4.7, cz_), 0.012, "metal", "#222426", 0.012)
    prof = [(0.55 + 0.03 * math.cos(a), 0.03 * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 7)]
    push(rotx(math.pi / 2), (cx_, 4.65, cz_))
    lathe("metal", [(0.52 + 0.035 * math.cos(a), 0.035 * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 7)], 16, "#1e2022")
    pop()
    for k in range(8):
        a = k * math.pi / 4
        lantern_post(cx_ + 0.52 * math.cos(a), cz_ + 0.52 * math.sin(a), hang=True, y=4.7) if False else None
        box("glow", cx_ + 0.52 * math.cos(a) - 0.03, 4.67, cz_ + 0.52 * math.sin(a) - 0.03, cx_ + 0.52 * math.cos(a) + 0.03, 4.84, cz_ + 0.52 * math.sin(a) + 0.03, "#ffffff", 0.3, dirt=False, skip=("-y",))
    # baseboards
    for (x0, z0, x1, z1) in ((-9.55, -5.55, 9.55, -5.5), (-9.55, 5.5, 9.55, 5.55)):
        box("planks", x0, 0.04, z0, x1, 0.2, z1, "#5a3d26", 0.6, dirt=False, skip=("-z", "+z") if False else ())
    # rugs
    rug(-5.7, -5.4, -4.3, -2.3, 0.045, "#6b2d28", "#c9a76a")
    rug(-2.9, -4.7, 4.9, -1.8, 0.045, "#41546a", "#cdb98a", 0.2)
    rug(8.6, -0.9, 9.5, 0.9, 0.045, "#6b2d28", "#c9a76a", 0.1)
    rug(4.2, 3.0, 8.4, 5.4, 0.045, "#5a6a40", "#c8b88a", 0.15) if False else None
    rug(-1.6, 1.4, 1.6, 3.8, 0.045, "#7a4a2a", "#d8c9a2", 0.15)
    rug(-8.4, 3.8, -7.4, 4.6, 0.045, "#41546a", "#cdb98a", 0.08) if False else None
    # upper gallery rugs
    rug(-6.2, -4.9, 6.0, -2.4, 3.012, "#7a3a2a", "#d2b886", 0.2)
    rug(8.0, 1.6, 9.4, 4.4, 3.012, "#41546a", "#cdb98a", 0.1)
    # pictures + antlers + wall clock + snowshoes (ground floor)
    picture(wall_z=-5.5, c=-8.0, y=1.75, w=0.9, h=0.65, canvas="#7a8e9a", sgn=1)
    picture(wall_z=-5.5, c=-1.4, y=1.8, w=1.2, h=0.8, canvas="#6a7a52", sgn=1)
    picture(wall_z=-5.5, c=3.4, y=1.75, w=0.7, h=0.9, canvas="#8a6a52", sgn=1)
    picture(wall_x=9.5, c=-3.6, y=1.8, w=0.8, h=0.6, canvas="#8a7a5a", sgn=-1)
    picture(wall_x=9.5, c=3.6, y=1.8, w=0.9, h=0.7, canvas="#5a6a7a", sgn=-1)
    picture(wall_z=5.5, c=-1.9, y=1.7, w=0.9, h=0.7, canvas="#7a6a8a", sgn=-1)
    picture(wall_z=5.5, c=1.8, y=1.7, w=0.7, h=0.9, canvas="#6a8a7a", sgn=-1)
    antlers(-8.05, 2.5, 0.0, (1, 0))
    prof = [(0.22 + 0.02 * math.cos(a), 0.02 * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 7)]
    push(roty(math.pi / 2), (-5.5 + 0.0, 2.0, 5.5))
    pop()
    push(rotx(0), (-9.5, 1.9, 4.2))
    push(roty(math.pi / 2), (0, 0, 0))
    lathe("metal", prof, 14, "#5a4026")
    pop()
    pop()
    # curtains on south windows (inside)
    for c in (-8.2, 0, 8.2):
        w = 2.4 if c == 0 else 1.3
        for sg in (-1, 1):
            xx = c + sg * (w / 2 + 0.12)
            box("cloth", xx - 0.18, 0.7, 5.35, xx + 0.18, 2.5, 5.5, "#7a3a30", 0.5, dirt=False, skip=("-z", "-y"))
        box("log", c - w / 2 - 0.4, 2.45, 5.38, c + w / 2 + 0.4, 2.52, 5.43, "#3a2a1c", 0.5, dirt=False)
    # coat hooks + coats near the north door
    box("planks", -7.0, 1.7, -5.5, -6.0, 1.76, -5.46, "#3a2a1c", 0.5, dirt=False)
    for k, cc in enumerate(("#4a5a3a", "#7a3a30", "#3e4f60")):
        box("cloth", -6.9 + k * 0.33, 0.9, -5.46, -6.62 + k * 0.33, 1.7, -5.34, cc, 0.5, dirt=False, skip=("-y",))
    # wall sconces
    for (sx, sz) in ((-3.0, -5.45), (4.5, -5.45), (-3.0, 5.45), (4.5, 5.45), (9.45, -3.0), (9.45, 3.0)):
        lantern_post(sx, sz, hang=True, y=2.1)
    # bookshelf by the stairs + mantel candlesticks
    box("planks", 1.0, 0.04, 5.0, 2.3, 2.2, 5.5, "#5a3d26", 0.6, dirt=False)
    for sh in range(5):
        for k in range(7):
            box("cloth", 1.05 + k * 0.17, 0.2 + sh * 0.42, 5.05, 1.05 + k * 0.17 + 0.14, 0.2 + sh * 0.42 + 0.3 + 0.04 * (k % 3), 5.45, ["#7a3a30", "#2d4a6a", "#4e6a3a", "#8a6a3a"][(k + sh) % 4], 0.4, dirt=False, skip=("-y", "-x", "+x"))
    col(1.0, 0.04, 5.0, 2.3, 2.2, 5.5, F_SOLID | F_CAMERA, S_WOOD)
    for zc in (-1.3, 1.3):
        box("metal", -8.4, 1.75, zc - 0.03, -8.3, 1.95, zc + 0.03, "#b89a4a", 0.3, dirt=False, skip=("-y",))
    # firewood stack by the hearth
    firewood(-8.6, 3.3, math.pi / 2, 1.0, 6, 5)
    # gallery: wall details on upper floor
    picture(wall_z=-5.5, c=-3.0, y=4.5, w=1.0, h=0.7, canvas="#7a8e9a", sgn=1)
    picture(wall_z=5.5, c=-5.0, y=4.5, w=0.8, h=0.6, canvas="#8a6a52", sgn=-1)
    antlers(9.45, 4.9, 1.5 + 4.6, (-1, 0)) if False else None
    for xl in (-6.0, 0.0, 6.0):
        lantern_post(xl, -5.45, hang=True, y=4.6)


def lodge_tweaks_ok():
    return True

# ----------------------------------------------------------------------------------------------
# ROUND 3: photographic materials, trim/detail geometry, ground detail objects
# ----------------------------------------------------------------------------------------------
def gblur(a, s):
    N = a.shape[0]
    f = np.fft.fftfreq(N)[:, None]
    g = np.fft.fftfreq(a.shape[1])[None, :]
    k = np.exp(-2 * (np.pi * s) ** 2 * (f * f + g * g))
    return np.real(np.fft.ifft2(np.fft.fft2(a) * k))


def cavity_ao(h, s=6.0, k=3.0):
    return np.clip(1 - k * np.maximum(gblur(h, s) - h, 0), 0.15, 1.0)


def _mask_strokes(N, count, seed, L0, L1, angle0, spread, bend):
    m = np.zeros((N, N))
    px, py, T, idv = _strokes(N, count, seed, L0, L1, 1.5, angle0, spread, bend)
    _paint(m, px, py, np.ones(px.shape))
    return m


def tex_log(N=1024):
    X, Y = grid(N)
    w1 = fbm(X * 3, Y * 2, 3, 401, (3, 2))
    w2 = fbm(X * 8, Y * 4, 3, 402, (8, 4))
    lines = np.sin((X * 22 + 2.4 * w1 + 0.9 * w2) * 2 * math.pi) * 0.5 + 0.5
    fine = fbm(X * 90, Y * 5, 3, 403, (90, 5))
    fib = fbm(X * 220, Y * 8, 2, 404, (220, 8))
    t = 0.42 * lines + 0.36 * fine + 0.22 * fib
    alb = mix3(hexc("#80502c")[None, None, :] + 0 * t[..., None], hexc("#c8975e"), smooth(0.25, 0.8, t))
    band = fbm(X * 5, Y * 1, 2, 405, (5, 1))
    alb = alb * (0.82 + 0.34 * band)[..., None]
    wg = smooth(0.5, 0.85, fbm(X * 6, Y * 3, 4, 406, (6, 3))) * 0.5
    alb = mix3(alb, hexc("#a79d8c") * (0.8 + 0.3 * fine)[..., None], wg)
    # checking cracks (long vertical splits) with lighter lips
    cm = np.clip(gblur(_mask_strokes(N, 80, 407, 70, 320, math.pi / 2, 0.05, 0.04), 0.9) * 3.0, 0, 1)
    cm2 = np.clip(gblur(_mask_strokes(N, 140, 408, 25, 90, math.pi / 2, 0.08, 0.05), 0.6) * 2.5, 0, 1)
    crack = np.maximum(cm, 0.6 * cm2)
    alb = alb * (1 - 0.8 * crack)[..., None]
    # knots
    h = 0.22 * lines + 0.34 * fine + 0.18 * fib
    rs = np.random.RandomState(409)
    for k in range(6):
        cx, cy = rs.uniform(0, 1, 2)
        dx = ((X - cx + 0.5) % 1.0) - 0.5
        dy = ((Y - cy + 0.5) % 1.0) - 0.5
        r = np.sqrt((dx / 0.035) ** 2 + (dy / 0.1) ** 2)
        m = smooth(1.5, 0.9, r)
        ring = 0.5 + 0.5 * np.sin(r * 9)
        alb = mix3(alb, hexc("#4a2c16") * (0.8 + 0.4 * ring)[..., None], m * 0.85)
        h = h + m * (0.25 * ring - 0.1) + smooth(1.9, 1.4, r) * 0.15
    h = h - 0.9 * crack
    ao = cavity_ao(h, 3.0, 2.2) * (1 - 0.7 * crack)
    return dict(alb=alb, h=h, rough=0.7 + 0.22 * wg + 0.1 * crack, metal=0 * h, ao=ao, nstr=2.4)


def tex_endgrain(N=512):
    X, Y = grid(N)
    dx, dy = X - 0.5, Y - 0.5
    r = np.sqrt(dx * dx + dy * dy) * 2.0  # 0 centre .. 1 edge of the log
    th = np.arctan2(dy, dx)
    wob = fbm(np.cos(th) * 2 + 3, np.sin(th) * 2 + 3, 3, 421) - 0.5
    cx = 0.12 * (fbm(X * 3, Y * 3, 2, 422) - 0.5)
    f = (r + 0.12 * wob + cx) * 34
    ring = 0.5 + 0.5 * np.sin(f * 2 * math.pi + 1.5 * fbm(X * 9, Y * 9, 2, 423))
    late = smooth(0.55, 1.0, ring)
    alb = mix3(hexc("#d2a771")[None, None, :] + 0 * r[..., None], hexc("#9c6a3a"), late * 0.8)
    alb = alb * (0.86 + 0.28 * fbm(X * 40, Y * 40, 3, 424))[..., None]
    grey = smooth(0.4, 0.8, fbm(X * 4, Y * 4, 3, 425)) * 0.5 + 0.2
    alb = mix3(alb, hexc("#a8a092"), grey * 0.55)
    # radial checks
    ang = np.sin(th * 9 + 4 * fbm(np.cos(th) * 3 + 9, np.sin(th) * 3 + 9, 2, 426))
    chk = smooth(0.96, 1.0, np.abs(ang)) * smooth(0.12, 0.35, r) * smooth(0.95, 0.5, r) * smooth(0.45, 0.65, fbm(X * 6, Y * 6, 2, 427))
    alb = alb * (1 - 0.75 * chk)[..., None]
    # bark rim
    bark = smooth(0.9, 0.97, r)
    alb = mix3(alb, hexc("#4a3a2c") * (0.7 + 0.6 * fbm(X * 30, Y * 30, 2, 428))[..., None], bark)
    h = 0.3 * ring - 0.6 * chk + 0.3 * bark + 0.1 * fbm(X * 40, Y * 40, 2, 429)
    return dict(alb=alb, h=h, rough=0.85 + 0 * h, metal=0 * h, ao=1 - 0.7 * chk, nstr=2.0)


def tex_stone(N=1024):
    X, Y = grid(N)
    f1, f2, v = voronoi(N, 7, 11, 0.8)
    warp = (fbm(X * 10, Y * 10, 3, 431, (10, 10)) - 0.5) * 0.07
    edge = (f2 - f1) + warp
    st = smooth(0.02, 0.1, edge)
    dome = smooth(0.0, 0.5, edge) ** 0.7
    chisel = fbm(X * 70, Y * 70, 4, 432, (70, 70))
    pal = np.array([hexc(c) for c in ("#77736c", "#8b8374", "#5e5d5b", "#9a9080", "#7a7062", "#a39b90", "#6a665e", "#857c6c")])
    base = pal[(v * 8).astype(int) % 8]
    vein = 0.5 + 0.5 * np.sin((X * 6 + Y * 3 + v * 5 + 0.6 * fbm(X * 6, Y * 6, 3, 433, (6, 6))) * 2 * math.pi)
    alb = base * (0.74 + 0.36 * chisel + 0.16 * vein)[..., None] * (0.82 + 0.3 * dome)[..., None]
    mort = hexc("#a69e8c")[None, None, :] * (0.7 + 0.5 * fbm(X * 120, Y * 120, 2, 434, (120, 120)))[..., None]
    alb = mix3(mort, alb, st)
    lich = smooth(0.74, 0.8, fbm(X * 12, Y * 12, 4, 435, (12, 12))) * st
    alb = mix3(alb, hexc("#c8932e") * (0.8 + 0.4 * chisel)[..., None], lich * 0.85)
    gl = smooth(0.7, 0.78, fbm(X * 9, Y * 9, 4, 436, (9, 9))) * st
    alb = mix3(alb, hexc("#9fae82"), gl * 0.7)
    crev = 1 - smooth(0.03, 0.35, edge)
    moss = smooth(0.5, 0.78, fbm(X * 4, Y * 4, 4, 437, (4, 4))) * (0.25 + 0.75 * crev)
    alb = mix3(alb, hexc("#456a26") * (0.7 + 0.6 * chisel)[..., None], moss * 0.8)
    alb = alb * (1 - 0.45 * crev)[..., None]
    h = st * (0.5 + 0.42 * dome + 0.14 * chisel) + (1 - st) * 0.04
    ao = cavity_ao(h, 9.0, 3.2)
    return dict(alb=alb, h=h, rough=0.88 - 0.2 * moss - 0.05 * (1 - st), metal=0 * h, ao=ao, nstr=3.4)


def tex_shingle(N=1024):
    X, Y = grid(N)
    rows = 8
    r = Y * rows
    ri = np.floor(r).astype(int)
    fr = r - ri
    jit = np.floor(_hash(ri, ri * 0 + 3, 9) * 7)
    xo = X * 7 + jit + 0.5 * (ri % 2)
    ci = np.floor(xo).astype(int)
    fc = xo - ci
    cell = _hash(ci % 7, ri % rows * 5 + 1, 5)
    cell2 = _hash(ci % 7, ri % rows * 3 + 2, 6)
    pal = np.array([hexc(c) for c in ("#5b4a3a", "#6a5a48", "#4a4036", "#7a6a58", "#8a8174", "#3f3a34", "#6e5a44")])
    base = pal[(cell * 7).astype(int) % 7]
    alb = base * (0.8 + 0.4 * cell2)[..., None]
    streak = smooth(0.5, 0.85, fbm(X * 70, Y * 3, 4, 441, (70, 3)))
    alb = alb * (1 - 0.3 * streak)[..., None]
    silver = smooth(0.45, 0.8, fbm(X * 12, Y * 8, 4, 442, (12, 8))) * 0.4
    alb = mix3(alb, hexc("#a8a193"), silver * smooth(0.3, 1.0, fr))
    shade = 0.5 + 0.5 * smooth(0.0, 0.4, fr)
    alb = alb * shade[..., None]
    bottom = 0.9 + 0.08 * cell
    inside = (fr < bottom).astype(float)
    gapx = np.minimum(smooth(0.0, 0.05, fc), smooth(1.0, 0.95, fc))
    under = smooth(bottom - 0.02, bottom + 0.06, fr)  # shadowed overlap region
    cov = gapx * (1 - 0.8 * under)
    alb = alb * (0.3 + 0.7 * cov)[..., None]
    gran = fbm(X * 200, Y * 200, 2, 443, (200, 200))
    alb = alb * (0.85 + 0.3 * gran)[..., None]
    moss = smooth(0.62, 0.8, fbm(X * 3, Y * 3, 4, 444, (3, 3))) * smooth(0.2, 0.8, 1 - fc) * smooth(0.3, 1.0, fr)
    alb = mix3(alb, hexc("#4c6428") * (0.7 + 0.6 * gran)[..., None], moss * 0.7)
    curl = (smooth(0.8, 1.0, fc) + smooth(0.2, 0.0, fc)) * fr * 0.18
    h = (fr ** 1.5 * 0.7 + curl) * inside * gapx + 0.05 * gran
    h = h - 0.3 * under
    ao = cavity_ao(h, 6.0, 2.8) * (0.5 + 0.5 * cov)
    return dict(alb=alb, h=h, rough=0.86 - 0.1 * moss, metal=0 * h, ao=ao, nstr=3.0)


def tex_planks(N=512):
    X, Y = grid(N)
    pl = 5
    r = Y * pl
    ri = np.floor(r).astype(int)
    fr = r - ri
    off = _hash(ri, ri * 0, 2)
    xs = X + off
    warp = fbm(xs * 3, Y * 30, 3, 451, (3, 30))
    lines = 0.5 + 0.5 * np.sin((fr * 16 + 2.0 * warp + 0.6 * fbm(xs * 8, Y * 20, 2, 452, (8, 20))) * math.pi)
    fine = fbm(xs * 10, Y * 140, 3, 453, (10, 140))
    t = 0.4 * lines + 0.6 * fine
    tone = _hash(ri, ri * 0 + 1, 7)
    alb = mix3(hexc("#6b4b2e")[None, None, :] + 0 * t[..., None], hexc("#9a7650"), smooth(0.2, 0.85, t * 0.7 + tone * 0.4))
    grey = smooth(0.45, 0.8, fbm(X * 3, Y * 3, 3, 454, (3, 3)))
    alb = mix3(alb, hexc("#8e8a80"), grey * 0.45)
    gap = smooth(0.0, 0.05, fr) * smooth(1.0, 0.95, fr)
    alb = alb * (0.35 + 0.65 * gap)[..., None]
    # nail heads at two stations per board
    ns = 0
    for nx in (0.07, 0.57):
        dxn = ((X - (nx + 0.0) * 1.0 + 0.5) % 1.0) - 0.5
        dyn = (fr - 0.25)
        d1 = np.sqrt((dxn / 0.012) ** 2 + (dyn / 0.06) ** 2)
        dyn2 = (fr - 0.75)
        d2 = np.sqrt((dxn / 0.012) ** 2 + (dyn2 / 0.06) ** 2)
        ns = np.maximum(ns, np.maximum(smooth(1.0, 0.5, d1), smooth(1.0, 0.5, d2)))
    alb = mix3(alb, hexc("#2a2622"), ns * 0.8)
    # wear path (polished by feet) across the middle of the tile
    wear = np.exp(-((X - 0.5) / 0.18) ** 2)
    alb = alb * (1 + 0.12 * wear)[..., None]
    # knots
    h = 0.3 * lines + 0.2 * fine
    rs = np.random.RandomState(455)
    for k in range(4):
        cx, cy = rs.uniform(0, 1, 2)
        dxk = ((X - cx + 0.5) % 1.0) - 0.5
        dyk = ((Y - cy + 0.5) % 1.0) - 0.5
        rk = np.sqrt((dxk / 0.03) ** 2 + (dyk / 0.012) ** 2)
        mk = smooth(1.2, 0.8, rk)
        alb = mix3(alb, hexc("#4a2e1a"), mk * 0.45)
        h = h - 0.15 * mk
    h = h * gap + 0.0 - 0.3 * (1 - gap) - 0.25 * ns
    ao = cavity_ao(h, 3.0, 2.5) * (0.5 + 0.5 * gap)
    return dict(alb=alb, h=h, rough=0.84 - 0.2 * wear, metal=0 * h, ao=ao, nstr=2.2)


def tex_paint(N=512):
    X, Y = grid(N)
    br = fbm(X * 8, Y * 90, 3, 461, (8, 90))
    base = hexc("#ece8de")
    alb = np.ones((N, N, 3)) * base * (0.93 + 0.1 * br)[..., None]
    flake = smooth(0.66, 0.7, fbm(X * 18, Y * 18, 4, 462, (18, 18)) + 0.1 * fbm(X * 60, Y * 60, 3, 463, (60, 60)))
    under = hexc("#8a6a4a") * (0.7 + 0.5 * fbm(X * 50, Y * 50, 3, 464, (50, 50)))[..., None]
    deep = smooth(0.8, 0.84, fbm(X * 18, Y * 18, 4, 462, (18, 18)))
    alb = mix3(alb, under, flake * 0.55)
    alb = mix3(alb, hexc("#3a2a1c"), deep * 0.45)
    dirt = smooth(0.45, 0.85, fbm(X * 3, Y * 14, 4, 465, (3, 14)))
    alb = alb * (1 - 0.28 * dirt)[..., None]
    mould = smooth(0.7, 0.85, fbm(X * 5, Y * 12, 4, 466, (5, 12)))
    alb = mix3(alb, hexc("#5a6a44"), mould * 0.25)
    h = 0.5 + 0.08 * br - 0.35 * flake - 0.2 * deep
    return dict(alb=alb, h=h, rough=0.55 + 0.35 * flake + 0.1 * dirt, metal=0 * h, ao=1 - 0.5 * flake, nstr=1.6)


def tex_metal(N=512):
    X, Y = grid(N)
    wave = 0.5 + 0.5 * np.sin(X * 2 * math.pi * 10)
    n = fbm(X * 12, Y * 12, 4, 471, (12, 12))
    rn = fbm(X * 4, Y * 4, 5, 472, (4, 4))
    edge = smooth(0.8, 1.0, wave)
    rust = np.clip(smooth(0.5, 0.7, rn * 0.7 + n * 0.3) + 0.5 * edge * smooth(0.4, 0.65, n), 0, 1)
    base = hexc("#8e969a") * (0.75 + 0.35 * n)[..., None]
    scratches = _mask_strokes(N, 160, 473, 20, 90, 1.57, 0.5, 0.0)
    base = base * (1 + 0.2 * gblur(scratches, 0.7) * 4)[..., None]
    rustc = mix3(hexc("#8a4a22")[None, None, :] + 0 * n[..., None], hexc("#5a2c14"), n)
    alb = mix3(base, rustc, rust)
    # bolts along crests
    bolt = np.zeros((N, N))
    for bx in np.arange(0.05, 1.0, 0.1):
        for by in (0.1, 0.6):
            d = np.hypot((X - bx) * 1, (Y - by) * 1)
            bolt = np.maximum(bolt, smooth(0.012, 0.006, d))
    alb = mix3(alb, hexc("#3a3836"), bolt * 0.7)
    h = wave * 0.55 + 0.1 * n - 0.25 * rust + 0.15 * bolt
    return dict(alb=alb, h=h, rough=0.4 + 0.5 * rust, metal=(1 - rust) * 0.88, ao=cavity_ao(h, 3.0, 2.0), nstr=2.2)


MATS.update({
    "log": (tex_log, 1024, 512),
    "endgrain": (tex_endgrain, 512, 256),
    "stone": (tex_stone, 1024, 1024),
    "shingle": (tex_shingle, 1024, 512),
    "planks": (tex_planks, 512, 512),
    "paint": (tex_paint, 512, 256),
    "metal": (tex_metal, 512, 256),
})


def litter_png():
    N = 256
    rs = np.random.RandomState(481)
    rgba = np.zeros((N, N, 4), np.float32)
    # leaves
    cols = [hexc(c) for c in ("#8a5a22", "#a87a2c", "#6a3a1a", "#b8902f", "#7a4a1e", "#8e3e1e", "#5e5a28")]
    for k in range(330):
        cx, cy = rs.uniform(0, N, 2)
        a = rs.uniform(0, 6.283)
        lw, ll = rs.uniform(2.0, 3.6), rs.uniform(5, 10)
        c = cols[rs.randint(len(cols))] * rs.uniform(0.75, 1.1)
        u = np.arange(-12, 13)
        gx, gy = np.meshgrid(u, u)
        lu = gx * math.cos(a) + gy * math.sin(a)
        lv = -gx * math.sin(a) + gy * math.cos(a)
        m = (lu / ll) ** 2 + (lv / lw) ** 2 < 1
        ix = (gx[m] + int(cx)) % N
        iy = (gy[m] + int(cy)) % N
        vein = np.abs(lv[m]) < 0.6
        rgba[iy, ix, :3] = np.where(vein[:, None], c * 0.65, c)
        rgba[iy, ix, 3] = 1
    # needles
    px, py, T, idv = _strokes(N, 900, 482, 6, 15, 1.0, None, 3.14, 0.1)
    ncol = np.array([hexc("#6a4a26"), hexc("#7a5a30"), hexc("#4a3a20")])[(idv * 3).astype(int) % 3]
    ix = np.floor(px).astype(int) % N
    iy = np.floor(py).astype(int) % N
    rgba[iy.ravel(), ix.ravel(), :3] = ncol.reshape(-1, 3)
    rgba[iy.ravel(), ix.ravel(), 3] = 1
    # feather to edges so decals fade out (alpha-tested, so thin the density)
    dx, dy = (np.arange(N)[None, :] - N / 2) / (N / 2), (np.arange(N)[:, None] - N / 2) / (N / 2)
    fade = smooth(1.0, 0.7, np.sqrt(dx * dx + dy * dy))
    keep = (rs.rand(N, N) < fade)
    rgba[..., 3] *= keep
    rgba[..., :3] = rgba[..., :3] ** (1 / 1.0)
    out = np.zeros((N, N, 4), np.uint8)
    out[..., :3] = np.clip(np.round(rgba[..., :3] * 255), 0, 255)
    out[..., 3] = (rgba[..., 3] * 255).astype(np.uint8)
    return png_bytes(out, True)


# ----------------------------------------------------------------------------------------------
# detail geometry
# ----------------------------------------------------------------------------------------------
def door_leaf(wall, outer, c, w, h, hinge_side=1, tint="#7a5a3c"):
    s = {"N": -1, "S": 1, "W": -1, "E": 1}[wall]
    fx = wall in "NS"
    off = outer + s * 0.17
    a0 = c + hinge_side * (w / 2 + 0.12)
    a1 = a0 + hinge_side * (w - 0.1)
    lo, hi = min(a0, a1), max(a0, a1)

    def B(a_0, a_1, ya, yb, o0, o1, mat="planks", tn=tint):
        o_lo, o_hi = min(o0, o1), max(o0, o1)
        if fx:
            box(mat, a_0, ya, o_lo, a_1, yb, o_hi, tn, 0.9, dirt=True)
        else:
            box(mat, o_lo, ya, a_0, o_hi, yb, a_1, tn, 0.9, dirt=True)

    B(lo, hi, 0.05, h, off - 0.03, off + 0.03)
    t2 = off + s * 0.03
    for (ya, yb) in ((0.2, 0.95), (1.08, 1.85)):
        B(lo + 0.12, hi - 0.12, ya, yb, t2, t2 + s * 0.015, "planks", "#5e4128")
    hx = lo + 0.11 if hinge_side < 0 else hi - 0.11
    B(hx - 0.015, hx + 0.015, 0.95, 1.12, t2, t2 + s * 0.05, "metal", "#2a2a2a")
    for yy in (0.3, 1.7):
        hh = (hi - 0.02) if hinge_side > 0 else (lo + 0.02)
        B(hh - 0.02, hh + 0.02, yy, yy + 0.12, t2, t2 + s * 0.02, "metal", "#1c1c1c")


def bbox(wall, a0, a1, ya, yb, o0, o1, mat="paint", tn="#ffffff", tile=1.0):
    lo, hi = min(o0, o1), max(o0, o1)
    if wall in "NS":
        box(mat, a0, ya, lo, a1, yb, hi, tn, tile, dirt=True)
    else:
        box(mat, lo, ya, a0, hi, yb, a1, tn, tile, dirt=True)


def opening_trim(wall, outer, ops, stone_sill=True):
    s = {"N": -1, "S": 1, "W": -1, "E": 1}[wall]
    for o in ops:
        c, hw = o["c"], o["w"] / 2
        bbox(wall, c - hw - 0.22, c + hw + 0.22, o["y1"] + 0.1, o["y1"] + 0.27, outer, outer + s * 0.11, "log", "#c9ad88", 0.8)
        if o["kind"] == "win" and stone_sill and o["y0"] < 1.5:
            bbox(wall, c - hw - 0.14, c + hw + 0.14, o["y0"] - 0.21, o["y0"] - 0.1, outer, outer + s * 0.15, "stone", "#e6ded0", 0.6)


def corner_boards(x0, z0, x1, z1, yb, yt, tint="#d8d0be", w=0.13):
    for (x, z, sx, sz) in ((x0, z0, -1, -1), (x1, z0, 1, -1), (x0, z1, -1, 1), (x1, z1, 1, 1)):
        box("planks", x - w * 0.5 + sx * 0.02, yb, z - w * 0.5 + sz * 0.02, x + w * 0.5 + sx * 0.02, yt, z + w * 0.5 + sz * 0.02, tint, 0.5, dirt=True)


def chinking(x0, z0, x1, z1, ybase, ytop, ops, inset=0.2):
    for wall in "NSWE":
        for s0, s1, ya, yb, o in wall_pieces(wall, x0, z0, x1, z1, 0.5, ops.get(wall, []), ybase, ytop):
            if o is not None:
                continue
            if wall in "NS":
                fz = z0 + inset if wall == "N" else z1 - inset
                box("paint", s0, ya, fz - 0.07, s1, yb, fz + 0.07, "#cbbd9c", 0.8, dirt=False, skip=("+y", "-y"))
            else:
                fx_ = x0 + inset if wall == "W" else x1 - inset
                box("paint", fx_ - 0.07, ya, s0, fx_ + 0.07, yb, s1, "#cbbd9c", 0.8, dirt=False, skip=("+y", "-y"))


def build_lodge_details():
    X0, X1, Z0, Z1 = -10.0, 10.0, -6.0, 6.0
    # opening trims: lintel boards + stone sills (rebuild the op lists used by the lodge)
    GW, UW = (1.0, 2.15), (3.9, 5.2)
    ops = {
        "N": [op(-5, 1.4, 0, 2.1, "door")] + [op(c, 1.3, GW[0], GW[1]) for c in (-8.2, -1.8, 2.6, 7.4)] + [op(c, 1.2, UW[0], UW[1]) for c in (-7.5, -2.5, 2.5, 7.5)],
        "S": [op(-4, 1.4, 0, 2.1, "door"), op(4, 1.4, 0, 2.1, "door"), op(-8.2, 1.3, GW[0], GW[1]), op(0, 2.4, 0.9, 2.2), op(8.2, 1.3, GW[0], GW[1])] + [op(c, 1.2, UW[0], UW[1]) for c in (-8, -4, 0, 4, 8)],
        "E": [op(0, 1.4, 0, 2.1, "door"), op(-3.6, 1.3, GW[0], GW[1]), op(3.6, 1.3, GW[0], GW[1]), op(-2.6, 1.2, UW[0], UW[1]), op(2.6, 1.2, UW[0], UW[1])],
        "W": [op(-3.8, 1.3, GW[0], GW[1]), op(3.8, 1.3, GW[0], GW[1]), op(-3.2, 1.2, UW[0], UW[1]), op(3.2, 1.2, UW[0], UW[1])],
    }
    for wall, outer in (("N", Z0), ("S", Z1), ("W", X0), ("E", X1)):
        opening_trim(wall, outer, ops[wall])
    # foundation plinth ledge (water table)
    for (a, b, c_, d_) in ((X0 - 0.07, Z0 - 0.07, X1 + 0.07, Z0 + 0.5), (X0 - 0.07, Z1 - 0.5, X1 + 0.07, Z1 + 0.07), (X0 - 0.07, Z0 - 0.07, X0 + 0.5, Z1 + 0.07), (X1 - 0.5, Z0 - 0.07, X1 + 0.07, Z1 + 0.07)):
        box("stone", a, 0.88, b, c_, 1.02, d_, "#e0d8ca", 1.2)
    # purlin / ridge beam ends sticking out of the gables
    tp = math.tan(math.radians(28))
    for sx in (-1, 1):
        for zc in (-4.2, -2.1, 2.1, 4.2):
            yr = 9.0 - abs(zc) * tp - 0.42
            cylx("log", sx * 10.1, sx * 11.2, yr, zc, 0.1, seg=6, tint="#d2b894", caps=True, cap_mat="endgrain", cap_tile=0.2, cap_uvo=(0.5, 0.5)) if sx > 0 else cylx("log", -11.2, -10.1, yr, zc, 0.1, seg=6, tint="#d2b894", caps=True, cap_mat="endgrain", cap_tile=0.2, cap_uvo=(0.5, 0.5))
        cylx("log", min(sx * 10.1, sx * 11.35), max(sx * 10.1, sx * 11.35), 8.6, 0.0, 0.15, seg=7, tint="#d2b894", caps=True, cap_mat="endgrain", cap_tile=0.3, cap_uvo=(0.5, 0.5))
    # floor joist ends on the N/S walls
    for zz, sg in ():
        for xx in np.arange(-9.0, 9.1, 1.5):
            box("log", xx - 0.08, 2.78, zz - 0.0 if sg > 0 else zz - 0.16, xx + 0.08, 3.0, zz + 0.16 if sg > 0 else zz + 0.0, "#d2b894", 0.6, dirt=False, skip=("-y", "+y"))
    # chimney pots + drip collar
    for zc in (-0.45, 0.45):
        cyly("paint", -10.3, 10.55, 11.15, zc, 0.13, r1=0.11, seg=8, tint="#a8532f", dirt=False)
    box("stone", -10.8, 10.28, -1.0, -9.5, 10.34, 1.0, "#cfc7ba", 1.0)
    # firewood stack against the east wall
    firewood(10.45, -5.0, 0.0, 1.8, 3, 6)
    firewood(10.45, 5.0, 0.0, 1.8, 3, 5)
    # extra door hardware: porch door numbers skipped; lanterns beside the doors
    for (lx, lz) in ((-3.2, 6.14), (3.2, 6.14)):
        lantern_post(lx, lz, hang=True, y=2.15)


def build_corner_details():
    # shed
    y0 = float(gh(46, -28))
    corner_boards(44.0, -29.5, 48.0, -26.5, y0 + 0.1, y0 + 2.4)
    # boathouse
    corner_boards(12.0, -56.0, 24.0, -46.0, 0.0, 3.2)
    for (a, b, c_, d_) in ((12.0, -56.0, 24.0, -56.0),):
        pass
    # cabin: stone quoins at the corners
    yc = float(gh(-38, 25))
    for (x, z, sx, sz) in ((-41.0, 22.5, -1, -1), (-35.0, 22.5, 1, -1), (-41.0, 27.5, -1, 1), (-35.0, 27.5, 1, 1)):
        for k in range(3):
            box("stone", x - 0.28 + sx * 0.04, yc + k * 0.2 - 0.2, z - 0.28 + sz * 0.04, x + 0.28 + sx * 0.04, yc + k * 0.2 - 0.02, z + 0.28 + sz * 0.04, "#e6ded0", 0.5)
    # woodshed + tool-shed roof trim handled by roofs; boathouse fascia lantern
    # door trims for the boathouse and shed doors (casing already present)


# ----------------------------------------------------------------------------------------------
# ground detail objects
# ----------------------------------------------------------------------------------------------
def blocked_xy(x, z, paths=True, pad=0.0):
    for k in KEEP:
        if k[0] == "r":
            if k[1] - pad <= x <= k[3] + pad and k[2] - pad <= z <= k[4] + pad:
                return True
        elif math.hypot(x - k[1], z - k[2]) <= k[3] + pad:
            return True
    if paths:
        for (w, pts) in PATHS:
            for (ax, az), (bx, bz) in zip(pts[:-1], pts[1:]):
                dx, dz = bx - ax, bz - az
                t = max(0.0, min(1.0, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz + 1e-9)))
                if math.hypot(x - (ax + t * dx), z - (az + t * dz)) < w / 2 + 0.6:
                    return True
    return False


def ground_details(trees):
    rs = np.random.RandomState(555)
    nped = 0
    # pebbles and small rocks along the paths
    for (w, pts) in PATHS:
        for (ax, az), (bx, bz) in zip(pts[:-1], pts[1:]):
            L = math.hypot(bx - ax, bz - az)
            n = int(L / 8.0)
            for k in range(n):
                t = rs.uniform(0, 1)
                nx_, nz_ = -(bz - az) / L, (bx - ax) / L
                side = rs.choice([-1, 1])
                off = side * (w / 2 + rs.uniform(0.15, 1.1))
                x, z = ax + (bx - ax) * t + nx_ * off, az + (bz - az) * t + nz_ * off
                if float(gh(x, z)) < -0.3 or blocked_xy(x, z, False, 0.2):
                    continue
                for j in range(rs.randint(1, 3)):
                    r = rs.uniform(0.06, 0.2)
                    xx, zz = x + rs.uniform(-0.4, 0.4), z + rs.uniform(-0.4, 0.4)
                    rock("rock", xx, float(gh(xx, zz)) + r * 0.25, zz, r, r * 0.6, r * 0.85, int(rs.randint(1000)), 3, 6, "#b3ac9f", 0.3, rs.uniform(0, 6), 1.0)
                    nped += 1
    # fallen logs + stumps at the forest edge
    cand = [t for t in trees if (abs(t[0]) > 44 or abs(t[2]) > 54)]
    rs.shuffle(cand)
    nlog = nstump = 0
    for t in cand:
        if nlog >= 9 and nstump >= 12:
            break
        a = rs.uniform(0, 6.283)
        d = rs.uniform(2.5, 4.5)
        x, z = t[0] + d * math.cos(a), t[2] + d * math.sin(a)
        if abs(x) > 54 or abs(z) > 64 or blocked_xy(x, z, True, 1.0) or float(gh(x, z)) < -0.2:
            continue
        if nlog < 9 and rs.rand() < 0.5:
            L, r = rs.uniform(3.0, 6.0), rs.uniform(0.18, 0.34)
            rot = rs.uniform(0, 6.283)
            ex, ez = math.cos(rot) * L / 2, -math.sin(rot) * L / 2
            ya, yb = float(gh(x - ex, z - ez)), float(gh(x + ex, z + ez))
            yc = (ya + yb) / 2 + r * 0.85
            push(roty(rot), (x, yc, z))
            cylx("log", -L / 2, L / 2, 0, 0, r, seg=8, tint="#a9a38d", caps=True, cap_mat="endgrain", cap_tile=2 * r, cap_uvo=(0.5, 0.5), r1=r * 0.85)
            for k in range(2):  # broken branch stubs
                bx = rs.uniform(-L / 3, L / 3)
                beam((bx, 0.0, 0.0), (bx + 0.1, r * 1.6, r * 0.7 * (1 if k else -1)), 0.035, "log", "#8c7e66", 0.035)
            pop()
            col_rot(x, z, L / 2, r, rot, min(ya, yb), yc + r, F_DEFAULT, S_WOOD) if r > 0.28 else None
            nlog += 1
        elif nstump < 12:
            y = float(gh(x, z))
            r = rs.uniform(0.22, 0.38)
            h = rs.uniform(0.45, 0.95)
            cyly("log", x, y - 0.1, y + h, z, r, r1=r * 0.82, seg=8, tint="#a9a38d", caps="top", cap_mat="endgrain", cap_tile=2 * r * 0.82, cap_uvo=(0.5, 0.5))
            cyly("log", x, y - 0.15, y + 0.28, z, r * 1.5, r1=r, seg=8, tint="#8c8068", caps=False)
            col(x - r, y, z - r, x + r, y + h, z + r, F_DEFAULT, S_WOOD)
            nstump += 1
    # leaf litter decals around trees (alpha-tested, merged into one primitive)
    ndec = 0
    for t in trees:
        if ndec >= 70:
            break
        if rs.rand() > 0.35:
            continue
        for _ in range(2):
            a = rs.uniform(0, 6.283)
            d = rs.uniform(0.5, 2.6)
            x, z = t[0] + d * math.cos(a), t[2] + d * math.sin(a)
            if blocked_xy(x, z, True, 0.3) or float(gh(x, z)) < -0.3:
                continue
            S_ = rs.uniform(2.0, 3.4)
            rot = rs.uniform(0, 6.283)
            gx, gz = np.meshgrid(np.linspace(-S_ / 2, S_ / 2, 3), np.linspace(-S_ / 2, S_ / 2, 3))
            c, s = math.cos(rot), math.sin(rot)
            wx, wz = x + gx * c - gz * s, z + gx * s + gz * c
            wy = np.array([[float(gh(a_, b_)) + 0.03 for a_, b_ in zip(r1, r2)] for r1, r2 in zip(wx, wz)])
            P = np.stack([wx.ravel(), wy.ravel(), wz.ravel()], 1)
            I = []
            for j in range(2):
                for i in range(2):
                    k = j * 3 + i
                    I.append((k, k + 3, k + 4))
                    I.append((k, k + 4, k + 1))
            uv = np.stack([(gx.ravel() / S_ + 0.5), (gz.ravel() / S_ + 0.5)], 1)
            tintc = [("#d9a85a", 1), ("#c98a46", 1), ("#b9854a", 1), ("#cfb070", 1), ("#9a7a44", 1)][rs.randint(5)][0]
            tl = hexl(tintc)
            emit("litter", P, np.tile([0, 1.0, 0], (9, 1)), uv, np.array(I), colors=np.tile(tl, (9, 1)) * np.array([[1.0]]))
            ndec += 1
    log("  ground detail: pebbles", nped, "logs", nlog, "stumps", nstump, "decals", ndec)

# ----------------------------------------------------------------------------------------------
# textures -> JPEG
# ----------------------------------------------------------------------------------------------
def down(a, N):
    f = a.shape[0] // N
    if f <= 1:
        return a
    return a.reshape(N, f, N, f, *a.shape[2:]).mean((1, 3))


def make_pbr(name, gen, Na, Nn):
    NOTEX = os.environ.get("LODGE_NOTEX")
    if NOTEX:
        Na = Nn = 32
    t = gen(max(Na, Nn))
    alb = down(np.clip(np.broadcast_to(t["alb"], t["h"].shape + (3,)), 0, 1), Na)
    nrm = normal_from_height(t["h"], t.get("nstr", 2.0))
    nrm = down(nrm, Nn)
    nrm = nrm / np.maximum(np.linalg.norm(nrm * 2 - 1, axis=-1, keepdims=True), 1e-6) * 0 + nrm
    ao = down(np.broadcast_to(np.clip(t["ao"], 0, 1), t["h"].shape).astype(np.float64), Nn)
    rough = down(np.broadcast_to(t["rough"], t["h"].shape).astype(np.float64), Nn)
    metal = down(np.broadcast_to(t["metal"], t["h"].shape).astype(np.float64), Nn)
    orm = np.stack([0.55 + 0.45 * ao, rough, metal], -1)
    orm = down(orm, max(256, orm.shape[0] // 2)) if orm.shape[0] > 256 else orm
    return (jpeg_bytes(alb, QA, name + "_a"), jpeg_bytes(nrm, QN, name + "_n"), jpeg_bytes(orm, 70, name + "_o"))


# ----------------------------------------------------------------------------------------------
# glTF assembly
# ----------------------------------------------------------------------------------------------
QA, QN = 64, 52
LITTER_PNG = b""
NOSHADOW = {"litter", "terrain", "ground", "glass", "glass_dark", "mountain", "glow"}
NOCOLOR = {"terrain", "glow"}


def chunks_of(acc, vmax=64000):
    P = np.concatenate(acc.P)
    N = np.concatenate(acc.N)
    UV = np.concatenate(acc.UV)
    C = np.concatenate(acc.C)
    I = np.concatenate(acc.I)
    if len(P) <= vmax:
        return [(P, N, UV, C, I)]
    out = []
    step = 30000
    k = 0
    while k < len(I):
        sub = I[k:k + step]
        u, inv = np.unique(sub.ravel(), return_inverse=True)
        while len(u) > vmax:
            step //= 2
            sub = I[k:k + step]
            u, inv = np.unique(sub.ravel(), return_inverse=True)
        out.append((P[u], N[u], UV[u], C[u], inv.reshape(-1, 3)))
        k += step
    return out


def add_vertex_attr(g, arr, ctype, atype, normalized=False, stride=None, minmax=False):
    a = np.ascontiguousarray(arr)
    vi = g._view(a.tobytes(), 34962)
    if stride:
        g.views[vi]["byteStride"] = stride
    d = {"bufferView": vi, "componentType": ctype, "count": int(a.shape[0]), "type": atype}
    if normalized:
        d["normalized"] = True
    if minmax:
        d["min"] = [float(x) for x in a.min(0)]
        d["max"] = [float(x) for x in a.max(0)]
    g.acc.append(d)
    return len(g.acc) - 1


def build_glb(tex):
    g = GLB()
    mats = {}
    order = [m for m in G.keys()]
    stats = dict(tris=0, verts=0, prims=0, mats=0)
    for name in order:
        acc = G[name]
        if not acc.P:
            continue
        mj = {"name": name}
        pbr = {}
        if name in tex:
            a, n, o = tex[name]
            ia, io = g.image(a), g.image(o)
            pbr = {"baseColorTexture": {"index": ia}, "metallicRoughnessTexture": {"index": io}, "metallicFactor": 1.0, "roughnessFactor": 1.0}
            if n is not None:
                mj["normalTexture"] = {"index": g.image(n), "scale": 1.0}
            mj["occlusionTexture"] = {"index": io, "strength": 1.0}
        elif name == "glass":
            pbr = {"baseColorFactor": [0.72, 0.84, 0.9, 0.2], "metallicFactor": 0.0, "roughnessFactor": 0.04}
            mj["alphaMode"] = "BLEND"
            mj["doubleSided"] = True
        elif name == "litter":
            ii = g.image(LITTER_PNG, "image/png")
            pbr = {"baseColorTexture": {"index": ii}, "metallicFactor": 0.0, "roughnessFactor": 1.0}
            mj["alphaMode"] = "MASK"
            mj["alphaCutoff"] = 0.5
            mj["doubleSided"] = True
        elif name == "glass_dark":
            pbr = {"baseColorFactor": [0.03, 0.05, 0.06, 0.72], "metallicFactor": 0.0, "roughnessFactor": 0.06}
            mj["alphaMode"] = "BLEND"
            mj["doubleSided"] = True
        elif name == "glow":
            pbr = {"baseColorFactor": [0.08, 0.06, 0.04, 1.0], "metallicFactor": 0.0, "roughnessFactor": 0.6}
            mj["emissiveFactor"] = [1.0, 0.62, 0.26]
        elif name == "carpaint":
            pbr = {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0.28, "roughnessFactor": 0.24}
        elif name == "carchrome":
            pbr = {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0.90, "roughnessFactor": 0.22}
        elif name == "cartrim":
            pbr = {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0.06, "roughnessFactor": 0.78}
        else:  # mountain (vertex colours only)
            pbr = {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0.0, "roughnessFactor": 1.0}
        mj["pbrMetallicRoughness"] = pbr
        g.materials.append(mj)
        mi = len(g.materials) - 1
        prims = []
        for (P, N, UV, C, I) in chunks_of(acc):
            attrs = {"POSITION": add_vertex_attr(g, P.astype(np.float32), 5126, "VEC3", minmax=True)}
            nb = np.zeros((len(N), 4), np.int8)
            nb[:, :3] = np.clip(np.round(N * 127), -127, 127)
            attrs["NORMAL"] = add_vertex_attr(g, nb, 5120, "VEC3", True, stride=4)
            attrs["TEXCOORD_0"] = add_vertex_attr(g, UV.astype(np.float32), 5126, "VEC2")
            if name not in NOCOLOR:
                cb = np.full((len(C), 4), 255, np.uint8)
                cb[:, :3] = np.clip(np.round(C * 255), 0, 255)
                attrs["COLOR_0"] = add_vertex_attr(g, cb, 5121, "VEC4", True)
            Ii = I.astype(np.uint16 if len(P) < 65535 else np.uint32).ravel()
            ia_ = g.accessor(Ii, 5123 if len(P) < 65535 else 5125, "SCALAR", 34963)
            prims.append({"attributes": attrs, "indices": ia_, "material": mi, "mode": 4})
            stats["tris"] += len(I)
            stats["verts"] += len(P)
            stats["prims"] += 1
        extras = {"castShadow": name not in NOSHADOW}
        if name in ("glass", "glass_dark"):
            extras["glass"] = True
        g.meshes.append({"name": name, "primitives": prims, "extras": extras})
        g.nodes.append({"mesh": len(g.meshes) - 1, "name": name, "extras": extras})
        stats["mats"] += 1
    return g, stats


# ----------------------------------------------------------------------------------------------
# Blender preview renders
# ----------------------------------------------------------------------------------------------
def setup_preview_scene(glb_path, trees, bushes, sun_dir):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=glb_path)
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    try:
        sc.cycles.device = "CPU"
        sc.cycles.samples = 8
    except Exception:
        pass
    try:
        sc.eevee.taa_render_samples = 24
    except Exception:
        pass
    sc.view_settings.view_transform = "Standard" if "Standard" in [v.identifier for v in sc.view_settings.bl_rna.properties["view_transform"].enum_items] else sc.view_settings.view_transform
    try:
        sc.view_settings.look = "None"
    except Exception:
        pass
    # world: sky
    w = bpy.data.worlds.new("W")
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    made = False
    try:
        sky = nt.nodes.new("ShaderNodeTexSky")
        for st in ("MULTIPLE_SCATTERING", "SINGLE_SCATTERING", "NISHITA", "HOSEK_WILKIE", "PREETHAM"):
            try:
                sky.sky_type = st
                break
            except Exception:
                continue
        try:
            d = np.array(sun_dir)
            sky.sun_direction = (d[0], -d[2], d[1])
        except Exception:
            pass
        nt.links.new(sky.outputs[0], bg.inputs[0])
        made = True
    except Exception:
        pass
    if not made:
        bg.inputs[0].default_value = (0.45, 0.65, 1.0, 1)
    bg.inputs[1].default_value = 1.0
    nt.links.new(bg.outputs[0], out.inputs[0])
    d = np.array(sun_dir)
    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = 2.8
    so = bpy.data.objects.new("sun", sun)
    sc.collection.objects.link(so)
    tgt = np.array([d[0], -d[2], d[1]])
    from mathutils import Vector
    so.rotation_euler = Vector(-tgt).to_track_quat("-Z", "Y").to_euler()
    # water plane
    me = bpy.data.meshes.new("water")
    me.from_pydata([(-400, -400, WATER_Y), (400, -400, WATER_Y), (400, -49, WATER_Y), (-400, -49, WATER_Y)], [], [(0, 1, 2, 3)])
    wo = bpy.data.objects.new("water", me)
    sc.collection.objects.link(wo)
    wm = bpy.data.materials.new("water")
    wm.use_nodes = True
    bs = wm.node_tree.nodes["Principled BSDF"]
    bs.inputs["Base Color"].default_value = (0.05, 0.2, 0.28, 1)
    bs.inputs["Roughness"].default_value = 0.05
    wo.data.materials.append(wm)
    # placeholder trees (preview only)
    for items, kind_sz in ((trees, True), (bushes, False)):
        verts, faces = [], []
        for (x, y, z, s, ry, kind) in items:
            if kind_sz:
                hh, rr = (12.0 if kind == "pine" else 10.0 if kind == "spruce" else 8.0) * s, (2.6 if kind != "birch" else 1.8) * s
                base = len(verts)
                for k in range(7):
                    a = k * 2 * math.pi / 7
                    verts.append((x + rr * math.cos(a), -z - rr * math.sin(a), y + hh * 0.18))
                verts.append((x, -z, y + hh))
                verts.append((x, -z, y))
                for k in range(7):
                    faces.append((base + k, base + (k + 1) % 7, base + 7))
                verts.append((x + 0.15, -z, y)); verts.append((x - 0.15, -z, y)); verts.append((x, -z + 0.15, y + hh * 0.2))
                faces.append((base + 9, base + 10, base + 11))
            else:
                base = len(verts)
                rr = (0.8 if kind != "fern" else 0.6) * s
                for k in range(6):
                    a = k * 2 * math.pi / 6
                    verts.append((x + rr * math.cos(a), -z - rr * math.sin(a), y + 0.1))
                verts.append((x, -z, y + (0.8 if kind != "fern" else 0.55) * s))
                for k in range(6):
                    faces.append((base + k, base + (k + 1) % 6, base + 6))
        me2 = bpy.data.meshes.new("fol")
        me2.from_pydata(verts, [], faces)
        ob = bpy.data.objects.new("fol", me2)
        sc.collection.objects.link(ob)
        m2 = bpy.data.materials.new("fol")
        m2.use_nodes = True
        m2.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.05, 0.16, 0.06, 1) if kind_sz else (0.1, 0.25, 0.06, 1)
        m2.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9
        ob.data.materials.append(m2)
    return sc


def render_view(sc, out, loc, target, res=(600, 337), lens=22.0, ortho=None, sun=None):
    from mathutils import Vector
    cam = bpy.data.cameras.new("c")
    co = bpy.data.objects.new("c", cam)
    sc.collection.objects.link(co)
    sc.camera = co
    if ortho:
        cam.type = "ORTHO"
        cam.ortho_scale = ortho
        cam.clip_end = 1000
        co.location = (loc[0], -loc[2], loc[1])
        co.rotation_euler = (0, 0, 0)
    else:
        cam.lens = lens
        cam.clip_start = 0.05
        cam.clip_end = 2000
        co.location = (loc[0], -loc[2], loc[1])
        d = Vector((target[0] - loc[0], -(target[2] - loc[2]), target[1] - loc[1]))
        co.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.filepath = out
    sc.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(co)


def load_png(path):
    im = bpy.data.images.load(path)
    w, h = im.size
    px = np.array(im.pixels[:], dtype=np.float32).reshape(h, w, 4)[::-1, :, :3]
    bpy.data.images.remove(im)
    return px


def render_all(glb_path, trees, bushes, sun_dir, quick=False):
    sc = setup_preview_scene(glb_path, trees, bushes, sun_dir)
    # interior lights
    lights = [(0, 2.6, 0, 600), (-6, 2.6, 0, 400), (6, 2.6, -2, 400), (0, 5.2, -3.5, 300), (8, 4.6, 0, 150)]
    for i, (x, y, z, e) in enumerate(lights):
        L = bpy.data.lights.new("p%d" % i, "POINT")
        L.energy = e
        L.shadow_soft_size = 0.5
        L.color = (1.0, 0.82, 0.6)
        o = bpy.data.objects.new("p%d" % i, L)
        o.location = (x, -z, y)
        sc.collection.objects.link(o)
    outs = {}
    W, Hh = 600, 337
    # minimap (ortho top-down, 140 m square, north up)
    render_view(sc, os.path.join(TMP, "minimap.png"), (0, 200, 0), (0, 0, 0), (384, 384), ortho=140.0)
    outs["minimap"] = os.path.join(TMP, "minimap.png")
    if quick:
        return outs, None
    render_view(sc, os.path.join(TMP, "top.png"), (0, 300, 0), (0, 0, 0), (720, 720), ortho=290.0)
    views = [
        ("v1", (0, 1.7, 57), (0, 2.8, 0), 24),
        ("v2", (7, 1.7, 17), (-3, 2.4, 6), 24),
        ("v3", (-24, 1.7, 7), (-41, 1.0, 0), 24),
        ("v4", (23, 1.7, -3), (38, 1.5, -10), 24),
        ("v5", (0, 1.7, -37), (6, 1.0, -52), 22),
        ("v6", (9, 1.7, 4.5), (-8, 1.7, -1.5), 18),
        ("v7", (8.6, 4.7, -4.5), (-4, 4.3, 0.5), 18),
        ("v8", (26, 6.5, -22), (0, 3.0, 0), 28),
        ("v9", (-3.0, 1.5, 46.5), (-8.5, 0.9, 52.5), 30),
        ("v10", (41.0, 1.5, 21.0), (46.0, 0.9, 26.0), 30),
    ]
    for nm, loc, tg, lens in views:
        render_view(sc, os.path.join(TMP, nm + ".png"), loc, tg, (W, Hh), lens)
        outs[nm] = os.path.join(TMP, nm + ".png")
    outs["top"] = os.path.join(TMP, "top.png")
    # compose sheet
    sheet = np.full((1685, 1920, 3), 0.1, np.float32)
    top = load_png(outs["top"])
    sheet[0:720, 0:720] = top
    mm = load_png(outs["minimap"])
    mmr = mm[::512 // 360 if False else 1][:360, :360] if False else mm.reshape(360, 512 // 360 if False else 1, 512, 3).mean(1)[:, :360] if False else None
    ys = (np.arange(360) * mm.shape[0] / 360).astype(int)
    mm2 = mm[ys][:, ys]
    sheet[720:1080, 0:360] = mm2
    for i, (nm, _, _, _) in enumerate(views):
        im = load_png(outs[nm])
        r, c = i // 2, i % 2
        sheet[r * Hh:(r + 1) * Hh, 720 + c * W:720 + (c + 1) * W] = im
    # gamma: images from Blender image load are already display-referred (Standard) -> store as is
    path = os.path.join(ROOT, "docs", "sheet_lodge.png")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "wb").write(png_bytes(np.clip(sheet, 0, 1)))
    return outs, path


# ----------------------------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------------------------
def b64(b):
    return base64.b64encode(b).decode("ascii")


def main():
    global HG
    quick = bool(os.environ.get("LODGE_QUICK")) or ("--quick" in sys.argv)
    HG = HeightGrid(-160.0, -160.0, 320.0, 321)
    reserve_c(-18.5, 20.0, 6.5)
    reserve_c(-24.0, 28.5, 8.5)
    reserve_c(-16.5, 36.5, 8.5)
    log("height grid", HG.data.shape, float(HG.data.min()), float(HG.data.max()))
    # --- scenery
    build_lodge()
    build_lodge_extra()
    build_lodge_details()
    log("lodge built; colliders", len(COL))
    build_cabin()
    build_greenhouse()
    build_boathouse()
    build_dock()
    build_bridge()
    build_shed()
    build_woodshed()
    build_garden()
    build_parking_props()
    build_east_props()
    build_north_props()
    build_west_props()
    build_corner_details()
    log("props built; colliders", len(COL))
    # boulders on the slopes and shores
    rs = np.random.RandomState(99)
    for i in range(34):
        side = rs.randint(4)
        t = rs.uniform(-1, 1)
        if side == 0:
            x, z = t * 52, -58 + rs.uniform(-2, 0)
            if z > -55:
                continue
            continue
        elif side == 1:
            x, z = t * 52, 60 + rs.uniform(0, 4)
        elif side == 2:
            x, z = -52 - rs.uniform(0, 8), t * 62
        else:
            x, z = 52 + rs.uniform(0, 8), t * 62
        if float(gh(x, z)) < -0.3:
            continue
        r = rs.uniform(0.7, 2.3)
        boulder(x, z, r, 300 + i, rot=rs.uniform(0, 6), collide=(abs(x) < 56 and abs(z) < 66 and r > 0.8))
    # shore stones
    for i in range(8):
        x = rs.uniform(-50, 50)
        z = rs.uniform(-48, -43)
        if abs(x + 20) < 3 or 13 < x < 23:
            continue
        boulder(x, z, rs.uniform(0.25, 0.7), 400 + i, collide=False, sink=0.35)
    # --- terrain
    ix0, ix1, iz0, iz1 = TERR_INNER
    terrain_region(ix0, ix1, iz0, iz1, 1.0, None, True, True)
    terrain_region(-88, 88, -88, 88, 2.0, (ix0, ix1, iz0, iz1), True)
    terrain_skirt(ix0, ix1, iz0, iz1, 1.0)
    terrain_skirt(ix0, ix1, iz0, iz1, 2.0)
    terrain_region(-160, 160, -160, 160, 8.0, (-88, 88, -88, 88), False)
    terrain_skirt(-88, 88, -88, 88, 2.0)
    terrain_skirt(-88, 88, -88, 88, 8.0, mat="ground")
    G["terrain"].nocolor = True
    log("terrain meshes")
    build_backdrop()
    log("backdrop")
    # --- textures
    tex = {}
    for nm, (gen, na, nn) in MATS.items():
        tex[nm] = make_pbr(nm, gen, na, nn)
        log("  tex", nm, sum(len(x) for x in tex[nm]) // 1024, "KB")
    alb, nrm, orm, aux = bake_terrain()
    ta = jpeg_bytes(down(alb, 512), 76, "terrain_a")
    tn = b""
    to = jpeg_bytes(down(orm, 512), 84, "terrain_o")
    tex["terrain"] = (ta, None, to)
    log("terrain bake KB", len(ta) // 1024, len(tn) // 1024, len(to) // 1024)
    # --- foliage + grass
    trees, bushes = place_foliage()
    log("trees", len(trees), "bushes", len(bushes))
    ground_details(trees)
    global LITTER_PNG
    LITTER_PNG = litter_png()
    gn = 321
    gx = (-80.0 + np.arange(gn) * 0.5)
    ii = np.clip(((gx - SPL_X0) / SPL_SIZE * SPL_N).astype(int), 0, SPL_N - 1)
    wgm = aux["wg"][np.ix_(ii, ii)]
    ins = aux["inside"][np.ix_(ii, ii)]
    HH = aux["H"][np.ix_(ii, ii)]
    nzz = fbm(gx[None, :] * 0.2, gx[:, None] * 0.2, 3, 777)
    dens = wgm ** 1.2 * (0.55 + 0.45 * nzz) * (1 - ins) * (1 - smooth(-0.2, -0.6, -HH) * 0) * (HH > -0.35)
    dout = np.hypot(np.maximum(np.abs(gx[None, :]) - 56, 0), np.maximum(np.abs(gx[:, None]) - 66, 0))
    dens = dens * (1 - 0.35 * smooth(0, 12, dout))
    grass = np.clip(np.round(dens * 255), 0, 255).astype(np.uint8)
    # --- boundary + shoreline invisible colliders
    for (a, b, c_, d_, e, f) in ((-58, -10, -68, -55, 40, 68), (55, -10, -68, 58, 40, 68), (-58, -10, -68, 58, 40, -65), (-58, -10, 65, 58, 40, 68)):
        col(a, b, c_, c_ if False else d_, e, f, F_DEFAULT, S_GROUND) if False else None
    col(-58, -10, -68, -55, 40, 68, F_DEFAULT, S_GROUND)
    col(55, -10, -68, 58, 40, 68, F_DEFAULT, S_GROUND)
    col(-58, -10, -68, 58, 40, -65, F_DEFAULT, S_GROUND)
    col(-58, -10, 65, 58, 40, 68, F_DEFAULT, S_GROUND)
    for (xa, xb) in ((-55, -22.3), (-17.7, 11.3), (24.7, 55)):
        col(xa, -8, -50.4, xb, 3.0, -49.4, F_SOLID, S_GROUND)
    # --- data
    spawns = [
        [[-11.0, 57.0, 0.0], [-6.0, 58.5, 0.0], [-1.0, 56.0, 0.0], [4.0, 58.5, 0.0], [9.0, 56.0, 0.0], [14.0, 58.0, 0.0]],
        [[-12.0, -40.0, math.pi], [-7.0, -42.0, math.pi], [-2.0, -40.0, math.pi], [3.0, -42.0, math.pi], [8.0, -40.0, math.pi], [13.0, -42.0, math.pi]],
    ]
    hotspots = [[0, 0], [-5, -9], [0, 11], [13, 1], [-40, 0], [-38, 21], [38, -10], [40, 11], [46, -26], [5, 47], [18, -48], [-20, -50], [32, 20], [-24, -26], [22, -30], [0, 28]]
    zones = [
        dict(name="LODGE", x0=-11.5, z0=-8.5, x1=11.5, z1=11.0),
        dict(name="DOCK", x0=-23.0, z0=-63.0, x1=-15.0, z1=-42.0),
        dict(name="BOATHOUSE", x0=11.0, z0=-60.0, x1=25.0, z1=-45.0),
        dict(name="CABIN", x0=-43.0, z0=19.0, x1=-33.0, z1=29.0),
        dict(name="GREENHOUSE", x0=31.5, z0=-14.5, x1=44.5, z1=-5.5),
        dict(name="GARDEN", x0=29.0, z0=2.0, x1=49.5, z1=20.5),
        dict(name="TOOL SHED", x0=42.0, z0=-31.0, x1=50.0, z1=-25.0),
        dict(name="CREEK", x0=-55.0, z0=-48.0, x1=-31.0, z1=50.0),
        dict(name="WOODSHED", x0=32.0, z0=47.0, x1=40.0, z1=53.0),
        dict(name="PARKING", x0=-24.0, z0=38.0, x1=30.0, z1=65.0),
        dict(name="NORTH SHORE", x0=-55.0, z0=-65.0, x1=55.0, z1=-38.0),
        dict(name="EAST LANE", x0=24.0, z0=-65.0, x1=55.0, z1=65.0),
        dict(name="WEST LANE", x0=-55.0, z0=-65.0, x1=-24.0, z1=65.0),
        dict(name="LODGE YARD", x0=-24.0, z0=-65.0, x1=24.0, z1=65.0),
    ]
    sd = np.array([-0.5, 0.72, 0.48])
    sd = (sd / np.linalg.norm(sd)).tolist()
    data = dict(
        name="CEDAR LODGE", half=HALF, bounds=BOUNDS,
        height=dict(n=321, x0=-160.0, z0=-160.0, size=320.0, data=b64(HG.data.astype("<f4").tobytes())),
        colliders=COL, spawns=spawns, hotspots=hotspots, zones=zones,
        water=dict(y=WATER_Y, x0=-160.0, z0=-160.0, x1=160.0, z1=-48.0),
        foliage=dict(trees=trees, bushes=bushes, grass=dict(n=gn, x0=-80.0, z0=-80.0, size=160.0, data=b64(grass.tobytes()))),
        sun=dict(dir=[round(v, 4) for v in sd]),
    )
    data["terrainLayers"] = build_terrain_layers(aux, bool(os.environ.get("LODGE_NOTEX")))
    # --- glb
    for k_,a_ in G.items():
        log("  mat", k_, "verts", a_.n, "tris", sum(len(i) for i in a_.I))
    g, st = build_glb(tex)
    glb = g.finish()
    glb_path = os.path.join(TMP, "lodge.glb")
    open(glb_path, "wb").write(glb)
    log("glb bytes", len(glb), st)
    # --- renders + minimap
    outs, sheet = render_all(glb_path, trees, bushes, sd, quick)
    mmi = load_png(outs["minimap"])
    mmi = np.round(mmi * 7) / 7
    mm = png_bytes(mmi)
    data["minimap"] = dict(png=b64(mm), x0=-70.0, z0=-70.0, size=140.0)
    js = "// Generated by tools/blender/build_lodge.py - do not edit.\nexport const LODGE_GLB = '%s';\nexport const LODGE_DATA = %s;\n" % (b64(glb), json.dumps(data, separators=(",", ":")))
    out = os.path.join(ROOT, "src", "maps", "lodge_asset.js")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, "w").write(js)
    print("RESULT tris=%d verts=%d prims=%d materials=%d glb=%.2fMB js=%.2fMB colliders=%d trees=%d bushes=%d" % (st["tris"], st["verts"], st["prims"], st["mats"], len(glb) / 1e6, len(js) / 1e6, len(COL), len(trees), len(bushes)), flush=True)


if __name__ == "__main__":
    main()
