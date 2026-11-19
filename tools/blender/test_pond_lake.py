"""Test script: Boolean cut pond + smooth 3D Koi fish + expansive lake water."""
import os
import math
import bpy
import numpy as np
from mathutils import Vector

OUT_DIR = os.path.join(os.path.dirname(__file__), "preview")
os.makedirs(OUT_DIR, exist_ok=True)
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
GLB_PATH = os.path.join(ROOT, "tools", "blender", "glb", "lodge.glb")

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB_PATH)
sc = bpy.context.scene

sc.render.engine = 'CYCLES'
sc.cycles.device = 'CPU'
sc.cycles.samples = 32
sc.cycles.preview_samples = 8
sc.cycles.use_adaptive_sampling = True
sc.render.film_transparent = False

sc.view_settings.view_transform = "Filmic" if "Filmic" in [v.identifier for v in sc.view_settings.bl_rna.properties["view_transform"].enum_items] else "Standard"
sc.view_settings.look = "Medium High Contrast"

# Setup Sun & Sky
world = bpy.data.worlds.new("LodgeWorld")
sc.world = world
world.use_nodes = True
wnt = world.node_tree
wnt.nodes.clear()
w_out = wnt.nodes.new("ShaderNodeOutputWorld")
w_bg = wnt.nodes.new("ShaderNodeBackground")

try:
    sky_node = wnt.nodes.new("ShaderNodeTexSky")
    for st in ("NISHITA", "HOSEK_WILKIE", "PREETHAM"):
        try:
            sky_node.sky_type = st
            break
        except Exception:
            continue
    sky_node.sun_elevation = math.radians(48.0)
    sky_node.sun_rotation = math.radians(138.0)
    sky_node.altitude = 600.0
    sky_node.air_density = 1.0
    wnt.links.new(sky_node.outputs[0], w_bg.inputs[0])
except Exception:
    w_bg.inputs[0].default_value = (0.5, 0.72, 0.98, 1.0)

w_bg.inputs[1].default_value = 1.0
wnt.links.new(w_bg.outputs[0], w_out.inputs[0])

# Direct Sun Light
sun_data = bpy.data.lights.new("Sun", "SUN")
sun_data.energy = 5.0
sun_data.color = (1.0, 0.95, 0.86)
sun_data.angle = math.radians(1.0)
sun_obj = bpy.data.objects.new("Sun", sun_data)
sc.collection.objects.link(sun_obj)
sun_dir = Vector((-0.5003, -0.4803, 0.7204)).normalized()
sun_obj.rotation_euler = (-sun_dir).to_track_quat("-Z", "Y").to_euler()

# -----------------------------------------------------------------------------
# 1. EXPANSIVE REALISTIC LAKE WATER (Behind the Lodge: Y_blender >= 42 to 300)
# -----------------------------------------------------------------------------
WATER_Y = -1.2
m_lake = bpy.data.meshes.new("LakeWaterMesh")
LAKE_NX, LAKE_NY = 36, 36
lake_verts = []
lake_faces = []
xs = np.linspace(-300, 300, LAKE_NX)
ys = np.linspace(42, 300, LAKE_NY)
for yi in range(LAKE_NY):
    for xi in range(LAKE_NX):
        wv = 0.02 * math.sin(xs[xi] * 0.18 + ys[yi] * 0.14)
        lake_verts.append((float(xs[xi]), float(ys[yi]), WATER_Y + wv))

for yi in range(LAKE_NY - 1):
    for xi in range(LAKE_NX - 1):
        i0 = yi * LAKE_NX + xi
        i1 = i0 + 1
        i2 = (yi + 1) * LAKE_NX + xi + 1
        i3 = (yi + 1) * LAKE_NX + xi
        lake_faces.append((i0, i1, i2, i3))

m_lake.from_pydata(lake_verts, [], lake_faces)
o_lake = bpy.data.objects.new("LakeWater", m_lake)
sc.collection.objects.link(o_lake)

mat_lake = bpy.data.materials.new("RealisticLakeWater")
mat_lake.use_nodes = True
lt = mat_lake.node_tree
lbsdf = lt.nodes.get("Principled BSDF")
if lbsdf:
    lbsdf.inputs["Base Color"].default_value = (0.03, 0.16, 0.22, 1.0)
    lbsdf.inputs["Roughness"].default_value = 0.03
    lbsdf.inputs["IOR"].default_value = 1.333
    if "Transmission Weight" in lbsdf.inputs:
        lbsdf.inputs["Transmission Weight"].default_value = 0.85
    elif "Transmission" in lbsdf.inputs:
        lbsdf.inputs["Transmission"].default_value = 0.85

tex_noise = lt.nodes.new("ShaderNodeTexNoise")
tex_noise.inputs["Scale"].default_value = 22.0
tex_noise.inputs["Detail"].default_value = 4.0
bump = lt.nodes.new("ShaderNodeBump")
bump.inputs["Strength"].default_value = 0.15
bump.inputs["Distance"].default_value = 0.08
lt.links.new(tex_noise.outputs["Fac"], bump.inputs["Height"])
lt.links.new(bump.outputs["Normal"], lbsdf.inputs["Normal"])
m_lake.materials.append(mat_lake)

# -----------------------------------------------------------------------------
# 2. BOOLEAN CUT HOLE IN TERRAIN FOR KOI POND
# -----------------------------------------------------------------------------
POND_CX = -18.5
POND_CY = -20.0
POND_GROUND_Z = 0.06
POND_DEPTH = 1.52 # ~5 feet
POND_WATER_Z = POND_GROUND_Z - 0.05

def pond_r(th):
    return 3.9 + 0.58 * math.sin(2 * th + 0.5) + 0.35 * math.cos(3 * th - 0.7) + 0.22 * math.sin(5 * th + 1.1)

terrain_obj = bpy.data.objects.get("terrain")
N_CUT = 40
c_verts = [(POND_CX, POND_CY, -3.0), (POND_CX, POND_CY, 3.0)]
c_faces = []
for i in range(N_CUT):
    th = (i / N_CUT) * math.pi * 2
    r = pond_r(th) * 0.98
    c_verts.append((POND_CX + math.sin(th) * r, POND_CY + math.cos(th) * r, -3.0))
    c_verts.append((POND_CX + math.sin(th) * r, POND_CY + math.cos(th) * r, 3.0))

for i in range(N_CUT):
    nxt = (i + 1) % N_CUT
    b0 = 2 + i * 2
    t0 = b0 + 1
    b1 = 2 + nxt * 2
    t1 = b1 + 1
    c_faces.append((b0, b1, t1, t0))
    c_faces.append((0, b0, b1))
    c_faces.append((1, t1, t0))

m_cut = bpy.data.meshes.new("PondCutter")
m_cut.from_pydata(c_verts, [], c_faces)
o_cut = bpy.data.objects.new("PondCutter", m_cut)
sc.collection.objects.link(o_cut)

mod = terrain_obj.modifiers.new("PondHole", 'BOOLEAN')
mod.object = o_cut
mod.operation = 'DIFFERENCE'
mod.solver = 'EXACT'
bpy.context.view_layer.objects.active = terrain_obj
bpy.ops.object.modifier_apply(modifier="PondHole")
bpy.data.objects.remove(o_cut)

# -----------------------------------------------------------------------------
# 3. 3D SUNKEN BASIN (5ft deep)
# -----------------------------------------------------------------------------
N_BASIN = 44
b_verts = []
b_faces = []
b_verts.append((POND_CX, POND_CY, POND_GROUND_Z - POND_DEPTH))
for i in range(N_BASIN):
    th = (i / N_BASIN) * math.pi * 2
    r = pond_r(th) * 0.45
    b_verts.append((POND_CX + math.sin(th) * r, POND_CY + math.cos(th) * r, POND_GROUND_Z - POND_DEPTH + 0.05))
for i in range(N_BASIN):
    th = (i / N_BASIN) * math.pi * 2
    r = pond_r(th) * 0.78
    b_verts.append((POND_CX + math.sin(th) * r, POND_CY + math.cos(th) * r, POND_GROUND_Z - 0.65))
for i in range(N_BASIN):
    th = (i / N_BASIN) * math.pi * 2
    r = pond_r(th) * 1.05
    b_verts.append((POND_CX + math.sin(th) * r, POND_CY + math.cos(th) * r, POND_GROUND_Z + 0.08))

for i in range(N_BASIN):
    nxt = (i + 1) % N_BASIN
    b_faces.append((0, 1 + i, 1 + nxt))
    r1a, r1b = 1 + i, 1 + nxt
    r2a, r2b = 1 + N_BASIN + i, 1 + N_BASIN + nxt
    b_faces.append((r1a, r2a, r2b, r1b))
    r3a, r3b = 1 + N_BASIN * 2 + i, 1 + N_BASIN * 2 + nxt
    b_faces.append((r2a, r3a, r3b, r2b))

m_basin = bpy.data.meshes.new("KoiPondBasin")
m_basin.from_pydata(b_verts, [], b_faces)
o_basin = bpy.data.objects.new("KoiPondBasin", m_basin)
sc.collection.objects.link(o_basin)

mat_basin = bpy.data.materials.new("PondGravelBasin")
mat_basin.use_nodes = True
bbsdf = mat_basin.node_tree.nodes.get("Principled BSDF")
if bbsdf:
    bbsdf.inputs["Base Color"].default_value = (0.16, 0.20, 0.16, 1.0)
    bbsdf.inputs["Roughness"].default_value = 0.85
m_basin.materials.append(mat_basin)

# Crystal Clear Pond Water Surface
w_verts = [(POND_CX, POND_CY, POND_WATER_Z)]
w_faces = []
for i in range(N_BASIN):
    th = (i / N_BASIN) * math.pi * 2
    r = pond_r(th) * 1.01
    w_verts.append((POND_CX + math.sin(th) * r, POND_CY + math.cos(th) * r, POND_WATER_Z))
    nxt = (i + 1) % N_BASIN
    w_faces.append((0, 1 + i, 1 + nxt))

m_pwater = bpy.data.meshes.new("PondWaterSurface")
m_pwater.from_pydata(w_verts, [], w_faces)
o_pwater = bpy.data.objects.new("PondWaterSurface", m_pwater)
sc.collection.objects.link(o_pwater)

mat_pwater = bpy.data.materials.new("CrystalClearPondWater")
mat_pwater.use_nodes = True
ptree = mat_pwater.node_tree
pbsdf = ptree.nodes.get("Principled BSDF")
if pbsdf:
    pbsdf.inputs["Base Color"].default_value = (0.15, 0.45, 0.48, 1.0)
    pbsdf.inputs["Roughness"].default_value = 0.03
    pbsdf.inputs["IOR"].default_value = 1.333
    if "Transmission Weight" in pbsdf.inputs:
        pbsdf.inputs["Transmission Weight"].default_value = 0.94
    elif "Transmission" in pbsdf.inputs:
        pbsdf.inputs["Transmission"].default_value = 0.94

p_noise = ptree.nodes.new("ShaderNodeTexNoise")
p_noise.inputs["Scale"].default_value = 32.0
p_noise.inputs["Detail"].default_value = 4.0
p_bump = ptree.nodes.new("ShaderNodeBump")
p_bump.inputs["Strength"].default_value = 0.03
p_bump.inputs["Distance"].default_value = 0.03
ptree.links.new(p_noise.outputs["Fac"], p_bump.inputs["Height"])
ptree.links.new(p_bump.outputs["Normal"], pbsdf.inputs["Normal"])
m_pwater.materials.append(mat_pwater)

# 36 Natural River Coping Stones lining the rim
mat_stone = bpy.data.materials.new("PondRiverStone")
mat_stone.use_nodes = True
mat_stone.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (0.38, 0.40, 0.36, 1.0)
mat_moss = bpy.data.materials.new("PondMossStone")
mat_moss.use_nodes = True
mat_moss.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (0.24, 0.36, 0.18, 1.0)

for i in range(36):
    th = (i / 36) * math.pi * 2 + 0.04 * math.sin(i * 3.7)
    r = pond_r(th) + 0.08 + 0.10 * math.sin(i * 4.9)
    sx = POND_CX + math.sin(th) * r
    sy = POND_CY + math.cos(th) * r
    sz = POND_GROUND_Z + 0.12

    rad = 0.44 + 0.10 * math.sin(i * 2.8)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=rad)
    stone = bpy.context.active_object
    stone.scale = (1.15, 1.0, 0.65)
    stone.location = (sx, sy, sz)
    stone.rotation_euler = (math.sin(i * 1.5) * 0.3, math.cos(i * 2.1) * 0.3, th)
    stone.data.materials.append(mat_moss if i % 3 == 0 else mat_stone)

# -----------------------------------------------------------------------------
# 4. 10 DISTINCT JAPANESE KOI FISH (Swimming at 5ft Depth)
# -----------------------------------------------------------------------------
KOI_VARIETIES = [
    ("Kohaku", (0.98, 0.98, 0.96, 1.0), (0.95, 0.18, 0.05, 1.0), "patch"),
    ("Taisho Sanke", (0.96, 0.96, 0.94, 1.0), (0.92, 0.16, 0.04, 1.0), "tri"),
    ("Showa", (0.12, 0.12, 0.14, 1.0), (0.92, 0.16, 0.04, 1.0), "swirl"),
    ("Yamabuki Ogon", (1.0, 0.82, 0.10, 1.0), (1.0, 0.90, 0.25, 1.0), "solid"),
    ("Shiro Utsuri", (0.10, 0.10, 0.12, 1.0), (0.98, 0.98, 0.98, 1.0), "stripe"),
    ("Tancho", (0.98, 0.98, 0.98, 1.0), (0.95, 0.12, 0.04, 1.0), "tancho"),
    ("Asagi", (0.32, 0.42, 0.50, 1.0), (0.96, 0.35, 0.06, 1.0), "asagi"),
    ("Ki Utsuri", (0.10, 0.10, 0.12, 1.0), (0.98, 0.78, 0.05, 1.0), "stripe"),
    ("Beni Kumonryu", (0.96, 0.96, 0.95, 1.0), (0.92, 0.15, 0.05, 1.0), "tri"),
    ("Kin Matsuba", (0.88, 0.64, 0.18, 1.0), (0.98, 0.76, 0.24, 1.0), "scale"),
]

def build_koi_3d(name, base_col, pat_col, style, loc, yaw, scale=1.25):
    k_root = bpy.data.objects.new(f"Koi_{name}", None)
    sc.collection.objects.link(k_root)

    bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.14 * scale, depth=1.05 * scale)
    body = bpy.context.active_object
    body.name = f"body_{name}"
    body.scale = (0.80, 0.55, 1.0)
    body.rotation_euler = (math.radians(90), 0, 0)
    body.parent = k_root

    mat_k = bpy.data.materials.new(f"mat_{name}")
    mat_k.use_nodes = True
    kbsdf = mat_k.node_tree.nodes.get("Principled BSDF")
    if kbsdf:
        kbsdf.inputs["Base Color"].default_value = base_col
        kbsdf.inputs["Roughness"].default_value = 0.15
        kbsdf.inputs["Metallic"].default_value = 0.50
        if "Emission Color" in kbsdf.inputs:
            kbsdf.inputs["Emission Color"].default_value = (base_col[0] * 0.3, base_col[1] * 0.3, base_col[2] * 0.3, 1.0)
            kbsdf.inputs["Emission Strength"].default_value = 0.8
    body.data.materials.append(mat_k)

    # Dorsal pattern marking
    bpy.ops.mesh.primitive_cube_add(size=1.0)
    patch = bpy.context.active_object
    patch.scale = (0.18 * scale, 0.54 * scale, 0.09 * scale)
    patch.location = (0, 0.06 * scale, 0.07 * scale)
    patch.parent = k_root

    mat_pat = bpy.data.materials.new(f"mat_pat_{name}")
    mat_pat.use_nodes = True
    pbs = mat_pat.node_tree.nodes.get("Principled BSDF")
    if pbs:
        pbs.inputs["Base Color"].default_value = pat_col
        pbs.inputs["Roughness"].default_value = 0.15
        pbs.inputs["Metallic"].default_value = 0.50
        if "Emission Color" in pbs.inputs:
            pbs.inputs["Emission Color"].default_value = (pat_col[0] * 0.4, pat_col[1] * 0.4, pat_col[2] * 0.4, 1.0)
            pbs.inputs["Emission Strength"].default_value = 1.0
    patch.data.materials.append(mat_pat)

    # Caudal Tail Fin
    bpy.ops.mesh.primitive_cone_add(vertices=6, radius1=0.22 * scale, radius2=0.01, depth=0.36 * scale)
    tail = bpy.context.active_object
    tail.scale = (0.12, 1.0, 0.95)
    tail.location = (0, -0.58 * scale, 0)
    tail.rotation_euler = (math.radians(90), 0, 0)
    tail.parent = k_root
    tail.data.materials.append(mat_pat if style in ("patch", "tri", "tancho") else mat_k)

    # Pectoral Fins
    for side in (-1, 1):
        bpy.ops.mesh.primitive_cube_add(size=1.0)
        fin = bpy.context.active_object
        fin.scale = (0.24 * scale, 0.10 * scale, 0.02 * scale)
        fin.location = (side * 0.18 * scale, 0.22 * scale, -0.01 * scale)
        fin.rotation_euler = (0, side * math.radians(25), side * math.radians(-25))
        fin.parent = k_root
        fin.data.materials.append(mat_pat if style == "asagi" else mat_k)

    k_root.location = loc
    k_root.rotation_euler = (0, 0, yaw)
    return k_root

KOI_POSITIONS = [
    (-1.4, -0.6, -0.18, 0.8),    # Kohaku
    ( 1.2,  0.8, -0.28, 2.2),    # Taisho Sanke
    (-0.5,  1.5, -0.24, -1.2),   # Showa
    ( 1.8, -0.8, -0.16, 1.5),    # Yamabuki Ogon (Golden Yellow)
    (-1.8,  1.2, -0.32, 0.4),    # Shiro Utsuri
    ( 0.0, -1.5, -0.20, 3.1),    # Tancho (Crimson crown)
    (-1.0, -1.8, -0.28, -2.1),   # Asagi
    ( 0.6, -0.4, -0.36, 1.0),    # Ki Utsuri
    ( 1.5, -1.6, -0.25, -0.8),   # Beni Kumonryu
    (-0.2,  0.6, -0.22, 2.6),    # Kin Matsuba (Bronze-gold)
]

for i, (kname, kbase, kpat, kstyle) in enumerate(KOI_VARIETIES):
    ox, oy, rel_z, yaw = KOI_POSITIONS[i]
    kx = POND_CX + ox
    ky = POND_CY + oy
    kz = POND_WATER_Z + rel_z
    build_koi_3d(kname, kbase, kpat, kstyle, (kx, ky, kz), yaw, scale=1.25)

# Floating Lily Pads with Lotus Flowers
mat_lily = bpy.data.materials.new("LilyPad")
mat_lily.use_nodes = True
mat_lily.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (0.18, 0.52, 0.16, 1.0)
mat_lotus = bpy.data.materials.new("LotusFlower")
mat_lotus.use_nodes = True
mat_lotus.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (0.96, 0.55, 0.78, 1.0)

for li in range(7):
    lth = li * 0.92 + 0.35
    lr = 1.6 + 0.9 * math.cos(li * 1.9)
    lx = POND_CX + math.sin(lth) * lr
    ly = POND_CY + math.cos(lth) * lr
    lz = POND_WATER_Z + 0.012

    bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.34, depth=0.01)
    pad = bpy.context.active_object
    pad.location = (lx, ly, lz)
    pad.data.materials.append(mat_lily)

    if li % 2 == 0:
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=0.11)
        lotus = bpy.context.active_object
        lotus.location = (lx + 0.05, ly + 0.05, lz + 0.09)
        lotus.data.materials.append(mat_lotus)

# -----------------------------------------------------------------------------
# 5. Render Perspectives
# -----------------------------------------------------------------------------
def render_cam(name, loc, target, focal=28):
    cam_d = bpy.data.cameras.new(name)
    cam_d.lens = focal
    cam_d.clip_start = 0.1
    cam_d.clip_end = 1500.0
    cam_o = bpy.data.objects.new(name, cam_d)
    sc.collection.objects.link(cam_o)
    sc.camera = cam_o

    cam_o.location = loc
    aim = Vector(target) - Vector(loc)
    cam_o.rotation_euler = aim.to_track_quat("-Z", "Y").to_euler()

    sc.render.resolution_x = 960
    sc.render.resolution_y = 540
    out_path = os.path.join(OUT_DIR, f"{name}.png")
    sc.render.filepath = out_path
    print(f"Rendering {name} -> {out_path} ...", flush=True)
    bpy.ops.render.render(write_still=True)
    print(f"Done {name}!", flush=True)
    bpy.data.objects.remove(cam_o)
    return out_path

# View 1: Looking down into the 5ft excavated Koi Pond at 45 degrees
render_cam("test_pond_render", loc=(POND_CX - 0.8, POND_CY - 5.2, 4.4), target=(POND_CX, POND_CY + 0.2, POND_WATER_Z - 0.35), focal=30)

# View 2: Lakeshore panorama behind the lodge with boathouse, canoes, dock, and reflective lake water
render_cam("test_lake_render", loc=(-18, 36, 4.2), target=(12, 65, 0.5), focal=22)
