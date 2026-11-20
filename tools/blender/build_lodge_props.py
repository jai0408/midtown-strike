"""Builds the Cedar Lodge hero props: two school buses, the koi pond set and the (slimmed) koi / phoenix.

NOTE: the generated asset module is post-processed by tools/recompress_assets.py (textures re-encoded as WebP,
GLB images via EXT_texture_webp). Run it after this script; do not hand-edit the output.

    /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/build_lodge_props.py

Outputs
  src/world/lodge_props_asset.js   LODGE_PROPS_GLB (base64 glb) + LODGE_PROPS_DATA   (buses + pond)
  src/world/creatures_asset.js     KOI_GLB + PHOENIX_GLB (CC-BY: koi_fish 1.glb by 7PLUS, phoenix_bird.glb by NORBERTO-3D)
  docs/sheet_lodge_props.png       contact sheet (Cycles)

Design
  * Geometry is authored with bmesh / modifiers, then flattened to numpy (positions, split normals, uvs).
  * Textures are painted procedurally: every mesh face is assigned a planar chart, charts are packed into an atlas and
    rasterised so each texel knows its bus-space position/normal; paint + weathering is then a function of position
    (so chart seams are invisible). Maps: albedo, tangent normal (from painted height), ORM (R ao, G rough, B metal).
  * glb is written by hand (write_glb) so vertex layout/extras are exactly what src/world/*.js expects.
  * Both buses share one mesh topology (UVs identical); the old bus differs by sag / flat tyres / its own paint.

Env: STAGE=bus,pond,creatures,sheet (default all)   SAMPLES=32   NO_SHEET=1
Coordinates while authoring a bus: +X right, +Y forward (front = +Y), +Z up, origin on the ground at the middle.
glTF export maps (x, y, z) -> (x, z, -y), i.e. the bus faces -Z in game space like the old one.
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

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
GAME = os.path.dirname(ROOT)
OUT_PROPS = os.path.join(ROOT, "src", "world", "lodge_props_asset.js")
OUT_CREAT = os.path.join(ROOT, "src", "world", "creatures_asset.js")
SHEET = os.path.join(ROOT, "docs", "sheet_lodge_props.png")
GLB_DIR = os.path.join(HERE, "glb")
TMP = os.environ.get("TMPDIR_PROPS", os.path.join(HERE, "preview"))
STAGES = [s for s in os.environ.get("STAGE", "bus,pond,creatures,sheet").split(",") if s]
SAMPLES = int(os.environ.get("SAMPLES", "32"))
ATLAS = int(os.environ.get("ATLAS", "1024"))
os.makedirs(GLB_DIR, exist_ok=True)
os.makedirs(TMP, exist_ok=True)
T0 = time.time()


def log(*a):
    print("[props %5.1fs]" % (time.time() - T0), *a, flush=True)


# ---------------------------------------------------------------------------------------------
# colour / noise
# ---------------------------------------------------------------------------------------------
def s2l(c):
    c = np.asarray(c, np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4).astype(np.float32)


def l2s(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055).astype(np.float32)


def hexc(h):
    h = h.lstrip("#")
    return s2l([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])


def _hash(ix, iy, iz, seed):
    h = (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791) ^ (seed * 374761393 + 12345)
    h = (h ^ (h >> 13)) & 0xFFFFFFFF
    h = (h * 1274126177) & 0xFFFFFFFF
    h = h ^ (h >> 16)
    return (h & 0xFFFF).astype(np.float32) / 65535.0


def noise3(P, f, seed=0):
    """Value noise, P (n,3) float, f scalar or (3,) frequency. Returns (n,) in 0..1."""
    p = P * np.asarray(f, np.float32)
    i = np.floor(p)
    fr = (p - i).astype(np.float32)
    u = fr * fr * (3 - 2 * fr)
    i = i.astype(np.int64)
    x0, y0, z0 = i[:, 0], i[:, 1], i[:, 2]
    out = 0
    for dx in (0, 1):
        wx = u[:, 0] if dx else 1 - u[:, 0]
        for dy in (0, 1):
            wy = u[:, 1] if dy else 1 - u[:, 1]
            for dz in (0, 1):
                wz = u[:, 2] if dz else 1 - u[:, 2]
                out = out + _hash(x0 + dx, y0 + dy, z0 + dz, seed) * (wx * wy * wz)
    return out.astype(np.float32)


def fbm3(P, f, octv=3, seed=0):
    a, tot, out = 1.0, 0.0, 0
    for o in range(octv):
        out = out + a * noise3(P, np.asarray(f, np.float32) * (2 ** o), seed + o * 17)
        tot += a
        a *= 0.5
    return out / tot


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0 + 1e-9), 0, 1)
    return t * t * (3 - 2 * t)


def mix(a, b, t):
    return a + (b - a) * t[..., None] if np.ndim(t) == np.ndim(a) - 1 else a + (b - a) * t


# ---------------------------------------------------------------------------------------------
# image encoding (Blender's own JPEG / PNG writers; no PIL in Blender's python)
# ---------------------------------------------------------------------------------------------
def encode_image(arr, fmt="JPEG", quality=80, name="enc"):
    """arr: (h,w,3|4) float 0..1 in the *encoded* space (already sRGB for colour). Row 0 = top."""
    a = np.clip(arr, 0, 1).astype(np.float32)
    h, w, c = a.shape
    if c == 3:
        a = np.concatenate([a, np.ones((h, w, 1), np.float32)], 2)
    img = bpy.data.images.new(name, w, h, alpha=(fmt == "PNG"), float_buffer=False)
    img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(np.ascontiguousarray(a[::-1]).ravel())
    sc = bpy.context.scene
    st = sc.render.image_settings
    st.file_format = fmt
    st.color_mode = "RGBA" if fmt == "PNG" else "RGB"
    if fmt == "JPEG":
        st.quality = quality
    else:
        st.compression = 100
        st.color_depth = "8"
    path = os.path.join(TMP, "_enc." + ("jpg" if fmt == "JPEG" else "png"))
    img.save_render(path, scene=sc)
    bpy.data.images.remove(img)
    with open(path, "rb") as f:
        return f.read()


def resize(a, w, h):
    """Box / bilinear resize of (H,W,C) float array."""
    H, W = a.shape[:2]
    if (H, W) == (h, w):
        return a
    if H % h == 0 and W % w == 0:
        return a.reshape(h, H // h, w, W // w, -1).mean((1, 3))
    ys = (np.arange(h) + 0.5) * H / h - 0.5
    xs = (np.arange(w) + 0.5) * W / w - 0.5
    y0 = np.clip(np.floor(ys).astype(int), 0, H - 1)
    x0 = np.clip(np.floor(xs).astype(int), 0, W - 1)
    y1, x1 = np.clip(y0 + 1, 0, H - 1), np.clip(x0 + 1, 0, W - 1)
    fy, fx = (ys - y0)[:, None, None], (xs - x0)[None, :, None]
    return (a[y0][:, x0] * (1 - fy) * (1 - fx) + a[y0][:, x1] * (1 - fy) * fx
            + a[y1][:, x0] * fy * (1 - fx) + a[y1][:, x1] * fy * fx)


def load_image(path):
    img = bpy.data.images.load(path)
    img.colorspace_settings.name = "Non-Color"
    w, h = img.size
    buf = np.zeros(w * h * 4, np.float32)
    img.pixels.foreach_get(buf)
    bpy.data.images.remove(img)
    return buf.reshape(h, w, 4)[::-1].copy()   # row 0 = top


def height_to_normal(h, strength=1.0):
    """Tangent-space normal (OpenGL, +Y up in image) from a height field (rows go down)."""
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    dy = (np.roll(h, 1, 0) - np.roll(h, -1, 0)) * 0.5      # up = negative row
    n = np.stack([-dx * strength, -dy * strength, np.ones_like(h)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


# ---------------------------------------------------------------------------------------------
# geometry helpers: a "Soup" is plain numpy: tri corners + per-tri attributes
# ---------------------------------------------------------------------------------------------
class Soup:
    """Triangle soup. P (T,3,3) positions, plus per-triangle ints: surf, chart ; UV (T,3,2) filled after packing."""

    def __init__(self):
        self.P, self.surf, self.chart, self.lc = [], [], [], []   # lc: chart-local metres (T,3,2)
        self.shade = []   # per-tri smoothing group (tris in same group smoothed; -1 = by angle)

    def add(self, P, surf, chart="auto", lc=None, grp=0):
        P = np.asarray(P, np.float32).reshape(-1, 3, 3)
        n = len(P)
        self.P.append(P)
        self.surf += [surf] * n
        self.chart += [chart] * n
        self.lc.append(lc if lc is not None else np.zeros((n, 3, 2), np.float32))
        self.shade += [grp] * n

    def arrays(self):
        return (np.concatenate(self.P), np.array(self.surf, np.int16), np.array(self.chart, dtype=object),
                np.concatenate(self.lc), np.array(self.shade, np.int32))


def tris_from_polys(V, polys):
    out = []
    for p in polys:
        for k in range(1, len(p) - 1):
            out.append((p[0], p[k], p[k + 1]))
    return np.array(V, np.float32)[np.array(out, int)]


def mesh_to_tris(obj, surf_from_mat=True):
    """Evaluate modifiers on a Blender object -> (P (T,3,3) world space, material_index (T,))."""
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    me.calc_loop_triangles()
    n = len(me.vertices)
    co = np.zeros(n * 3, np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(n, 3)
    m = np.array(obj.matrix_world, np.float32)
    co = co @ m[:3, :3].T + m[:3, 3]
    nt = len(me.loop_triangles)
    vi = np.zeros(nt * 3, np.int32)
    me.loop_triangles.foreach_get("vertices", vi)
    mi = np.zeros(nt, np.int32)
    me.loop_triangles.foreach_get("material_index", mi)
    P = co[vi.reshape(nt, 3)]
    ev.to_mesh_clear()
    return P, mi


def new_obj(name, V, F, mats=0):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in V], [], [tuple(f) for f in F])
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    for i in range(mats):
        me.materials.append(bpy.data.materials.new("m%d" % i) if i >= len(bpy.data.materials) else bpy.data.materials[i])
    return ob


def set_mat(obj, idx):
    for p in obj.data.polygons:
        p.material_index = idx


def add_mod(obj, kind, **kw):
    m = obj.modifiers.new(kind.title(), kind)
    for k, v in kw.items():
        setattr(m, k, v)
    return m


def drop(*objs):
    for o in objs:
        me = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        if me and me.users == 0:
            bpy.data.meshes.remove(me)


def loft(rings, close_u=True, cap0=False, cap1=False):
    """rings: list of (n,3) arrays with equal n. Returns V, F quads (+ optional fan caps)."""
    n = len(rings[0])
    V = np.concatenate(rings)
    F = []
    for k in range(len(rings) - 1):
        for i in range(n if close_u else n - 1):
            j = (i + 1) % n
            F.append((k * n + i, k * n + j, (k + 1) * n + j, (k + 1) * n + i))
    if cap0:
        F.append(tuple(range(n - 1, -1, -1)))
    if cap1:
        F.append(tuple(range((len(rings) - 1) * n, len(rings) * n)))
    return V, F


def flip(F):
    return [tuple(reversed(f)) for f in F]


def box_tris(c, s, rot=None):
    """Axis box centre c size s -> (12,3,3) tris; optional 3x3 rotation."""
    c = np.asarray(c, np.float32)
    h = np.asarray(s, np.float32) / 2
    V = np.array([[sx, sy, sz] for sz in (-1, 1) for sy in (-1, 1) for sx in (-1, 1)], np.float32) * h
    if rot is not None:
        V = V @ np.asarray(rot, np.float32).T
    V = V + c
    F = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
    return tris_from_polys(V, F)


def rot_x(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]], np.float32)


def rot_y(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], np.float32)


def rot_z(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]], np.float32)


def revolve(profile, seg, axis="x", centre=(0, 0, 0), start=0.0, sweep=2 * math.pi):
    """profile: list of (a, r) = (distance along axis, radius). Returns tris (closed around the axis)."""
    prof = np.asarray(profile, np.float32)
    rings = []
    n = seg if abs(sweep - 2 * math.pi) > 1e-4 else seg
    for i in range(seg + (0 if abs(sweep - 2 * math.pi) < 1e-4 else 1)):
        t = start + sweep * i / seg
        ring = []
        for a, r in prof:
            p = {"x": (a, r * math.cos(t), r * math.sin(t)), "y": (r * math.cos(t), a, r * math.sin(t)),
                 "z": (r * math.cos(t), r * math.sin(t), a)}[axis]
            ring.append(p)
        rings.append(ring)
    R = np.array(rings, np.float32) + np.asarray(centre, np.float32)
    tris = []
    m = len(prof)
    full = abs(sweep - 2 * math.pi) < 1e-4
    for i in range(seg):
        i2 = (i + 1) % seg if full else i + 1
        for j in range(m - 1):
            a, b, c, d = R[i][j], R[i][j + 1], R[i2][j + 1], R[i2][j]
            tris += [[a, b, c], [a, c, d]]
    return np.array(tris, np.float32)


def orient_outward(P, centre=None):
    """Flip triangles whose normal points towards `centre` (closed convex-ish parts)."""
    c = P.reshape(-1, 3).mean(0) if centre is None else np.asarray(centre)
    n = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0])
    flipm = (n * (P.mean(1) - c)).sum(1) < 0
    P = P.copy()
    P[flipm] = P[flipm][:, ::-1]
    return P


def tri_normals(P):
    n = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0])
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    return n / np.maximum(ln, 1e-12), ln[:, 0] * 0.5


def smooth_normals(P, angle_deg=42.0, groups=None):
    """Split normals per triangle corner: area-weighted average of incident faces within `angle` of this face."""
    T = len(P)
    fn, area = tri_normals(P)
    key = np.round(P.reshape(-1, 3) * 1e4).astype(np.int64)
    _, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    order = np.argsort(inv, kind="stable")
    sorted_inv = inv[order]
    starts = np.searchsorted(sorted_inv, np.arange(inv.max() + 2))
    cosT = math.cos(math.radians(angle_deg))
    N = np.zeros((T, 3, 3), np.float32)
    tri_of = order // 3
    for v in range(inv.max() + 1):
        s, e = starts[v], starts[v + 1]
        tis = tri_of[s:e]
        cs = order[s:e]
        fns = fn[tis]
        w = area[tis]
        dots = fns @ fns.T
        use = dots >= cosT
        if groups is not None:
            g = groups[tis]
            use &= (g[:, None] == g[None, :])
        acc = (use * w[None, :]) @ fns
        ln = np.linalg.norm(acc, axis=1, keepdims=True)
        acc = np.where(ln > 1e-9, acc / np.maximum(ln, 1e-9), fns)
        for k, c in enumerate(cs):
            N[c // 3, c % 3] = acc[k]
    return N


# ---------------------------------------------------------------------------------------------
# glb writer
# ---------------------------------------------------------------------------------------------
class GLB:
    def __init__(self):
        self.bin = bytearray()
        self.bvs, self.accs, self.meshes, self.nodes, self.mats, self.images, self.textures = [], [], [], [], [], [], []
        self.exts = set()

    def _bv(self, data, target=None, stride=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        d = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(data)}
        if target:
            d["target"] = target
        if stride:
            d["byteStride"] = stride
        self.bin += data
        self.bvs.append(d)
        return len(self.bvs) - 1

    def acc(self, arr, kind, ctype, norm=False, target=None, minmax=False):
        """arr (n, comps). Interleave-free: one bufferView per accessor (padded rows for int8/int16 vec3)."""
        arr = np.ascontiguousarray(arr)
        comps = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[kind]
        dt = {5126: "<f4", 5123: "<u2", 5125: "<u4", 5120: "i1", 5122: "<i2", 5121: "u1"}[ctype]
        a = arr.astype(dt)
        if a.ndim == 1:
            a = a.reshape(-1, 1)
        item = a.dtype.itemsize * comps
        stride = None
        if item % 4 and kind != "SCALAR":
            pad = (-item) % 4
            padn = pad // a.dtype.itemsize
            a = np.concatenate([a, np.zeros((len(a), padn), dt)], 1)
            stride = item + pad
        bv = self._bv(a.tobytes(), target, stride if (stride and target == 34962) else None)
        d = {"bufferView": bv, "componentType": ctype, "count": int(len(arr)), "type": kind}
        if norm:
            d["normalized"] = True
        if minmax:
            d["min"] = [float(x) for x in arr.min(0)]
            d["max"] = [float(x) for x in arr.max(0)]
        self.accs.append(d)
        return len(self.accs) - 1

    def image(self, data, mime):
        bv = self._bv(data)
        self.images.append({"bufferView": bv, "mimeType": mime})
        self.textures.append({"source": len(self.images) - 1})
        return len(self.textures) - 1

    def mesh(self, name, pos, nrm, uv, idx, mat, extra_attrs=None, extras=None):
        attrs = {"POSITION": self.acc(pos, "VEC3", 5126, target=34962, minmax=True),
                 "NORMAL": self.acc(np.round(nrm * 127), "VEC3", 5120, True, 34962)}
        if uv is not None:
            attrs["TEXCOORD_0"] = self.acc(np.round(np.clip(uv, 0, 1) * 65535), "VEC2", 5123, True, 34962)
        for k, (arr, kind, ct, nm) in (extra_attrs or {}).items():
            attrs[k] = self.acc(arr, kind, ct, nm, 34962)
        it = 5123 if len(pos) < 65536 else 5125
        prim = {"attributes": attrs, "indices": self.acc(np.asarray(idx).reshape(-1), "SCALAR", it, target=34963), "material": mat}
        m = {"name": name, "primitives": [prim]}
        if extras:
            m["extras"] = extras
        self.meshes.append(m)
        return len(self.meshes) - 1

    def node(self, name, mesh=None, t=None, r=None, extras=None, children=None):
        n = {"name": name}
        if mesh is not None:
            n["mesh"] = mesh
        if t is not None:
            n["translation"] = [float(x) for x in t]
        if r is not None:
            n["rotation"] = [float(x) for x in r]
        if extras:
            n["extras"] = extras
        if children:
            n["children"] = children
        self.nodes.append(n)
        return len(self.nodes) - 1

    def material(self, name, **kw):
        self.mats.append(dict(name=name, **kw))
        return len(self.mats) - 1

    def save(self, path, scene_nodes=None, extras=None):
        j = {"asset": {"version": "2.0", "generator": "build_lodge_props.py", "copyright": "Original props; koi/phoenix CC-BY-4.0 (7PLUS, NORBERTO-3D)"},
             "scene": 0, "scenes": [{"nodes": scene_nodes if scene_nodes is not None else list(range(len(self.nodes)))}],
             "nodes": self.nodes, "meshes": self.meshes, "materials": self.mats, "accessors": self.accs,
             "bufferViews": self.bvs, "buffers": [{"byteLength": len(self.bin)}]}
        if self.images:
            j["images"], j["textures"] = self.images, self.textures
            j["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}]
            for t in self.textures:
                t["sampler"] = 0
        if extras:
            j["extras"] = extras
        if getattr(self, "skins", None):
            j["skins"] = self.skins
        if getattr(self, "anims", None):
            j["animations"] = self.anims
        if getattr(self, "asset_extra", None):
            j["asset"].update(self.asset_extra)
        js = json.dumps(j, separators=(",", ":")).encode()
        js += b" " * ((-len(js)) % 4)
        b = bytes(self.bin) + b"\0" * ((-len(self.bin)) % 4)
        out = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(b))
        out += struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(b), 0x004E4942) + b
        with open(path, "wb") as f:
            f.write(out)
        return len(out)


def to_gltf(P):
    """Authoring (x,y,z) -> glTF (x, z, -y), and flip winding to keep faces outward."""
    return np.stack([P[..., 0], P[..., 2], -P[..., 1]], -1)


def tris_to_buffers(P, N, UV, extra=None):
    """Corner arrays (T,3,k) -> unique vertex buffers + index list. extra: dict name->(T,3,k)."""
    T = len(P)
    cols = [P.reshape(-1, 3), N.reshape(-1, 3), UV.reshape(-1, 2)]
    ex = {k: v.reshape(T * 3, -1) for k, v in (extra or {}).items()}
    cols += list(ex.values())
    key = np.round(np.concatenate(cols, 1) * np.array([2e4] * 3 + [100] * 3 + [8000] * 2 + [100] * sum(c.shape[1] for c in ex.values()))).astype(np.int64)
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    inv = inv.reshape(-1)
    return (P.reshape(-1, 3)[first], N.reshape(-1, 3)[first], UV.reshape(-1, 2)[first],
            inv.astype(np.uint32).reshape(T, 3), {k: v[first] for k, v in ex.items()})


def js_asset(path, header, consts):
    with open(path, "w") as f:
        f.write(header + "\n")
        for k, v in consts.items():
            if isinstance(v, bytes):
                f.write("export const %s = \"%s\";\n" % (k, base64.b64encode(v).decode()))
            else:
                f.write("export const %s = %s;\n" % (k, json.dumps(v, separators=(",", ":"))))
    return os.path.getsize(path)


# =============================================================================================
# SCHOOL BUS geometry
# =============================================================================================
S_PAINT, S_BLACK, S_CHROME, S_TYRE, S_RIM, S_LENS, S_RED, S_AMBER, S_INT, S_UNDER, S_DOOR, S_STOP, S_WHITE, S_SEAT, S_GLASS = range(15)
SWATCH_SURFS = (S_INT, S_UNDER, S_SEAT, S_RIM, S_LENS, S_RED, S_AMBER, S_WHITE)

HW = 1.22                 # body half width
Z0, ZR = 0.62, 3.07       # skirt bottom, roof crown
Y_REAR, Y_FRONT = -5.45, 3.30
RWY, FWY = -2.75, 4.30    # rear / front axle y
TR = 0.52                 # tyre radius
SILL, HEAD = 1.55, 2.42
ROWS_Z = [Z0, 0.70, 0.90, 1.10, 1.30, SILL, 1.99, HEAD, 2.62, 2.76]
BAY_P, BAY_W = 0.84, 0.72
BAYS = [(1.86 - BAY_P * k - BAY_W, 1.86 - BAY_P * k) for k in range(8)]     # (y0,y1) right side & left side
DOOR = (2.05, 2.95)
DRIVER = (2.25, 3.05)
ARCH_R = 0.68


def wall_x(z):
    return HW - 0.02 * max(0.0, z - 1.6) / 1.0


def arch_lift(y, z, yc=RWY, R=ARCH_R, zc=0.52):
    """Remap skirt z so its lower edge follows the wheel arch."""
    d = abs(y - yc)
    if d >= R or z > 1.30:
        return z
    zb = zc + math.sqrt(R * R - d * d)
    if zb <= z and z >= 1.30:
        return z
    zb = max(zb, Z0)
    return zb + (z - Z0) * (1.30 - zb) / (1.30 - Z0) if z < 1.30 else z


def profile_rows():
    """Half profile (right side) bottom->top as list of (x,z)."""
    pts = [(wall_x(z) - (0.05 if z <= Z0 + 1e-6 else 0.0), z) for z in ROWS_Z]
    for k in range(1, 6):
        t = k / 5 * math.pi / 2
        pts.append((pts[-1][0] * math.cos(t) if k < 5 else 0.0, 2.76 + (ZR - 2.76) * math.sin(t)))
    # make the shoulder arc start from the wall x at 2.76
    x0 = wall_x(2.76)
    pts = pts[:len(ROWS_Z)] + [(x0 * math.cos(k / 5 * math.pi / 2), 2.76 + (ZR - 2.76) * math.sin(k / 5 * math.pi / 2)) for k in range(1, 6)]
    return pts


PROF = profile_rows()
NR = len(PROF)


def stations_y():
    ys = set()
    for a, b in BAYS + [DOOR, DRIVER]:
        ys.add(round(a, 3)); ys.add(round(b, 3))
    # arch stations
    for k in range(-6, 7):
        ys.add(round(RWY + k * 0.12, 3))
    for y in np.linspace(-4.7, 3.0, 22):
        ys.add(round(float(y), 3))
    return sorted(y for y in ys if Y_REAR + 0.35 < y < Y_FRONT - 0.35)


def end_stations(y_end, r, sign):
    """sign=-1 rear (moves towards +y), +1 front. returns [(y, inset)] from the end face inwards."""
    out = []
    for th in (0.0, 0.5, 1.0, 1.45):
        th_ = th
        out.append((y_end - sign * r * (1 - math.cos(th_)) * 1.0, r * (1 - math.sin(th_))))
    return out


def rake(y, z):
    """Windshield rake: the front face leans back with height."""
    return y - 0.10 * (z - 1.85) if y > 2.5 else y


def inset_pt(x, z, inset):
    zc = 1.85
    fx = max(0.05, (HW - inset) / HW)
    fz = max(0.05, (1.22 - inset) / 1.22)
    return x * fx, zc + (z - zc) * fz


def build_box_shell(hole_sets):
    """Returns dict of Soup tri arrays: outer skin, inner skin, reveals, plus glass quads & hole info."""
    ys = stations_y()
    rear = end_stations(Y_REAR, 0.30, -1)       # face first
    front = end_stations(Y_FRONT, 0.32, +1)
    stations = [(y, i, "rear") for y, i in rear] + [(y, 0.0, "mid") for y in ys] + [(y, i, "front") for y, i in reversed(front)]
    stations.sort(key=lambda s: s[0])
    # grid of vertices: [station][side-ordered profile idx]; full ring = right half rows 0..NR-1 then left half mirrored (NR-2..0)
    full = list(range(NR)) + list(range(NR - 2, -1, -1))
    side = [1] * NR + [-1] * (NR - 1)
    V = np.zeros((len(stations), len(full), 3), np.float32)
    for si, (y, ins, kind) in enumerate(stations):
        for ci, (pi, sd) in enumerate(zip(full, side)):
            x, z = PROF[pi]
            if kind != "mid":
                x, z = inset_pt(x, z, ins)
            yy = y
            if kind == "front":
                yy = rake(y, z)
            z2 = arch_lift(y, z) if kind == "mid" and pi < 4 else z
            V[si, ci] = (sd * x, yy, z2)
    return stations, full, side, V


def in_hole(y0, y1, zlo, zhi, ya, yb, za, zb, eps=1e-3):
    return ya >= y0 - eps and yb <= y1 + eps and za >= zlo - eps and zb <= zhi + eps


def box_parts():
    """Build the passenger box: outer, inner, reveals, glass, face grids. Returns dict name->(P tris)."""
    stations, full, side, V = build_box_shell(None)
    NS, NC = V.shape[:2]
    right_holes = [(a, b, SILL, HEAD) for a, b in BAYS] + [(DOOR[0], DOOR[1], 0.90, HEAD)]
    left_holes = [(a, b, SILL, HEAD) for a, b in BAYS] + [(DRIVER[0], DRIVER[1], SILL, HEAD)]
    sys_ = [s[0] for s in stations]
    outer, inner, reveal, glass, bars = [], [], [], [], []

    def hole_of(si, ci):
        """Is the cell between stations si..si+1 and ring cols ci..ci+1 inside a window hole?"""
        ya, yb = sys_[si], sys_[si + 1]
        ra, rb = full[ci], full[ci + 1]
        if side[ci] != side[ci + 1] or max(ra, rb) >= len(ROWS_Z):
            return None
        za, zb = ROWS_Z[min(ra, rb)], ROWS_Z[max(ra, rb)]
        for hi, (y0, y1, zl, zh) in enumerate(right_holes if side[ci] > 0 else left_holes):
            if in_hole(y0, y1, zl, zh, ya, yb, za, zb) and stations[si][2] == "mid" and stations[si + 1][2] == "mid":
                return (side[ci], hi)
        return None

    holes = {}
    for si in range(NS - 1):
        for ci in range(NC - 1):
            h = hole_of(si, ci)
            if h:
                holes.setdefault(h, []).append((si, ci))
                continue
            a, b, c, d = V[si, ci], V[si, ci + 1], V[si + 1, ci + 1], V[si + 1, ci]
            outer += [[a, d, c], [a, c, b]] if True else []
    # winding: ring runs bottom-right -> top -> bottom-left, stations rear->front. check later via orient
    # reveals + glass for each hole
    glass_quads, bar_boxes, hole_rects = [], [], []
    for (sd, hi), cells in holes.items():
        sis = [c[0] for c in cells]; cis = [c[1] for c in cells]
        s0, s1, c0, c1 = min(sis), max(sis) + 1, min(cis), max(cis) + 1
        y0, y1 = sys_[s0], sys_[s1]
        zl, zh = PROF[full[c0]][1] if side[c0] > 0 else PROF[full[c0]][1], PROF[full[c1]][1]
        zl, zh = min(zl, zh), max(zl, zh)
        # actually z from rows
        zl = min(ROWS_Z[min(full[c0], full[c1])], ROWS_Z[max(full[c0], full[c1])])
        zh = max(ROWS_Z[min(full[c0], full[c1])], ROWS_Z[max(full[c0], full[c1])])
        dep = 0.055
        xo = lambda z: sd * wall_x(z)
        xi = lambda z: sd * (wall_x(z) - dep)
        ring_o = [(xo(zl), y0, zl), (xo(zl), y1, zl), (xo(zh), y1, zh), (xo(zh), y0, zh)]
        ring_i = [(xi(zl), y0, zl), (xi(zl), y1, zl), (xi(zh), y1, zh), (xi(zh), y0, zh)]
        for k in range(4):
            k2 = (k + 1) % 4
            reveal += [[ring_o[k], ring_o[k2], ring_i[k2]], [ring_o[k], ring_i[k2], ring_i[k]]]
        hole_rects.append((sd, y0, y1, zl, zh))
        if hi == len(right_holes) - 1 and sd > 0:       # door: handled elsewhere
            continue
        m = 0.012
        gq = [(xi(zl + m) - sd * 0.004, y0 + m, zl + m), (xi(zl + m) - sd * 0.004, y1 - m, zl + m),
              (xi(zh - m) - sd * 0.004, y1 - m, zh - m), (xi(zh - m) - sd * 0.004, y0 + m, zh - m)]
        glass_quads.append((sd, gq))
        zm = 1.99
        bar_boxes.append((sd * (wall_x(zm) - dep + 0.015), (y0 + y1) / 2, zm, 0.03, (y1 - y0) - 0.02, 0.045))
    # inner skin: same cells shifted inwards along -normal-ish (towards centre), reversed winding
    inner_off = 0.06
    centre = np.array([0, 0, 1.85], np.float32)
    for si in range(NS - 1):
        for ci in range(NC - 1):
            if hole_of(si, ci):
                continue
            q = []
            for (s_, c_) in ((si, ci), (si, ci + 1), (si + 1, ci + 1), (si + 1, ci)):
                p = V[s_, c_].copy()
                v = centre - p
                v[1] = 0
                p = p + v / max(np.linalg.norm(v), 1e-6) * inner_off
                q.append(p)
            a, b, c, d = q
            inner += [[a, c, d], [a, b, c]]
    return dict(stations=stations, V=V, outer=np.array(outer, np.float32), inner=np.array(inner, np.float32),
                reveal=np.array(reveal, np.float32), glass=glass_quads, bars=bar_boxes, holes=hole_rects, full=full, side=side)


class BSoup(Soup):
    def __init__(self):
        super().__init__()
        self.tag = []

    def add(self, P, surf, chart="auto", lc=None, grp=0, tag=""):
        n = len(np.asarray(P).reshape(-1, 3, 3))
        super().add(P, surf, chart, lc, grp)
        self.tag += [tag] * n


def rbox(c, size, r=0.05, axis="y", seg=2, taper=None):
    """Rounded box (closed, outward faces). size in world xyz."""
    sx, sy, sz = size
    perm = {"y": (0, 1, 2), "x": (1, 0, 2), "z": (0, 2, 1)}[axis]
    loc = [size[perm[0]], size[perm[1]], size[perm[2]]]     # local (a, long, b)
    ha, hl, hb = loc[0] / 2, loc[1] / 2, loc[2] / 2
    rc = min(r, ha * 0.98, hb * 0.98)
    rl = min(r, hl * 0.98)
    arc = []
    for k, (cx, cz, a0) in enumerate(((1, 1, 0), (-1, 1, 90), (-1, -1, 180), (1, -1, 270))):
        for s in range(seg + 1):
            t = math.radians(a0 + 90 * s / seg)
            arc.append((cx * (ha - rc) + math.cos(t) * rc, cz * (hb - rc) + math.sin(t) * rc))
    rings = []
    ths = [0.0, 0.6, 1.2, math.pi / 2]
    for end in (-1, 1):
        for th in (ths if end < 0 else ths[::-1]):
            inset = rl * (1 - math.sin(th))
            y = end * (hl - rl * (1 - math.cos(th)))
            f_a = max(0.02, (ha - inset) / ha)
            f_b = max(0.02, (hb - inset) / hb)
            rings.append([(p[0] * f_a, y, p[1] * f_b) for p in arc])
    rings = np.array(rings, np.float32)
    Vv, F = loft(list(rings), True, True, True)
    Vv = Vv[:, list(np.argsort(perm))] if False else Vv
    # local (a,long,b) -> world: world[perm[i]] = local[i]
    W = np.zeros_like(Vv)
    for i in range(3):
        W[:, perm[i]] = Vv[:, i]
    W += np.asarray(c, np.float32)
    return orient_outward(tris_from_polys(W, F), np.asarray(c, np.float32))


def extrude_x(poly_yz, x0, x1):
    """Closed prism: polygon in (y,z) extruded between x0..x1 (convex-ish outline)."""
    n = len(poly_yz)
    A = np.array([(x0, y, z) for y, z in poly_yz], np.float32)
    B = np.array([(x1, y, z) for y, z in poly_yz], np.float32)
    V = np.concatenate([A, B])
    F = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)] + [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))]
    return orient_outward(tris_from_polys(V, F), V.mean(0))


def disc_lamp(c, r, depth, axis_sign=1, axis="y", dome=0.045):
    """Short lens cylinder along an axis."""
    prof = [(0, 0), (0, r), (depth * 0.55, r), (depth, r * 0.78), (depth + dome, r * 0.45), (depth + dome * 1.2, 0)]
    T = revolve(prof, 14, axis=axis)
    if axis_sign < 0:
        T = T * np.array([1, -1, 1], np.float32) if axis == "y" else T * np.array([-1, 1, 1], np.float32)
    T = T + np.asarray(c, np.float32)
    return orient_outward(T, np.asarray(c, np.float32) + (np.array([0, 1, 0]) if axis == "y" else np.array([1, 0, 0])) * axis_sign * 0.0 - np.array([0, 0.05 * axis_sign, 0]) * (axis == "y"))


def build_bus_geometry(old=False):
    S = BSoup()
    bp = box_parts()
    # ---- passenger box -------------------------------------------------------------------
    def orient_axis(P):
        c = P.mean(1)
        n, _ = tri_normals(P)
        ref = np.stack([c[:, 0] * 0, c[:, 1] * 0, np.full(len(c), 1.85, np.float32)], 1)
        ref[:, 1] = c[:, 1]
        # end faces: use global centre in y
        endm = (np.abs(c[:, 1] - Y_REAR) < 0.45) | (c[:, 1] > Y_FRONT - 0.45)
        ref[endm] = np.array([0, 0, 1.85], np.float32)
        d = c - ref
        bad = (n * d).sum(1) < 0
        P = P.copy()
        P[bad] = P[bad][:, ::-1]
        return P
    outer = orient_axis(bp["outer"])
    S.add(outer, S_PAINT, tag="body")
    inner = bp["inner"].copy()
    inn_n, _ = tri_normals(inner)
    cc = inner.mean(1)
    towards = np.stack([-cc[:, 0], np.zeros(len(cc)), 1.85 - cc[:, 2]], 1)
    bad = (inn_n * towards).sum(1) < 0
    inner[bad] = inner[bad][:, ::-1]
    S.add(inner, S_INT, chart="sw", tag="body")
    rv = bp["reveal"]
    S.add(rv, S_BLACK, tag="body")
    # end faces (grids)
    V, full, side = bp["V"], bp["full"], bp["side"]
    NC = V.shape[1]
    def face(ring, windows):
        cols = [-1, -0.84, -0.04, 0.04, 0.84, 1]
        rows = []
        for j in range(NR):
            xr = abs(ring[j][0]) if j < NR else 0
            rows.append([np.array([s * xr, ring[j][1], ring[j][2]], np.float32) for s in cols])
        tris, gl = [], []
        for j in range(NR - 1):
            for k in range(len(cols) - 1):
                a, b, c, d = rows[j][k], rows[j][k + 1], rows[j + 1][k + 1], rows[j + 1][k]
                if windows and k in (1, 3) and j in (5, 6):
                    continue
                tris += [[a, b, c], [a, c, d]]
        if windows:
            for k in (1, 3):
                a, b, c, d = rows[5][k], rows[5][k + 1], rows[7][k + 1], rows[7][k]
                gl.append([a + np.array([0, -0.045, 0.012]), b + np.array([0, -0.045, 0.012]), c + np.array([0, -0.045, -0.012]), d + np.array([0, -0.045, -0.012])])
                # reveal
                for p, q in ((a, b), (b, c), (c, d), (d, a)):
                    tris += [[p, q, q + np.array([0, -0.055, 0])], [p, q + np.array([0, -0.055, 0]), p + np.array([0, -0.055, 0])]]
        return np.array(tris, np.float32), gl
    def rear_face(ring):
        cols = [-1.0, -0.84, -0.46, -0.38, 0.38, 0.46, 0.84, 1.0]
        rows = []
        for j in range(NR):
            xr = abs(ring[j][0]) if j < NR else 0
            rows.append([np.array([s * xr, ring[j][1], ring[j][2]], np.float32) for s in cols])
        tris, gl, frames = [], [], []
        for j in range(NR - 1):
            for k in range(len(cols) - 1):
                a, b, c, d = rows[j][k], rows[j][k + 1], rows[j + 1][k + 1], rows[j + 1][k]
                if k in (1, 3, 5) and j in (5, 6):
                    continue
                tris += [[a, b, c], [a, c, d]]
        for k in (1, 3, 5):
            a, b, c, d = rows[5][k], rows[5][k + 1], rows[7][k + 1], rows[7][k]
            # Glass panel quad (recessed inside the window opening, oriented outward towards -y)
            g_b = b + np.array([0, 0.040, 0.012], np.float32)
            g_a = a + np.array([0, 0.040, 0.012], np.float32)
            g_d = d + np.array([0, 0.040, -0.012], np.float32)
            g_c = c + np.array([0, 0.040, -0.012], np.float32)
            gl.append([g_b, g_a, g_d, g_c])
            # Inner reveal walls (inset into the bus toward +y)
            dy = 0.055
            for p, q in ((a, b), (b, c), (c, d), (d, a)):
                frames += [[p, q, q + np.array([0, dy, 0], np.float32)], [p, q + np.array([0, dy, 0], np.float32), p + np.array([0, dy, 0], np.float32)]]
            # Outer raised rubber gasket frame around the cutout
            Wf = 0.024
            ao = a + np.array([-Wf, -0.008, -Wf], np.float32)
            bo = b + np.array([Wf, -0.008, -Wf], np.float32)
            co = c + np.array([Wf, -0.008, Wf], np.float32)
            do = d + np.array([-Wf, -0.008, Wf], np.float32)
            ai = a + np.array([0, -0.002, 0], np.float32)
            bi = b + np.array([0, -0.002, 0], np.float32)
            ci = c + np.array([0, -0.002, 0], np.float32)
            di = d + np.array([0, -0.002, 0], np.float32)
            for po, qo, pi, qi in ((ao, bo, ai, bi), (bo, co, bi, ci), (co, do, ci, di), (do, ao, di, ai)):
                frames += [[po, qo, qi], [po, qi, pi]]
        fr_arr = np.array(frames, np.float32) if len(frames) else np.zeros((0, 3, 3), np.float32)
        if len(fr_arr):
            fn, _ = tri_normals(fr_arr)
            bad_fr = (fn[:, 1] > 0.0) & (np.abs(fn[:, 1]) > 0.3)
            fr_arr[bad_fr] = fr_arr[bad_fr][:, ::-1]
        return np.array(tris, np.float32), gl, fr_arr
    def ring_of(si):
        return [V[si, i] for i in range(NR)] if False else [V[si, full.index(j)] for j in range(NR)]
    rear_ring = [V[0, j] for j in range(NR)]
    front_ring = [V[-1, j] for j in range(NR)]
    rf, rglass, rframe = rear_face(rear_ring)
    ff, fglass = face(front_ring, True)
    for P in (rf, ff):
        c = P.mean(1)
        n, _ = tri_normals(P)
        ysign = np.where(c[:, 1] > 0, 1, -1)
        P2 = P.copy()
        bad = (n[:, 1] * ysign) < -0.0  # normals should point along +y at the front, -y at rear
        # reveals point inwards (normal mostly sideways): leave those alone
        flat = np.abs(n[:, 1]) > 0.5
        P2[bad & flat] = P2[bad & flat][:, ::-1]
        S.add(P2, S_PAINT, tag="body")
    if len(rframe):
        S.add(rframe, S_BLACK, tag="body")
    glass = []
    for sd, gq in bp["glass"]:
        glass.append(np.array(gq, np.float32))
    for g in fglass:
        glass.append(np.array(g, np.float32))
    for g in rglass:
        glass.append(np.array(g, np.float32))
    # bottom / floor
    S.add(box_tris((0, (Y_REAR + Y_FRONT) / 2 - 0.1, Z0 + 0.01), (2.3, Y_FRONT - Y_REAR - 0.5, 0.02)), S_UNDER, chart="sw", tag="body")
    S.add(box_tris((0, (Y_REAR + Y_FRONT) / 2 - 0.1, 0.84), (2.3, Y_FRONT - Y_REAR - 0.6, 0.02)), S_INT, chart="sw", tag="body")
    # ---- rub rails ------------------------------------------------------------------------
    def cut(y0, y1, holes):
        segs = [(y0, y1)]
        for h0, h1 in holes:
            ns = []
            for a, b in segs:
                if h1 <= a or h0 >= b:
                    ns.append((a, b)); continue
                if h0 > a: ns.append((a, h0))
                if h1 < b: ns.append((h1, b))
            segs = ns
        return segs
    prof = [(0.0, -0.032), (0.016, -0.026), (0.026, 0.0), (0.016, 0.026), (0.0, 0.032)]
    def rail(z, sd, y0, y1):
        ring = lambda y: np.array([(sd * (wall_x(z) + o), y, z + dz) for o, dz in prof], np.float32)
        Vr, Fr = loft([ring(y0), ring(y1)], False, False, False)
        P = tris_from_polys(Vr, Fr)
        n, _ = tri_normals(P)
        bad = n[:, 0] * sd < -1e-3
        P[bad] = P[bad][:, ::-1]
        return P
    for sd in (1, -1):
        for z, hs in ((0.97, [(RWY - 0.78, RWY + 0.78)] + ([DOOR] if sd > 0 else [])), (1.27, [(RWY - 0.78, RWY + 0.78)] + ([(DOOR[0] - 0.05, DOOR[1] + 0.05)] if sd > 0 else [])),
                      (SILL - 0.045, []), (2.53, [])):
            for a, b in cut(-5.25, 3.02, hs):
                S.add(rail(z, sd, a, b), S_BLACK, tag="body")
    # ---- hood, fenders, grille, bumpers ---------------------------------------------------
    S.add(rbox((0, 4.22, 1.35), (1.78, 1.98, 1.1), r=0.26), S_BLACK, tag="body")
    S.add(rbox((0, 4.30, 1.93), (0.9, 1.7, 0.08), r=0.04), S_BLACK, tag="body")
    for sd in (1, -1):
        rings = []
        Rf = 0.66
        for k in range(15):
            t = math.pi * k / 14
            y, zc = FWY + Rf * math.cos(t) * 0.0, 0.0
            pts = [(0.80, Rf + 0.05), (0.96, Rf + 0.13), (1.15, Rf + 0.10), (1.225, Rf + 0.0), (1.225, Rf - 0.09), (0.80, Rf - 0.06)]
            rings.append(np.array([(sd * px, FWY + (rr) * math.cos(t), 0.52 + (rr) * math.sin(t)) for px, rr in pts], np.float32))
        Vf, Ff = loft(rings, True, True, True)
        P = tris_from_polys(Vf, Ff)
        S.add(orient_outward(P, np.array([sd * 1.0, FWY, 0.55], np.float32) * 0 + np.array([sd * 1.0, FWY, 0.8], np.float32)), S_BLACK, tag="body")
    S.add(rbox((0, 5.19, 1.18), (1.3, 0.06, 0.74), r=0.025), S_CHROME, tag="body")      # grille
    S.add(rbox((0, 5.40, 0.60), (2.36, 0.34, 0.30), r=0.13), S_BLACK, tag="body")
    S.add(rbox((0, 5.50, 0.64), (2.0, 0.07, 0.08), r=0.03), S_CHROME, tag="body")
    S.add(rbox((0, -5.60, 0.64), (2.42, 0.30, 0.32), r=0.10), S_BLACK, tag="body")
    S.add(rbox((0, -5.53, 0.95), (0.56, 0.02, 0.26), r=0.01), S_WHITE, tag="body")
    # headlights / indicators
    for sd in (1, -1):
        c = (sd * 0.66, 5.17, 1.20)
        S.add(disc_lamp(c, 0.145, 0.03), S_LENS, chart="sw", tag="body")
        S.add(revolve([(0, 0.15), (0, 0.19), (0.03, 0.19), (0.03, 0.15)], 14, axis="y") + np.array(c, np.float32) + np.array([0, -0.02, 0], np.float32), S_CHROME, tag="body")
        S.add(disc_lamp((sd * 0.90, 5.14, 1.52), 0.055, 0.015), S_AMBER, chart="sw", tag="body")
        S.add(rbox((sd * 1.0, 5.50, 0.64), (0.14, 0.06, 0.1), r=0.02), S_AMBER, chart="sw", tag="body")
        # mirrors
        S.add(rbox((sd * 1.36, 3.62, 2.15), (0.06, 0.07, 0.50), r=0.02), S_BLACK, tag="body")
        S.add(rbox((sd * 1.30, 3.55, 2.34), (0.22, 0.06, 0.10), r=0.02, axis="x"), S_BLACK, tag="body")
        S.add(rbox((sd * 1.42, 3.62, 2.12), (0.05, 0.05, 0.36), r=0.015), S_CHROME, tag="body")
        S.add(rbox((sd * 0.98, 4.95, 1.76), (0.03, 0.03, 0.2), r=0.01), S_BLACK, tag="body")
        S.add(revolve([(0, 0), (0.03, 0.08), (0.08, 0.1), (0.1, 0)], 10, axis="y") + np.array([sd * 0.98, 4.95, 1.9], np.float32), S_CHROME, tag="body")
        # tail lamps
        S.add(rbox((sd * 1.09, -5.50, 1.02), (0.13, 0.05, 0.36), r=0.02), S_RED, chart="sw", tag="body")
    # ---- roof lamps, hatches, signs --------------------------------------------------------
    for sd in (1, -1):
        for (x, kind) in ((0.97, S_AMBER), (0.64, S_RED)):
            S.add(disc_lamp((sd * x, rake(Y_FRONT, 2.69) + 0.0, 2.69), 0.095, 0.03), kind, chart="sw", tag="body")
            T = disc_lamp((sd * x, 0, 2.69), 0.095, 0.03, axis_sign=-1)
            S.add(T + np.array([0, Y_REAR - 0.02, 0], np.float32), kind, chart="sw", tag="body")
    for y in (-2.3, 0.4):
        S.add(rbox((0, y, ZR + 0.035), (0.78, 0.78, 0.09), r=0.04), S_WHITE, chart="sw", tag="body")
    S.add(rbox((0.0, -4.4, ZR + 0.03), (0.5, 0.5, 0.07), r=0.03), S_WHITE, chart="sw", tag="body")
    # ---- stop arm / crossing arm -----------------------------------------------------------
    ang = np.arange(8) * math.pi / 4 + math.pi / 8
    oct_ = [(1.15, 0.0 + 0.0)]
    cy, cz, sdx = 1.45, 1.22, -1
    pts = np.array([(sdx * (HW + 0.075), cy + 0.27 * math.cos(a), cz + 0.27 * math.sin(a)) for a in ang], np.float32)
    ctr = np.array([sdx * (HW + 0.075), cy, cz], np.float32)
    tri = [[ctr, pts[i], pts[(i + 1) % 8]] for i in range(8)]
    tri = np.array(tri, np.float32)
    n, _ = tri_normals(tri)
    bad = n[:, 0] * sdx < 0
    tri[bad] = tri[bad][:, ::-1]
    S.add(tri, S_STOP, tag="body")
    back = tri[:, ::-1] + np.array([-sdx * 0.012, 0, 0], np.float32)
    S.add(back, S_WHITE, chart="sw", tag="body")
    S.add(rbox((sdx * (HW + 0.04), cy - 0.40, cz), (0.07, 0.30, 0.05), r=0.015), S_BLACK, tag="body")
    S.add(rbox((0.40, 5.60, 0.98), (1.55, 0.03, 0.03), r=0.012, axis="x"), S_CHROME, tag="body")
    S.add(rbox((1.17, 5.56, 0.98), (0.07, 0.10, 0.1), r=0.02), S_BLACK, tag="body")
    S.add(rbox((-0.37, 5.60, 0.98), (0.06, 0.06, 0.06), r=0.02), S_RED, chart="sw", tag="body")
    # ---- door fill -------------------------------------------------------------------------
    xd = wall_x(1.6) - 0.085
    dq = [(xd, DOOR[0], 0.90), (xd, DOOR[1], 0.90), (xd, DOOR[1], HEAD), (xd, DOOR[0], HEAD)]
    S.add(np.array([[dq[0], dq[2], dq[1]], [dq[0], dq[3], dq[2]]], np.float32), S_DOOR, tag="body")
    for y0, y1 in ((DOOR[0] + 0.04, (DOOR[0] + DOOR[1]) / 2 - 0.02), ((DOOR[0] + DOOR[1]) / 2 + 0.02, DOOR[1] - 0.04)):
        glass.append(np.array([(xd + 0.01, y0, 1.50), (xd + 0.01, y1, 1.50), (xd + 0.01, y1, HEAD - 0.05), (xd + 0.01, y0, HEAD - 0.05)], np.float32))
    # ---- wheels ------------------------------------------------------------------------------
    tyre_prof = [(-0.12, 0.31), (-0.15, 0.36), (-0.158, 0.44), (-0.14, 0.50), (-0.10, 0.52), (0.10, 0.52), (0.14, 0.50), (0.158, 0.44), (0.15, 0.36), (0.12, 0.31)]
    rim_prof = [(-0.115, 0.32), (-0.115, 0.27), (-0.07, 0.23), (-0.07, 0.12), (-0.11, 0.10), (-0.11, 0.02), (-0.06, 0.0)]
    plen = np.cumsum([0] + [math.hypot(tyre_prof[i + 1][0] - tyre_prof[i][0], tyre_prof[i + 1][1] - tyre_prof[i][1]) for i in range(len(tyre_prof) - 1)])
    wheels = [(1, FWY, 0.97, "f"), (-1, FWY, 0.97, "f"), (1, RWY, 0.95, "ro"), (-1, RWY, 0.95, "ro"), (1, RWY, 0.57, "ri"), (-1, RWY, 0.57, "ri")]
    flat_set = {(-1, "f"), (1, "ro")} if old else set()
    for sd, yc, xc, kind in wheels:
        T = revolve(tyre_prof, 22, axis="x")
        flat = (sd, kind) in flat_set
        C = np.array([sd * xc, yc, TR], np.float32)
        # chart-local (u = angle * R, v = profile arclength)
        ang = np.arctan2(T[..., 2], T[..., 1])
        ref = ang[:, :1]
        d = (ang - ref + np.pi) % (2 * np.pi) - np.pi
        u = (ref + d) * TR
        pr = np.hypot(T[..., 1], T[..., 2])
        a = T[..., 0]
        dist = (a[..., None] - np.array([p[0] for p in tyre_prof])) ** 2 + (pr[..., None] - np.array([p[1] for p in tyre_prof])) ** 2
        vv = plen[np.argmin(dist, -1)]
        lc = np.stack([u, vv], -1).astype(np.float32)
        T = T + C
        if flat:
            # squash the lower contact patch: tyre sits lower, bulges sideways
            drop = np.clip((T[..., 2] - TR) / TR, 0, 1)
            T[..., 2] = np.where(T[..., 2] > TR, TR + (T[..., 2] - TR) * 0.62, T[..., 2])
            T[..., 0] += sd * 0.05 * (1 - np.abs((T[..., 2] - TR) / TR)) * np.sign(a) * 0.0
        S.add(T, S_TYRE, chart="tyre", lc=lc, tag="tyre" if not flat else "tyreflat")
        R_ = revolve(rim_prof, 22, axis="x")
        if sd < 0:
            R_ = R_ * np.array([-1, 1, 1], np.float32)
        Rm = R_ + C + np.array([sd * 0.0, 0, 0], np.float32)
        S.add(orient_outward(Rm, C + np.array([sd * 0.05, 0, 0], np.float32) * 0 + np.array([sd * 0.11, 0, 0], np.float32)), S_RIM, chart="sw", tag="rimflat" if flat else "rim")
        # lug nuts
        for i in range(6):
            t = i * math.pi / 3
            S.add(box_tris(C + np.array([sd * (0.122), 0.15 * math.cos(t), 0.15 * math.sin(t)], np.float32), (0.03, 0.04, 0.04)), S_CHROME, chart="sw", tag="rimflat" if flat else "rim")
    # arch liners (rear) + chassis
    for sd in (1, -1):
        prof = [(0.45, 0.70), (1.19, 0.70)]
        L = revolve(prof, 12, axis="x", sweep=math.pi, start=0.0)
        L = L * np.array([sd, 1, 1], np.float32) + np.array([0, RWY, 0.52], np.float32)
        S.add(np.concatenate([L, L[:, ::-1]]), S_UNDER, chart="sw", tag="body")
        S.add(box_tris((sd * 0.45, 0.0, 0.50), (0.12, 10.0, 0.16)), S_UNDER, chart="sw", tag="body")
        S.add(rbox((sd * 0.80, 0.4, 0.45), (0.50, 1.3, 0.40), r=0.12), S_UNDER, chart="sw", tag="body")
    S.add(revolve([(-1.1, 0.07), (1.1, 0.07)], 8, axis="x") + np.array([0, FWY, TR], np.float32), S_UNDER, chart="sw", tag="body")
    S.add(revolve([(-1.0, 0.09), (1.0, 0.09)], 8, axis="x") + np.array([0, RWY, TR], np.float32), S_UNDER, chart="sw", tag="body")
    # ---- interior: seats, dash, driver ------------------------------------------------------
    seat = [(-0.24, 0.88), (0.22, 0.88), (0.25, 0.98), (0.22, 1.05), (-0.07, 1.06), (-0.09, 1.55), (-0.15, 1.64), (-0.21, 1.58), (-0.25, 1.0)]
    for k in range(10):
        y = 1.86 - 0.84 * k - 0.30
        if y < -4.95:
            break
        for x0, x1 in ((0.10, 1.04), (-1.04, -0.10)):
            P = extrude_x([(yy + y, z) for yy, z in seat], x0, x1)
            S.add(P, S_SEAT, chart="sw", tag="body")
    S.add(extrude_x([(yy + 2.35, z) for yy, z in seat], -0.95, -0.30), S_SEAT, chart="sw", tag="body")
    S.add(rbox((0, 3.02, 1.17), (2.0, 0.34, 0.38), r=0.08), S_INT, chart="sw", tag="body")
    S.add(revolve([(-0.012, 0.0), (-0.012, 0.20), (0.012, 0.20), (0.012, 0.0)], 14, axis="y") @ rot_x(-0.9).T + np.array([-0.58, 2.62, 1.48], np.float32), S_BLACK, chart="sw", tag="body")
    P = np.concatenate(S.P)
    surf = np.array(S.surf)
    tag = np.array(S.tag)
    # ---- variant: sag + lean -------------------------------------------------------------------
    if old:
        body = (tag == "body") | (tag == "rim") | (tag == "rimflat")
        sag = np.zeros(len(P), bool)
        for i in range(0, 1): pass
    return S, glass


def finalize_variant(S, glass, old):
    """Apply sag/lean to body+glass (old bus); returns arrays."""
    P, surf, chart, lc, grp = S.arrays()
    tag = np.array(S.tag)
    glass = [g.copy() for g in glass]
    if old:
        sagz, lean = 0.032, 0.006
        movable = (tag == "body") | (tag == "rim") | (tag == "rimflat")
        def xf(Q):
            Q = Q.copy()
            Q[..., 2] -= sagz + lean * Q[..., 0] * 0.0 - 0.0
            Q[..., 2] += lean * (Q[..., 0]) * -1.0 * (Q[..., 1] * 0 + 1)    # roll about the length axis
            return Q
        # sag grows towards the rear-right flat tyre
        def sagf(Q):
            Q = Q.copy()
            Q[..., 2] -= 0.018 + 0.016 * np.clip((Q[..., 0] * 0.5 + 0.5) * (0.5 - Q[..., 1] / 11), 0, 1.2) + lean * Q[..., 0]
            return Q
        keep = ~movable
        P[movable] = sagf(P[movable])
        glass = [sagf(g) for g in glass]
    return P, surf, chart, lc, grp, glass


# =============================================================================================
# atlas engine: charts -> packing -> rasterise texel attributes -> paint
# =============================================================================================
def assign_charts(P, surf, chart, lc):
    """Resolve 'auto' charts from the face normal; 'sw' (swatch) -> ('sw', surf). Returns chart keys (object array) + lc."""
    n, _ = tri_normals(P)
    c = P.mean(1)
    keys = chart.copy()
    lc = lc.copy()
    surf = surf.copy()
    ax = np.argmax(np.abs(n), 1)
    for i in range(len(P)):
        if chart[i] == "auto" and surf[i] in (S_PAINT, S_BLACK, S_CHROME) and ((n[i, 1] < -0.3 and c[i, 1] > 2.5) or (n[i, 1] > 0.3 and c[i, 1] < -2.0)):
            keys[i] = "sw%d" % S_UNDER      # hidden back faces of the hood / bumpers: flat dark swatch
            surf[i] = S_UNDER
            continue
        if chart[i] == "auto":
            a = ax[i]
            if a == 0:
                k = "R" if n[i, 0] > 0 else "L"
                uv = P[i][:, [1, 2]]
            elif a == 1:
                k = "FRONT" if n[i, 1] > 0 else "REAR"
                uv = P[i][:, [0, 2]]
            else:
                k = "TOP" if n[i, 2] > 0 else "BOT"
                uv = P[i][:, [1, 0]]
            keys[i] = k
            lc[i] = uv
        elif chart[i] == "sw":
            keys[i] = "sw%d" % surf[i]
    return keys, lc, surf


def pack_charts(keys, lc, size, dens_mul=None, sw_px=10, pad=5):
    """Returns (rects dict key->(x0,y0,w_px,h_px,umin,vmin,D), D). Swatches occupy a reserved strip at the top."""
    dens_mul = dens_mul or {}
    uk = sorted(set(keys), key=str)
    sw = [k for k in uk if str(k).startswith("sw")]
    ch = [k for k in uk if k not in sw]
    bounds = {}
    for k in ch:
        m = keys == k
        a = lc[m].reshape(-1, 2)
        bounds[k] = (a[:, 0].min(), a[:, 1].min(), a[:, 0].max(), a[:, 1].max())
    strip = ((len(sw) * (sw_px + 2) + size - 1) // size) * (sw_px + 2) + 2
    rects = {}

    def try_pack(D):
        items = []
        for k in ch:
            u0, v0, u1, v1 = bounds[k]
            d = D * dens_mul.get(k, 1.0)
            items.append((k, int(math.ceil((u1 - u0) * d)) + 2 * pad, int(math.ceil((v1 - v0) * d)) + 2 * pad, d))
        items.sort(key=lambda t: -t[2])
        x = y = rowh = 0
        y = strip
        out = {}
        for k, w, h, d in items:
            if w > size:
                return None
            if x + w > size:
                x = 0
                y += rowh
                rowh = 0
            if y + h > size:
                return None
            out[k] = (x + pad, y + pad, w - 2 * pad, h - 2 * pad, bounds[k][0], bounds[k][1], d)
            x += w
            rowh = max(rowh, h)
        return out

    lo, hi = 5.0, 600.0
    for _ in range(18):
        mid = (lo + hi) / 2
        r = try_pack(mid)
        if r:
            lo, rects = mid, r
        else:
            hi = mid
    sx = sy = 0
    for i, k in enumerate(sw):
        per_row = size // (sw_px + 2)
        rects[k] = (1 + (i % per_row) * (sw_px + 2), 1 + (i // per_row) * (sw_px + 2), sw_px, sw_px, 0, 0, 1.0)
    return rects, lo


def chart_uv(keys, lc, rects, size):
    UV = np.zeros(lc.shape, np.float32)
    for k, (x0, y0, w, h, u0, v0, d) in rects.items():
        m = keys == k
        if str(k).startswith("sw"):
            UV[m] = ((x0 + w / 2) / size, (y0 + h / 2) / size)
        else:
            a = lc[m]
            UV[m, :, 0] = (x0 + (a[..., 0] - u0) * d) / size
            UV[m, :, 1] = (y0 + (a[..., 1] - v0) * d) / size
    return UV


def raster_attrs(UV, attrs, consts, size):
    """attrs (T,3,K) float, consts (T,C) float -> arrays (size,size,K), (size,size,C), coverage."""
    K, C = attrs.shape[2], consts.shape[1]
    Wd, Hd = size if isinstance(size, tuple) else (size, size)
    out = np.zeros((Hd, Wd, K), np.float32)
    cst = np.zeros((Hd, Wd, C), np.float32)
    cov = np.zeros((Hd, Wd), bool)
    px = UV * np.array([Wd, Hd], np.float32)
    for t in range(len(UV)):
        p = px[t]
        x0, x1 = int(max(0, math.floor(p[:, 0].min() - 0.5))), int(min(Wd - 1, math.ceil(p[:, 0].max() + 0.5)))
        y0, y1 = int(max(0, math.floor(p[:, 1].min() - 0.5))), int(min(Hd - 1, math.ceil(p[:, 1].max() + 0.5)))
        if x1 < x0 or y1 < y0:
            continue
        den = (p[1, 1] - p[2, 1]) * (p[0, 0] - p[2, 0]) + (p[2, 0] - p[1, 0]) * (p[0, 1] - p[2, 1])
        if abs(den) < 1e-9:
            continue
        xs = np.arange(x0, x1 + 1) + 0.5
        ys = np.arange(y0, y1 + 1) + 0.5
        X, Y = np.meshgrid(xs, ys)
        l0 = ((p[1, 1] - p[2, 1]) * (X - p[2, 0]) + (p[2, 0] - p[1, 0]) * (Y - p[2, 1])) / den
        l1 = ((p[2, 1] - p[0, 1]) * (X - p[2, 0]) + (p[0, 0] - p[2, 0]) * (Y - p[2, 1])) / den
        l2 = 1 - l0 - l1
        e = -0.03
        m = (l0 >= e) & (l1 >= e) & (l2 >= e)
        if not m.any():
            continue
        yy, xx = np.nonzero(m)
        w = np.stack([l0[m], l1[m], l2[m]], 1)
        out[yy + y0, xx + x0] = w @ attrs[t]
        cst[yy + y0, xx + x0] = consts[t]
        cov[yy + y0, xx + x0] = True
    return out, cst, cov


def dilate(arrs, cov, iters=6):
    cov = cov.copy()
    arrs = [a.copy() for a in arrs]
    for _ in range(iters):
        new = cov.copy()
        acc = [np.zeros_like(a) for a in arrs]
        cnt = np.zeros(cov.shape, np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            sh = np.roll(np.roll(cov, dy, 0), dx, 1)
            take = sh & ~cov
            for a, ac in zip(arrs, acc):
                ac[take] += np.roll(np.roll(a, dy, 0), dx, 1)[take]
            cnt[take] += 1
        got = cnt > 0
        for a, ac in zip(arrs, acc):
            a[got] = ac[got] / cnt[got][..., None] if a.ndim == 3 else ac[got] / cnt[got]
        new |= got
        cov = new
    return arrs


def vertex_ao(P, N, extra_tris=None, rays=12, dist=0.9, seed=3):
    """Per triangle-corner ambient occlusion by BVH ray casting (ground plane included)."""
    allP = P if extra_tris is None else np.concatenate([P, extra_tris])
    V = allP.reshape(-1, 3)
    F = np.arange(len(V)).reshape(-1, 3)
    bvh = BVHTree.FromPolygons([tuple(v) for v in V.tolist()], [tuple(f) for f in F.tolist()], all_triangles=True)
    key = np.round(np.concatenate([P.reshape(-1, 3), N.reshape(-1, 3)], 1) * np.array([300, 300, 300, 10, 10, 10])).astype(np.int64)
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    rng = np.random.default_rng(seed)
    # fixed cosine-ish hemisphere samples
    u = (np.arange(rays) + 0.5) / rays
    phi = np.arange(rays) * 2.399963
    r = np.sqrt(u)
    dirs = np.stack([r * np.cos(phi), r * np.sin(phi), np.sqrt(1 - u)], 1)
    ao = np.ones(len(first), np.float32)
    pts = P.reshape(-1, 3)[first]
    nrm = N.reshape(-1, 3)[first]
    for i in range(len(first)):
        n = nrm[i]
        a = np.array([1, 0, 0]) if abs(n[0]) < 0.9 else np.array([0, 1, 0])
        t = np.cross(n, a); t /= max(np.linalg.norm(t), 1e-6)
        b = np.cross(n, t)
        o = Vector(pts[i] + n * 0.012)
        hit = 0.0
        for d in dirs:
            dv = d[0] * t + d[1] * b + d[2] * n
            res = bvh.ray_cast(o, Vector(dv), dist)
            if res[0] is not None:
                hit += 1.0 - res[3] / dist * 0.5
        ao[i] = 1.0 - hit / rays
    return ao[inv.reshape(-1)].reshape(len(P), 3)


# ---- stencil lettering -------------------------------------------------------------------------
FONT = {
    "A": [[(0, 0), (.35, 1), (.7, 0)], [(.12, .4), (.58, .4)]],
    "C": [[(.7, .85), (.5, 1), (.2, 1), (0, .8), (0, .2), (.2, 0), (.5, 0), (.7, .15)]],
    "D": [[(0, 0), (0, 1), (.4, 1), (.65, .8), (.65, .2), (.4, 0), (0, 0)]],
    "E": [[(.65, 1), (0, 1), (0, 0), (.65, 0)], [(0, .5), (.5, .5)]],
    "R": [[(0, 0), (0, 1), (.45, 1), (.65, .85), (.65, .65), (.45, .5), (0, .5)], [(.35, .5), (.68, 0)]],
    "V": [[(0, 1), (.35, 0), (.7, 1)]],
    "L": [[(0, 1), (0, 0), (.6, 0)]],
    "Y": [[(0, 1), (.35, .5), (.7, 1)], [(.35, .5), (.35, 0)]],
    "S": [[(.65, .85), (.45, 1), (.2, 1), (0, .85), (0, .65), (.2, .5), (.45, .5), (.65, .35), (.65, .15), (.45, 0), (.2, 0), (0, .15)]],
    "H": [[(0, 0), (0, 1)], [(.65, 0), (.65, 1)], [(0, .5), (.65, .5)]],
    "O": [[(.2, 0), (0, .2), (0, .8), (.2, 1), (.45, 1), (.65, .8), (.65, .2), (.45, 0), (.2, 0)]],
    "U": [[(0, 1), (0, .2), (.2, 0), (.45, 0), (.65, .2), (.65, 1)]],
    "B": [[(0, 0), (0, 1), (.45, 1), (.6, .85), (.6, .62), (.45, .5), (0, .5)], [(.45, .5), (.65, .35), (.65, .15), (.5, 0), (0, 0)]],
    "T": [[(0, 1), (.7, 1)], [(.35, 1), (.35, 0)]],
    "P": [[(0, 0), (0, 1), (.45, 1), (.65, .85), (.65, .65), (.45, .5), (0, .5)]],
    "4": [[(.5, 0), (.5, 1), (0, .3), (.7, .3)]],
    "2": [[(0, .85), (.2, 1), (.5, 1), (.65, .8), (0, 0), (.65, 0)]],
    "1": [[(.15, .8), (.35, 1), (.35, 0)]],
    "7": [[(0, 1), (.65, 1), (.25, 0)]],
}


def text_segments(text, a0, b0, h, pitch, dirn=1.0, width_ratio=0.7):
    """Segments (a0,b0,a1,b1) of the stencil text; a runs along `dirn`, b is height. Text is centred on a0."""
    segs = []
    total = (len(text) - 1) * pitch + width_ratio * h
    start = a0 - dirn * total / 2
    for i, ch in enumerate(text):
        if ch == " ":
            continue
        ox = start + dirn * i * pitch
        for poly in FONT[ch]:
            for (x0, y0), (x1, y1) in zip(poly[:-1], poly[1:]):
                segs.append((ox + dirn * x0 * h, b0 + y0 * h, ox + dirn * x1 * h, b0 + y1 * h))
    return np.array(segs, np.float32)


def stroke_cov(a, b, segs, w):
    """Distance based coverage for points (a,b) (1-D arrays) against segments, stroke half width w."""
    d = np.full(len(a), 1e9, np.float32)
    for s in segs:
        ex, ey = s[2] - s[0], s[3] - s[1]
        l2 = ex * ex + ey * ey + 1e-9
        t = np.clip(((a - s[0]) * ex + (b - s[1]) * ey) / l2, 0, 1)
        dd = np.hypot(a - (s[0] + t * ex), b - (s[1] + t * ey))
        d = np.minimum(d, dd)
    return smooth(w * 1.15, w * 0.8, d)


SW_COLS = {S_INT: ("#8A826C", 0.8, 0.0), S_UNDER: ("#0B0B0C", 0.9, 0.0), S_SEAT: ("#2F3B26", 0.7, 0.0), S_RIM: ("#8A8D92", 0.38, 0.8),
           S_LENS: ("#E4EAF0", 0.08, 0.0), S_RED: ("#8E0A0A", 0.12, 0.0), S_AMBER: ("#E58C0A", 0.12, 0.0), S_WHITE: ("#D0D0CC", 0.5, 0.0),
           S_BLACK: ("#111113", 0.6, 0.0), S_CHROME: ("#B4B7BC", 0.2, 1.0), S_PAINT: ("#F0B000", 0.4, 0.0)}


def paint_bus(wear, seed, A, Nn, SURF, CH, LC, AO, PX, size, rects, keys_list):
    """A: positions (n,3), Nn normals, returns albedo(n,3 lin), rough, metal, ao, height (n)."""
    n = len(A)
    x, y, z = A[:, 0], A[:, 1], A[:, 2]
    ax = np.abs(x)
    fb = lambda f, o=3, s=0: fbm3(A, f, o, seed + s)
    rng = np.random.default_rng(seed)
    alb = np.zeros((n, 3), np.float32)
    rough = np.full(n, 0.5, np.float32)
    metal = np.zeros(n, np.float32)
    h = np.zeros(n, np.float32)
    side = np.abs(Nn[:, 0]) > 0.6
    up = np.clip(Nn[:, 2], 0, 1)
    is_p = (SURF == S_PAINT) | (SURF == S_DOOR)
    # ---------------- yellow paint with weathering
    yel = hexc("#F4B300")
    pale = hexc("#D9B24A")
    base = np.tile(yel, (n, 1))
    blotch = fb(1.1, 3, 1)
    fade = np.clip((0.45 * up + 0.25 * smooth(2.0, 3.1, z)) * (0.55 + 0.9 * blotch) * wear * 1.5, 0, 0.75)
    base = mix(base, pale, fade)
    base *= (0.93 + 0.14 * fb(9.0, 2, 2))[:, None]
    # wheel splash + road grime
    g_h = 1 - smooth(0.62, 1.50, z)
    splash = np.zeros(n, np.float32)
    for wy in (FWY, RWY):
        splash = np.maximum(splash, (1 - smooth(0.4, 1.7, np.abs(y - wy))) * (1 - smooth(0.7, 1.9, z)))
    grime_a = np.clip((g_h * 0.75 + splash * 0.6) * (0.55 + 0.9 * fb(3.5, 3, 3)) * (0.45 + 0.9 * wear), 0, 0.92)
    grime_c = np.array([0.075, 0.055, 0.040], np.float32)
    # dirt streaks: stretched vertically, strongest below sills / roof gutter
    st = noise3(A * np.array([22.0, 22.0, 1.0], np.float32), 1.0, seed + 5) * 0.65 + noise3(A * np.array([9.0, 9.0, 0.6], np.float32), 1.0, seed + 6) * 0.35
    streak = smooth(0.52, 0.80, st) * (smooth(1.05, 1.6, z) * (1 - smooth(1.6, 2.4, z)) * 0.7 + smooth(2.45, 2.7, z) * 0.55) * side
    streak_a = streak * (0.25 + 0.7 * wear)
    # rust: flakes near the lower edge, wheel arches, rail edges
    rn = fb(6.5, 3, 7)
    rust_zone = (1 - smooth(0.7, 1.5, z)) * (0.5 + 0.5 * splash) + 0.10 * smooth(2.5, 2.8, z) * side
    rust = smooth(0.62, 0.74, rn) * np.clip(rust_zone, 0, 1) * np.clip(wear * 1.6, 0, 1)
    rust_c = np.where((fb(14.0, 2, 8) > 0.5)[:, None], np.array([0.30, 0.11, 0.035], np.float32), np.array([0.18, 0.07, 0.03], np.float32))
    col = mix(base, np.tile(grime_c, (n, 1)), grime_a)
    col = mix(col, col * 0.45 + np.array([0.04, 0.03, 0.02], np.float32), streak_a)
    col = mix(col, rust_c, rust)
    # ---------------- black trim
    blk = np.tile(hexc("#101012"), (n, 1))
    bl_fade = np.clip((0.35 * up + 0.2) * wear * (0.5 + blotch), 0, 0.6)
    blk = mix(blk, hexc("#3a3836")[None, :] * np.ones((n, 1), np.float32), bl_fade)
    blk = mix(blk, np.tile(grime_c * 1.5, (n, 1)), grime_a * 0.8)
    alb[:] = col
    isb = SURF == S_BLACK
    alb[isb] = blk[isb]
    # ---------------- chrome
    isc = SURF == S_CHROME
    cc = np.tile(hexc("#C9CBCF"), (n, 1)) * (0.8 + 0.3 * fb(25, 2, 11))[:, None]
    cc = mix(cc, np.tile(grime_c * 2.5, (n, 1)), np.clip(grime_a * 0.7 + 0.2 * wear * fb(8, 2, 12), 0, 0.8))
    alb[isc] = cc[isc]
    # grille slats
    gr = isc & (y > 5.12) & (ax < 0.66) & (z > 0.78) & (z < 1.58)
    slat = (np.sin(z * 2 * math.pi / 0.052) > 0.15)
    alb[gr & slat] = np.array([0.012, 0.012, 0.014], np.float32)
    # ---------------- door fill
    dr = SURF == S_DOOR
    low = dr & (z < 1.48)
    alb[dr & ~low] = np.array([0.012, 0.014, 0.016], np.float32)
    # ---------------- rear door + window frames (rear face) + panel lines
    rear = (Nn[:, 1] < -0.6) & (y < -5.2)
    rgasket = rear & is_p & (z > 1.50) & (z < 2.47) & (
        ((ax > 0.35) & (ax < 0.41)) | ((ax > 0.43) & (ax < 0.49)) |
        ((ax > 0.81) & (ax < 0.87)) |
        (np.abs(z - 1.55) < 0.025) | (np.abs(z - 2.42) < 0.025)
    )
    alb[rgasket] = np.array([0.015, 0.015, 0.018], np.float32)
    rough[rgasket] = 0.85
    front = (Nn[:, 1] > 0.6) & (y > 2.9) & (y < 3.6)
    # SCHOOL BUS header sign (front & rear)
    for ysd, fr in ((1, front), (-1, rear)):
        sign = fr & (ax < 0.5) & (z > 2.62) & (z < 2.78) & is_p
        alb[sign] = np.array([0.01, 0.01, 0.012], np.float32)
        segs = text_segments("SCHOOL BUS", 0.0, 2.65, 0.10, 0.0865, dirn=-ysd, width_ratio=0.65)
        sel = np.nonzero(sign)[0]
        cv = stroke_cov(x[sel], z[sel], segs, 0.0085)
        alb[sel] = mix(alb[sel], np.tile(hexc("#F2B300"), (len(sel), 1)), cv)
    # ---------------- lettering on sides (stencil, faded)
    for sd in (1, -1):
        sel = np.nonzero(is_p & (Nn[:, 0] * sd > 0.6) & (z > 2.5) & (z < 2.8) & (ax > 1.1))[0]
        if len(sel):
            segs = text_segments("CEDAR VALLEY SCHOOLS", -1.25, 2.575, 0.17, 0.287, dirn=float(sd), width_ratio=0.65)
            cv = stroke_cov(y[sel], z[sel], segs, 0.0135)
            fade_l = 1 - np.clip(0.25 + 0.55 * wear * fb(20, 2, 31)[sel], 0, 0.85)
            col_t = mix(alb[sel], np.tile(hexc("#121214"), (len(sel), 1)), cv * fade_l)
            alb[sel] = col_t
        # bus number on the side, low in the rear quarter
        num = "42" if sd > 0 else "17"
        sel2 = np.nonzero(is_p & (Nn[:, 0] * sd > 0.6) & (z > 0.98) & (z < 1.22) & (ax > 1.1) & (y < -3.4) & (y > -5.3))[0]
        if len(sel2):
            segs = text_segments(num, -4.35, 1.0, 0.2, 0.19, dirn=float(sd), width_ratio=0.65)
            cv = stroke_cov(y[sel2], z[sel2], segs, 0.014)
            alb[sel2] = mix(alb[sel2], np.tile(hexc("#121214"), (len(sel2), 1)), cv * 0.85)
    # ---------------- stop arm
    sa = SURF == S_STOP
    sa_c = np.tile(hexc("#B3100E"), (n, 1))
    dyz = np.hypot(y - 1.45, z - 1.22)
    ring = (dyz > 0.225)
    sa_c[ring] = hexc("#E8E8E4")
    sel = np.nonzero(sa & ~ring)[0]
    if len(sel):
        segs = text_segments("STOP", -1.45, 1.22 - 0.055, 0.11, 0.095, dirn=-1.0, width_ratio=0.65)
        cv = stroke_cov(y[sel], z[sel], segs, 0.0085)
        sa_c[sel] = mix(sa_c[sel], np.tile(hexc("#F0F0EC"), (len(sel), 1)), cv)
    alb[sa] = sa_c[sa]
    # ---------------- tyres
    ty = SURF == S_TYRE
    u, v = LC[:, 0], LC[:, 1]
    tyre_c = np.tile(np.array([0.020, 0.020, 0.021], np.float32), (n, 1))
    dust = np.clip((0.35 + 0.55 * wear) * (0.4 + 0.8 * noise3(np.stack([u * 6, v * 6, u * 0], 1), 1.0, seed + 41)), 0, 0.9)
    tyre_c = mix(tyre_c, np.tile(np.array([0.11, 0.095, 0.08], np.float32), (n, 1)), dust * 0.55)
    alb[ty] = tyre_c[ty]
    th_t = (v > 0.25) & (v < 0.62)         # tread band on the profile arclength
    blocks = np.sin(u * 2 * math.pi / (2 * math.pi * TR / 40.0)) > 0.35
    rib = np.abs(np.sin((v - 0.435) * 2 * math.pi / 0.17)) < 0.18
    groove = (th_t & (blocks | (np.abs(v - 0.435) < 0.012)))
    h[ty & groove] -= 3.0
    h[ty & ~th_t] += 0.6 * np.sin(v[ty & ~th_t] * 90)
    alb[ty & groove] *= 0.55
    # ---------------- generic wear over everything
    # dust film on upward faces (all non-glass)
    dust_a = np.clip(up * (0.12 + 0.5 * wear) * (0.4 + 0.9 * fb(4.0, 3, 51)), 0, 0.6)
    dcol = np.array([0.20, 0.17, 0.12], np.float32)
    nonsw = ~np.isin(SURF, SWATCH_SURFS)
    alb[nonsw] = mix(alb[nonsw], np.tile(dcol, (nonsw.sum(), 1)) * 0.6 + alb[nonsw] * 0.4 * 0, dust_a[nonsw] * 0.55)
    # ---------------- roughness / metal
    rough[:] = 0.36
    rough[is_p] = 0.34 + 0.45 * fade[is_p] + 0.35 * grime_a[is_p] + 0.2 * streak_a[is_p]
    rough[isb] = 0.55 + 0.25 * bl_fade[isb] + 0.3 * grime_a[isb]
    rough[isc] = 0.16 + 0.35 * grime_a[isc]
    metal[isc] = 0.92 - 0.5 * grime_a[isc]
    rough[ty] = 0.86
    rough[dr] = 0.5
    rough[sa] = 0.42
    rough[rust > 0.3] = 0.82
    metal[rust > 0.3] = 0.1
    # ---------------- height field (rivets, seams, paint texture)
    h += 0.35 * (fb(80.0, 2, 61) - 0.5)
    seam_ys = [1.86 - BAY_P * k for k in range(9)] + [1.86 - BAY_P * k - BAY_W for k in range(8)] + [DOOR[0], DOOR[1], DRIVER[0]]
    sdm = side & is_p
    for sy in seam_ys:
        d = np.abs(y - sy)
        h[sdm & (z < SILL) & (d < 0.007)] -= 2.2
        pat = np.abs(((z - 0.05) % 0.035) - 0.0175)
        riv = sdm & (d < 0.032) & (d > 0.014) & (pat < 0.0065) & (np.abs(((y - sy) * 1 + 0.0)) > 0.0)
    for sy in seam_ys:
        d = np.abs(y - sy)
        for off in (-0.025, 0.025):
            riv = sdm & (z < 2.78) & (np.abs(y - sy - off) < 0.0055) & (np.abs(((z + 0.02) % 0.04) - 0.02) < 0.0065)
            h[riv] += 2.4
            alb[riv] *= 0.78
    for zr_ in (0.97, 1.27, SILL - 0.045, 2.53):
        for off in (-0.05, 0.05):
            riv = sdm & (np.abs(z - zr_ - off) < 0.0055) & (np.abs(((y + 0.02) % 0.04) - 0.02) < 0.0065)
            h[riv] += 2.4
            alb[riv] *= 0.78
    # rear door outline & hood centre seam
    rd = rear & ((np.abs(ax - 0.62) < 0.006) & (z > 0.75) & (z < 2.62) | (np.abs(x) < 0.005) & (z > 0.75) & (z < 2.62))
    h[rd] -= 2.5
    hs = (SURF == S_BLACK) & (Nn[:, 2] > 0.5) & (np.abs(x) < 0.006) & (y > 3.2)
    h[hs] -= 1.5
    # ---------------- ambient occlusion + contact darkness
    ao = AO.copy()
    ao *= 0.88 + 0.12 * smooth(0.5, 1.4, z)
    ao[rust > 0.3] *= 0.8
    # swatches / interior: flat colours
    sw_cols = SW_COLS
    _unused = {S_INT: ("#8A826C", 0.8, 0.0), S_UNDER: ("#0B0B0C", 0.9, 0.0), S_SEAT: ("#2F3B26", 0.7, 0.0), S_RIM: ("#8A8D92", 0.38, 0.8),
               S_LENS: ("#E4EAF0", 0.08, 0.0), S_RED: ("#8E0A0A", 0.12, 0.0), S_AMBER: ("#E58C0A", 0.12, 0.0), S_WHITE: ("#D0D0CC", 0.5, 0.0)}
    for sid in SWATCH_SURFS:
        hx, r_, m_ = sw_cols[sid]
        m = SURF == sid
        alb[m] = hexc(hx)
        rough[m] = r_
        metal[m] = m_
    m = (SURF == S_RIM)
    alb[m] = mix(alb[m], np.tile(grime_c * 2, (m.sum(), 1)), np.clip(0.25 + 0.5 * wear * fb(9, 2, 71)[m], 0, 0.8)[:, None] if False else np.clip(0.25 + 0.5 * wear * fb(9, 2, 71)[m], 0, 0.8))
    return alb, rough, metal, ao, h


def finish_maps(cov, alb, rough, metal, ao, hgt, size, nstrength=0.55, rects=None, swcols=None):
    """Scatter painted 1-D texel data into images, dilate, return (albedo_srgb, normal, orm) float images."""
    idx = np.nonzero(cov)
    A = np.zeros(cov.shape + (3,), np.float32)
    O = np.zeros(cov.shape + (3,), np.float32)
    Hh = np.zeros(cov.shape, np.float32)
    A[idx] = alb
    O[idx] = np.stack([ao, rough, metal], 1)
    Hh[idx] = hgt
    A, O, Hh = dilate([A, O, Hh], cov, 8)
    for k, (x0, y0, w, h, *_r) in (rects or {}).items():
        if str(k).startswith("sw"):
            hx, r_, m_ = swcols[int(str(k)[2:])]
            A[y0:y0 + h, x0:x0 + w] = hexc(hx)
            O[y0:y0 + h, x0:x0 + w] = (1.0, r_, m_)
            Hh[y0:y0 + h, x0:x0 + w] = 0
    Nrm = height_to_normal(Hh * 0.012, nstrength * 40)
    return l2s(A), Nrm.astype(np.float32), O


def bake_bus_variant(old, keys, lc, surf_in, rects, seed, wear):
    S, glass = build_bus_geometry(old)
    P, surf, chart, lc_ign, grp, glass = finalize_variant(S, glass, old)
    surf = surf_in
    log("bus", "old" if old else "clean", "tris", len(P), "glass quads", len(glass))
    N = smooth_normals(P, 38.0)
    ground = np.array([[(-30, -30, 0), (30, -30, 0), (30, 30, 0)], [(-30, -30, 0), (30, 30, 0), (-30, 30, 0)]], np.float32)
    ao = vertex_ao(P, N, ground, rays=10, dist=0.9, seed=seed)
    log("  ao done")
    UV = chart_uv(keys, lc, rects, ATLAS)
    fn, _ = tri_normals(P)
    attrs = np.concatenate([P, N, ao[..., None], lc], 2)
    raster_attrs_out, cst, cov = raster_attrs(UV, attrs.astype(np.float32), surf[:, None].astype(np.float32), ATLAS)
    log("  raster done, coverage %.1f%%" % (cov.mean() * 100))
    idx = np.nonzero(cov)
    r = raster_attrs_out[idx]
    A_, N_, AO_, LC_ = r[:, 0:3], r[:, 3:6], r[:, 6], r[:, 7:9]
    N_ /= np.maximum(np.linalg.norm(N_, axis=1, keepdims=True), 1e-6)
    SURF = cst[idx][:, 0].astype(np.int16)
    PX = np.stack(idx[::-1], 1)
    alb, rough, metal, ao_t, hgt = paint_bus(wear, seed, A_, N_, SURF, None, LC_, AO_, PX, ATLAS, rects, None)
    log("  paint done")
    albedo, normal, orm = finish_maps(cov, alb, rough, metal, ao_t, hgt, ATLAS, rects=rects, swcols=SW_COLS)
    return dict(P=P, N=N, UV=UV, surf=surf, glass=glass, albedo=albedo, normal=normal, orm=orm)


def bake_bus():
    S, g = build_bus_geometry(False)
    P, surf, chart, lc, grp = S.arrays()
    keys, lc, surf = assign_charts(P, surf, chart, lc)
    rects, D = pack_charts(keys, lc, ATLAS, {"tyre": 0.55, "BOT": 0.1})
    log("atlas packed, density %.1f px/m, charts %d" % (D, len(rects)))
    a = bake_bus_variant(False, keys, lc, surf, rects, 11, 0.38)
    b = bake_bus_variant(True, keys, lc, surf, rects, 29, 0.95)
    return a, b, rects


def quads_to_tris(glass):
    out = []
    for q in glass:
        q = np.asarray(q, np.float32)
        out += [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]
    return np.array(out, np.float32)


def add_tex_material(g, name, A, N, O, rough=1.0, alpha=None, q=(80, 80, 80), nimg=None):
    tex = {}
    tex["a"] = g.image(encode_image(A, "JPEG", q[0], name + "_a"), "image/jpeg")
    if N is not None:
        tex["n"] = g.image(encode_image(N, "JPEG", q[1], name + "_n"), "image/jpeg") if not isinstance(N, int) else N
    tex["o"] = g.image(encode_image(O, "JPEG", q[2], name + "_o"), "image/jpeg")
    m = {"pbrMetallicRoughness": {"baseColorTexture": {"index": tex["a"]}, "metallicRoughnessTexture": {"index": tex["o"]}, "metallicFactor": 1.0, "roughnessFactor": 1.0},
         "occlusionTexture": {"index": tex["o"]}}
    if "n" in tex:
        m["normalTexture"] = {"index": tex["n"]}
    return g.material(name, **m), tex


def mesh_from_tris(g, name, P, N, UV, mat, extras=None):
    pos, nor, uv, idx, _ = tris_to_buffers(to_gltf(P), to_gltf(N), UV)
    # flip winding: y->-z mapping is a rotation (det +1), so winding is preserved
    return g.mesh(name, pos.astype(np.float32), nor, uv, idx, mat, extras=extras), len(idx)


def export_buses(g, a, b):
    """Adds both buses to glb g. Returns node indices + stats."""
    ma, ta = add_tex_material(g, "bus_clean", a["albedo"], a["normal"], a["orm"], q=(82, 88, 80))
    mb, tb = add_tex_material(g, "bus_old", b["albedo"], tb_n := ta["n"], b["orm"], q=(82, 88, 80))
    mg = g.material("bus_glass", pbrMetallicRoughness={"baseColorFactor": [0.035, 0.055, 0.065, 0.55], "metallicFactor": 0.0, "roughnessFactor": 0.05},
                    alphaMode="BLEND", doubleSided=True, extras={"glass": True})
    nodes, stats = [], {}
    for nm, v, mat in (("bus_clean", a, ma), ("bus_old", b, mb)):
        body = ~(v["surf"] == S_GLASS)
        P, N, UV = v["P"], v["N"], v["UV"]
        i1, n1 = mesh_from_tris(g, nm + "_body", P, N, UV, mat, extras={"castShadow": True})
        GP = quads_to_tris(v["glass"])
        GN = np.tile(tri_normals(GP)[0][:, None, :], (1, 3, 1)).astype(np.float32)
        i2, n2 = mesh_from_tris(g, nm + "_glass", GP, GN, np.zeros((len(GP), 3, 2), np.float32), mg, extras={"glass": True, "castShadow": False})
        c1 = g.node(nm + "_body", mesh=i1)
        c2 = g.node(nm + "_glass", mesh=i2)
        nodes.append(g.node(nm, children=[c1, c2]))
        stats[nm] = {"tris": int(len(P) + len(GP)), "body": int(len(P)), "glass": int(len(GP))}
    return nodes, stats


# =============================================================================================
# KOI POND set (authored directly in glTF space: x east, y up, z south; origin = pond centre at ground level)
# =============================================================================================
POND_DEPTH = 1.52


def pond_r(th):      # identical to src/world/pond_shape.js pondRadius()
    return 3.9 + 0.58 * math.sin(2 * th + 0.5) + 0.35 * math.cos(3 * th - 0.7) + 0.22 * math.sin(5 * th + 1.1) + 0.15 * math.cos(7 * th)


def pond_drop(x, z):
    d = math.hypot(x, z)
    r = pond_r(math.atan2(x, z))
    return min(1.0, (1 - d / r) * 2) * POND_DEPTH if d < r else 0.0


def sphere_grid(nlat, nlon):
    """(nlat+1) x (nlon+1) unit-sphere grid. Returns dirs (nlat+1, nlon+1, 3), and tri index list on the grid."""
    la = np.linspace(0, math.pi, nlat + 1)
    lo = np.linspace(0, 2 * math.pi, nlon + 1)
    LA, LO = np.meshgrid(la, lo, indexing="ij")
    D = np.stack([np.sin(LA) * np.cos(LO), np.cos(LA), np.sin(LA) * np.sin(LO)], -1)
    tris = []
    for i in range(nlat):
        for j in range(nlon):
            a, b, c, d = (i, j), (i, j + 1), (i + 1, j + 1), (i + 1, j)
            if i > 0:
                tris.append((a, d, b))
            if i < nlat - 1:
                tris.append((b, d, c))
    return D, tris


def make_rock(rng, R, squash, seed, nlat=10, nlon=18):
    D, tris = sphere_grid(nlat, nlon)
    flat = D.reshape(-1, 3)
    big = fbm3(flat * 1.6 + seed * 3.1, 1.0, 3, seed) - 0.5
    sm = noise3(flat * 4.0 + seed, 1.0, seed + 5) - 0.5
    rad = R * (1 + 0.35 * big + 0.08 * sm)
    # rounded underside, organic chunky boulder form
    yy = flat[:, 1]
    P = flat * rad[:, None]
    P[:, 1] = np.where(P[:, 1] < 0, P[:, 1] * 0.75, P[:, 1])
    P *= np.array(squash, np.float32)
    P = P.reshape(nlat + 1, nlon + 1, 3)
    out = np.array([[P[a], P[b], P[c]] for t in tris for (a, b, c) in [t]], np.float32)
    uv = np.array([[(a[1] / nlon, a[0] / nlat), (b[1] / nlon, b[0] / nlat), (c[1] / nlon, c[0] / nlat)] for (a, b, c) in tris], np.float32)
    return out, uv


def rot_yaw(P, a):
    c, s = math.cos(a), math.sin(a)
    R = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], np.float32)
    return P @ R.T


def build_coping(rng):
    rocks, uvs, info = [], [], []
    N_R = 36
    for i in range(N_R):
        th = (i / N_R) * math.pi * 2 + math.sin(i * 3.7) * 0.06
        r = pond_r(th) + 0.12 + 0.12 * math.sin(i * 5.3) + rng.uniform(-0.05, 0.05)
        R = rng.uniform(0.38, 0.58)
        sq = (rng.uniform(0.95, 1.25), rng.uniform(0.90, 1.25), rng.uniform(0.95, 1.25))
        P, uv = make_rock(rng, R, sq, 100 + i, nlat=10, nlon=18)
        # Scale and position to ensure rounded chunky boulders 0.3 - 0.6 m tall
        y_top = float(P[..., 1].max())
        target_h = rng.uniform(0.35, 0.64)
        P[..., 1] *= (target_h / max(0.1, y_top))
        sink = rng.uniform(0.04, 0.06)
        P[..., 1] -= sink
        P = rot_yaw(P, th + math.pi / 2 + rng.uniform(-0.3, 0.3))
        P += np.array([math.sin(th) * r, 0.0, math.cos(th) * r], np.float32)
        rocks.append(P); uvs.append(uv)
        info.append([round(math.sin(th) * r, 3), round(math.cos(th) * r, 3), round(R, 3), round(float(P[..., 1].max()), 3)])
    return rocks, uvs, info


def build_sub_rocks(rng):
    rocks, uvs = [], []
    for i in range(14):
        th = rng.uniform(0, 2 * math.pi)
        f = rng.uniform(0.15, 0.82)
        r = pond_r(th) * f
        x, z = math.sin(th) * r, math.cos(th) * r
        yb = -pond_drop(x, z) + 0.01
        R = rng.uniform(0.09, 0.26)
        P, uv = make_rock(rng, R, (rng.uniform(1, 1.5), rng.uniform(0.5, 0.8), rng.uniform(1, 1.4)), 300 + i, 7, 12)
        P = rot_yaw(P, rng.uniform(0, 6.28)) + np.array([x, yb + R * 0.15, z], np.float32)
        rocks.append(P); uvs.append(uv)
    return rocks, uvs


def build_floor(rng):
    """Basin floor following the physics profile; rings from the middle to a skirt just beyond the rim."""
    SEG = 48
    fr = [0.0, 0.18, 0.36, 0.5, 0.6, 0.7, 0.8, 0.9, 0.97, 1.0, 1.12]
    V = []
    for k, f in enumerate(fr):
        for i in range(SEG):
            th = i / SEG * 2 * math.pi
            r = pond_r(th) * f
            x, z = math.sin(th) * r, math.cos(th) * r
            y = -pond_drop(x, z) if f <= 1.0 else -0.03
            if f < 1.0:
                y += 0.03 + 0.03 * (fbm3(np.array([[x, 0, z]], np.float32), 1.3, 2, 9)[0])
            if f == 0.0:
                x = z = 0.0
            V.append((x, y, z))
    V = np.array(V, np.float32).reshape(len(fr), SEG, 3)
    tris = []
    for k in range(len(fr) - 1):
        for i in range(SEG):
            j = (i + 1) % SEG
            a, b, c, d = V[k, i], V[k, j], V[k + 1, j], V[k + 1, i]
            if k == 0:
                tris.append([a, d, c])
            else:
                tris += [[a, d, c], [a, c, b]]
    return np.array(tris, np.float32)


def leaf_pad(rng, R, notch=0.28, nring=3, nseg=22):
    """Lily pad: notched disc, slightly curled rim. Returns P (T,3,3), UV (T,3,2) in pad-local 0..1 (top-down)."""
    n0 = rng.uniform(0, 6.28)
    verts = [(0, 0.012, 0)]
    for r_i in range(1, nring + 1):
        rr = R * r_i / nring
        for s in range(nseg):
            a = notch / 2 + (2 * math.pi - notch) * s / (nseg - 1)
            curl = 0.035 * (r_i / nring) ** 3 + 0.006 * math.sin(a * 5 + n0) * r_i / nring
            verts.append((rr * math.cos(a), 0.012 + curl - 0.01 * (1 - r_i / nring), rr * math.sin(a)))
    verts = np.array(verts, np.float32)
    tris = []
    for s in range(nseg - 1):
        tris.append((0, 1 + s + 1, 1 + s))
    for r_i in range(1, nring):
        for s in range(nseg - 1):
            a = 1 + (r_i - 1) * nseg + s
            b = a + nseg
            tris += [(a, a + 1, b + 1), (a, b + 1, b)]
    P = verts[np.array(tris)]
    P = P[:, ::-1] if False else P
    # winding: want +y normals
    n, _ = tri_normals(P)
    P[n[:, 1] < 0] = P[n[:, 1] < 0][:, ::-1]
    UV = np.stack([P[..., 0] / R * 0.5 + 0.5, P[..., 2] / R * 0.5 + 0.5], -1).astype(np.float32)
    return P, UV


def petal(base, ang, length, width, tilt, curl=0.25):
    """A curved petal strip rooted at `base` pointing outwards at yaw `ang`. 3 segments."""
    pts = []
    for k in range(4):
        t = k / 3
        w = width * (math.sin(math.pi * (0.25 + 0.75 * t) ) * 0.9 + 0.1) * (1 - 0.3 * t * t)
        out_ = length * t * math.cos(tilt - curl * t)
        up_ = length * t * math.sin(tilt - curl * t * 1.4) * 1.0 + 0.0
        pts.append((out_, up_, w))
    P = []
    ca, sa = math.cos(ang), math.sin(ang)
    def tr(o, u, s):
        return (base[0] + ca * o - sa * s, base[1] + u, base[2] + sa * o + ca * s)
    for k in range(3):
        o0, u0, w0 = pts[k]; o1, u1, w1 = pts[k + 1]
        a, b, c, d = tr(o0, u0, -w0), tr(o0, u0, w0), tr(o1, u1, w1), tr(o1, u1, -w1)
        P += [[a, b, c], [a, c, d]]
    UV = []
    for k in range(3):
        v0, v1 = k / 3, (k + 1) / 3
        UV += [[(0, v0), (1, v0), (1, v1)], [(0, v0), (1, v1), (0, v1)]]
    return np.array(P, np.float32), np.array(UV, np.float32)


def blade(base, h, w, yaw, lean, rng, segs=5):
    """Curved reed / cattail-leaf ribbon rooted at base."""
    P, UV = [], []
    ca, sa = math.cos(yaw), math.sin(yaw)
    pts = []
    for k in range(segs + 1):
        t = k / segs
        wd = w * (1 - t * 0.85) * (1 - 0.3 * t) 
        o = lean * h * t * t
        pts.append((o, h * t, wd, t))
    def tr(o, y, s):
        return (base[0] + ca * o - sa * s, base[1] + y, base[2] + sa * o + ca * s)
    for k in range(segs):
        o0, y0, w0, t0 = pts[k]; o1, y1, w1, t1 = pts[k + 1]
        a, b, c, d = tr(o0, y0, -w0), tr(o0, y0, w0), tr(o1, y1, w1), tr(o1, y1, -w1)
        P += [[a, b, c], [a, c, d]]
        UV += [[(0, t0), (1, t0), (1, t1)], [(0, t0), (1, t1), (0, t1)]]
    return np.array(P, np.float32), np.array(UV, np.float32)


def tube(base, h, r, yaw, lean, nside=5, segs=3):
    ca, sa = math.cos(yaw), math.sin(yaw)
    rings = []
    for k in range(segs + 1):
        t = k / segs
        cx, cy = ca * lean * h * t * t, h * t
        cz = sa * lean * h * t * t
        ring = []
        for s in range(nside):
            a = s / nside * 2 * math.pi
            ring.append((base[0] + cx + r * math.cos(a), base[1] + cy, base[2] + cz + r * math.sin(a)))
        rings.append(ring)
    V, F = loft([np.array(r_, np.float32) for r_ in rings], True, False, True)
    P = orient_outward(tris_from_polys(V, F), np.array(base, np.float32) + np.array([0, h / 2, 0], np.float32))
    return P


def head_cyl(base, h0, h1, r, yaw, lean, hh):
    """Cattail seed head: a capsule-ish cylinder between heights h0..h1 on a leaning stem."""
    ca, sa = math.cos(yaw), math.sin(yaw)
    rings = []
    for t, rr in ((0, 0.0), (0.08, 0.7), (0.5, 1.0), (0.92, 0.7), (1.0, 0.0)):
        h = h0 + (h1 - h0) * t
        tt = h / hh
        cx, cz = ca * lean * hh * tt * tt, sa * lean * hh * tt * tt
        rings.append(np.array([(base[0] + cx + r * rr * math.cos(a), base[1] + h, base[2] + cz + r * rr * math.sin(a)) for a in np.arange(7) / 7 * 2 * math.pi], np.float32))
    V, F = loft(rings, True, False, False)
    return orient_outward(tris_from_polys(V, F), np.array(base, np.float32) + np.array([0, (h0 + h1) / 2, 0], np.float32))


TILE_W, TILE_H, TILE_PX, TILE_PY, TILE_COLS = 96, 58, 100, 62, 5


def tile_rect(i, ox=0):
    return ox + 2 + (i % TILE_COLS) * TILE_PX, 2 + (i // TILE_COLS) * TILE_PY


def rocks_uv(uvs, ox, size_w, size_h):
    out = []
    for i, uv in enumerate(uvs):
        x0, y0 = tile_rect(i, ox)
        out.append(np.stack([(x0 + uv[..., 0] * TILE_W) / size_w, (y0 + uv[..., 1] * TILE_H) / size_h], -1).astype(np.float32))
    return out


def paint_rock(wear_moss, seed, A, N, tid, AO, submerged, cx_info):
    n = len(A)
    fb = lambda f, o=3, s=0: fbm3(A, f, o, seed + s)
    up = np.clip(N[:, 1], 0, 1)
    pick = noise3(np.stack([tid.astype(np.float32), tid * 0.37, tid * 0.0], 1), 1.0, seed + 3)
    greys = np.array([[0.46, 0.44, 0.40], [0.55, 0.49, 0.40], [0.38, 0.38, 0.36], [0.50, 0.46, 0.41]], np.float32)
    gi = np.clip((pick * 4).astype(int), 0, 3)
    base = s2l(greys[gi])
    strata = fb(np.array([2.5, 9.0, 2.5], np.float32), 3, 1)
    base = base * (0.65 + 0.7 * strata)[:, None]
    spk = noise3(A * 70, 1.0, seed + 9)
    base = base * (0.85 + 0.3 * spk)[:, None]
    # warm iron-stain streaks
    stain = smooth(0.62, 0.8, fb(np.array([5.0, 1.5, 5.0], np.float32), 2, 4))
    base = mix(base, base * np.array([1.25, 0.95, 0.7], np.float32), stain * 0.55)
    # moss on top-facing, damp parts
    mn = fb(7.0, 3, 6)
    moss = smooth(0.30 - 0.10 * wear_moss, 0.58, mn * 0.55 + up * 0.62) * smooth(0.10, 0.6, up + 0.25 * fb(3, 2, 7))
    moss_c = mix(np.tile(s2l([0.18, 0.30, 0.09]), (n, 1)), np.tile(s2l([0.32, 0.42, 0.12]), (n, 1)), fb(15, 2, 8))
    lichen = smooth(0.72, 0.78, fb(11, 2, 12)) * (1 - moss)
    alb = mix(base, moss_c, np.clip(moss, 0, 0.92))
    alb = mix(alb, np.tile(s2l([0.70, 0.72, 0.55]), (n, 1)), lichen * 0.35)
    # wet band at the waterline / underwater
    x, y, z = A[:, 0], A[:, 1], A[:, 2]
    wet = smooth(0.20, -0.02, y) if not submerged else np.ones(n, np.float32)
    alb *= (1 - 0.35 * wet)[:, None]
    if submerged:
        alg = smooth(0.35, 0.65, fb(6.0, 3, 21))
        alb = mix(alb, np.tile(s2l([0.12, 0.2, 0.08]), (n, 1)), alg * 0.7)
    rough = np.clip(0.88 - 0.38 * wet - 0.25 * moss * 0, 0.3, 0.95).astype(np.float32)
    rough = np.where(moss > 0.5, 0.94, rough)
    # height: ridged cracks + pits + grain
    rid = 1 - np.abs(fb(np.array([3.5, 3.5, 3.5], np.float32), 3, 31) * 2 - 1)
    h = 3.0 * (smooth(0.8, 0.97, rid) * -1.0) + 2.0 * (fb(18, 3, 33) - 0.5) + 1.2 * (spk - 0.5) + 1.8 * moss * (fb(40, 2, 34) - 0.5)
    ao = AO * (0.9 + 0.1 * smooth(-0.1, 0.2, y))
    return alb.astype(np.float32), rough, np.zeros(n, np.float32), ao, h.astype(np.float32)


def paint_floor(seed, A, N, AO, leaves):
    n = len(A)
    x, y, z = A[:, 0], A[:, 1], A[:, 2]
    fb = lambda f, o=3, s=0: fbm3(A, f, o, seed + s)
    d = np.hypot(x, z)
    mud = np.tile(s2l([0.20, 0.155, 0.10]), (n, 1)) * (0.6 + 0.8 * fb(2.2, 3, 1))[:, None]
    silt = fb(6.0, 3, 2)
    mud = mix(mud, np.tile(s2l([0.34, 0.30, 0.22]), (n, 1)), smooth(0.5, 0.75, silt) * 0.7)
    pn = noise3(A * np.array([34, 6, 34], np.float32), 1.0, seed + 5)
    peb = smooth(0.64, 0.72, pn) * 0.7
    pcol = np.array([[0.30, 0.28, 0.24], [0.22, 0.22, 0.22], [0.36, 0.30, 0.22], [0.18, 0.20, 0.16]], np.float32)
    pi_ = np.clip((noise3(A * np.array([34, 6, 34], np.float32), 1.0, seed + 6) * 4).astype(int), 0, 3)
    alb = mix(mud, s2l(pcol[pi_]) * (0.7 + 0.6 * noise3(A * 90, 1.0, seed + 7))[:, None], peb)
    alg = smooth(-0.9, -0.1, y) * smooth(0.45, 0.7, fb(4.0, 2, 8))
    alb = mix(alb, np.tile(s2l([0.14, 0.24, 0.08]), (n, 1)), alg * 0.75)
    h = 2.0 * peb * (noise3(A * 90, 1.0, seed + 9)) + 1.5 * (fb(10, 2, 10) - 0.5)
    # sunken leaves
    for (lx, lz, la, lw, lh, lc) in leaves:
        c, s = math.cos(la), math.sin(la)
        dx, dz = x - lx, z - lz
        if True:
            near = (np.abs(dx) < lh + 0.02) & (np.abs(dz) < lh + 0.02)
            idx = np.nonzero(near)[0]
            if not len(idx):
                continue
            u = (dx[idx] * c + dz[idx] * s) / lh
            v = (-dx[idx] * s + dz[idx] * c) / lw
            shape = lw * (1 - np.abs(u) ** 1.7)
            inside = (np.abs(u) < 1) & (np.abs(v * lw) < np.maximum(shape, 0))
            vein = inside & (np.abs(v * lw) < 0.004)
            col = np.array(lc, np.float32)
            alb[idx[inside]] = s2l(col) * (0.85 + 0.3 * noise3(A[idx[inside]] * 60, 1.0, seed + 12))[:, None]
            alb[idx[vein]] = s2l(col * 1.5)
            h[idx[inside]] += 1.5
    rough = np.full(n, 0.9, np.float32)
    return alb.astype(np.float32), rough, np.zeros(n, np.float32), AO, h.astype(np.float32)


def paint_plants():
    """512x512 RGBA atlas: pad tile, petal, blade, cattail head, fern frond. Returns (rgba sRGB float)."""
    S = 512
    img = np.zeros((S, S, 4), np.float32)
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
    rng = np.random.default_rng(5)

    def put(x0, y0, w, h, f):
        v, u = np.mgrid[0:h, 0:w].astype(np.float32)
        r = f((u + 0.5) / w, (v + 0.5) / h)
        img[y0:y0 + h, x0:x0 + w] = r
    # lily pad (256x256): polar, veins, darker rim, slight reddish underside tint at the notch
    def pad(u, v):
        px, py = u * 2 - 1, v * 2 - 1
        r = np.hypot(px, py)
        a = np.arctan2(py, px)
        veins = np.abs(np.sin(a * 11.0)) ** 14
        veins2 = np.abs(np.sin(a * 22.0 + r * 3)) ** 40 * smooth(0.35, 0.8, r)
        rings = 0.5 + 0.5 * np.sin(r * 40 + np.sin(a * 3) * 2)
        nz = noise3(np.stack([px.ravel() * 6, py.ravel() * 6, px.ravel() * 0], 1), 1.0, 7).reshape(px.shape)
        col = np.stack([0.17 + 0.07 * nz, 0.36 + 0.14 * nz, 0.10 + 0.05 * nz], -1)
        col = col * (0.85 + 0.2 * (1 - r))[..., None]
        col = col + (veins * (1 - r) * 0.12 + veins2 * 0.05)[..., None] * np.array([0.9, 1.0, 0.5])
        col = col * (1 - smooth(0.88, 1.0, r) * 0.35)[..., None] + smooth(0.9, 1.0, r)[..., None] * np.array([0.12, 0.02, 0.0])
        return np.concatenate([l2s(s2l(np.clip(col, 0, 1))), np.ones_like(r)[..., None]], -1)
    put(0, 0, 256, 256, pad)
    # petal (128x128): v 0 = base (white-yellow) -> 1 = tip (pink); veins along length
    def pet(u, v):
        c = np.abs(u - 0.5) * 2
        col = np.stack([1.0 * np.ones_like(u), 0.78 - 0.30 * v + 0.15 * (1 - v), 0.82 - 0.34 * v + 0.18 * (1 - v)], -1)
        col[..., 1] += 0.1 * (1 - v) * (1 - c)
        col = col * (1 - 0.12 * np.abs(np.sin(u * 40)) ** 6 * 0.0)[..., None]
        col = col * (0.88 + 0.12 * np.cos(c * 3))[..., None]
        col[..., 1] -= 0.1 * smooth(0.5, 1.0, c) * v
        return np.concatenate([np.clip(col, 0, 1), np.ones_like(u)[..., None]], -1)
    put(256, 0, 128, 128, pet)
    # stamen / centre
    img[0:16, 384:400] = (0.98, 0.78, 0.08, 1)
    # reed blade (64x256 at 384..448,16..272): v along length
    def reed(u, v):
        c = np.abs(u - 0.5) * 2
        col = np.stack([0.30 + 0.12 * v, 0.45 + 0.10 * v, 0.14 + 0.04 * v], -1) * (0.75 + 0.3 * (1 - c))[..., None]
        col = col * (1 - 0.5 * np.exp(-(c * 12) ** 2))[..., None] + 0.0
        col[..., 0:3] += (np.exp(-(c * 14) ** 2) * 0.12)[..., None]
        col[..., 0] += 0.25 * smooth(0.82, 1.0, v) * np.clip(0.5 + 0.5 * np.sin(v * 5), 0, 1)
        col[..., 1] -= 0.06 * smooth(0.85, 1.0, v)
        return np.concatenate([np.clip(col, 0, 1), np.ones_like(u)[..., None]], -1)
    put(384, 16, 64, 256, reed)
    # cattail head (64x64 at 448..512, 0..64)
    def cat(u, v):
        nz = noise3(np.stack([u.ravel() * 30, v.ravel() * 30, u.ravel() * 0], 1), 1.0, 3).reshape(u.shape)
        col = np.stack([0.30 + 0.12 * nz, 0.17 + 0.07 * nz, 0.08 + 0.04 * nz], -1)
        return np.concatenate([np.clip(col, 0, 1), np.ones_like(u)[..., None]], -1)
    put(448, 0, 64, 64, cat)
    # fern frond (256x256 at 0..256, 256..512): rachis along the middle, pinnae pairs, alpha cut-out
    def fern(u, v):
        out = np.zeros(u.shape + (4,), np.float32)
        x = (u - 0.5) * 2
        rach = np.abs(x) < 0.018
        k = 20
        phase = (v * k) % 1.0
        # pinnae: diagonal bars leaving the rachis, length tapering towards the tip
        taper = np.clip(1 - v * 0.9, 0.12, 1)
        diag = np.abs(np.abs(x) - (phase * 0.9) * taper)
        pin = (np.abs(x) < taper * 0.95) & (np.abs(np.abs(x) - (0.15 + phase * 0.8) * taper) < 0.11 * (1 - 0.5 * phase))
        pin = pin & (np.abs(x) > 0.02)
        a = (rach | pin).astype(np.float32)
        g = 0.55 + 0.35 * (1 - v)
        col = np.stack([0.12 * g, 0.34 * g + 0.04, 0.06 * g], -1)
        col[rach] = (0.16, 0.30, 0.08)
        out[..., :3] = col
        out[..., 3] = a
        return out
    put(0, 256, 256, 256, fern)
    # dilate colour into transparent areas to avoid dark fringes
    cov = img[..., 3] > 0.5
    rgb = dilate([img[..., :3]], cov, 6)[0]
    img[..., :3] = np.where(cov[..., None], img[..., :3], rgb)
    return img


PL = dict(pad=(0, 0, 256, 256), petal=(256, 0, 128, 128), stamen=(384, 0, 16, 16), reed=(384, 16, 64, 256), cat=(448, 0, 64, 64), fern=(0, 256, 256, 256))


def tile_uv(UV, key):
    x0, y0, w, h = PL[key]
    return np.stack([(x0 + UV[..., 0] * w) / 512.0, (y0 + UV[..., 1] * h) / 512.0], -1).astype(np.float32)


def build_plants(rng):
    P, UV = [], []
    def add(p, uv, key, inset=0.5):
        # keep UVs away from the tile border by half a texel
        x0, y0, w, h = PL[key]
        u = np.stack([(x0 + 1 + np.clip(uv[..., 0], 0, 1) * (w - 2)) / 512.0, (y0 + 1 + np.clip(uv[..., 1], 0, 1) * (h - 2)) / 512.0], -1)
        P.append(p); UV.append(u.astype(np.float32))
    WY = -0.06
    pads = []
    clusters = [(-1.6, 1.4, 5), (1.8, -1.2, 6), (0.8, 2.1, 4), (-0.6, -2.0, 3)]
    for cx, cz, cnt in clusters:
        for p in range(cnt):
            px, pz = cx + math.sin(p * 2.1) * 0.7, cz + math.cos(p * 1.8) * 0.7
            if math.hypot(px, pz) > pond_r(math.atan2(px, pz)) - 0.7:
                continue
            R = 0.26 + 0.12 * (0.5 + 0.5 * math.sin(p * 3.4 + cx))
            pp, uv = leaf_pad(rng, R)
            pp = rot_yaw(pp, rng.uniform(0, 6.28)) + np.array([px, WY + 0.004, pz], np.float32)
            add(pp, uv, "pad")
            pads.append((px, pz, R))
    # lotus / water-lily flowers
    for fx, fz, sc in ((1.5, -1.0, 1.0), (-1.2, 1.5, 0.85), (0.9, 2.0, 0.75), (-0.5, -2.1, 0.9)):
        base = (fx, WY + 0.012, fz)
        for ring, (n_, ln, wd, tilt) in enumerate(((9, 0.16, 0.050, 0.28), (7, 0.14, 0.045, 0.75), (5, 0.10, 0.04, 1.1))):
            for k in range(n_):
                pp, uv = petal(base, k / n_ * 2 * math.pi + ring * 0.35, ln * sc, wd * sc, tilt, 0.5)
                add(pp, uv, "petal")
        c = rbox((fx, WY + 0.045, fz), (0.05 * sc, 0.05 * sc, 0.05 * sc), r=0.02, seg=1)      # little yellow boss
        cu = np.zeros((len(c), 3, 2), np.float32) + 0.5
        add(c, cu, "stamen")
    # reeds + cattails at one edge
    th0 = 0.9
    for i in range(34):
        th = th0 + rng.uniform(-0.45, 0.45)
        r = pond_r(th) + rng.uniform(0.55, 1.15)
        b = (math.sin(th) * r, -0.15, math.cos(th) * r)
        h = rng.uniform(1.1, 2.1)
        pp, uv = blade(b, h, rng.uniform(0.022, 0.04), rng.uniform(0, 6.28), rng.uniform(0.1, 0.35), rng)
        add(pp, uv, "reed")
    for i in range(10):
        th = th0 + rng.uniform(-0.4, 0.4)
        r = pond_r(th) + rng.uniform(0.6, 1.1)
        b = (math.sin(th) * r, -0.15, math.cos(th) * r)
        h = rng.uniform(1.3, 1.9)
        yaw, lean = rng.uniform(0, 6.28), rng.uniform(0.06, 0.2)
        st = tube(b, h, 0.009, yaw, lean)
        add(st, np.stack([np.full(st.shape[:2], 0.5), np.zeros(st.shape[:2]) + 0.4], -1).astype(np.float32), "reed")
        hd = head_cyl(b, h - 0.30, h - 0.08, 0.026, yaw, lean, h)
        add(hd, np.zeros(hd.shape[:2] + (2,), np.float32) + 0.5, "cat")
    # ferns on the coping (two tufts)
    for th, n_ in ((3.6, 7), (5.4, 6), (2.0, 5)):
        r = pond_r(th) + 0.35
        for k in range(n_):
            a = k / n_ * 2 * math.pi + rng.uniform(-0.2, 0.2)
            b = (math.sin(th) * r + 0.05 * math.cos(a), 0.18, math.cos(th) * r + 0.05 * math.sin(a))
            pp, uv = blade(b, 0.52, 0.11, a, 0.75, rng, segs=6)
            pp[..., 1] = np.maximum(pp[..., 1], 0.1)
            add(pp, uv, "fern")
    return np.concatenate(P), np.concatenate(UV), pads


def bake_pond():
    rng = np.random.default_rng(77)
    log("pond: rocks")
    rocks, ruv, rinfo = build_coping(rng)
    srocks, suv = build_sub_rocks(rng)
    ground = np.array([[(-30, 0, -30), (30, 0, 30), (30, 0, -30)], [(-30, 0, -30), (-30, 0, 30), (30, 0, 30)]], np.float32)

    def bake_set(P, UV, tid, size, painter, extra_tris, submerged, fixed_up=False):
        N = smooth_normals(P, 70.0)
        ao = vertex_ao(P, N, extra_tris, rays=10, dist=0.7, seed=5)
        attrs = np.concatenate([P, N, ao[..., None]], 2).astype(np.float32)
        r, cst, cov = raster_attrs(UV, attrs, tid[:, None].astype(np.float32), size)
        idx = np.nonzero(cov)
        rr = r[idx]
        return N, ao, r, cst, cov, idx, rr
    # --- coping rocks (512x512 tile atlas)
    PR = np.concatenate(rocks)
    UVR = np.concatenate(rocks_uv(ruv, 0, 512, 512))
    TID = np.concatenate([np.full(len(r_), i) for i, r_ in enumerate(rocks)])
    N, ao, r, cst, cov, idx, rr = bake_set(PR, UVR, TID, 512, None, ground, False)
    nn = rr[:, 3:6] / np.maximum(np.linalg.norm(rr[:, 3:6], axis=1, keepdims=True), 1e-6)
    alb, rough, metal, ao_t, hgt = paint_rock(1.0, 4, rr[:, 0:3], nn, cst[idx][:, 0].astype(int), rr[:, 6], False, None)
    cA, cN, cO = finish_maps(cov, alb, rough, metal, ao_t, hgt, 512, 0.5)
    cop = dict(P=PR, N=N, UV=UVR, A=cA, Nn=cN, O=cO)
    log("  coping", len(PR), "tris")
    # --- floor + submerged rocks (1024x512)
    PF = build_floor(rng)
    UVF = np.stack([(PF[..., 0] / 11.0 + 0.5) * 0.5, (PF[..., 2] / 11.0 + 0.5)], -1).astype(np.float32) * np.array([1, 1], np.float32)
    PS = np.concatenate(srocks)
    UVS = np.concatenate(rocks_uv(suv, 512, 1024, 512))
    PA = np.concatenate([PF, PS])
    UVA = np.concatenate([UVF, UVS])
    TIDA = np.concatenate([np.full(len(PF), -1), np.concatenate([np.full(len(r_), i) for i, r_ in enumerate(srocks)])])
    N2, ao2, r2, cst2, cov2, idx2, rr2 = bake_set(PA, UVA, TIDA, (1024, 512), None, ground * 0 + np.array([[(-30, -1.6, -30), (30, -1.6, 30), (30, -1.6, -30)]], np.float32), True)
    nn2 = rr2[:, 3:6] / np.maximum(np.linalg.norm(rr2[:, 3:6], axis=1, keepdims=True), 1e-6)
    tid2 = cst2[idx2][:, 0].astype(int)
    isf = tid2 < 0
    leaves = []
    for i in range(70):
        th = rng.uniform(0, 6.28); f = math.sqrt(rng.uniform(0.02, 0.95)); rr_ = pond_r(th) * f
        lx, lz = math.sin(th) * rr_, math.cos(th) * rr_
        col = [(0.35, 0.22, 0.08), (0.28, 0.2, 0.07), (0.2, 0.22, 0.06), (0.4, 0.3, 0.1), (0.15, 0.12, 0.06)][i % 5]
        leaves.append((lx, lz, rng.uniform(0, 6.28), rng.uniform(0.025, 0.05), rng.uniform(0.06, 0.12), col))
    Af, Rf, Mf, AOf, Hf = paint_floor(9, rr2[:, 0:3], nn2, rr2[:, 6], leaves)
    Ar, Rr, Mr, AOr, Hr = paint_rock(0.2, 8, rr2[:, 0:3], nn2, np.maximum(tid2, 0), rr2[:, 6], True, None)
    sel = isf[:, None]
    alb2 = np.where(sel, Af, Ar); rough2 = np.where(isf, Rf, Rr); met2 = np.zeros(len(Rf), np.float32)
    ao2t = np.where(isf, AOf, AOr); h2 = np.where(isf, Hf, Hr)
    fA, fN, fO = finish_maps(cov2, alb2, rough2, met2, ao2t, h2, (1024, 512), 0.5)
    flo = dict(P=PA, N=N2, UV=UVA, A=fA, Nn=fN, O=fO)
    log("  floor+submerged", len(PA), "tris")
    # --- plants
    PP, UVP, pads = build_plants(rng)
    NP = smooth_normals(PP, 80.0)
    plant_img = paint_plants()
    log("  plants", len(PP), "tris")
    return dict(cop=cop, flo=flo, plants=dict(P=PP, N=NP, UV=UVP, img=plant_img), info=rinfo, pads=pads)


def export_pond(g, pd):
    out = {}
    nodes = []
    for key, d, mname in (("coping", pd["cop"], "pond_rock"), ("floor", pd["flo"], "pond_floor")):
        mat, _ = add_tex_material(g, mname, d["A"], d["Nn"], d["O"], q=(78, 82, 76))
        pos, nor, uv, idx, _ = tris_to_buffers(d["P"], d["N"], d["UV"])
        mi = g.mesh(mname, pos.astype(np.float32), nor, uv, idx, mat, extras={"castShadow": key == "coping"})
        nodes.append(g.node(mname, mesh=mi))
        out[key] = len(d["P"])
    pl = pd["plants"]
    img = encode_image(pl["img"], "PNG", 0, "pond_plants")
    ti = g.image(img, "image/png")
    mat = g.material("pond_plants", pbrMetallicRoughness={"baseColorTexture": {"index": ti}, "metallicFactor": 0.0, "roughnessFactor": 0.62},
                     alphaMode="MASK", alphaCutoff=0.5, doubleSided=True)
    pos, nor, uv, idx, _ = tris_to_buffers(pl["P"], pl["N"], pl["UV"])
    mi = g.mesh("pond_plants", pos.astype(np.float32), nor, uv, idx, mat, extras={"castShadow": False})
    nodes.append(g.node("pond_plants", mesh=mi))
    out["plants"] = len(pl["P"])
    return nodes, out


# =============================================================================================
# helpers: system PIL (outside Blender) for compact textures
# =============================================================================================
PIL_SNIPPET = r'''
import sys, io, struct
from PIL import Image
hdr = sys.stdin.buffer.read(16)
w, h, c, kind, q = struct.unpack("<IIIII", hdr[:20]) if len(hdr) >= 20 else (0,0,0,0,0)
'''


def pil_encode(arr, fmt="JPEG", quality=80, colors=128):
    """arr float 0..1 (h,w,3|4) (row0 = top) -> bytes. Uses the system python3 (PIL); falls back to Blender's encoder."""
    import subprocess
    a = (np.clip(arr, 0, 1) * 255 + 0.5).astype(np.uint8)
    h, w, c = a.shape
    code = ("import sys,struct\nfrom PIL import Image\nimport io\n"
            "w,h,c,q,k=struct.unpack('<5I',sys.stdin.buffer.read(20))\n"
            "d=sys.stdin.buffer.read()\n"
            "im=Image.frombytes('RGBA' if c==4 else 'RGB',(w,h),d)\n"
            "o=io.BytesIO()\n"
            "if k==0: im.save(o,'JPEG',quality=q,optimize=True,progressive=True,subsampling=0 if q>=90 else 2)\n"
            "elif k==1:\n"
            "    im=im.quantize(colors=q,method=Image.Quantize.FASTOCTREE) if c==4 else im.quantize(colors=q)\n"
            "    im.save(o,'PNG',optimize=True)\n"
            "else: im.save(o,'PNG',optimize=True)\n"
            "sys.stdout.buffer.write(o.getvalue())\n")
    kind = 0 if fmt == "JPEG" else (1 if colors else 2)
    q = quality if fmt == "JPEG" else colors
    try:
        r = subprocess.run(["/usr/bin/env", "python3", "-I", "-c", code], input=struct.pack("<5I", w, h, c, q, kind) + a.tobytes(), capture_output=True, timeout=120)
        if r.returncode == 0 and len(r.stdout) > 100:
            return r.stdout
    except Exception as e:
        log("PIL fallback", e)
    return encode_image(arr, fmt, quality)


def read_glb(path):
    d = open(path, "rb").read()
    jl, = struct.unpack("<I", d[12:16])
    j = json.loads(d[20:20 + jl])
    b = d[20 + jl + 8:]
    return j, b


CT = {5120: "i1", 5121: "u1", 5122: "<i2", 5123: "<u2", 5125: "<u4", 5126: "<f4"}
NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def read_acc(j, b, i):
    a = j["accessors"][i]
    bv = j["bufferViews"][a["bufferView"]]
    dt = np.dtype(CT[a["componentType"]])
    nc = NC[a["type"]]
    off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = bv.get("byteStride") or dt.itemsize * nc
    n = a["count"]
    raw = np.frombuffer(b, np.uint8, count=(n - 1) * stride + dt.itemsize * nc, offset=off)
    out = np.lib.stride_tricks.as_strided(raw, (n, dt.itemsize * nc), (stride, 1)).copy().view(dt).reshape(n, nc)
    if a.get("normalized"):
        out = out.astype(np.float32) / (np.iinfo(dt).max if dt.kind in "iu" else 1)
    return out


# =============================================================================================
# KOI (7PLUS, CC-BY-4.0): rest pose + PCA of the baked morph animation, subdivided once
# =============================================================================================
KOI_SRC = os.path.join(GAME, "koi_fish 1.glb")
PH_SRC = os.path.join(GAME, "phoenix_bird.glb")
KOI_K = 4


def quat_mat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]], np.float32)


def bake_koi():
    j, b = read_glb(KOI_SRC)
    prim = j["meshes"][0]["primitives"][0]
    at = prim["attributes"]
    P0 = read_acc(j, b, at["POSITION"])
    UV0 = read_acc(j, b, at["TEXCOORD_0"])
    IDX = read_acc(j, b, prim["indices"]).reshape(-1, 3)
    D = np.stack([read_acc(j, b, t["POSITION"]) for t in prim["targets"]])          # (150, n, 3)
    an = j["animations"][0]
    smp = an["samplers"][0]
    times = read_acc(j, b, smp["input"]).reshape(-1)
    Wt = read_acc(j, b, smp["output"]).reshape(len(times), -1)                         # (F, 150)
    F = Wt @ D.reshape(D.shape[0], -1)                                                 # (F, n*3) offsets per frame
    m = F.mean(0)
    U, Sg, Vt = np.linalg.svd(F - m, full_matrices=False)
    var = (Sg ** 2) / (Sg ** 2).sum()
    log("koi frames", len(times), "dur", float(times[-1]), "pca variance", np.round(var[:6], 4), "kept", float(var[:KOI_K].sum()))
    modes = Vt[:KOI_K]
    wts = (U[:, :KOI_K] * Sg[:KOI_K]).T                                                # (K, F)
    R = quat_mat((-0.5, 0.5, 0.5, 0.5))                                                # raw -> swim space (+Z head, +Y up)
    rest = (P0 + m.reshape(-1, 3)) @ R.T
    modes = np.stack([(mo.reshape(-1, 3) @ R.T) for mo in modes])
    ext = rest.max(0) - rest.min(0)
    L = float(ext.max())
    ctr = (rest.max(0) + rest.min(0)) / 2
    rest = (rest - ctr) / L
    modes = modes / L
    log("koi extents after rotation", np.round(ext / L, 3), "rawlen", L)
    # weld by position, build blender mesh, subdivide once
    key = np.round(rest * 1e5).astype(np.int64)
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    inv = inv.reshape(-1)
    Vw = rest[first]
    Mw = modes[:, first]
    faces = inv[IDX]
    me = bpy.data.meshes.new("koi")
    me.from_pydata(Vw.tolist(), [], faces.tolist())
    uvl = me.uv_layers.new(name="UV")
    uv_arr = UV0[IDX.reshape(-1)].astype(np.float32)
    uvl.data.foreach_set("uv", uv_arr.ravel())
    ob = bpy.data.objects.new("koi", me)
    bpy.context.scene.collection.objects.link(ob)
    md = ob.modifiers.new("sub", "SUBSURF")
    md.levels = md.render_levels = 1
    md.uv_smooth = "PRESERVE_BOUNDARIES"
    md.boundary_smooth = "PRESERVE_CORNERS"

    def evaluated(verts):
        me.vertices.foreach_set("co", verts.astype(np.float32).ravel())
        me.update()
        dg = bpy.context.evaluated_depsgraph_get()
        dg.update()
        ev = ob.evaluated_get(dg)
        em = ev.to_mesh()
        n = len(em.vertices)
        co = np.zeros(n * 3, np.float32)
        em.vertices.foreach_get("co", co)
        res = co.reshape(n, 3)
        em.calc_loop_triangles()
        nt = len(em.loop_triangles)
        lt = np.zeros(nt * 3, np.int32)
        em.loop_triangles.foreach_get("loops", lt)
        vi = np.zeros(nt * 3, np.int32)
        em.loop_triangles.foreach_get("vertices", vi)
        uvs = np.zeros(len(em.loops) * 2, np.float32)
        em.uv_layers[0].data.foreach_get("uv", uvs)
        uvs = uvs.reshape(-1, 2)[lt]
        ev.to_mesh_clear()
        return res, vi.reshape(-1, 3), uvs.reshape(-1, 3, 2)
    base, vi, uvs = evaluated(Vw)
    dmodes = []
    for k in range(KOI_K):
        pk, _, _ = evaluated(Vw + Mw[k])
        dmodes.append(pk - base)
    dmodes = np.stack(dmodes)
    # per-corner arrays
    P = base[vi]
    N = smooth_normals(P, 75.0)
    UV = uvs.astype(np.float32)
    ex = {"_MODE%d" % k: dmodes[k][vi] for k in range(KOI_K)}
    pos, nor, uv, idx, exu = tris_to_buffers(P, N, UV, ex)
    scales = [float(np.abs(dmodes[k]).max() + 1e-9) for k in range(KOI_K)]
    log("koi subdivided tris", len(idx), "verts", len(pos), "mode scales", np.round(scales, 4))
    bpy.data.objects.remove(ob, do_unlink=True)
    # textures
    return dict(pos=pos, nor=nor, uv=uv, idx=idx, modes=exu, scales=scales, weights=wts, dur=float(times[-1]), L=L, frames=len(times))


def export_koi(kd, tex_a, tex_n):
    g = GLB()
    ia = g.image(pil_encode(tex_a, "JPEG", 80), "image/jpeg")
    inn = g.image(pil_encode(tex_n, "JPEG", 88), "image/jpeg")
    mat = g.material("koi", pbrMetallicRoughness={"baseColorTexture": {"index": ia}, "metallicFactor": 0.0, "roughnessFactor": 0.3}, normalTexture={"index": inn})
    extra = {}
    for k, arr in kd["modes"].items():
        sc = kd["scales"][int(k[5:])]
        extra[k] = (np.round(arr / sc * 32767), "VEC3", 5122, True)
    mi = g.mesh("koi", kd["pos"].astype(np.float32), kd["nor"], kd["uv"], kd["idx"], mat, extra_attrs=extra,
                extras={"koi": {"K": KOI_K, "scales": [round(s, 6) for s in kd["scales"]], "duration": round(kd["dur"], 4), "frames": kd["frames"],
                                "weights": [[round(float(x), 4) for x in row] for row in kd["weights"]], "length": 1.0}})
    n = g.node("koi", mesh=mi)
    g.save(os.path.join(GLB_DIR, "koi_lite.glb"), scene_nodes=[n])
    return open(os.path.join(GLB_DIR, "koi_lite.glb"), "rb").read()


# =============================================================================================
# PHOENIX (NORBERTO-3D, CC-BY-4.0): decimate both skinned meshes, merge into one, keep rig + animation
# =============================================================================================
PH_RATIO = float(os.environ.get("PH_RATIO", "0.5"))


def copy_acc(j, b, g, i):
    a = dict(j["accessors"][i])
    bv = j["bufferViews"][a.pop("bufferView")]
    off = bv.get("byteOffset", 0) + a.pop("byteOffset", 0)
    nc, dt = NC[a["type"]], np.dtype(CT[a["componentType"]])
    stride = bv.get("byteStride") or nc * dt.itemsize
    data = b[off:off + (a["count"] - 1) * stride + nc * dt.itemsize]
    if stride != nc * dt.itemsize:
        arr = np.frombuffer(data, np.uint8)
        data = np.lib.stride_tricks.as_strided(arr, (a["count"], nc * dt.itemsize), (stride, 1)).tobytes()
    a["bufferView"] = g._bv(data)
    a.pop("sparse", None)
    g.accs.append(a)
    return len(g.accs) - 1


def decimate_prim(j, b, prim, ratio):
    at = prim["attributes"]
    P = read_acc(j, b, at["POSITION"])
    Nn = read_acc(j, b, at["NORMAL"])
    UV = read_acc(j, b, at["TEXCOORD_0"])
    JT = read_acc(j, b, at["JOINTS_0"]).astype(int)
    W = read_acc(j, b, at["WEIGHTS_0"])
    IDX = read_acc(j, b, prim["indices"]).reshape(-1, 3).astype(int)
    me = bpy.data.meshes.new("ph")
    me.from_pydata(P.tolist(), [], IDX.tolist())
    uvl = me.uv_layers.new(name="UV")
    uvl.data.foreach_set("uv", UV[IDX.reshape(-1)].astype(np.float32).ravel())
    ob = bpy.data.objects.new("ph", me)
    bpy.context.scene.collection.objects.link(ob)
    groups = {}
    for jn in np.unique(JT[W > 0]):
        groups[int(jn)] = ob.vertex_groups.new(name="j%d" % jn)
    for v in range(len(P)):
        for k in range(4):
            if W[v, k] > 1e-4:
                groups[int(JT[v, k])].add([v], float(W[v, k]), "REPLACE" if False else "ADD")
    md = ob.modifiers.new("dec", "DECIMATE")
    md.decimate_type = "COLLAPSE"
    md.ratio = ratio
    md.use_collapse_triangulate = True
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    em = ev.to_mesh()
    em.calc_loop_triangles()
    n = len(em.vertices)
    co = np.zeros(n * 3, np.float32)
    em.vertices.foreach_get("co", co)
    co = co.reshape(n, 3)
    nt = len(em.loop_triangles)
    lt = np.zeros(nt * 3, np.int32); em.loop_triangles.foreach_get("loops", lt)
    vi = np.zeros(nt * 3, np.int32); em.loop_triangles.foreach_get("vertices", vi)
    uvs = np.zeros(len(em.loops) * 2, np.float32); em.uv_layers[0].data.foreach_get("uv", uvs)
    uvs = uvs.reshape(-1, 2)[lt].reshape(-1, 3, 2)
    jw = np.zeros((n, 4), np.float32); jj = np.zeros((n, 4), int)
    for v in em.vertices:
        gs = sorted(((ob.vertex_groups[g.group].name, g.weight) for g in v.groups), key=lambda t: -t[1])[:4]
        for k, (nm, w) in enumerate(gs):
            jw[v.index, k] = w
            jj[v.index, k] = int(nm[1:])
    ev.to_mesh_clear()
    bpy.data.objects.remove(ob, do_unlink=True)
    sw = jw.sum(1, keepdims=True)
    jw = np.where(sw > 0, jw / np.maximum(sw, 1e-6), np.array([1, 0, 0, 0], np.float32))
    tri_v = vi.reshape(-1, 3)
    Pc = co[tri_v]
    # normals: smooth from decimated geometry (rest pose)
    Nc = smooth_normals(Pc, 60.0)
    return Pc, Nc, uvs.astype(np.float32), jj[tri_v], jw[tri_v], len(IDX)


def bake_phoenix():
    j, b = read_glb(PH_SRC)
    parts = []
    for mi in range(2):
        prim = j["meshes"][mi]["primitives"][0]
        parts.append(decimate_prim(j, b, prim, PH_RATIO))
        log("phoenix mesh", mi, "tris", parts[-1][5], "->", len(parts[-1][0]))
    P = np.concatenate([p[0] for p in parts])
    Nn = np.concatenate([p[1] for p in parts])
    UV = np.concatenate([np.stack([p[2][..., 0], (p[2][..., 1] + i) * 0.5], -1) for i, p in enumerate(parts)])
    JJ = np.concatenate([p[3] for p in parts])
    WW = np.concatenate([p[4] for p in parts])
    pos, nor, uv, idx, ex = tris_to_buffers(P, Nn, UV, {"J": JJ.astype(np.float32), "W": WW})
    g = GLB()
    # textures: atlas the two materials vertically
    def img(i):
        im = j["images"][i]
        bv = j["bufferViews"][im["bufferView"]]
        data = b[bv.get("byteOffset", 0):][:bv["byteLength"]]
        path = os.path.join(TMP, "_ph%d.png" % i)
        open(path, "wb").write(data)
        return load_image(path)
    ba, bb = img(j["textures"][j["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["index"]]["source"]), img(j["textures"][j["materials"][1]["pbrMetallicRoughness"]["baseColorTexture"]["index"]]["source"])
    ea, eb = img(j["textures"][j["materials"][0]["emissiveTexture"]["index"]]["source"])[..., :3], img(j["textures"][j["materials"][1]["emissiveTexture"]["index"]]["source"])[..., :3]
    base = np.concatenate([ba, bb], 0)
    emis = np.concatenate([resize(ea, 256, 256), resize(eb, 256, 256)], 0)
    log("phoenix atlas", base.shape, emis.shape)
    tb = g.image(pil_encode(base, "PNG", 0, colors=112), "image/png")
    te = g.image(pil_encode(emis, "JPEG", 80), "image/jpeg")
    mat = g.material("phoenix", pbrMetallicRoughness={"baseColorTexture": {"index": tb}, "metallicFactor": 0.0, "roughnessFactor": 0.55},
                     emissiveTexture={"index": te}, emissiveFactor=[1, 1, 1], alphaMode="MASK", alphaCutoff=0.4, doubleSided=True)
    jbuf = ex["J"].astype(np.uint16)
    mi = g.mesh("phoenix", pos.astype(np.float32), nor, uv, idx, mat, extra_attrs={"JOINTS_0": (jbuf, "VEC4", 5123, False), "WEIGHTS_0": (np.round(ex["W"] * 65535), "VEC4", 5123, True)})
    # nodes + skin + animation from the source (mesh nodes collapse into one)
    nodes = json.loads(json.dumps(j["nodes"]))
    first = True
    for nd in nodes:
        if "mesh" in nd:
            if first:
                nd["mesh"] = mi
                first = False
            else:
                nd.pop("mesh"); nd.pop("skin", None)
    g.nodes = nodes
    g.meshes = g.meshes
    skins = json.loads(json.dumps(j["skins"]))
    for sk in skins:
        if "inverseBindMatrices" in sk:
            sk["inverseBindMatrices"] = copy_acc(j, b, g, sk["inverseBindMatrices"])
    anims = json.loads(json.dumps(j["animations"]))
    cache = {}

    def cp(i):
        if i not in cache:
            cache[i] = copy_acc(j, b, g, i)
        return cache[i]
    kept = dropped = 0
    for an in anims:
        chans, smps = [], []
        for ch in an["channels"]:
            sm = an["samplers"][ch["sampler"]]
            out = read_acc(j, b, sm["output"])
            if np.ptp(out, 0).max() < 1e-5:      # constant track -> bake into the node, drop the channel
                nd = nodes[ch["target"]["node"]]
                nd[{"translation": "translation", "rotation": "rotation", "scale": "scale"}[ch["target"]["path"]]] = [float(x) for x in out[0]]
                dropped += 1
                continue
            smps.append({"input": cp(sm["input"]), "output": cp(sm["output"]), "interpolation": sm.get("interpolation", "LINEAR")})
            chans.append({"sampler": len(smps) - 1, "target": ch["target"]})
            kept += 1
        an["channels"], an["samplers"] = chans, smps
    log("phoenix animation channels kept", kept, "dropped", dropped)
    path = os.path.join(GLB_DIR, "phoenix_lite.glb")
    g.skins, g.anims = skins, anims
    n = g.save(path, scene_nodes=j["scenes"][j["scene"]]["nodes"])
    return open(path, "rb").read(), len(P)


# =============================================================================================
# assets + contact sheet
# =============================================================================================
def build_props_glb():
    a, b, rects = bake_bus()
    g = GLB()
    nodes, bstats = export_buses(g, a, b)
    pd = bake_pond()
    pn, pstats = export_pond(g, pd)
    n = g.save(os.path.join(GLB_DIR, "lodge_props.glb"), scene_nodes=nodes + pn)
    data = {"buses": bstats, "pond": {"x": -18.5, "z": 20.0, "depth": POND_DEPTH, "rocks": pd["info"], "tris": pstats},
            "notes": "bus nodes: bus_clean, bus_old (body + glass children, authored front = -Z, origin on the ground, centred); pond nodes in pond-local space"}
    log("lodge_props.glb", n, "bytes", bstats, pstats)
    return data


def build_creatures():
    j, b = read_glb(KOI_SRC)
    def img(i):
        bv = j["bufferViews"][j["images"][i]["bufferView"]]
        path = os.path.join(TMP, "_k%d.%s" % (i, "jpg" if "jpeg" in j["images"][i]["mimeType"] else "png"))
        open(path, "wb").write(b[bv.get("byteOffset", 0):][:bv["byteLength"]])
        return load_image(path)[..., :3]
    kd = bake_koi()
    kglb = export_koi(kd, resize(img(0), 512, 512), resize(img(1), 512, 512))
    pglb, pt = bake_phoenix()
    size = js_asset(OUT_CREAT, "// Generated by tools/blender/build_lodge_props.py. Do not edit by hand.\n// KOI_GLB: koi_fish 1.glb by 7PLUS (CC-BY-4.0), re-meshed (subdivided once, 4 PCA morph modes + weight table in mesh extras).\n// PHOENIX_GLB: phoenix_bird.glb by NORBERTO-3D (CC-BY-4.0), decimated, merged into one mesh/atlas, rig + animation untouched.",
                    {"KOI_GLB": kglb, "PHOENIX_GLB": pglb})
    log("creatures_asset.js", size, "bytes; koi glb", len(kglb), "phoenix glb", len(pglb), "tris", pt)
    return size


def write_props_js():
    data = json.load(open(os.path.join(GLB_DIR, "lodge_props.json")))
    glb = open(os.path.join(GLB_DIR, "lodge_props.glb"), "rb").read()
    size = js_asset(OUT_PROPS, "// Generated by tools/blender/build_lodge_props.py. Do not edit by hand.\n// LODGE_PROPS_GLB: school buses (bus_clean, bus_old) + koi pond coping / basin floor / plants, merged by material.",
                    {"LODGE_PROPS_GLB": glb, "LODGE_PROPS_DATA": data})
    log("lodge_props_asset.js", size, "bytes")
    return size


def render_sheet():
    from mathutils import Vector
    sc = bpy.context.scene
    tiles = []
    W, H = 640, 360

    def fresh():
        bpy.ops.wm.read_factory_settings(use_empty=True)
        s = bpy.context.scene
        s.render.engine = "CYCLES"
        s.cycles.device = "CPU"
        s.cycles.samples = SAMPLES
        s.cycles.use_denoising = True
        s.render.resolution_x, s.render.resolution_y = W, H
        s.render.resolution_percentage = 100
        try:
            s.view_settings.view_transform = "AgX"
        except Exception:
            pass
        w = bpy.data.worlds.new("w")
        w.use_nodes = True
        bg = w.node_tree.nodes["Background"]
        bg.inputs[0].default_value = (0.42, 0.62, 0.95, 1)
        bg.inputs[1].default_value = 1.0
        s.world = w
        ld = bpy.data.lights.new("sun", "SUN")
        ld.energy = 4.0
        ld.angle = 0.03
        lo = bpy.data.objects.new("sun", ld)
        s.collection.objects.link(lo)
        lo.rotation_euler = (math.radians(52), math.radians(8), math.radians(35))
        return s

    def ground(s, z=0.0, col=(0.16, 0.2, 0.09), hole=False):
        if hole:
            ring_in, ring_out, V, F = 40, 40, [], []
            for i in range(ring_in):
                th = i / ring_in * 2 * math.pi
                r = pond_r(th) - 0.06
                V.append((math.sin(th) * r, -math.cos(th) * r, z))
            for i in range(ring_out):
                th = i / ring_out * 2 * math.pi
                V.append((math.sin(th) * 60, -math.cos(th) * 60, z))
            for i in range(ring_in):
                j = (i + 1) % ring_in
                F.append((i, ring_in + i, ring_in + j, j))
        else:
            V = [(-80, -80, z), (80, -80, z), (80, 80, z), (-80, 80, z)]
            F = [(0, 1, 2, 3)]
        me = bpy.data.meshes.new("gr")
        me.from_pydata(V, [], F)
        ob = bpy.data.objects.new("gr", me)
        s.collection.objects.link(ob)
        m = bpy.data.materials.new("gm")
        m.use_nodes = True
        m.node_tree.nodes["Principled BSDF"].inputs[0].default_value = (*col, 1)
        m.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.95
        me.materials.append(m)

    def cam_render(s, loc, tgt, lens, path, clip=(0.05, 4000)):
        cd = bpy.data.cameras.new("c")
        cd.lens = lens
        cd.clip_start, cd.clip_end = clip
        cam = bpy.data.objects.new("c", cd)
        s.collection.objects.link(cam)
        s.camera = cam
        cam.location = loc
        cam.rotation_euler = (Vector(tgt) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        s.render.filepath = path
        bpy.ops.render.render(write_still=True)
        return load_image(path)

    def only(prefixes):
        for o in bpy.data.objects:
            if o.type in ("MESH", "EMPTY") and o.name.split(".")[0] not in ("gr", "water"):
                top = o
                while top.parent:
                    top = top.parent
                keep = any(top.name.startswith(p) for p in prefixes)
                o.hide_render = not keep
                o.hide_set(not keep) if False else None

    glb = os.path.join(GLB_DIR, "lodge_props.glb")
    out = []
    # --- buses
    s = fresh()
    bpy.ops.import_scene.gltf(filepath=glb)
    ob = bpy.data.objects["bus_old"]
    ob.location = (40, 0, 0)
    for o in bpy.data.objects:
        top = o
        while top.parent:
            top = top.parent
        if top.name.startswith("pond"):
            o.hide_render = True
    ground(s, 0.0, (0.2, 0.22, 0.17))
    for k, (loc, tgt, lens) in enumerate([((0.5, 13.5, 1.5), (0, 3, 1.5), 42), ((-9.5, 9.5, 3.0), (0, 0.5, 1.4), 38), ((13.5, 0.5, 1.7), (0, 0.4, 1.5), 36)]):
        out.append(cam_render(s, loc, tgt, lens, os.path.join(TMP, "sh_bus%d.png" % k)))
    out.append(cam_render(s, (40 + 9.5, -9.5, 2.6), (40, -0.5, 1.3), 38, os.path.join(TMP, "sh_busold.png")))
    # --- pond
    s = fresh()
    bpy.ops.import_scene.gltf(filepath=glb)
    for o in bpy.data.objects:
        top = o
        while top.parent:
            top = top.parent
        if top.name.startswith("bus"):
            o.hide_render = True
    ground(s, 0.0, (0.17, 0.22, 0.1), hole=True)
    # water
    V = [(0, 0, -0.06)] + [(math.sin(i / 48 * 6.2832) * pond_r(i / 48 * 6.2832), -math.cos(i / 48 * 6.2832) * pond_r(i / 48 * 6.2832), -0.06) for i in range(48)]
    me = bpy.data.meshes.new("water")
    me.from_pydata(V, [], [(0, 1 + i, 1 + (i + 1) % 48) for i in range(48)])
    wo = bpy.data.objects.new("water", me)
    s.collection.objects.link(wo)
    m = bpy.data.materials.new("wm")
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs[0].default_value = (0.05, 0.22, 0.2, 1)
    b.inputs["Roughness"].default_value = 0.02
    b.inputs["Alpha"].default_value = 0.45
    b.inputs["IOR"].default_value = 1.33
    me.materials.append(m)
    out.append(cam_render(s, (5.5, 9.0, 6.0), (0, -0.3, -0.4), 36, os.path.join(TMP, "sh_pond0.png")))
    out.append(cam_render(s, (2.8, 3.6, 0.9), (0.3, -1.5, -0.1), 40, os.path.join(TMP, "sh_pond1.png")))
    # --- koi
    s = fresh()
    bpy.ops.import_scene.gltf(filepath=os.path.join(GLB_DIR, "koi_lite.glb"))
    ground(s, -0.6, (0.12, 0.2, 0.12))
    out.append(cam_render(s, (0.55, 1.0, 0.65), (0, 0, 0), 55, os.path.join(TMP, "sh_koi.png")))
    # --- phoenix
    s = fresh()
    bpy.ops.import_scene.gltf(filepath=os.path.join(GLB_DIR, "phoenix_lite.glb"))
    s.frame_set(14)
    s.world.node_tree.nodes["Background"].inputs[0].default_value = (0.25, 0.45, 0.9, 1)
    out.append(cam_render(s, (700, 1500, 800), (0, 0, 100), 40, os.path.join(TMP, "sh_phoenix.png"), clip=(1, 100000)))
    sheet = np.zeros((2 * H, 4 * W, 4), np.float32)
    sheet[..., 3] = 1
    order = [0, 1, 2, 3, 4, 5, 6, 7]
    for i, t in enumerate(out[:8]):
        r, c = divmod(i, 4)
        y0 = r * H
        sheet[y0:y0 + H, c * W:(c + 1) * W] = t
    img = bpy.data.images.new("sheet", 4 * W, 2 * H)
    img.pixels.foreach_set(np.ascontiguousarray(sheet[::-1]).ravel())
    img.filepath_raw = SHEET
    img.file_format = "PNG"
    img.save()
    log("wrote", SHEET)


def main():
    if "bus" in STAGES or "pond" in STAGES:
        d = build_props_glb()
        json.dump(d, open(os.path.join(GLB_DIR, "lodge_props.json"), "w"))
    if "creatures" in STAGES:
        build_creatures()
    if "bus" in STAGES or "pond" in STAGES or os.environ.get("ASSEMBLE"):
        write_props_js()
    if "sheet" in STAGES and not os.environ.get("NO_SHEET"):
        render_sheet()


if STAGES and __name__ == "__main__":
    main()
