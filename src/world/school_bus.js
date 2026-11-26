// Cedar Lodge school buses: two original Type-C buses ("CEDAR VALLEY SCHOOLS") built in Blender
// (tools/blender/build_lodge_props.py), rounded body panels, dual rear wheels, interior seats behind tinted glass,
// baked PBR atlas (albedo / normal / ORM) with road grime, sun fade, rust and dirt streaks.
// bus_clean = lightly weathered; bus_old = dusty, rusty, two flat tyres and a sag (its own atlas, same UV layout).
// Cost: 2 draw calls per bus (body atlas + glass), ~20k triangles each.
import { smoothPaint } from './paint.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { F_DEFAULT, S_METAL } from '../core/physics.js';
import { LODGE_PROPS_GLB } from './lodge_props_asset.js';

function decodeBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

let propsPromise = null;
/** Parses the shared props GLB once (buses + pond set). Resolves to the glTF result. */
export function loadLodgeProps() {
  if (!propsPromise) {
    propsPromise = new Promise((resolve, reject) => {
      try { new GLTFLoader().parse(decodeBase64(LODGE_PROPS_GLB), '', resolve, reject); } catch (e) { reject(e); }
    });
  }
  return propsPromise;
}

/** Adds segmented collision boxes along the yawed bus body (7 short AABBs so a yawed bus stays tight). */
function addBusColliders(world, x, z, yaw, yBase) {
  const W = 2.6, H = 3.2;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  // many short boxes: the axis-aligned box of a rotated segment grows with its length,
  // and 3 long ones stuck out about 1 m past the sides of the yawed bus
  const segments = [-4.71, -3.14, -1.57, 0, 1.57, 3.14, 4.71];
  const halfSeg = 0.8, halfW = W / 2;
  const ex = Math.abs(c) * halfW + Math.abs(s) * halfSeg;
  const ez = Math.abs(s) * halfW + Math.abs(c) * halfSeg;
  for (const seg of segments) {
    const sx = x + s * seg;
    const sz = z + c * seg;
    world.addBox(sx - ex, yBase, sz - ez, sx + ex, yBase + H, sz + ez, F_DEFAULT, S_METAL);
  }
}

/**
 * Builds the two school buses between the lodges.
 * @param {(x:number, z:number)=>number} groundAt Terrain height function
 * @param {object} world Physics world for adding colliders
 */
export function buildSchoolBuses(groundAt, world) {
  const group = new THREE.Group();
  group.name = 'school_buses';

  const BUS_CONFIGS = [
    { x: -24.0, z: 28.5, yaw: -0.35, model: 'bus_clean' },
    { x: -16.5, z: 36.5, yaw: 1.18, model: 'bus_old' },
  ];

  // physics first: it must not wait for the (async) model parse
  for (const { x, z, yaw } of BUS_CONFIGS) {
    if (world) addBusColliders(world, x, z, yaw, groundAt(x, z));
  }

  const owned = [];
  let disposed = false;
  loadLodgeProps().then((gltf) => {
    if (disposed) return;
    BUS_CONFIGS.forEach(({ x, z, yaw, model }, i) => {
      const src = gltf.scene.getObjectByName(model);
      if (!src) return;
      src.parent.remove(src);
      src.name = `school_bus_${i + 1}`;
      src.traverse((o) => {
        if (!o.isMesh) return;
        const glass = /glass/.test(o.name);
        o.castShadow = !glass;
        o.receiveShadow = !glass;
        const m = o.material;
        if (glass) {
          m.transparent = true;
          m.depthWrite = false;
          m.opacity = 0.68;
          m.roughness = 0.10;
          m.metalness = 0.05;
          m.envMapIntensity = 2.4;
          m.side = THREE.FrontSide;
          o.renderOrder = 2;
        } else {
          m.envMapIntensity = 1.35;
          smoothPaint(m, 0.62);   // calm blotches while keeping gentle school-bus weathering
          m.customProgramCacheKey = () => 'lodge-bus-ao-v1';
          m.onBeforeCompile = (s) => {
            s.vertexShader = s.vertexShader
              .replace('#include <common>', '#include <common>\nvarying float vBusY;')
              .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBusY = transformed.y;');
            s.fragmentShader = s.fragmentShader
              .replace('#include <common>', '#include <common>\nvarying float vBusY;')
              .replace('#include <color_fragment>', `#include <color_fragment>
                diffuseColor.rgb *= mix(0.58, 1.0, smoothstep(0.05, 0.72, vBusY));`);
          };
          m.needsUpdate = true;
        }
        owned.push(o);
      });
      // sit the bus on the slope: pitch from the ground under the axles
      const L = 3.6, sy = Math.sin(yaw), cy = Math.cos(yaw);   // local -Z (front) maps to (-sin, -cos)
      const fy = groundAt(x - sy * L, z - cy * L), ry = groundAt(x + sy * L, z + cy * L);
      src.rotation.order = 'YXZ';
      src.rotation.set(THREE.MathUtils.clamp(Math.atan2(fy - ry, 2 * L), -0.12, 0.12), yaw, 0);
      src.position.set(x, Math.max(fy, ry) * 0.5 + Math.min(fy, ry) * 0.5, z);
      group.add(src);
    });
  }).catch((e) => console.warn('school bus props failed to load', e));

  return {
    group,
    dispose() {
      disposed = true;
      const seen = new Set();
      for (const o of owned) {
        o.geometry.dispose();
        const m = o.material;
        if (seen.has(m)) continue;
        seen.add(m);
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) if (m[k]) m[k].dispose();
        m.dispose();
      }
    },
  };
}
