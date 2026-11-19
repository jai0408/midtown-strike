"""Test script to generate a high-detail American School Bus and render it in Blender Cycles."""
import os
import math
import bpy
from mathutils import Vector

OUT_DIR = os.path.join(os.path.dirname(__file__), "preview")
os.makedirs(OUT_DIR, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene

sc.render.engine = 'CYCLES'
sc.cycles.device = 'CPU'
sc.cycles.samples = 28
sc.cycles.preview_samples = 8
sc.cycles.use_adaptive_sampling = True
sc.render.film_transparent = False

sc.view_settings.view_transform = "Filmic" if "Filmic" in [v.identifier for v in sc.view_settings.bl_rna.properties["view_transform"].enum_items] else "Standard"

# Materials
def make_mat(name, color, rough=0.4, metal=0.0, emissive=None):
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

mat_yellow = make_mat("SchoolBusYellow", (0.96, 0.70, 0.06, 1.0), rough=0.32, metal=0.05)
mat_hood_black = make_mat("HoodBlack", (0.15, 0.15, 0.16, 1.0), rough=0.6, metal=0.1) # anti-glare center strip
mat_black = make_mat("BlackTrim", (0.10, 0.10, 0.12, 1.0), rough=0.6, metal=0.2)
mat_chrome = make_mat("Chrome", (0.85, 0.86, 0.88, 1.0), rough=0.15, metal=0.9)
mat_glass = make_mat("BusGlass", (0.12, 0.20, 0.28, 1.0), rough=0.06, metal=0.1)
mat_tire = make_mat("RubberTire", (0.12, 0.12, 0.13, 1.0), rough=0.88, metal=0.0)
mat_wheel_rim = make_mat("WheelRim", (0.35, 0.36, 0.38, 1.0), rough=0.35, metal=0.7)
mat_hub = make_mat("WheelHub", (0.08, 0.08, 0.09, 1.0), rough=0.5, metal=0.8)
mat_red_light = make_mat("RedLight", (0.8, 0.1, 0.1, 1.0), rough=0.2, emissive=(1.0, 0.1, 0.1, 1.0))
mat_amber_light = make_mat("AmberLight", (0.9, 0.5, 0.05, 1.0), rough=0.2, emissive=(1.0, 0.6, 0.1, 1.0))
mat_headlight = make_mat("Headlight", (0.95, 0.95, 1.0, 1.0), rough=0.1, emissive=(1.0, 0.98, 0.9, 1.0))
mat_white = make_mat("WhiteRoof", (0.92, 0.92, 0.94, 1.0), rough=0.4, metal=0.05)
mat_stop_red = make_mat("StopRed", (0.85, 0.08, 0.08, 1.0), rough=0.3, metal=0.1)
mat_sign_text = make_mat("SignYellow", (0.98, 0.78, 0.10, 1.0), rough=0.3, emissive=(0.98, 0.78, 0.10, 1.0))

def build_detailed_school_bus(name, loc=(0,0,0), yaw=0):
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

    # Bus orientation: -Y forward (hood), +Y rear (emergency door)
    # Chassis / floor height: 0.85m off ground
    CABIN_L, CABIN_W, CABIN_H = 8.8, 2.55, 2.30
    CABIN_Y = 0.9
    CABIN_Z = 0.85 + CABIN_H / 2 # 2.00

    # 1. Main Passenger Cabin Body
    add_box("cabin_body", (CABIN_W, CABIN_L, CABIN_H), (0, CABIN_Y, CABIN_Z), mat_yellow)

    # 2. Arched Roof Cap
    add_box("roof_cap", (CABIN_W - 0.08, CABIN_L, 0.28), (0, CABIN_Y, CABIN_Z + CABIN_H / 2 + 0.12), mat_yellow)
    # White emergency exit roof hatches
    add_box("hatch_1", (0.85, 0.85, 0.08), (0, CABIN_Y - 2.2, CABIN_Z + CABIN_H / 2 + 0.28), mat_white)
    add_box("hatch_2", (0.85, 0.85, 0.08), (0, CABIN_Y + 2.2, CABIN_Z + CABIN_H / 2 + 0.28), mat_white)

    # 3. Front Engine Hood / Cowl (Type C School Bus)
    HOOD_L, HOOD_W, HOOD_H = 2.4, 1.95, 1.25
    HOOD_Y = -CABIN_L / 2 + CABIN_Y - HOOD_L / 2 # -4.7
    HOOD_Z = 0.85 + HOOD_H / 2 # 1.475
    add_box("hood_main", (HOOD_W, HOOD_L, HOOD_H), (0, HOOD_Y, HOOD_Z), mat_yellow)
    # Sloped hood top wedge
    add_box("hood_slope", (HOOD_W - 0.06, HOOD_L * 0.9, 0.16), (0, HOOD_Y + 0.1, HOOD_Z + HOOD_H / 2 + 0.04), mat_yellow, rot=(math.radians(-3), 0, 0))
    # Anti-glare black center hood patch
    add_box("hood_antiglare", (0.75, HOOD_L - 0.4, 0.02), (0, HOOD_Y + 0.1, HOOD_Z + HOOD_H / 2 + 0.13), mat_hood_black)

    # 4. Radiator Grille & Chrome Surround
    add_box("grille_frame", (1.50, 0.10, 0.88), (0, HOOD_Y - HOOD_L / 2 - 0.02, HOOD_Z - 0.08), mat_chrome)
    add_box("grille_mesh", (1.38, 0.08, 0.78), (0, HOOD_Y - HOOD_L / 2 - 0.05, HOOD_Z - 0.08), mat_black)
    # Grille horizontal chrome slats
    for si in range(4):
        slat_z = (HOOD_Z - 0.08) - 0.28 + si * 0.18
        add_box(f"grille_slat_{si}", (1.36, 0.10, 0.03), (0, HOOD_Y - HOOD_L / 2 - 0.07, slat_z), mat_chrome)

    # 5. Dual Round Headlights & Amber Turn Signals
    for sd in (-1, 1):
        add_cyl(f"headlight_housing_{sd}", 0.18, 0.12, (sd * 0.82, HOOD_Y - HOOD_L / 2 - 0.02, HOOD_Z - 0.02), (math.radians(90), 0, 0), mat_chrome)
        add_cyl(f"headlight_lens_{sd}", 0.15, 0.06, (sd * 0.82, HOOD_Y - HOOD_L / 2 - 0.07, HOOD_Z - 0.02), (math.radians(90), 0, 0), mat_headlight)
        add_cyl(f"turn_signal_{sd}", 0.09, 0.08, (sd * 0.82, HOOD_Y - HOOD_L / 2 - 0.03, HOOD_Z - 0.32), (math.radians(90), 0, 0), mat_amber_light)

    # 6. Windshield (Slanted split pane)
    WS_Y = -CABIN_L / 2 + CABIN_Y + 0.04
    WS_Z = HOOD_Z + HOOD_H / 2 + 0.44
    add_box("windshield_frame", (CABIN_W - 0.12, 0.16, 0.92), (0, WS_Y, WS_Z), mat_black, rot=(math.radians(-6), 0, 0))
    add_box("windshield_glass", (CABIN_W - 0.26, 0.18, 0.82), (0, WS_Y - 0.02, WS_Z), mat_glass, rot=(math.radians(-6), 0, 0))
    # Windshield center pillar divider
    add_box("ws_divider", (0.07, 0.20, 0.86), (0, WS_Y - 0.03, WS_Z), mat_black, rot=(math.radians(-6), 0, 0))
    # Black wiper blades
    for sd in (-0.55, 0.55):
        add_box(f"wiper_{sd}", (0.50, 0.03, 0.04), (sd, WS_Y - 0.12, WS_Z - 0.25), mat_black, rot=(math.radians(-6), 0, math.radians(12)))

    # 7. Side Passenger Windows (Left side: continuous bays; Right side: with entry door)
    WIN_L = CABIN_L - 1.2
    WIN_H = 0.82
    WIN_Z = CABIN_Z + 0.32
    # Left side (driver side)
    add_box("win_band_L", (0.05, WIN_L, WIN_H + 0.08), (-CABIN_W / 2 - 0.01, CABIN_Y, WIN_Z), mat_black)
    add_box("win_glass_L", (0.07, WIN_L - 0.1, WIN_H), (-CABIN_W / 2 - 0.01, CABIN_Y, WIN_Z), mat_glass)
    for w_i in range(8):
        py = CABIN_Y - WIN_L / 2 + w_i * (WIN_L / 7)
        add_box(f"pillar_L_{w_i}", (0.09, 0.07, WIN_H + 0.06), (-CABIN_W / 2 - 0.01, py, WIN_Z), mat_black)

    # Right side (passenger entry door near front + window bays)
    DOOR_W = 0.95
    DOOR_Y = CABIN_Y - CABIN_L / 2 + 0.70
    DOOR_Z = CABIN_Z - 0.22
    # Passenger entry bi-fold door
    add_box("entry_door_frame", (0.06, DOOR_W, 1.85), (CABIN_W / 2 + 0.01, DOOR_Y, DOOR_Z), mat_black)
    add_box("door_glass_top1", (0.08, 0.38, 0.72), (CABIN_W / 2 + 0.01, DOOR_Y - 0.22, DOOR_Z + 0.42), mat_glass)
    add_box("door_glass_top2", (0.08, 0.38, 0.72), (CABIN_W / 2 + 0.01, DOOR_Y + 0.22, DOOR_Z + 0.42), mat_glass)
    add_box("door_glass_bot1", (0.08, 0.38, 0.48), (CABIN_W / 2 + 0.01, DOOR_Y - 0.22, DOOR_Z - 0.40), mat_glass)
    add_box("door_glass_bot2", (0.08, 0.38, 0.48), (CABIN_W / 2 + 0.01, DOOR_Y + 0.22, DOOR_Z - 0.40), mat_glass)

    # Remaining passenger windows on right side
    WIN_R_L = WIN_L - DOOR_W - 0.3
    WIN_R_Y = CABIN_Y + (DOOR_W / 2)
    add_box("win_band_R", (0.05, WIN_R_L, WIN_H + 0.08), (CABIN_W / 2 + 0.01, WIN_R_Y, WIN_Z), mat_black)
    add_box("win_glass_R", (0.07, WIN_R_L - 0.1, WIN_H), (CABIN_W / 2 + 0.01, WIN_R_Y, WIN_Z), mat_glass)
    for w_i in range(7):
        py = WIN_R_Y - WIN_R_L / 2 + w_i * (WIN_R_L / 6)
        add_box(f"pillar_R_{w_i}", (0.09, 0.07, WIN_H + 0.06), (CABIN_W / 2 + 0.01, py, WIN_Z), mat_black)

    # 8. Rear Emergency Exit Door & Rear Windows
    REAR_Y = CABIN_Y + CABIN_L / 2 + 0.01
    add_box("rear_door", (0.95, 0.04, 1.85), (0, REAR_Y, CABIN_Z - 0.15), mat_yellow)
    add_box("rear_door_frame", (1.02, 0.05, 1.90), (0, REAR_Y - 0.01, CABIN_Z - 0.15), mat_black)
    add_box("rear_win_top", (0.74, 0.06, 0.65), (0, REAR_Y, CABIN_Z + 0.42), mat_glass)
    add_box("rear_win_bot", (0.55, 0.06, 0.48), (0, REAR_Y, CABIN_Z - 0.38), mat_glass)
    # Rear flanking windows
    for sd in (-1, 1):
        add_box(f"rear_flank_win_{sd}", (0.50, 0.05, 0.65), (sd * 0.95, REAR_Y, CABIN_Z + 0.42), mat_glass)

    # 9. Triple Black Rub Rails
    for sd in (-1, 1):
        rx = sd * (CABIN_W / 2 + 0.02)
        add_box(f"rub_floor_{sd}", (0.04, CABIN_L + 0.05, 0.08), (rx, CABIN_Y, CABIN_Z - 0.88), mat_black)
        add_box(f"rub_seat_{sd}", (0.04, CABIN_L + 0.05, 0.08), (rx, CABIN_Y, CABIN_Z - 0.42), mat_black)
        add_box(f"rub_sill_{sd}", (0.04, CABIN_L + 0.05, 0.08), (rx, CABIN_Y, CABIN_Z - 0.10), mat_black)

    # 10. Heavy-Duty Steel Bumpers
    add_box("front_bumper", (HOOD_W + 0.40, 0.32, 0.38), (0, HOOD_Y - HOOD_L / 2 - 0.16, 0.60), mat_black)
    add_box("rear_bumper", (CABIN_W + 0.15, 0.34, 0.40), (0, REAR_Y + 0.16, 0.60), mat_black)
    # Crossing safety arm on front bumper
    add_box("cross_arm", (1.20, 0.04, 0.08), (0.2, HOOD_Y - HOOD_L / 2 - 0.34, 0.60), mat_yellow)

    # 11. Large American Side-View Mirrors on Tubular Brackets
    for sd in (-1, 1):
        mx = sd * (CABIN_W / 2 + 0.32)
        my = HOOD_Y + HOOD_L * 0.25
        mz = WS_Z - 0.10
        # Horizontal bracket arms
        add_box(f"mirror_arm_top_{sd}", (0.35, 0.04, 0.04), (mx - sd * 0.16, my, mz + 0.35), mat_black)
        add_box(f"mirror_arm_bot_{sd}", (0.35, 0.04, 0.04), (mx - sd * 0.16, my, mz - 0.35), mat_black)
        # Vertical mirror body
        add_box(f"mirror_head_{sd}", (0.08, 0.18, 0.45), (mx, my, mz + 0.15), mat_black)
        add_box(f"mirror_glass_{sd}", (0.09, 0.16, 0.42), (mx - sd * 0.01, my + 0.01, mz + 0.15), mat_chrome)
        # Lower convex round mirror
        add_cyl(f"convex_mirror_{sd}", 0.11, 0.06, (mx, my, mz - 0.22), (math.radians(90), 0, 0), mat_chrome)

    # 12. Red Octagonal STOP Sign on Driver Side (Left side)
    STOP_X = -CABIN_W / 2 - 0.09
    STOP_Y = CABIN_Y - CABIN_L / 2 + 1.3
    STOP_Z = CABIN_Z - 0.15
    add_box("stop_bracket", (0.08, 0.06, 0.45), (STOP_X + 0.04, STOP_Y, STOP_Z), mat_black)
    add_cyl("stop_sign_blade", 0.30, 0.03, (STOP_X, STOP_Y, STOP_Z), (0, math.radians(90), 0), mat_stop_red)
    add_box("stop_sign_core", (0.04, 0.38, 0.14), (STOP_X, STOP_Y, STOP_Z), mat_white)

    # 13. Overhead "SCHOOL BUS" Headers & 8-Way Warning Lights
    for is_front in (True, False):
        hy = (WS_Y - 0.08) if is_front else (REAR_Y + 0.02)
        hz = CABIN_Z + CABIN_H / 2 + 0.06
        prefix = "front" if is_front else "rear"
        # Header black box
        add_box(f"{prefix}_header", (1.85, 0.10, 0.32), (0, hy, hz), mat_black)
        # "SCHOOL BUS" text plate
        add_box(f"{prefix}_textplate", (1.30, 0.12, 0.16), (0, hy + ( -0.01 if is_front else 0.01), hz), mat_sign_text)
        # 4 Warning Flashers (Amber inner, Red outer)
        for l_side in (-1, 1):
            add_cyl(f"{prefix}_amber_{l_side}", 0.10, 0.08, (l_side * 0.72, hy, hz), (math.radians(90), 0, 0), mat_amber_light)
            add_cyl(f"{prefix}_red_{l_side}", 0.10, 0.08, (l_side * 1.02, hy, hz), (math.radians(90), 0, 0), mat_red_light)

    # Amber Roof Marker Clearance Lights along front roof curve
    for rx in (-1.1, -0.2, 0.0, 0.2, 1.1):
        add_cyl(f"roof_marker_{rx}", 0.03, 0.04, (rx, WS_Y + 0.05, CABIN_Z + CABIN_H / 2 + 0.25), (math.radians(90), 0, 0), mat_amber_light)

    # 14. Wheels & Tires (Proper upright wheel orientation: rotate cylinder along Y axis: (0, pi/2, 0))
    # Wheel radius 0.52m (height to center = 0.52m)
    TIRE_R = 0.52
    TIRE_W = 0.30
    WHEEL_ROT = (0, math.radians(90), 0)

    # Front steer axle
    FRONT_AXLE_Y = HOOD_Y + 0.25
    for sd in (-1, 1):
        wx = sd * (CABIN_W / 2 - 0.14)
        add_cyl(f"tire_front_{sd}", TIRE_R, TIRE_W, (wx, FRONT_AXLE_Y, TIRE_R), WHEEL_ROT, mat_tire)
        add_cyl(f"rim_front_{sd}", TIRE_R * 0.65, TIRE_W + 0.02, (wx, FRONT_AXLE_Y, TIRE_R), WHEEL_ROT, mat_wheel_rim)
        add_cyl(f"hub_front_{sd}", TIRE_R * 0.22, TIRE_W + 0.05, (wx + sd * 0.02, FRONT_AXLE_Y, TIRE_R), WHEEL_ROT, mat_hub)
        # Wheel arch trim
        add_box(f"arch_front_{sd}", (0.08, 1.35, 0.65), (sd * (CABIN_W / 2 + 0.01), FRONT_AXLE_Y, TIRE_R + 0.20), mat_black)

    # Rear dual drive axle
    REAR_AXLE_Y = CABIN_Y + CABIN_L / 2 - 1.85
    for sd in (-1, 1):
        wx_out = sd * (CABIN_W / 2 - 0.12)
        wx_in  = sd * (CABIN_W / 2 - 0.44)
        # Outer tire
        add_cyl(f"tire_rear_out_{sd}", TIRE_R, TIRE_W, (wx_out, REAR_AXLE_Y, TIRE_R), WHEEL_ROT, mat_tire)
        # Inner tire
        add_cyl(f"tire_rear_in_{sd}",  TIRE_R, TIRE_W, (wx_in,  REAR_AXLE_Y, TIRE_R), WHEEL_ROT, mat_tire)
        # Deep dish rear rim
        add_cyl(f"rim_rear_{sd}", TIRE_R * 0.65, TIRE_W * 2.1, ((wx_out + wx_in) / 2, REAR_AXLE_Y, TIRE_R), WHEEL_ROT, mat_wheel_rim)
        add_cyl(f"hub_rear_{sd}", TIRE_R * 0.22, TIRE_W * 2.15, (wx_out + sd * 0.02, REAR_AXLE_Y, TIRE_R), WHEEL_ROT, mat_hub)
        # Wheel arch trim
        add_box(f"arch_rear_{sd}", (0.08, 1.45, 0.65), (sd * (CABIN_W / 2 + 0.01), REAR_AXLE_Y, TIRE_R + 0.20), mat_black)
        # Mudflaps behind rear wheels
        add_box(f"mudflap_{sd}", (0.34, 0.04, 0.42), (wx_out - sd * 0.08, REAR_AXLE_Y + 0.85, TIRE_R - 0.15), mat_black)

    # Under-chassis frame rail & battery box
    add_box("chassis_frame", (CABIN_W - 0.7, CABIN_L + 1.0, 0.22), (0, CABIN_Y - 0.3, 0.68), mat_black)
    add_box("battery_box", (0.35, 0.8, 0.35), (-CABIN_W / 2 + 0.2, CABIN_Y - 0.8, 0.55), mat_black)
    # Chrome exhaust tip on driver side rear
    add_cyl("exhaust_tip", 0.06, 0.30, (-CABIN_W / 2 + 0.25, REAR_AXLE_Y + 1.4, 0.45), (math.radians(90), 0, 0), mat_chrome)

    # Position & rotate root
    root.location = loc
    root.rotation_euler = (0, 0, yaw)
    return root

# Ground plane
bpy.ops.mesh.primitive_plane_add(size=40.0)
plane = bpy.context.active_object
mat_ground = make_mat("Ground", (0.28, 0.35, 0.22, 1.0), rough=0.9)
plane.data.materials.append(mat_ground)

# Sunlight
sun_data = bpy.data.lights.new("Sun", "SUN")
sun_data.energy = 4.0
sun_data.color = (1.0, 0.95, 0.88)
sun_obj = bpy.data.objects.new("Sun", sun_data)
sc.collection.objects.link(sun_obj)
sun_obj.rotation_euler = (math.radians(52), math.radians(24), math.radians(45))

# Sky ambient light
world = sc.world or bpy.data.worlds.new("World")
sc.world = world
world.use_nodes = True
bg = world.node_tree.nodes.get("Background")
if bg:
    bg.inputs["Color"].default_value = (0.55, 0.72, 0.95, 1.0)
    bg.inputs["Strength"].default_value = 0.85

# Build two buses
build_detailed_school_bus("Bus1", loc=(-4.0, 0, 0), yaw=math.radians(25))
build_detailed_school_bus("Bus2", loc=(4.0, 2.5, 0), yaw=math.radians(-40))

# Camera
cam_data = bpy.data.cameras.new("Cam")
cam_data.lens = 32.0
cam_obj = bpy.data.objects.new("Cam", cam_data)
sc.collection.objects.link(cam_obj)
sc.camera = cam_obj
cam_obj.location = (0, -14.0, 4.5)
aim = Vector((0, 0, 1.5)) - Vector(cam_obj.location)
cam_obj.rotation_euler = aim.to_track_quat("-Z", "Y").to_euler()

sc.render.resolution_x = 960
sc.render.resolution_y = 540
sc.render.filepath = os.path.join(OUT_DIR, "test_school_bus.png")
print("Rendering test_school_bus.png ...", flush=True)
bpy.ops.render.render(write_still=True)
print("Done test_school_bus.png!", flush=True)
