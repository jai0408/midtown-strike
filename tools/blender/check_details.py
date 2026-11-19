import bpy
from mathutils import Vector

def inspect_details(path):
    print("==================================================")
    print("Inspecting:", path)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    for obj in bpy.context.scene.objects:
        if obj.type == 'MESH':
            print(f"Object: {obj.name}, parent: {obj.parent.name if obj.parent else None}")
            me = obj.data
            print(f"  Verts: {len(me.vertices)}, Polys: {len(me.polygons)}")
            xs = [v.co.x for v in me.vertices]
            ys = [v.co.y for v in me.vertices]
            zs = [v.co.z for v in me.vertices]
            print(f"  Local X: [{min(xs):.3f}, {max(xs):.3f}]")
            print(f"  Local Y: [{min(ys):.3f}, {max(ys):.3f}]")
            print(f"  Local Z: [{min(zs):.3f}, {max(zs):.3f}]")
            if me.shape_keys:
                print(f"  Shape keys ({len(me.shape_keys.key_blocks)}): {[k.name for k in me.shape_keys.key_blocks[:10]]}")
        elif obj.type == 'ARMATURE':
            print(f"Armature: {obj.name}, bones: {len(obj.data.bones)}")
            for b in obj.data.bones[:8]:
                print(f"  Bone: {b.name}")

inspect_details('/Users/jaikeerthanchowdarybonam/Desktop/game/koi_fish 1.glb')
inspect_details('/Users/jaikeerthanchowdarybonam/Desktop/game/phoenix_bird.glb')
