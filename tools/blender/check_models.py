
import bpy
from mathutils import Vector

def check_model(path):
    print("--------------------------------------------------")
    print("Checking:", path)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    print(f"Total mesh objects: {len(objs)}")
    
    all_min = Vector((float("inf"), float("inf"), float("inf")))
    all_max = Vector((float("-inf"), float("-inf"), float("-inf")))
    
    for o in objs:
        print(f"Mesh: {o.name}, parent: {o.parent.name if o.parent else None}")
        for v in o.bound_box:
            world_v = o.matrix_world @ Vector(v)
            for i in range(3):
                all_min[i] = min(all_min[i], world_v[i])
                all_max[i] = max(all_max[i], world_v[i])
                
    dims = all_max - all_min
    center = (all_max + all_min) / 2
    print(f"Bounding Box Min: {all_min}")
    print(f"Bounding Box Max: {all_max}")
    print(f"Dimensions (X, Y, Z): {dims}")
    print(f"Center: {center}")
    
    if bpy.data.actions:
        print("Actions/Animations:")
        for a in bpy.data.actions:
            print(f"  Action: {a.name}, frame range: {a.frame_range}")

check_model("/Users/jaikeerthanchowdarybonam/Desktop/game/koi_fish 1.glb")
check_model("/Users/jaikeerthanchowdarybonam/Desktop/game/phoenix_bird.glb")
