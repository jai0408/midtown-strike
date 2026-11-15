"""
Builds the soldier (a generic US Marine rifleman) with Blender and writes
src/chars/soldier_asset.js.

    /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/build_soldier.py
    ... -- --fast        geometry only: flat-colour previews, nothing is written to the game

Needs numpy (ships with Blender). The system `python3` with Pillow is used for
JPEG/PNG encoding and the contact sheet.

What happens here
  * the body is lofted from anatomical cross-sections (torso, sleeves, trousers,
    boots, face, hands with separate fingers) and the kit (helmet, plate carrier,
    pouches, belt, pads) is modelled as bevelled solids and sweeps
  * everything is unwrapped into one 2048 atlas
  * Cycles bakes: an ID map (material, camouflage level, dust), a tangent-space
    NORMAL map from procedural bump nodes (weave, MOLLE rows, wrinkles, tread),
    a ROUGHNESS map and ambient occlusion
  * the mesh is exported for the game's 16-bone rig (two influences per vertex)
  * previews are rendered with the same maps (Principled BSDF) incl. a bent pose

The game composes the albedo per team from the ID map (woodland MARPAT-like
camouflage for the Marines, a dark urban kit for the hostiles).

Model space is the game's: X right, Y up, facing -Z. Blender is Z-up, so
game (X, Y, Z) is authored as Blender (X, -Z, Y).
"""
import base64
import io
import json
import math
import os
import subprocess
import sys
import tempfile

import bpy  # must come first: it registers bmesh and mathutils
import bmesh
import numpy as np
from mathutils import Matrix, Vector, Euler

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
FAST = '--fast' in ARGS
NOPREV = '--noprev' in ARGS

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT_JS = os.path.join(ROOT, 'src', 'chars', 'soldier_asset.js')
PREVIEW = os.path.join(HERE, 'preview')
SHEET = os.path.join(ROOT, 'docs', 'sheet_soldier.png')
TEX = 2048        # albedo-related atlas (ID map)
TEX_B = 1024      # normal / roughness / occlusion
BAKE_N = 2048

# the game's rig (src/chars/soldier.js): name, parent, rest position
RIG = [
    ('hips', -1, 0, 0.95, 0), ('spine', 0, 0, 1.05, 0), ('chest', 1, 0, 1.25, 0), ('head', 2, 0, 1.52, 0),
    ('armL', 2, -0.225, 1.49, 0), ('foreL', 4, -0.225, 1.21, 0), ('handL', 5, -0.225, 0.95, 0),
    ('armR', 2, 0.225, 1.49, 0), ('foreR', 7, 0.225, 1.21, 0), ('handR', 8, 0.225, 0.95, 0),
    ('thighL', 0, -0.1, 0.93, 0), ('shinL', 10, -0.1, 0.5, 0), ('footL', 11, -0.1, 0.07, 0),
    ('thighR', 0, 0.1, 0.93, 0), ('shinR', 13, 0.1, 0.5, 0), ('footR', 14, 0.1, 0.07, 0),
]
BONE = {r[0]: i for i, r in enumerate(RIG)}

# material ids written to the ID map (id = index + 1)
MATS = ['camo', 'gear', 'gearDark', 'boot', 'skin', 'black', 'glove', 'accent', 'flag', 'tape', 'metal', 'lens', 'rubber', 'lip', 'eye']
MAT = {n: i for i, n in enumerate(MATS)}
# base roughness per material (the roughness map adds fabric / wear variation)
ROUGH = {'camo': 0.90, 'gear': 0.88, 'gearDark': 0.84, 'boot': 0.70, 'skin': 0.52, 'black': 0.55, 'glove': 0.66, 'accent': 0.7,
         'flag': 0.8, 'tape': 0.86, 'metal': 0.30, 'lens': 0.06, 'rubber': 0.92, 'lip': 0.42, 'eye': 0.10}


def B(x, y=None, z=None):
    """game -> Blender coordinates"""
    if y is None:
        x, y, z = x
    return Vector((x, -z, y))


def smooth(a, b, v):
    t = min(1.0, max(0.0, (v - a) / (b - a)))
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


# ---------------------------------------------------------------------------
# scene helpers
# ---------------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
objects = []
materials = {}


def unwrap_object(ob, seamed):
    """Per-part UVs: lofted tubes are cut along their back line and flattened; everything else gets Smart UV."""
    ob['uv'] = 1
    for o in bpy.context.scene.objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    if seamed:
        bpy.ops.uv.unwrap(method='ANGLE_BASED', margin=0.0)
    else:
        bpy.ops.uv.smart_project(angle_limit=math.radians(70), island_margin=0.0)
    bpy.ops.object.mode_set(mode='OBJECT')
    ob.select_set(False)


def finish_mesh(ob, sharp=50):
    for p in ob.data.polygons:
        p.use_smooth = True
    if sharp:
        ob.data.set_sharp_from_angle(angle=math.radians(sharp))


def new_object(name, bm, mat):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.uv_layers.new(name='UVMap')
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    for m in MATS:
        me.materials.append(materials[m])
    for p in me.polygons:
        p.material_index = MAT[mat]
        p.use_smooth = True
    objects.append(ob)
    return ob


def weights(ob, fn):
    """fn(game_x, game_y, game_z) -> [(bone, weight), ...] (at most two are kept)"""
    groups = {}
    for v in ob.data.vertices:
        x, y, z = v.co.x, v.co.z, -v.co.y
        ws = [(b, w) for b, w in fn(x, y, z) if w > 0.002]
        ws.sort(key=lambda t: -t[1])
        ws = ws[:2]
        tot = sum(w for _, w in ws) or 1.0
        for bone, w in ws:
            g = groups.get(bone) or groups.setdefault(bone, ob.vertex_groups.new(name=bone))
            g.add([v.index], w / tot, 'REPLACE')


def rigid(bone):
    return lambda x, y, z: [(bone, 1.0)]


def blend2(a, b, y_joint, half, y):
    """Bone a above the joint, bone b below it, blended over +-half."""
    t = smooth(y_joint - half, y_joint + half, y)
    return [(a, t), (b, 1 - t)]


def W(bone):
    return bone if callable(bone) else rigid(bone)


# --- geometry primitives -----------------------------------------------------
def superellipse(seg, p, phase=1.5 * math.pi):
    out = []
    for k in range(seg):
        t = 2 * math.pi * k / seg + phase
        c, s = math.cos(t), math.sin(t)
        out.append((math.copysign(abs(c) ** (2 / p), c), math.copysign(abs(s) ** (2 / p), s)))
    return out


def sweep(path, ra, rb, seg=12, p=2.0, ref=(1, 0, 0), caps=(True, True), loop=False):
    """Tube along a path of game-space points. ra / rb: radius along e1 / e2 (per ring, or
    (positive side, negative side) tuples). e1 is `ref` projected off the path tangent,
    e2 = tangent x e1."""
    n = len(path)
    path = [Vector(q) for q in path]
    ra = ra if isinstance(ra, list) else [ra] * n
    rb = rb if isinstance(rb, list) else [rb] * n
    se = superellipse(seg, p)
    verts, faces, seams = [], [], []
    for i in range(n):
        if loop:
            T = (path[(i + 1) % n] - path[i - 1]).normalized()
        else:
            T = (path[min(i + 1, n - 1)] - path[max(i - 1, 0)]).normalized()
        r = Vector(ref)
        e1 = r - T * r.dot(T)
        if e1.length < 1e-4:
            e1 = Vector((0, 0, 1)) - T * T.z
        e1.normalize()
        e2 = T.cross(e1)
        for (c, s) in se:
            a = ra[i]
            b = rb[i]
            if isinstance(a, tuple):
                a = a[0] if c >= 0 else a[1]
            if isinstance(b, tuple):
                b = b[0] if s >= 0 else b[1]
            verts.append(path[i] + e1 * (c * a) + e2 * (s * b))
    rings = n if loop else n - 1
    for i in range(rings):
        j = (i + 1) % n
        for k in range(seg):
            k2 = (k + 1) % seg
            faces.append((i * seg + k, i * seg + k2, j * seg + k2, j * seg + k))
    for i in range(rings):
        seams.append((i * seg, ((i + 1) % n) * seg))
    ends = []
    if not loop:
        if caps[0]:
            faces.append(tuple(range(seg - 1, -1, -1)))
            ends.append(0)
        if caps[1]:
            faces.append(tuple((n - 1) * seg + k for k in range(seg)))
            ends.append(n - 1)
    else:
        ends.append(0)
    for r in ends:
        for k in range(seg):
            seams.append((r * seg + k, r * seg + (k + 1) % seg))
    return verts, faces, seams


def resample(keys, ys):
    """keys: [(y, f1, f2, ...)] ascending; returns smooth (Catmull-Rom) rows at each y."""
    K = np.array(sorted(keys, key=lambda r: r[0]), dtype=float)
    n = len(K)
    out = []
    for y in ys:
        i = int(np.clip(np.searchsorted(K[:, 0], y) - 1, 0, n - 2))
        t = (y - K[i, 0]) / (K[i + 1, 0] - K[i, 0])
        p0, p1, p2, p3 = K[max(i - 1, 0)], K[i], K[i + 1], K[min(i + 2, n - 1)]
        v = 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3)
        v[0] = y
        out.append(tuple(float(q) for q in v))
    return out


def loft_rings(keys, ys=None):
    """keys: (y, cx, cz, rx, rf, rb, p). Returns sweep arguments for an upright loft."""
    keys = sorted(keys, key=lambda r: r[0])
    rows = resample(keys, sorted(ys)) if ys is not None else keys
    path = [(r[1], r[0], r[2]) for r in rows]
    ra = [r[3] for r in rows]
    rb = [(r[4], r[5]) for r in rows]
    return path, ra, rb, rows


def vloft(keys, ys=None, seg=14, p=None, caps=(True, True)):
    path, ra, rb, rows = loft_rings(keys, ys)
    pp = p if p is not None else rows[len(rows) // 2][6]
    return sweep(path, ra, rb, seg=seg, p=pp, ref=(1, 0, 0), caps=caps)


def emit(name, mat, bone, vf, closed=True, sharp=50):
    verts, faces = vf[0], vf[1]
    seams = vf[2] if len(vf) > 2 else None
    bm = bmesh.new()
    bv = [bm.verts.new(B(v)) for v in verts]
    for f in faces:
        try:
            bm.faces.new([bv[i] for i in f])
        except ValueError:
            pass
    if seams:
        for a, b in seams:
            e = bm.edges.get((bv[a], bv[b]))
            if e is not None:
                e.seam = True
    if closed:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    ob = new_object(name, bm, mat)
    if seams:
        unwrap_object(ob, True)
    finish_mesh(ob, sharp)
    if bone is not None:
        weights(ob, W(bone))
    return ob


def box(name, mat, bone, size, pos, bevel=0.008, rot_x=0.0, rot_y=0.0, seg=1, taper=None, sharp=50):
    """Bevelled box. size/pos in game space (w, h, d) / (x, y, z)."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    w, h, d = size
    for v in bm.verts:
        v.co = Vector((v.co.x * w, v.co.y * d, v.co.z * h))
        if taper:  # narrower towards the top: (scale_x, scale_depth)
            k = (v.co.z / h) + 0.5
            v.co.x *= 1 + (taper[0] - 1) * k
            v.co.y *= 1 + (taper[1] - 1) * k
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=min(bevel, min(size) * 0.45), segments=(seg if max(size) > 0.09 else 1), profile=0.5, affect='EDGES')
    if rot_x:
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(rot_x, 3, 'X'))
    if rot_y:  # about the game's vertical axis
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(rot_y, 3, 'Z'))
    bmesh.ops.translate(bm, verts=bm.verts, vec=B(*pos))
    ob = new_object(name, bm, mat)
    unwrap_object(ob, False)
    finish_mesh(ob, sharp)
    weights(ob, W(bone))
    return ob


def blob(name, mat, bone, pos, radii, seg=10, rings=6):
    """Ellipsoid (eyes, ear lobes ...)."""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * radii[0], -v.co.z * 0 + v.co.y * radii[2], v.co.z * radii[1]))
    bmesh.ops.translate(bm, verts=bm.verts, vec=B(*pos))
    ob = new_object(name, bm, mat)
    unwrap_object(ob, False)
    finish_mesh(ob, 0)
    weights(ob, W(bone))
    return ob


def plan_pt(theta, y, yc, h, a, cf, cb, cz, p=2.3):
    """Point on the helmet dome at height y; theta 0 = straight ahead (-Z)."""
    s = max(-1.0, min(1.0, (y - yc) / h))
    cp = math.sqrt(1 - s * s)
    c, sn = math.cos(theta), math.sin(theta)
    sx = math.copysign(abs(sn) ** (2 / p), sn)
    sz = math.copysign(abs(c) ** (2 / p), c)
    c_ = cf if c >= 0 else cb
    return (a * cp * sx, y, cz - c_ * cp * sz)


# ---------------------------------------------------------------------------
# materials: every one has an emission branch (ID bake) and a Principled branch
# (normal / roughness bake), both built from procedural nodes in object space
# ---------------------------------------------------------------------------
def camo_index_image():
    """MARPAT-like digital camouflage as 4 grey levels: 0 base, 1 brown, 2 tan, 3 dark.
    Two scales of square 'pixels' (about 6 mm and 2.4 cm)."""
    n = 192
    rng = np.random.default_rng(1775)

    def noise(cells):
        g = rng.random((cells, cells))
        idx = (np.arange(n) * cells / n)
        i0 = np.floor(idx).astype(int) % cells
        i1 = (i0 + 1) % cells
        t = idx - np.floor(idx)
        t = t * t * (3 - 2 * t)
        rows = g[i0][:, i0] * (1 - t)[None, :] + g[i0][:, i1] * t[None, :]
        rows2 = g[i1][:, i0] * (1 - t)[None, :] + g[i1][:, i1] * t[None, :]
        return rows * (1 - t)[:, None] + rows2 * t[:, None]

    def blocks(size, amp):
        g = rng.random((n // size + 1, n // size + 1))
        return (np.kron(g, np.ones((size, size)))[:n, :n] - 0.5) * amp

    n1 = noise(5) * 0.6 + noise(11) * 0.4 + blocks(8, 0.16) + blocks(2, 0.12)
    n2 = noise(8) * 0.5 + noise(17) * 0.5 + blocks(8, 0.16) + blocks(2, 0.12)
    level = np.where(n2 > 0.68, 2, np.where(n2 < 0.31, 3, np.where(n1 > 0.56, 1, 0)))
    img = bpy.data.images.new('camo_index', n, n, alpha=False, is_data=True)
    px = np.zeros((n, n, 4), dtype=np.float32)
    px[..., 0] = px[..., 1] = px[..., 2] = level / 3.0
    px[..., 3] = 1
    img.pixels.foreach_set(px.ravel())
    return img


class NG:
    """Tiny helper for building node graphs."""

    def __init__(self, nt):
        self.nt = nt

    def node(self, kind, **props):
        n = self.nt.nodes.new(kind)
        for k, v in props.items():
            setattr(n, k, v)
        return n

    def set(self, sock, v):
        if isinstance(v, (int, float)):
            sock.default_value = v
        elif isinstance(v, (tuple, list)):
            sock.default_value = v
        else:
            self.nt.links.new(v, sock)

    def math(self, op, a, b=None, c=None, clamp=False):
        n = self.node('ShaderNodeMath', operation=op, use_clamp=clamp)
        self.set(n.inputs[0], a)
        if b is not None:
            self.set(n.inputs[1], b)
        if c is not None:
            self.set(n.inputs[2], c)
        return n.outputs[0]

    def maprange(self, v, a0, a1, b0=0.0, b1=1.0, clamp=True):
        n = self.node('ShaderNodeMapRange', clamp=clamp)
        self.set(n.inputs[0], v)
        n.inputs[1].default_value, n.inputs[2].default_value = a0, a1
        n.inputs[3].default_value, n.inputs[4].default_value = b0, b1
        return n.outputs[0]


def build_materials(camo_img):
    for name in MATS:
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        nt = m.node_tree
        nt.nodes.clear()
        g = NG(nt)
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        tc = nt.nodes.new('ShaderNodeTexCoord')
        P = tc.outputs['Object']
        sep = nt.nodes.new('ShaderNodeSeparateXYZ')
        nt.links.new(P, sep.inputs[0])
        X, Y, Z = sep.outputs[0], sep.outputs[1], sep.outputs[2]   # Blender axes: game x, -z, y
        gx, gy, gz = X, Z, g.math('MULTIPLY', Y, -1.0)           # game axes

        # ---- ID branch -----------------------------------------------------
        em = nt.nodes.new('ShaderNodeEmission')
        comb = nt.nodes.new('ShaderNodeCombineColor')
        comb.inputs[0].default_value = (MAT[name] + 1) / 16.0
        if name == 'camo':
            mp = nt.nodes.new('ShaderNodeMapping')
            mp.inputs['Scale'].default_value = (1 / 1.2, 1 / 1.2, 1 / 1.2)   # one tile = 1.2 m, 6 mm "pixels"
            mp.inputs['Location'].default_value = (0.37, 0.11, 0.23)
            ti = nt.nodes.new('ShaderNodeTexImage')
            ti.image = camo_img
            ti.projection = 'BOX'
            ti.projection_blend = 0.0
            ti.interpolation = 'Closest'
            nt.links.new(P, mp.inputs['Vector'])
            nt.links.new(mp.outputs['Vector'], ti.inputs['Vector'])
            nt.links.new(ti.outputs['Color'], comb.inputs[1])
        # dust: boots / trouser knees / shoulders (normal pointing up)
        nrm = nt.nodes.new('ShaderNodeNewGeometry')
        sepn = nt.nodes.new('ShaderNodeSeparateXYZ')
        nt.links.new(nrm.outputs['Normal'], sepn.inputs[0])
        boot_d = g.maprange(gz, 0.04, 0.2, 1.0, 0.0)
        knee_d = g.math('MULTIPLY', g.maprange(g.math('ABSOLUTE', g.math('SUBTRACT', gz, 0.5)), 0.03, 0.09, 1.0, 0.0),
                        g.maprange(g.math('MULTIPLY', gy, 1.0), -0.25, 0.0, 1.0, 0.4))
        up_d = g.math('MULTIPLY', g.maprange(sepn.outputs[2], 0.35, 0.95, 0.0, 0.45), g.maprange(gz, 1.38, 1.5, 0.0, 1.0))
        dust = g.math('MAXIMUM', g.math('MAXIMUM', boot_d, knee_d), up_d)
        if name in ('skin', 'lens', 'eye', 'lip', 'metal', 'flag', 'tape'):
            dust = 0.0
        if isinstance(dust, float):
            comb.inputs[2].default_value = 0.0
        else:
            nt.links.new(dust, comb.inputs[2])
        nt.links.new(comb.outputs[0], em.inputs['Color'])

        # ---- bump branch ---------------------------------------------------
        def noise(scale, detail=3.0, rough=0.55, vec=None):
            n = nt.nodes.new('ShaderNodeTexNoise')
            n.noise_dimensions = '3D'
            n.inputs['Scale'].default_value = scale
            n.inputs['Detail'].default_value = detail
            n.inputs['Roughness'].default_value = rough
            nt.links.new(vec if vec is not None else P, n.inputs['Vector'])
            return n.outputs['Fac']

        def checker(scale):
            n = nt.nodes.new('ShaderNodeTexChecker')
            n.inputs['Scale'].default_value = scale
            nt.links.new(P, n.inputs['Vector'])
            return n.outputs['Fac']

        def comb3(a, b, c):
            n = nt.nodes.new('ShaderNodeCombineXYZ')
            g.set(n.inputs[0], a)
            g.set(n.inputs[1], b)
            g.set(n.inputs[2], c)
            return n.outputs[0]

        def stretched_noise(sx, sy, sz, detail=2.0):
            return noise(1.0, detail, 0.5, comb3(g.math('MULTIPLY', X, sx), g.math('MULTIPLY', Y, sz), g.math('MULTIPLY', Z, sy)))

        height = 0.5
        rough = ROUGH[name]
        rough_var = None
        strength = 0.35
        if name == 'camo':
            # ripstop weave + fibre grain + creases that gather at elbows, knees and hips
            weave = g.math('MULTIPLY', checker(190.0), 0.5)
            fibre = g.math('MULTIPLY', noise(900.0, 1.0, 0.5), 0.5)
            wr = stretched_noise(7.0, 46.0, 7.0, 3.0)                 # horizontal folds
            elbow = g.math('MULTIPLY', g.maprange(g.math('ABSOLUTE', g.math('SUBTRACT', gz, 1.21)), 0.0, 0.085, 1.0, 0.0),
                           g.maprange(g.math('ABSOLUTE', gx), 0.15, 0.19, 0.0, 1.0))
            knee = g.maprange(g.math('ABSOLUTE', g.math('SUBTRACT', gz, 0.5)), 0.0, 0.09, 1.0, 0.0)
            hip = g.math('MULTIPLY', g.maprange(g.math('ABSOLUTE', g.math('SUBTRACT', gz, 0.95)), 0.0, 0.08, 1.0, 0.0),
                         g.maprange(g.math('ABSOLUTE', gx), 0.0, 0.05, 0.5, 1.0))
            fold = g.math('MULTIPLY', g.math('MAXIMUM', g.math('MAXIMUM', elbow, knee), hip), g.math('SUBTRACT', wr, 0.35))
            height = g.math('ADD', g.math('ADD', weave, fibre), g.math('MULTIPLY', fold, 5.5))
            strength = 0.55
            rough_var = g.math('MULTIPLY', noise(60.0, 2.0), 0.14)
        elif name in ('gear', 'gearDark'):
            # cordura grain; MOLLE rows (25 mm webbing, stitched slots) on the coyote webbing
            ang = g.math('ARCTAN2', gy, gx)
            u = g.math('MULTIPLY', ang, 0.17)
            vv = comb3(u, gz, 0.0)
            brick = nt.nodes.new('ShaderNodeTexBrick')
            brick.offset = 0.0
            brick.inputs['Scale'].default_value = 1.0 / 0.0125
            brick.inputs['Mortar Size'].default_value = 0.06
            brick.inputs['Mortar Smooth'].default_value = 0.1
            brick.inputs['Brick Width'].default_value = 3.0
            brick.inputs['Row Height'].default_value = 1.0
            nt.links.new(vv, brick.inputs['Vector'])
            wave = nt.nodes.new('ShaderNodeTexWave')
            wave.wave_type = 'BANDS'
            wave.bands_direction = 'Y'
            wave.wave_profile = 'SAW'
            wave.inputs['Scale'].default_value = 1.0 / 0.0125
            nt.links.new(vv, wave.inputs['Vector'])
            grain = g.math('MULTIPLY', checker(260.0), 0.35)
            fibre = g.math('MULTIPLY', noise(700.0, 1.0, 0.5), 0.45)
            molle_mask = g.maprange(gz, 1.19, 1.215, 0.0, 1.0)
            molle_mask = g.math('MULTIPLY', molle_mask, g.maprange(gz, 1.52, 1.50, 0.0, 1.0))
            molle_mask = g.math('MULTIPLY', molle_mask, g.maprange(g.math('ABSOLUTE', gx), 0.17, 0.152, 0.0, 1.0))
            molle_mask = g.math('MULTIPLY', molle_mask, g.maprange(g.math('ABSOLUTE', gy), 0.092, 0.11, 0.0, 1.0)) if name == 'gear' else 0.0
            slot = nt.nodes.new('ShaderNodeMath')
            slot.operation = 'MULTIPLY'
            nt.links.new(brick.outputs['Fac'], slot.inputs[0])
            nt.links.new(g.math('MULTIPLY', wave.outputs['Fac'], 0.0), slot.inputs[1]) if False else None
            slot.inputs[1].default_value = 1.0
            ridges = g.math('MULTIPLY', g.math('SUBTRACT', wave.outputs['Fac'], 0.5), 0.5)
            molle = g.math('MULTIPLY', g.math('SUBTRACT', brick.outputs['Fac'], 0.5), 2.0)
            molle = g.math('ADD', molle, ridges)
            height = g.math('ADD', g.math('ADD', grain, fibre), g.math('MULTIPLY', molle, molle_mask) if not isinstance(molle_mask, float) else 0.0)
            strength = 0.5 if name == 'gear' else 0.35
            rough_var = g.math('MULTIPLY', noise(45.0, 2.0), 0.12)
        elif name == 'boot':
            # suede grain, creases at the flex line, lace bands up the front
            grain = g.math('MULTIPLY', noise(380.0, 2.0, 0.6), 0.6)
            crease = g.math('MULTIPLY', stretched_noise(14.0, 70.0, 14.0, 2.0), 0.4)
            lace = nt.nodes.new('ShaderNodeTexWave')
            lace.wave_type = 'BANDS'
            lace.bands_direction = 'Y'
            lace.wave_profile = 'SIN'
            lace.inputs['Scale'].default_value = 1.0 / 0.0125
            nt.links.new(comb3(0.0, gz, 0.0), lace.inputs['Vector'])
            lace_mask = g.math('MULTIPLY', g.maprange(gz, 0.07, 0.09, 0.0, 1.0), g.maprange(gy, 0.0, -0.03, 0.0, 1.0))
            lace_mask = g.math('MULTIPLY', lace_mask, g.maprange(g.math('ABSOLUTE', g.math('SUBTRACT', g.math('MULTIPLY', g.math('ABSOLUTE', gx), 1.0), 0.1)), 0.03, 0.015, 0.0, 1.0))
            height = g.math('ADD', g.math('ADD', grain, crease), g.math('MULTIPLY', g.math('SUBTRACT', lace.outputs['Fac'], 0.5), g.math('MULTIPLY', lace_mask, 1.6)))
            strength = 0.7
            rough_var = g.math('MULTIPLY', noise(50.0, 2.0), 0.14)
        elif name == 'rubber':
            lug = nt.nodes.new('ShaderNodeTexBrick')
            lug.offset = 0.5
            lug.inputs['Scale'].default_value = 1.0 / 0.011
            lug.inputs['Mortar Size'].default_value = 0.22
            lug.inputs['Mortar Smooth'].default_value = 0.08
            lug.inputs['Brick Width'].default_value = 1.8
            nt.links.new(comb3(gx, g.math('MULTIPLY', gy, 1.0), 0.0), lug.inputs['Vector'])
            height = g.math('ADD', g.math('MULTIPLY', lug.outputs['Fac'], 1.6), g.math('MULTIPLY', noise(420.0, 1.0), 0.3))
            strength = 0.9
            rough_var = g.math('MULTIPLY', noise(70.0, 1.0), 0.06)
        elif name == 'glove':
            knit = g.math('MULTIPLY', checker(300.0), 0.4)
            grain = g.math('MULTIPLY', noise(500.0, 2.0, 0.6), 0.5)
            height = g.math('ADD', knit, grain)
            strength = 0.45
            rough_var = g.math('MULTIPLY', noise(80.0, 2.0), 0.14)
        elif name == 'skin':
            height = g.math('MULTIPLY', noise(520.0, 2.0, 0.6), 0.6)
            strength = 0.18
            rough_var = g.math('MULTIPLY', noise(35.0, 2.0), 0.12)
        elif name in ('black', 'accent', 'flag', 'tape'):
            height = g.math('ADD', g.math('MULTIPLY', noise(420.0, 2.0), 0.5), g.math('MULTIPLY', checker(220.0), 0.2))
            strength = 0.3
            rough_var = g.math('MULTIPLY', noise(60.0, 2.0), 0.1)
        else:   # metal, lens, lip, eye
            height = g.math('MULTIPLY', noise(600.0, 2.0), 0.15)
            strength = 0.05
            rough_var = g.math('MULTIPLY', noise(90.0, 2.0), 0.08) if name == 'metal' else None

        pr = nt.nodes.new('ShaderNodeBsdfPrincipled')
        bump = nt.nodes.new('ShaderNodeBump')
        bump.inputs['Strength'].default_value = strength
        bump.inputs['Distance'].default_value = 0.018
        g.set(bump.inputs['Height'], height)
        nt.links.new(bump.outputs['Normal'], pr.inputs['Normal'])
        if rough_var is None:
            pr.inputs['Roughness'].default_value = rough
        else:
            g.set(pr.inputs['Roughness'], g.math('ADD', rough - 0.07, rough_var, clamp=True))
        pr.inputs['Base Color'].default_value = (0.5, 0.5, 0.5, 1)

        target = nt.nodes.new('ShaderNodeTexImage')   # bake target (must be the active node)
        target.name = 'target'
        nt.nodes.active = target
        m['em'], m['pr'] = em.name, pr.name
        m['out'] = out.name
        nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
        materials[name] = m


def set_pass(kind):
    for m in materials.values():
        nt = m.node_tree
        out = nt.nodes[m['out']]
        for l in list(out.inputs['Surface'].links):
            nt.links.remove(l)
        if kind == 'id':
            nt.links.new(nt.nodes[m['em']].outputs['Emission'], out.inputs['Surface'])
        else:
            nt.links.new(nt.nodes[m['pr']].outputs['BSDF'], out.inputs['Surface'])


def set_target(img):
    for m in materials.values():
        m.node_tree.nodes['target'].image = img
        m.node_tree.nodes.active = m.node_tree.nodes['target']


build_materials(camo_index_image())

# ---------------------------------------------------------------------------
# body
# ---------------------------------------------------------------------------
# torso: combat shirt over the chest, trousers over the hips. (y, cx, cz, rx, rf, rb, p)
TORSO = [
    (0.83, 0, 0.002, 0.100, 0.075, 0.082, 2.1), (0.875, 0, 0.003, 0.140, 0.092, 0.101, 2.2), (0.93, 0, 0.004, 0.160, 0.100, 0.112, 2.3), (0.99, 0, 0.002, 0.158, 0.098, 0.108, 2.3),
    (1.07, 0, 0.0, 0.140, 0.090, 0.095, 2.3), (1.16, 0, 0.0, 0.148, 0.096, 0.098, 2.3), (1.27, 0, -0.002, 0.164, 0.106, 0.104, 2.4),
    (1.37, 0, -0.004, 0.180, 0.112, 0.105, 2.5), (1.44, 0, -0.002, 0.190, 0.102, 0.098, 2.6), (1.49, 0, 0.0, 0.172, 0.082, 0.082, 2.5),
    (1.525, 0, 0.0, 0.105, 0.066, 0.068, 2.2), (1.55, 0, 0.003, 0.068, 0.058, 0.062, 2.1),
]
torso_v = vloft(TORSO, [0.83 + 0.72 / 18 * i for i in range(19)], seg=16, p=2.4)
torso = emit('torso', 'camo', None, torso_v)
for p in torso.data.polygons:   # collar edge is shirt; nothing else
    pass


def torso_w(x, y, z):
    chest = smooth(1.17, 1.33, y)
    spine = smooth(0.99, 1.11, y)
    return [('chest', chest), ('spine', (1 - chest) * spine), ('hips', (1 - chest) * (1 - spine))]


weights(torso, torso_w)

# neck (skin) and head
neck_keys = [(1.49, 0, 0.0, 0.056, 0.058, 0.062, 2.1), (1.54, 0, 0.0, 0.052, 0.056, 0.060, 2.1), (1.60, 0, -0.004, 0.050, 0.052, 0.052, 2.1)]
neck = emit('neck', 'skin', None, vloft(neck_keys, [1.49 + 0.0275 * i for i in range(5)], seg=10))
weights(neck, lambda x, y, z: [('head', smooth(1.50, 1.56, y)), ('chest', 1 - smooth(1.50, 1.56, y))])

HEAD = [
    (1.563, 0, -0.050, 0.020, 0.024, 0.026, 2.1), (1.572, 0, -0.045, 0.036, 0.040, 0.044, 2.1), (1.584, 0, -0.034, 0.052, 0.060, 0.058, 2.2),
    (1.600, 0, -0.020, 0.064, 0.075, 0.072, 2.2), (1.625, 0, -0.008, 0.071, 0.088, 0.088, 2.2), (1.655, 0, 0.0, 0.076, 0.094, 0.096, 2.2),
    (1.690, 0, 0.0, 0.078, 0.096, 0.100, 2.2), (1.720, 0, 0.0, 0.077, 0.094, 0.102, 2.2), (1.750, 0, 0.004, 0.072, 0.084, 0.098, 2.2),
    (1.775, 0, 0.008, 0.058, 0.062, 0.082, 2.1), (1.793, 0, 0.012, 0.030, 0.032, 0.048, 2.0),
]
head = emit('head', 'skin', 'head', vloft(HEAD, [1.563 + 0.0144 * i for i in range(17)], seg=16, p=2.2))
# face: brow ridge, nose, lips, ears, eyes
emit('brow', 'skin', 'head', sweep([(-0.074, 1.708, -0.052), (-0.052, 1.711, -0.084), (-0.022, 1.713, -0.0925), (0.022, 1.713, -0.0925),
                                    (0.052, 1.711, -0.084), (0.074, 1.708, -0.052)], 0.0095, 0.0105, seg=8, p=2.2, ref=(0, 1, 0)))
emit('nose', 'skin', 'head', sweep([(0, 1.688, -0.088), (0, 1.668, -0.102), (0, 1.649, -0.1065), (0, 1.644, -0.1055)],
                                   [0.0052, 0.0072, 0.0092, 0.0085], [0.0058, 0.0078, 0.0088, 0.0072], seg=8, p=2.4, ref=(1, 0, 0)))
emit('lipU', 'lip', 'head', sweep([(-0.026, 1.619, -0.07), (-0.012, 1.6225, -0.0865), (0.0, 1.6235, -0.0895), (0.012, 1.6225, -0.0865), (0.026, 1.619, -0.07)],
                                  0.003, 0.0042, seg=6, ref=(0, 1, 0)))
emit('lipL', 'lip', 'head', sweep([(-0.022, 1.608, -0.071), (-0.010, 1.6095, -0.0855), (0.0, 1.6095, -0.0875), (0.010, 1.6095, -0.0855), (0.022, 1.608, -0.071)],
                                  0.0034, 0.0045, seg=6, ref=(0, 1, 0)))
emit('chinp', 'skin', 'head', sweep([(0, 1.592, -0.06), (0, 1.579, -0.073)], 0.016, 0.014, seg=8, ref=(1, 0, 0)))
for s in (-1, 1):
    ear = [(1.627, s * 0.0775, 0.014, 0.0045, 0.012, 0.011, 2.0), (1.646, s * 0.0795, 0.011, 0.0065, 0.018, 0.015, 2.0),
           (1.668, s * 0.0795, 0.010, 0.0065, 0.019, 0.016, 2.0), (1.688, s * 0.078, 0.012, 0.005, 0.014, 0.012, 2.0)]
    ear = [(a[0], a[1], a[2], a[3], a[4], a[5], a[6]) for a in ear]
    emit('ear%d' % s, 'skin', 'head', vloft(ear, [1.627 + 0.0153 * i for i in range(5)], seg=10))
    blob('eye%d' % s, 'eye', 'head', (s * 0.031, 1.692, -0.0815), (0.0105, 0.0095, 0.0085))

# ballistic glasses: wraparound lens, frame bar, temple arms, nose pad
lens_path, rim_path = [], []
for k in range(13):
    ph = math.radians(-74 + 148 * k / 12)
    lens_path.append((0.0905 * math.sin(ph) * 0.97 + 0.0, 1.693, 0.0 - 0.1085 * math.cos(ph) * 0.97 + 0.0))
emit('lens', 'lens', 'head', sweep(lens_path, 0.0245, 0.0026, seg=6, p=4.0, ref=(0, 1, 0)), sharp=60)
emit('lensbar', 'black', 'head', sweep([(q[0], 1.7195, q[2] - 0.0006) for q in lens_path], 0.0028, 0.0042, seg=4, p=2.5, ref=(0, 1, 0)))
for s in (-1, 1):
    a = lens_path[0] if s < 0 else lens_path[-1]
    emit('temple%d' % s, 'black', 'head', sweep([(a[0], 1.703, a[2]), (s * 0.0885, 1.703, a[2] + 0.04), (s * 0.0825, 1.700, 0.055)],
                                                 0.0042, 0.0022, seg=6, ref=(0, 1, 0)))
emit('nosepad', 'black', 'head', sweep([(-0.012, 1.690, -0.0985), (0.0, 1.686, -0.1015), (0.012, 1.690, -0.0985)], 0.0050, 0.0042, seg=6, ref=(0, 1, 0)))

# helmet (MICH-style) with camouflage cover: a dome whose rim runs high at the brow and low at the ears and nape
YC, HH, HA, HCF, HCB, HCZ = 1.688, 0.136, 0.108, 0.121, 0.131, 0.007


def rim_y(theta):
    c = math.cos(theta)
    return 1.668 + 0.071 * max(0.0, c) ** 1.4 - 0.014 * max(0.0, -c) ** 1.2 + 0.0 * math.sin(theta)


SEG_H, ROWS_H = 28, 7
hv, hf = [], []
for j in range(ROWS_H + 1):
    for k in range(SEG_H):
        th = 2 * math.pi * k / SEG_H
        y0 = rim_y(th)
        y = lerp(y0, YC + HH * 0.9999, math.sin(0.5 * math.pi * j / ROWS_H) ** 0.9 if j else 0.0)
        # flatter crown: stretch the dome vertically with a superellipse profile
        hv.append(Vector(plan_pt(th, y, YC, HH, HA, HCF, HCB, HCZ)))
for j in range(ROWS_H):
    for k in range(SEG_H):
        k2 = (k + 1) % SEG_H
        hf.append((j * SEG_H + k, (j + 1) * SEG_H + k, (j + 1) * SEG_H + k2, j * SEG_H + k2))
bm = bmesh.new()
bvs = [bm.verts.new(B(v)) for v in hv]
for f in hf:
    bm.faces.new([bvs[i] for i in f])
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
helmet = new_object('helmet', bm, 'camo')
helmet.modifiers.new('solid', 'SOLIDIFY').thickness = 0.011
helmet.modifiers['solid'].offset = -1.0
bpy.context.view_layer.update()
dg = bpy.context.evaluated_depsgraph_get()
_me = bpy.data.meshes.new_from_object(helmet.evaluated_get(dg))
_old = helmet.data
helmet.modifiers.clear()
helmet.data = _me
bpy.data.meshes.remove(_old)
finish_mesh(helmet, 62)
unwrap_object(helmet, False)
weights(helmet, rigid('head'))
# the dome faces outward only if its top normal points up; flip if not
_top = max(helmet.data.polygons, key=lambda p: p.center.z)
if _top.normal.z < 0:
    bpy.context.view_layer.objects.active = helmet
    bm2 = bmesh.new()
    bm2.from_mesh(helmet.data)
    bmesh.ops.reverse_faces(bm2, faces=bm2.faces[:])
    bm2.to_mesh(helmet.data)
    bm2.free()
    print('helmet normals flipped')


def helm_ring(y, grow):
    pts = []
    for k in range(32):
        th = 2 * math.pi * k / 32
        x, yy, z = plan_pt(th, y, YC, HH, HA + grow, HCF + grow, HCB + grow, HCZ)
        pts.append((x, yy, z))
    return pts


emit('helmband', 'gearDark', 'head', sweep(helm_ring(1.746, 0.0016), 0.0075, 0.0034, seg=4, p=3.0, ref=(0, 1, 0), loop=True))
box('nvgmount', 'black', 'head', (0.074, 0.05, 0.034), (0, 1.778, -0.1055), bevel=0.0065, seg=2, rot_x=-0.38)
box('nvgplate', 'metal', 'head', (0.046, 0.032, 0.012), (0, 1.7765, -0.1275), bevel=0.003, seg=2, rot_x=-0.38)
for s in (-1, 1):
    # side accessory rails and the stiff ear-cup headset
    box('rail%d' % s, 'metal', 'head', (0.011, 0.02, 0.118), (s * 0.1105, 1.742, 0.0), bevel=0.0035, seg=2)
    cup = [(s * 0.0805, 1.66, 0.006), (s * 0.0905, 1.66, 0.006), (s * 0.1005, 1.66, 0.006), (s * 0.1075, 1.66, 0.006)]
    emit('cup%d' % s, 'gearDark', 'head', sweep(cup, [0.043, 0.047, 0.045, 0.038], [0.034, 0.038, 0.036, 0.029], seg=14, p=2.4, ref=(0, 1, 0)))
    emit('cupcap%d' % s, 'black', 'head', sweep([(s * 0.1015, 1.66, 0.006), (s * 0.1095, 1.66, 0.006)], 0.024, 0.019, seg=12, ref=(0, 1, 0)))
    # headset arm under the helmet rim
    emit('hband%d' % s, 'black', 'head', sweep([(s * 0.0885, 1.69, 0.006), (s * 0.0875, 1.712, 0.0), (s * 0.0855, 1.742, -0.004)], 0.0055, 0.0030, seg=6, ref=(0, 0, 1)))
emit('mic', 'black', 'head', sweep([(-0.099, 1.652, 0.0), (-0.1, 1.642, -0.044), (-0.083, 1.628, -0.09), (-0.05, 1.6225, -0.1015)], 0.0021, 0.0021, seg=6, ref=(0, 1, 0)))
blob('micfoam', 'black', 'head', (-0.045, 1.6225, -0.1035), (0.0072, 0.0068, 0.0068), seg=8, rings=5)
# chin strap: from the helmet shell down both cheeks and under the chin
strap = [(-0.1, 1.700, 0.012), (-0.0915, 1.664, -0.012), (-0.077, 1.617, -0.04), (-0.052, 1.581, -0.06), (-0.02, 1.565, -0.066),
         (0.02, 1.565, -0.066), (0.052, 1.581, -0.06), (0.077, 1.617, -0.04), (0.0915, 1.664, -0.012), (0.1, 1.700, 0.012)]
emit('chinstrap', 'gearDark', 'head', sweep(strap, 0.0078, 0.0026, seg=6, p=3.0, ref=(0, 0, 1)))
box('chincup', 'gearDark', 'head', (0.045, 0.022, 0.03), (0, 1.567, -0.074), bevel=0.007, seg=2, rot_x=0.4)

# ---- arms: sleeves, pads, gloved hands -------------------------------------
ARM = [
    (1.548, 0.0, 0.0, 0.030, 0.030, 0.030, 2.0), (1.532, 0.0, 0.0, 0.050, 0.048, 0.048, 2.0), (1.51, 0.0, 0.0, 0.066, 0.062, 0.062, 2.0), (1.48, 0.0, 0.0, 0.0735, 0.067, 0.068, 2.1),
    (1.43, 0.0, 0.0, 0.069, 0.062, 0.064, 2.1), (1.35, 0.0, 0.001, 0.063, 0.058, 0.060, 2.1), (1.28, 0.0, 0.002, 0.057, 0.054, 0.056, 2.1),
    (1.21, 0.0, 0.003, 0.053, 0.051, 0.053, 2.1), (1.15, 0.0, 0.002, 0.056, 0.055, 0.053, 2.1), (1.07, 0.0, -0.001, 0.051, 0.051, 0.047, 2.1),
    (1.00, 0.0, -0.002, 0.046, 0.045, 0.043, 2.1), (0.955, 0.0, -0.002, 0.0455, 0.0445, 0.0445, 2.1),
]
ARM = [(r[0], r[1], r[2]) + tuple(q * (0.93 if r[0] < 1.55 else 1.0) for q in r[3:6]) + (r[6],) for r in ARM]
ARM_YS = [1.548, 1.536, 1.52, 1.50, 1.47, 1.43, 1.37, 1.31, 1.26, 1.225, 1.205, 1.185, 1.15, 1.10, 1.04, 0.99, 0.955]


def arm_ring(y):
    return resample(ARM, [y])[0]


def ARM_CX(y):
    """offset of the sleeve centre line from the bone axis (x = 0.225): shoulders sit narrower, arms hang slightly outwards"""
    return -0.022 * smooth(1.0, 1.52, y) + 0.0


PATCH = {'flag': (0.875, 0.02, 0.995, 0.10), 'tape': (0.875, 0.12, 0.995, 0.144)}
FLAG_DIM = {}

for s, L in ((-1, 'L'), (1, 'R')):
    ax = s * 0.225
    keys = [(r[0], ax + s * (r[1] + ARM_CX(r[0])), r[2], r[3], r[4], r[5], r[6]) for r in ARM]
    sleeve = emit('sleeve' + L, 'camo', None, vloft(keys, ARM_YS, seg=14, p=2.1))

    def arm_w(x, y, z, L=L):
        if y > 1.30:
            t = smooth(1.46, 1.57, y)
            return [('chest', t), ('arm' + L, 1 - t)]
        if y > 1.0:
            return blend2('arm' + L, 'fore' + L, 1.205, 0.075, y)
        return blend2('fore' + L, 'hand' + L, 0.93, 0.025, y)

    weights(sleeve, arm_w)
    # armband / ID patch ring
    for yy, hh in ((1.355, 0.026),):
        k2 = [(r[0], ax + s * (r[1] + ARM_CX(r[0])), r[2], r[3] + 0.0032, r[4] + 0.0032, r[5] + 0.0032, r[6]) for r in resample(ARM, [yy - hh, yy - hh * 0.5, yy, yy + hh * 0.5, yy + hh])]
        emit('band' + L, 'accent', 'arm' + L, vloft(k2, None, seg=16, p=2.1))
    # shoulder flag, bent around the sleeve
    fy0, fy1, fw = 1.40, 1.452, 0.036
    gv, gf = [], []
    zs = [-fw + 2 * fw * k / 6 for k in range(7)]
    ysx = [fy0, fy1]
    for yy in ysx:
        r = arm_ring(yy)
        for z in zs:
            rz = r[4] if z < 0 else r[5]
            xx = r[3] * math.sqrt(max(0.0, 1 - (z / rz) ** 2) ** 1) + 0.0042
            gv.append((ax + s * (r[1] + ARM_CX(yy) + xx), yy, z + r[2]))
    for k in range(6):
        gf.append((k, k + 1, 7 + k + 1, 7 + k) if s > 0 else (k + 1, k, 7 + k, 7 + k + 1))
    ob = emit('flag' + L, 'flag', 'arm' + L, (gv, gf), closed=False, sharp=0)
    ob['patch'] = 'flag'
    # elbow pad and wrist cuff (kit), sleeve hem cord
    box('elbowpad' + L, 'gearDark', 'fore' + L, (0.074, 0.098, 0.038), (ax + s * ARM_CX(1.2), 1.208, 0.056), bevel=0.016, seg=2)
    box('elbowcap' + L, 'black', 'fore' + L, (0.05, 0.06, 0.014), (ax + s * ARM_CX(1.2), 1.208, 0.0745), bevel=0.0065, seg=2)
    emit('hem' + L, 'camo', 'fore' + L, vloft([(0.985 - 0.0, ax + s * 0.0, -0.002, 0.0485, 0.0475, 0.0475, 2.1), (0.958, ax, -0.002, 0.0495, 0.0485, 0.0485, 2.1),
                                                (0.948, ax, -0.002, 0.0475, 0.0465, 0.0465, 2.1)][::-1], None, seg=16, p=2.1))
    emit('velcrocuff' + L, 'gearDark', 'hand' + L, vloft([(0.972, ax, -0.002, 0.0405, 0.0405, 0.0405, 2.1), (0.944, ax, -0.002, 0.0405, 0.0405, 0.0405, 2.1)], None, seg=14, p=2.1))

    # ---- hand: relaxed trigger-grip, built in (inward, down, forward) coordinates from the wrist
    def hp(i, d, f):
        return (ax - s * i, 0.95 - d, -f)

    palm = [(-0.014, 0.0, 0.026, 0.040), (0.0, 0.002, 0.0255, 0.040), (0.028, 0.004, 0.0205, 0.041), (0.058, 0.007, 0.0185, 0.0445),
            (0.086, 0.009, 0.0170, 0.0455), (0.096, 0.0095, 0.0145, 0.0425)]
    palm_path = [hp(r[1], r[0], 0.0) for r in palm]
    emit('palm' + L, 'glove', 'hand' + L, sweep(palm_path, [r[2] for r in palm], [r[3] for r in palm], seg=14, p=2.5, ref=(1, 0, 0)))
    emit('cuff' + L, 'glove', 'hand' + L, sweep([hp(0.0, -0.040, 0.0), hp(0.0, -0.012, 0.0), hp(0.0, 0.010, 0.0)], [0.0335, 0.0345, 0.0325],
                                                  [0.0425, 0.0445, 0.0430], seg=16, p=2.6, ref=(1, 0, 0)))
    # thenar pad under the thumb
    emit('thenar' + L, 'glove', 'hand' + L, sweep([hp(0.008, 0.012, 0.034), hp(0.013, 0.036, 0.040)], 0.0165, 0.0185, seg=10, p=2.2, ref=(1, 0, 0)))
    fingers = [  # name, forward offset, knuckle d, segment lengths, curl per joint (deg), radius
        ('idx', 0.0285, 0.0955, (0.034, 0.022, 0.019), (22, 38, 20), 0.0102),
        ('mid', 0.0095, 0.0965, (0.038, 0.025, 0.020), (38, 58, 34), 0.0106),
        ('rng', -0.0095, 0.0955, (0.034, 0.024, 0.019), (48, 64, 38), 0.0099),
        ('pnk', -0.0285, 0.0925, (0.029, 0.018, 0.017), (54, 68, 40), 0.0088),
    ]
    for nm, f, d0, lens, curl, rad in fingers:
        i, d, ang = 0.0075, d0, 0.0
        pts, rr = [(ax - s * i, 0.95 - d + 0.006, -f)], [rad * 1.02]
        for seg_i, (ln, cv) in enumerate(zip(lens, curl)):
            for sub in range(1, 3):
                a_prev = math.radians(sum(curl[:seg_i]))
                a_now = a_prev + math.radians(cv) * (sub / 2.0)
                am = 0.5 * (a_prev + a_now) if sub == 1 else 0.5 * (a_prev + math.radians(cv) * 0.5 + a_now)
                # advance half a segment along the mean direction of that half
                ang_s = a_prev + math.radians(cv) * ((sub - 0.5) / 2.0)
                i += math.sin(ang_s) * ln / 2
                d += math.cos(ang_s) * ln / 2
                pts.append((ax - s * i, 0.95 - d, -f))
                rr.append(rad * (1.0 - 0.07 * (seg_i * 2 + sub)))
        rr[-1] *= 0.82
        emit('f_%s%s' % (nm, L), 'glove', 'hand' + L, sweep(pts, rr, rr, seg=8, p=2.2, ref=(0, 0, 1)))
        # finger-tip and joint panels in TPR on the back of the glove would be texture; knuckle guard below
    # thumb
    th = [(0.007, 0.018, 0.038), (0.012, 0.040, 0.050), (0.021, 0.060, 0.053), (0.032, 0.077, 0.047), (0.040, 0.089, 0.040), (0.0435, 0.096, 0.035)]
    tr = [0.0135, 0.0125, 0.0112, 0.0102, 0.0090, 0.0072]
    emit('thumb' + L, 'glove', 'hand' + L, sweep([hp(*q) for q in th], tr, tr, seg=8, p=2.2, ref=(0, 0, 1)))
    # knuckle guard + back-of-hand plate
    box('knuckle' + L, 'gearDark', 'hand' + L, (0.0105, 0.030, 0.076), (ax + s * 0.0185, 0.95 - 0.080, 0.0), bevel=0.0045, seg=2)

# ---- legs: trousers, knee pads, boots ----------------------------------------
LEG = [
    (1.00, 0, 0.0, 0.107, 0.100, 0.108, 2.2), (0.93, 0, 0.0, 0.103, 0.097, 0.106, 2.2), (0.84, 0, 0.0, 0.098, 0.092, 0.099, 2.2),
    (0.73, 0, 0.0, 0.090, 0.085, 0.090, 2.2), (0.62, 0, 0.0, 0.080, 0.076, 0.078, 2.2), (0.545, 0, 0.0, 0.073, 0.070, 0.070, 2.2),
    (0.50, 0, 0.001, 0.072, 0.069, 0.070, 2.2), (0.455, 0, 0.003, 0.071, 0.066, 0.075, 2.2), (0.39, 0, 0.007, 0.069, 0.064, 0.081, 2.2),
    (0.32, 0, 0.007, 0.065, 0.061, 0.075, 2.2), (0.25, 0, 0.004, 0.064, 0.060, 0.068, 2.2), (0.20, 0, 0.0, 0.066, 0.064, 0.066, 2.2),
]
LEG_YS = [1.00, 0.95, 0.88, 0.80, 0.72, 0.64, 0.57, 0.52, 0.49, 0.455, 0.40, 0.34, 0.28, 0.23, 0.20]
for s, L in ((-1, 'L'), (1, 'R')):
    lx = s * 0.1
    keys = [(r[0], lx + r[1], r[2], r[3], r[4], r[5], r[6]) for r in LEG]
    leg = emit('leg' + L, 'camo', None, vloft(keys, LEG_YS, seg=12, p=2.2))

    def leg_w(x, y, z, L=L):
        if y > 0.72:
            t = smooth(0.86, 1.0, y)
            return [('thigh' + L, t), ('hips', 1 - t)]
        return blend2('thigh' + L, 'shin' + L, 0.50, 0.075, y)

    weights(leg, leg_w)
    # cargo pocket with flap, thigh
    box('cargo' + L, 'camo', 'thigh' + L, (0.04, 0.17, 0.125), (lx + s * 0.0905, 0.74, 0.0), bevel=0.010, seg=2)
    box('cargoflap' + L, 'camo', 'thigh' + L, (0.043, 0.05, 0.13), (lx + s * 0.0925, 0.80, 0.0), bevel=0.008, seg=2)
    # knee pad on the shin
    box('kneepad' + L, 'gearDark', 'shin' + L, (0.094, 0.125, 0.036), (lx, 0.478, -0.0675), bevel=0.016, seg=2, rot_x=0.12)
    box('kneecup' + L, 'black', 'shin' + L, (0.062, 0.07, 0.014), (lx, 0.478, -0.0865), bevel=0.0065, seg=2, rot_x=0.12)
    emit('kneestrap' + L, 'gearDark', 'shin' + L, vloft([(0.425, lx, 0.0, 0.0735, 0.0695, 0.0745, 2.2), (0.405, lx, 0.0, 0.0735, 0.0695, 0.0745, 2.2)], None, seg=16, p=2.2))
    # boot: shaft on the shin (blended to the foot at the ankle), foot with sole and heel
    shaft = [(0.045, lx, 0.003, 0.054, 0.056, 0.058, 2.2), (0.09, lx, 0.003, 0.053, 0.056, 0.057, 2.2), (0.14, lx, 0.003, 0.054, 0.056, 0.056, 2.2),
             (0.19, lx, 0.003, 0.058, 0.058, 0.057, 2.2), (0.226, lx, 0.003, 0.0615, 0.060, 0.059, 2.2), (0.236, lx, 0.003, 0.060, 0.059, 0.058, 2.2)]
    sh = emit('shaft' + L, 'boot', None, vloft(shaft, None, seg=16, p=2.2))
    weights(sh, lambda x, y, z, L=L: [('shin' + L, smooth(0.07, 0.15, y)), ('foot' + L, 1 - smooth(0.07, 0.15, y))])
    emit('bootcollar' + L, 'gearDark', 'shin' + L, vloft([(0.2215, lx, 0.003, 0.0645, 0.0625, 0.0615, 2.2), (0.2475, lx, 0.003, 0.0635, 0.0615, 0.0605, 2.2)], None, seg=16, p=2.2))
    fz = [0.092, 0.064, 0.025, -0.02, -0.07, -0.12, -0.17, -0.205, -0.222]
    fcy = [0.070, 0.072, 0.066, 0.058, 0.050, 0.044, 0.037, 0.031, 0.027]
    frx = [0.040, 0.045, 0.047, 0.047, 0.049, 0.050, 0.045, 0.034, 0.018]
    fry = [0.054, 0.060, 0.058, 0.050, 0.041, 0.033, 0.027, 0.020, 0.013]
    emit('foot' + L, 'boot', 'foot' + L, sweep([(lx, fcy[i], fz[i]) for i in range(len(fz))], frx, fry, seg=16, p=2.4, ref=(1, 0, 0)))
    sx = [0.043, 0.048, 0.050, 0.0505, 0.0525, 0.0535, 0.0485, 0.037, 0.021]
    syy = [0.021, 0.0135, 0.012, 0.012, 0.012, 0.0125, 0.0125, 0.0115, 0.0085]
    scy = [0.021, 0.0125, 0.0105, 0.0105, 0.0105, 0.0105, 0.0105, 0.0105, 0.0105]
    emit('sole' + L, 'rubber', 'foot' + L, sweep([(lx, scy[i], fz[i] + (0.004 if i == 0 else 0.0)) for i in range(len(fz))], sx, syy, seg=14, p=3.0, ref=(1, 0, 0)))
    # heel block
    box('heel' + L, 'rubber', 'foot' + L, (0.074, 0.026, 0.040), (lx, 0.021, 0.082), bevel=0.006, seg=2)
    # toe cap rand and welt stripe
    emit('welt' + L, 'black', 'foot' + L, sweep([(lx, 0.0235, z) for z in (0.09, 0.06, 0.02, -0.03, -0.08, -0.13, -0.18, -0.208)], [0.0455, 0.0515, 0.0535, 0.0565, 0.0595, 0.0595, 0.054, 0.043],
                                                0.0035, seg=12, p=3.0, ref=(1, 0, 0)))

# ---------------------------------------------------------------------------
# kit
# ---------------------------------------------------------------------------
# belt, holster, dump pouch
emit('belt', 'gear', 'hips', vloft([(1.012, 0, 0.0, 0.1565, 0.1015, 0.1075, 2.4), (1.03, 0, 0.0, 0.1575, 0.1025, 0.1085, 2.4), (1.062, 0, 0.0, 0.1535, 0.1005, 0.1055, 2.4),
                                    (1.072, 0, 0.0, 0.1485, 0.0965, 0.1005, 2.4)], [1.012, 1.02, 1.03, 1.062, 1.072], seg=22, p=2.4))
box('buckle1', 'metal', 'hips', (0.05, 0.034, 0.009), (0, 1.043, -0.1065), bevel=0.003, seg=1)
box('holster', 'gearDark', 'hips', (0.052, 0.19, 0.098), (0.181, 0.945, 0.012), bevel=0.014, seg=2)
box('holsterflap', 'gear', 'hips', (0.055, 0.04, 0.102), (0.1815, 1.02, 0.012), bevel=0.01, seg=2)
box('pistolgrip', 'black', 'hips', (0.026, 0.07, 0.035), (0.181, 1.05, 0.02), bevel=0.006, seg=1, rot_x=-0.22)
box('dump', 'gearDark', 'hips', (0.056, 0.125, 0.105), (-0.182, 0.985, 0.045), bevel=0.016, seg=2)
box('dumpflap', 'gear', 'hips', (0.059, 0.036, 0.109), (-0.1825, 1.04, 0.045), bevel=0.01, seg=2)
box('pouchL', 'gearDark', 'hips', (0.08, 0.1, 0.05), (-0.07, 1.02, 0.128), bevel=0.012, seg=2)
box('pouchR', 'gearDark', 'hips', (0.08, 0.1, 0.05), (0.07, 1.02, 0.128), bevel=0.012, seg=2)

# plate carrier: front / back plate bags, cummerbund, shoulder straps
PL = [(1.195, 0, 0.0, 0.118, 0.028, 0.028, 3.2), (1.212, 0, 0.0, 0.146, 0.032, 0.032, 3.2), (1.27, 0, 0.0, 0.152, 0.033, 0.033, 3.2),
      (1.38, 0, 0.0, 0.153, 0.033, 0.033, 3.2), (1.455, 0, 0.0, 0.147, 0.031, 0.031, 3.2), (1.482, 0, 0.0, 0.126, 0.026, 0.026, 3.2)]
for nm, zc in (('plateF', -0.1395), ('plateB', 0.1385)):
    keys = [(r[0], 0, zc, r[3], r[4], r[5], r[6]) for r in PL]
    emit(nm, 'gear', 'chest', vloft(keys, [1.195, 1.212, 1.27, 1.38, 1.455, 1.482], seg=18, p=3.2))
emit('cummer', 'gear', 'chest', vloft([(1.12, 0, 0.0, 0.17, 0.124, 0.12, 2.5), (1.135, 0, 0.0, 0.18, 0.13, 0.126, 2.5), (1.30, 0, 0.0, 0.1855, 0.131, 0.127, 2.5),
                                       (1.318, 0, 0.0, 0.178, 0.126, 0.122, 2.5)], [1.12, 1.135, 1.20, 1.30, 1.318], seg=24, p=2.5))
for s in (-1, 1):
    st = [(s * 0.088, 1.478, -0.16), (s * 0.09, 1.508, -0.12), (s * 0.098, 1.532, -0.062), (s * 0.108, 1.543, -0.005), (s * 0.108, 1.536, 0.05),
          (s * 0.098, 1.515, 0.1), (s * 0.09, 1.492, 0.152)]
    emit('strap%d' % s, 'gear', 'chest', sweep(st, 0.034, 0.0105, seg=10, p=3.4, ref=(1, 0, 0)))
    box('strapad%d' % s, 'gearDark', 'chest', (0.056, 0.012, 0.11), (s * 0.108, 1.552, 0.0), bevel=0.005, seg=2)
# front pouches: three mag pouches with flaps, admin pouch, tape
for i, x in enumerate((-0.088, 0.0, 0.088)):
    box('mag%d' % i, 'gearDark', 'chest', (0.079, 0.125, 0.044), (x, 1.263, -0.19), bevel=0.011, seg=2)
    box('magflap%d' % i, 'gear', 'chest', (0.082, 0.048, 0.049), (x, 1.307, -0.1915), bevel=0.01, seg=2)
    box('magbuckle%d' % i, 'metal', 'chest', (0.014, 0.016, 0.006), (x, 1.292, -0.217), bevel=0.0018)
box('admin', 'gearDark', 'chest', (0.118, 0.075, 0.032), (0.052, 1.405, -0.1865), bevel=0.01, seg=2)
box('radio', 'gearDark', 'chest', (0.062, 0.14, 0.072), (-0.188, 1.215, 0.0), bevel=0.014, seg=2)
box('radioflap', 'gear', 'chest', (0.065, 0.038, 0.076), (-0.188, 1.275, 0.0), bevel=0.01, seg=2)
emit('antenna', 'black', 'chest', sweep([(-0.188, 1.29, 0.02), (-0.19, 1.43, 0.045), (-0.2, 1.56, 0.07), (-0.206, 1.63, 0.078)], [0.0075, 0.0062, 0.0042, 0.003], [0.0075, 0.0062, 0.0042, 0.003], seg=6, ref=(0, 0, 1)))
emit('radiocable', 'black', 'chest', sweep([(-0.17, 1.30, -0.12), (-0.19, 1.28, -0.1), (-0.205, 1.26, -0.06), (-0.2, 1.255, -0.02)], 0.0032, 0.0032, seg=6, ref=(0, 0, 1)))
quad_tape = (0.0, 1.466, -0.1737)
# back: hydration port, grab handle, small IFAK
box('ifak', 'gearDark', 'chest', (0.125, 0.105, 0.052), (0.075, 1.255, 0.2025), bevel=0.014, seg=2)
box('hydro', 'gearDark', 'chest', (0.1, 0.07, 0.03), (-0.04, 1.43, 0.2), bevel=0.01, seg=2)
emit('handle', 'gear', 'chest', sweep([(-0.04, 1.468, 0.173), (-0.04, 1.492, 0.183), (-0.012, 1.505, 0.19), (0.012, 1.505, 0.19), (0.04, 1.492, 0.183), (0.04, 1.468, 0.173)],
                                      0.0095, 0.0055, seg=6, p=3.0, ref=(0, 0, 1)))
emit('hosetube', 'black', 'chest', sweep([(-0.088, 1.43, 0.21), (-0.09, 1.52, 0.192), (-0.075, 1.563, 0.12), (-0.058, 1.5675, 0.05)], 0.0058, 0.0058, seg=6, ref=(1, 0, 0)))

# trouser seat patches / belt loops not modelled; name tape and its backing
tape_ob = None
bm = bmesh.new()
x, y, z = quad_tape
pts = [(x + 0.085, y - 0.017, z), (x - 0.085, y - 0.017, z), (x - 0.085, y + 0.017, z), (x + 0.085, y + 0.017, z)]
bm.faces.new([bm.verts.new(B(*p)) for p in pts])
tape_ob = new_object('tape', bm, 'tape')
weights(tape_ob, rigid('chest'))
tape_ob['patch'] = 'tape'

# ---------------------------------------------------------------------------
# join, unwrap
# ---------------------------------------------------------------------------
if os.environ.get('SOLDIER_DEBUG'):
    _cnt = sorted(((len(o.data.vertices), o.name) for o in objects), reverse=True)
    print('TOP', _cnt[:28])
    print('boxes-ish (<=60 verts):', sum(c for c, _ in _cnt if c <= 60), 'in', sum(1 for c, _ in _cnt if c <= 60))
    for ob in objects:
        c = np.array([v.co[:] for v in ob.data.vertices])
        lo, hi = c.min(0), c.max(0)
        if max(hi - lo) > 0.7 or lo.min() < -1 or hi.max() > 2:
            print('BIG', ob.name, lo, hi)
for ob in bpy.context.scene.objects:
    ob.select_set(False)
for ob in objects:
    ob.select_set(True)
bpy.context.view_layer.objects.active = objects[0]
bpy.ops.object.join()
body = bpy.context.view_layer.objects.active
body.name = 'soldier'
me = body.data
# the same 16 groups on every part make join cheap; drop empty duplicates not needed
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
scene.tool_settings.use_uv_select_sync = True
bpy.ops.uv.select_all(action='SELECT')
bpy.ops.uv.average_islands_scale()
bpy.ops.uv.pack_islands(rotate=True, margin=0.0028)
bpy.ops.object.mode_set(mode='OBJECT')
uv = me.uv_layers.active.data
# keep a strip on the right free for the flag and the name tape
for l in uv:
    l.uv = (l.uv[0] * 0.86, l.uv[1])
co_ = np.zeros(len(me.vertices) * 3, dtype=np.float32)
me.vertices.foreach_get('co', co_)
co_ = co_.reshape(-1, 3)
for p in me.polygons:
    name = MATS[p.material_index]
    if name not in PATCH:
        continue
    u0, v0, u1, v1 = PATCH[name]
    for li in p.loop_indices:
        c = co_[me.loops[li].vertex_index]
        gx_, gy_, gz_ = c[0], c[2], -c[1]
        if name == 'flag':
            t = (gz_ + 0.036) / 0.072
            fy = (gy_ - 1.40) / 0.052
        else:
            t = (0.085 - gx_) / 0.17
            fy = (gy_ - (quad_tape[1] - 0.017)) / 0.034
        uv[li].uv = (u0 + (u1 - u0) * min(1, max(0, t)), v0 + (v1 - v0) * min(1, max(0, fy)))

# flat material ids for previews / export
print('mesh: %d verts, %d faces' % (len(me.vertices), len(me.polygons)))
_c = co_
print('extents game (x, y, z): %.3f %.3f %.3f ; height %.3f' % ((_c[:, 0].max() - _c[:, 0].min()), (_c[:, 2].max() - _c[:, 2].min()), (_c[:, 1].max() - _c[:, 1].min()), _c[:, 2].max()))


# ---------------------------------------------------------------------------
# bake (Cycles, CPU)
# ---------------------------------------------------------------------------
import zlib

scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.render.bake.margin = 6
scene.render.bake.margin_type = 'EXTEND'
scene.render.bake.use_clear = True
scene.render.bake.normal_space = 'TANGENT'
for o in bpy.context.scene.objects:
    o.select_set(False)
body.select_set(True)
bpy.context.view_layer.objects.active = body


def image_array(img, size, ch=4):
    a = np.zeros(size * size * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return np.flipud(a.reshape(size, size, 4))[..., :ch]


def do_bake(kind, size, samples, name, filt=None):
    img = bpy.data.images.new(name, size, size, alpha=False, is_data=True, float_buffer=True)
    set_target(img)
    set_pass('id' if kind == 'EMIT' else 'pr')
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    if filt is not None:
        scene.cycles.filter_width = filt
    scene.render.bake.margin = max(3, size // 256 * 2)
    bpy.ops.object.bake(type=kind)
    return image_array(img, size)


def downsample(a, f):
    h, w = a.shape[:2]
    return a.reshape(h // f, f, w // f, f, -1).mean(axis=(1, 3))


BAKED = None
CACHE = os.path.join(tempfile.gettempdir(), 'soldier_bake_cache.npz')
SHOTS = [a.split('=')[1].split(',') for a in ARGS if a.startswith('--shots=')]
SHOTS = SHOTS[0] if SHOTS else None
if '--reuse' in ARGS and os.path.exists(CACHE) and not FAST:
    BAKED = dict(np.load(CACHE))
elif not FAST:
    ida = do_bake('EMIT', TEX, 1, 'bake_id', filt=0.01)
    mat_id = np.clip(np.rint(ida[..., 0] * 16), 0, len(MATS)).astype(np.uint8)       # 0 = nothing baked
    level = np.clip(np.rint(ida[..., 1] * 3), 0, 3).astype(np.uint8)
    dustq = np.clip(np.rint(ida[..., 2] * 3), 0, 3).astype(np.uint8)
    print('ID baked: materials used', np.unique(mat_id))
    nrm_hi = do_bake('NORMAL', BAKE_N, 12, 'bake_nrm', filt=1.2)[..., :3]
    nrm_hi = np.where((mat_id == 0)[..., None], np.array([0.5, 0.5, 1.0]), nrm_hi)
    v = nrm_hi * 2 - 1
    v = downsample(v, BAKE_N // TEX_B)
    v /= np.maximum(np.linalg.norm(v, axis=2, keepdims=True), 1e-5)
    nrm = np.clip((v * 0.5 + 0.5) * 255 + 0.5, 0, 255).astype(np.uint8)
    rough = np.clip(do_bake('ROUGHNESS', TEX_B, 4, 'bake_rough', filt=1.2)[..., 0], 0, 1)
    # Occlusion is baked with the limbs spread, so that arms hanging next to the
    # ribs do not burn permanent shadows into each other.
    rest = np.zeros(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get('co', rest)
    co = rest.reshape(-1, 3).copy()
    gi = {g.index: g.name for g in body.vertex_groups}
    for vtx in me.vertices:
        names = [gi[g.group] for g in vtx.groups if g.weight > 0.4]
        for side, sign in (('L', -1), ('R', 1)):
            if any(n in ('arm' + side, 'fore' + side, 'hand' + side) for n in names):
                piv, ang = np.array(B(sign * 0.2, 1.47, 0)), sign * math.radians(-48)
            elif any(n in ('thigh' + side, 'shin' + side, 'foot' + side) for n in names):
                piv, ang = np.array(B(sign * 0.1, 0.95, 0)), sign * math.radians(-13)
            else:
                continue
            d = co[vtx.index] - piv
            c, s_ = math.cos(ang), math.sin(ang)
            co[vtx.index] = piv + np.array([d[0] * c + d[2] * s_, d[1], -d[0] * s_ + d[2] * c])
    me.vertices.foreach_set('co', co.ravel())
    me.update()
    world = bpy.data.worlds.new('w')
    scene.world = world
    world.light_settings.distance = 0.30
    ao = np.clip(do_bake('AO', TEX_B, 72, 'bake_ao', filt=1.2)[..., 0], 0, 1)
    me.vertices.foreach_set('co', rest)
    me.update()
    mid1k = mat_id[::2, ::2]
    ao = np.where(mid1k == 0, 1.0, ao)
    rough = np.where(mid1k == 0, 0.8, rough)
    nrm = np.where((mid1k == 0)[..., None], np.array([128, 128, 255], dtype=np.uint8), nrm)
    packed = (mat_id << 4 | dustq << 2 | level).astype(np.uint8)
    BAKED = dict(packed=packed, mat_id=mat_id, level=level, dust=dustq, ao=ao, nrm=nrm, rough=rough)
    np.savez_compressed(CACHE, **BAKED)

# ---------------------------------------------------------------------------
# export: unique (position, normal, uv) vertices with two bone weights each
# ---------------------------------------------------------------------------
me.calc_loop_triangles()
normals = me.corner_normals
gi = {g.index: g.name for g in body.vertex_groups}
verts, index, lookup = [], [], {}
for tri in me.loop_triangles:
    for li in tri.loops:
        vi = me.loops[li].vertex_index
        n = normals[li].vector
        t = uv[li].uv
        key = (vi, round(n.x * 100), round(n.y * 100), round(n.z * 100), round(t[0] * 4096), round(t[1] * 4096))
        i = lookup.get(key)
        if i is None:
            v = me.vertices[vi]
            ws = sorted(((g.weight, BONE[gi[g.group]]) for g in v.groups), reverse=True)[:2]
            if len(ws) == 1:
                ws.append((0.0, ws[0][1]))
            tot = ws[0][0] + ws[1][0]
            i = lookup[key] = len(verts)
            verts.append(((v.co.x, v.co.z, -v.co.y), (n.x, n.z, -n.y), (t[0], t[1]), ws[0][1], ws[1][1], ws[0][0] / tot))
        index.append(i)
nv = len(verts)
ntri = len(index) // 3
print('export mesh: %d verts, %d tris' % (nv, ntri))
if os.environ.get('SOLDIER_DEBUG'):
    ks = list(lookup.keys())
    print('unique vi', len({k[0] for k in ks}), 'vi+uv', len({(k[0], k[4], k[5]) for k in ks}), 'vi+n', len({k[:4] for k in ks}))
assert nv < 65536
SCALE = 16000.0   # positions as int16: 1/16 mm steps


def delta16(a):
    a = np.asarray(a, dtype=np.int64)
    d = np.diff(a, prepend=0)
    return (d & 0xFFFF).astype('<u2')


def mesh_blob():
    P = np.array([[round(c * SCALE) for c in v[0]] for v in verts], dtype=np.int64)
    N = np.array([[round(c * 127) for c in v[1]] for v in verts], dtype=np.int8)
    U = np.array([[round(v[2][0] * 65535), round(v[2][1] * 65535)] for v in verts], dtype=np.int64)
    Sk = np.array([[v[3], v[4], round(v[5] * 255)] for v in verts], dtype=np.uint8)
    buf = io.BytesIO()
    for k in range(3):
        buf.write(delta16(P[:, k]).tobytes())
    for k in range(3):
        buf.write(N[:, k].tobytes())
    for k in range(2):
        buf.write(delta16(U[:, k]).tobytes())
    for k in range(3):
        buf.write(Sk[:, k].tobytes())
    buf.write(delta16(np.array(index, dtype=np.int64)).tobytes())
    return buf.getvalue()


mesh_raw = mesh_blob()
mesh_z = zlib.compress(mesh_raw, 9)
b64 = lambda b: base64.b64encode(b).decode('ascii')


def encode_maps(tmp):
    """PNG / JPEG encoding with the system python3 + Pillow."""
    np.save(os.path.join(tmp, 'id.npy'), BAKED['packed'])
    np.save(os.path.join(tmp, 'ao.npy'), (BAKED['ao'] * 255 + 0.5).astype(np.uint8))
    np.save(os.path.join(tmp, 'nrm.npy'), BAKED['nrm'])
    np.save(os.path.join(tmp, 'rough.npy'), (BAKED['rough'] * 255 + 0.5).astype(np.uint8))
    code = (
        "import sys, numpy as np\nfrom PIL import Image\nd=sys.argv[1]\n"
        "Image.fromarray(np.load(d+'/id.npy'),'L').save(d+'/id.png','PNG',optimize=True,compress_level=9)\n"
        "Image.fromarray(np.load(d+'/ao.npy'),'L').save(d+'/ao.jpg','JPEG',quality=80,optimize=True)\n"
        "Image.fromarray(np.load(d+'/nrm.npy'),'RGB').save(d+'/nrm.jpg','JPEG',quality=88,optimize=True,subsampling=0)\n"
        "Image.fromarray(np.load(d+'/rough.npy'),'L').save(d+'/rough.jpg','JPEG',quality=82,optimize=True)\n")
    r = subprocess.run(['python3', '-I', '-c', code, tmp], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError('map encoding failed (system python3 needs numpy + Pillow): ' + r.stderr)
    return {k: open(os.path.join(tmp, f), 'rb').read() for k, f in (('id', 'id.png'), ('ao', 'ao.jpg'), ('nrm', 'nrm.jpg'), ('rough', 'rough.jpg'))}


ENC = None
if BAKED is not None:
    tmpdir = tempfile.mkdtemp(prefix='soldier_maps_')
    ENC = encode_maps(tmpdir)
    meta = {'verts': nv, 'tris': ntri, 'scale': SCALE, 'tex': TEX, 'texB': TEX_B, 'materials': MATS, 'patch': PATCH, 'blender': bpy.app.version_string,
            'format': 'deflate: planes px,py,pz (int16 delta), nx,ny,nz (int8), u,v (uint16 delta), bone a, bone b, weight a (uint8), indices (uint16 delta)'}
    with open(OUT_JS, 'w', encoding='utf-8') as fh:
        fh.write('// Generated by tools/blender/build_soldier.py with Blender %s. Do not edit by hand.\n' % bpy.app.version_string)
        fh.write('// MESH: zlib-deflated planes (see SOLDIER_META.format). ID: material<<4 | dust<<2 | camouflage level.\n')
        fh.write('export const SOLDIER_META = %s;\n' % json.dumps(meta))
        fh.write("export const SOLDIER_MESH = '%s';\n" % b64(mesh_z))
        fh.write("export const SOLDIER_ID = 'data:image/png;base64,%s';\n" % b64(ENC['id']))
        fh.write("export const SOLDIER_AO = 'data:image/jpeg;base64,%s';\n" % b64(ENC['ao']))
        fh.write("export const SOLDIER_NORMAL = 'data:image/jpeg;base64,%s';\n" % b64(ENC['nrm']))
        fh.write("export const SOLDIER_ROUGH = 'data:image/jpeg;base64,%s';\n" % b64(ENC['rough']))
    print('export: %d verts, %d tris | mesh %d KB (raw %d) id %d KB ao %d KB normal %d KB rough %d KB | file %d KB -> %s' % (
        nv, ntri, len(mesh_z) // 1024, len(mesh_raw) // 1024, len(ENC['id']) // 1024, len(ENC['ao']) // 1024, len(ENC['nrm']) // 1024,
        len(ENC['rough']) // 1024, os.path.getsize(OUT_JS) // 1024, OUT_JS))

# ---------------------------------------------------------------------------
# previews: same maps, Principled BSDF, studio lights; posed through a real armature
# ---------------------------------------------------------------------------
PALS = {
    'marine': dict(camo=[0x485b2c, 0x6a5538, 0xa89c74, 0x20221a],
                   flat=[0, 0, 0x8a7a5a, 0x6c6049, 0x6a5a40, 0xb98f70, 0x17181a, 0x2c2b29, 0x5e5138, 0x56653a, 0x5c6a45, 0x4d4f52, 0x050506, 0x15161a, 0x8d4a45, 0xd8d4c8]),
    'enemy': dict(camo=[0x2b2d31, 0x383b40, 0x4b4e53, 0x16171a],
                  flat=[0, 0, 0x2a2c30, 0x1b1c1f, 0x171718, 0xb58a6e, 0x0f0f11, 0x121214, 0xc22530, 0xb3202a, 0x1c1d20, 0x3b3d42, 0x050506, 0x15161a, 0x8d4a45, 0xd0ccc2]),
}


def rgb(h):
    return np.array([(h >> 16) & 255, (h >> 8) & 255, h & 255], dtype=np.float32)


def box_blur(a, r):
    for ax in (0, 1):
        c = np.cumsum(np.pad(a, [(r + 1, r) if k == ax else (0, 0) for k in range(a.ndim)], mode='wrap'), axis=ax)
        sl = [slice(None)] * a.ndim
        sl2 = [slice(None)] * a.ndim
        sl[ax] = slice(2 * r + 1, None)
        sl2[ax] = slice(0, -(2 * r + 1))
        a = (c[tuple(sl)] - c[tuple(sl2)]) / (2 * r + 1)
    return a


def compose_albedo(team):
    """Numpy mirror of bakedTexture() in src/chars/soldier.js (approximate noise)."""
    pal = PALS[team]
    mat_id, level, dust = BAKED['mat_id'], BAKED['level'], BAKED['dust']
    ao = np.kron(BAKED['ao'], np.ones((2, 2)))
    rng = np.random.default_rng(5)
    lo = box_blur(box_blur(rng.random((TEX, TEX)), 5), 5) * 9.0
    lo = (lo - lo.mean()) / (lo.std() + 1e-6) * 0.5 + 0.5
    lo2 = box_blur(box_blur(rng.random((TEX, TEX)), 22), 12)
    lo2 = (lo2 - lo2.mean()) / (lo2.std() + 1e-6) * 0.5 + 0.5
    fine = rng.random((TEX, TEX))
    col = np.zeros((TEX, TEX, 3), dtype=np.float32)
    camo = np.stack([rgb(h) for h in pal['camo']])
    flat = np.stack([rgb(h) if h else rgb(0x808080) for h in pal['flat']])
    col[:] = flat[mat_id]
    cm = mat_id == 1
    col[cm] = camo[level[cm]]
    cloth = np.isin(mat_id, (1, 2, 3, 7, 6, 8))
    mult = np.ones((TEX, TEX), dtype=np.float32)
    mult += np.where(cloth, (lo - 0.5) * 0.20 + (fine - 0.5) * 0.09 + (lo2 - 0.5) * 0.08, 0)
    mult += np.where(mat_id == 5, (lo - 0.5) * 0.14 + (fine - 0.5) * 0.03, 0)
    mult += np.where(mat_id == 4, (lo - 0.5) * 0.22 + (fine - 0.5) * 0.06, 0)
    col *= np.clip(mult, 0.5, 1.6)[..., None]
    d = (dust / 3.0) * (0.45 + 0.55 * lo2) * np.where(np.isin(mat_id, (5, 12, 14, 15, 11)), 0.0, 1.0)
    col = col * (1 - 0.55 * d[..., None]) + rgb(0x8a7556) * 0.55 * d[..., None]
    shade = 0.40 + 0.60 * ao ** 1.15
    col *= np.where(mat_id[..., None] == 0, 1.0, shade[..., None])
    # flag + tape strips
    def rect(r):
        return int((1 - r[3]) * TEX), int((1 - r[1]) * TEX), int(r[0] * TEX), int(r[2] * TEX)
    y0, y1, x0, x1 = rect(PATCH['flag'])
    if team == 'marine':
        col[y0:y1, x0:x1] = rgb(0xb22234)
        for k in range(1, 13, 2):
            col[y0 + (y1 - y0) * k // 13:y0 + (y1 - y0) * (k + 1) // 13, x0:x1] = 240
        col[y0:y0 + (y1 - y0) * 7 // 13, x0:x0 + int((x1 - x0) * 0.42)] = rgb(0x3c3b6e)
    else:
        col[y0:y1, x0:x1] = rgb(0xb3202a)
        col[y0:y1, x0 + int((x1 - x0) * 0.42):x0 + int((x1 - x0) * 0.58)] = 17
    y0, y1, x0, x1 = rect(PATCH['tape'])
    col[y0:y1, x0:x1] = rgb(0x5c6a45) if team == 'marine' else rgb(0x1c1d20)
    col[y0 + (y1 - y0) // 3:y1 - (y1 - y0) // 3, x0 + 8:x1 - 8] = rgb(0x14170e) if team == 'marine' else rgb(0xc22530)
    return np.clip(col, 0, 255).astype(np.uint8)


def np_to_image(name, arr, srgb):
    h, w = arr.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=False)
    img.colorspace_settings.name = 'sRGB' if srgb else 'Non-Color'
    ch = arr.shape[2] if arr.ndim == 3 else 1
    a = np.ones((h, w, 4), dtype=np.float32)
    f = arr.astype(np.float32) / 255.0 if arr.dtype == np.uint8 else arr.astype(np.float32)
    if ch == 1:
        a[..., 0] = a[..., 1] = a[..., 2] = f
    else:
        a[..., :3] = f[..., :3]
    img.pixels.foreach_set(np.flipud(a).ravel())
    img.update()
    return img


def make_view_material(team, textured):
    m = bpy.data.materials.new('view_' + team)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    pr = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(pr.outputs['BSDF'], out.inputs['Surface'])
    pr.inputs['Metallic'].default_value = 0.0
    if textured:
        tex = nt.nodes.new('ShaderNodeTexImage')
        tex.image = np_to_image('alb_' + team, compose_albedo(team), True)
        nt.links.new(tex.outputs['Color'], pr.inputs['Base Color'])
        tn = nt.nodes.new('ShaderNodeTexImage')
        tn.image = np_to_image('nrm_' + team, BAKED['nrm'], False)
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], pr.inputs['Normal'])
        tr = nt.nodes.new('ShaderNodeTexImage')
        tr.image = np_to_image('rgh_' + team, (BAKED['rough'] * 255).astype(np.uint8), False)
        nt.links.new(tr.outputs['Color'], pr.inputs['Roughness'])
    pr.inputs['Specular IOR Level'].default_value = 0.45
    return m


def build_rig():
    arm = bpy.data.armatures.new('rig')
    rig = bpy.data.objects.new('rig', arm)
    scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = {}
    for name, parent, x, y, z in RIG:
        b = arm.edit_bones.new(name)
        b.head = B(x, y, z)
        b.tail = B(x, y, z) + Vector((0, 0, 0.08))
        b.roll = 0.0
        eb[name] = b
    for name, parent, x, y, z in RIG:
        if parent >= 0:
            eb[name].parent = eb[RIG[parent][0]]
    bpy.ops.object.mode_set(mode='OBJECT')
    return rig


def pose_bone(rig, name, quat_world=None, scale=None):
    pb = rig.pose.bones[name]
    pb.rotation_mode = 'QUATERNION'
    if quat_world is not None:
        R = pb.bone.matrix_local.to_3x3()
        pb.rotation_quaternion = (R.inverted() @ quat_world.to_matrix() @ R).to_quaternion()
    if scale is not None:
        pb.scale = (scale, scale, scale)


def reset_pose(rig):
    for pb in rig.pose.bones:
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.scale = (1, 1, 1)


from mathutils import Quaternion


def qx(deg):
    return Quaternion((1, 0, 0), math.radians(deg))


def qz(deg):   # game vertical axis
    return Quaternion((0, 0, 1), math.radians(deg))


def studio():
    for o in [o for o in scene.objects if o.type in ('LIGHT', 'CAMERA')]:
        bpy.data.objects.remove(o)
    wd = bpy.data.worlds.new('studio')
    scene.world = wd
    wd.use_nodes = True
    bgn = wd.node_tree.nodes['Background']
    bgn.inputs['Color'].default_value = (0.30, 0.32, 0.35, 1)
    bgn.inputs['Strength'].default_value = 0.9
    rigs = {}
    for nm, loc, power, size, col in (('key', (-2.6, 3.4, 3.0), 520, 2.2, (1.0, 0.95, 0.88)), ('fill', (3.4, 2.4, 1.4), 170, 3.0, (0.85, 0.92, 1.0)),
                                      ('rim', (1.8, -3.2, 3.0), 420, 1.5, (1.0, 1.0, 1.0)), ('top', (0.0, 0.5, 4.0), 120, 3.0, (1, 1, 1))):
        ld = bpy.data.lights.new(nm, 'AREA')
        ld.energy, ld.size, ld.color = power, size, col
        lo = bpy.data.objects.new(nm, ld)
        scene.collection.objects.link(lo)
        lo.location = loc
        d = Vector((0, 0, 0.95)) - lo.location
        lo.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    # floor
    bpy.ops.mesh.primitive_plane_add(size=14, location=(0, 0, 0))
    fl = bpy.context.active_object
    fm = bpy.data.materials.new('floor')
    fm.use_nodes = True
    fm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.20, 0.205, 0.21, 1)
    fm.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.9
    fl.data.materials.append(fm)


def shoot(name, cam_loc, target, lens, res, sensor_fit='VERTICAL', sensor=24.0, game=False):
    cd = bpy.data.cameras.new('cam')
    cd.lens = lens
    cd.sensor_fit = sensor_fit
    cd.sensor_height = sensor
    cd.sensor_width = sensor if sensor_fit == 'HORIZONTAL' else 36.0
    cd.clip_start = 0.02
    co = bpy.data.objects.new('cam', cd)
    scene.collection.objects.link(co)
    co.location = B(*cam_loc) if game else Vector(cam_loc)
    co.rotation_euler = ((B(*target) if game else Vector(target)) - co.location).to_track_quat('-Z', 'Y').to_euler()
    scene.camera = co
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.filepath = os.path.join(PREVIEW, name + '.png')
    if SHOTS and name.replace('soldier_', '') not in SHOTS:
        bpy.data.objects.remove(co)
        return
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(co)
    print('rendered', name)


def previews():
    os.makedirs(PREVIEW, exist_ok=True)
    textured = BAKED is not None
    teams = ['marine', 'enemy'] if textured else ['marine']
    mats = {t: make_view_material(t, textured) for t in teams}
    if not textured:
        # flat colours per material for geometry checks
        _idx = [pp.material_index for pp in me.polygons]
        me.materials.clear()
        for nm in MATS:
            m = bpy.data.materials.new('f_' + nm)
            m.use_nodes = True
            h = PALS['marine']['flat'][MAT[nm] + 1] if nm != 'camo' else PALS['marine']['camo'][0]
            c = rgb(h or 0x808080) / 255.0
            m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (c[0] ** 2.2, c[1] ** 2.2, c[2] ** 2.2, 1)
            m.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = ROUGH[nm]
            me.materials.append(m)
        for pp, k in zip(me.polygons, _idx):
            pp.material_index = k
    else:
        me.materials.clear()
        me.materials.append(mats['marine'])
        for p in me.polygons:
            p.material_index = 0
    rig = build_rig()
    body.parent = rig
    mod = body.modifiers.new('arm', 'ARMATURE')
    mod.object = rig
    studio()
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 40
    scene.cycles.use_denoising = True
    scene.cycles.filter_width = 1.5
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    scene.view_settings.exposure = 0.0
    scene.render.image_settings.file_format = 'PNG'
    reset_pose(rig)
    shoot('soldier_front', (0, 1.0 * 0 + 5.8, 0.95), (0, 0, 0.93), 62, (700, 1000))
    shoot('soldier_back', (0, -5.8, 0.95), (0, 0, 0.93), 62, (700, 1000))
    shoot('soldier_34', (3.9, 4.4, 1.1), (0, 0, 0.9), 62, (700, 1000))
    shoot('soldier_head', (0.75, 1.9, 1.62), (0, 0, 1.5), 62, (900, 800), 'VERTICAL', 24.0)
    shoot('soldier_torso', (-1.0, 2.4, 1.38), (0, 0, 1.28), 58, (900, 800))
    shoot('soldier_boots', (1.2, 1.5, 0.3), (0, 0, 0.25), 55, (900, 700))
    # bent pose: elbows and knees about 90 degrees
    reset_pose(rig)
    pose_bone(rig, 'armL', qx(48))
    pose_bone(rig, 'foreL', qx(88))
    pose_bone(rig, 'armR', qx(30) )
    pose_bone(rig, 'foreR', qx(92))
    pose_bone(rig, 'thighL', qx(80))
    pose_bone(rig, 'shinL', qx(-95))
    pose_bone(rig, 'thighR', qx(-12))
    pose_bone(rig, 'shinR', qx(-28))
    pose_bone(rig, 'spine', qx(8))
    shoot('soldier_bent', (-4.3, 4.9, 1.0), (0, 0, 0.95), 62, (700, 1000))
    shoot('soldier_bent_arm', (-1.4, 1.9, 1.2), (0, -0.2, 1.1), 50, (900, 800))
    # first-person style: head scaled away, arms raised towards a weapon
    reset_pose(rig)
    pose_bone(rig, 'head', scale=0.001)
    pose_bone(rig, 'armR', qz(18) @ qx(62))
    pose_bone(rig, 'foreR', qx(30))
    pose_bone(rig, 'armL', qz(-26) @ qx(70))
    pose_bone(rig, 'foreL', qx(45))
    pose_bone(rig, 'handR', qx(10))
    shoot('soldier_fp', (0.0, 1.69, 0.12), (0.0, 1.46, -0.6), 22, (1200, 800), 'HORIZONTAL', 36.0, True)
    shoot('soldier_fp2', (0.25, 1.78, 0.25), (-0.05, 1.12, -0.5), 30, (1200, 800), 'HORIZONTAL', 36.0, True)
    if textured:
        reset_pose(rig)
        me.materials.clear()
        me.materials.append(mats['enemy'])
        shoot('soldier_enemy', (0, 5.8, 0.95), (0, 0, 0.93), 62, (700, 1000))
        shoot('soldier_enemy_head', (0.75, 1.9, 1.62), (0, 0, 1.5), 62, (900, 800))
        # atlas preview
        alb = compose_albedo('marine')
        np.save(os.path.join(tempfile.gettempdir(), 'soldier_atlas.npy'), alb)


if not NOPREV:
    previews()
    sheet_code = (
        "import sys\nfrom PIL import Image, ImageDraw\nd=sys.argv[1]; out=sys.argv[2]\n"
        "names=['front','back','34','head','torso','boots','bent','bent_arm','fp','fp2','enemy','enemy_head']\n"
        "ims=[]\n"
        "for n in names:\n"
        "    try: ims.append((n,Image.open(f'{d}/soldier_{n}.png').convert('RGB')))\n"
        "    except Exception as e: pass\n"
        "if ims:\n"
        "    W=480; H=420; cols=4; rows=(len(ims)+cols-1)//cols\n"
        "    sh=Image.new('RGB',(cols*W,rows*H),(24,25,28))\n"
        "    for k,(n,im) in enumerate(ims):\n"
        "        im.thumbnail((W-8,H-8),Image.LANCZOS)\n"
        "        x=(k%cols)*W+(W-im.width)//2; y=(k//cols)*H+(H-im.height)//2\n"
        "        sh.paste(im,(x,y)); ImageDraw.Draw(sh).text(((k%cols)*W+8,(k//cols)*H+6),n,fill=(220,220,220))\n"
        "    sh.save(out,'PNG',optimize=True)\n")
    r = subprocess.run(['python3', '-I', '-c', sheet_code, PREVIEW, SHEET], capture_output=True, text=True)
    print('sheet:', SHEET if r.returncode == 0 else r.stderr)
