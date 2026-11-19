// The Cedar Lodge koi pond, in one place. The physics basin (lodge.js groundAt),
// the hole cut in the terrain (terrain.js) and the pond meshes (pond.js) all read
// this, so they can't drift apart.

export const POND = { x: -18.5, z: 20.0, depth: 1.52 };

/** Rim radius (m) at angle th = atan2(dx, dz) around the pond centre: an organic wobbly circle. */
export function pondRadius(th) {
  return 3.9 + 0.58 * Math.sin(2 * th + 0.5) + 0.35 * Math.cos(3 * th - 0.7) + 0.22 * Math.sin(5 * th + 1.1) + 0.15 * Math.cos(7 * th);
}

/** True inside the rim, with an optional margin (m, positive = smaller area). */
export function inPond(x, z, margin = 0) {
  const dx = x - POND.x, dz = z - POND.z;
  return Math.hypot(dx, dz) < pondRadius(Math.atan2(dx, dz)) - margin;
}

/** How far the ground drops at (x, z): 0 at the rim, the full depth from halfway in. */
export function pondDrop(x, z) {
  const dx = x - POND.x, dz = z - POND.z, d = Math.hypot(dx, dz), r = pondRadius(Math.atan2(dx, dz));
  return d < r ? Math.min(1, (1 - d / r) * 2) * POND.depth : 0;
}

/** The same rim in GLSL: `float pondRadiusGL(float th)` plus the centre as a vec2 constant. */
export const POND_GLSL = `
  const vec2 POND_C = vec2(${POND.x.toFixed(3)}, ${POND.z.toFixed(3)});
  float pondRadiusGL(float th) {
    return 3.9 + 0.58 * sin(2.0 * th + 0.5) + 0.35 * cos(3.0 * th - 0.7) + 0.22 * sin(5.0 * th + 1.1) + 0.15 * cos(7.0 * th);
  }`;
