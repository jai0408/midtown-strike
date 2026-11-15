// Vehicles (tools/blender/build_vehicles.py): decoder for the compact meshes and the
// shared material that samples the ONE 1024 atlas (albedo / normal / orm).
//
// Vertex layout (nv vertices, ni indices, little endian):
//   int16 x,y,z * nv   position * meta.scale
//   int8  x,y,z * nv   normal * 127
//   uint8 ao    * nv   baked occlusion x grime (multiplies the albedo)
//   uint8 mask  * nv   paint mask: 0 fixed colour, 1 body paint, 2 second paint
//   uint16 u,v  * nv   atlas uv * 65535 (v = 0 at the top row of the atlas)
//   uint16 index * ni
//
// Per vertex the city builder stores colour = paint tint (white for fixed parts) and the
// `rm` attribute as (ao, burnt): the shader multiplies the tint in only where the atlas ORM
// red channel says "body paint", so plates, lamps, grilles and glass keep their own colours.
import * as THREE from 'three';
import { VEHICLE_ATLAS } from './vehicles_asset.js';

const cache = new Map();

/** Returns { pos, nor, ao, mask, uv, idx, nv, ni } (floats, 0..1 for ao/uv). */
export function decodeVehicle(b64, meta) {
  let m = cache.get(b64);
  if (m) return m;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const nv = meta.verts, ni = meta.tris * 3;
  const dv = new DataView(bytes.buffer);
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), ao = new Float32Array(nv);
  const mask = new Uint8Array(nv), uv = new Float32Array(nv * 2), idx = new Uint16Array(ni);
  let o = 0;
  for (let i = 0; i < nv * 3; i++, o += 2) pos[i] = dv.getInt16(o, true) / meta.scale;
  for (let i = 0; i < nv * 3; i++, o++) nor[i] = dv.getInt8(o) / 127;
  for (let i = 0; i < nv; i++, o++) ao[i] = bytes[o] / 255;
  for (let i = 0; i < nv; i++, o++) mask[i] = bytes[o];
  for (let i = 0; i < nv * 2; i++, o += 2) uv[i] = dv.getUint16(o, true) / 65535;
  for (let i = 0; i < ni; i++, o += 2) idx[i] = dv.getUint16(o, true);
  m = { pos, nor, ao, mask, uv, idx, nv, ni };
  cache.set(b64, m);
  return m;
}

/** The city 'veh' material family: MeshStandardMaterial + atlas, tint through the ORM mask. */
export function vehicleMaterial() {
  const loader = new THREE.TextureLoader();
  const tex = (url, srgb) => {
    const t = loader.load(url);
    t.flipY = false;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 4;
    return t;
  };
  const orm = tex(VEHICLE_ATLAS.orm, false);
  const m = new THREE.MeshStandardMaterial({
    map: tex(VEHICLE_ATLAS.albedo, true), normalMap: tex(VEHICLE_ATLAS.normal, false),
    roughnessMap: orm, metalnessMap: orm, roughness: 1, metalness: 1, vertexColors: true,
  });
  m.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 rm;\nvarying vec2 vRm;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRm = rm;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vRm;')
      .replace('#include <color_fragment>', `
        float vpMask = texture2D(roughnessMap, vRoughnessMapUv).r;
        diffuseColor.rgb *= mix(vec3(1.0), vColor.rgb, vpMask) * vRm.x;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03), vRm.y);`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, 0.95, vRm.y);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n metalnessFactor *= 1.0 - vRm.y;');
  };
  m.customProgramCacheKey = () => 'vehicle-atlas';
  return m;
}
