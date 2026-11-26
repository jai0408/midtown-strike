"""Builds the Midtown Strike weapon meshes.

    /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/build_weapons.py

Every firearm is authored in millimetres in its own "gun space" (x right, y up
with the bore on y = 0, forward = -z) from real-world dimensions, then scaled
uniformly and moved so the muzzle and grip land on the anchor points the game
animates the hands to.

Hard-surface look without textures:
  * parts are bevelled; normals are face-area weighted so big faces stay flat
    and the bevels catch the highlights (one vertex per smooth fan)
  * vertex colour = albedo * per-part tint * low-frequency variation * baked AO,
    with bare-metal wear on the middle loop of two-segment bevels / lathe rims
  * every vertex carries a material class (see src/core/pbr.js MAT_CLASSES)

Environment switches (for iterating):
  WEAPONS=m4,m9     build only these (the asset file is not written)
  NO_PREVIEW=1      skip the preview renders
  ADS=1             also render weapon_<id>_ads.png down the sight line
"""
import base64
import json
import math
import os
import random
import struct
import time
import traceback

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

bpy.ops.wm.read_factory_settings(use_empty=True)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT_PATH = os.path.join(ROOT, "src", "game", "weapons_asset.js")
PREVIEW_DIR = os.path.join(HERE, "preview")
SHEET_PATH = os.path.join(ROOT, "docs", "sheet_weapons.png")

SCALE = 16000
AO_DIST = 0.045
AO_FLOOR = 0.42
ONLY = [s for s in os.environ.get("WEAPONS", "").split(",") if s]
NO_PREVIEW = bool(os.environ.get("NO_PREVIEW"))
ADS_VIEW = bool(os.environ.get("ADS"))

# Material classes; keep in sync with MAT_CLASSES in src/core/pbr.js -> (roughness, metalness)
MAT_CLASSES = [
    (0.85, 0.0), (0.30, 0.35), (0.42, 0.90), (0.28, 1.00), (0.58, 0.00), (0.92, 0.00),
    (0.62, 0.00), (0.08, 0.85), (0.95, 0.00), (0.14, 1.00), (0.10, 0.40), (0.70, 0.60),
]
C_MATTE, C_PAINT, C_GUN, C_STEEL, C_POLY, C_RUBBER, C_WOOD, C_GLASS, C_FABRIC, C_CHROME, C_LENS, C_CAST = range(12)

# surface name -> (sRGB albedo, material class)
SURF = {
    "gun": ("#383c44", C_GUN),        # anodized / parkerized slate receiver
    "gun_l": ("#4e535d", C_GUN),      # lighter titanium phosphate (barrels, bezels, small parts)
    "gun_d": ("#292c32", C_GUN),      # matte black-oxide hardware
    "blued": ("#282c33", C_GUN),      # blued steel (AK)
    "cast": ("#3a3d43", C_CAST),      # rough cast / heavy parkerizing
    "steel": ("#9aa0a8", C_STEEL),    # bare brushed steel
    "steel_d": ("#686e78", C_STEEL),  # bolt carrier, machined steel turrets & levers
    "satin": ("#a9adb3", C_STEEL),    # brushed stainless (Desert Eagle)
    "chrome": ("#c9cdd2", C_CHROME),
    "blade": ("#b8bcc2", C_STEEL),
    "blade_d": ("#42464c", C_GUN),    # coated blade flats
    "poly": ("#1b1d20", C_POLY),
    "poly_l": ("#2f3237", C_POLY),
    "fde": ("#947d58", C_POLY),
    "fde_d": ("#746348", C_POLY),
    "od": ("#454b38", C_POLY),
    "od_d": ("#363b2d", C_POLY),
    "bronze": ("#76634d", C_GUN),     # rich burnt-bronze anodized M-LOK rail
    "rubber": ("#1b1c1e", C_RUBBER),
    "wood": ("#4b2e1b", C_WOOD),
    "wood_d": ("#33200f", C_WOOD),
    "leather": ("#36231a", C_WOOD),
    "lens": ("#0b1830", C_LENS),
    "glass": ("#0e1216", C_GLASS),
    "fabric": ("#54523f", C_FABRIC),
    "void": ("#050505", C_MATTE),
    "white": ("#c9cac2", C_MATTE),
    "red": ("#a51b15", C_MATTE),
    "brass": ("#a98339", C_STEEL),
}
SURF_NAMES = list(SURF.keys())


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_to_linear(h):
    h = h.lstrip("#")
    return tuple(srgb_to_linear(int(h[i:i + 2], 16) / 255.0) for i in (0, 2, 4))


SURF_LIN = [hex_to_linear(SURF[n][0]) for n in SURF_NAMES]
SURF_CLS = [SURF[n][1] for n in SURF_NAMES]


# ---------------------------------------------------------------------------
# 2D helpers
# ---------------------------------------------------------------------------
def rnd(pts, r=1.0, n=1):
    """Chamfer (n=1) or round (n>1) the corners of a closed 2D polygon. A point may carry
    its own radius as a third element (0 keeps the corner sharp)."""
    out = []
    cnt = len(pts)
    for i, p in enumerate(pts):
        rr = p[2] if len(p) > 2 else r
        a, b, c = pts[i - 1], p, pts[(i + 1) % cnt]
        va = (a[0] - b[0], a[1] - b[1])
        vc = (c[0] - b[0], c[1] - b[1])
        la, lc = math.hypot(*va), math.hypot(*vc)
        if rr <= 0 or la < 1e-6 or lc < 1e-6:
            out.append((b[0], b[1]))
            continue
        cross = abs(va[0] * vc[1] - va[1] * vc[0]) / (la * lc)
        dot = (va[0] * vc[0] + va[1] * vc[1]) / (la * lc)
        if cross < 0.26 and dot < 0:  # nearly straight
            out.append((b[0], b[1]))
            continue
        d = min(rr, la * 0.45, lc * 0.45)
        p0 = (b[0] + va[0] / la * d, b[1] + va[1] / la * d)
        p1 = (b[0] + vc[0] / lc * d, b[1] + vc[1] / lc * d)
        for k in range(n + 1):
            t = k / n
            w0, w1, w2 = (1 - t) ** 2, 2 * t * (1 - t), t * t
            out.append((w0 * p0[0] + w1 * b[0] + w2 * p1[0], w0 * p0[1] + w1 * b[1] + w2 * p1[1]))
    return out


def mirror_x(half):
    """half: points with x >= 0 listed bottom to top; returns the closed symmetric outline."""
    left = [(-p[0],) + tuple(p[1:]) for p in reversed(half) if abs(p[0]) > 1e-6]
    return list(half) + left


def sup_xz(y, cz, rx, rz, e=2.6, n=14, cx=0.0, back=None):
    """Superellipse ring in the horizontal plane (grip sections). `back` optionally gives
    a different exponent for the +z half."""
    ring = []
    for i in range(n):
        a = 2 * math.pi * i / n
        c, s = math.cos(a), math.sin(a)
        ee = back if (back and s > 0) else e
        ring.append((cx + rx * math.copysign(abs(c) ** (2 / ee), c), y, cz + rz * math.copysign(abs(s) ** (2 / ee), s)))
    return ring


def sup_xy(z, cy, rx, ry, e=2.6, n=14, cx=0.0, top=None):
    ring = []
    for i in range(n):
        a = 2 * math.pi * i / n
        c, s = math.cos(a), math.sin(a)
        ee = top if (top and s > 0) else e
        ring.append((cx + rx * math.copysign(abs(c) ** (2 / ee), c), cy + ry * math.copysign(abs(s) ** (2 / ee), s), z))
    return ring


def frame_of(axis):
    a = Vector(axis).normalized()
    t = Vector((0, 1, 0)) if abs(a.y) < 0.9 else Vector((1, 0, 0))
    u = t.cross(a).normalized()
    v = a.cross(u).normalized()
    return u, v, a


# ---------------------------------------------------------------------------
# Gun builder
# ---------------------------------------------------------------------------
class Gun:
    def __init__(self, wid, scale, muzzle_mm, muzzle_game):
        self.wid = wid
        self.S = scale / 1000.0
        self.off = [muzzle_game[i] - muzzle_mm[i] * self.S for i in range(3)]
        self.bm = bmesh.new()
        self.l_mat = self.bm.faces.layers.int.new("surf")
        self.l_tint = self.bm.faces.layers.float.new("tint")
        self.l_wear = self.bm.verts.layers.float.new("wear")
        self.rng = random.Random(wid)
        self.points = {}

    # --- coordinates -------------------------------------------------------
    def game(self, x, y, z):
        return [round(x * self.S + self.off[0], 4), round(y * self.S + self.off[1], 4), round(z * self.S + self.off[2], 4)]

    def mm(self, g):
        return [round((g[i] - self.off[i]) / self.S, 1) for i in range(3)]

    def _bl(self, co):
        x = co[0] * self.S + self.off[0]
        y = co[1] * self.S + self.off[1]
        z = co[2] * self.S + self.off[2]
        return (x, -z, y)

    # --- part plumbing -----------------------------------------------------
    @staticmethod
    def _new():
        pb = bmesh.new()
        pb.verts.layers.float.new("wear")
        return pb

    @staticmethod
    def _bevel(pb, edges, off, wear=0.0, seg=None):
        if off <= 0 or not edges:
            return
        seg = seg or (2 if wear > 0 else 1)
        res = bmesh.ops.bevel(pb, geom=edges, offset=off, offset_type="OFFSET", segments=seg, profile=0.5,
                              affect="EDGES", clamp_overlap=True)
        if wear > 0:
            wl = pb.verts.layers.float["wear"]
            bf = set(res["faces"])
            for v in res["verts"]:
                if v.is_valid and all(f in bf for f in v.link_faces):
                    v[wl] = wear

    def _fin(self, pb, mat, sharp=50.0, mx=False, rot=None, warp=None, tint=None, keepn=False, soft=False, marked=False):
        """Finish a part and merge it into the gun. rot = (axis, degrees, pivot)."""
        if rot:
            ax, deg, piv = rot
            c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
            for v in pb.verts:
                x, y, z = v.co.x - piv[0], v.co.y - piv[1], v.co.z - piv[2]
                if ax == "x":
                    y, z = y * c - z * s, y * s + z * c
                elif ax == "y":
                    x, z = x * c + z * s, -x * s + z * c
                else:
                    x, y = x * c - y * s, x * s + y * c
                v.co = (x + piv[0], y + piv[1], z + piv[2])
        if warp:
            for v in pb.verts:
                v.co = warp(v.co.x, v.co.y, v.co.z)
        if not keepn:
            bmesh.ops.recalc_face_normals(pb, faces=list(pb.faces))
        pb.normal_update()
        if not marked:
            lim = math.radians(sharp)
            for e in pb.edges:
                if len(e.link_faces) == 2:
                    e.smooth = soft or e.calc_face_angle(0.0) < lim
                else:
                    e.smooth = False
        si = SURF_NAMES.index(mat)
        t = tint if tint is not None else self.rng.uniform(-1.0, 1.0)
        wl = pb.verts.layers.float["wear"]
        pb.verts.index_update()
        for sx in ((1, -1) if mx else (1,)):
            vm = []
            for v in pb.verts:
                nv = self.bm.verts.new(self._bl((v.co.x * sx, v.co.y, v.co.z)))
                nv[self.l_wear] = v[wl]
                vm.append(nv)
            for f in pb.faces:
                vs = [vm[v.index] for v in f.verts]
                if sx < 0:
                    vs.reverse()
                try:
                    nf = self.bm.faces.new(vs)
                except ValueError:
                    continue
                nf[self.l_mat] = si
                nf[self.l_tint] = t
                nf.smooth = True
            for e in pb.edges:
                ne = self.bm.edges.get((vm[e.verts[0].index], vm[e.verts[1].index]))
                if ne is not None:
                    ne.smooth = e.smooth
        pb.free()

    # --- primitives --------------------------------------------------------
    def box(self, mat, x0, x1, y0, y1, z0, z1, bev=0.5, wear=0.0, **kw):
        pb = self._new()
        bmesh.ops.create_cube(pb, size=1.0)
        w, h, d = abs(x1 - x0), abs(y1 - y0), abs(z1 - z0)
        for v in pb.verts:
            v.co = (v.co.x * w + (x0 + x1) / 2, v.co.y * h + (y0 + y1) / 2, v.co.z * d + (z0 + z1) / 2)
        if bev > 0:
            self._bevel(pb, list(pb.edges), min(bev, min(w, h, d) * 0.3), wear)
        self._fin(pb, mat, **kw)

    def prof(self, mat, pts, a0, a1, plane="zy", bev=0.5, wear=0.0, r=0.0, rn=1, capbev=(True, True), seg=None, **kw):
        """Extrude a 2D outline. plane 'zy': pts are (z, y), extruded over x in [a0, a1];
        'xy': (x, y) extruded along z; 'xz': (x, z) extruded along y."""
        if r > 0:
            pts = rnd(pts, r, rn)
        else:
            pts = [(p[0], p[1]) for p in pts]
        if plane == "zy":
            P = lambda u, v, a: (a, v, u)
        elif plane == "xy":
            P = lambda u, v, a: (u, v, a)
        else:
            P = lambda u, v, a: (u, a, v)
        pb = self._new()
        v0 = [pb.verts.new(P(u, v, a0)) for (u, v) in pts]
        v1 = [pb.verts.new(P(u, v, a1)) for (u, v) in pts]
        f0 = pb.faces.new(v0)
        f1 = pb.faces.new(list(reversed(v1)))
        n = len(pts)
        for i in range(n):
            j = (i + 1) % n
            pb.faces.new((v0[j], v0[i], v1[i], v1[j]))
        bmesh.ops.recalc_face_normals(pb, faces=list(pb.faces))
        if bev > 0:
            rim = []
            if capbev[0]:
                rim += list(f0.edges)
            if capbev[1]:
                rim += list(f1.edges)
            self._bevel(pb, rim, min(bev, abs(a1 - a0) * 0.45), wear, seg)
        self._fin(pb, mat, **kw)

    def lathe(self, mat, prof, c=(0.0, 0.0), ax="z", seg=16, caps=(True, True), o=None, a=None, phase=0.0, **kw):
        """Revolve (t, radius[, wear]) around an axis. ax 'z': t is z, c = (x, y);
        'x': t is x, c = (y, z); 'y': t is y, c = (x, z); or give origin o and direction a."""
        if o is None:
            if ax == "z":
                o, a = (c[0], c[1], 0.0), (0, 0, 1)
            elif ax == "x":
                o, a = (0.0, c[0], c[1]), (1, 0, 0)
            else:
                o, a = (c[0], 0.0, c[1]), (0, 1, 0)
        u, v, a = frame_of(a)
        o = Vector(o)
        pb = self._new()
        wl = pb.verts.layers.float["wear"]
        rings = []
        for p in prof:
            t, r = p[0], max(p[1], 0.01)
            ring = []
            for i in range(seg):
                ang = 2 * math.pi * (i + phase) / seg
                vert = pb.verts.new(o + a * t + (u * math.cos(ang) + v * math.sin(ang)) * r)
                if len(p) > 2:
                    vert[wl] = p[2]
                ring.append(vert)
            rings.append(ring)
        for k in range(len(rings) - 1):
            r0, r1 = rings[k], rings[k + 1]
            for i in range(seg):
                j = (i + 1) % seg
                pb.faces.new((r0[i], r0[j], r1[j], r1[i]))
        if caps[0]:
            pb.faces.new(list(reversed(rings[0])))
        if caps[1]:
            pb.faces.new(rings[-1])
        self._fin(pb, mat, **kw)

    def rod(self, mat, p0, p1, r, seg=8, bev=0.0, r1=None, **kw):
        d = Vector(p1) - Vector(p0)
        ln = d.length
        r1 = r if r1 is None else r1
        if bev > 0:
            prof = [(0, r - bev), (bev, r), (ln - bev, r1), (ln, r1 - bev)]
        else:
            prof = [(0, r), (ln, r1)]
        self.lathe(mat, prof, o=p0, a=d, seg=seg, **kw)

    def pin(self, mat, x, y, z, r, h=0.5, side=1, seg=8, **kw):
        """Small round head sitting on a side face (x = const), pointing along +-x."""
        self.lathe(mat, [(0.0, r), (h * 0.6, r), (h, r * 0.72)], o=(x, y, z), a=(side, 0, 0), seg=seg, caps=(False, True), **kw)

    def loft(self, mat, rings, caps=(True, True), **kw):
        pb = self._new()
        vr = [[pb.verts.new(p) for p in ring] for ring in rings]
        n = len(vr[0])
        for k in range(len(vr) - 1):
            for i in range(n):
                j = (i + 1) % n
                pb.faces.new((vr[k][i], vr[k][j], vr[k + 1][j], vr[k + 1][i]))
        if caps[0]:
            pb.faces.new(list(reversed(vr[0])))
        if caps[1]:
            pb.faces.new(vr[-1])
        self._fin(pb, mat, **kw)

    def decal(self, mat, pts, nrm, **kw):
        """Flat polygon floating just above a surface (markings, dark slots)."""
        pb = self._new()
        f = pb.faces.new([pb.verts.new(p) for p in pts])
        f.normal_update()
        if f.normal.dot(Vector(nrm)) < 0:
            f.normal_flip()
        self._fin(pb, mat, keepn=True, **kw)

    def slot_r(self, mat, ang, r, z0, z1, w, c=(0.0, 0.0), ends=True, **kw):
        """Stadium-shaped decal on a face/tangent plane at angle `ang` (deg, from +x toward +y)
        around the z axis through c, at distance r."""
        a = math.radians(ang)
        n = (math.cos(a), math.sin(a))
        t = (-n[1], n[0])
        hw = w / 2
        k = min(hw * 0.7, abs(z1 - z0) * 0.3)
        if ends:
            loc = [(-hw, z0 + k), (-hw * 0.45, z0), (hw * 0.45, z0), (hw, z0 + k), (hw, z1 - k), (hw * 0.45, z1), (-hw * 0.45, z1), (-hw, z1 - k)]
        else:
            loc = [(-hw, z0), (hw, z0), (hw, z1), (-hw, z1)]
        pts = [(c[0] + n[0] * r + t[0] * u, c[1] + n[1] * r + t[1] * u, z) for (u, z) in loc]
        self.decal(mat, pts, (n[0], n[1], 0), **kw)

    def patch_x(self, mat, x, pts_zy, r=0.0, **kw):
        """Decal on a side plane x = const from a (z, y) outline; faces away from the gun."""
        if r > 0:
            pts_zy = rnd(pts_zy, r, 1)
        self.decal(mat, [(x, p[1], p[0]) for p in pts_zy], (1 if x > 0 else -1, 0, 0), **kw)

    def disc(self, mat, c, nrm, r, seg=10, **kw):
        u, v, a = frame_of(nrm)
        c = Vector(c)
        self.decal(mat, [c + (u * math.cos(2 * math.pi * i / seg) + v * math.sin(2 * math.pi * i / seg)) * r for i in range(seg)], nrm, **kw)

    def rail(self, mat, z0, z1, ytop, base=True, wear=0.35, pitch=10.0, tooth=4.9, cx=0.0, **kw):
        """MIL-STD-1913 rail along z with its top at ytop: undercut base bar + teeth."""
        za, zb = min(z0, z1), max(z0, z1)
        if base:
            half = [(7.8, ytop - 9.0), (7.8, ytop - 5.6), (10.6, ytop - 3.6), (10.6, ytop - 3.0)]
            self.prof(mat, [(p[0] + cx, p[1]) for p in mirror_x(half)], za, zb, plane="xy", bev=0.3)
        n = int((zb - za - tooth) // pitch) + 1
        start = za + ((zb - za) - ((n - 1) * pitch + tooth)) / 2
        pb = self._new()
        wl = pb.verts.layers.float["wear"]
        for i in range(n):
            a = start + i * pitch
            b = a + tooth
            bot = [pb.verts.new((cx + x, ytop - 3.05, z)) for (x, z) in ((-10.6, a), (10.6, a), (10.6, b), (-10.6, b))]
            mid = [pb.verts.new((cx + x, ytop - 2.3, z)) for (x, z) in ((-10.6, a), (10.6, a), (10.6, b), (-10.6, b))]
            top = [pb.verts.new((cx + x, ytop, z)) for (x, z) in ((-8.3, a + 0.25), (8.3, a + 0.25), (8.3, b - 0.25), (-8.3, b - 0.25))]
            for vv in top:
                vv[wl] = wear
            for k in range(4):
                j = (k + 1) % 4
                pb.faces.new((bot[k], bot[j], mid[j], mid[k]))
                pb.faces.new((mid[k], mid[j], top[j], top[k]))
            pb.faces.new(top)
        bmesh.ops.recalc_face_normals(pb, faces=list(pb.faces))
        self._fin(pb, mat, sharp=62.0, **kw)


# ---------------------------------------------------------------------------
# Shared AR-15 parts.  Gun space: z = 0 at the rear face of the upper receiver.
# ---------------------------------------------------------------------------
def ar_receiver(g, grip="fde", flat_top=True):
    # upper receiver: front-view section extruded along the bore
    top = 27.8 if flat_top else 19.5
    half = [(13.2, -19.0), (15.4, -16.0), (15.4, 4.5), (14.2, 10.0), (11.6, 15.0), (9.4, 19.5), (9.4, top)]
    g.prof("gun", mirror_x(half), -198, 0, plane="xy", bev=0.9, wear=0.5)
    # ejection port with the bolt carrier showing, dust cover folded down, hinge
    g.patch_x("void", 15.75, [(-168, -11), (-100, -11), (-100, 3.5), (-168, 3.5)], r=2.0)
    g.box("steel_d", 15.5, 16.3, -8.5, 1.5, -165, -104, bev=0.4, soft=True)
    g.patch_x("void", 16.4, [(-150, -6.5), (-128, -6.5), (-128, -0.5), (-150, -0.5)], r=1.5)
    g.box("gun", 15.3, 17.2, -27.5, -13.2, -170, -98, bev=0.6)
    g.box("gun_d", 17.0, 17.9, -24.5, -16.0, -160, -108, bev=0.4, soft=True)
    g.rod("steel_d", (16.2, -12.6, -176), (16.2, -12.6, -93), 1.3, seg=6)
    # brass deflector and forward assist
    g.prof("gun", [(-93, -10), (-72, -10), (-72, 7), (-86, 7)], 14.0, 21.0, bev=1.2, r=1.2,
           warp=lambda x, y, z: (x - max(0.0, (y + 2) * 0.28) if x > 16 else x, y, z))
    g.rod("gun", (12.5, 1.5, -68), (22.5, 1.5, -34), 6.4, seg=10, bev=0.8)
    g.rod("gun_d", (22.2, 1.5, -35), (24.2, 1.5, -28), 7.3, seg=10, bev=0.7)
    # charging handle
    g.box("gun_d", -19, 19, 16.5, 23.0, 0.2, 9.5, bev=0.9)
    g.box("gun_d", -25, -14.5, 15.5, 24.0, -3.0, 10.5, bev=0.9)
    g.box("gun_d", -8.5, 8.5, 17.0, 22.5, -12, 1, bev=0.5)

    # lower receiver: magazine well + fire-control body
    well = [(-193, -20), (-194.5, -34), (-191, -67, 1.2), (-124, -61, 1.2), (-119, -46), (-119, -20)]
    g.prof("gun", well, -14.3, 14.3, bev=1.0, wear=0.5, r=2.5)
    body = [(-121, -19.5, 0), (-121, -44.5, 0), (-50, -44.5), (-44, -49), (-6, -49), (6, -40), (15, -30), (19.5, -20),
            (19.5, -5), (1.5, -5, 0), (1.5, -19.5, 0)]
    g.prof("gun", body, -12.6, 12.6, bev=0.9, wear=0.5, r=2.0)
    # magwell relief panels and front pivot lug
    for sx in (1, -1):
        g.patch_x("gun_d", sx * 14.62, [(-186, -30), (-128, -30), (-128, -57), (-183.5, -61.5)], r=3.0)
    # buffer tower ring
    g.lathe("gun", [(1.5, 16.2), (2.3, 17.4), (18.6, 17.4), (19.5, 16.4)], seg=16, caps=(True, True))
    # pins
    for sx in (1, -1):
        g.pin("steel_d", sx * 14.3, -27, -181, 3.0, h=0.7, side=sx)
        g.pin("steel_d", sx * 12.6, -27, -21, 3.0, h=0.7, side=sx)
        g.pin("gun_d", sx * 12.6, -33.5, -71, 1.9, h=0.5, side=sx, seg=6)
        g.pin("gun_d", sx * 12.6, -27.5, -49, 1.9, h=0.5, side=sx, seg=6)
    # selector (lever left, indicator right), bolt catch, magazine release
    g.pin("gun_d", -12.6, -30.5, -33, 4.4, h=1.6, side=-1, seg=10)
    g.box("gun_d", -15.6, -13.6, -32.3, -28.7, -52, -34, bev=0.6)
    g.pin("gun_d", 12.6, -30.5, -33, 3.6, h=0.8, side=1, seg=10)
    g.patch_x("white", 13.75, [(-36.5, -30.9), (-30, -30.9), (-30, -30.1), (-36.5, -30.1)])
    g.patch_x("white", -12.95, [(-58, -31.2), (-55.5, -31.2), (-55.5, -29.8), (-58, -29.8)])
    g.patch_x("red", -12.95, [(-34, -39.5), (-31.5, -39.5), (-31.5, -38.1), (-34, -38.1)])
    g.box("gun_d", -17.2, -14.0, -31, -13.5, -127.5, -113.5, bev=0.8)
    g.box("gun_d", -17.9, -16.9, -19.5, -14.5, -126.5, -114.5, bev=0.3, soft=True)
    g.box("gun_d", 14.0, 16.6, -34.5, -26.5, -121, -110, bev=0.9)
    g.prof("gun", [(-131, -23), (-103, -23), (-103, -25), (-131, -25)], 14.0, 15.6, bev=0.4)
    # trigger guard and trigger
    g.prof("gun", [(-121, -60.5), (-52, -70.5), (-48, -68), (-50, -65.8), (-119, -56.2)], -4.2, 4.2, bev=0.6)
    g.prof("steel_d", [(-86, -44), (-78.5, -44), (-79.5, -52), (-83, -59.5), (-86.2, -61), (-86, -53)], -2.3, 2.3, bev=0.6, r=0.8)

    # pistol grip: raked loft with a beavertail
    gm = grip
    secs = [(-43.5, -27, 21.5, 12.6, 3.2), (-50, -25.5, 21, 13.6, 3.0), (-66, -20, 20, 14.6, 2.7), (-92, -9.5, 19.5, 15.0, 2.6),
            (-118, 2, 19.5, 14.8, 2.6), (-131, 8, 19.5, 14.2, 2.8), (-134, 9.5, 18.3, 13.2, 2.8)]
    g.loft(gm, [sup_xz(y, cz, rx, rz, e=e, n=14) for (y, cz, rz, rx, e) in secs], caps=(False, True), sharp=70)
    g.prof(gm, [(-12, -44), (8, -33), (16, -24), (19.4, -24), (14, -40), (2, -52), (-12, -52)], -10.5, 10.5, bev=2.5, r=2.0)
    gd = "fde_d" if gm == "fde" else "poly_l"
    psec = [(-62, -20.5, 12.5, 15.3), (-78, -14.5, 13.5, 15.9), (-100, -5.5, 13.5, 16.0), (-122, 4, 12.5, 15.5)]
    g.loft(gd, [sup_xz(y, cz, rx, rz, e=3.2, n=12) for (y, cz, rz, rx) in psec], caps=(True, True), sharp=75)


def ar_mag(g, mat="gun_l"):
    front = [(-185.5, -22), (-185.5, -97), (-188.5, -126), (-194.5, -153), (-202, -179)]
    rear = [(-141.5, -195), (-134, -166), (-127.5, -133), (-124, -98), (-124, -22)]
    g.prof(mat, front + rear, -11.3, 11.3, bev=1.3, wear=0.45)
    # pressed stiffening ribs following the curve
    def band(f0, f1):
        a = [(f[0] + (r[0] - f[0]) * f0, f[1] + (r[1] - f[1]) * f0) for f, r in zip(front[1:], reversed(rear[:-1]))]
        b = [(f[0] + (r[0] - f[0]) * f1, f[1] + (r[1] - f[1]) * f1) for f, r in zip(front[1:], reversed(rear[:-1]))]
        a[0] = (a[0][0], -70)
        b[0] = (b[0][0], -70)
        return a + list(reversed(b))
    g.prof(mat, band(0.16, 0.36), -12.0, 12.0, bev=0.6)
    g.prof(mat, band(0.62, 0.84), -12.0, 12.0, bev=0.6)
    g.prof("gun_d", [(-204.5, -177.5), (-140.5, -194.5), (-139.5, -198.5), (-205.5, -181.5)], -12.6, 12.6, bev=0.9)


def a2_flash_hider(g, z0, mat="gun_l"):
    """A2 birdcage; z0 = barrel shoulder, returns the muzzle z."""
    zt = z0 - 44.5
    g.lathe("gun_d", [(z0 + 0.2, 8.0), (z0, 10.2), (z0 - 2.6, 10.2), (z0 - 2.8, 8.5)], seg=12, caps=(False, False))
    g.lathe(mat, [(z0 - 2.8, 9.4), (z0 - 3.6, 11.0, 0.4), (z0 - 13.0, 11.0), (z0 - 13.8, 10.3), (z0 - 15.2, 10.3), (z0 - 16.0, 11.0),
                  (zt + 1.0, 11.0), (zt, 10.0, 0.6), (zt, 6.2, 0.3), (zt + 30, 6.0)], seg=16, caps=(False, True))
    for ang in (90, 90 - 62, 90 + 62, 90 - 124, 90 + 124):
        g.slot_r("void", ang, 11.25, zt + 4.5, zt + 27, 3.4)
    return zt


def ar_stock_tube(g):
    g.box("gun_d", -15.5, 15.5, -24, 17.5, 19.6, 22.6, bev=0.8)
    g.lathe("gun_d", [(22.6, 15.6), (23.4, 17.0), (31.5, 17.0), (32.3, 15.8)], seg=12, caps=(False, False))
    g.lathe("gun_l", [(32, 14.6), (200, 14.6), (201, 13.6)], seg=14, caps=(False, True))


# ---------------------------------------------------------------------------
# M4A1 -- 14.5" barrel, free-float M-LOK rail, holographic sight, collapsed stock
# ---------------------------------------------------------------------------
def build_m4():
    muz = [0, 0.045, -0.76]
    Z_MUZ = -588.5
    g = Gun("m4", 0.79 / (588.5 - 27.0) * 1000, (0, 0, Z_MUZ), muz)
    ar_receiver(g, grip="fde")
    ar_mag(g)
    ar_stock_tube(g)

    # free-float handguard
    hg0, hg1 = -201.0, -468.0
    half = [(7.5, -21.2), (15.2, -16.8), (19.5, -8.2), (19.5, 8.2), (15.2, 16.4), (10.6, 20.6), (10.6, 22.0)]
    g.prof("bronze", mirror_x(half), hg1, hg0, plane="xy", bev=0.9, wear=0.55)
    g.lathe("gun_d", [(hg0 + 0.5, 20.5), (hg0 + 3.0, 20.5)], seg=12, caps=(False, False))
    g.disc("void", (0, 0, hg1 - 0.25), (0, 0, -1), 15.6, seg=12)
    for i in range(6):
        za = hg0 - 22 - i * 41.0
        for ang, r, w in ((0, 19.8, 7.0), (180, 19.8, 7.0), (-90, 21.5, 7.0)):
            g.slot_r("void", ang, r, za - 32, za, w)
        for ang, r in ((27.7, 21.45), (152.3, 21.45), (-29.8, 21.15), (-150.2, 21.15)):
            g.slot_r("void", ang, r, za - 27, za - 5, 4.6)
    for sx in (1, -1):
        g.pin("steel", sx * 19.5, -3.5, hg0 - 9, 2.4, h=0.8, side=sx, seg=8)
        g.pin("steel", sx * 19.5, 3.5, hg0 - 9, 2.4, h=0.8, side=sx, seg=8)
        # Textured dark-polymer M-LOK rail grip panels where the support hand wraps
        g.box("poly_l", sx * 19.3, sx * 21.4, -7.2, 7.2, hg0 - 165, hg0 - 46, bev=0.9)
        for ri in range(8):
            rz = hg0 - 54 - ri * 14.2
            g.box("rubber", sx * 21.1, sx * 22.0, -5.8, 5.8, rz - 4.5, rz + 4.5, bev=0.4, soft=True)
    # Compact low-profile tactical laser/illuminator module on front top rail (stays well below holo sight line)
    g.box("fde_d", -14.5, 14.5, 31.0, 42.2, -424, -366, bev=1.5, wear=0.45)
    g.box("gun_d", -15.5, 15.5, 30.8, 35.2, -418, -372, bev=0.7)
    g.rod("steel_d", (12.0, 38.0, -424), (12.0, 38.0, -429), 3.2, seg=8)
    g.disc("lens", (12.0, 38.0, -429.2), (0, 0, -1), 2.5, seg=8)
    g.rod("gun_l", (-8.5, 38.0, -424), (-8.5, 38.0, -428), 3.8, seg=8)
    g.disc("lens", (-8.5, 38.0, -428.2), (0, 0, -1), 3.0, seg=8)
    g.rod("steel_d", (0.0, 42.0, -395), (0.0, 44.0, -395), 4.2, seg=10, bev=0.4)
    # top rail: receiver + handguard
    g.rail("gun", -197, -3, 30.8, base=False, wear=0.55)
    g.rail("bronze", hg1 + 1, hg0 - 1, 30.8, base=True, wear=0.55)

    # barrel (government profile) and flash hider
    g.lathe("gun_l", [(-455, 9.4), (-486, 9.4), (-488, 8.1), (-520, 8.1), (-522, 9.3), (-543.0, 9.3)], seg=14, caps=(False, False))
    zt = a2_flash_hider(g, -544.0)
    assert abs(zt - Z_MUZ) < 0.6, zt

    # Sculpted EOTech EXPS-style holographic sight (tapered dual-shroud hood, steel turrets, QD lever)
    SY = 68.0
    # Lower rail riser & battery body with chamfered flanks
    g.box("gun_d", -15.2, 15.2, 31.0, 51.0, -130, -43, bev=1.8, wear=0.55)
    g.box("gun_l", -17.6, 17.6, 31.2, 37.5, -122, -49, bev=1.0, wear=0.5)
    # Tapered outer protective aluminum hood (sleeker chamfered silhouette, not a thick square brick)
    arch = [
        (-20.4, 46.5), (-19.2, 77.5, 3.8), (-15.0, 83.2, 3.6), (15.0, 83.2, 3.6), (19.2, 77.5, 3.8), (20.4, 46.5),
        (17.2, 46.5, 0), (16.4, 76.2, 2.2), (13.8, 79.6, 2.2), (-13.8, 79.6, 2.2), (-16.4, 76.2, 2.2), (-17.2, 46.5, 0),
    ]
    g.prof("gun_d", arch, -92, -44, plane="xy", bev=1.1, wear=0.65, r=2.0)
    # Recessed brushed-slate inner optic bezel framing the coated glass window
    bezel = [
        (-16.8, 49.0), (-16.2, 75.8, 2.0), (-13.6, 79.0, 2.0), (13.6, 79.0, 2.0), (16.2, 75.8, 2.0), (16.8, 49.0),
        (14.8, 49.0, 0), (14.4, 74.6, 1.5), (12.4, 77.0, 1.5), (-12.4, 77.0, 1.5), (-14.4, 74.6, 1.5), (-14.8, 49.0, 0),
    ]
    g.prof("gun_l", bezel, -76, -54, plane="xy", bev=0.6, wear=0.5, r=1.5)
    # Forward tapered battery hood + transverse CR123 battery cap
    g.prof("gun_d", [(-114, 50.5), (-91, 50.5), (-91, 63.5), (-99, 63.5)], -16.2, 16.2, bev=1.4, wear=0.5)
    g.rod("gun_d", (-19.0, 43.5, -118), (19.0, 43.5, -118), 7.8, seg=14, bev=1.0)
    g.pin("steel_d", 19.0, 43.5, -118, 5.4, h=1.2, side=1, seg=12)
    g.pin("steel", -19.0, 43.5, -118, 4.6, h=0.9, side=-1, seg=10)
    # Right-side machined steel windage & elevation adjustment turrets
    g.pin("steel_d", 19.4, 62.0, -76, 4.2, h=2.4, side=1, seg=10)
    g.pin("steel", 21.8, 62.0, -76, 2.6, h=0.6, side=1, seg=8)
    g.pin("steel_d", 19.4, 62.0, -59, 4.2, h=2.4, side=1, seg=10)
    g.pin("steel", 21.8, 62.0, -59, 2.6, h=0.6, side=1, seg=8)
    # Left-side quick-detach throw lever + steel mount bolt
    g.box("gun_l", -19.8, -17.0, 32.0, 40.5, -99, -60, bev=1.0, wear=0.5)
    g.rod("steel", (-21.0, 36.2, -80), (-17.0, 36.2, -80), 3.6, seg=10)
    # Rear brightness/NV control pads + glowing red NV indicator dot
    for bx in (-6.5, 0, 6.5):
        g.box("poly_l", bx - 2.2, bx + 2.2, 38.5, 44.0, -43.2, -41.8, bev=0.45, soft=True)
    g.box("red", -1.4, 1.4, 45.2, 47.4, -43.2, -42.0, bev=0.25, soft=True)
    # Sculpted folded back-up sights with steel hinge pins
    g.box("poly_l", -11.0, 11.0, 30.9, 41.2, -36, -6, bev=1.5)
    g.box("gun_l", -6.5, 6.5, 41.0, 43.4, -33, -12, bev=0.7, wear=0.4)
    g.rod("steel_d", (-11.6, 36.5, -14), (11.6, 36.5, -14), 1.8, seg=8)
    g.box("poly_l", -11.0, 11.0, 30.9, 40.5, -462, -428, bev=1.5)
    g.box("gun_l", -6.5, 6.5, 40.3, 42.4, -458, -436, bev=0.7, wear=0.4)

    # collapsed carbine stock
    out = [(50, 17.5), (58, 22), (176, 23.5), (197, 21), (199, -74), (191, -80), (176, -77), (126, -31), (96, -22.5), (54, -21.5), (49, -17)]
    g.prof("fde", out, -16.5, 16.5, bev=3.2, wear=0.4, r=3.0, seg=2)
    g.lathe("fde", [(52, 17.2), (54, 19.6), (184, 19.6), (187, 17.5)], seg=14, caps=(True, False), c=(0, 0.5))
    for sx in (1, -1):
        g.patch_x("fde_d", sx * 16.75, [(138, -28), (188, -24), (188, -66), (180, -68)], r=3.0)
    g.box("fde_d", -6.5, 6.5, -28.5, -21, 60, 96, bev=1.6)
    g.prof("rubber", [(198.5, 22), (204.5, 20), (206, -72), (199.5, -79)], -17.5, 17.5, bev=2.2, r=2.0)
    for i in range(5):
        y = 10 - i * 17
        g.decal("void", [(-15, y - 1.2, 206.1 + (0.02 if y < -70 else 0)), (15, y - 1.2, 206.1), (15, y + 1.2, 206.1), (-15, y + 1.2, 206.1)], (0, 0, 1))
    # sling loop on the end plate
    g.rod("steel_d", (-15.5, -8, 21), (-22, -8, 21), 1.5, seg=6)
    g.rod("steel_d", (-22, -8, 21), (-22, -22, 21), 1.5, seg=6)

    g.points.update({
        "muzzle": muz, "left": [0, 0.015, -0.31], "right": [0, -0.035, 0.03], "mag": [0, -0.12, -0.11],
        "sight": g.game(0, SY, -43), "eject": g.game(16.5, -4, -134),
    })
    return g


# ---------------------------------------------------------------------------
# Beretta M9.  Gun space: z = 0 at the muzzle, rear is +z.
# ---------------------------------------------------------------------------
def build_m9():
    muz = [0, 0.04, -0.16]
    g = Gun("m9", 0.19 / 173.0 * 1000, (0, 0, 0), muz)
    SY = 18.2
    # barrel (visible through the open slide) with crowned muzzle and squared breech
    g.lathe("gun_l", [(14, 4.5), (0.6, 4.5), (0, 5.2, 0.5), (0, 6.3, 0.6), (0.9, 7.0, 0.4), (112, 7.0)], seg=16, caps=(True, False))
    g.box("gun_l", -8.2, 8.2, -8, 8.6, 101, 121, bev=1.2, wear=0.4)
    # slide: nose ring, the two open-top rails, rear block
    nose = [(8.5, -21.5), (13.9, -15.5), (13.9, 5.5), (12.6, 10.0), (9.2, 12.9), (4.5, 13.6)]
    g.prof("gun", mirror_x(nose), 8, 37, plane="xy", bev=0.9, wear=0.5,
           warp=lambda x, y, z: (x, y, z + (max(0.0, -10 - y) * 0.55 if z > 20 else 0.0)))
    wall = [(13.9, -10.5), (13.9, 4.8), (12.9, 7.6), (10.6, 8.6), (9.6, 7.6), (9.6, -10.5)]
    g.prof("gun", wall, 36, 119, plane="xy", bev=0.5, wear=0.5, mx=True)
    g.box("gun_d", -9.7, 9.7, -10.3, -5.5, 36, 119, bev=0)
    rear = [(13.9, -10.5), (13.9, 5.5), (12.6, 10.0), (9.2, 12.9), (4.5, 13.6)]
    g.prof("gun", mirror_x(rear), 118, 197, plane="xy", bev=0.9, wear=0.5)
    # breech face detail, extractor, firing pin block
    g.box("steel_d", 13.6, 14.5, 1.5, 4.8, 122, 146, bev=0.4, soft=True)
    g.patch_x("red", 14.25, [(140, 2.2), (144, 2.2), (144, 4.0), (140, 4.0)])
    g.box("gun_d", -3.5, 3.5, 13.0, 14.1, 150, 163, bev=0.4, soft=True)
    # cocking serrations (both sides)
    n_ser = 9
    for i in range(n_ser):
        z = 163.5 + i * 3.4
        for sx in (1, -1):
            g.patch_x("void", sx * 14.05, [(z, -8.5), (z + 1.5, -8.5), (z + 1.5, 5.0), (z, 5.0)])
    # ambidextrous safety / decocking levers
    for sx in (1, -1):
        g.pin("gun_d", sx * 13.9, 0.5, 187.5, 4.6, h=1.4, side=sx, seg=10)
        g.prof("gun_d", [(170, 1.2), (188, -2.6), (190, 3.0), (172, 4.2)], sx * 14.6, sx * 18.2, bev=0.8, r=0.8)
        g.patch_x("red", sx * 14.0, [(176, -5.2), (179, -5.2), (179, -2.6), (176, -2.6)], r=0.8)
    # sights
    g.prof("gun_d", [(12, 13.2), (22.5, 13.2), (21.5, SY), (16.5, SY)], -1.9, 1.9, bev=0.35)
    g.disc("white", (0, 16.0, 22.25), (0, 0.15, 1), 1.0, seg=8)
    rs = [(-7.5, 13.0), (-7.5, SY - 0.8, 0.8), (-6.7, SY, 0), (-2.1, SY, 0), (-2.1, 15.4, 0), (2.1, 15.4, 0), (2.1, SY, 0), (6.7, SY, 0),
          (7.5, SY - 0.8, 0.8), (7.5, 13.0)]
    g.prof("gun_d", rs, 181.5, 190.5, plane="xy", bev=0.4, r=0.01)
    g.disc("white", (0, 14.2, 190.6), (0, 0, 1), 1.0, seg=8)
    # recoil guide rod
    g.lathe("steel_d", [(7.6, 3.4), (6.9, 3.4), (6.6, 2.6)], seg=10, c=(0, -14.5), caps=(False, False))
    g.disc("steel_d", (0, -14.5, 6.6), (0, 0, -1), 2.6, seg=10)

    # frame (anodized alloy)
    frame = [(28, -10.2, 0), (35, -25.5), (143, -26.5), (200, -29), (207.5, -23), (212.5, -14.5), (207, -10.2)]
    g.prof("gun_d", frame, -13.0, 13.0, bev=0.9, wear=0.45, r=2.2)
    guard = [(90, -24), (89.5, -41), (93, -54, 3), (101, -57.5, 3), (133, -57.5, 4), (141.5, -50, 4), (143.5, -38), (138.5, -38),
             (136.5, -47.5, 3), (130.5, -52.5, 3), (102.5, -52.5, 3), (97.5, -49, 3), (95, -38), (96.5, -24)]
    g.prof("gun_d", guard, -6.2, 6.2, bev=1.3, r=2.0, rn=2)
    g.prof("steel_d", [(111.5, -25), (120, -25), (118.5, -35), (115, -44.5), (111, -47), (110.2, -40)], -2.9, 2.9, bev=0.8, r=1.2)
    # grip frame: straps
    gs = [(-27, 141.5, 204.5, 12.4), (-40, 141.5, 197.5, 12.4), (-60, 145.5, 198.5, 12.4), (-88, 152, 203.5, 12.4),
          (-108, 156.5, 207.5, 12.4), (-120, 159, 210, 12.4)]
    g.loft("gun_d", [sup_xz(y, (zf + zb) / 2, rx, (zb - zf) / 2, e=4.5, n=16) for (y, zf, zb, rx) in gs], caps=(False, True), sharp=70)
    # grip panels with medallion, screws and grooves
    panel = [(146.5, -35, 3), (192.5, -33, 3), (195.5, -44), (197, -62), (201.5, -88), (204, -113, 3), (161, -114.5, 3), (155, -89), (149, -59)]
    for sx in (1, -1):
        g.prof("poly", panel, sx * 12.0, sx * 16.4, bev=1.9, r=2.5, capbev=(sx < 0, sx > 0), tint=0.6)
        for i in range(8):
            y = -60 - i * 5.6
            zf = 151.5 + (-58 - y) * 0.215
            zb = 195.0 + (-58 - y) * 0.155
            g.patch_x("void", sx * 16.62, [(zf, y), (zb, y), (zb, y + 1.5), (zf, y + 1.5)])
        g.disc("poly_l", (sx * 16.62, -45.5, 171), (sx, 0, 0), 5.2, seg=12)
        g.pin("steel_d", sx * 16.4, -107.5, 182, 2.4, h=0.5, side=sx, seg=8)
        g.pin("steel_d", sx * 16.4, -38.5, 156, 2.0, h=0.4, side=sx, seg=8)
    g.prof("poly", [(156.5, -119), (211.5, -119), (213, -124.5), (155, -124.5)], -13.6, 13.6, bev=1.2, r=1.2)
    # hammer, slide stop, take-down lever, magazine release
    g.prof("steel_d", [(197.5, -13), (203, -11), (209, -4), (214.5, 6), (212.5, 10.5), (207, 9), (203.5, 2), (197.5, -2)], -3.3, 3.3, bev=0.9, r=1.5)
    g.patch_x("void", 3.35, [(207, 1), (210.5, 2.5), (211.5, 6.5), (208.5, 6)], r=0.8)
    g.patch_x("void", -3.35, [(207, 1), (210.5, 2.5), (211.5, 6.5), (208.5, 6)], r=0.8)
    g.prof("gun_l", [(118, -17.5), (150, -17.5), (153, -13.5), (150, -11.8), (118, -12.6)], -15.4, -13.0, bev=0.6, r=0.8)
    g.box("gun_l", -16.6, -15.0, -17.5, -12.2, 141, 152, bev=0.5)
    g.pin("gun_l", 13.0, -15, 121, 2.6, h=0.6, side=1, seg=8)
    g.pin("gun_l", -13.0, -17.5, 73, 4.2, h=1.2, side=-1, seg=10)
    g.prof("gun_l", [(58, -21), (74, -20.5), (75, -16.5), (58, -18)], -15.2, -13.4, bev=0.5, r=0.6)
    g.pin("gun_l", 13.0, -17.5, 73, 2.6, h=0.9, side=1, seg=8)
    g.pin("gun_l", -12.6, -46, 147.5, 3.6, h=2.2, side=-1, seg=10)
    # lanyard loop
    g.rod("steel_d", (-3, -113, 210.5), (-3, -121, 213.5), 1.2, seg=6)
    g.rod("steel_d", (3, -113, 210.5), (3, -121, 213.5), 1.2, seg=6)

    g.points.update({
        "muzzle": muz, "left": [0.0, -0.05, 0.035], "right": [0, -0.04, 0.03], "mag": [0, -0.09, 0.03],
        "sight": g.game(0, SY, 190.5), "eject": g.game(9, 8, 108),
    })
    return g


# ---------------------------------------------------------------------------
# Shared helpers for the new weapons
# ---------------------------------------------------------------------------
def ball(g, mat, c, r, seg=12, **kw):
    prof = [(r * math.cos(math.radians(a)), r * math.sin(math.radians(a))) for a in range(0, 181, 30)]
    g.lathe(mat, prof, o=c, a=(0, 0, 1), seg=seg, **kw)


def scope(g, ya, zo, zf, rt, rob, roc, rings, base_y, zt_elev, zt_wind, elev_h=24.0, w_ring=13.0):
    """Telescopic sight along -z with its axis at height ya. zo = ocular rear, zf = objective front."""
    ob_len = 70.0
    prof = [(zo, roc * 0.8), (zo - 2.0, roc * 0.97, 0.4), (zo - 12.0, roc, 0.2), (zo - 40.0, roc * 0.96), (zo - 62.0, rt + 2.5), (zo - 74.0, rt),
            (zf + ob_len + 20.0, rt), (zf + ob_len, rob * 0.8), (zf + ob_len - 8.0, rob, 0.3), (zf + 5.0, rob), (zf, rob * 0.93, 0.5)]
    g.lathe("gun", prof, c=(0, ya), seg=20, caps=(True, True))
    g.lathe("rubber", [(zo + 4.0, roc * 0.86), (zo + 3.0, roc * 1.0), (zo - 11.0, roc * 1.0), (zo - 12.0, roc * 0.94)], c=(0, ya), seg=20, caps=(False, False))
    g.disc("lens", (0, ya, zo + 4.05), (0, 0, 1), roc * 0.68, seg=16)
    g.disc("lens", (0, ya, zf - 0.1), (0, 0, -1), rob * 0.84, seg=20)
    g.lathe("gun_d", [(zf + 2.0, rob * 0.97), (zf - 1.0, rob * 1.04), (zf + 14.0, rob * 1.04), (zf + 16.0, rob)], c=(0, ya), seg=20, caps=(False, False))
    for z in rings:
        g.lathe("gun_d", [(z + 10.0, rt + 4.0), (z + 9.0, rt + 5.2, 0.3), (z - 9.0, rt + 5.2, 0.3), (z - 10.0, rt + 4.0)], c=(0, ya), seg=18, caps=(False, False))
        g.box("gun_d", -w_ring, w_ring, base_y - 0.5, ya - rt * 0.55, z - 10.0, z + 10.0, bev=1.2, wear=0.3)
        for sx in (1, -1):
            g.pin("steel_d", sx * (rt + 5.2), ya - 3.0, z, 2.6, h=0.9, side=sx, seg=8)
    # turrets: elevation (top), windage (right), parallax (left)
    r2 = rt * 0.66
    g.lathe("gun_d", [(ya + rt - 3, r2), (ya + rt + 0.5, r2 + 0.6), (ya + rt + elev_h * 0.4, r2 + 0.6), (ya + rt + elev_h * 0.42, r2 - 0.4), (ya + rt + elev_h, r2 - 0.2, 0.3), (ya + rt + elev_h + 1.5, r2 - 1.4)],
            ax="y", c=(0, zt_elev), seg=16)
    g.lathe("gun_d", [(rt - 3, r2 * 0.9), (rt + 0.5, r2 * 0.9 + 0.5), (rt + elev_h * 0.55, r2 * 0.9 + 0.5), (rt + elev_h * 0.57, r2 * 0.9 - 0.3), (rt + elev_h * 0.8, r2 * 0.9 - 0.2), (rt + elev_h * 0.85, r2 * 0.9 - 1.2)],
            ax="x", c=(ya, zt_wind), seg=14)
    g.lathe("gun_d", [(-(rt - 3), r2 * 0.95), (-(rt + 0.5), r2 * 0.95 + 0.4), (-(rt + elev_h * 0.55), r2 * 0.95 + 0.4), (-(rt + elev_h * 0.6), r2 * 0.8)],
            ax="x", c=(ya, zt_wind + 40.0), seg=14)


# ---------------------------------------------------------------------------
# AKM.  Gun space: z = 0 at the rear of the receiver, bore on y = 0.
# ---------------------------------------------------------------------------
def build_ak47():
    muz = [0, 0.04, -0.73]
    Z_MUZ = -631.0
    g = Gun("ak47", 0.77 / (631.0 - 26.0) * 1000, (0, 0, Z_MUZ), muz)
    SY = 40.0
    # stamped receiver trough, trunnion, dust cover with ribs
    g.prof("blued", mirror_x([(0, -38), (14, -38), (18.8, -33), (18.8, 17)]), -230, -1, plane="xy", bev=0.9, wear=0.5)
    g.box("blued", -17.8, 17.8, -34, 16, -248, -226, bev=1.4, wear=0.5)
    g.prof("blued", mirror_x([(17.6, 14), (19.2, 19), (19.5, 26), (16.5, 32), (9, 35)]), -228, -22, plane="xy", bev=1.0, wear=0.5)
    for sx in (-1, 1):
        g.box("blued", sx * 6.2 - 0.7, sx * 6.2 + 0.7, 34.6, 36.0, -222, -50, bev=0.3, wear=0.3)
    g.box("blued", 19.2, 20.3, 21.0, 24.2, -218, -48, bev=0.4, mx=True)
    g.box("blued", 19.2, 20.3, 9.0, 11.6, -218, -48, bev=0.4, mx=True)
    g.box("blued", -13, 13, -8, 14, -24, 0, bev=1.0, wear=0.4)
    g.lathe("steel_d", [(2.0, 3.8), (1.2, 4.6), (-4.0, 4.6)], c=(0, 6), seg=10, caps=(True, True))
    # rivets
    for sx in (1, -1):
        for (y, z) in ((-27, -206), (-27, -150), (-27, -105), (8, -236), (-18, -236), (-28, -20)):
            g.pin("steel_d", sx * 18.8, y, z, 2.2, h=0.6, side=sx, seg=8)
    # safety plate / selector (right), ejection port hidden below it
    g.prof("gun", [(-190, 3), (-62, 3), (-48, 9), (-40, 18), (-62, 23), (-190, 23)], 19.0, 20.6, bev=0.7, r=1.5)
    g.prof("gun", [(-62, 18), (-34, 15), (-26, 25), (-38, 32), (-52, 29)], 20.4, 22.4, bev=0.8, r=1.0)
    g.patch_x("void", 20.7, [(-176, 7), (-168, 7), (-168, 19), (-176, 19)])
    # charging handle on the bolt carrier
    g.rod("steel_d", (20, 14, -128), (31, 14, -128), 3.8, seg=8, bev=0.5)
    g.rod("steel_d", (31, 14, -128), (37, 20, -128), 3.8, seg=8)
    g.rod("steel_d", (36.5, 19.5, -128), (45, 26, -128), 6.4, seg=10, bev=1.0)
    # magwell, trigger guard, trigger, grip
    g.box("blued", -20.2, 20.2, -64, -30, -204, -119, bev=1.4, wear=0.5)
    g.prof("blued", [(-119, -44), (-119, -58), (-111, -66), (-74, -68), (-62, -59), (-62, -46), (-69, -46), (-71, -57), (-79, -62), (-106, -61), (-112, -56), (-112, -44)], -3.6, 3.6, bev=0.8, r=1.0)
    g.prof("steel_d", [(-99, -40), (-92, -40), (-96, -62), (-100, -56)], -2.2, 2.2, bev=0.5)
    g.box("steel_d", -5, 5, -66, -46, -114, -104, bev=0.8)
    secs = [(-40, -42, 19, 17, 3.0), (-64, -36, 18.5, 17.5, 2.8), (-92, -26, 18, 17.5, 2.8), (-120, -14, 18.5, 17.2, 2.8), (-134, -8, 19.5, 16.5, 3.0)]
    g.loft("wood_d", [sup_xz(y, cz, rx, rz, e=e, n=14) for (y, cz, rz, rx, e) in secs], caps=(True, True), sharp=70)
    # magazine: curved stamped steel, vertical ribs following the curve
    front = [(-191, -30), (-192, -100), (-202, -157), (-226, -208), (-254, -237)]
    rear = [(-184, -243), (-165, -214), (-146, -165), (-133, -100), (-130, -30)]
    g.prof("gun_l", front + rear, -16.0, 16.0, bev=1.2, wear=0.4)
    def band(f0, f1):
        a = [(f[0] + (r[0] - f[0]) * f0, f[1] + (r[1] - f[1]) * f0) for f, r in zip(front[1:], reversed(rear[:-1]))]
        b = [(f[0] + (r[0] - f[0]) * f1, f[1] + (r[1] - f[1]) * f1) for f, r in zip(front[1:], reversed(rear[:-1]))]
        a[0] = (a[0][0], -62)
        b[0] = (b[0][0], -62)
        return a + list(reversed(b))
    for f0, f1 in ((0.10, 0.20), (0.40, 0.50), (0.72, 0.82)):
        g.prof("gun_l", band(f0, f1), -16.9, 16.9, bev=0.5)
    g.prof("gun_d", [(-257, -236), (-182, -246), (-182, -251), (-258, -241)], -17.4, 17.4, bev=0.8)

    # wood furniture: stock, lower and upper handguard
    stock = [(2, 14), (60, 14), (150, 9), (240, 1), (251, -3), (252, -96), (245, -104), (170, -73), (110, -52), (60, -42), (2, -42)]
    g.prof("wood", stock, -19, 19, bev=3.0, wear=0.2, r=2.5, seg=2,
           warp=lambda x, y, z: (x * (0.8 + 0.2 * min(1.0, max(0.0, (z - 3.0) / 220.0))), y, z))
    g.prof("steel_d", [(250, -3), (256, -5), (256, -98), (249, -106), (245, -101)], -19, 19, bev=0.8, r=0.8)
    for i in range(5):
        y = -14 - i * 17
        g.decal("void", [(-15, y - 1.3, 256.15), (15, y - 1.3, 256.15), (15, y + 1.3, 256.15), (-15, y + 1.3, 256.15)], (0, 0, 1))
    for sx in (1, -1):
        g.pin("steel_d", sx * 15.6, -92, 250, 2.4, h=0.5, side=sx, seg=8)
    g.prof("wood", mirror_x([(0, -37), (13, -37), (20.5, -31), (23.5, -16), (23.5, 4)]), -447, -232, plane="xy", bev=1.4, wear=0.2, seg=2)
    g.prof("wood", mirror_x([(23.5, 2), (23.9, 10), (22.8, 22), (17.2, 30.5), (9, 32.8)]), -447, -302, plane="xy", bev=1.4, wear=0.2, seg=2)
    for sx in (1, -1):
        for i in range(4):
            z = -330 - i * 17
            g.patch_x("wood_d", sx * 23.62, [(z, -24), (z - 4.5, -24), (z - 4.5, -6), (z, -6)], r=0.8)
    g.prof("steel_d", mirror_x([(0, -39), (14, -39), (22, -33), (25, -18), (25, 8), (24, 14), (23, 24), (17, 32), (9, 34)]), -454, -447, plane="xy", bev=0.5)
    # barrel, gas tube, gas block, front sight, cleaning rod, slant brake
    g.lathe("gun_l", [(-232, 9.4), (-592, 8.7)], seg=14, caps=(False, False))
    g.lathe("blued", [(-300, 9.6), (-492, 9.6)], c=(0, 19), seg=12, caps=(False, True))
    g.lathe("blued", [(-451, 11.0), (-455, 11.0)], c=(0, 19), seg=12, caps=(False, False))
    g.box("blued", -11.5, 11.5, -9, 29, -514, -476, bev=1.6, wear=0.5)
    g.lathe("blued", [(-476, 12.6), (-478, 13.4), (-512, 13.4), (-514, 12.6)], seg=14, caps=(False, False))
    g.lathe("blued", [(-556, 11.5), (-558, 13.2), (-586, 13.2), (-588, 11.5)], seg=14, caps=(False, False))
    g.prof("blued", [(-587, 8), (-557, 8), (-561, 30), (-583, 30)], -5.0, 5.0, bev=1.0, wear=0.5)
    g.prof("steel_d", [(-573.2, 29), (-569.0, 29), (-569.4, SY), (-572.8, SY)], -1.35, 1.35, bev=0.3)
    g.box("blued", 5.2, 7.2, 24, 39.0, -583, -561, bev=0.5, mx=True)
    g.disc("white", (0, SY - 1.2, -572.9), (0, 0, -1), 0.9, seg=6)
    g.lathe("steel", [(-448, 2.8), (-560, 2.8)], c=(0, -14), seg=8, caps=(False, True))
    g.box("steel_d", -3.5, 3.5, -16, -6, -560, -552, bev=0.5)
    g.box("blued", -4.5, 4.5, -18, -8, -588, -556, bev=0.8)
    g.lathe("blued", [(-589, 8.6), (-590, 10.9, 0.4), (-624, 10.9), (-631.0, 10.4, 0.5), (-631.0, 6.0)], seg=16, caps=(False, True), phase=0.5,
            warp=lambda x, y, z: (x, y, z + max(0.0, y) * 0.8 if z < -610 else z))
    g.decal("void", [(5.0 * math.cos(2 * math.pi * i / 10), 5.0 * math.sin(2 * math.pi * i / 10), -631.2 + max(0.0, 5.0 * math.sin(2 * math.pi * i / 10)) * 0.8) for i in range(10)], (0, 0.5, -1))
    for ang in (0, 180):
        g.slot_r("void", ang, 10.85 * 0.98 + 0.12, -622, -598, 5.0)
    # rear tangent sight
    g.box("blued", -9.5, 9.5, 6, 24, -300, -236, bev=1.0, wear=0.4)
    g.prof("steel_d", [(-298, 20), (-298, 29), (-244, 38.5), (-244, 24)], -8.0, 8.0, bev=0.6)
    g.box("steel_d", 2.2, 8.5, 34, 46, -251, -242, bev=0.6, mx=True)
    g.box("steel_d", -2.4, 2.4, 30, 38, -251, -242, bev=0.3)
    g.disc("white", (0, 37, -251.1), (0, 0, 1), 0.9, seg=6)

    g.points.update({
        "muzzle": muz, "left": [0, 0, -0.29], "right": [0, -0.035, 0.04], "mag": [0, -0.14, -0.14],
        "sight": g.game(0, SY, -251), "eject": g.game(20.7, 13, -150),
    })
    return g


# ---------------------------------------------------------------------------
# M16A4: flat-top upper with the detachable carry handle, rifle-length handguard, A2 stock
# ---------------------------------------------------------------------------
def build_m16():
    muz = [0, 0.045, -0.91]
    Z_MUZ = -728.5
    g = Gun("m16", 0.94 / (728.5 - 27.0) * 1000, (0, 0, Z_MUZ), muz)
    SY = 78.0
    ar_receiver(g, grip="poly")
    ar_mag(g, "gun")
    # buffer tube mount and fixed A2 stock
    g.box("gun_d", -15.5, 15.5, -24, 17.5, 19.6, 22.6, bev=0.8)
    g.lathe("gun_d", [(22.6, 15.6), (23.4, 17.0), (31.5, 17.0), (32.3, 15.8)], seg=12, caps=(False, False))
    out = [(26, 17), (34, 21.5), (230, 24.5), (288, 25.5), (292, 22), (293, -70), (287, -78), (250, -74), (120, -38), (60, -26), (28, -22)]
    g.prof("poly", out, -16.5, 16.5, bev=3.0, wear=0.3, r=3.0, seg=2)
    g.prof("rubber", [(289.5, 26), (298, 24), (299, -72), (291, -80)], -17.3, 17.3, bev=2.0, r=2.0)
    for i in range(6):
        y = 14 - i * 14
        g.decal("void", [(-14.5, y - 1.0, 299.15), (14.5, y - 1.0, 299.15), (14.5, y + 1.0, 299.15), (-14.5, y + 1.0, 299.15)], (0, 0, 1))
    g.rod("steel_d", (-17, -60, 250), (-24, -60, 250), 1.5, seg=6)
    # rifle-length ribbed round handguard, delta ring, barrel, A2 front sight tower
    g.lathe("gun_d", [(-197, 23.4), (-199, 25.2), (-209, 25.2), (-211, 23.4)], seg=20, caps=(False, False))
    g.lathe("poly", [(-209, 21.6), (-212, 22.6), (-486, 22.6), (-492, 20.5), (-495, 19)], seg=20, caps=(False, True), phase=0.5)
    for i in range(20):
        g.slot_r("void", 18.0 * i + 9.0, 22.6 * math.cos(math.pi / 20) + 0.12, -226, -462, 2.4, ends=False)
    g.lathe("gun_l", [(-200, 10.5), (-497, 10.5), (-505, 9.8), (-684, 9.3)], seg=16, caps=(False, False))
    g.lathe("gun_d", [(-497, 10.5), (-500, 14.0), (-538, 14.0), (-541, 10.5)], seg=14, caps=(False, False))
    g.prof("gun_d", [(-541, 11), (-500, 11), (-508, 63), (-534, 63)], -5.0, 5.0, bev=1.0, wear=0.5)
    g.box("gun_d", 4.8, 7.4, 60, 80.2, -533, -509, bev=0.6, mx=True)
    g.prof("steel_d", [(-522.6, 62), (-519.0, 62), (-519.4, SY), (-522.2, SY)], -1.25, 1.25, bev=0.3)
    g.box("gun_d", -4, 4, -20, -10, -532, -508, bev=0.8)
    zt = a2_flash_hider(g, -684.0)
    assert abs(zt - Z_MUZ) < 0.6, zt
    # carry handle with the rear aperture sight on top of the rail
    g.rail("gun", -197, -3, 30.8, base=False)
    handle = [(-12, 31), (-12, 62), (-30, 68), (-120, 71), (-176, 69), (-203, 58), (-212, 34), (-212, 31), (-196, 31), (-192, 40), (-180, 52), (-160, 58),
              (-120, 60), (-70, 58), (-48, 48), (-46, 31)]
    g.prof("gun", handle, -15.5, 15.5, plane="zy", bev=1.0, wear=0.5, r=1.5)
    g.box("gun", -17.5, 17.5, 29.5, 33, -214, -10, bev=0.6)
    g.box("gun_d", -13, 13, 62, 75.5, -50, -15, bev=1.2, wear=0.5)
    for (bx0, bx1, by0, by1) in ((-8, 8, 70, 76), (-8, 8, 80, 86), (-8, -2, 76, 80), (2, 8, 76, 80)):
        g.box("gun_d", bx0, bx1, by0, by1, -15.5, -11.5, bev=0.4)
    g.lathe("gun_d", [(13, 5.0), (14, 6.8, 0.3), (20, 6.8, 0.3), (20.8, 5.5)], ax="x", c=(66, -30), seg=12)
    g.lathe("gun_d", [(-13, 5.0), (-14, 6.8, 0.3), (-19, 6.8, 0.3), (-19.8, 5.5)], ax="x", c=(52, -34), seg=12)
    g.box("gun_d", -6, 6, 56, 64, -200, -184, bev=0.8)

    g.points.update({
        "muzzle": muz, "left": [0, 0.01, -0.33], "right": [0, -0.035, 0.03], "mag": [0, -0.12, -0.11],
        "sight": g.game(0, SY, -15.5), "eject": g.game(16.5, -4, -134),
    })
    return g



# ---------------------------------------------------------------------------
# M40A5: Remington 700 action, heavy barrel, McMillan-style fibreglass stock, 3-12x50 scope
# Gun space: z = 0 at the rear of the receiver, bore on y = 0.
# ---------------------------------------------------------------------------
def build_m40():
    muz = [0, 0.055, -1.14]
    Z_MUZ = -890.0
    g = Gun("m40", 1.18 / (890.0 - 30.0) * 1000, (0, 0, Z_MUZ), muz)
    YA, ZO, ZF, RT = 56.0, 12.0, -338.0, 17.0
    # action, bolt, scope rail
    g.lathe("gun", [(-264, 18.8), (-251, 18.8), (-249, 17.2), (-4, 17.2), (0, 16.2)], seg=20, caps=(True, True))
    g.lathe("gun_d", [(-3, 17.9), (-4, 17.9), (-6, 17.2)], seg=20, caps=(False, False))
    g.rail("gun", -262, -8, 26.0)
    g.lathe("steel_d", [(-2, 9.6), (0, 10.4, 0.3), (17, 10.4), (22, 8.4), (27, 5.8)], seg=14)
    g.box("steel_d", -3.0, 3.0, 9, 21, 20, 27, bev=0.8)
    g.box("gun", 11, 17.6, -9, 13, -152, -66, bev=1.0, wear=0.5)
    g.patch_x("void", 17.75, [(-146, -5), (-72, -5), (-72, 9.5), (-146, 9.5)], r=3.0)
    g.box("steel_d", 14.0, 17.6, 1, 9, -112, -86, bev=0.5, soft=True)
    g.rod("steel_d", (15, 0.7, -30), (47, 0.7, -30), 4.6, seg=10, bev=0.6)
    g.rod("steel_d", (13, 0.7, -30), (24, 0.7, -30), 7.2, seg=10, bev=0.8)
    g.rod("steel_d", (46, 0.7, -30), (60, -6, -23), 4.6, seg=10)
    ball(g, "steel_d", (68, -10, -20), 11.0, seg=14)
    g.box("gun_d", 10, 20, 4, 11, 10, 24, bev=1.2)
    # heavy tapered barrel and thread protector
    g.lathe("gun_l", [(-262, 16.8), (-400, 15.8), (-600, 14.0), (-780, 12.9), (-862, 12.5)], seg=20, caps=(False, False))
    g.lathe("gun_d", [(-862, 11.6), (-863, 12.2), (-866, 12.2), (-867, 11.2)], seg=20, caps=(False, False))
    g.lathe("gun_d", [(-866, 11.2), (-868, 10.8, 0.4), (-889, 10.8), (-890.0, 10.0, 0.5), (-890.0, 6.4)], seg=16, caps=(False, True))
    g.disc("void", (0, 0, -890.2), (0, 0, -1), 4.6, seg=10)
    for i in range(4):
        g.slot_r("void", i * 90 + 22.5 * 0 + 11.25, 10.8 * 0.98 + 0.1, -884, -872, 2.0, ends=False)
    # stock: fore-end / action bedding, buttstock, pistol grip, cheek riser, recoil pad
    g.prof("od", mirror_x([(0, -55), (24, -55), (30, -49), (30, -14), (26, -3), (19, -1), (12, -5), (0, -9)]), -522, -5, plane="xy", bev=2.5, wear=0.15, seg=2)
    butt = [(-8, 3), (40, 6), (130, 17), (260, 21), (318, 18), (322, 16), (322, -100), (318, -112), (290, -110), (230, -90), (160, -62), (110, -52), (28, -52), (-8, -50)]
    g.prof("od", butt, -21, 21, bev=3.5, wear=0.15, r=3.0, rn=2, seg=2,
           warp=lambda x, y, z: (x * (0.8 + 0.2 * min(1.0, max(0.0, (z - 20.0) / 160.0))), y, z))
    gs = [(-48, 2, 24, 19.5, 3.0), (-75, 10, 22, 19.5, 2.8), (-105, 21, 21, 19, 2.8), (-124, 28, 21, 18, 3.0)]
    g.loft("od", [sup_xz(y, cz, rx, rz, e=e, n=14) for (y, cz, rz, rx, e) in gs], caps=(True, True), sharp=70)
    g.prof("rubber", [(321.5, 17), (333, 13), (334, -98), (323, -110)], -21.5, 21.5, bev=2.2, r=2.0)
    g.box("poly", -17.5, 17.5, 14, 31, 85, 205, bev=2.5, wear=0.2)
    g.box("gun_d", -22, 22, 20, 25, 95, 105, bev=0.6)
    for sx in (1, -1):
        g.pin("gun_d", sx * 17.5, 22, 150, 5.0, h=1.4, side=sx, seg=10)
        g.pin("gun_d", sx * 17.5, 22, 195, 5.0, h=1.4, side=sx, seg=10)
        g.pin("steel_d", sx * 21.1, -85, 40, 2.6, h=0.6, side=sx, seg=8)
    # bottom metal: floorplate, trigger guard, trigger
    g.box("gun_d", -14.5, 14.5, -58, -52, -196, -98, bev=1.0, wear=0.5)
    g.box("steel_d", -4.5, 4.5, -61, -57, -104, -96, bev=0.6)
    g.prof("gun_d", [(-98, -53), (-98, -72), (-90, -80), (-34, -80), (-24, -68), (-24, -53), (-31, -53), (-34, -66), (-39, -72), (-84, -72), (-91, -67), (-91, -53)], -3.0, 3.0, bev=0.7, r=1.0)
    g.prof("steel_d", [(-52, -52), (-46, -52), (-50, -72), (-54, -66)], -2.0, 2.0, bev=0.4)
    # scope
    scope(g, YA, ZO, ZF, RT, 28.0, 22.0, [-70.0, -215.0], 26.0, -150.0, -150.0)

    g.points.update({
        "muzzle": muz, "left": [0, -0.02, -0.3], "right": [0, -0.04, 0.06], "mag": [0, -0.06, -0.12], "bolt": [0.05, 0.056, 0.04],
        "sight": g.game(0, YA, ZO + 4.0), "eject": g.game(17.8, 2, -100),
    })
    return g


# ---------------------------------------------------------------------------
# Barrett M107.  Gun space: z = 0 at the pistol grip, bore on y = 0, muzzle at -1100.
# ---------------------------------------------------------------------------
def build_m107():
    muz = [0, 0.055, -1.31]
    Z_MUZ = -1100.0
    g = Gun("m107", 1.35 / 1100.0 * 1000, (0, 0, Z_MUZ), muz)
    YA, ZO, ZF, RT = 78.0, 76.0, -310.0, 17.5
    # upper receiver with 1913 rail, rear tube, recoil pad
    g.prof("gun", mirror_x([(0, -38), (24, -38), (31, -31), (31, 26), (25, 36), (14, 40)]), -326, 102, plane="xy", bev=1.8, wear=0.5)
    g.rail("gun", -300, 92, 48.0)
    g.lathe("gun_d", [(102, 24.0), (103, 26.0, 0.3), (118, 26.0), (120, 22.5)], seg=18, caps=(True, False))
    g.lathe("gun_d", [(119, 21.0), (331, 21.0)], c=(0, -4), seg=18, caps=(False, True))
    g.lathe("gun", [(150, 22.2), (151, 23.0), (156, 23.0), (157, 22.2)], c=(0, -4), seg=18, caps=(False, False))
    g.prof("rubber", mirror_x([(0, -52), (26, -52), (36, -42), (38, -8), (34, 24), (20, 36)]), 330, 346, plane="xy", bev=2.5, r=3.0, rn=2)
    g.prof("poly", mirror_x([(0, 17), (17, 17), (21, 20), (20, 34), (14, 40)]), 150, 262, plane="xy", bev=2.5, wear=0.2)
    # ejection port, charging handle (right), bolt
    g.patch_x("void", 31.15, [(-176, -6), (-64, -6), (-64, 22), (-176, 22)], r=4.0)
    g.box("steel_d", 30.2, 31.4, 0, 14, -150, -90, bev=0.6, soft=True)
    g.rod("steel_d", (31, 12, -52), (52, 12, -52), 5.0, seg=10, bev=0.6)
    g.rod("steel_d", (52, 12, -52), (60, 24, -52), 5.0, seg=10)
    ball(g, "steel_d", (63, 30, -52), 9.5, seg=12)
    for sx in (1, -1):
        g.pin("steel_d", sx * 31.0, -20, -280, 3.0, h=0.8, side=sx, seg=8)
        g.pin("steel_d", sx * 31.0, 16, -280, 3.0, h=0.8, side=sx, seg=8)
        g.pin("steel_d", sx * 31.0, -20, 80, 3.0, h=0.8, side=sx, seg=8)
    # lower receiver, grip, trigger guard, magazine
    g.prof("gun_d", mirror_x([(0, -66), (22, -66), (27, -60), (27, -34)]), -236, 104, plane="xy", bev=1.8, wear=0.45)
    gs = [(-64, -8, 24, 19.5, 3.0), (-90, 0, 23, 20, 2.8), (-120, 13, 22, 19.5, 2.8), (-148, 25, 23, 19, 3.0)]
    g.loft("poly", [sup_xz(y, cz, rx, rz, e=e, n=14) for (y, cz, rz, rx, e) in gs], caps=(True, True), sharp=70)
    g.prof("gun_d", [(-70, -64), (-70, -88), (-60, -98), (-18, -98), (-8, -88), (-8, -64), (-15, -64), (-18, -80), (-23, -86), (-55, -86), (-62, -80), (-63, -64)], -3.5, 3.5, bev=0.8, r=1.0)
    g.prof("steel_d", [(-42, -64), (-36, -64), (-40, -86), (-44, -80)], -2.3, 2.3, bev=0.5)
    g.prof("gun_d", [(-232, -62), (-232, -122), (-226, -130), (-70, -130), (-64, -122), (-64, -62)], -21.0, 21.0, bev=1.6, wear=0.45, r=1.5)
    g.box("steel_d", -22, 22, -134, -128, -234, -62, bev=0.8)
    for sx in (1, -1):
        for z in (-190, -150, -110):
            g.patch_x("gun", sx * 21.1, [(z, -70), (z - 16, -70), (z - 16, -122), (z, -122)], r=1.5)
    g.box("gun_d", -29, -27, -52, -38, -102, -80, bev=0.8)
    # barrel: collar, fluted heavy barrel, brake
    g.lathe("gun_d", [(-324, 28.0), (-326, 29.0), (-350, 29.0), (-352, 24.0)], seg=18, caps=(True, False))
    g.lathe("gun_l", [(-350, 20.5), (-480, 20.0), (-700, 18.2), (-958, 16.8)], seg=16, caps=(False, False), phase=0.5)
    g.lathe("gun_d", [(-958, 18.0), (-960, 26.0, 0.3), (-1098, 26.0), (-1100.0, 22.0, 0.4), (-1100.0, 8.0)], seg=16, caps=(False, True), phase=0.5)
    for (za, zb) in ((-1032, -990), (-1090, -1048)):
        for ang in (0, 180):
            g.slot_r("void", ang, 26.0 * 0.98 + 0.15, za, zb, 20.0)
    g.slot_r("void", 90, 26.0 * 0.98 + 0.15, -1085, -1000, 6.0, ends=False)
    g.disc("void", (0, 0, -1100.2), (0, 0, -1), 6.5, seg=12)
    for z in (-968, -1010, -1094):
        g.lathe("gun_d", [(z + 2, 26.2), (z, 27.0, 0.3), (z - 4, 27.0, 0.3), (z - 6, 26.2)], seg=16, caps=(False, False), phase=0.5)
    # bipod folded under the barrel, rear monopod
    g.lathe("gun_d", [(-374, 23.0), (-376, 24.5), (-394, 24.5), (-396, 23.0)], seg=16, caps=(False, False))
    g.box("gun_d", -26, 26, -34, -14, -396, -374, bev=1.4)
    for sx in (1, -1):
        g.rod("gun_d", (sx * 24, -24, -386), (sx * 24, -26, -700), 6.2, seg=10, bev=0.8)
        g.rod("gun_d", (sx * 24, -26, -690), (sx * 24, -26, -712), 8.0, seg=10, bev=1.0)
        g.rod("rubber", (sx * 24, -26, -712), (sx * 24, -26, -722), 8.4, seg=10, bev=1.0)
    g.rod("gun_d", (0, -26, 290), (0, -118, 296), 7.0, seg=10, bev=0.8)
    g.rod("rubber", (0, -118, 296), (0, -130, 298), 9.5, seg=10, bev=1.0)
    g.box("gun_d", -14, 14, -30, -22, 280, 300, bev=1.2)
    # scope
    scope(g, YA, ZO, ZF, RT, 29.0, 22.0, [-40.0, -215.0], 48.0, -120.0, -120.0, elev_h=26.0, w_ring=14.0)

    g.points.update({
        "muzzle": muz, "left": [0, -0.03, -0.29], "right": [0, -0.04, 0.04], "mag": [0, -0.1, -0.14],
        "sight": g.game(0, YA, ZO + 4.0), "eject": g.game(31.4, 8, -120),
    })
    return g


# ---------------------------------------------------------------------------
# Desert Eagle .50 AE (6").  Gun space: z = 0 at the muzzle, rear is +z.
# ---------------------------------------------------------------------------
def build_d50():
    muz = [0, 0.045, -0.22]
    g = Gun("d50", 0.25 / 224.0 * 1000, (0, 0, 0), muz)
    SY = 36.0
    # polygonal barrel and the barrel hood
    g.lathe("steel_d", [(0.0, 7.2), (0.8, 9.4), (30, 9.8)], seg=6, caps=(True, False), phase=0.5)
    g.disc("void", (0, 0, -0.2), (0, 0, -1), 6.4, seg=6)
    g.prof("satin", mirror_x([(0, -15), (11, -15), (14.8, -10), (14.8, 22), (11, 27.5), (6, 27.5)]), 14, 46, plane="xy", bev=1.4, wear=0.5)
    # slide with ejection port, serrations, rail and sights
    slide = [(44, -10), (44, 22), (52, 27.2), (250, 27.2), (262, 24), (264, 18), (264, -10)]
    g.prof("satin", slide, -15.8, 15.8, bev=1.0, wear=0.5, r=1.2)
    g.patch_x("void", 15.95, [(126, 1), (190, 1), (190, 22), (126, 22)], r=3.0)
    for i in range(8):
        z = 232 + i * 3.4
        for sx in (1, -1):
            g.patch_x("void", sx * 15.9, [(z, -7), (z + 1.5, -7), (z + 1.5, 19), (z, 19)])
    g.prof("gun_d", [(-6.3, 26.5), (6.3, 26.5), (6.3, 29.4), (-6.3, 29.4)], 14, 264, plane="xy", bev=0.5, wear=0.5)
    for i in range(34):
        z = 20 + i * 7.1
        g.decal("void", [(-5.2, 29.45, z), (5.2, 29.45, z), (5.2, 29.45, z + 2.2), (-5.2, 29.45, z + 2.2)], (0, 1, 0))
    g.prof("gun_d", [(14.5, 29), (23.5, 29), (22.5, SY), (16.5, SY)], -1.4, 1.4, bev=0.35)
    g.disc("white", (0, 33.6, 14.45), (0, 0.1, -1), 0.9, seg=6)
    g.box("gun_d", 2.5, 8.8, 29, 41.5, 246, 259, bev=0.6, mx=True)
    g.box("gun_d", -2.6, 2.6, 29, 35.8, 246, 259, bev=0.3)
    for sx in (1, -1):
        g.disc("white", (sx * 5.6, 36, 259.15), (0, 0, 1), 1.0, seg=8)
    # frame, trigger guard, trigger, grip, panels
    frame = [(20, -10), (20, -22), (42, -34), (150, -35), (238, -35), (268, -30), (270, -18), (266, -10)]
    g.prof("gun_d", frame, -15.0, 15.0, bev=1.0, wear=0.5, r=2.0)
    g.prof("gun_d", [(118, -34), (118, -60), (126, -70), (158, -70), (166, -60), (166, -34), (158, -34), (158, -58), (154, -63), (130, -63), (126, -58), (126, -34)], -6.5, 6.5, bev=1.2, r=1.5)
    g.prof("steel_d", [(138, -34), (146, -34), (143, -58), (137, -60)], -2.4, 2.4, bev=0.5)
    gs = [(-34, 219, 33, 14.5, 3.2), (-60, 221, 33, 14.5, 3.0), (-95, 225, 33, 14.5, 3.0), (-130, 229, 33, 14.5, 3.0), (-148, 232, 33.5, 14.0, 3.2)]
    g.loft("gun_d", [sup_xz(y, cz, rx, rz, e=e, n=16) for (y, cz, rz, rx, e) in gs], caps=(True, True), sharp=70)
    panel = [(190, -38, 3), (248, -38, 3), (257, -62), (261, -118), (266, -142, 3), (226, -147, 3), (214, -112), (204, -70)]
    for sx in (1, -1):
        g.prof("poly", panel, sx * 13.4, sx * 18.4, bev=1.6, r=2.5, capbev=(sx < 0, sx > 0), tint=0.6)
        for i in range(14):
            y = -48 - i * 6.6
            zf = 200 + (-48 - y) * 0.30
            zb = 246 + (-48 - y) * 0.17
            g.patch_x("void", sx * 18.55, [(zf, y), (zb, y), (zb, y + 1.4), (zf, y + 1.4)])
        g.disc("poly_l", (sx * 18.55, -52, 214), (sx, 0, 0), 5.0, seg=12)
        g.pin("steel_d", sx * 18.4, -134, 232, 2.4, h=0.5, side=sx, seg=8)
    g.box("steel_d", -17.5, 17.5, -154, -147, 196, 270, bev=1.0, wear=0.4)
    # hammer, safety, magazine release, slide stop
    g.prof("steel_d", [(260, -2), (270, 0), (277, 12), (273, 20), (264, 14)], -3.5, 3.5, bev=0.9, r=1.2)
    for sx in (1, -1):
        g.pin("gun_d", sx * 15.1, -16, 244, 5.0, h=1.6, side=sx, seg=10)
        g.prof("gun_d", [(226, -17), (246, -20), (248, -14), (230, -11)], sx * 15.1, sx * 19.2, bev=0.8, r=0.8)
        g.patch_x("red", sx * 15.2, [(236, -24), (240, -24), (240, -20), (236, -20)])
    g.pin("steel_d", -15.0, -44, 176, 4.0, h=1.6, side=-1, seg=10)
    g.pin("steel_d", 15.0, -22, 108, 2.6, h=0.7, side=1, seg=8)
    g.pin("steel_d", -15.0, -22, 108, 2.6, h=0.7, side=-1, seg=8)

    g.points.update({
        "muzzle": muz, "left": [0, -0.055, 0.04], "right": [0, -0.045, 0.03], "mag": [0, -0.1, 0.03],
        "sight": g.game(0, SY, 259.5), "eject": g.game(15.9, 12, 150),
    })
    return g


# ---------------------------------------------------------------------------
# KA-BAR style fighting knife.  Gun space: z = 0 at the guard's centre-line, tip forward (-z).
# ---------------------------------------------------------------------------
def build_knife():
    g = Gun("knife", 0.25 / 214.0 * 1000, (0, 0, -214.0), [0, 0, -0.25])
    st = [(-36, 14, -16), (-60, 14, -16), (-110, 14, -16), (-150, 14, -16), (-162, 12.6, -15.7), (-175, 10.2, -14.6), (-188, 7, -12.3),
          (-200, 3.6, -8.8), (-208, 0.6, -5.2), (-213, -0.8, -2.8), (-214.3, -1.3, -2.1)]
    thick = [2.3] * 8 + [1.7, 1.0, 0.45]
    main, edge = [], []
    for (z, yt, yb), t in zip(st, thick):
        h = yt - yb
        yg = yt - 0.30 * h
        ym = min(yb + 1.7, yb + 0.5 * (yg - yb))
        main.append([(-t, yt, z), (t, yt, z), (t, yg, z), (-t, yg, z)])
        edge.append([(-t, yg, z), (t, yg, z), (0.7 * t / 2.3 + 0.0, ym, z), (0.12, yb, z), (-0.12, yb, z), (-0.7 * t / 2.3, ym, z)])
    g.loft("blade_d", main, caps=(True, True), sharp=30, tint=0.2)
    g.loft("steel", edge, caps=(True, True), sharp=30, tint=0.0)
    for sx in (1, -1):
        g.patch_x("steel_d", sx * 2.33, [(-172, 9.6), (-50, 9.6), (-50, 8.3), (-172, 8.3)], r=0.5)
    # crossguard
    g.prof("steel", [(-10, -27), (10, -27), (10, 25), (-10, 25)], -37, -29, plane="xy", bev=1.2, wear=0.5, r=8.0, rn=2)
    # leather washer handle (oval), pommel
    pr = [(-29, 9.4), (-28, 10.8)]
    for i in range(11):
        z0 = -28 + i * 9.5
        pr += [(z0 + 0.5, 10.4), (z0 + 1.5, 11.5, 0.6), (z0 + 8.0, 11.5, 0.6), (z0 + 9.0, 10.4)]
    pr += [(78, 10.2)]
    g.lathe("leather", pr, seg=10, caps=(True, True), warp=lambda x, y, z: (x * 0.9, y, z))
    g.lathe("steel", [(77, 9.8), (78.5, 12.2, 0.4), (86, 12.2), (90.5, 10.2), (92.2, 6.2), (92.6, 3.0)], seg=10, caps=(True, True), warp=lambda x, y, z: (x * 0.9, y, z))
    g.points.update({"muzzle": [0, 0, -0.25]})
    return g


# ---------------------------------------------------------------------------
# Tactical tomahawk: black steel head (bearded bit + spike poll) on a hickory haft.
# Haft along z, head at the front end, edge facing down.  Authored 1:1 in game units.
# ---------------------------------------------------------------------------
def build_axe():
    g = Gun("axe", 1.0, (0, -100.0, -340.0), [0, -0.1, -0.34])
    st = [(-338, -93, -101), (-330, -76, -115), (-320, -60, -123), (-305, -42, -128), (-290, -24, -130), (-270, -22, -130), (-250, -22, -129),
          (-238, -22, -125), (-228, -48, -118), (-218, -76, -110), (-210, -94, -104)]
    main, edge = [], []
    for (z, yt, ye) in st:
        t = 6.0 * min(1.0, (yt - ye) / 30.0)
        ym = ye + min(46.0, 0.6 * (yt - ye))
        main.append([(-t, yt, z), (t, yt, z), (t, ym, z), (-t, ym, z)])
        edge.append([(-t, ym, z), (t, ym, z), (0.35, ye, z), (-0.35, ye, z)])
    g.loft("blade_d", main, caps=(True, True), sharp=30, tint=0.2)
    g.loft("steel", edge, caps=(True, True), sharp=30, tint=0.0)
    # eye block and spike poll
    g.box("blade_d", -9.0, 9.0, -24, 21, -284, -242, bev=2.4, wear=0.5)
    rings = []
    for k in range(6):
        f = k / 5.0
        y = 22 + f * 72
        hz = 20 * (1 - f) ** 0.9 + 1.5
        w = 8.6 - 7.0 * f
        rings.append([(-w, y, -264 - hz), (w, y, -264 - hz), (w, y, -264 + hz), (-w, y, -264 + hz)])
    g.loft("blade_d", rings, caps=(True, True), sharp=40, tint=0.0)
    for sx in (1, -1):
        g.pin("steel", sx * 9.0, -2, -264, 3.2, h=0.8, side=sx, seg=8)
    # haft and cord wrap
    ov = lambda x, y, z: (x * 0.62, y, z)
    g.lathe("wood", [(100, 10.5), (98, 13.0), (90, 14.2), (70, 13.2), (30, 11.8), (-100, 11.0), (-200, 10.6), (-250, 10.2), (-298, 9.4)], seg=14, warp=ov)
    g.lathe("fabric", [(64, 13.9), (62.5, 14.4), (15, 13.1), (13.5, 12.7)], seg=14, warp=ov, caps=(True, True))
    g.lathe("steel_d", [(-232, 11.4), (-234, 12.8), (-238, 12.8), (-240, 11.4)], seg=14, warp=ov, caps=(False, False))
    g.points.update({"muzzle": [0, -0.1, -0.34]})
    return g



WEAPONS = [
    ("m4", build_m4, 6500),
    ("ak47", build_ak47, 6500),
    ("m16", build_m16, 6500),
    ("m40", build_m40, 6500),
    ("m107", build_m107, 6500),
    ("m9", build_m9, 3500),
    ("d50", build_d50, 3500),
    ("knife", build_knife, 1500),
    ("axe", build_axe, 1500),
]


# ---------------------------------------------------------------------------
# Finalize: normals, AO, colours, export
# ---------------------------------------------------------------------------
def vnoise(p, freq, seed):
    """Cheap smooth pseudo-noise in [-1, 1] for positions p (n, 3)."""
    rs = np.random.RandomState(seed)
    out = np.zeros(len(p))
    for k in range(4):
        d = rs.normal(size=3)
        d /= np.linalg.norm(d)
        out += np.sin(p @ d * freq * (1.0 + 0.37 * k) + rs.uniform(0, 6.28)) / 4.0
    return out


def finalize(g):
    bm = g.bm
    bm.normal_update()
    bm.verts.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    bm.verts.index_update()
    bm.faces.index_update()
    n = 0
    for f in bm.faces:
        for l in f.loops:
            l.index = n
            n += 1
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for e in bm.edges:
        if e.smooth and len(e.link_loops) == 2:
            la, lb = e.link_loops
            ca = {la.vert.index: la.index, la.link_loop_next.vert.index: la.link_loop_next.index}
            cb = {lb.vert.index: lb.index, lb.link_loop_next.vert.index: lb.link_loop_next.index}
            for vi, li in ca.items():
                if vi in cb:
                    ra, rb = find(li), find(cb[vi])
                    if ra != rb:
                        parent[ra] = rb

    loop_vert = np.zeros(n, dtype=np.int64)
    loop_face = np.zeros(n, dtype=np.int64)
    for f in bm.faces:
        for l in f.loops:
            loop_vert[l.index] = l.vert.index
            loop_face[l.index] = f.index
    f_area = np.array([max(f.calc_area(), 1e-12) for f in bm.faces])
    f_nrm = np.array([f.normal[:] for f in bm.faces])
    f_surf = np.array([f[g.l_mat] for f in bm.faces])
    f_tint = np.array([f[g.l_tint] for f in bm.faces])
    v_co = np.array([v.co[:] for v in bm.verts])
    v_wear = np.array([v[g.l_wear] for v in bm.verts])
    root = np.array([find(i) for i in range(n)])
    uniq, fan = np.unique(root, return_inverse=True)
    nf = len(uniq)

    # face-area weighted normals per smooth fan
    amax = np.zeros(nf)
    np.maximum.at(amax, fan, f_area[loop_face])
    w = (f_area[loop_face] / amax[fan]) ** 3
    fn = np.zeros((nf, 3))
    np.add.at(fn, fan, f_nrm[loop_face] * w[:, None])
    ln = np.linalg.norm(fn, axis=1)
    bad = ln < 1e-6
    fn[bad] = (0, 0, 1)
    ln[bad] = 1
    fn /= ln[:, None]

    me = bpy.data.meshes.new(g.wid)
    bm.to_mesh(me)
    ob = bpy.data.objects.new(g.wid, me)
    bpy.context.scene.collection.objects.link(ob)
    lv = np.zeros(n, dtype=np.int32)
    me.loops.foreach_get("vertex_index", lv)
    assert np.array_equal(lv, loop_vert), "loop order mismatch"

    # ambient occlusion baked per corner, averaged per fan
    ao = np.ones(n)
    try:
        attr = me.color_attributes.new("ao", "FLOAT_COLOR", "CORNER")
        me.color_attributes.active_color = attr
        scene = bpy.context.scene
        scene.render.engine = "CYCLES"
        scene.cycles.device = "CPU"
        scene.cycles.samples = 64
        scene.world = bpy.data.worlds.new("ao_world")
        scene.world.light_settings.distance = AO_DIST
        bpy.ops.object.select_all(action="DESELECT")
        ob.select_set(True)
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.bake(type="AO", target="VERTEX_COLORS")
        buf = np.zeros(n * 4, dtype=np.float32)
        me.color_attributes["ao"].data.foreach_get("color", buf)
        ao = np.clip(buf.reshape(n, 4)[:, :3].mean(axis=1), 0, 1).astype(np.float64)
    except Exception as exc:  # pragma: no cover
        print(f"WARNING: AO bake failed for {g.wid}: {exc}")
    fan_ao = np.zeros(nf)
    fan_cnt = np.zeros(nf)
    np.add.at(fan_ao, fan, ao)
    np.add.at(fan_cnt, fan, 1)
    fan_ao /= fan_cnt

    # colours per fan
    first = np.zeros(nf, dtype=np.int64)
    first[fan] = np.arange(n)
    fv = loop_vert[first]
    ff = loop_face[first]
    surf = f_surf[ff]
    cls = np.array(SURF_CLS)[surf]
    base = np.array(SURF_LIN)[surf]
    pos = v_co[fv]
    tint = 1.0 + 0.07 * f_tint[ff]
    var = 1.0 + 0.09 * vnoise(pos, 55.0, 3) + 0.06 * vnoise(pos, 190.0, 7)
    flat = np.isin(surf, [SURF_NAMES.index(s) for s in ("void", "white", "red", "lens", "glass")])
    var[flat] = 1.0
    tint[flat] = 1.0
    col = base * (tint * var)[:, None]
    wear = np.clip(v_wear[fv], 0, 1) * (0.75 + 0.5 * (0.5 + 0.5 * vnoise(pos, 120.0, 11)))
    metal = np.isin(cls, [C_GUN, C_STEEL, C_CAST, C_CHROME])
    lum = col.mean(axis=1)
    bare = np.array([0.36, 0.37, 0.39])
    wm = (wear * 0.5)[:, None]
    col = np.where(metal[:, None], col * (1 - wm) + bare * wm,
                   col * (1 - wm) + (col * 1.9 + 0.012) * wm)
    col = np.where((metal & (lum > 0.25))[:, None], col * (1 + 0.25 * wear)[:, None], col)
    occ = AO_FLOOR + (1 - AO_FLOOR) * fan_ao ** 1.15
    col = np.clip(col * occ[:, None], 0, 1)

    # preview attributes on the Blender mesh
    cattr = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
    cbuf = np.ones((n, 4), dtype=np.float32)
    cbuf[:, :3] = col[fan]
    cattr.data.foreach_set("color", cbuf.ravel())
    for i in range(len(MAT_CLASSES)):
        me.materials.append(class_material(i))
    me.polygons.foreach_set("material_index", np.array(SURF_CLS, dtype=np.int32)[f_surf])
    me.polygons.foreach_set("use_smooth", np.ones(len(me.polygons), dtype=bool))
    me.normals_split_custom_set([tuple(x) for x in fn[fan]])
    me.update()

    # export buffers (Blender x, y, z -> game x, z, -y)
    gpos = np.stack([pos[:, 0], pos[:, 2], -pos[:, 1]], axis=1)
    gnor = np.stack([fn[:, 0], fn[:, 2], -fn[:, 1]], axis=1)
    ipos = np.clip(np.round(gpos * SCALE), -32768, 32767).astype("<i2")
    inor = np.clip(np.round(gnor * 127), -127, 127).astype("i1")
    srgb = np.where(col <= 0.0031308, col * 12.92, 1.055 * np.power(np.maximum(col, 1e-9), 1 / 2.4) - 0.055)
    icol = np.zeros((nf, 4), dtype="u1")
    icol[:, :3] = np.clip(np.round(srgb * 255), 0, 255)
    icol[:, 3] = cls << 2
    me.calc_loop_triangles()
    nt = len(me.loop_triangles)
    tl = np.zeros(nt * 3, dtype=np.int32)
    me.loop_triangles.foreach_get("loops", tl)
    idx = fan[tl].astype("<u2")
    assert nf < 65536
    blob = ipos.tobytes() + inor.tobytes() + icol.tobytes() + idx.tobytes()
    bb = (gpos.min(axis=0), gpos.max(axis=0))
    return ob, me, {"verts": int(nf), "tris": int(nt), "b64": base64.b64encode(blob).decode("ascii"), "bbox": bb}


def check_sightline(g, me):
    """The line from the sight point forward must be clear (0.4 mm above it)."""
    if "sight" not in g.points or g.wid in ("m40", "m107"):
        return
    s = g.points["sight"]
    bm = bmesh.new()
    bm.from_mesh(me)
    tree = BVHTree.FromBMesh(bm)
    for dx in (-0.0012, 0.0, 0.0012):
        o = Vector((s[0] + dx, -(s[2] - 0.0005), s[1] + 0.0005))
        hit = tree.ray_cast(o, Vector((0, 1, 0)), 3.0)
        if hit[0] is not None:
            print(f"  WARNING {g.wid}: sight line blocked at game z={-hit[0].y:.4f} y={hit[0].z:.4f} (dx {dx})")
    # how far below the line is the highest thing in front (front sight should be ~0)
    best = None
    for k in range(1, 60):
        o = Vector((s[0], -(s[2] - 0.004), s[1] - k * 0.0005))
        hit = tree.ray_cast(o, Vector((0, 1, 0)), 3.0)
        if hit[0] is not None:
            best = (k * 0.5, -hit[0].y)
            break
    print(f"  sight {s}: first geometry {best[0] if best else '>30'} mm below the line" + (f" at z={best[1]:.3f}" if best else ""))
    bm.free()


# ---------------------------------------------------------------------------
# Preview renders
# ---------------------------------------------------------------------------
_class_mats = {}


def class_material(i):
    if i in _class_mats:
        return _class_mats[i]
    mat = bpy.data.materials.new(f"class_{i}")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_name = "Col"
    nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = MAT_CLASSES[i][0]
    bsdf.inputs["Metallic"].default_value = MAT_CLASSES[i][1]
    mat.use_fake_user = True
    _class_mats[i] = mat
    return mat


def setup_studio():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 40
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 4
    try:
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.look = "AgX - Medium High Contrast"
        scene.view_settings.exposure = -0.5
    except Exception:
        pass
    scene.render.resolution_x = 1400
    scene.render.resolution_y = 800
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    world = bpy.data.worlds.new("studio")
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    mix = nt.nodes.new("ShaderNodeMixShader")
    lp = nt.nodes.new("ShaderNodeLightPath")
    cam_bg = nt.nodes.new("ShaderNodeBackground")
    cam_bg.inputs[0].default_value = (0.19, 0.20, 0.215, 1)
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
    els[0].color = (0.05, 0.045, 0.04, 1)
    els[1].position = 1.0
    els[1].color = (1.0, 1.05, 1.15, 1)
    e = els.new(0.5)
    e.color = (0.42, 0.42, 0.44, 1)
    e = els.new(0.44)
    e.color = (0.10, 0.09, 0.085, 1)
    nt.links.new(ramp.outputs[0], env_bg.inputs[0])
    env_bg.inputs[1].default_value = 0.9
    nt.links.new(lp.outputs["Is Camera Ray"], mix.inputs[0])
    nt.links.new(env_bg.outputs[0], mix.inputs[1])
    nt.links.new(cam_bg.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs[0])
    scene.world = world


def add_area(name, loc, target, size, power, color=(1, 1, 1)):
    ld = bpy.data.lights.new(name, "AREA")
    ld.size = size
    ld.energy = power
    ld.color = color
    ob = bpy.data.objects.new(name, ld)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = loc
    ob.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    return ob


def add_camera(name, loc, target, ortho=None, lens=None):
    cd = bpy.data.cameras.new(name)
    cd.clip_start = 0.01
    cd.clip_end = 50
    if ortho:
        cd.type = "ORTHO"
        cd.ortho_scale = ortho
    else:
        cd.lens = lens
        cd.sensor_width = 36
    ob = bpy.data.objects.new(name, cd)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = loc
    ob.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = ob
    return ob


def render_previews(g, info):
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    scene = bpy.context.scene
    setup_studio()
    lo, hi = info["bbox"]  # game space
    cz = (lo[2] + hi[2]) / 2
    cy = (lo[1] + hi[1]) / 2
    length = hi[2] - lo[2]
    height = hi[1] - lo[1]
    R = max(length, height * 1.75)
    # Blender coords: (x, -z_game, y_game)
    ctr = Vector((0, -cz, cy))
    add_area("key", ctr + Vector((0.9 * R, 0.5 * R, 1.3 * R)), ctr, R * 1.2, 55 * R * R * 4)
    add_area("fill", ctr + Vector((-1.2 * R, -0.6 * R, 0.5 * R)), ctr, R * 1.5, 22 * R * R * 4, (0.85, 0.92, 1.0))
    add_area("rim", ctr + Vector((0.2 * R, -1.3 * R, 0.9 * R)), ctr, R * 0.8, 30 * R * R * 4, (1.0, 0.95, 0.88))
    add_area("top", ctr + Vector((0, 0, 1.6 * R)), ctr, R * 2.0, 14 * R * R * 4)
    # side view (right side, muzzle to the right)
    add_camera("side", ctr + Vector((3.0, 0, 0)), ctr, ortho=max(length * 1.1, height * 1.1 * 1.75))
    scene.render.filepath = os.path.join(PREVIEW_DIR, f"weapon_{g.wid}.png")
    bpy.ops.render.render(write_still=True)
    # first-person-ish view: eye behind, above and inboard of the gun
    sp = g.points.get("sight")
    pistol = length < 0.45
    if sp is not None:
        sy, sz = sp[1], sp[2]
        if pistol:
            eye = Vector((0.07, -(sz + 0.26), sy + 0.12))
            look = Vector((0.0, -(sz - 0.10), sy - 0.07))
        else:
            eye = Vector((0.06, -(sz + 0.34), sy + 0.12))
            look = Vector((-0.005, -(sz - 0.45), sy - 0.10))
    else:
        r = g.points.get("right", [0, 0, 0])
        eye = Vector((0.07, -(r[2] + 0.30), r[1] + 0.12))
        look = Vector((0.0, -(r[2] - 0.15), r[1] - 0.06))
    add_camera("fp", eye, look, lens=30 if pistol else 36)
    scene.render.filepath = os.path.join(PREVIEW_DIR, f"weapon_{g.wid}_fp.png")
    bpy.ops.render.render(write_still=True)
    if ADS_VIEW and "sight" in g.points:
        s = g.points["sight"]
        eye = Vector((s[0], -(s[2] + (0.30 if pistol else 0.09)), s[1]))
        add_camera("ads", eye, eye + Vector((0, 1, 0)), lens=30)
        scene.render.filepath = os.path.join(PREVIEW_DIR, f"weapon_{g.wid}_ads.png")
        bpy.ops.render.render(write_still=True)


def cleanup_scene():
    scene = bpy.context.scene
    scene.world = None
    scene.camera = None
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.cameras, bpy.data.lights, bpy.data.worlds, bpy.data.images):
        for d in list(coll):
            if d.users == 0:
                coll.remove(d)


def contact_sheet(ids):
    tw, th, cols = 700, 400, 3
    tiles = []
    for wid in ids:
        for suffix in ("", "_fp"):
            path = os.path.join(PREVIEW_DIR, f"weapon_{wid}{suffix}.png")
            img = bpy.data.images.load(path)
            w, h = img.size
            buf = np.zeros(w * h * 4, dtype=np.float32)
            img.pixels.foreach_get(buf)
            a = buf.reshape(h, w, 4)
            a = a.reshape(th, h // th, tw, w // tw, 4).mean(axis=(1, 3))
            tiles.append(a)
            bpy.data.images.remove(img)
    side = tiles[0::2]
    fp = tiles[1::2]
    rows_n = (len(ids) + cols - 1) // cols
    sheet = np.zeros((rows_n * 2 * th, cols * tw, 4), dtype=np.float32)
    sheet[..., 3] = 1
    sheet[..., :3] = 0.19
    for i in range(len(ids)):
        rr, cc = divmod(i, cols)
        for k, t in enumerate((side[i], fp[i])):
            top = (rr * 2 + k) * th
            y0 = sheet.shape[0] - top - th
            sheet[y0:y0 + th, cc * tw:(cc + 1) * tw] = t
    out = bpy.data.images.new("sheet", sheet.shape[1], sheet.shape[0], alpha=False)
    out.pixels.foreach_set(sheet.ravel())
    out.filepath_raw = SHEET_PATH
    out.file_format = "PNG"
    out.save()
    print(f"Wrote {SHEET_PATH}")


def main():
    t0 = time.time()
    results = {}
    todo = [w for w in WEAPONS if not ONLY or w[0] in ONLY]
    for wid, build_fn, budget in todo:
        t1 = time.time()
        g = build_fn()
        ob, me, info = finalize(g)
        lo, hi = info["bbox"]
        print(f"{wid}: {info['verts']} verts, {info['tris']} tris, {len(info['b64']) // 1024} KB, "
              f"bbox x[{lo[0]:.3f},{hi[0]:.3f}] y[{lo[1]:.3f},{hi[1]:.3f}] z[{lo[2]:.3f},{hi[2]:.3f}]")
        for k in ("right", "left", "mag", "bolt"):
            if k in g.points:
                print(f"  {k} -> gun space mm {g.mm(g.points[k])}")
        check_sightline(g, me)
        if info["verts"] > budget:
            print(f"  WARNING {wid}: {info['verts']} verts exceeds the budget of {budget}")
        if not NO_PREVIEW:
            try:
                render_previews(g, info)
            except Exception:
                traceback.print_exc()
        results[wid] = (info, g.points)
        g.bm.free()
        cleanup_scene()
        print(f"  ({time.time() - t1:.1f}s)")

    if ONLY:
        print("Subset build: asset file not written.")
        return
    lines = [
        f"// Generated by tools/blender/build_weapons.py with Blender {bpy.app.version_string}. Do not edit by hand.",
        "export const WEAPON_ASSETS = {",
    ]
    for wid, _, _ in WEAPONS:
        info, points = results[wid]
        meta = json.dumps({"verts": info["verts"], "tris": info["tris"], "scale": SCALE})
        lines.append(f"  {wid}: {{ meta: {meta}, points: {json.dumps(points)}, mesh: {json.dumps(info['b64'])} }},")
    lines.append("};")
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"Wrote {OUT_PATH} ({os.path.getsize(OUT_PATH) // 1024} KB) in {time.time() - t0:.0f}s")
    if not NO_PREVIEW:
        try:
            contact_sheet([w[0] for w in WEAPONS])
        except Exception:
            traceback.print_exc()


if __name__ == "__main__":
    main()
