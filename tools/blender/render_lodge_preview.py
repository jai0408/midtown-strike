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
v2 = render_camera("lodge_render_buses", loc=(-27.0, 44.0, 3.8), target=(-20.5, 32.5, 1.6), focal_len=28)

# View 3: Broad perspective of South Yard Lodge with pond, buses, and lush green trees
v3 = render_camera("lodge_render_south_yard", loc=(-8.0, 48.0, 5.5), target=(-16.0, 22.0, 2.2), focal_len=24)

# View 4: Lakeshore panorama with clear water & reflections
v4 = render_camera("lodge_render_lake", loc=(-18, -38, 3.5), target=(10, -52, 1.2), focal_len=22)

# View 5: Close 3/4 Hero shot of the School Bus between lodges
v5 = render_camera("lodge_render_bus_detail", loc=(-21.5, 42.5, 2.6), target=(-16.5, 36.5, 1.7), focal_len=35)

print("All new lodge renders complete!", flush=True)
