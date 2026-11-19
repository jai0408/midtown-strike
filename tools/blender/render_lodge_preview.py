"""Render realistic Cedar Lodge preview images using Blender Cycles CPU."""
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

# Color management (Filmic / AgX / Standard)
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

# Sky texture (Nishita / Hosek)
sky_node = None
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
    sky_node.dust_density = 0.6
    wnt.links.new(sky_node.outputs[0], w_bg.inputs[0])
except Exception as e:
    print("Sky node fallback:", e)
    w_bg.inputs[0].default_value = (0.5, 0.72, 0.98, 1.0)

w_bg.inputs[1].default_value = 1.0
wnt.links.new(w_bg.outputs[0], w_out.inputs[0])

# Direct Sun Light
# sunDir = [-0.5003, 0.7204, 0.4803] -> Blender (x, -z, y)
sun_data = bpy.data.lights.new("Sun", "SUN")
sun_data.energy = 4.5
sun_data.color = (1.0, 0.94, 0.82)
sun_data.angle = math.radians(1.2)  # soft realistic shadow edges
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

# Wave bump on water
tex_noise = w_tree.nodes.new("ShaderNodeTexNoise")
tex_noise.inputs["Scale"].default_value = 18.0
tex_noise.inputs["Detail"].default_value = 4.0
tex_noise.inputs["Roughness"].default_value = 0.4
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

# 7. Helper to render a camera view
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

# 8. Render 3 Key Views:
# View 1: Main lodge exterior from the yard (warm cedar logs, stone chimney, glass windows)
v1 = render_camera("lodge_render_yard", loc=(0, 52, 6.5), target=(0, 2, 3.2), focal_len=28)

# View 2: Lakefront panorama (lake surface, reflections, dock, boathouse, mountains)
v2 = render_camera("lodge_render_lake", loc=(-18, -38, 3.5), target=(10, -52, 1.2), focal_len=22)

# View 3: Lodge entrance close-up (porch, cedar timber, glass reflection of sky)
v3 = render_camera("lodge_render_porch", loc=(6, 18, 3.2), target=(-2, 2, 2.8), focal_len=24)

print("All lodge renders complete!", flush=True)
