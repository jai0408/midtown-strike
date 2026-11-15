// Decoder for the compact meshes written by tools/blender/build_weapons.py and
// tools/blender/build_vehicles.py.
//
// Layout of the base64 payload, for nv vertices and ni indices:
//   int16  x,y,z   * nv   position * meta.scale
//   int8   x,y,z   * nv   normal * 127
//   uint8  r,g,b,m * nv   sRGB colour with the baked occlusion already multiplied in;
//                         m = (material class << 2) | paint mask. Paint mask: 0 fixed
//                         colour, 1 body paint, 2 second paint. Material class indexes
//                         MAT_CLASSES in core/pbr.js (roughness, metalness).
//                         Painted vertices store a grey shade that multiplies the tint.
//   uint16 index   * ni
import * as THREE from 'three';
import { MAT_CLASSES } from './pbr.js';

const SRGB = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const cache = new Map();

/** meta: { verts, tris, scale }. Returns { pos, nor, col (linear), mask, rm, idx, nv, ni }. */
export function decodeMesh(b64, meta) {
  let m = cache.get(b64);
  if (m) return m;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const nv = meta.verts, ni = meta.tris * 3;
  const dv = new DataView(bytes.buffer);
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
  const mask = new Uint8Array(nv), rm = new Float32Array(nv * 2), idx = new Uint16Array(ni);
  let o = 0;
  for (let i = 0; i < nv * 3; i++, o += 2) pos[i] = dv.getInt16(o, true) / meta.scale;
  for (let i = 0; i < nv * 3; i++, o++) nor[i] = dv.getInt8(o) / 127;
  for (let i = 0; i < nv; i++, o += 4) {
    col[i * 3] = SRGB[bytes[o]];
    col[i * 3 + 1] = SRGB[bytes[o + 1]];
    col[i * 3 + 2] = SRGB[bytes[o + 2]];
    mask[i] = bytes[o + 3] & 3;
    const cls = MAT_CLASSES[bytes[o + 3] >> 2] || MAT_CLASSES[0];
    rm[i * 2] = cls[0]; rm[i * 2 + 1] = cls[1];
  }
  for (let i = 0; i < ni; i++, o += 2) idx[i] = dv.getUint16(o, true);
  m = { pos, nor, col, mask, rm, idx, nv, ni };
  cache.set(b64, m);
  return m;
}

/** Stand-alone geometry (weapons). */
export function meshGeometry(b64, meta) {
  const m = decodeMesh(b64, meta);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(m.col, 3));
  g.setAttribute('rm', new THREE.BufferAttribute(m.rm, 2));
  g.setIndex(new THREE.BufferAttribute(m.idx, 1));
  g.computeBoundingSphere();
  return g;
}
