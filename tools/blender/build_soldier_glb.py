"""
Midtown Strike - soldier built from the supplied Tripo model (TacticalSoldier.glb).

Run (Blender 5.3, headless):
  /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/build_soldier_glb.py [-- --reuse --noprev]

  1. import the 378k-tri scan, decimate to ~16k tris, unwrap, bake normal / AO / colour / roughness / metalness
     from the scan onto the low-poly (Cycles, selected-to-active)
  2. skin the low-poly to the 16 game bones (region rules + distance to bone segments, max 2 influences) and
     retarget it into the game rig's rest pose (legs and arms straightened, proportions fitted to the joints)
  3. write src/chars/soldier_asset.js (mesh planes + JPEG maps as data URIs)
  4. render previews (tools/blender/preview/soldier_glb_*.png) and the contact sheet docs/sheet_soldier.png

--reuse skips the (slow) bake and reuses the cached one. The previous procedural soldier is build_soldier.py.
Needs numpy (ships with Blender); the system python3 with Pillow encodes the images.
"""
import bpy
import bmesh
import numpy as np
import math
import os
import sys
import io
import json
import zlib
import base64
import subprocess
import tempfile
from mathutils import Vector, Matrix

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
REUSE = '--reuse' in ARGS
NOPREV = '--noprev' in ARGS
SHOTS = [a for a in os.environ.get('SHOTS', '').split(',') if a]
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SRC_DIR = os.environ.get('SOLDIER_SRC', os.path.join(os.path.dirname(ROOT), 'modern-tactical-soldier'))
SRC_GLB = os.path.join(SRC_DIR, 'source', 'TacticalSoldier.glb')
TEXDIR = os.path.join(SRC_DIR, 'textures')
OUT_JS = os.path.join(ROOT, 'src', 'chars', 'soldier_asset.js')
PREVIEW = os.path.join(HERE, 'preview')
SHEET = os.path.join(ROOT, 'docs', 'sheet_soldier.png')
CACHE = os.path.join(tempfile.gettempdir(), 'soldier_glb_cache')
os.makedirs(CACHE, exist_ok=True)
LO_BLEND = os.path.join(CACHE, 'lo.blend')
MAPS_NPZ = os.path.join(CACHE, 'maps.npz')

TARGET_TRIS = 15500       # decimation target; UV / sharp-edge splits raise the vertex count, not the tris
TEX, TEX_B = 2048, 1024   # colour + normal, AO + ORM


def tex_file(prefix):
    for f in sorted(os.listdir(TEXDIR)):
        if f.startswith(prefix):
            return os.path.join(TEXDIR, f)
    raise FileNotFoundError(prefix)


def new_bake_image(name, size):
    im = bpy.data.images.new(name, size, size, alpha=False, float_buffer=True)
    im.colorspace_settings.name = 'Non-Color'
    return im


def image_pixels(im):
    n = im.size[0] * im.size[1] * 4
    a = np.empty(n, dtype=np.float32)
    im.pixels.foreach_get(a)
    return a.reshape(im.size[1], im.size[0], 4)


AXES = np.array([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]], dtype=np.float64)


def seam_patches(me, min_faces=40, rounds=10):
    """Label every face by the dominant axis of its smoothed normal, vote the noise away, absorb tiny patches,
    then mark the patch borders as UV seams."""
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    nf = len(bm.faces)
    fn = np.array([f.normal[:] for f in bm.faces])
    fa = np.array([f.calc_area() for f in bm.faces]) + 1e-12
    # smoothed normal over the 2-ring
    ring = [[g.index for v in f.verts for g in v.link_faces] for f in bm.faces]
    ns = fn * fa[:, None]
    for _ in range(2):
        nn = np.zeros_like(ns)
        for i, r in enumerate(ring):
            nn[i] = ns[r].sum(axis=0)
        ns = nn / (np.linalg.norm(nn, axis=1, keepdims=True) + 1e-12) * fa[:, None]
    ns /= (np.linalg.norm(ns, axis=1, keepdims=True) + 1e-12)
    score = ns @ AXES.T
    lab = score.argmax(axis=1)
    pairs = np.array([(e.link_faces[0].index, e.link_faces[1].index) for e in bm.edges if len(e.link_faces) == 2])
    a, b = pairs[:, 0], pairs[:, 1]
    for _ in range(rounds):
        votes = np.zeros((nf, 6))
        votes[np.arange(nf), lab] += 1.6 * fa
        np.add.at(votes, (a, lab[b]), fa[b])
        np.add.at(votes, (b, lab[a]), fa[a])
        votes += 0.5 * score * fa[:, None]
        lab = votes.argmax(axis=1)
    nbr = [[] for _ in range(nf)]
    for x, y in pairs:
        nbr[x].append(y)
        nbr[y].append(x)

    def components():
        comp = -np.ones(nf, dtype=np.int64)
        n = 0
        for s0 in range(nf):
            if comp[s0] >= 0:
                continue
            comp[s0] = n
            st = [s0]
            while st:
                f = st.pop()
                for g in nbr[f]:
                    if comp[g] < 0 and lab[g] == lab[f]:
                        comp[g] = n
                        st.append(g)
            n += 1
        return comp, n
    for _ in range(12):
        comp, n = components()
        sizes = np.bincount(comp, minlength=n)
        small = [c for c in range(n) if sizes[c] < min_faces]
        if not small:
            break
        for c in small:
            fs = np.where(comp == c)[0]
            cnt = {}
            for f in fs:
                for g in nbr[f]:
                    if comp[g] != c:
                        cnt[lab[g]] = cnt.get(lab[g], 0) + 1
            if cnt:
                lab[fs] = max(cnt, key=cnt.get)
    comp, n = components()
    print('uv patches:', n)
    for e in bm.edges:
        e.seam = bool(len(e.link_faces) == 2 and lab[e.link_faces[0].index] != lab[e.link_faces[1].index])
        if len(e.link_faces) == 1:
            e.seam = True
    bm.to_mesh(me)
    bm.free()


# ---------------------------------------------------------------------------
# 1. decimate, unwrap, bake
# ---------------------------------------------------------------------------
def make_lowpoly_and_bake():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    bpy.ops.import_scene.gltf(filepath=SRC_GLB)
    hi = [o for o in scene.objects if o.type == 'MESH'][0]
    hi.name = 'hi'
    bpy.context.view_layer.objects.active = hi
    hi.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    print('source: %d verts %d tris, dims %s' % (len(hi.data.vertices), len(hi.data.polygons), tuple(round(d, 3) for d in hi.dimensions)))

    # high-poly materials: colour (diffuse bake), roughness / metalness through emission (EMIT bake)
    def img(prefix, cs):
        im = bpy.data.images.load(tex_file(prefix))
        im.colorspace_settings.name = cs
        return im
    im_col = img('Color_', 'sRGB')
    im_rough = img('ORM_df116015-2687-4829-8fb0-f11ddd3ba0ee_1@channels=G', 'Non-Color')
    im_metal = img('ORM_df116015-2687-4829-8fb0-f11ddd3ba0ee_1@channels=B', 'Non-Color')

    def tex_mat(name, im, emit):
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        nt = m.node_tree
        nt.nodes.clear()
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = im
        t.interpolation = 'Cubic'
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        if emit:
            e = nt.nodes.new('ShaderNodeEmission')
            nt.links.new(t.outputs['Color'], e.inputs['Color'])
            nt.links.new(e.outputs['Emission'], out.inputs['Surface'])
        else:
            b = nt.nodes.new('ShaderNodeBsdfPrincipled')
            nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
            nt.links.new(b.outputs['BSDF'], out.inputs['Surface'])
        return m
    mats_hi = {'col': tex_mat('hi_col', im_col, False), 'rough': tex_mat('hi_rough', im_rough, True), 'metal': tex_mat('hi_metal', im_metal, True)}

    # low-poly by decimation of a UV-less copy
    me = hi.data.copy()
    me.name = 'lo'
    while me.uv_layers:
        me.uv_layers.remove(me.uv_layers[0])
    for a in list(me.attributes):
        if a.name.startswith('Col') or a.name.startswith('Color'):
            me.attributes.remove(a)
    me.materials.clear()
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.00005)   # the glTF import splits vertices along UV seams
    bm.to_mesh(me)
    bm.free()
    print('welded: %d verts' % len(me.vertices))
    lo = bpy.data.objects.new('lo', me)
    scene.collection.objects.link(lo)
    for o in scene.objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = lo
    lo.select_set(True)
    md = lo.modifiers.new('dec', 'DECIMATE')
    md.decimate_type = 'COLLAPSE'
    md.ratio = TARGET_TRIS / len(hi.data.polygons)
    md.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier='dec')
    print('decimated: %d verts %d tris' % (len(me.vertices), len(me.polygons)))

    # smooth shading with sharp edges where the surface really folds
    for p in me.polygons:
        p.use_smooth = True
    me.set_sharp_from_angle(angle=math.radians(52))

    # unwrap: seams between large smooth patches (not between the noisy decimated triangles)
    seam_patches(me)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.unwrap(method='CONFORMAL', margin=0.004)
    bpy.ops.uv.average_islands_scale()
    bpy.ops.uv.pack_islands(margin=0.005, rotate=True)
    bpy.ops.object.mode_set(mode='OBJECT')

    # cycles
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 1
    scene.cycles.use_denoising = False
    scene.cycles.bake_type = 'NORMAL'
    scene.render.bake.use_selected_to_active = True
    w = bpy.data.worlds.new('w')
    w.use_nodes = True
    scene.world = w
    w.light_settings.distance = 0.1

    lo_mat = bpy.data.materials.new('lo_bake')
    lo_mat.use_nodes = True
    me.materials.append(lo_mat)
    nt = lo_mat.node_tree
    tn = nt.nodes.new('ShaderNodeTexImage')

    def bake(kind, size, mat_key, samples, **kw):
        im = new_bake_image('bk_' + kind, size)
        tn.image = im
        nt.nodes.active = tn
        hi.data.materials.clear()
        hi.data.materials.append(mats_hi[mat_key] if mat_key else mats_hi['col'])
        for o in scene.objects:
            o.select_set(False)
        hi.select_set(True)
        lo.select_set(True)
        bpy.context.view_layer.objects.active = lo
        scene.cycles.samples = samples
        args = dict(type=kw.pop('type'), use_selected_to_active=True, cage_extrusion=EXTR, max_ray_distance=RAYD,
                    margin=12 if size > 1024 else 8, margin_type='EXTEND', use_clear=True)
        args.update(kw)
        bpy.ops.object.bake(**args)
        a = image_pixels(im)[:, :, :3].copy()
        print('baked', kind, size, 'mean', a.mean(axis=(0, 1)).round(3))
        return a

    EXTR, RAYD = 0.012, 0.03
    out = {}
    out['nrm'] = bake('normal', TEX, 'col', 1, type='NORMAL', normal_space='TANGENT')
    out['ao'] = bake('ao', TEX_B, 'col', 48, type='AO')
    out['col'] = bake('color', TEX, 'col', 1, type='DIFFUSE', pass_filter={'COLOR'})
    out['rough'] = bake('rough', TEX_B, 'rough', 1, type='EMIT')
    out['metal'] = bake('metal', TEX_B, 'metal', 1, type='EMIT')
    np.savez(MAPS_NPZ, **out)

    bpy.data.objects.remove(hi)
    lo.data.materials.clear()
    bpy.ops.wm.save_as_mainfile(filepath=LO_BLEND)
    print('bake done')


if not (REUSE and os.path.exists(LO_BLEND) and os.path.exists(MAPS_NPZ)):
    make_lowpoly_and_bake()
if '--bakeonly' in ARGS:
    sys.exit(0)

# ---------------------------------------------------------------------------
# 2. rig, skin weights, retarget into the game rig's rest pose
# ---------------------------------------------------------------------------
bpy.ops.wm.open_mainfile(filepath=LO_BLEND)
scene = bpy.context.scene
lo = bpy.data.objects['lo']
me = lo.data
MAPS = dict(np.load(MAPS_NPZ))

# game rig (must match RIG in src/chars/soldier.js): name, parent, rest position (model space, -Z forward, Y up)
RIG = [
    ('hips', -1, 0, 0.95, 0), ('spine', 0, 0, 1.05, 0), ('chest', 1, 0, 1.25, 0), ('head', 2, 0, 1.52, 0),
    ('armL', 2, -0.225, 1.49, 0), ('foreL', 4, -0.225, 1.21, 0), ('handL', 5, -0.225, 0.95, 0),
    ('armR', 2, 0.225, 1.49, 0), ('foreR', 7, 0.225, 1.21, 0), ('handR', 8, 0.225, 0.95, 0),
    ('thighL', 0, -0.1, 0.93, 0), ('shinL', 10, -0.1, 0.5, 0), ('footL', 11, -0.1, 0.07, 0),
    ('thighR', 0, 0.1, 0.93, 0), ('shinR', 13, 0.1, 0.5, 0), ('footR', 14, 0.1, 0.07, 0),
]
BI = {r[0]: i for i, r in enumerate(RIG)}
REST = np.array([[r[2], r[3], r[4]] for r in RIG], dtype=np.float64)

# joints of the scan in its own space (Blender, Z up, faces +X, character left = +Y), estimated from front / side renders
SJ = dict(
    hips=(0.02, 0, -0.04), spine=(0.02, 0, 0.02), chest=(0.02, 0, 0.14), head=(0.04, 0, 0.305), headtop=(0.07, 0, 0.49),
    shoulder=(0.01, 0.19, 0.245), elbow=(0.02, 0.235, 0.085), wrist=(0.09, 0.24, 0.0), tip=(0.11, 0.24, -0.09),
    hip=(0.02, 0.09, -0.04), knee=(0.09, 0.15, -0.2), ankle=(0.01, 0.19, -0.44), toe=(0.15, 0.19, -0.465),
)
SJ = {k: np.array(v, dtype=np.float64) for k, v in SJ.items()}


def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def chain_coord(P, joints):
    """arc-length coordinate of the nearest point on a polyline, and the distance to it"""
    cum = [0.0]
    for a, b in zip(joints[:-1], joints[1:]):
        cum.append(cum[-1] + np.linalg.norm(b - a))
    best_d = np.full(len(P), 1e9)
    best_s = np.zeros(len(P))
    for i in range(len(joints) - 1):
        a, b = joints[i], joints[i + 1]
        u = (b - a) / np.linalg.norm(b - a)
        t = np.clip((P - a) @ u, 0, cum[i + 1] - cum[i])
        d = np.linalg.norm(P - (a + np.outer(t, u)), axis=1)
        m = d < best_d
        best_d[m] = d[m]
        best_s[m] = cum[i] + t[m]
    return best_s, best_d, cum


def chain_weights(P, joints, wins):
    """3-bone chain partition of unity along the arc length, smooth windows (half widths) around joints 1 and 2"""
    S, D, cum = chain_coord(P, joints)
    w0 = 1 - sstep(cum[1] - wins[0], cum[1] + wins[0], S)
    w2 = sstep(cum[2] - wins[1], cum[2] + wins[1], S)
    w1 = np.clip(1 - w0 - w2, 0, 1)
    return w0, w1, w2


def compute_weights(V):
    x, y, z = V.T
    ay = np.abs(y)
    n = len(V)
    W = np.zeros((n, 16))
    # ---- upper body partition: hips / spine / chest / head
    zeff = z + 0.13 * (1 - sstep(-0.07, -0.03, x)) * sstep(0.02, 0.06, z)      # backpack rides with the chest
    wh = 1 - sstep(-0.01, 0.06, zeff)
    wc = sstep(0.05, 0.16, zeff)
    ws = np.clip(1 - wh - wc, 0, 1)
    tot = wh + ws + wc
    wh, ws, wc = wh / tot, ws / tot, wc / tot
    thr = np.interp(x, [0.0, 0.10], [0.335, 0.285])
    head = sstep(thr - 0.015, thr + 0.02, z) * (1 - sstep(0.12, 0.16, ay)) * sstep(-0.005, 0.025, x)
    up = np.zeros((n, 16))
    up[:, BI['hips']] = wh * (1 - head)
    up[:, BI['spine']] = ws * (1 - head)
    up[:, BI['chest']] = wc * (1 - head)
    up[:, BI['head']] = head
    # ---- legs
    lz = 1 - sstep(-0.075, -0.01, z)
    leg = np.zeros((n, 16))
    swL = sstep(-0.025, 0.025, y)
    for side, sgn, sw in (('L', 1, swL), ('R', -1, 1 - swL)):
        P = np.stack([x, sgn * y, z], axis=1)
        a, b, c = chain_weights(P, [SJ['hip'], SJ['knee'], SJ['ankle'], SJ['toe']], (0.035, 0.022))
        leg[:, BI['thigh' + side]] = a * sw
        leg[:, BI['shin' + side]] = b * sw
        leg[:, BI['foot' + side]] = c * sw
    body = (1 - lz)[:, None] * up + lz[:, None] * leg
    # ---- arms
    yb = np.interp(z, [-0.1, 0.0, 0.05, 0.2, 0.3], [0.2, 0.2, 0.175, 0.16, 0.115])
    a_raw = sstep(yb - 0.01, yb + 0.025, ay) * sstep(-0.17, -0.13, z) * (1 - sstep(0.30, 0.32, z))
    a_raw *= 1 - (1 - sstep(-0.07, -0.03, x)) * sstep(0.26, 0.29, z)      # backpack top corners are not shoulder
    Wout = body.copy()
    acc = np.zeros(n)
    for side, sgn in (('L', 1), ('R', -1)):
        P = np.stack([x, sgn * y, z], axis=1)
        _s, dch, _c = chain_coord(P, [SJ['shoulder'], SJ['elbow'], SJ['wrist'], SJ['tip']])
        low = 1 - sstep(0.02, 0.06, z)        # forearm / glove: decided by distance to the arm, the thigh pockets are right next to it
        near = (1 - sstep(0.045, 0.075, dch)) * sstep(-0.17, -0.13, z)
        am = ((1 - low) * a_raw + low * near) * sstep(-0.01, 0.015, sgn * y)
        a, b, c = chain_weights(P, [SJ['shoulder'], SJ['elbow'], SJ['wrist'], SJ['tip']], (0.03, 0.015))
        sock = 0.55 * (1 - sstep(0.03, 0.09, np.linalg.norm(P - SJ['shoulder'], axis=1)))
        arm = np.zeros((n, 16))
        arm[:, BI['arm' + side]] = a * (1 - sock)
        arm[:, BI['chest']] = a * sock
        arm[:, BI['fore' + side]] = b
        arm[:, BI['hand' + side]] = c
        Wout += am[:, None] * (arm - body)
        acc += am
    # keep the two arm masks from over-subtracting where both are 0.5 (never happens: arms are far apart)
    # ---- top two influences
    idx = np.argsort(-Wout, axis=1)[:, :2]
    w2 = np.take_along_axis(Wout, idx, axis=1)
    w2 = w2 / np.maximum(w2.sum(axis=1, keepdims=True), 1e-9)
    return idx, w2, Wout


def rot_between(a, b):
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    v = np.cross(a, b)
    c = float(a @ b)
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3)
    K = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + K + K @ K / (1 + c)


S0 = 1.75                                  # scan -> metres, before the per-bone fit
M_SRC = np.array([[0, -1, 0], [0, 0, 1], [-1, 0, 0]], dtype=np.float64)   # Blender scan (x fwd, y left, z up) -> game (x right, y up, z back)


def G(p):
    return (np.asarray(p) @ M_SRC.T) * S0


# per bone: (source joint, source child joint, lateral scale (game x, y, z), uniform / along-bone stretch policy)
def bone_transforms():
    """returns for each rig bone the pair (T, A): g' = T + A (g - Jg)"""
    out = []
    LAT = dict(torso=(0.62, 1.0, 0.85), head=(0.8, 1.0, 0.85), arm=(0.85, 1.0, 0.88), leg=(0.82, 1.0, 0.9), hand=(0.9, 1.0, 0.9), foot=(0.82, 1.0, 0.9))
    for i, (name, par, rx, ry, rz) in enumerate(RIG):
        side = name[-1] if name[-1] in 'LR' else ''
        sg = 1 if side == 'L' else -1
        base = name[:-1] if side else name

        def mirror(v):
            return np.array([v[0], sg * v[1] if side else v[1], v[2]])
        spec = {
            'hips': ('hips', 'spine', 'torso', None), 'spine': ('spine', 'chest', 'torso', None), 'chest': ('chest', 'head', 'torso', None),
            'head': ('head', 'headtop', 'head', 0.93),
            'arm': ('shoulder', 'elbow', 'arm', None), 'fore': ('elbow', 'wrist', 'arm', None), 'hand': ('wrist', 'tip', 'hand', 'rigid'),
            'thigh': ('hip', 'knee', 'leg', None), 'shin': ('knee', 'ankle', 'leg', None), 'foot': ('ankle', 'toe', 'foot', 'rigid'),
        }[base]
        j0, j1, lat, mode = spec
        J0, J1 = G(mirror(SJ[j0])), G(mirror(SJ[j1]))
        Lm = np.diag(LAT[lat])
        d_s = Lm @ (J1 - J0)
        # target direction
        child = [k for k, r in enumerate(RIG) if r[1] == i]
        if base == 'head':
            d_t = np.array([0, 1.0, 0])
        elif base == 'foot':
            d_t = np.array([0, 0, -1.0])
        elif child:
            d_t = REST[child[0]] - REST[i]
        elif base == 'hand':
            d_t = np.array([0, -1.0, 0])
        else:
            d_t = np.array([0, 1.0, 0])
        if base in ('hips', 'spine', 'chest'):
            d_t = REST[child[0]] - REST[i]
        R = rot_between(d_s, d_t)
        if mode == 'rigid':
            K = np.eye(3)
        elif isinstance(mode, float):
            K = np.eye(3) * mode
            R = R   # head: keep proportions, just scale
            Lm = Lm
        else:
            e = d_s / np.linalg.norm(d_s)
            k = np.linalg.norm(d_t) / np.linalg.norm(d_s)
            K = np.eye(3) + (k - 1) * np.outer(e, e)
        if base == 'hand':      # hand follows the forearm's rotation (wrist is rigid), keeps its own length
            pass
        A = R @ K @ Lm
        out.append((REST[i].copy(), A, J0))
    return out


BT = bone_transforms()


def retarget(Vs, idx, w2):
    Gp = G(Vs)
    out = np.zeros_like(Gp)
    for k in range(2):
        for b in range(16):
            m = idx[:, k] == b
            if not m.any():
                continue
            T, A, J0 = BT[b]
            out[m] += w2[m, k:k + 1] * (T + (Gp[m] - J0) @ A.T)
    return out


nv0 = len(me.vertices)
Vs = np.empty(nv0 * 3)
me.vertices.foreach_get('co', Vs)
Vs = Vs.reshape(-1, 3).astype(np.float64)
SKIN_IDX, SKIN_W, SKIN_FULL = compute_weights(Vs)
Vg = retarget(Vs, SKIN_IDX, SKIN_W)
Vg[:, 1] -= Vg[:, 1].min()
_E = np.array([[e.vertices[0], e.vertices[1]] for e in me.edges])
_r = np.linalg.norm(Vg[_E[:, 0]] - Vg[_E[:, 1]], axis=1) / (np.linalg.norm(Vs[_E[:, 0]] - Vs[_E[:, 1]], axis=1) * S0 + 1e-9)
for k in np.argsort(-_r)[:8]:
    a_, b_ = _E[k]
    print('stretch %.1f src %s w %s %s | src %s w %s %s' % (_r[k], Vs[a_].round(3), SKIN_IDX[a_], SKIN_W[a_].round(2), Vs[b_].round(3), SKIN_IDX[b_], SKIN_W[b_].round(2)))
_m = (Vg[:, 1] > 1.68) & (np.abs(Vg[:, 0]) > 0.11)
for k in np.where(_m)[0][:12]:
    print('ear', Vs[k].round(3), Vg[k].round(3), SKIN_IDX[k], SKIN_W[k].round(2))
print('retargeted: height %.3f  x %.3f..%.3f  z %.3f..%.3f' % (Vg[:, 1].max(), Vg[:, 0].min(), Vg[:, 0].max(), Vg[:, 2].min(), Vg[:, 2].max()))


def to_blender(Vgame):
    return np.stack([Vgame[:, 0], -Vgame[:, 2], Vgame[:, 1]], axis=1)


me.vertices.foreach_set('co', to_blender(Vg).astype(np.float32).ravel())
me.update()

# ---------------------------------------------------------------------------
# 3. export: mesh planes + JPEG maps
# ---------------------------------------------------------------------------
nl = len(me.loops)
lv = np.empty(nl, dtype=np.int32)
me.loops.foreach_get('vertex_index', lv)
cn = np.empty(nl * 3, dtype=np.float32)
me.corner_normals.foreach_get('vector', cn)
cn = cn.reshape(-1, 3)
uvl = me.uv_layers[0]
uvs = np.empty(nl * 2, dtype=np.float32)
uvl.uv.foreach_get('vector', uvs)
uvs = uvs.reshape(-1, 2)
me.calc_loop_triangles()
ntri = len(me.loop_triangles)
tl = np.empty(ntri * 3, dtype=np.int32)
me.loop_triangles.foreach_get('loops', tl)
# unique (vertex, normal, uv) corners become the exported vertices
key = np.concatenate([lv[:, None].astype(np.int64), np.round(cn * 100).astype(np.int64), np.round(uvs * 4096).astype(np.int64)], axis=1)
uk, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
inv = inv.ravel()
nv = len(uk)
order = np.argsort(first)               # keep first-appearance order
rank = np.empty(nv, dtype=np.int64)
rank[order] = np.arange(nv)
first_sorted = first[order]
ev = lv[first_sorted]
EXP_P = Vg[ev]                                           # game space
EXP_N = np.stack([cn[first_sorted, 0], cn[first_sorted, 2], -cn[first_sorted, 1]], axis=1)
EXP_N /= np.linalg.norm(EXP_N, axis=1, keepdims=True) + 1e-12
EXP_UV = np.clip(uvs[first_sorted], 0, 1)
EXP_IDX = rank[inv[tl]]
EXP_SK = np.zeros((nv, 3), dtype=np.uint8)
ia, ib = SKIN_IDX[ev, 0], SKIN_IDX[ev, 1]
wa = SKIN_W[ev, 0]
single = SKIN_W[ev, 1] < 1e-4
ib = np.where(single, ia, ib)
EXP_SK[:, 0], EXP_SK[:, 1], EXP_SK[:, 2] = ia, ib, np.round(np.where(single, 1.0, wa) * 255)
print('export mesh: %d verts, %d tris' % (nv, ntri))
assert nv < 65536
SCALE = 16000.0
b64 = lambda b: base64.b64encode(b).decode('ascii')


def delta16(a):
    d = np.diff(np.asarray(a, dtype=np.int64), prepend=0)
    return (d & 0xFFFF).astype('<u2')


def mesh_blob():
    P = np.round(EXP_P * SCALE).astype(np.int64)
    N = np.round(EXP_N * 127).astype(np.int8)
    U = np.round(EXP_UV * 65535).astype(np.int64)
    buf = io.BytesIO()
    for k in range(3):
        buf.write(delta16(P[:, k]).tobytes())
    for k in range(3):
        buf.write(N[:, k].tobytes())
    for k in range(2):
        buf.write(delta16(U[:, k]).tobytes())
    for k in range(3):
        buf.write(EXP_SK[:, k].tobytes())
    buf.write(delta16(EXP_IDX).tobytes())
    return buf.getvalue()


mesh_raw = mesh_blob()
mesh_z = zlib.compress(mesh_raw, 9)

Q_COL, Q_NRM = int(os.environ.get('Q_COL', 80)), int(os.environ.get('Q_NRM', 82))


def encode_maps(tmp):
    def srgb(a):
        a = np.clip(a, 0, 1)
        return np.where(a <= 0.0031308, a * 12.92, 1.055 * np.power(a, 1 / 2.4) - 0.055)
    flip = lambda a: np.ascontiguousarray(a[::-1])
    to8 = lambda a: (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)
    np.save(os.path.join(tmp, 'col.npy'), to8(flip(srgb(MAPS['col']))))
    np.save(os.path.join(tmp, 'nrm.npy'), to8(flip(MAPS['nrm'])))
    orm = np.stack([np.ones_like(MAPS['ao'][:, :, 0]), MAPS['rough'][:, :, 0], MAPS['metal'][:, :, 0]], axis=2)
    np.save(os.path.join(tmp, 'orm.npy'), to8(flip(orm)))
    np.save(os.path.join(tmp, 'ao.npy'), to8(flip(MAPS['ao'][:, :, 0])))
    code = (
        "import sys, numpy as np\nfrom PIL import Image\nd=sys.argv[1]; qc=int(sys.argv[2]); qn=int(sys.argv[3])\n"
        "Image.fromarray(np.load(d+'/col.npy'),'RGB').save(d+'/col.jpg','JPEG',quality=qc,optimize=True,subsampling=2)\n"
        "Image.fromarray(np.load(d+'/nrm.npy'),'RGB').save(d+'/nrm.jpg','JPEG',quality=qn,optimize=True,subsampling=0)\n"
        "Image.fromarray(np.load(d+'/orm.npy'),'RGB').save(d+'/orm.jpg','JPEG',quality=82,optimize=True,subsampling=0)\n"
        "Image.fromarray(np.load(d+'/ao.npy'),'L').save(d+'/ao.jpg','JPEG',quality=80,optimize=True)\n")
    r = subprocess.run(['python3', '-I', '-c', code, tmp, str(Q_COL), str(Q_NRM)], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError('map encoding failed (system python3 needs numpy + Pillow): ' + r.stderr)
    return {k: open(os.path.join(tmp, k + '.jpg'), 'rb').read() for k in ('col', 'nrm', 'orm', 'ao')}


MAPDIR = os.path.join(CACHE, 'maps')
os.makedirs(MAPDIR, exist_ok=True)
ENC = encode_maps(MAPDIR)
meta = {'verts': nv, 'tris': ntri, 'scale': SCALE, 'tex': TEX, 'texB': TEX_B, 'textured': True,
        'maps': {'color': 'SOLDIER_COLOR', 'normal': 'SOLDIER_NORMAL', 'orm': 'SOLDIER_ORM', 'ao': 'SOLDIER_AO'},
        'blender': bpy.app.version_string,
        'format': 'deflate: planes px,py,pz (int16 delta), nx,ny,nz (int8), u,v (uint16 delta), bone a, bone b, weight a (uint8), indices (uint16 delta)'}
with open(OUT_JS, 'w', encoding='utf-8') as fh:
    fh.write('// Generated by tools/blender/build_soldier_glb.py with Blender %s. Do not edit by hand.\n' % bpy.app.version_string)
    fh.write('// Source: owner-supplied Tripo scan, decimated + baked. MESH: zlib-deflated planes (see SOLDIER_META.format).\n')
    fh.write('// COLOR sRGB jpeg | NORMAL tangent-space jpeg | ORM: G roughness, B metalness | AO gray jpeg.\n')
    fh.write('export const SOLDIER_META = %s;\n' % json.dumps(meta))
    fh.write("export const SOLDIER_MESH = '%s';\n" % b64(mesh_z))
    fh.write("export const SOLDIER_COLOR = 'data:image/jpeg;base64,%s';\n" % b64(ENC['col']))
    fh.write("export const SOLDIER_NORMAL = 'data:image/jpeg;base64,%s';\n" % b64(ENC['nrm']))
    fh.write("export const SOLDIER_ORM = 'data:image/jpeg;base64,%s';\n" % b64(ENC['orm']))
    fh.write("export const SOLDIER_AO = 'data:image/jpeg;base64,%s';\n" % b64(ENC['ao']))
print('export: %d verts, %d tris | mesh %d KB | color %d KB normal %d KB orm %d KB ao %d KB | file %d KB -> %s' % (
    nv, ntri, len(mesh_z) // 1024, len(ENC['col']) // 1024, len(ENC['nrm']) // 1024, len(ENC['orm']) // 1024, len(ENC['ao']) // 1024,
    os.path.getsize(OUT_JS) // 1024, OUT_JS))

# ---------------------------------------------------------------------------
# 4. previews: Principled BSDF with the shipped JPEGs; poses by emulating the skinning
# ---------------------------------------------------------------------------
ENEMY = dict(sat=0.5, mul=(0.62, 0.7, 0.9))    # same recipe as soldier.js (colour map -> cooler, darker, desaturated)


def B(x, y, z):
    return Vector((x, -z, y))


def view_material(team):
    def load(name, cs):
        im = bpy.data.images.load(os.path.join(MAPDIR, name))
        im.colorspace_settings.name = cs
        return im
    m = bpy.data.materials.new('view_' + team)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    N = nt.nodes.new
    L = nt.links.new
    col = N('ShaderNodeTexImage'); col.image = load('col.jpg', 'sRGB')
    nrm = N('ShaderNodeTexImage'); nrm.image = load('nrm.jpg', 'Non-Color')
    orm = N('ShaderNodeTexImage'); orm.image = load('orm.jpg', 'Non-Color')
    ao = N('ShaderNodeTexImage'); ao.image = load('ao.jpg', 'Non-Color')
    nm = N('ShaderNodeNormalMap'); nm.inputs['Strength'].default_value = 1.0
    L(nrm.outputs['Color'], nm.inputs['Color'])
    sep = N('ShaderNodeSeparateColor')
    L(orm.outputs['Color'], sep.inputs['Color'])
    rng = N('ShaderNodeMapRange'); rng.inputs['To Min'].default_value = 0.45; rng.inputs['To Max'].default_value = 1.0
    L(ao.outputs['Color'], rng.inputs['Value'])
    c = col.outputs['Color']
    if team == 'enemy':
        hs = N('ShaderNodeHueSaturation'); hs.inputs['Saturation'].default_value = ENEMY['sat']
        L(c, hs.inputs['Color'])
        mu = N('ShaderNodeMix'); mu.data_type = 'RGBA'; mu.blend_type = 'MULTIPLY'; mu.inputs['Factor'].default_value = 1.0
        L(hs.outputs['Color'], mu.inputs['A'])
        mu.inputs['B'].default_value = (*[v ** 2.2 for v in ENEMY['mul']], 1)
        c = mu.outputs['Result']
    m2 = N('ShaderNodeMix'); m2.data_type = 'RGBA'; m2.blend_type = 'MULTIPLY'; m2.inputs['Factor'].default_value = 1.0
    L(c, m2.inputs['A'])
    L(rng.outputs['Result'], m2.inputs['B'])
    bsdf = N('ShaderNodeBsdfPrincipled')
    L(m2.outputs['Result'], bsdf.inputs['Base Color'])
    L(sep.outputs['Green'], bsdf.inputs['Roughness'])
    L(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    L(nm.outputs['Normal'], bsdf.inputs['Normal'])
    out = N('ShaderNodeOutputMaterial')
    L(bsdf.outputs['BSDF'], out.inputs['Surface'])
    return m


def posed_object(name, pose, hide_head=False):
    """pose: bone -> (rx, rz) in degrees (rotation order Rz after Rx), applied through the skin weights"""
    nb = len(RIG)
    Wm = [None] * nb
    Sm = np.zeros((nb, 4, 4))
    for i, (nm_, par, *_r) in enumerate(RIG):
        rx, rz = pose.get(nm_, (0, 0))
        R = np.eye(4)
        cx, sx, cz, sz = math.cos(math.radians(rx)), math.sin(math.radians(rx)), math.cos(math.radians(rz)), math.sin(math.radians(rz))
        Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
        Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
        R[:3, :3] = Rz @ Rx
        T = np.eye(4)
        T[:3, 3] = REST[i] - (REST[par] if par >= 0 else 0)
        loc = T @ R
        Wm[i] = loc if par < 0 else Wm[par] @ loc
        Tn = np.eye(4)
        Tn[:3, 3] = -REST[i]
        Sm[i] = Wm[i] @ Tn
    out = np.zeros_like(Vg)
    h = np.concatenate([Vg, np.ones((len(Vg), 1))], axis=1)
    for k in range(2):
        for b in range(nb):
            mk = SKIN_IDX[:, k] == b
            if mk.any():
                out[mk] += SKIN_W[mk, k:k + 1] * (h[mk] @ Sm[b].T)[:, :3]
    if hide_head:
        hw = np.where(SKIN_IDX[:, 0] == BI['head'], SKIN_W[:, 0], 0) + np.where(SKIN_IDX[:, 1] == BI['head'], SKIN_W[:, 1], 0)
        out = out + hw[:, None] * (np.array([0, 1.45, 0.0]) - out)
    m2 = me.copy()
    m2.name = name
    m2.vertices.foreach_set('co', to_blender(out).astype(np.float32).ravel())
    m2.update()
    o = bpy.data.objects.new(name, m2)
    scene.collection.objects.link(o)
    return o


def setup_scene():
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = int(os.environ.get('PREV_SAMPLES', 24))
    scene.cycles.use_denoising = True
    scene.render.film_transparent = False
    scene.view_settings.view_transform = 'Standard'
    w = scene.world
    w.use_nodes = True
    bg = w.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (0.42, 0.47, 0.55, 1)
    bg.inputs['Strength'].default_value = 0.9
    sun = bpy.data.lights.new('sun', 'SUN'); sun.energy = 3.2; sun.angle = math.radians(25)
    so = bpy.data.objects.new('sun', sun); scene.collection.objects.link(so)
    so.rotation_euler = (math.radians(50), 0, math.radians(150))
    fill = bpy.data.lights.new('fill', 'AREA'); fill.energy = 90; fill.size = 4
    fo = bpy.data.objects.new('fill', fill); scene.collection.objects.link(fo)
    fo.location = (-3, 4, 1.8); fo.rotation_euler = ((Vector((0, 0, 1)) - fo.location).to_track_quat('-Z', 'Y').to_euler())
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, 0))
    fl = bpy.context.object; fl.name = 'floor'
    fm = bpy.data.materials.new('floor'); fm.use_nodes = True
    fm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.09, 0.1, 0.11, 1)
    fl.data.materials.append(fm)


def shoot(name, cam_loc, target, lens, res, game=False, sensor_fit='VERTICAL', sensor=24.0):
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
    scene.render.filepath = os.path.join(PREVIEW, 'soldier_glb_' + name + '.png')
    if SHOTS and name not in SHOTS:
        bpy.data.objects.remove(co)
        return
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(co)
    print('rendered', name)


def previews():
    os.makedirs(PREVIEW, exist_ok=True)
    setup_scene()
    mats = {t: view_material(t) for t in ('marine', 'enemy')}
    lo.data.materials.clear()
    lo.data.materials.append(mats['marine'])
    for p in lo.data.polygons:
        p.use_smooth = True
    bent = posed_object('bent', {
        'armL': (25, -8), 'foreL': (80, 0), 'armR': (25, 8), 'foreR': (85, 0),
        'thighL': (55, 0), 'shinL': (-95, 0), 'thighR': (-15, 0), 'shinR': (-30, 0), 'spine': (8, 0), 'chest': (6, 0)})
    fp = posed_object('fp', {
        'head': (0, 0), 'armR': (62, 18), 'foreR': (30, 0), 'armL': (70, -26), 'foreL': (45, 0), 'handR': (10, 0)}, hide_head=True)
    for o in (bent, fp):
        o.data.materials.append(mats['marine'])
        o.hide_render = True
    sets = {'rest': lo, 'bent': bent, 'fp': fp}

    def only(k):
        for n, o in sets.items():
            o.hide_render = n != k
    only('rest')
    shoot('front', (0, 5.8, 0.93), (0, 0, 0.93), 62, (700, 1000))
    shoot('back', (0, -5.8, 0.93), (0, 0, 0.93), 62, (700, 1000))
    shoot('34', (3.9, 3.9, 1.25), (0, 0, 0.93), 62, (700, 1000))
    shoot('head', (0.75, 1.9, 1.62), (0, 0, 1.5), 62, (900, 800))
    shoot('torso', (0.0, 3.4, 1.15), (0, 0, 1.12), 62, (900, 800))
    shoot('legs', (1.5, 3.0, 0.5), (0, 0, 0.5), 62, (900, 800))
    only('bent')
    shoot('bent', (3.2, 4.2, 1.1), (0, 0, 0.9), 62, (900, 1000))
    shoot('bent_side', (5.8, 0, 1.0), (0, 0, 0.9), 62, (900, 1000))
    only('fp')
    shoot('fp', (0.0, 1.69, 0.12), (0.0, 1.46, -0.6), 22, (1200, 800), game=True, sensor_fit='HORIZONTAL', sensor=36.0)
    only('rest')
    lo.data.materials.clear()
    lo.data.materials.append(mats['enemy'])
    shoot('enemy', (0, 5.8, 0.93), (0, 0, 0.93), 62, (700, 1000))
    shoot('enemy_back', (-2.9, -5.0, 1.3), (0, 0, 0.93), 62, (700, 1000))
    shoot('enemy_head', (0.75, 1.9, 1.62), (0, 0, 1.5), 62, (900, 800))
    # skin weights: dominant bone as flat colour
    pal = np.array([[.9, .2, .2], [.9, .5, .1], [.9, .9, .1], [.1, .9, .9], [.2, .8, .2], [.1, .5, .2], [.05, .3, .1], [.3, .3, 1], [.1, .1, .8], [.05, .05, .5],
                    [.9, .3, .9], [.6, .1, .6], [.3, .05, .3], [.9, .6, .8], [.5, .3, .4], [.3, .2, .25]])
    wm = me.copy()
    wm.name = 'wmesh'
    cols = pal[SKIN_IDX[:, 0]] * SKIN_W[:, 0:1] + pal[SKIN_IDX[:, 1]] * SKIN_W[:, 1:2]
    ca = wm.color_attributes.new('wc', 'FLOAT_COLOR', 'POINT')
    ca.data.foreach_set('color', np.concatenate([cols, np.ones((len(cols), 1))], axis=1).astype(np.float32).ravel())
    wmat = bpy.data.materials.new('wmat'); wmat.use_nodes = True
    nt = wmat.node_tree; nt.nodes.clear()
    an = nt.nodes.new('ShaderNodeAttribute'); an.attribute_name = 'wc'
    em = nt.nodes.new('ShaderNodeEmission'); on = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(an.outputs['Color'], em.inputs['Color']); nt.links.new(em.outputs['Emission'], on.inputs['Surface'])
    wm.materials.clear(); wm.materials.append(wmat)
    wo = bpy.data.objects.new('wobj', wm); scene.collection.objects.link(wo)
    lo.hide_render = True
    shoot('weights', (3.9, 3.9, 1.25), (0, 0, 0.93), 62, (700, 1000))
    shoot('weights_back', (-3.9, -3.9, 1.25), (0, 0, 0.93), 62, (700, 1000))


if not NOPREV:
    previews()
    sheet_code = (
        "import sys\nfrom PIL import Image, ImageDraw\nd=sys.argv[1]; out=sys.argv[2]\n"
        "names=['front','back','34','head','torso','legs','bent','bent_side','fp','enemy','enemy_back','enemy_head']\n"
        "ims=[]\n"
        "for n in names:\n"
        "    try: ims.append((n,Image.open(f'{d}/soldier_glb_{n}.png').convert('RGB')))\n"
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
