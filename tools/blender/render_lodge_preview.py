"""Render realistic Cedar Lodge preview images featuring:
1. Uneven natural Koi Pond with 10 colorful Koi fish
2. Two school buses between the lodges
3. Upgraded vegetation, trees, and lake water reflections
"""
import os
import sys
import math
import bpy
import numpy as np
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
GLB_PATH = os.path.join(ROOT, "tools", "blender", "glb", "lodge.glb")
OUT_DIR = os.path.join(ROOT, "tools", "blender", "preview")
os.makedirs(OUT_DIR, exist_ok=True)

# 1. Reset scene & import lodge.glb
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB_PATH)
sc = bpy.context.scene

# 2. Configure Cycles CPU
sc.render.engine = 'CYCLES'
sc.cycles.device = 'CPU'
sc.cycles.samples = 28
sc.cycles.preview_samples = 12
sc.cycles.use_adaptive_sampling = True
sc.cycles.adaptive_threshold = 0.05
sc.cycles.max_bounces = 4
sc.cycles.diffuse_bounces = 2
sc.cycles.glossy_bounces = 3
sc.cycles.transmission_bounces = 4
sc.cycles.transparent_max_bounces = 6
sc.render.film_transparent = False

sc.view_settings.view_transform = "Filmic" if "Filmic" in [v.identifier for v in sc.view_settings.bl_rna.properties["view_transform"].enum_items] else "Standard"
sc.view_settings.look = "Medium High Contrast"

# 3. Setup Sky & Sunlight
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
    sky_node.sun_elevation = math.radians(46.0)
    sky_node.sun_rotation = math.radians(135.0)
    sky_node.altitude = 600.0
    sky_node.air_density = 1.0
    wnt.links.new(sky_node.outputs[0], w_bg.inputs[0])
except Exception as e:
    w_bg.inputs[0].default_value = (0.5, 0.72, 0.98, 1.0)

w_bg.inputs[1].default_value = 1.0
wnt.links.new(w_bg.outputs[0], w_out.inputs[0])

# Direct Sun Light
sun_data = bpy.data.lights.new("Sun", "SUN")
sun_data.energy = 4.5
sun_data.color = (1.0, 0.94, 0.82)
sun_data.angle = math.radians(1.2)
sun_obj = bpy.data.objects.new("Sun", sun_data)
sc.collection.objects.link(sun_obj)
sun_dir = Vector((-0.5003, -0.4803, 0.7204)).normalized()
sun_obj.rotation_euler = (-sun_dir).to_track_quat("-Z", "Y").to_euler()

# 4. Realistic Water Plane
WATER_Y = -1.2
water_mesh = bpy.data.meshes.new("water_mesh")
water_mesh.from_pydata(
    [(-300, -300, WATER_Y), (300, -300, WATER_Y), (300, 48, WATER_Y), (-300, 48, WATER_Y)],
    [],
    [(0, 1, 2, 3)]
)
water_obj = bpy.data.objects.new("LakeWater", water_mesh)
sc.collection.objects.link(water_obj)

water_mat = bpy.data.materials.new("RealisticWater")
water_mat.use_nodes = True
w_tree = water_mat.node_tree
w_bsdf = w_tree.nodes.get("Principled BSDF")
if w_bsdf:
    w_bsdf.inputs["Base Color"].default_value = (0.02, 0.12, 0.18, 1.0)
    w_bsdf.inputs["Roughness"].default_value = 0.05
    w_bsdf.inputs["IOR"].default_value = 1.333
    if "Transmission Weight" in w_bsdf.inputs:
        w_bsdf.inputs["Transmission Weight"].default_value = 0.65
    elif "Transmission" in w_bsdf.inputs:
        w_bsdf.inputs["Transmission"].default_value = 0.65

tex_noise = w_tree.nodes.new("ShaderNodeTexNoise")
tex_noise.inputs["Scale"].default_value = 18.0
tex_noise.inputs["Detail"].default_value = 4.0
bump = w_tree.nodes.new("ShaderNodeBump")
bump.inputs["Strength"].default_value = 0.08
bump.inputs["Distance"].default_value = 0.1
w_tree.links.new(tex_noise.outputs["Fac"], bump.inputs["Height"])
w_tree.links.new(bump.outputs["Normal"], w_bsdf.inputs["Normal"])
water_mesh.materials.append(water_mat)

# 5. Enhance Glass Materials
for mat in bpy.data.materials:
    if "glass" in mat.name.lower():
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Roughness"].default_value = 0.04
            bsdf.inputs["IOR"].default_value = 1.52
            if "Transmission Weight" in bsdf.inputs:
                bsdf.inputs["Transmission Weight"].default_value = 0.85
            elif "Transmission" in bsdf.inputs:
                bsdf.inputs["Transmission"].default_value = 0.85
            bsdf.inputs["Base Color"].default_value = (0.85, 0.92, 0.96, 1.0)

# 6. Interior Warm Lamps inside the Lodge
interior_lights = [
    (0, 0, 2.6, 500),
    (-5, 0, 2.6, 350),
    (4.5, 1.5, 2.6, 350),
    (0, -2.4, 2.6, 250),
]
for i, (lx, lz, ly, pwr) in enumerate(interior_lights):
    pl = bpy.data.lights.new(f"LodgeLight_{i}", "POINT")
    pl.energy = pwr
    pl.color = (1.0, 0.72, 0.42)
    pl.shadow_soft_size = 0.4
    plo = bpy.data.objects.new(f"LodgeLight_{i}", pl)
    plo.location = (lx, -lz, ly)
    sc.collection.objects.link(plo)

# -----------------------------------------------------------------------------
# 7. Add Two School Buses between the Lodges
# -----------------------------------------------------------------------------
def create_school_bus(name, loc, yaw):
    # Dimensions: L=11.6, W=2.8, H=3.1
    L, W, H = 11.6, 2.8, 3.1
    # Main body box
    bpy.ops.mesh.primitive_cube_add(size=1.0)
    bus = bpy.context.active_object
    bus.name = name
    bus.scale = (W, L, H)
    bus.location = (loc[0], -loc[1], loc[2] + H / 2)
    bus.rotation_euler = (0, 0, -yaw)

    mat_bus = bpy.data.materials.new(f"{name}_mat")
    mat_bus.use_nodes = True
    b_bsdf = mat_bus.node_tree.nodes.get("Principled BSDF")
    if b_bsdf:
        b_bsdf.inputs["Base Color"].default_value = (0.96, 0.72, 0.08, 1.0) # School Bus Yellow
        b_bsdf.inputs["Roughness"].default_value = 0.35
        b_bsdf.inputs["Metallic"].default_value = 0.2
    bus.data.materials.append(mat_bus)

    # Black bumper & roof cap details
    bpy.ops.mesh.primitive_cube_add(size=1.0)
    bumper = bpy.context.active_object
    bumper.name = f"{name}_bumper"
    bumper.scale = (W + 0.1, 0.4, 0.5)
    # Front bumper local position (-L/2)
    c, s = math.cos(yaw), math.sin(yaw)
    fx = loc[0] + s * (-L / 2)
    fz = loc[1] + c * (-L / 2)
    bumper.location = (fx, -fz, loc[2] + 0.35)
    bumper.rotation_euler = (0, 0, -yaw)
    mat_black = bpy.data.materials.new("black_trim")
    mat_black.use_nodes = True
    mat_black.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (0.1, 0.1, 0.12, 1.0)
    bumper.data.materials.append(mat_black)

# Bus 1: Between Main Lodge & Cabin
create_school_bus("SchoolBus_1", (-24.0, 28.5, 0.0), -0.35)
# Bus 2: Driveway connecting lodges and parking
create_school_bus("SchoolBus_2", (-16.5, 36.5, -0.05), 1.18)

# -----------------------------------------------------------------------------
# 8. Add Uneven Natural Koi Pond with 10 Colorful Koi Fish
# -----------------------------------------------------------------------------
POND_CX, POND_CZ = -18.5, 20.0
POND_GY = 0.06
POND_WY = POND_GY - 0.05
POND_DEPTH = 1.52

def pond_r(th):
    return 3.9 + 0.58 * math.sin(2 * th + 0.5) + 0.35 * math.cos(3 * th - 0.7) + 0.22 * math.sin(5 * th + 1.1)

# Basin & water geometry
verts_w = [(POND_CX, -POND_CZ, POND_WY)]
faces_w = []
verts_b = [(POND_CX, -POND_CZ, POND_GY - POND_DEPTH)]
faces_b = []
N_PTS = 32

for i in range(N_PTS):
    th = (i / N_PTS) * math.pi * 2
    r = pond_r(th)
    px = POND_CX + math.sin(th) * r
    pz = POND_CZ + math.cos(th) * r
    verts_w.append((px, -pz, POND_WY))
    verts_b.append((px, -pz, POND_GY + 0.08))
    nxt = (i + 1) % N_PTS
    faces_w.append((0, 1 + i, 1 + nxt))
    faces_b.append((0, 1 + i, 1 + nxt))

# Water mesh
m_pw = bpy.data.meshes.new("KoiPondWater")
m_pw.from_pydata(verts_w, [], faces_w)
o_pw = bpy.data.objects.new("KoiPondWater", m_pw)
sc.collection.objects.link(o_pw)

mat_pw = bpy.data.materials.new("KoiWaterMat")
mat_pw.use_nodes = True
pw_bsdf = mat_pw.node_tree.nodes.get("Principled BSDF")
if pw_bsdf:
    pw_bsdf.inputs["Base Color"].default_value = (0.1, 0.42, 0.45, 1.0)
    pw_bsdf.inputs["Roughness"].default_value = 0.04
    pw_bsdf.inputs["IOR"].default_value = 1.333
    if "Transmission Weight" in pw_bsdf.inputs:
        pw_bsdf.inputs["Transmission Weight"].default_value = 0.75
    elif "Transmission" in pw_bsdf.inputs:
        pw_bsdf.inputs["Transmission"].default_value = 0.75
o_pw.data.materials.append(mat_pw)

# Basin bottom mesh
m_pb = bpy.data.meshes.new("KoiPondBasin")
m_pb.from_pydata(verts_b, [], faces_b)
o_pb = bpy.data.objects.new("KoiPondBasin", m_pb)
sc.collection.objects.link(o_pb)
mat_pb = bpy.data.materials.new("BasinGravel")
mat_pb.use_nodes = True
mat_pb.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (0.18, 0.22, 0.16, 1.0)
o_pb.data.materials.append(mat_pb)

# River stones around rim
for i in range(28):
    th = (i / 28) * math.pi * 2 + math.sin(i * 3.1) * 0.05
    r = pond_r(th) + 0.15 + 0.12 * math.sin(i * 4.3)
    rx = POND_CX + math.sin(th) * r
    rz = POND_CZ + math.cos(th) * r
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.35 + 0.15 * math.sin(i * 2.7))
    st = bpy.context.active_object
    st.location = (rx, -rz, POND_GY + 0.05)
    st.scale = (1.0 + 0.2 * math.cos(i), 1.0 + 0.2 * math.sin(i), 0.6)
    mat_stone = bpy.data.materials.new(f"stone_{i}")
    mat_stone.use_nodes = True
    col = (0.35, 0.38, 0.34, 1.0) if i % 3 != 0 else (0.28, 0.42, 0.24, 1.0) # grey rock or moss
    mat_stone.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = col
    st.data.materials.append(mat_stone)

# 10 Colorful Koi Fish
KOI_COLORS = [
    ("Kohaku", (0.95, 0.25, 0.08, 1.0)),     # Red/White
    ("Ogon", (0.98, 0.82, 0.08, 1.0)),       # Pure Gold
    ("Sanke", (0.92, 0.92, 0.95, 1.0)),      # White with markings
    ("Showa", (0.12, 0.12, 0.15, 1.0)),      # Black & Scarlet
    ("Tancho", (0.96, 0.96, 0.96, 1.0)),     # White with Red Crown
    ("Asagi", (0.42, 0.52, 0.62, 1.0)),      # Indigo/Blue-Grey
    ("Ki_Utsuri", (0.94, 0.72, 0.05, 1.0)),  # Yellow & Black
    ("Shiro", (0.98, 0.98, 0.98, 1.0)),      # Pure White Pearl
    ("Matsuba", (0.84, 0.58, 0.18, 1.0)),    # Shimmering Bronze
    ("Beni", (0.88, 0.18, 0.08, 1.0)),       # Deep Crimson
]

for i in range(10):
    name, color = KOI_COLORS[i]
    th = (i / 10) * math.pi * 2 + 0.3
    r = 1.2 + (i % 5) * 0.38
    fx = POND_CX + math.sin(th) * r
    fz = POND_CZ + math.cos(th) * r
    fy = POND_WY - 0.35 - (i % 4) * 0.22 # varied swimming depths

    bpy.ops.mesh.primitive_cone_add(vertices=6, radius1=0.08, radius2=0.015, depth=0.55)
    fish = bpy.context.active_object
    fish.name = f"Koi_{name}"
    fish.location = (fx, -fz, fy)
    fish.rotation_euler = (math.radians(90), 0, th + math.pi / 2 + 0.2)

    mat_koi = bpy.data.materials.new(f"mat_{name}")
    mat_koi.use_nodes = True
    k_bsdf = mat_koi.node_tree.nodes.get("Principled BSDF")
    k_bsdf.inputs["Base Color"].default_value = color
    k_bsdf.inputs["Roughness"].default_value = 0.25
    k_bsdf.inputs["Metallic"].default_value = 0.35 # glistening wet fish scales
    fish.data.materials.append(mat_koi)

# -----------------------------------------------------------------------------
# 9. Helper to render camera views
# -----------------------------------------------------------------------------
def render_camera(out_name, loc, target, focal_len=24.0, res=(960, 540)):
    cam_data = bpy.data.cameras.new(out_name)
    cam_data.lens = focal_len
    cam_data.clip_start = 0.1
    cam_data.clip_end = 1500.0
    cam_obj = bpy.data.objects.new(out_name, cam_data)
    sc.collection.objects.link(cam_obj)
    sc.camera = cam_obj

    # Game (x, z, y) -> Blender (x, -z, y)
    cam_obj.location = (loc[0], -loc[1], loc[2])
    aim = Vector((target[0] - loc[0], -(target[1] - loc[1]), target[2] - loc[2])).normalized()
    cam_obj.rotation_euler = aim.to_track_quat("-Z", "Y").to_euler()

    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    out_path = os.path.join(OUT_DIR, f"{out_name}.png")
    sc.render.filepath = out_path
    sc.render.image_settings.file_format = "PNG"

    print(f"Rendering {out_name} -> {out_path} ...", flush=True)
    bpy.ops.render.render(write_still=True)
    print(f"Done rendering {out_name}", flush=True)
    bpy.data.objects.remove(cam_obj)
    return out_path

# -----------------------------------------------------------------------------
# 10. Render Key Perspectives
# -----------------------------------------------------------------------------
# View 1: Close-up on the natural uneven Koi Pond & 10 colorful Koi fish
v1 = render_camera("lodge_render_koi_pond", loc=(-18.5, 14.5, 2.8), target=(-18.5, 20.0, -0.2), focal_len=30)

# View 2: The Two School Buses parked between the lodges
v2 = render_camera("lodge_render_buses", loc=(-29.0, 46.0, 4.2), target=(-20.0, 32.0, 1.5), focal_len=26)

# View 3: Broad perspective of South Yard Lodge with pond, buses, and lush green trees
v3 = render_camera("lodge_render_south_yard", loc=(-8.0, 48.0, 5.5), target=(-16.0, 22.0, 2.2), focal_len=24)

# View 4: Lakeshore panorama with clear water & reflections
v4 = render_camera("lodge_render_lake", loc=(-18, -38, 3.5), target=(10, -52, 1.2), focal_len=22)

print("All new lodge renders complete!", flush=True)
