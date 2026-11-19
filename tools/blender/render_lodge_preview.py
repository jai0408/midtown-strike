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

# 4. Realistic Expansive Lake Water (Behind the Lodge: Y_blender >= 42 to 300)
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
# 7. Add Authentic American School Buses between the Lodges
# -----------------------------------------------------------------------------
def make_bus_mat(name, color, rough=0.4, metal=0.0, emissive=None):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = color
        bsdf.inputs["Roughness"].default_value = rough
        bsdf.inputs["Metallic"].default_value = metal
        if emissive and "Emission Color" in bsdf.inputs:
            bsdf.inputs["Emission Color"].default_value = emissive
            bsdf.inputs["Emission Strength"].default_value = 2.0
        elif emissive and "Emission" in bsdf.inputs:
            bsdf.inputs["Emission"].default_value = emissive
    return mat

mat_bus_yellow = make_bus_mat("SchoolBusYellow", (0.96, 0.70, 0.06, 1.0), rough=0.32, metal=0.05)
mat_bus_hood_black = make_bus_mat("HoodBlack", (0.15, 0.15, 0.16, 1.0), rough=0.6, metal=0.1)
mat_bus_black = make_bus_mat("BlackTrim", (0.10, 0.10, 0.12, 1.0), rough=0.6, metal=0.2)
mat_bus_chrome = make_bus_mat("Chrome", (0.85, 0.86, 0.88, 1.0), rough=0.15, metal=0.9)
mat_bus_glass = make_bus_mat("BusGlass", (0.12, 0.20, 0.28, 1.0), rough=0.06, metal=0.1)
mat_bus_tire = make_bus_mat("RubberTire", (0.12, 0.12, 0.13, 1.0), rough=0.88, metal=0.0)
mat_bus_wheel_rim = make_bus_mat("WheelRim", (0.35, 0.36, 0.38, 1.0), rough=0.35, metal=0.7)
mat_bus_hub = make_bus_mat("WheelHub", (0.08, 0.08, 0.09, 1.0), rough=0.5, metal=0.8)
mat_bus_red_light = make_bus_mat("RedLight", (0.8, 0.1, 0.1, 1.0), rough=0.2, emissive=(1.0, 0.1, 0.1, 1.0))
mat_bus_amber_light = make_bus_mat("AmberLight", (0.9, 0.5, 0.05, 1.0), rough=0.2, emissive=(1.0, 0.6, 0.1, 1.0))
mat_bus_headlight = make_bus_mat("Headlight", (0.95, 0.95, 1.0, 1.0), rough=0.1, emissive=(1.0, 0.98, 0.9, 1.0))
mat_bus_white = make_bus_mat("WhiteRoof", (0.92, 0.92, 0.94, 1.0), rough=0.4, metal=0.05)
mat_bus_stop_red = make_bus_mat("StopRed", (0.85, 0.08, 0.08, 1.0), rough=0.3, metal=0.1)
mat_bus_sign_text = make_bus_mat("SignYellow", (0.98, 0.78, 0.10, 1.0), rough=0.3, emissive=(0.98, 0.78, 0.10, 1.0))

def build_detailed_school_bus(name, loc, yaw):
    root = bpy.data.objects.new(name, None)
    sc.collection.objects.link(root)

    def add_box(bname, size, pos, mat, rot=(0,0,0)):
        bpy.ops.mesh.primitive_cube_add(size=1.0)
        obj = bpy.context.active_object
        obj.name = f"{name}_{bname}"
        obj.scale = size
        obj.location = pos
        obj.rotation_euler = rot
        obj.data.materials.append(mat)
        obj.parent = root
        return obj

    def add_cyl(cname, r, depth, pos, rot, mat):
        bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=r, depth=depth)
        obj = bpy.context.active_object
        obj.name = f"{name}_{cname}"
        obj.location = pos
        obj.rotation_euler = rot
        obj.data.materials.append(mat)
        obj.parent = root
        return obj

    # Bus orientation: -Y forward (hood), +Y rear
    CABIN_L, CABIN_W, CABIN_H = 8.8, 2.55, 2.30
    CABIN_Y = 0.9
    CABIN_Z = 0.85 + CABIN_H / 2

    # 1. Main Passenger Cabin Body
    add_box("cabin_body", (CABIN_W, CABIN_L, CABIN_H), (0, CABIN_Y, CABIN_Z), mat_bus_yellow)

    # 2. Arched Roof Cap & Escape Hatches
    add_box("roof_cap", (CABIN_W - 0.08, CABIN_L, 0.28), (0, CABIN_Y, CABIN_Z + CABIN_H / 2 + 0.12), mat_bus_yellow)
    add_box("hatch_1", (0.85, 0.85, 0.08), (0, CABIN_Y - 2.2, CABIN_Z + CABIN_H / 2 + 0.28), mat_bus_white)
    add_box("hatch_2", (0.85, 0.85, 0.08), (0, CABIN_Y + 2.2, CABIN_Z + CABIN_H / 2 + 0.28), mat_bus_white)

    # 3. Front Engine Hood / Cowl (Classic Type C)
    HOOD_L, HOOD_W, HOOD_H = 2.4, 1.95, 1.25
    HOOD_Y = -CABIN_L / 2 + CABIN_Y - HOOD_L / 2
    HOOD_Z = 0.85 + HOOD_H / 2
    add_box("hood_main", (HOOD_W, HOOD_L, HOOD_H), (0, HOOD_Y, HOOD_Z), mat_bus_yellow)
    add_box("hood_slope", (HOOD_W - 0.06, HOOD_L * 0.9, 0.16), (0, HOOD_Y + 0.1, HOOD_Z + HOOD_H / 2 + 0.04), mat_bus_yellow, rot=(math.radians(-3), 0, 0))
    add_box("hood_antiglare", (0.75, HOOD_L - 0.4, 0.02), (0, HOOD_Y + 0.1, HOOD_Z + HOOD_H / 2 + 0.13), mat_bus_hood_black)

    # 4. Radiator Grille & Chrome Surround
    add_box("grille_frame", (1.50, 0.10, 0.88), (0, HOOD_Y - HOOD_L / 2 - 0.02, HOOD_Z - 0.08), mat_bus_chrome)
    add_box("grille_mesh", (1.38, 0.08, 0.78), (0, HOOD_Y - HOOD_L / 2 - 0.05, HOOD_Z - 0.08), mat_bus_black)
    for si in range(4):
        slat_z = (HOOD_Z - 0.08) - 0.28 + si * 0.18
        add_box(f"grille_slat_{si}", (1.36, 0.10, 0.03), (0, HOOD_Y - HOOD_L / 2 - 0.07, slat_z), mat_bus_chrome)

    # 5. Headlights & Amber Turn Signals
    for sd in (-1, 1):
        add_cyl(f"headlight_housing_{sd}", 0.18, 0.12, (sd * 0.82, HOOD_Y - HOOD_L / 2 - 0.02, HOOD_Z - 0.02), (math.radians(90), 0, 0), mat_bus_chrome)
        add_cyl(f"headlight_lens_{sd}", 0.15, 0.06, (sd * 0.82, HOOD_Y - HOOD_L / 2 - 0.07, HOOD_Z - 0.02), (math.radians(90), 0, 0), mat_bus_headlight)
        add_cyl(f"turn_signal_{sd}", 0.09, 0.08, (sd * 0.82, HOOD_Y - HOOD_L / 2 - 0.03, HOOD_Z - 0.32), (math.radians(90), 0, 0), mat_bus_amber_light)

    # 6. Windshield (Slanted split pane)
    WS_Y = -CABIN_L / 2 + CABIN_Y + 0.04
    WS_Z = HOOD_Z + HOOD_H / 2 + 0.44
    add_box("windshield_frame", (CABIN_W - 0.12, 0.16, 0.92), (0, WS_Y, WS_Z), mat_bus_black, rot=(math.radians(-6), 0, 0))
    add_box("windshield_glass", (CABIN_W - 0.26, 0.18, 0.82), (0, WS_Y - 0.02, WS_Z), mat_bus_glass, rot=(math.radians(-6), 0, 0))
    add_box("ws_divider", (0.07, 0.20, 0.86), (0, WS_Y - 0.03, WS_Z), mat_bus_black, rot=(math.radians(-6), 0, 0))
    for sd in (-0.55, 0.55):
        add_box(f"wiper_{sd}", (0.50, 0.03, 0.04), (sd, WS_Y - 0.12, WS_Z - 0.25), mat_bus_black, rot=(math.radians(-6), 0, math.radians(12)))

    # 7. Side Passenger Windows
    WIN_L = CABIN_L - 1.2
    WIN_H = 0.82
    WIN_Z = CABIN_Z + 0.32
    # Left side (driver side)
    add_box("win_band_L", (0.05, WIN_L, WIN_H + 0.08), (-CABIN_W / 2 - 0.01, CABIN_Y, WIN_Z), mat_bus_black)
    add_box("win_glass_L", (0.07, WIN_L - 0.1, WIN_H), (-CABIN_W / 2 - 0.01, CABIN_Y, WIN_Z), mat_bus_glass)
    for w_i in range(8):
        py = CABIN_Y - WIN_L / 2 + w_i * (WIN_L / 7)
        add_box(f"pillar_L_{w_i}", (0.09, 0.07, WIN_H + 0.06), (-CABIN_W / 2 - 0.01, py, WIN_Z), mat_bus_black)

    # Right side (passenger entry door + window bays)
    DOOR_W = 0.95
    DOOR_Y = CABIN_Y - CABIN_L / 2 + 0.70
    DOOR_Z = CABIN_Z - 0.22
    add_box("entry_door_frame", (0.06, DOOR_W, 1.85), (CABIN_W / 2 + 0.01, DOOR_Y, DOOR_Z), mat_bus_black)
    add_box("door_glass_top1", (0.08, 0.38, 0.72), (CABIN_W / 2 + 0.01, DOOR_Y - 0.22, DOOR_Z + 0.42), mat_bus_glass)
    add_box("door_glass_top2", (0.08, 0.38, 0.72), (CABIN_W / 2 + 0.01, DOOR_Y + 0.22, DOOR_Z + 0.42), mat_bus_glass)
    add_box("door_glass_bot1", (0.08, 0.38, 0.48), (CABIN_W / 2 + 0.01, DOOR_Y - 0.22, DOOR_Z - 0.40), mat_bus_glass)
    add_box("door_glass_bot2", (0.08, 0.38, 0.48), (CABIN_W / 2 + 0.01, DOOR_Y + 0.22, DOOR_Z - 0.40), mat_bus_glass)

    WIN_R_L = WIN_L - DOOR_W - 0.3
    WIN_R_Y = CABIN_Y + (DOOR_W / 2)
    add_box("win_band_R", (0.05, WIN_R_L, WIN_H + 0.08), (CABIN_W / 2 + 0.01, WIN_R_Y, WIN_Z), mat_bus_black)
    add_box("win_glass_R", (0.07, WIN_R_L - 0.1, WIN_H), (CABIN_W / 2 + 0.01, WIN_R_Y, WIN_Z), mat_bus_glass)
    for w_i in range(7):
        py = WIN_R_Y - WIN_R_L / 2 + w_i * (WIN_R_L / 6)
        add_box(f"pillar_R_{w_i}", (0.09, 0.07, WIN_H + 0.06), (CABIN_W / 2 + 0.01, py, WIN_Z), mat_bus_black)

    # 8. Rear Emergency Exit Door & Windows
    REAR_Y = CABIN_Y + CABIN_L / 2 + 0.01
    add_box("rear_door", (0.95, 0.04, 1.85), (0, REAR_Y, CABIN_Z - 0.15), mat_bus_yellow)
    add_box("rear_door_frame", (1.02, 0.05, 1.90), (0, REAR_Y - 0.01, CABIN_Z - 0.15), mat_bus_black)
    add_box("rear_win_top", (0.74, 0.06, 0.65), (0, REAR_Y, CABIN_Z + 0.42), mat_bus_glass)
    add_box("rear_win_bot", (0.55, 0.06, 0.48), (0, REAR_Y, CABIN_Z - 0.38), mat_bus_glass)
    for sd in (-1, 1):
        add_box(f"rear_flank_win_{sd}", (0.50, 0.05, 0.65), (sd * 0.95, REAR_Y, CABIN_Z + 0.42), mat_bus_glass)

    # 9. Triple Black Rub Rails
    for sd in (-1, 1):
        rx = sd * (CABIN_W / 2 + 0.02)
        add_box(f"rub_floor_{sd}", (0.04, CABIN_L + 0.05, 0.08), (rx, CABIN_Y, CABIN_Z - 0.88), mat_bus_black)
        add_box(f"rub_seat_{sd}", (0.04, CABIN_L + 0.05, 0.08), (rx, CABIN_Y, CABIN_Z - 0.42), mat_bus_black)
        add_box(f"rub_sill_{sd}", (0.04, CABIN_L + 0.05, 0.08), (rx, CABIN_Y, CABIN_Z - 0.10), mat_bus_black)

    # 10. Heavy-Duty Bumpers
    add_box("front_bumper", (HOOD_W + 0.40, 0.32, 0.38), (0, HOOD_Y - HOOD_L / 2 - 0.16, 0.60), mat_bus_black)
    add_box("rear_bumper", (CABIN_W + 0.15, 0.34, 0.40), (0, REAR_Y + 0.16, 0.60), mat_bus_black)
    add_box("cross_arm", (1.20, 0.04, 0.08), (0.2, HOOD_Y - HOOD_L / 2 - 0.34, 0.60), mat_bus_yellow)

    # 11. Large American Side-View Mirrors
    for sd in (-1, 1):
        mx = sd * (CABIN_W / 2 + 0.32)
        my = HOOD_Y + HOOD_L * 0.25
        mz = WS_Z - 0.10
        add_box(f"mirror_arm_top_{sd}", (0.35, 0.04, 0.04), (mx - sd * 0.16, my, mz + 0.35), mat_bus_black)
        add_box(f"mirror_arm_bot_{sd}", (0.35, 0.04, 0.04), (mx - sd * 0.16, my, mz - 0.35), mat_bus_black)
        add_box(f"mirror_head_{sd}", (0.08, 0.18, 0.45), (mx, my, mz + 0.15), mat_bus_black)
        add_box(f"mirror_glass_{sd}", (0.09, 0.16, 0.42), (mx - sd * 0.01, my + 0.01, mz + 0.15), mat_bus_chrome)
        add_cyl(f"convex_mirror_{sd}", 0.11, 0.06, (mx, my, mz - 0.22), (math.radians(90), 0, 0), mat_bus_chrome)

    # 12. Red Octagonal STOP Sign on Driver Side
    STOP_X = -CABIN_W / 2 - 0.09
    STOP_Y = CABIN_Y - CABIN_L / 2 + 1.3
    STOP_Z = CABIN_Z - 0.15
    add_box("stop_bracket", (0.08, 0.06, 0.45), (STOP_X + 0.04, STOP_Y, STOP_Z), mat_bus_black)
    add_cyl("stop_sign_blade", 0.30, 0.03, (STOP_X, STOP_Y, STOP_Z), (0, math.radians(90), 0), mat_bus_stop_red)
    add_box("stop_sign_core", (0.04, 0.38, 0.14), (STOP_X, STOP_Y, STOP_Z), mat_bus_white)

    # 13. Overhead "SCHOOL BUS" Headers & 8-Way Warning Lights
    for is_front in (True, False):
        hy = (WS_Y - 0.08) if is_front else (REAR_Y + 0.02)
        hz = CABIN_Z + CABIN_H / 2 + 0.06
        prefix = "front" if is_front else "rear"
        add_box(f"{prefix}_header", (1.85, 0.10, 0.32), (0, hy, hz), mat_bus_black)
        add_box(f"{prefix}_textplate", (1.30, 0.12, 0.16), (0, hy + (-0.01 if is_front else 0.01), hz), mat_bus_sign_text)
        for l_side in (-1, 1):
            add_cyl(f"{prefix}_amber_{l_side}", 0.10, 0.08, (l_side * 0.72, hy, hz), (math.radians(90), 0, 0), mat_bus_amber_light)
            add_cyl(f"{prefix}_red_{l_side}", 0.10, 0.08, (l_side * 1.02, hy, hz), (math.radians(90), 0, 0), mat_bus_red_light)

    # Roof Marker Clearance Lights
    for rx in (-1.1, -0.2, 0.0, 0.2, 1.1):
        add_cyl(f"roof_marker_{rx}", 0.03, 0.04, (rx, WS_Y + 0.05, CABIN_Z + CABIN_H / 2 + 0.25), (math.radians(90), 0, 0), mat_bus_amber_light)

    # 14. Wheels & Tires
    TIRE_R = 0.52
    TIRE_W = 0.30
    WHEEL_ROT = (0, math.radians(90), 0)

    # Front steer axle
    FRONT_AXLE_Y = HOOD_Y + 0.25
    for sd in (-1, 1):
        wx = sd * (CABIN_W / 2 - 0.14)
        add_cyl(f"tire_front_{sd}", TIRE_R, TIRE_W, (wx, FRONT_AXLE_Y, TIRE_R), WHEEL_ROT, mat_bus_tire)
        add_cyl(f"rim_front_{sd}", TIRE_R * 0.65, TIRE_W + 0.02, (wx, FRONT_AXLE_Y, TIRE_R), WHEEL_ROT, mat_bus_wheel_rim)
        add_cyl(f"hub_front_{sd}", TIRE_R * 0.22, TIRE_W + 0.05, (wx + sd * 0.02, FRONT_AXLE_Y, TIRE_R), WHEEL_ROT, mat_bus_hub)
        add_box(f"arch_front_{sd}", (0.08, 1.35, 0.65), (sd * (CABIN_W / 2 + 0.01), FRONT_AXLE_Y, TIRE_R + 0.20), mat_bus_black)

    # Rear dual drive axle
    REAR_AXLE_Y = CABIN_Y + CABIN_L / 2 - 1.85
    for sd in (-1, 1):
        wx_out = sd * (CABIN_W / 2 - 0.12)
        wx_in  = sd * (CABIN_W / 2 - 0.44)
        add_cyl(f"tire_rear_out_{sd}", TIRE_R, TIRE_W, (wx_out, REAR_AXLE_Y, TIRE_R), WHEEL_ROT, mat_bus_tire)
        add_cyl(f"tire_rear_in_{sd}",  TIRE_R, TIRE_W, (wx_in,  REAR_AXLE_Y, TIRE_R), WHEEL_ROT, mat_bus_tire)
        add_cyl(f"rim_rear_{sd}", TIRE_R * 0.65, TIRE_W * 2.1, ((wx_out + wx_in) / 2, REAR_AXLE_Y, TIRE_R), WHEEL_ROT, mat_bus_wheel_rim)
        add_cyl(f"hub_rear_{sd}", TIRE_R * 0.22, TIRE_W * 2.15, (wx_out + sd * 0.02, REAR_AXLE_Y, TIRE_R), WHEEL_ROT, mat_bus_hub)
        add_box(f"arch_rear_{sd}", (0.08, 1.45, 0.65), (sd * (CABIN_W / 2 + 0.01), REAR_AXLE_Y, TIRE_R + 0.20), mat_bus_black)
        add_box(f"mudflap_{sd}", (0.34, 0.04, 0.42), (wx_out - sd * 0.08, REAR_AXLE_Y + 0.85, TIRE_R - 0.15), mat_bus_black)

    add_box("chassis_frame", (CABIN_W - 0.7, CABIN_L + 1.0, 0.22), (0, CABIN_Y - 0.3, 0.68), mat_bus_black)
    add_box("battery_box", (0.35, 0.8, 0.35), (-CABIN_W / 2 + 0.2, CABIN_Y - 0.8, 0.55), mat_bus_black)
    add_cyl("exhaust_tip", 0.06, 0.30, (-CABIN_W / 2 + 0.25, REAR_AXLE_Y + 1.4, 0.45), (math.radians(90), 0, 0), mat_bus_chrome)

    root.location = (loc[0], -loc[1], loc[2])
    root.rotation_euler = (0, 0, -yaw)
    return root

# Bus 1: Between Main Lodge & Cabin (x=-24.0, z=28.5, yaw=-0.35)
build_detailed_school_bus("SchoolBus_1", (-24.0, 28.5, 0.0), -0.35)
# Bus 2: Driveway connecting lodges and parking (x=-16.5, z=36.5, yaw=1.18)
build_detailed_school_bus("SchoolBus_2", (-16.5, 36.5, -0.05), 1.18)

# -----------------------------------------------------------------------------
# 8. Add Uneven Natural Koi Pond with 5ft Excavated Basin & 10 Japanese Koi Fish
# -----------------------------------------------------------------------------
POND_CX = -18.5
POND_CY = -20.0
POND_GROUND_Z = 0.06
POND_DEPTH = 1.52 # ~5 feet deep
POND_WATER_Z = POND_GROUND_Z - 0.05

def pond_r(th):
    return 3.9 + 0.58 * math.sin(2 * th + 0.5) + 0.35 * math.cos(3 * th - 0.7) + 0.22 * math.sin(5 * th + 1.1)

# 1. Exact Boolean Cut on Terrain for Pond Hole
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

# 2. 3D Sunken Excavated Basin (5ft / 1.52m deep)
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

# 3. Crystal Clear Pond Water Surface
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

# 4. 36 River Coping Stones around Rim
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

# 5. 10 Distinct Japanese Koi Fish (Organic Sleek 3D Meshes with Smooth Shading)
KOI_VARIETIES = [
    ("Kohaku", (0.98, 0.98, 0.96, 1.0), (0.95, 0.18, 0.05, 1.0), "patch"),        # Pearl white with vibrant red markings
    ("Taisho Sanke", (0.96, 0.96, 0.94, 1.0), (0.92, 0.16, 0.04, 1.0), "tri"),     # White with vermilion & sumi black
    ("Showa", (0.12, 0.12, 0.14, 1.0), (0.92, 0.16, 0.04, 1.0), "swirl"),          # Midnight black with scarlet & white
    ("Yamabuki Ogon", (1.0, 0.82, 0.10, 1.0), (1.0, 0.90, 0.25, 1.0), "solid"),    # Pure shimmering metallic gold
    ("Shiro Utsuri", (0.10, 0.10, 0.12, 1.0), (0.98, 0.98, 0.98, 1.0), "stripe"),  # Black body with white markings
    ("Tancho", (0.98, 0.98, 0.98, 1.0), (0.95, 0.12, 0.04, 1.0), "tancho"),       # Pure pearl white with crimson crown spot
    ("Asagi", (0.32, 0.42, 0.50, 1.0), (0.96, 0.35, 0.06, 1.0), "asagi"),          # Steel-blue net scales with fiery belly
    ("Ki Utsuri", (0.10, 0.10, 0.12, 1.0), (0.98, 0.78, 0.05, 1.0), "stripe"),     # Lacquer black with bright canary yellow
    ("Beni Kumonryu", (0.96, 0.96, 0.95, 1.0), (0.92, 0.15, 0.05, 1.0), "tri"),    # White dragon with scarlet & ink
    ("Kin Matsuba", (0.88, 0.64, 0.18, 1.0), (0.98, 0.76, 0.24, 1.0), "scale"),    # Bronze pinecone luster
]

def build_koi_3d(name, base_col, pat_col, style, loc, yaw, scale=1.35):
    k_root = bpy.data.objects.new(f"Koi_{name}", None)
    sc.collection.objects.link(k_root)

    # 1. Sleek organic fish body cross-sections along the spine
    SEGS = [
        ( 0.52 * scale, 0.02 * scale, 0.02 * scale,  0.00),         # Snout tip
        ( 0.40 * scale, 0.09 * scale, 0.08 * scale,  0.01 * scale),  # Head / Eyes
        ( 0.20 * scale, 0.15 * scale, 0.13 * scale,  0.02 * scale),  # Gills / Maximum Girth
        ( 0.00 * scale, 0.14 * scale, 0.12 * scale,  0.015 * scale), # Torso Midsection
        (-0.20 * scale, 0.11 * scale, 0.09 * scale,  0.005 * scale), # Tapering Belly
        (-0.36 * scale, 0.06 * scale, 0.06 * scale, -0.005 * scale), # Lower Flank
        (-0.48 * scale, 0.03 * scale, 0.035 * scale, -0.01 * scale), # Caudal Peduncle Base
    ]

    N_RAD = 12
    verts = []
    faces = []

    # Build rings of vertices
    for si, (sy, hw, hh, z_off) in enumerate(SEGS):
        # Organic gentle swimming undulation curve along spine
        und = 0.025 * scale * math.sin(si * 0.9)
        for ri in range(N_RAD):
            ang = (ri / N_RAD) * math.pi * 2
            vx = hw * math.cos(ang) + und
            vz = hh * math.sin(ang) + z_off
            verts.append((vx, sy, vz))

    # Ring quad faces
    for si in range(len(SEGS) - 1):
        for ri in range(N_RAD):
            nxt_r = (ri + 1) % N_RAD
            v0 = si * N_RAD + ri
            v1 = si * N_RAD + nxt_r
            v2 = (si + 1) * N_RAD + nxt_r
            v3 = (si + 1) * N_RAD + ri
            faces.append((v0, v1, v2, v3))

    # Snout cap (front)
    snout_center = len(verts)
    verts.append((0, 0.56 * scale, 0))
    for ri in range(N_RAD):
        nxt_r = (ri + 1) % N_RAD
        faces.append((snout_center, ri, nxt_r))

    # Tail peduncle cap (rear)
    tail_center = len(verts)
    verts.append((0, -0.50 * scale, -0.01 * scale))
    last_ring = (len(SEGS) - 1) * N_RAD
    for ri in range(N_RAD):
        nxt_r = (ri + 1) % N_RAD
        faces.append((tail_center, last_ring + nxt_r, last_ring + ri))

    m_body = bpy.data.meshes.new(f"mesh_body_{name}")
    m_body.from_pydata(verts, [], faces)
    if hasattr(m_body, "polygons"):
        m_body.polygons.foreach_set('use_smooth', [True] * len(m_body.polygons))

    o_body = bpy.data.objects.new(f"body_{name}", m_body)
    sc.collection.objects.link(o_body)
    o_body.parent = k_root

    # Base Fish Scale Material
    mat_k = bpy.data.materials.new(f"mat_{name}")
    mat_k.use_nodes = True
    kbsdf = mat_k.node_tree.nodes.get("Principled BSDF")
    if kbsdf:
        kbsdf.inputs["Base Color"].default_value = base_col
        kbsdf.inputs["Roughness"].default_value = 0.12
        kbsdf.inputs["Metallic"].default_value = 0.45 # Glistening wet fish scales
        if "Emission Color" in kbsdf.inputs:
            kbsdf.inputs["Emission Color"].default_value = (base_col[0] * 0.25, base_col[1] * 0.25, base_col[2] * 0.25, 1.0)
            kbsdf.inputs["Emission Strength"].default_value = 0.5
    o_body.data.materials.append(mat_k)

    # 2. Distinct Pattern Patches (Kohaku red hi, Sanke markings, Tancho spot)
    mat_pat = bpy.data.materials.new(f"mat_pat_{name}")
    mat_pat.use_nodes = True
    pbs = mat_pat.node_tree.nodes.get("Principled BSDF")
    if pbs:
        pbs.inputs["Base Color"].default_value = pat_col
        pbs.inputs["Roughness"].default_value = 0.12
        pbs.inputs["Metallic"].default_value = 0.45
        if "Emission Color" in pbs.inputs:
            pbs.inputs["Emission Color"].default_value = (pat_col[0] * 0.35, pat_col[1] * 0.35, pat_col[2] * 0.35, 1.0)
            pbs.inputs["Emission Strength"].default_value = 0.75

    if style == "tancho":
        # Red circular crown on head
        bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.055 * scale, depth=0.02 * scale)
        spot = bpy.context.active_object
        spot.location = (0, 0.34 * scale, 0.082 * scale)
        spot.parent = k_root
        spot.data.materials.append(mat_pat)
    else:
        # Vibrant dorsal color patches
        for pi, (py, pz_scl, pl, pw) in enumerate([(0.18, 0.02, 0.38, 0.16), (-0.12, 0.015, 0.28, 0.12)]):
            bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=pw * scale, depth=pl * scale)
            patch = bpy.context.active_object
            patch.scale = (0.9, 1.0, 0.35)
            patch.rotation_euler = (math.radians(90), 0, 0)
            patch.location = (0.01 * (1 if pi == 0 else -1) * scale, py * scale, (0.12 + pz_scl) * scale)
            patch.parent = k_root
            patch.data.materials.append(mat_pat)

    # 3. Delicate Translucent Caudal Tail Fin (Fan shape undulating behind fish)
    t_verts = [
        (0.0, -0.48 * scale, -0.01 * scale),                           # peduncle top
        (0.0, -0.48 * scale, -0.03 * scale),                           # peduncle bot
        (0.03 * scale, -0.74 * scale,  0.18 * scale),                  # top lobe tip
        (0.02 * scale, -0.66 * scale,  0.00 * scale),                  # fork notch
        (0.03 * scale, -0.72 * scale, -0.16 * scale),                  # bot lobe tip
    ]
    t_faces = [(0, 2, 3, 1), (1, 3, 4)]
    m_tail = bpy.data.meshes.new(f"mesh_tail_{name}")
    m_tail.from_pydata(t_verts, [], t_faces)
    o_tail = bpy.data.objects.new(f"tail_{name}", m_tail)
    sc.collection.objects.link(o_tail)
    o_tail.parent = k_root
    o_tail.data.materials.append(mat_pat if style in ("patch", "tri") else mat_k)

    # 4. Angled Pectoral Fins
    for side in (-1, 1):
        f_verts = [
            (side * 0.14 * scale, 0.24 * scale, -0.01 * scale),
            (side * 0.14 * scale, 0.16 * scale, -0.03 * scale),
            (side * 0.36 * scale, 0.10 * scale, -0.05 * scale),
            (side * 0.34 * scale, 0.18 * scale, -0.03 * scale),
        ]
        f_faces = [(0, 1, 2, 3) if side == 1 else (3, 2, 1, 0)]
        m_fin = bpy.data.meshes.new(f"fin_{side}_{name}")
        m_fin.from_pydata(f_verts, [], f_faces)
        o_fin = bpy.data.objects.new(f"fin_{side}_{name}", m_fin)
        sc.collection.objects.link(o_fin)
        o_fin.parent = k_root
        o_fin.data.materials.append(mat_pat if style == "asagi" else mat_k)

    # 5. Delicate Dorsal Fin along spine
    d_verts = [
        (0.0,  0.22 * scale, 0.13 * scale),
        (0.0, -0.18 * scale, 0.10 * scale),
        (0.01 * scale, -0.12 * scale, 0.21 * scale),
        (0.005 * scale, 0.14 * scale, 0.20 * scale),
    ]
    d_faces = [(0, 1, 2, 3)]
    m_dorsal = bpy.data.meshes.new(f"dorsal_{name}")
    m_dorsal.from_pydata(d_verts, [], d_faces)
    o_dorsal = bpy.data.objects.new(f"dorsal_{name}", m_dorsal)
    sc.collection.objects.link(o_dorsal)
    o_dorsal.parent = k_root
    o_dorsal.data.materials.append(mat_pat if style in ("patch", "swirl") else mat_k)

    k_root.location = loc
    k_root.rotation_euler = (0, 0, yaw)
    return k_root

KOI_POSITIONS = [
    (-1.4, -0.6, -0.18, 0.8),    # Kohaku
    ( 1.2,  0.8, -0.28, 2.2),    # Taisho Sanke
    (-0.5,  1.5, -0.24, -1.2),   # Showa
    ( 1.8, -0.8, -0.16, 1.5),    # Yamabuki Ogon
    (-1.8,  1.2, -0.32, 0.4),    # Shiro Utsuri
    ( 0.0, -1.5, -0.20, 3.1),    # Tancho
    (-1.0, -1.8, -0.28, -2.1),   # Asagi
    ( 0.6, -0.4, -0.36, 1.0),    # Ki Utsuri
    ( 1.5, -1.6, -0.25, -0.8),   # Beni Kumonryu
    (-0.2,  0.6, -0.22, 2.6),    # Kin Matsuba
]

for i, (kname, kbase, kpat, kstyle) in enumerate(KOI_VARIETIES):
    ox, oy, rel_z, yaw = KOI_POSITIONS[i]
    kx = POND_CX + ox
    ky = POND_CY + oy
    kz = POND_WATER_Z + rel_z
    build_koi_3d(kname, kbase, kpat, kstyle, (kx, ky, kz), yaw, scale=1.35)

# 6. Floating Lily Pads with Lotus Flowers
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
# View 1: Looking down into the 5ft excavated Koi Pond at 45 degrees, revealing clear water & 10 swimming Koi
v1 = render_camera("lodge_render_koi_pond", loc=(-19.3, 25.2, 4.4), target=(-18.5, 19.8, -0.34), focal_len=30)

# View 2: The Two School Buses parked between the lodges
v2 = render_camera("lodge_render_buses", loc=(-27.0, 44.0, 3.8), target=(-20.5, 32.5, 1.6), focal_len=28)

# View 3: Broad perspective of South Yard Lodge with pond, buses, and lush green trees
v3 = render_camera("lodge_render_south_yard", loc=(-8.0, 48.0, 5.5), target=(-16.0, 22.0, 2.2), focal_len=24)

# View 4: Lakeshore panorama behind lodge with reflective lake water, canoes, and boathouse
v4 = render_camera("lodge_render_lake", loc=(-18.0, -36.0, 4.2), target=(12.0, -65.0, 0.5), focal_len=22)

# View 5: Close 3/4 Hero shot of the School Bus between lodges
v5 = render_camera("lodge_render_bus_detail", loc=(-21.5, 42.5, 2.6), target=(-16.5, 36.5, 1.7), focal_len=35)

print("All new lodge renders complete!", flush=True)
