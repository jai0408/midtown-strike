import bpy
import os
import math
from mathutils import Vector

OUT_DIR = os.path.join(os.path.dirname(__file__), "preview")
os.makedirs(OUT_DIR, exist_ok=True)
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
GLB_PATH = os.path.join(ROOT, "tools", "blender", "glb", "lodge.glb")
KOI_GLB = "/Users/jaikeerthanchowdarybonam/Desktop/game/koi_fish 1.glb"
PHOENIX_GLB = "/Users/jaikeerthanchowdarybonam/Desktop/game/phoenix_bird.glb"

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB_PATH)
sc = bpy.context.scene

sc.render.engine = 'CYCLES'
sc.cycles.device = 'CPU'
sc.cycles.samples = 24
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
        try: sky_node.sky_type = st; break
        except Exception: pass
    sky_node.sun_elevation = math.radians(48.0)
    sky_node.sun_rotation = math.radians(138.0)
    wnt.links.new(sky_node.outputs[0], w_bg.inputs[0])
except Exception:
    w_bg.inputs[0].default_value = (0.5, 0.72, 0.98, 1.0)
w_bg.inputs[1].default_value = 1.0
wnt.links.new(w_bg.outputs[0], w_out.inputs[0])

sun_data = bpy.data.lights.new("Sun", "SUN")
sun_data.energy = 5.0
sun_data.color = (1.0, 0.95, 0.86)
sun_obj = bpy.data.objects.new("Sun", sun_data)
sc.collection.objects.link(sun_obj)
sun_dir = Vector((-0.5003, -0.4803, 0.7204)).normalized()
sun_obj.rotation_euler = (-sun_dir).to_track_quat("-Z", "Y").to_euler()

# Excavated pond parameters
POND_CX = -18.5
POND_CY = -20.0
POND_GROUND_Z = 0.06
POND_DEPTH = 1.52 # ~5 feet
POND_WATER_Z = POND_GROUND_Z - 0.05

def pond_r(th):
    return 3.9 + 0.58 * math.sin(2 * th + 0.5) + 0.35 * math.cos(3 * th - 0.7) + 0.22 * math.sin(5 * th + 1.1)

# Exact Boolean Difference Cut on Terrain
terrain_obj = bpy.data.objects.get("terrain")
if terrain_obj:
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
        b0 = 2 + i * 2; t0 = b0 + 1
        b1 = 2 + nxt * 2; t1 = b1 + 1
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

# Basin
N_BASIN = 44
b_verts = [(POND_CX, POND_CY, POND_GROUND_Z - POND_DEPTH)]
b_faces = []
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
mat_basin.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (0.16, 0.20, 0.16, 1.0)
m_basin.materials.append(mat_basin)

# Clear Water
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
p_bump = ptree.nodes.new("ShaderNodeBump")
p_bump.inputs["Strength"].default_value = 0.03
ptree.links.new(p_noise.outputs["Fac"], p_bump.inputs["Height"])
ptree.links.new(p_bump.outputs["Normal"], pbsdf.inputs["Normal"])
m_pwater.materials.append(mat_pwater)

# River Stones
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
    if hasattr(stone.data, "polygons"):
        stone.data.polygons.foreach_set('use_smooth', [True] * len(stone.data.polygons))

# Lily pads & lotus flowers
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
# Add 10 Realistic 3D Koi Fish from koi_fish 1.glb
# -----------------------------------------------------------------------------
KOI_CONFIGS = [
    # (rel_x, rel_y, rel_depth, yaw_deg, scale, pitch_deg, roll_deg)
    (-1.2, -0.5, -0.35,  25, 0.125,  2, -5),
    ( 1.4,  0.7, -0.48, 140, 0.118, -3,  4),
    (-0.6,  1.6, -0.30, 220, 0.130,  1,  2),
    ( 1.6, -0.9, -0.55, -45, 0.122, -2, -3),
    (-1.9,  1.1, -0.65,  85, 0.115,  3,  6),
    ( 0.2, -1.6, -0.42, 175, 0.128, -1, -2),
    (-1.1, -1.9, -0.52, -100,0.110,  2, -4),
    ( 0.8, -0.3, -0.70,  55, 0.135, -4,  5),
    ( 1.7, -1.7, -0.38, -135,0.120,  1,  3),
    (-0.3,  0.5, -0.45, -15, 0.126,  0, -1),
]

for idx, (rx, ry, rz, yaw, scl, pitch, roll) in enumerate(KOI_CONFIGS):
    bpy.ops.import_scene.gltf(filepath=KOI_GLB)
    new_objs = [o for o in bpy.context.selected_objects if o.type == 'MESH']
    root = bpy.context.active_object or new_objs[0]
    while root.parent:
        root = root.parent
    root.name = f"Koi_{idx}"
    root.scale = (scl, scl, scl)
    root.location = (POND_CX + rx, POND_CY + ry, POND_WATER_Z + rz)
    root.rotation_euler = (math.radians(pitch), math.radians(roll), math.radians(yaw))

# Render Koi Pond View
cam_d = bpy.data.cameras.new("CamPond")
cam_d.lens = 30
cam_o = bpy.data.objects.new("CamPond", cam_d)
sc.collection.objects.link(cam_o)
sc.camera = cam_o
cam_o.location = (POND_CX - 0.8, POND_CY - 5.2, 4.4)
aim = Vector((POND_CX, POND_CY + 0.2, POND_WATER_Z - 0.45)) - Vector(cam_o.location)
cam_o.rotation_euler = aim.to_track_quat("-Z", "Y").to_euler()

sc.render.resolution_x = 960
sc.render.resolution_y = 540
sc.render.filepath = os.path.join(OUT_DIR, "test_10_koi_rendered.png")
print("Rendering test_10_koi_rendered.png ...", flush=True)
bpy.ops.render.render(write_still=True)
print("Done test_10_koi_rendered.png!", flush=True)
