// Shared physically-based material for everything exported from Blender and
// for the merged city geometry.
//
// Colour comes from vertex colours (and an optional map). Roughness and
// metalness come per vertex from the `rm` attribute, which the mesh decoder
// fills from the material class stored with each vertex (see MAT_CLASSES).
import * as THREE from 'three';

/** Material classes: index -> [roughness, metalness]. Keep in sync with tools/blender/*.py. */
export const MAT_CLASSES = [
  [0.85, 0.0],  // 0  matte / painted concrete / default
  [0.30, 0.35], // 1  car paint (glossy lacquer)
  [0.42, 0.90], // 2  gunmetal / parkerized or anodized dark metal
  [0.28, 1.00], // 3  bare steel, blades, worn edges
  [0.58, 0.00], // 4  polymer / plastic furniture
  [0.92, 0.00], // 5  rubber, tyres
  [0.62, 0.00], // 6  wood (oiled)
  [0.08, 0.85], // 7  glass (dark, mirror-like)
  [0.95, 0.00], // 8  fabric / webbing
  [0.14, 1.00], // 9  chrome / polished metal
  [0.10, 0.40], // 10 lens / coated optics
  [0.70, 0.60], // 11 rough cast metal, rusty or dirty steel
];
export const MAT = {
  matte: 0, paint: 1, gunmetal: 2, steel: 3, polymer: 4, rubber: 5, wood: 6, glass: 7, fabric: 8, chrome: 9, lens: 10, cast: 11,
};

const NOISE = /* glsl */`
  float pbrHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float pbrNoise(vec3 x) {
    vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(pbrHash(i), pbrHash(i + vec3(1,0,0)), f.x), mix(pbrHash(i + vec3(0,1,0)), pbrHash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(pbrHash(i + vec3(0,0,1)), pbrHash(i + vec3(1,0,1)), f.x), mix(pbrHash(i + vec3(0,1,1)), pbrHash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }`;

/**
 * MeshStandardMaterial driven by vertex attributes.
 *   rm:    read roughness/metalness from the `rm` vec2 attribute
 *   grain: object-space noise frequency (1/m) that breaks up roughness and
 *          albedo so large flat surfaces do not look like plastic; 0 = off
 */
export function pbrMaterial({ rm = true, grain = 0, grainAmount = 0.18, ...params } = {}) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: rm ? 1 : 0.8, metalness: rm ? 1 : 0, ...params });
  m.onBeforeCompile = (s) => {
    s.uniforms.uGrain = { value: grain };
    s.uniforms.uGrainAmt = { value: grainAmount };
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>\n${rm ? 'attribute vec2 rm; varying vec2 vRm;' : ''}\nvarying vec3 vObj;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${rm ? 'vRm = rm;' : ''}\nvObj = position;`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\n${rm ? 'varying vec2 vRm;' : ''}\nvarying vec3 vObj;\nuniform float uGrain, uGrainAmt;\n${NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float pbrN = uGrain > 0.0 ? pbrNoise(vObj * uGrain) * 0.65 + pbrNoise(vObj * uGrain * 4.3) * 0.35 : 0.5;
        diffuseColor.rgb *= 1.0 + (pbrN - 0.5) * uGrainAmt * 0.6;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        ${rm ? 'roughnessFactor *= vRm.x;' : ''}
        roughnessFactor = clamp(roughnessFactor + (pbrN - 0.5) * uGrainAmt, 0.04, 1.0);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${rm ? 'metalnessFactor *= vRm.y;' : ''}`);
  };
  m.customProgramCacheKey = () => `pbr|${rm}`;
  return m;
}
