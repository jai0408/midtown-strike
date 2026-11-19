"""Imports the three owner-supplied Sketchfab weapon models into the game.

    /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/import_weapons.py

Sources (never modified, in the folder above the repo):
  hand gun.glb  Colt M1911 (lokeig, CC-BY-NC-4.0)       -> 'm1911'  one pistol + its inserted magazine
  sniper.glb    KSR 29 Sniper (3DHaupt, CC-BY-NC-4.0)   -> 'ksr29'
  knife.glb     Magic sword (Biomoloko, CC-BY-4.0)      -> 'sword'  (a fantasy longsword, not a knife)
See docs/CREDITS.md.

For every model: keep only the needed meshes, bake transforms, orient to game
space (X right, Y up, muzzle / blade tip toward -Z), scale to real-world size,
put the grip near the origin, decimate, resize + recompress the textures
(<= 1024 px, JPEG inside the .glb) and export one compact .glb (no Draco).
The attachment points are measured from the final geometry. Output:
  tools/blender/glb/<id>.glb          intermediate files
  src/game/weapons_glb.js             base64 glb bytes + points per id
  tools/blender/preview/glb_<id>*.png side / first-person previews

Environment switches:  WEAPONS=m1911,ksr29   NO_PREVIEW=1   JPEG_Q=80
"""
import base64
import json
import math
import os
import sys
import time

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SRC_DIR = os.environ.get("WEAPON_SRC", os.path.dirname(ROOT))
GLB_DIR = os.path.join(HERE, "glb")
PREVIEW_DIR = os.path.join(HERE, "preview")
TMP_DIR = os.path.join(HERE, "glb", "tex")
OUT_JS = os.path.join(ROOT, "src", "game", "weapons_glb.js")
JPEG_Q = int(os.environ.get("JPEG_Q", "80"))
for d in (GLB_DIR, PREVIEW_DIR, TMP_DIR):
    os.makedirs(d, exist_ok=True)

# Blender axes while building: X right, Y forward (the muzzle), Z up.
# glTF export (+Y up) turns that into the game's X right, Y up, -Z forward.


def g(v):
    """Blender (x right, y forward, z up) -> game point [x, y up, z back], in metres, rounded."""
    return [round(float(v[0]), 4), round(float(v[2]), 4), round(-float(v[1]), 4)]


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_glb(name):
    bpy.ops.import_scene.gltf(filepath=os.path.join(SRC_DIR, name))
    return {o.name: o for o in bpy.data.objects if o.type == "MESH"}


def bake_world(o):
    mw = o.matrix_world.copy()
    o.parent = None
    if o.data.users > 1:
        o.data = o.data.copy()
    o.data.transform(mw)
    o.matrix_world = Matrix.Identity(4)


def join(objs):
    for o in objs:
        bake_world(o)
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    with bpy.context.temp_override(active_object=objs[0], selected_editable_objects=objs, selected_objects=objs):
        bpy.ops.object.join()
    return objs[0]


def verts(o):
    n = len(o.data.vertices)
    a = np.empty(n * 3, dtype=np.float64)
    o.data.vertices.foreach_get("co", a)
    return a.reshape(n, 3)


def transform(o, m):
    o.data.transform(m)
    o.data.update()


def bbox(o):
    v = verts(o)
    return v.min(0), v.max(0)


def keep_first_uv(o):
    uvs = o.data.uv_layers
    while len(uvs) > 1:
        uvs.remove(uvs[len(uvs) - 1])


def tri_count(o):
    o.data.calc_loop_triangles()
    return len(o.data.loop_triangles)


def decimate(o, target, delimit=None):
    """Collapse-decimate to roughly `target` triangles (UVs kept), then re-shade."""
    bpy.context.view_layer.objects.active = o
    for _ in range(4):
        cur = tri_count(o)
        if cur <= target:
            break
        md = o.modifiers.new("dec", "DECIMATE")
        md.decimate_type = "COLLAPSE"
        md.ratio = max(0.02, min(1.0, target / cur * (0.97 if _ == 0 else 1.0)))
        md.use_collapse_triangulate = True
        if delimit:
            md.delimit = delimit
        with bpy.context.temp_override(object=o, active_object=o):
            bpy.ops.object.modifier_apply(modifier=md.name)
    return tri_count(o)


def shade(o, angle=40.0):
    """Smooth shading with hard edges past `angle` degrees; no custom normals."""
    me = o.data
    try:
        with bpy.context.temp_override(object=o, active_object=o):
            bpy.ops.mesh.customdata_custom_splitnormals_clear()
    except Exception:
        pass
    bm = bmesh.new()
    bm.from_mesh(me)
    for f in bm.faces:
        f.smooth = True
    lim = math.radians(angle)
    for e in bm.edges:
        e.smooth = True
        if len(e.link_faces) == 2:
            try:
                if e.calc_face_angle() > lim:
                    e.smooth = False
            except ValueError:
                pass
    bm.to_mesh(me)
    bm.free()
    me.update()


# ---------------------------------------------------------------------------
# textures
# ---------------------------------------------------------------------------
def read_pixels(img, srgb):
    """float32 array (h, w, 4), rows bottom to top, scene-linear for sRGB images."""
    img.colorspace_settings.name = "sRGB" if srgb else "Non-Color"
    w, h = img.size
    a = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(h, w, 4)


def shrink(a, w, h):
    """Box-filter / bilinear resize of an (h0, w0, 4) array to (h, w, 4)."""
    h0, w0 = a.shape[:2]
    if (h0, w0) == (h, w):
        return a
    if h0 % h == 0 and w0 % w == 0:
        return a.reshape(h, h0 // h, w, w0 // w, 4).mean(axis=(1, 3))
    # two-step: integer box filter to the nearest multiple, then linear resample
    fy, fx = max(1, h0 // h), max(1, w0 // w)
    if fy > 1 or fx > 1:
        a = a[: (h0 // fy) * fy, : (w0 // fx) * fx].reshape(h0 // fy, fy, w0 // fx, fx, 4).mean(axis=(1, 3))
        h0, w0 = a.shape[:2]
    ys = (np.arange(h) + 0.5) * h0 / h - 0.5
    xs = (np.arange(w) + 0.5) * w0 / w - 0.5
    y0 = np.clip(np.floor(ys).astype(int), 0, h0 - 1); y1 = np.clip(y0 + 1, 0, h0 - 1); fy_ = (ys - np.floor(ys))[:, None, None]
    x0 = np.clip(np.floor(xs).astype(int), 0, w0 - 1); x1 = np.clip(x0 + 1, 0, w0 - 1); fx_ = (xs - np.floor(xs))[None, :, None]
    top = a[y0][:, x0] * (1 - fx_) + a[y0][:, x1] * fx_
    bot = a[y1][:, x0] * (1 - fx_) + a[y1][:, x1] * fx_
    return top * (1 - fy_) + bot * fy_


def save_image(arr, name, srgb, quality=None):
    h, w = arr.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=False, float_buffer=False)
    img.colorspace_settings.name = "sRGB" if srgb else "Non-Color"
    out = np.clip(arr, 0, 1).astype(np.float32).copy()
    out[..., 3] = 1.0
    img.pixels.foreach_set(out.ravel())
    img.update()
    path = os.path.join(TMP_DIR, name + ".jpg")
    img.filepath_raw = path
    img.file_format = "JPEG"
    img.save(quality=quality or JPEG_Q)
    img.source = "FILE"
    img.filepath = path
    img.reload()
    return img


def make_material(name, base, normal, orm=None, metal=0.5, rough=0.5, emissive=None):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        if n.type != "OUTPUT_MATERIAL":
            nt.nodes.remove(n)
    out = [n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"][0]
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    tb = nt.nodes.new("ShaderNodeTexImage"); tb.image = base
    nt.links.new(tb.outputs["Color"], bsdf.inputs["Base Color"])
    tn = nt.nodes.new("ShaderNodeTexImage"); tn.image = normal
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(tn.outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    if orm is not None:
        to = nt.nodes.new("ShaderNodeTexImage"); to.image = orm
        sp = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(to.outputs["Color"], sp.inputs["Color"])
        nt.links.new(sp.outputs["Green"], bsdf.inputs["Roughness"])
        nt.links.new(sp.outputs["Blue"], bsdf.inputs["Metallic"])
    else:
        bsdf.inputs["Metallic"].default_value = metal
        bsdf.inputs["Roughness"].default_value = rough
    return mat


def export_glb(o, path, quality):
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    kw = dict(filepath=path, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
              export_image_format="JPEG", export_jpeg_quality=quality, export_materials="EXPORT",
              export_cameras=False, export_lights=False, export_normals=True, export_texcoords=True,
              export_tangents=False, export_draco_mesh_compression_enable=False)
    try:
        bpy.ops.export_scene.gltf(export_vertex_color="NONE", **kw)
    except TypeError:
        bpy.ops.export_scene.gltf(**kw)


def principal_axes(v):
    c = np.cov((v - v.mean(0)).T)
    w, e = np.linalg.eigh(c)
    return e[:, ::-1].T, w[::-1]   # rows: axes sorted by variance, descending


def orient(o, right, fwd, up, scale, shift=(0, 0, 0)):
    """Rotate so the given unit vectors become X (right), Y (forward), Z (up); scale; translate."""
    r = np.array([right, fwd, up], dtype=np.float64)
    m = Matrix([list(r[0]) + [0], list(r[1]) + [0], list(r[2]) + [0], [0, 0, 0, 1]])
    transform(o, Matrix.Scale(scale, 4) @ m)
    if any(shift):
        transform(o, Matrix.Translation(Vector(shift)))


def slice_stats(v, axis, lo, hi):
    s = v[(v[:, axis] >= lo) & (v[:, axis] <= hi)]
    return s


# ---------------------------------------------------------------------------
# per weapon builds. Each returns (object, points in game space, source info)
# ---------------------------------------------------------------------------
def image_of(mat, tex_name):
    for n in mat.node_tree.nodes:
        if n.type == "TEX_IMAGE" and n.image and n.image.name.split(".")[0] == tex_name:
            return n.image
    raise KeyError(tex_name)


def build_m1911():
    objs = import_glb("hand gun.glb")
    pistol, mag = objs["colt001_Pistol_0"], objs["mag001_Magazine_0"]
    for n, o in list(objs.items()):
        if o not in (pistol, mag):
            bpy.data.objects.remove(o)
    mat_p, mat_m = pistol.active_material, mag.active_material
    for o in (pistol, mag):
        bake_world(o)
    both = np.vstack([verts(pistol), verts(mag)])
    axes, _ = principal_axes(both)
    mc = verts(mag).mean(0) - both.mean(0)
    f = axes[0] * (-1 if np.dot(mc, axes[0]) > 0 else 1)          # muzzle direction: the magazine sits behind the middle
    # height axis: the one of the two remaining that is taller (grip hangs down) -> up points away from the magazine
    ext = [np.ptp(both @ axes[i]) for i in (1, 2)]
    u = axes[1 + int(np.argmax(ext))]
    u = u * (-1 if np.dot(mc, u) > 0 else 1)
    u = u - f * np.dot(u, f); u /= np.linalg.norm(u)
    r = np.cross(f, u)
    length = np.ptp(both @ f)
    scale = 0.216 / length
    print(f"m1911: raw length {length:.5f} -> scale {scale:.2f}")
    for o in (pistol, mag):
        orient(o, r, f, u, scale)
    # the grip leans, so the principal axis is not the slide's: level the slide's top edge
    vp, vm = verts(pistol), verts(mag)
    allv = np.vstack([vp, vm])
    lo, hi = allv.min(0), allv.max(0)
    xs, ts = [], []
    for y0 in np.arange(lo[1] + 0.35 * 0.216, lo[1] + 0.85 * 0.216, 0.004):
        s_ = allv[(allv[:, 1] >= y0) & (allv[:, 1] < y0 + 0.004) & (np.abs(allv[:, 0]) < 0.006)]
        if len(s_):
            xs.append(y0 + 0.002); ts.append(s_[:, 2].max())
    slope = np.polyfit(xs, ts, 1)[0]
    th = -math.atan(slope)
    print(f"  slide slope {math.degrees(-th):.1f} deg, levelling")
    rot = Matrix.Rotation(th, 4, "X")
    for o in (pistol, mag):
        transform(o, rot)
    vp, vm = verts(pistol), verts(mag)
    allv = np.vstack([vp, vm])
    xc = (allv[:, 0].min() + allv[:, 0].max()) / 2
    for o in (pistol, mag):
        transform(o, Matrix.Translation(Vector((-xc, 0, 0))))
    vp, vm = verts(pistol), verts(mag)
    allv = np.vstack([vp, vm])
    # --- measure (Blender frame: x right, y forward, z up) ---
    lo, hi = allv.min(0), allv.max(0)
    front = allv[allv[:, 1] > hi[1] - 0.004]
    bore_z = (front[:, 2].min() + front[:, 2].max()) / 2
    muzzle = np.array([0.0, hi[1], bore_z])
    mag_lo, mag_hi = vm.min(0), vm.max(0)
    grip = np.array([0.0, vm[:, 1].mean(), mag_lo[2] + 0.4 * (mag_hi[2] - mag_lo[2])])
    magp = np.array([0.0, vm[:, 1].mean(), mag_lo[2] + 0.012])
    sg = allv[(allv[:, 1] > lo[1] + 0.044) & (allv[:, 1] < lo[1] + 0.056) & (np.abs(allv[:, 0]) < 0.004)]   # G.I. rear sight (the hammer sits further back)
    k = np.argmax(sg[:, 2])
    sight = np.array([0.0, sg[k, 1], sg[k, 2]])
    mid = allv[(allv[:, 1] > lo[1] + 0.45 * length * scale) & (allv[:, 1] < lo[1] + 0.55 * length * scale) & (allv[:, 2] > bore_z - 0.004)]
    eject = np.array([mid[:, 0].max() * 0.9, bore_z + 0.008, lo[1] + 0.5 * length * scale])
    pts = {"muzzle": muzzle, "right": grip, "left": grip + np.array([0, -0.004, -0.012]), "mag": magp, "sight": sight, "eject": eject}
    # grip centre to its conventional place near the origin (the M9's)
    target = np.array([0.0, -0.03, -0.04])     # game (0, -0.04, 0.03)
    shift = target - grip
    for o in (pistol, mag):
        transform(o, Matrix.Translation(Vector(shift)))
    pts = {k: v + shift for k, v in pts.items()}

    # --- atlas: pistol on the upper 3/4, magazine on the lower 1/4 of one 1024^2 texture ---
    W = 1024
    base = np.zeros((W, W, 4), np.float32); orm = np.zeros((W, W, 4), np.float32); nrm = np.zeros((W, W, 4), np.float32)
    base[..., 3] = orm[..., 3] = nrm[..., 3] = 1
    for mat, o, y0, hh in ((mat_p, pistol, 256, 768), (mat_m, mag, 0, 256)):
        for tex, dst, srgb in (("Image_4" if mat is mat_p else "Image_7", base, True),
                               ("Image_5" if mat is mat_p else "Image_8", orm, False),
                               ("Image_6" if mat is mat_p else "Image_9", nrm, False)):
            im = image_of(mat, tex)
            dst[y0:y0 + hh] = shrink(read_pixels(im, srgb), W, hh)
        uv = o.data.uv_layers[0].data
        a = np.empty(len(uv) * 2, np.float32); uv.foreach_get("uv", a); a = a.reshape(-1, 2)
        print(f"  uv range {o.name}: u {a[:,0].min():.3f}..{a[:,0].max():.3f} v {a[:,1].min():.3f}..{a[:,1].max():.3f}")
        # tiled UVs (the magazine runs to u = 2): shift every face back into 0..1
        npoly = len(o.data.polygons)
        ls = np.empty(npoly, np.int32); le = np.empty(npoly, np.int32)
        o.data.polygons.foreach_get("loop_start", ls); o.data.polygons.foreach_get("loop_total", le)
        bad = 0
        for st, n in zip(ls, le):
            seg = a[st:st + n, 0]
            off = max(0.0, math.floor(seg.mean()))
            if np.ptp(seg) > 0.5:
                bad += 1
            a[st:st + n, 0] = seg - off
        print(f"  faces with u spread > 0.5: {bad}")
        a[:, 0] = np.clip(a[:, 0], 0, 1)
        a[:, 1] = y0 / W + a[:, 1] * (hh / W)
        uv.foreach_set("uv", a.ravel())
    keep_first_uv(pistol); keep_first_uv(mag)
    ob = join([pistol, mag])
    ob.name = "m1911"
    ob.data.materials.clear()
    mat = make_material("m1911", save_image(base, "m1911_base", True, 74), save_image(nrm, "m1911_n", False, 80), save_image(shrink(orm, 512, 512), "m1911_orm", False, 72))
    ob.data.materials.append(mat)
    tris = decimate(ob, 4800)
    shade(ob, 38)
    return ob, {k: g(v) for k, v in pts.items()}


def build_ksr29():
    objs = import_glb("sniper.glb")
    o = list(objs.values())[0]
    bake_world(o)
    keep_first_uv(o)
    mat = o.active_material
    v = verts(o)
    # source: muzzle toward +X, up +Z (checked on renders); rotate so the muzzle faces +Y
    scale = 1.2 / np.ptp(v[:, 0])
    orient(o, (0, -1, 0), (1, 0, 0), (0, 0, 1), scale)
    v = verts(o)
    lo, hi = v.min(0), v.max(0)
    print(f"ksr29: scale {scale:.4f}, size {hi - lo}")
    # barrel: forward of the receiver, thin and centred on the bore
    bar = v[(v[:, 1] > hi[1] - 0.30) & (v[:, 1] < hi[1] - 0.12) & (np.abs(v[:, 0]) < 0.02)]
    bore = (bar[:, 2].min() + bar[:, 2].max()) / 2
    muzzle = np.array([0.0, hi[1], bore])
    # scope: tube sitting on top of the receiver; ocular = rearmost ring above the rail
    sc = v[v[:, 2] > bore + 0.01]
    rear_y = sc[:, 1].min()
    ring = sc[sc[:, 1] < rear_y + 0.015]
    sight = np.array([0.0, rear_y - 0.05, (ring[:, 2].min() + ring[:, 2].max()) / 2])
    # (the sight point sits 5 cm behind the ocular: the hip pose then keeps the big scope out of the face; FP_EYE compensates)
    scope_front = sc[:, 1].max()
    print(f"  bore {bore:.3f}  scope y {rear_y:.3f}..{scope_front:.3f} axis {sight[2]:.3f}")
    # pistol grip (read off the side view): ~0.23 m ahead of the butt-plate end, a hand's width below the receiver
    gr = v[(np.abs(v[:, 0]) < 0.02) & (v[:, 1] > -0.30) & (v[:, 1] < -0.17) & (v[:, 2] < bore - 0.10)]
    grip = np.array([0.0, float(gr[:, 1].mean()), (gr[:, 2].min() + bore - 0.10) / 2])
    magp = np.array([0.0, -0.09, bore - 0.15])
    left = np.array([0.0, grip[1] + 0.31, bore - 0.078])     # fore-end ahead of the magazine
    print(f"  grip {grip}  left {left}")
    eject = np.array([0.03, sight[1] + 0.22, bore - 0.03])
    pts = {"muzzle": muzzle, "right": grip, "left": left, "mag": magp, "sight": sight, "eject": eject}
    shift = np.array([0.0, -0.06, -0.04]) - grip
    transform(o, Matrix.Translation(Vector(shift)))
    pts = {k: p + shift for k, p in pts.items()}
    base = shrink(read_pixels(image_of(mat, "Image_0"), True), 1024, 1024)
    nrm = shrink(read_pixels(image_of(mat, "Image_1"), False), 1024, 1024)
    o.data.materials.clear()
    o.data.materials.append(make_material("ksr29", save_image(base, "ksr29_base", True, 74), save_image(shrink(nrm, 512, 512), "ksr29_n", False, 82), None, metal=0.45, rough=0.5))
    o.name = "ksr29"
    decimate(o, 8000)
    shade(o, 35)
    return o, {k: g(p) for k, p in pts.items()}


def build_sword():
    objs = import_glb("knife.glb")
    o = list(objs.values())[0]
    bake_world(o)
    keep_first_uv(o)
    mat = o.active_material
    v = verts(o)
    # source: blade along +Z, flat width along Y, thin along X; guard = the widest slice
    zs = np.linspace(v[:, 2].min(), v[:, 2].max(), 60)
    wid = [np.ptp(v[(v[:, 2] >= a) & (v[:, 2] < b), 1]) if ((v[:, 2] >= a) & (v[:, 2] < b)).any() else 0 for a, b in zip(zs[:-1], zs[1:])]
    gz = zs[int(np.argmax(wid))]
    print(f"sword: length {np.ptp(v[:,2]):.1f}, guard at z={gz:.1f} (of {v[:,2].min():.1f}..{v[:,2].max():.1f})")
    scale = 0.95 / np.ptp(v[:, 2])
    orient(o, (1, 0, 0), (0, 0, 1), (0, -1, 0), scale)
    v = verts(o)
    lo, hi = v.min(0), v.max(0)
    guard = (gz - (-0.0)) * scale  # placeholder, recomputed below
    ys = v[:, 1]
    # grip centre: halfway between the pommel and the guard
    gy = (gz - 0) * 0
    wid2 = []
    yy = np.linspace(lo[1], hi[1], 60)
    for a, b in zip(yy[:-1], yy[1:]):
        s = v[(ys >= a) & (ys < b)]
        wid2.append(np.ptp(s[:, 2]) if len(s) else 0)
    gy = yy[int(np.argmax(wid2))]
    grip_y = (lo[1] + gy) / 2
    shift = np.array([0.0, -grip_y, -(lo[2] + hi[2]) / 2])
    transform(o, Matrix.Translation(Vector(shift)))
    v = verts(o)
    lo, hi = v.min(0), v.max(0)
    print(f"  pommel {lo[1]:.3f} guard {gy + shift[1]:.3f} tip {hi[1]:.3f}")
    pts = {"muzzle": np.array([0.0, hi[1], 0.0])}
    base = shrink(read_pixels(image_of(mat, "Image_0"), True), 512, 512)
    orm = shrink(read_pixels(image_of(mat, "Image_1"), False), 512, 512)
    nrm = shrink(read_pixels(image_of(mat, "Image_3"), False), 512, 512)
    o.data.materials.clear()
    o.data.materials.append(make_material("sword", save_image(base, "sword_base", True, 78), save_image(nrm, "sword_n", False, 80), save_image(orm, "sword_orm", False, 72)))
    o.name = "sword"
    decimate(o, 2900)
    shade(o, 40)
    return o, {k: g(p) for k, p in pts.items()}


def build_m4():
    objs = import_glb("assault rifle.glb")
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    for o in meshes:
        bake_world(o)
        keep_first_uv(o)

    body_objs = [bpy.data.objects[n] for n in ["Object_4", "Object_6", "Object_11", "Object_9", "Object_10", "Object_5"] if n in bpy.data.objects]
    acc_objs = [bpy.data.objects["Object_8"]]
    mag_objs = [bpy.data.objects["Object_7"]]
    sight_objs = [bpy.data.objects["Object_12"]]

    mat_body = bpy.data.objects["Object_4"].active_material
    mat_acc = bpy.data.objects["Object_8"].active_material
    mat_mag = bpy.data.objects["Object_7"].active_material
    mat_sight = bpy.data.objects["Object_12"].active_material

    im_body_base = image_of(mat_body, "Image_0")
    im_body_n = image_of(mat_body, "Image_1")
    im_acc_base = image_of(mat_acc, "Image_4")
    im_acc_n = image_of(mat_acc, "Image_5")
    im_mag_base = image_of(mat_mag, "Image_2")
    im_mag_n = image_of(mat_mag, "Image_3")
    im_sight_base = image_of(mat_sight, "Image_6")
    im_sight_n = image_of(mat_sight, "Image_7")

    W = 1024
    base_atlas = np.zeros((W, W, 4), np.float32)
    nrm_atlas = np.zeros((W, W, 4), np.float32)
    base_atlas[..., 3] = nrm_atlas[..., 3] = 1.0

    base_atlas[512:1024, 0:512] = shrink(read_pixels(im_body_base, True), 512, 512)
    nrm_atlas[512:1024, 0:512] = shrink(read_pixels(im_body_n, False), 512, 512)
    base_atlas[512:1024, 512:1024] = shrink(read_pixels(im_acc_base, True), 512, 512)
    nrm_atlas[512:1024, 512:1024] = shrink(read_pixels(im_acc_n, False), 512, 512)
    base_atlas[0:512, 0:512] = shrink(read_pixels(im_mag_base, True), 512, 512)
    nrm_atlas[0:512, 0:512] = shrink(read_pixels(im_mag_n, False), 512, 512)
    base_atlas[0:512, 512:1024] = shrink(read_pixels(im_sight_base, True), 512, 512)
    nrm_atlas[0:512, 512:1024] = shrink(read_pixels(im_sight_n, False), 512, 512)

    def remap_uv(objs, u_off, v_off, u_scale, v_scale):
        for o in objs:
            uv = o.data.uv_layers[0].data
            a = np.empty(len(uv) * 2, np.float32)
            uv.foreach_get("uv", a)
            a = a.reshape(-1, 2)
            a[:, 0] = np.clip(a[:, 0], 0, 1) * u_scale + u_off
            a[:, 1] = np.clip(a[:, 1], 0, 1) * v_scale + v_off
            uv.foreach_set("uv", a.ravel())

    remap_uv(body_objs, 0.0, 0.5, 0.5, 0.5)
    remap_uv(acc_objs, 0.5, 0.5, 0.5, 0.5)
    remap_uv(mag_objs, 0.0, 0.0, 0.5, 0.5)
    remap_uv(sight_objs, 0.5, 0.0, 0.5, 0.5)

    all_objs = body_objs + acc_objs + mag_objs + sight_objs
    bpy.ops.object.select_all(action="DESELECT")
    for o in all_objs: o.select_set(True)
    bpy.context.view_layer.objects.active = all_objs[0]
    with bpy.context.temp_override(active_object=all_objs[0], selected_editable_objects=all_objs, selected_objects=all_objs):
        bpy.ops.object.join()
    ob = all_objs[0]
    ob.name = "m4"

    v = verts(ob)
    length = np.ptp(v[:, 0])
    scale = 0.80 / length

    orient(ob, (0, -1, 0), (1, 0, 0), (0, 0, 1), scale)
    v = verts(ob)

    lo, hi = v.min(0), v.max(0)
    muzzle_pts = v[v[:, 1] > hi[1] - 0.01]
    bore_z = (muzzle_pts[:, 2].min() + muzzle_pts[:, 2].max()) / 2
    muzzle = np.array([0.0, hi[1], bore_z])

    grip_pts = v[(v[:, 1] > -0.13) & (v[:, 1] < -0.05) & (v[:, 2] < bore_z - 0.05)]
    grip = np.array([0.0, float(grip_pts[:, 1].mean()), float(grip_pts[:, 2].mean())])

    left_pts = v[(v[:, 1] > 0.18) & (v[:, 1] < 0.28) & (v[:, 2] < bore_z + 0.02) & (v[:, 2] > bore_z - 0.05)]
    left = np.array([0.0, float(left_pts[:, 1].mean()), bore_z - 0.015])
    magp = np.array([0.0, 0.08, bore_z - 0.08])
    sight = np.array([0.0, -0.02, float(v[(v[:, 1] > -0.08) & (v[:, 1] < 0.05)][:, 2].max())])
    eject = np.array([0.024, 0.01, bore_z + 0.005])

    pts = {"muzzle": muzzle, "right": grip, "left": left, "mag": magp, "sight": sight, "eject": eject}

    target = np.array([0.0, -0.03, -0.035])
    shift = target - grip
    transform(ob, Matrix.Translation(Vector(shift)))
    pts = {k: v + shift for k, v in pts.items()}

    ob.data.materials.clear()
    img_base = save_image(base_atlas, "m4_base", True, 78)
    img_nrm = save_image(shrink(nrm_atlas, 1024, 1024), "m4_n", False, 80)
    mat = make_material("m4", img_base, img_nrm, None, metal=0.48, rough=0.38)
    ob.data.materials.append(mat)

    tris = decimate(ob, 7800)
    shade(ob, 38)
    return ob, {k: g(v) for k, v in pts.items()}


JPEG_QUALITY = {"m1911": 76, "ksr29": 68, "sword": 76, "m4": 78}   # the exporter re-encodes the textures at this quality
BUILDS = {"m1911": build_m1911, "ksr29": build_ksr29, "sword": build_sword, "m4": build_m4}


# ---------------------------------------------------------------------------
# previews: re-import the exported .glb and render it
# ---------------------------------------------------------------------------
def render_previews(wid, glb_path, pts):
    reset()
    bpy.ops.import_scene.gltf(filepath=glb_path)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_WORKBENCH"
    sh = sc.display.shading
    sh.light = "STUDIO"; sh.color_type = "TEXTURE"; sh.show_cavity = False
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = "PNG"
    sc.world = bpy.data.worlds.new("w"); sc.world.color = (0.32, 0.34, 0.38)
    colours = {"muzzle": (1, 0.1, 0.1), "right": (0.1, 1, 0.1), "left": (0.1, 0.4, 1), "mag": (1, 1, 0.1), "sight": (1, 0.2, 1), "eject": (0.1, 1, 1)}
    for k, p in pts.items():
        e = bpy.data.objects.new("m_" + k, None)
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.004 if wid == "m1911" else 0.007, location=(p[0], -p[2], p[1]))
        m = bpy.context.active_object
        mt = bpy.data.materials.new(k); mt.diffuse_color = (*colours.get(k, (1, 1, 1)), 1); m.data.materials.append(mt)
    allv = np.vstack([verts_world(o) for o in meshes])
    c = (allv.min(0) + allv.max(0)) / 2
    size = float(np.ptp(allv, axis=0).max())
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    sc.collection.objects.link(cam); sc.camera = cam
    cam.data.clip_start = 0.001; cam.data.clip_end = 100
    # side view (muzzle to the right)
    cam.data.type = "ORTHO"; cam.data.ortho_scale = size * 1.15
    sc.render.resolution_x, sc.render.resolution_y = 1400, 700
    cam.location = (c[0] + 5, c[1], c[2]); cam.rotation_euler = (math.radians(90), 0, math.radians(90))
    sc.render.filepath = os.path.join(PREVIEW_DIR, f"glb_{wid}.png")
    bpy.ops.render.render(write_still=True)
    # three-quarter view
    cam.data.type = "PERSP"; cam.data.lens = 50
    d = size * 1.5
    cam.location = (c[0] + d * 0.7, c[1] - d * 0.55, c[2] + d * 0.3)
    cam.rotation_euler = (Vector(c) - Vector(cam.location)).to_track_quat("-Z", "Y").to_euler()
    sc.render.resolution_x, sc.render.resolution_y = 1000, 700
    sc.render.filepath = os.path.join(PREVIEW_DIR, f"glb_{wid}_34.png")
    bpy.ops.render.render(write_still=True)
    # first-person style: behind the sights, looking down the barrel
    if "sight" in pts:
        s = pts["sight"]
        cam.data.lens = 40
        back = 0.32 if wid == "m1911" else 0.4
        cam.location = (s[0] + 0.0, -s[2] + back, s[1] + 0.045)
        cam.rotation_euler = (math.radians(87), 0, math.radians(180))
        sc.render.resolution_x, sc.render.resolution_y = 900, 600
        sc.render.filepath = os.path.join(PREVIEW_DIR, f"glb_{wid}_fp.png")
        bpy.ops.render.render(write_still=True)


def verts_world(o):
    n = len(o.data.vertices)
    a = np.empty(n * 3); o.data.vertices.foreach_get("co", a)
    a = a.reshape(n, 3)
    m = np.array(o.matrix_world)
    return a @ m[:3, :3].T + m[:3, 3]


def main():
    want = [w for w in os.environ.get("WEAPONS", ",".join(BUILDS)).split(",") if w]
    store = os.path.join(GLB_DIR, "points.json")
    allpts = json.load(open(store)) if os.path.exists(store) else {}
    for wid in want:
        t0 = time.time()
        reset()
        o, pts = BUILDS[wid]()
        path = os.path.join(GLB_DIR, wid + ".glb")
        export_glb(o, path, JPEG_QUALITY.get(wid, 75))
        tris = tri_count(o)
        print(f"== {wid}: {tris} tris, {os.path.getsize(path) / 1024:.0f} KB glb, points {json.dumps(pts)}  ({time.time() - t0:.0f}s)")
        allpts[wid] = pts
        json.dump(allpts, open(store, "w"), indent=1)
        if not os.environ.get("NO_PREVIEW"):
            render_previews(wid, path, pts)
    # the game module
    lines = ["// GENERATED by tools/blender/import_weapons.py -- do not edit.",
             "// Weapon models by third parties (see docs/CREDITS.md): Colt M1911 by lokeig, KSR 29 Sniper by 3DHaupt (both CC-BY-NC-4.0),",
             "// Magic sword by Biomoloko (CC-BY-4.0). Modified: decimated, textures re-baked / resized.",
             "// glb bytes (base64) and attachment points (game space, metres) per weapon id.",
             "export const WEAPON_GLB = {"]
    for wid in BUILDS:
        p = os.path.join(GLB_DIR, wid + ".glb")
        if wid not in allpts or not os.path.exists(p):
            continue
        b64 = base64.b64encode(open(p, "rb").read()).decode()
        lines.append(f"  {wid}: {{\n    points: {json.dumps(allpts[wid])},\n    glb: '{b64}',\n  }},")
    lines.append("};")
    open(OUT_JS, "w").write("\n".join(lines) + "\n")
    print("wrote", OUT_JS, os.path.getsize(OUT_JS) // 1024, "KB")


if __name__ == "__main__":
    main()
