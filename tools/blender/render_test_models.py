import bpy
import os
import math
from mathutils import Vector

OUT_DIR = os.path.join(os.path.dirname(__file__), "preview")
os.makedirs(OUT_DIR, exist_ok=True)

def render_model(glb_path, out_name, cam_pos, cam_target, light_energy=4.0):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=glb_path)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = 24
    sc.cycles.use_adaptive_sampling = True
    sc.render.film_transparent = True
    
    # Sun
    sun_data = bpy.data.lights.new("Sun", "SUN")
    sun_data.energy = light_energy
    sun_obj = bpy.data.objects.new("Sun", sun_data)
    sc.collection.objects.link(sun_obj)
    sun_obj.rotation_euler = (math.radians(45), math.radians(30), math.radians(45))
    
    # Cam
    cam_data = bpy.data.cameras.new("Cam")
    cam_data.lens = 35
    cam_obj = bpy.data.objects.new("Cam", cam_data)
    sc.collection.objects.link(cam_obj)
    sc.camera = cam_obj
    cam_obj.location = cam_pos
    aim = Vector(cam_target) - Vector(cam_pos)
    cam_obj.rotation_euler = aim.to_track_quat("-Z", "Y").to_euler()
    
    sc.render.resolution_x = 960
    sc.render.resolution_y = 540
    out_path = os.path.join(OUT_DIR, f"{out_name}.png")
    sc.render.filepath = out_path
    print(f"Rendering {out_name} -> {out_path} ...", flush=True)
    bpy.ops.render.render(write_still=True)
    print(f"Done {out_name}!", flush=True)

# Render Koi Fish (Bounding box was ~6m along X, center ~(-0.25, 0.52, 0.27))
render_model(
    "/Users/jaikeerthanchowdarybonam/Desktop/game/koi_fish 1.glb",
    "test_koi_imported",
    cam_pos=(0, -8.0, 3.5),
    cam_target=(0, 0, 0)
)

# Render Phoenix Bird (Bounding box was ~920 along X, 500 along Y, 650 along Z, center ~(-288, 1, 271))
render_model(
    "/Users/jaikeerthanchowdarybonam/Desktop/game/phoenix_bird.glb",
    "test_phoenix_imported",
    cam_pos=(-288, -1200, 500),
    cam_target=(-288, 0, 270)
)
