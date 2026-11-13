"""
Builds the soldier model with Blender and writes src/chars/soldier_asset.js.

    pip install bpy numpy pillow        # Blender as a Python module (5.x)
    python tools/blender/build_soldier.py

What Blender does here
  * models the body with Skin + Subdivision modifiers (smooth limbs and torso)
    and the kit (helmet, plate carrier, pouches, pack, pads, boots) as bevelled
    solids
  * unwraps everything into one UV atlas (Smart UV Project)
  * bakes two maps with Cycles: ambient occlusion, and an "ID" map that stores
    the material of every texel plus the digital-camouflage pattern, projected
    in 3D so it flows across seams
  * the script then exports a compact skinned mesh for the game's own 16-bone rig

The game colours the ID map at start-up (woodland MARPAT for the Marines, a
dark urban kit for the hostiles) and multiplies in the baked occlusion, so one
bake serves both teams.

Model space is the game's: X right, Y up, facing -Z. Blender is Z-up, so
game (X, Y, Z) is authored as Blender (X, -Z, Y).
"""
import base64
import io
import json
import math
import os
import struct
import sys

import bpy  # must come first: it registers bmesh and mathutils
import bmesh
import numpy as np
from mathutils import Matrix, Vector
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT_JS = os.path.join(ROOT, 'src', 'chars', 'soldier_asset.js')
PREVIEW = os.path.join(HERE, 'preview')
TEX = 1024

# the game's rig (src/chars/soldier.js): name, parent, rest position
RIG = [
    ('hips', -1, 0, 0.95, 0), ('spine', 0, 0, 1.05, 0), ('chest', 1, 0, 1.25, 0), ('head', 2, 0, 1.52, 0),
    ('armL', 2, -0.225, 1.49, 0), ('foreL', 4, -0.225, 1.21, 0), ('handL', 5, -0.225, 0.95, 0),
    ('armR', 2, 0.225, 1.49, 0), ('foreR', 7, 0.225, 1.21, 0), ('handR', 8, 0.225, 0.95, 0),
    ('thighL', 0, -0.1, 0.93, 0), ('shinL', 10, -0.1, 0.5, 0), ('footL', 11, -0.1, 0.07, 0),
    ('thighR', 0, 0.1, 0.93, 0), ('shinR', 13, 0.1, 0.5, 0), ('footR', 14, 0.1, 0.07, 0),
]
BONE = {r[0]: i for i, r in enumerate(RIG)}

# material ids written to the red channel of the ID map
MATS = ['camo', 'gear', 'gearDark', 'boot', 'skin', 'black', 'glove', 'accent', 'flag', 'tape', 'metal']
MAT = {n: i for i, n in enumerate(MATS)}


def B(x, y, z):
    """game -> Blender coordinates"""
    return Vector((x, -z, y))


def smooth(a, b, v):
    t = min(1.0, max(0.0, (v - a) / (b - a)))
    return t * t * (3 - 2 * t)


# ---------------------------------------------------------------------------
# scene helpers
# ---------------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
objects = []


def new_object(name, bm, mat):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    for m in MATS:
        me.materials.append(materials[m])
    for p in me.polygons:
        p.material_index = MAT[mat]
        p.use_smooth = True
    objects.append(ob)
    return ob


def realize(ob):
    """Apply the modifier stack and keep the result as the object's mesh."""
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    old = ob.data
    ob.modifiers.clear()
    ob.data = me
    bpy.data.meshes.remove(old)
    for p in me.polygons:
        p.use_smooth = True
    return ob


def weights(ob, fn):
    """fn(game_x, game_y, game_z) -> [(bone, weight), ...]"""
    groups = {}
    for v in ob.data.vertices:
        x, y, z = v.co.x, v.co.z, -v.co.y
        for bone, w in fn(x, y, z):
            if w <= 0.002:
                continue
            g = groups.get(bone) or groups.setdefault(bone, ob.vertex_groups.new(name=bone))
            g.add([v.index], w, 'REPLACE')


def rigid(bone):
    return lambda x, y, z: [(bone, 1.0)]


def blend2(a, b, y_joint, half, y):
    """Bone a above the joint, bone b below it, blended over +-half."""
    t = smooth(y_joint - half, y_joint + half, y)
    return [(a, t), (b, 1 - t)]


def skin_part(name, chain, mat, levels=1):
    """chain: [(x, y, z, rx, ry)] in game space; consecutive points are joined."""
    bm = bmesh.new()
    layer = bm.verts.layers.skin.verify()
    prev = None
    for i, (x, y, z, rx, ry) in enumerate(chain):
        v = bm.verts.new(B(x, y, z))
        v[layer].radius = (rx, ry)
        v[layer].use_root = i == 0
        if prev is not None:
            bm.edges.new((prev, v))
        prev = v
    ob = new_object(name, bm, mat)
    ob.modifiers.new('skin', 'SKIN').use_smooth_shade = True
    sub = ob.modifiers.new('sub', 'SUBSURF')
    sub.levels = levels
    return realize(ob)


def box(name, mat, bone, size, pos, bevel=0.008, rot_x=0.0, sub=0, taper=None):
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
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=min(bevel, min(size) * 0.3), segments=1, profile=0.5, affect='EDGES')
    if rot_x:
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(rot_x, 3, 'X'))
    bmesh.ops.translate(bm, verts=bm.verts, vec=B(*pos))
    ob = new_object(name, bm, mat)
    if sub:
        ob.modifiers.new('sub', 'SUBSURF').levels = sub
        realize(ob)
    ob.data.set_sharp_from_angle(angle=math.radians(50))
    weights(ob, bone if callable(bone) else rigid(bone))
    return ob


def tube(name, mat, bone, x, z, y0, y1, r0, r1, seg=12, bevel=0.004):
    """Upright cylinder / cone between two heights (game space)."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r0, radius2=r1, depth=y1 - y0)
    if bevel:
        ring = [e for e in bm.edges if abs(e.verts[0].co.z - e.verts[1].co.z) < 1e-6]
        bmesh.ops.bevel(bm, geom=ring, offset=bevel, segments=1, affect='EDGES')
    bmesh.ops.translate(bm, verts=bm.verts, vec=B(x, (y0 + y1) / 2, z))
    ob = new_object(name, bm, mat)
    ob.data.set_sharp_from_angle(angle=math.radians(50))
    weights(ob, bone if callable(bone) else rigid(bone))
    return ob


def quad(name, mat, bone, w, h, pos, normal):
    """Flat patch (flag / name tape). normal: 'front', 'left' or 'right'."""
    bm = bmesh.new()
    x, y, z = pos
    if normal == 'front':
        pts = [(x + w / 2, y - h / 2, z), (x - w / 2, y - h / 2, z), (x - w / 2, y + h / 2, z), (x + w / 2, y + h / 2, z)]
    elif normal == 'right':
        pts = [(x, y - h / 2, z + w / 2), (x, y - h / 2, z - w / 2), (x, y + h / 2, z - w / 2), (x, y + h / 2, z + w / 2)]
    else:
        pts = [(x, y - h / 2, z - w / 2), (x, y - h / 2, z + w / 2), (x, y + h / 2, z + w / 2), (x, y + h / 2, z - w / 2)]
    bm.faces.new([bm.verts.new(B(*p)) for p in pts])
    ob = new_object(name, bm, mat)
    weights(ob, rigid(bone))
    ob['patch'] = name
    return ob


# ---------------------------------------------------------------------------
# materials: every one emits (material id, camouflage level, 0) for the ID bake
# ---------------------------------------------------------------------------
def camo_index_image():
    """Digital camouflage as 4 grey levels: 0 base A, 1 base B, 2 light accent, 3 dark accent."""
    n = 128
    rng = np.random.default_rng(1775)

    def noise(cells):
        g = rng.random((cells, cells))
        idx = (np.arange(n) * cells / n)
        i0 = np.floor(idx).astype(int) % cells
        i1 = (i0 + 1) % cells
        t = idx - np.floor(idx)
        rows = g[i0][:, i0] * (1 - t)[None, :] + g[i0][:, i1] * t[None, :]
        rows2 = g[i1][:, i0] * (1 - t)[None, :] + g[i1][:, i1] * t[None, :]
        return rows * (1 - t)[:, None] + rows2 * t[:, None]

    n1 = noise(7) * 0.6 + noise(13) * 0.4 + (rng.random((n, n)) - 0.5) * 0.08
    n2 = noise(11) * 0.5 + noise(23) * 0.5 + (rng.random((n, n)) - 0.5) * 0.08
    level = np.where(n2 > 0.61, 2, np.where(n2 < 0.37, 3, np.where(n1 > 0.5, 1, 0)))
    img = bpy.data.images.new('camo_index', n, n, alpha=False, is_data=True)
    px = np.zeros((n, n, 4), dtype=np.float32)
    px[..., 0] = px[..., 1] = px[..., 2] = level / 3.0
    px[..., 3] = 1
    img.pixels.foreach_set(px.ravel())
    return img


camo_img = camo_index_image()
bake_id = bpy.data.images.new('bake_id', TEX, TEX, alpha=False, is_data=True)
bake_ao = bpy.data.images.new('bake_ao', TEX, TEX, alpha=False, is_data=True)
materials = {}
for name in MATS:
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    comb = nt.nodes.new('ShaderNodeCombineColor')
    comb.inputs[0].default_value = (MAT[name] + 1) / 16.0
    comb.inputs[1].default_value = 0.0
    comb.inputs[2].default_value = 0.0
    nt.links.new(comb.outputs[0], em.inputs['Color'])
    if name == 'camo':
        tc = nt.nodes.new('ShaderNodeTexCoord')
        mp = nt.nodes.new('ShaderNodeMapping')
        mp.inputs['Scale'].default_value = (1 / 1.5, 1 / 1.5, 1 / 1.5)   # one tile = 1.5 m, 1.17 cm "pixels"
        mp.inputs['Location'].default_value = (0.37, 0.11, 0.23)
        ti = nt.nodes.new('ShaderNodeTexImage')
        ti.image = camo_img
        ti.projection = 'BOX'
        ti.projection_blend = 0.0
        ti.interpolation = 'Closest'
        nt.links.new(tc.outputs['Object'], mp.inputs['Vector'])
        nt.links.new(mp.outputs['Vector'], ti.inputs['Vector'])
        nt.links.new(ti.outputs['Color'], comb.inputs[1])
    target = nt.nodes.new('ShaderNodeTexImage')   # bake target (must be the active node)
    target.name = 'target'
    target.image = bake_id
    nt.nodes.active = target
    materials[name] = m

# ---------------------------------------------------------------------------
# body: Skin-modifier limbs and torso
# ---------------------------------------------------------------------------
torso = skin_part('torso', [
    (0, 0.90, 0, 0.165, 0.112), (0, 1.00, 0.004, 0.172, 0.116), (0, 1.10, 0.002, 0.152, 0.104),
    (0, 1.24, -0.004, 0.172, 0.114), (0, 1.38, -0.006, 0.192, 0.122), (0, 1.48, 0, 0.176, 0.108),
    (0, 1.545, 0.004, 0.072, 0.07), (0, 1.60, 0.002, 0.064, 0.064),
], 'camo', levels=2)
_c = np.array([v.co[:] for v in torso.data.vertices])
print('torso extents (width, depth, height): %.3f %.3f %.3f' % tuple(_c.max(0) - _c.min(0)))
for p in torso.data.polygons:   # the neck is skin
    if (torso.matrix_world @ p.center).z > 1.525:
        p.material_index = MAT['skin']


def torso_w(x, y, z):
    head = smooth(1.505, 1.565, y)
    chest = smooth(1.18, 1.32, y)
    spine = smooth(0.99, 1.11, y)
    return [('head', head), ('chest', (1 - head) * chest), ('spine', (1 - chest) * spine), ('hips', (1 - chest) * (1 - spine))]


weights(torso, torso_w)

# head: a subdivided cube reads better than a sphere at this size
# (subdivision pulls a cube in by about a quarter, hence the generous size)
head = box('head', 'skin', 'head', (0.215, 0.27, 0.24), (0, 1.685, -0.004), bevel=0, sub=2)
box('nose', 'skin', 'head', (0.03, 0.045, 0.03), (0, 1.668, -0.1), bevel=0.01)
box('jaw', 'skin', 'head', (0.13, 0.055, 0.13), (0, 1.605, -0.03), bevel=0.022)

for s, L in ((-1, 'L'), (1, 'R')):
    ax = s * 0.225
    arm = skin_part('arm' + L, [
        (ax, 1.495, 0, 0.074, 0.074), (ax, 1.40, 0, 0.062, 0.064), (ax, 1.30, 0.004, 0.056, 0.058), (ax, 1.215, 0.006, 0.05, 0.052),
        (ax, 1.12, 0.002, 0.05, 0.052), (ax, 1.03, 0, 0.044, 0.046), (ax, 0.955, 0, 0.038, 0.04),
        (ax, 0.90, -0.004, 0.046, 0.03), (ax, 0.835, -0.01, 0.04, 0.026),
    ], 'camo')
    for p in arm.data.polygons:
        if (arm.matrix_world @ p.center).z < 0.957:
            p.material_index = MAT['glove']

    def arm_w(x, y, z, L=L):
        if y > 1.08:
            return blend2('arm' + L, 'fore' + L, 1.21, 0.06, y)
        return blend2('fore' + L, 'hand' + L, 0.95, 0.03, y)

    weights(arm, arm_w)
    box('elbow' + L, 'gearDark', 'fore' + L, (0.09, 0.105, 0.05), (ax, 1.195, 0.05), bevel=0.014)
    tube('band' + L, 'accent', 'arm' + L, ax, 0, 1.335, 1.385, 0.066, 0.066, seg=14, bevel=0.003)
    box('cuff' + L, 'gearDark', 'hand' + L, (0.088, 0.03, 0.094), (ax, 0.952, 0), bevel=0.008)

    lx = s * 0.1
    leg = skin_part('leg' + L, [
        (lx, 0.95, 0, 0.096, 0.1), (lx, 0.80, -0.004, 0.09, 0.094), (lx, 0.64, -0.002, 0.078, 0.082), (lx, 0.50, -0.004, 0.068, 0.07),
        (lx, 0.37, 0.006, 0.064, 0.068), (lx, 0.24, 0.004, 0.058, 0.06), (lx, 0.185, 0, 0.066, 0.066),
    ], 'camo')
    weights(leg, lambda x, y, z, L=L: blend2('thigh' + L, 'shin' + L, 0.50, 0.065, y))
    box('cargo' + L, 'camo', 'thigh' + L, (0.045, 0.16, 0.13), (lx + s * 0.088, 0.71, 0.005), bevel=0.012)
    box('knee' + L, 'gearDark', 'shin' + L, (0.108, 0.13, 0.05), (lx, 0.505, -0.072), bevel=0.02)
    box('kneecap' + L, 'black', 'shin' + L, (0.075, 0.075, 0.03), (lx, 0.51, -0.092), bevel=0.012)
    # boot: shaft on the shin, foot on the foot bone
    tube('shaft' + L, 'boot', 'shin' + L, lx, 0.004, 0.075, 0.215, 0.058, 0.066, seg=12, bevel=0.006)
    box('foot' + L, 'boot', 'foot' + L, (0.104, 0.078, 0.265), (lx, 0.061, -0.052), bevel=0.026, taper=(0.86, 0.8))
    box('sole' + L, 'black', 'foot' + L, (0.11, 0.024, 0.275), (lx, 0.012, -0.052), bevel=0.006)

# ---------------------------------------------------------------------------
# kit
# ---------------------------------------------------------------------------
box('pelvis', 'camo', 'hips', (0.31, 0.15, 0.215), (0, 0.95, 0), bevel=0.05)
box('belt', 'gear', 'hips', (0.335, 0.048, 0.238), (0, 1.05, 0), bevel=0.01)
box('holster', 'gearDark', 'hips', (0.045, 0.16, 0.08), (0.186, 0.955, 0.01), bevel=0.012)
box('dump', 'gearDark', 'hips', (0.05, 0.115, 0.095), (-0.186, 0.98, 0.03), bevel=0.014)
# plate carrier
box('plateF', 'gear', 'chest', (0.3, 0.33, 0.06), (0, 1.335, -0.122), bevel=0.02, taper=(0.9, 1.0))
box('plateB', 'gear', 'chest', (0.3, 0.33, 0.06), (0, 1.335, 0.124), bevel=0.02, taper=(0.9, 1.0))
for s in (-1, 1):
    box('cummer%d' % s, 'gear', 'chest', (0.04, 0.15, 0.26), (s * 0.176, 1.245, 0), bevel=0.012)
    box('strap%d' % s, 'gear', 'chest', (0.07, 0.04, 0.27), (s * 0.108, 1.512, 0), bevel=0.012)
for i, x in enumerate((-0.094, 0, 0.094)):
    box('mag%d' % i, 'gearDark', 'chest', (0.078, 0.14, 0.046), (x, 1.245, -0.172), bevel=0.01)
    box('magflap%d' % i, 'gear', 'chest', (0.08, 0.035, 0.05), (x, 1.31, -0.173), bevel=0.008)
box('radio', 'gearDark', 'chest', (0.07, 0.115, 0.05), (-0.115, 1.42, -0.166), bevel=0.01)
tube('antenna', 'black', 'chest', -0.14, -0.15, 1.46, 1.63, 0.006, 0.004, seg=6, bevel=0)
box('admin', 'gearDark', 'chest', (0.11, 0.075, 0.03), (0.075, 1.415, -0.158), bevel=0.008)
box('pack', 'gearDark', 'chest', (0.235, 0.3, 0.085), (0, 1.36, 0.19), bevel=0.03, taper=(0.86, 0.8))
box('packtop', 'gear', 'chest', (0.2, 0.05, 0.07), (0, 1.5, 0.185), bevel=0.016)
box('ifak', 'gearDark', 'chest', (0.12, 0.1, 0.06), (0.1, 1.215, 0.178), bevel=0.014)
box('tube1', 'black', 'chest', (0.016, 0.2, 0.016), (-0.09, 1.47, 0.16), bevel=0.004)
quad('tape', 'tape', 'chest', 0.17, 0.034, (0, 1.468, -0.1535), 'front')
quad('flagR', 'flag', 'armR', 0.075, 0.05, (0.225 + 0.066, 1.43, 0), 'right')
quad('flagL', 'flag', 'armL', 0.075, 0.05, (-0.225 - 0.066, 1.43, 0), 'left')

# helmet: the top of a sphere, stretched front to back, with a real rim thickness
bm = bmesh.new()
bmesh.ops.create_uvsphere(bm, u_segments=20, v_segments=12, radius=0.131)
cut = [v for v in bm.verts if v.co.z < -0.04 + max(0.0, v.co.y) * 0.34 + (0.035 if abs(v.co.x) > 0.1 and -0.05 < v.co.y < 0.07 else 0)]
bmesh.ops.delete(bm, geom=cut, context='VERTS')
for v in bm.verts:
    v.co = Vector((v.co.x * 1.075, v.co.y * 1.2, v.co.z * 1.06))
bmesh.ops.translate(bm, verts=bm.verts, vec=B(0, 1.708, 0.006))
helmet = new_object('helmet', bm, 'camo')
helmet.modifiers.new('solid', 'SOLIDIFY').thickness = 0.012
realize(helmet)
helmet.data.set_sharp_from_angle(angle=math.radians(60))
weights(helmet, rigid('head'))
box('nvg', 'black', 'head', (0.05, 0.046, 0.026), (0, 1.778, -0.153), bevel=0.006)
box('visor', 'black', 'head', (0.176, 0.046, 0.05), (0, 1.706, -0.092), bevel=0.014)
for s in (-1, 1):
    box('cup%d' % s, 'gearDark', 'head', (0.034, 0.085, 0.075), (s * 0.139, 1.668, 0.004), bevel=0.016)
    box('rail%d' % s, 'gear', 'head', (0.016, 0.022, 0.2), (s * 0.142, 1.738, 0.006), bevel=0.005)
box('mic', 'black', 'head', (0.012, 0.012, 0.095), (-0.142, 1.648, -0.06), bevel=0.003)
box('strapchin', 'gearDark', 'head', (0.19, 0.012, 0.02), (0, 1.60, -0.05), bevel=0.003)

# ---------------------------------------------------------------------------
# join, unwrap
# ---------------------------------------------------------------------------
for ob in objects:
    ob.select_set(True)
bpy.context.view_layer.objects.active = objects[0]
bpy.ops.object.join()
body = bpy.context.view_layer.objects.active
body.name = 'soldier'
me = body.data
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.006)
bpy.ops.object.mode_set(mode='OBJECT')
uv = me.uv_layers.active.data
# keep a strip on the right free for the flag and the name tape
for l in uv:
    l.uv = (l.uv[0] * 0.86, l.uv[1])
PATCH = {'flag': (0.875, 0.02, 0.995, 0.10), 'tape': (0.875, 0.12, 0.995, 0.144)}
for p in me.polygons:
    name = MATS[p.material_index]
    if name not in PATCH:
        continue
    u0, v0, u1, v1 = PATCH[name]
    # corners were created bottom-left (as seen from outside), bottom-right, top-right, top-left
    if name == 'flag' and p.center.x > 0:
        u0, u1 = u1, u0
    for k, li in enumerate(p.loop_indices):
        uv[li].uv = ((u0, v0), (u1, v0), (u1, v1), (u0, v1))[k]

print('mesh: %d verts, %d faces' % (len(me.vertices), len(me.polygons)))

# ---------------------------------------------------------------------------
# bake (Cycles, CPU)
# ---------------------------------------------------------------------------
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 1
scene.render.bake.margin = 8
scene.render.bake.use_clear = True
body.select_set(True)
bpy.ops.object.bake(type='EMIT')

# Occlusion is baked with the limbs spread, so that arms hanging next to the
# ribs do not burn permanent shadows into each other.
rest = np.zeros(len(me.vertices) * 3, dtype=np.float32)
me.vertices.foreach_get('co', rest)
co = rest.reshape(-1, 3).copy()
gi = {g.index: g.name for g in body.vertex_groups}
for v in me.vertices:
    names = [gi[g.group] for g in v.groups if g.weight > 0.4]
    for side, sign in (('L', -1), ('R', 1)):
        if any(n in ('arm' + side, 'fore' + side, 'hand' + side) for n in names):
            piv, ang = np.array(B(sign * 0.2, 1.47, 0)), sign * math.radians(-48)
        elif any(n in ('thigh' + side, 'shin' + side, 'foot' + side) for n in names):
            piv, ang = np.array(B(sign * 0.1, 0.95, 0)), sign * math.radians(-13)
        else:
            continue
        d = co[v.index] - piv
        c, s_ = math.cos(ang), math.sin(ang)
        co[v.index] = piv + np.array([d[0] * c + d[2] * s_, d[1], -d[0] * s_ + d[2] * c])
me.vertices.foreach_set('co', co.ravel())
me.update()
for m in materials.values():
    m.node_tree.nodes['target'].image = bake_ao
world = bpy.data.worlds.new('w')
scene.world = world
world.light_settings.distance = 0.32
scene.cycles.samples = 96
bpy.ops.object.bake(type='AO')
me.vertices.foreach_set('co', rest)
me.update()


def image_array(img):
    a = np.zeros(TEX * TEX * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return np.flipud(a.reshape(TEX, TEX, 4))


ida = image_array(bake_id)
mat_id = np.clip(np.rint(ida[..., 0] * 16), 0, len(MATS)).astype(np.uint8)       # 0 = nothing baked
level = np.clip(np.rint(ida[..., 1] * 3), 0, 3).astype(np.uint8)
ao = np.clip(image_array(bake_ao)[..., 0], 0, 1)
ao = np.where(mat_id == 0, 1.0, ao)
# one byte per texel: high nibble material, low two bits camouflage level
packed = (mat_id << 4 | level).astype(np.uint8)
id_png = io.BytesIO()
Image.fromarray(packed, 'L').save(id_png, 'PNG', optimize=True)
ao_img = Image.fromarray((ao * 255).astype(np.uint8), 'L').resize((512, 512), Image.LANCZOS)
ao_png = io.BytesIO()
ao_img.save(ao_png, 'JPEG', quality=84, optimize=True)   # occlusion is smooth: JPEG is a quarter of the PNG

# ---------------------------------------------------------------------------
# export: unique (position, normal, uv) vertices with two bone weights each
# ---------------------------------------------------------------------------
me.calc_loop_triangles()
normals = me.corner_normals
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
assert nv < 65536
SCALE = 16000.0   # positions as int16: 1/16 mm steps
buf = io.BytesIO()
buf.write(np.array([[round(c * SCALE) for c in v[0]] for v in verts], dtype='<i2').tobytes())
buf.write(np.array([[round(c * 127) for c in v[1]] for v in verts], dtype='i1').tobytes())
buf.write(np.array([[round(v[2][0] * 65535), round(v[2][1] * 65535)] for v in verts], dtype='<u2').tobytes())
buf.write(np.array([[v[3], v[4], round(v[5] * 255)] for v in verts], dtype='u1').tobytes())
buf.write(np.array(index, dtype='<u2').tobytes())
mesh_bytes = buf.getvalue()
meta = {'verts': nv, 'tris': len(index) // 3, 'scale': SCALE, 'tex': TEX, 'materials': MATS, 'patch': PATCH, 'blender': bpy.app.version_string}

b64 = lambda b: base64.b64encode(b).decode('ascii')
with open(OUT_JS, 'w', encoding='utf-8') as fh:
    fh.write('// Generated by tools/blender/build_soldier.py with Blender %s. Do not edit by hand.\n' % bpy.app.version_string)
    fh.write('// Layout of MESH: int16 xyz, int8 normal, uint16 uv, uint8 (bone a, bone b, weight a), uint16 indices.\n')
    fh.write('export const SOLDIER_META = %s;\n' % json.dumps(meta))
    fh.write("export const SOLDIER_MESH = '%s';\n" % b64(mesh_bytes))
    fh.write("export const SOLDIER_ID = 'data:image/png;base64,%s';\n" % b64(id_png.getvalue()))
    fh.write("export const SOLDIER_AO = 'data:image/jpeg;base64,%s';\n" % b64(ao_png.getvalue()))
print('export: %d verts, %d tris | mesh %d KB, id map %d KB, ao map %d KB -> %s' % (
    nv, len(index) // 3, len(mesh_bytes) // 1024, len(id_png.getvalue()) // 1024, len(ao_png.getvalue()) // 1024, OUT_JS))

# previews for a quick look at what was baked
os.makedirs(PREVIEW, exist_ok=True)
pal = np.array([[0, 0, 0], [74, 90, 53], [138, 115, 80], [109, 90, 61], [143, 116, 79], [199, 154, 116], [20, 21, 24], [94, 81, 56], [107, 122, 74], [178, 34, 52], [92, 106, 69], [59, 61, 66]], dtype=np.float32)
camo = np.array([[74, 90, 53], [110, 90, 59], [163, 150, 114], [35, 36, 29]], dtype=np.float32)
rgb = pal[mat_id]
rgb = np.where((mat_id == 1)[..., None], camo[level], rgb)
Image.fromarray(np.clip(rgb * (0.4 + 0.6 * ao[..., None]), 0, 255).astype(np.uint8)).save(os.path.join(PREVIEW, 'atlas.png'))
