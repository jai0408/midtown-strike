// Procedural soldier: one rigid-skinned mesh (a single draw call), a 16-bone
// skeleton and a hand-written animation layer (locomotion, stances, two-bone
// arm IK onto the weapon, reload, melee, death).
//
// The model faces -Z. US Marine kit: woodland MARPAT utilities, coyote plate
// carrier and boots, helmet with camouflage cover, shoulder flag and tape.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { KIT, soldierTexture, glowTexture } from '../world/textures.js';
import { clamp, damp, lerp, smooth, RNG } from '../core/util.js';
import { makeWeaponModel } from '../game/weapons.js';
import { SOLDIER_META, SOLDIER_MESH, SOLDIER_COLOR, SOLDIER_AO, SOLDIER_NORMAL, SOLDIER_ORM } from './soldier_asset.js';

// name, parent index, rest position in model space
const RIG = [
  ['hips', -1, 0, 0.95, 0],
  ['spine', 0, 0, 1.05, 0],
  ['chest', 1, 0, 1.25, 0],
  ['head', 2, 0, 1.52, 0],
  ['armL', 2, -0.225, 1.49, 0], ['foreL', 4, -0.225, 1.21, 0], ['handL', 5, -0.225, 0.95, 0],
  ['armR', 2, 0.225, 1.49, 0], ['foreR', 7, 0.225, 1.21, 0], ['handR', 8, 0.225, 0.95, 0],
  ['thighL', 0, -0.1, 0.93, 0], ['shinL', 10, -0.1, 0.5, 0], ['footL', 11, -0.1, 0.07, 0],
  ['thighR', 0, 0.1, 0.93, 0], ['shinR', 13, 0.1, 0.5, 0], ['footR', 14, 0.1, 0.07, 0],
];
const BI = {};
RIG.forEach((r, i) => (BI[r[0]] = i));
const HIPS_Y = 0.95;
const UPPER = 0.28, FORE = 0.26;      // shoulder -> elbow -> wrist
const THIGH = 0.43, SHIN = 0.43;      // hip joint -> knee -> ankle
const ANKLE = 0.07;                   // ankle height with the sole flat on the ground

// ---------------------------------------------------------------------------
// Geometry (built once, shared by every soldier)
// ---------------------------------------------------------------------------
let sharedGeometry = null;

function buildGeometry() {
  const parts = [];
  const rng = new RNG(7);
  const CAMO_W = 0.78, CAMO_H = 1.56; // metres covered by the camouflage swatch

  const finish = (g, bone, kit) => {
    g = g.index ? g : g.toNonIndexed();
    const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
    const rect = KIT[kit];
    if (kit === 'camo') {
      g.computeBoundingBox();
      const bb = g.boundingBox;
      const sx = bb.max.x - bb.min.x, sy = bb.max.y - bb.min.y, sz = bb.max.z - bb.min.z;
      const offA = rng.next() * Math.max(0, CAMO_W - Math.max(sx, sz) - 0.02);
      const offB = rng.next() * Math.max(0, CAMO_H - Math.max(sy, sz) - 0.02);
      for (let i = 0; i < pos.count; i++) {
        const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i)), az = Math.abs(nor.getZ(i));
        let a, b;
        if (ay > ax && ay > az) { a = pos.getX(i) - bb.min.x; b = pos.getZ(i) - bb.min.z; }
        else if (ax > az) { a = pos.getZ(i) - bb.min.z; b = pos.getY(i) - bb.min.y; }
        else { a = pos.getX(i) - bb.min.x; b = pos.getY(i) - bb.min.y; }
        uv.setXY(i, rect[0] + ((a + offA) / CAMO_W) * (rect[2] - rect[0]), rect[1] + ((b + offB) / CAMO_H) * (rect[3] - rect[1]));
      }
    } else if (kit === 'flag' || kit === 'tape') {
      for (let i = 0; i < uv.count; i++) uv.setXY(i, rect[0] + uv.getX(i) * (rect[2] - rect[0]), rect[1] + uv.getY(i) * (rect[3] - rect[1]));
    } else {
      for (let i = 0; i < uv.count; i++) uv.setXY(i, rect[0] + (0.2 + 0.6 * uv.getX(i)) * (rect[2] - rect[0]), rect[1] + (0.2 + 0.6 * uv.getY(i)) * (rect[3] - rect[1]));
    }
    const n = pos.count;
    const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { si[i * 4] = BI[bone]; sw[i * 4] = 1; }
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    parts.push(g);
  };
  const box = (bone, kit, w, h, d, x, y, z, rx = 0) => {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rx) g.rotateX(rx);
    g.translate(x, y, z);
    finish(g, bone, kit);
  };
  const cyl = (bone, kit, rTop, rBot, yTop, yBot, x, z, seg = 8) => {
    const g = new THREE.CylinderGeometry(rTop, rBot, yTop - yBot, seg, 1);
    g.translate(x, (yTop + yBot) / 2, z);
    finish(g, bone, kit);
  };
  const sph = (bone, kit, r, x, y, z, sx = 1, sy = 1, sz = 1, ws = 8, hs = 6, thetaLen = Math.PI) => {
    const g = new THREE.SphereGeometry(r, ws, hs, 0, Math.PI * 2, 0, thetaLen);
    g.scale(sx, sy, sz);
    g.translate(x, y, z);
    finish(g, bone, kit);
  };
  const plane = (bone, kit, w, h, x, y, z, ry = 0) => {
    const g = new THREE.PlaneGeometry(w, h);
    g.rotateY(ry);
    g.translate(x, y, z);
    finish(g, bone, kit);
  };

  // pelvis and belt
  box('hips', 'camo', 0.35, 0.21, 0.23, 0, 0.965, 0);
  box('hips', 'gear', 0.37, 0.055, 0.25, 0, 1.055, 0);
  box('hips', 'gearDark', 0.09, 0.14, 0.06, 0.2, 0.98, 0.02);   // holster
  box('hips', 'gearDark', 0.1, 0.11, 0.06, -0.2, 0.99, 0.03);   // dump pouch
  // torso
  box('spine', 'camo', 0.33, 0.22, 0.21, 0, 1.15, 0);
  box('chest', 'camo', 0.4, 0.28, 0.23, 0, 1.385, 0);
  // plate carrier
  box('chest', 'gear', 0.31, 0.34, 0.05, 0, 1.345, -0.135);
  box('chest', 'gear', 0.31, 0.34, 0.05, 0, 1.345, 0.135);
  box('chest', 'gear', 0.035, 0.15, 0.25, 0.185, 1.26, 0);
  box('chest', 'gear', 0.035, 0.15, 0.25, -0.185, 1.26, 0);
  box('chest', 'gear', 0.07, 0.035, 0.27, 0.115, 1.525, 0);
  box('chest', 'gear', 0.07, 0.035, 0.27, -0.115, 1.525, 0);
  for (const x of [-0.095, 0, 0.095]) box('chest', 'gearDark', 0.08, 0.14, 0.045, x, 1.25, -0.18); // magazines
  box('chest', 'gearDark', 0.07, 0.11, 0.05, -0.12, 1.41, -0.175);  // radio
  box('chest', 'black', 0.02, 0.16, 0.02, -0.14, 1.52, -0.14);     // antenna
  box('chest', 'gearDark', 0.24, 0.3, 0.075, 0, 1.36, 0.195);       // hydration pack
  box('chest', 'gearDark', 0.12, 0.1, 0.06, 0.1, 1.22, 0.19);       // IFAK
  plane('chest', 'tape', 0.17, 0.034, 0, 1.47, -0.1615, Math.PI);
  // neck, head, helmet
  cyl('head', 'skin', 0.052, 0.058, 1.62, 1.5, 0, 0);
  sph('head', 'skin', 0.104, 0, 1.69, -0.008, 0.96, 1.16, 1.04, 10, 8);
  box('head', 'black', 0.175, 0.046, 0.05, 0, 1.705, -0.098);      // ballistic eyewear
  box('head', 'skin', 0.03, 0.04, 0.03, 0, 1.665, -0.108);          // nose
  // helmet: a close-fitting dome that drops lower over the ears and nape
  sph('head', 'camo', 0.13, 0, 1.712, 0.006, 1.07, 1.06, 1.2, 10, 6, Math.PI * 0.55);
  box('head', 'camo', 0.262, 0.07, 0.15, 0, 1.672, 0.075);          // nape + ear cover
  box('head', 'black', 0.05, 0.045, 0.03, 0, 1.775, -0.152);        // NVG mount
  box('head', 'gearDark', 0.03, 0.08, 0.07, 0.137, 1.665, 0.0);     // headset
  box('head', 'gearDark', 0.03, 0.08, 0.07, -0.137, 1.665, 0.0);
  box('head', 'black', 0.012, 0.012, 0.09, -0.14, 1.645, -0.06);    // boom mic
  box('head', 'gear', 0.02, 0.02, 0.22, 0.137, 1.735, 0.0);         // side rails
  box('head', 'gear', 0.02, 0.02, 0.22, -0.137, 1.735, 0.0);

  for (const s of [-1, 1]) {
    const L = s < 0 ? 'L' : 'R';
    const x = s * 0.225;
    // arms
    sph('arm' + L, 'camo', 0.074, x, 1.49, 0, 1, 1, 1, 8, 6);
    cyl('arm' + L, 'camo', 0.062, 0.053, 1.49, 1.21, x, 0);
    plane('arm' + L, 'flag', 0.075, 0.05, x + s * 0.0625, 1.4, 0, s * Math.PI / 2);
    sph('fore' + L, 'camo', 0.056, x, 1.21, 0, 1, 1, 1, 8, 6);
    cyl('fore' + L, 'camo', 0.051, 0.042, 1.21, 0.95, x, 0);
    box('fore' + L, 'gearDark', 0.085, 0.1, 0.075, x, 1.19, 0.035);  // elbow pad
    box('hand' + L, 'glove', 0.075, 0.105, 0.09, x, 0.9, 0);
    box('hand' + L, 'gearDark', 0.085, 0.03, 0.095, x, 0.945, 0);
    // legs
    const lx = s * 0.1;
    cyl('thigh' + L, 'camo', 0.092, 0.074, 0.95, 0.5, lx, 0);
    box('thigh' + L, 'camo', 0.07, 0.15, 0.13, lx + s * 0.085, 0.72, 0); // cargo pocket
    sph('shin' + L, 'camo', 0.077, lx, 0.5, 0, 1, 1, 1, 8, 6);
    box('shin' + L, 'gearDark', 0.115, 0.13, 0.07, lx, 0.5, -0.06);     // knee pad
    cyl('shin' + L, 'camo', 0.07, 0.06, 0.5, 0.17, lx, 0);
    cyl('shin' + L, 'boot', 0.064, 0.06, 0.2, 0.06, lx, 0);
    box('foot' + L, 'boot', 0.105, 0.085, 0.27, lx, 0.052, -0.055);
    box('foot' + L, 'black', 0.11, 0.022, 0.275, lx, 0.011, -0.055);
  }
  const g = mergeGeometries(parts, false);
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------------------
// Blender-built model (tools/blender/build_soldier_glb.py): the owner's scanned
// soldier, decimated and smooth-skinned to the rig above, with baked colour,
// tangent-space normal, ORM (G roughness, B metalness) and occlusion maps.
// `baked` stays null if decoding fails, and the game then falls back to the
// procedural model above.
// ---------------------------------------------------------------------------
let baked = null;

async function inflate(b64) {
  const bin = atob(b64), raw = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// planes: px py pz (int16, delta) | nx ny nz (int8) | u v (uint16, delta) | bone a, bone b, weight a (uint8) | indices (uint16, delta)
async function decodeMesh() {
  const bytes = await inflate(SOLDIER_MESH), n = SOLDIER_META.verts, T = SOLDIER_META.tris;
  let off = 0;
  const plane16 = (cnt, signed) => {
    const a = new Uint16Array(bytes.buffer.slice(off, off + cnt * 2)), out = signed ? new Int16Array(cnt) : new Uint16Array(cnt);
    off += cnt * 2;
    let acc = 0;
    for (let i = 0; i < cnt; i++) { acc = (acc + a[i]) & 0xffff; out[i] = acc; }
    return out;
  };
  const plane8 = (cnt, signed) => {
    const a = signed ? new Int8Array(bytes.buffer.slice(off, off + cnt)) : new Uint8Array(bytes.buffer.slice(off, off + cnt));
    off += cnt;
    return a;
  };
  const px = plane16(n, true), py = plane16(n, true), pz = plane16(n, true);
  const nx = plane8(n, true), ny = plane8(n, true), nz = plane8(n, true);
  const us = plane16(n, false), vs = plane16(n, false);
  const ba = plane8(n), bb = plane8(n), wa = plane8(n);
  const index = plane16(T * 3, false);
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = px[i] / SOLDIER_META.scale; pos[i * 3 + 1] = py[i] / SOLDIER_META.scale; pos[i * 3 + 2] = pz[i] / SOLDIER_META.scale;
    const x = nx[i] / 127, y = ny[i] / 127, z = nz[i] / 127, l = Math.hypot(x, y, z) || 1;
    nor[i * 3] = x / l; nor[i * 3 + 1] = y / l; nor[i * 3 + 2] = z / l;
    uv[i * 2] = us[i] / 65535; uv[i * 2 + 1] = vs[i] / 65535;
    si[i * 4] = ba[i]; si[i * 4 + 1] = bb[i];
    sw[i * 4] = wa[i] / 255; sw[i * 4 + 1] = 1 - wa[i] / 255;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeTangents(); // normal map basis (needs index, position, normal, uv)
  g.computeBoundingSphere();
  return g;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('soldier map failed to decode'));
    img.src = src;
  });
}

function imageData(src, size) {
  return loadImage(src).then((img) => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, size, size);
    return g.getImageData(0, 0, size, size).data;
  });
}

/** Decodes the Blender asset. Call once before the first Soldier is created. */
export async function loadSoldierAssets() {
  try {
    const size = SOLDIER_META.tex;
    const [geometry, color, ao, normalImg, ormImg] = await Promise.all([
      decodeMesh(), loadImage(SOLDIER_COLOR), imageData(SOLDIER_AO, size), loadImage(SOLDIER_NORMAL), loadImage(SOLDIER_ORM),
    ]);
    baked = { geometry, color, ao, size, normalImg, ormImg };
  } catch (e) {
    baked = null;
  }
  return !!baked;
}

// Team looks are made from the one colour map. 'marine' keeps it as scanned; 'enemy' is
// desaturated and multiplied towards a dark charcoal / blue-grey so the teams read apart.
// Baked occlusion darkens creases (the scan's colour already carries some shading, so gently).
const TEAM_LOOK = {
  marine: { sat: 1, mul: [1.25, 1.2, 1.08] },
  enemy: { sat: 0.45, mul: [0.6, 0.7, 0.92] },
};
const AO_MIN = 0.6;

function bakedTexture(kind) {
  const { color, ao, size } = baked, look = TEAM_LOOK[kind] || TEAM_LOOK.marine;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(color, 0, 0, size, size);
  const img = g.getImageData(0, 0, size, size), d = img.data;
  const [mr, mg, mb] = look.mul, sat = look.sat;
  for (let i = 0, n = size * size; i < n; i++) {
    const o = i * 4, a = ao[o] / 255, s = AO_MIN + (1 - AO_MIN) * a;
    const r = d[o], gg = d[o + 1], b = d[o + 2], lum = 0.299 * r + 0.587 * gg + 0.114 * b;
    d[o] = (lum + (r - lum) * sat) * mr * s;
    d[o + 1] = (lum + (gg - lum) * sat) * mg * s;
    d[o + 2] = (lum + (b - lum) * sat) * mb * s;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const textures = {};
const materials = {};
let dataMaps = null;
function bakedDataMaps() {
  if (!dataMaps) {
    const mk = (img) => { const t = new THREE.Texture(img); t.anisotropy = 4; t.needsUpdate = true; return t; };
    dataMaps = { normal: mk(baked.normalImg), orm: mk(baked.ormImg) };
  }
  return dataMaps;
}
function kitMaterial(kind) {
  if (!materials[kind]) {
    if (baked) {
      textures[kind] = bakedTexture(kind);
      const maps = bakedDataMaps();
      materials[kind] = new THREE.MeshStandardMaterial({
        map: textures[kind], normalMap: maps.normal, roughnessMap: maps.orm, metalnessMap: maps.orm,
        roughness: 1, metalness: 1, envMapIntensity: 0.7,
      });
    } else {
      textures[kind] = soldierTexture(kind);
      materials[kind] = new THREE.MeshStandardMaterial({ map: textures[kind], roughness: 0.85, metalness: 0, envMapIntensity: 0.6 });
    }
  }
  return materials[kind];
}
let shadowMat = null;
const shadowGeo = new THREE.PlaneGeometry(1.5, 1.5).rotateX(-Math.PI / 2);

// weapon carry poses in chest space: position, euler (pitch, yaw, roll)
const POSES = {
  rifle: {
    hip: [0.085, 0.085, -0.15, 0.03, 0.2, 0.0], ads: [0.05, 0.185, -0.19, 0, 0.05, 0],
    sprint: [0.03, 0.03, -0.17, 0.5, 0.95, 0.25], reload: [0.06, 0.06, -0.17, 0.35, 0.25, -0.35], scale: 1.12,
  },
  sniper: {
    hip: [0.09, 0.07, -0.1, 0.03, 0.2, 0.0], ads: [0.055, 0.17, -0.13, 0, 0.05, 0],
    sprint: [0.03, 0.02, -0.12, 0.55, 0.9, 0.25], reload: [0.07, 0.05, -0.12, 0.3, 0.25, -0.3], scale: 1.1,
  },
  pistol: {
    hip: [0.07, 0.1, -0.42, 0.0, 0.08, 0], ads: [0.02, 0.3, -0.47, 0, 0.02, 0],
    sprint: [0.16, -0.12, -0.2, -0.9, 0.1, 0], reload: [0.08, 0.12, -0.3, 0.5, 0.3, -0.5], scale: 1.25,
  },
};
const DOWN = new THREE.Vector3(0, -1, 0);
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();

// --- hands on the weapon -----------------------------------------------------
// The scanned gloves are relaxed and half closed. In the rest pose the fingers
// hang down (-Y), the palms face the body (right palm -X, left palm +X) and the
// curl of the fingers runs front to back (Z): that channel is where a grip sits.
// GRIP_* is the middle of that channel in hand-bone space (from the wrist).
const GRIP_R = new THREE.Vector3(-0.024, -0.07, 0.004);
const GRIP_L = new THREE.Vector3(0.024, -0.07, 0.004);
/**
 * Hand rotation (weapon space) from where the hand's +X ends up (the back of the
 * right hand, the palm of the left) and where the fingers point.
 */
function handTurn(xAxis, fingers) {
  const x = new THREE.Vector3(...xAxis).normalize();
  const f = new THREE.Vector3(...fingers);
  const y = f.addScaledVector(x, -f.dot(x)).normalize().negate();   // +Y runs back up the hand to the wrist
  const z = new THREE.Vector3().crossVectors(x, y);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
// Trigger hand: palm on the right of the pistol grip, fingers forward round its
// front, the curl along the grip (raked back ~20 degrees). Rifle support hand:
// under the handguard, palm up and a little right, fingers wrapping the far side.
// Pistol support hand: palm on the left grip panel, fingers over the trigger hand.
// rOff / lOff nudge the hands (weapon space, metres): the gloves are big next to a
// pistol, so they sit on the grip itself and leave the slide and sights clear, and
// the support hand sits off the trigger hand.
const TRIGGER_HAND = handTurn([1, 0, 0], [0, -0.34, -0.94]);
const HOLD = {
  rifle: { R: TRIGGER_HAND, L: handTurn([0.22, 1, 0.1], [1, -0.12, -0.3]), rOff: [0, 0, 0], lOff: [0, -0.008, 0] },
  pistol: { R: TRIGGER_HAND, L: handTurn([1, 0.12, 0.1], [0.35, -0.42, -1]), rOff: [0, -0.004, -0.004], lOff: [-0.03, -0.018, -0.012], elbows: 0.35 },
};
HOLD.sniper = HOLD.rifle;
const HAND_FREE = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0, 0));
const _g1 = new THREE.Vector3(), _g2 = new THREE.Vector3(), _g3 = new THREE.Vector3();
const _qR = new THREE.Quaternion(), _qL = new THREE.Quaternion(), _qA = new THREE.Quaternion();

// --- legs --------------------------------------------------------------------
const sstep = (a, b, x) => smooth(clamp((x - a) / (b - a), 0, 1));
const _k1 = new THREE.Vector3(), _k2 = new THREE.Vector3(), _k3 = new THREE.Vector3(), _k4 = new THREE.Vector3();
const _b1 = new THREE.Vector3(), _b2 = new THREE.Vector3(), _b3 = new THREE.Vector3();
const _mb = new THREE.Matrix4(), _mInv = new THREE.Matrix4();
const _qT = new THREE.Quaternion(), _qS = new THREE.Quaternion(), _qF = new THREE.Quaternion(), _qH = new THREE.Quaternion();
const _ef = new THREE.Euler(0, 0, 0, 'YXZ');
const LEG_REACH = THIGH + SHIN - 0.004;
// ankle offset when the foot rolls: over the ball of the foot (heel up) or the heel (toes up)
const BALL = Math.hypot(0.13, ANKLE), BALL_A = Math.atan2(ANKLE, -0.13);
const HEEL = Math.hypot(0.05, ANKLE), HEEL_A = Math.atan2(ANKLE, 0.05);
const feet = [
  { side: 'L', sgn: -1, x: 0, y: 0, z: 0, pitch: 0, yaw: 0, down: true },
  { side: 'R', sgn: 1, x: 0, y: 0, z: 0, pitch: 0, yaw: 0, down: true },
];

/** Rotation whose -Y runs along dir and whose -Z (knee / shin front) faces front. */
function aimBone(out, dir, front) {
  _b2.copy(dir).negate();
  _b3.copy(front).addScaledVector(dir, -front.dot(dir)).normalize().negate();
  _b1.crossVectors(_b2, _b3);
  return out.setFromRotationMatrix(_mb.makeBasis(_b1, _b2, _b3));
}

export class Soldier {
  constructor(kind = 'marine') {
    if (!sharedGeometry) sharedGeometry = baked ? baked.geometry : buildGeometry();
    this.kind = kind;
    this.root = new THREE.Group();
    this.bones = [];
    this.b = {};
    RIG.forEach(([name, parent, x, y, z], i) => {
      const bone = new THREE.Bone();
      bone.name = name;
      if (parent < 0) bone.position.set(x, y, z);
      else bone.position.set(x - RIG[parent][2], y - RIG[parent][3], z - RIG[parent][4]);
      bone.userData.rest = bone.position.clone();
      this.bones.push(bone);
      this.b[name] = bone;
      if (parent >= 0) this.bones[parent].add(bone);
    });
    this.root.add(this.bones[0]);
    this.mesh = new THREE.SkinnedMesh(sharedGeometry, kitMaterial(kind));
    this.mesh.frustumCulled = true;
    this.root.add(this.mesh);
    this.root.updateMatrixWorld(true);
    this.mesh.bind(new THREE.Skeleton(this.bones));
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 2.0);

    // weapon mounts: guns ride on the chest, melee weapons in the right hand
    this.gunMount = new THREE.Group();
    this.b.chest.add(this.gunMount);
    this.handMount = new THREE.Group();
    this.handMount.position.set(0, -0.075, -0.01);
    this.b.handR.add(this.handMount);
    this.weapon = null;
    this.weaponDef = null;
    this.points = null;

    if (!shadowMat) {
      shadowMat = new THREE.MeshBasicMaterial({
        map: glowTexture('rgba(0,0,0,0.85)', 'rgba(0,0,0,0)'), transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, color: 0x000000,
      });
    }
    this.shadow = new THREE.Mesh(shadowGeo, shadowMat);
    this.shadow.renderOrder = 2;
    this.root.add(this.shadow);

    // animation state
    this.b.hips.rotation.order = 'YXZ';   // turn towards the travel direction, then lean
    this.gaitP = Math.random();           // gait cycle 0..1, the left foot strikes at 0
    this.phase = 0;                       // gait cycle in radians (read by the first-person bob)
    this.crouchK = 0; this.proneK = 0; this.sprintK = 0; this.adsK = 0; this.airK = 0; this.slideK = 0;
    this.moveK = 0; this.hipYaw = 0; this.reloadK = 0; this.kick = 0; this.flinch = 0; this.pitch = 0;
    this.mountPos = new THREE.Vector3(0.085, 0.085, -0.15);
    this.mountRot = new THREE.Vector3(0, 0.2, 0);
  }

  setKind(kind) {
    this.kind = kind;
    this.mesh.material = kitMaterial(kind);
  }

  setWeapon(def) {
    if (this.weaponDef === def) return;
    if (this.weapon) this.weapon.parent.remove(this.weapon);
    this.weaponDef = def;
    this.weapon = null;
    if (!def) return;
    const { mesh, points } = makeWeaponModel(def.id);
    this.weapon = mesh;
    this.points = points;
    if (def.pose === 'melee') {
      mesh.scale.setScalar(1.25);
      this.handMount.add(mesh);
    } else {
      mesh.scale.setScalar(POSES[def.pose].scale);
      this.gunMount.add(mesh);
    }
  }

  /** World position of the muzzle (for tracers and flashes). */
  muzzleWorld(out) {
    if (!this.weapon || !this.points) return this.b.chest.getWorldPosition(out);
    const p = this.points.muzzle;
    out.set(p[0], p[1], p[2]);
    return this.weapon.localToWorld(out);
  }

  headWorld(out) {
    return out.set(0, 0.17, -0.02).applyMatrix4(this.b.head.matrixWorld);
  }

  /** Two-bone arm IK in chest space: puts the wrist at (tx, ty, tz). */
  _ik(side, tx, ty, tz, poleX) {
    const arm = this.b['arm' + side], fore = this.b['fore' + side];
    const S = arm.userData.rest;
    _v1.set(tx - S.x, ty - S.y, tz - S.z);
    let d = _v1.length();
    _v1.divideScalar(d || 1);
    // just out of reach: the shoulder blade slides forward a little, as a real one does
    const reach = UPPER + FORE - 0.004;
    const slack = clamp(d - reach, 0, 0.07);
    arm.position.copy(S).addScaledVector(_v1, slack);
    d = clamp(d - slack, 0.08, reach);
    const cosA = clamp((UPPER * UPPER + d * d - FORE * FORE) / (2 * UPPER * d), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    // pole: elbows drop down and out
    _v2.set(poleX, -1, 0.35);
    _v2.addScaledVector(_v1, -_v2.dot(_v1)).normalize();
    _v3.copy(_v1).multiplyScalar(UPPER * cosA).addScaledVector(_v2, UPPER * sinA); // elbow (relative to shoulder)
    _v4.copy(_v1).multiplyScalar(d).sub(_v3).normalize();                          // forearm direction
    _v3.normalize();
    arm.quaternion.setFromUnitVectors(DOWN, _v3);
    _q1.setFromUnitVectors(DOWN, _v4);
    fore.quaternion.copy(arm.quaternion).invert().multiply(_q1);
  }

  /**
   * Both hands onto the weapon, wherever the gun mount currently is (third person
   * pose, or the first-person hold that player.js sets). reload: 0..1 or -1.
   */
  gripWeapon(reload = -1) {
    const def = this.weaponDef, pts = this.points, w = this.weapon;
    if (!def || !pts || !w || def.pose === 'melee') return;
    const H = HOLD[def.pose] || HOLD.rifle, sc = w.scale.x, gm = this.gunMount, m = gm.matrix;
    // where each hand turns to and the grips, in chest space
    _qR.copy(gm.quaternion).multiply(H.R);
    _qL.copy(gm.quaternion).multiply(H.L);
    _g1.set(pts.right[0] * sc + H.rOff[0], pts.right[1] * sc + H.rOff[1], pts.right[2] * sc + H.rOff[2]).applyMatrix4(m);
    _g2.set(pts.left[0] * sc + H.lOff[0], pts.left[1] * sc + H.lOff[1], pts.left[2] * sc + H.lOff[2]).applyMatrix4(m);
    // the IK places wrists: step back from the grip to the wrist
    _g1.sub(_g3.copy(GRIP_R).applyQuaternion(_qR));
    _g3.copy(GRIP_L).applyQuaternion(_qL);
    _g2.sub(_g3);
    let lx = _g2.x, ly = _g2.y, lz = _g2.z, onGun = 1;
    if (reload >= 0 && pts.mag) {
      // support hand: grip -> magazine -> belt -> magazine -> grip
      _v1.set(pts.mag[0] * sc, pts.mag[1] * sc, pts.mag[2] * sc).applyMatrix4(m).sub(_g3);
      const mx = _v1.x, my = _v1.y, mz = _v1.z;
      const seg = (a0, a1) => smooth(clamp((reload - a0) / (a1 - a0), 0, 1));
      const toMag = seg(0.05, 0.22), toBelt = seg(0.25, 0.48), back = seg(0.52, 0.76), toGrip = seg(0.82, 0.98);
      let hx = lerp(lx, mx, toMag), hy = lerp(ly, my, toMag), hz = lerp(lz, mz, toMag);
      hx = lerp(hx, -0.14, toBelt); hy = lerp(hy, -0.2, toBelt); hz = lerp(hz, -0.12, toBelt);
      hx = lerp(hx, mx, back); hy = lerp(hy, my, back); hz = lerp(hz, mz, back);
      lx = lerp(hx, lx, toGrip); ly = lerp(hy, ly, toGrip); lz = lerp(hz, lz, toGrip);
      onGun = 1 - clamp(Math.min(reload - 0.03, 0.98 - reload) * 8, 0, 1);
    }
    const out = H.elbows || 0.75;   // a pistol is held with the elbows tucked in
    this._ik('R', _g1.x, _g1.y, _g1.z, out);
    this._ik('L', lx, ly, lz, -out);
    // hand (local to the forearm) = (arm * fore)^-1 * the grip rotation, all in chest space
    const b = this.b;
    _qA.copy(b.armR.quaternion).multiply(b.foreR.quaternion).invert();
    b.handR.quaternion.copy(_qA).multiply(_qR);
    _qA.copy(b.armL.quaternion).multiply(b.foreL.quaternion).invert();
    b.handL.quaternion.copy(_qA).multiply(_qL);
    if (onGun < 1) b.handL.quaternion.slerp(HAND_FREE, 1 - onGun);
  }

  /** Two-bone leg IK in hips space: ankle onto t, knee bending towards pole. Writes _qT / _qS. */
  _legIK(side, t, pole) {
    const S = this.b['thigh' + side].userData.rest;
    _k1.subVectors(t, S);
    let d = _k1.length();
    _k1.divideScalar(d || 1);
    d = clamp(d, 0.12, LEG_REACH);
    const cosA = clamp((THIGH * THIGH + d * d - SHIN * SHIN) / (2 * THIGH * d), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
    _k2.copy(pole).addScaledVector(_k1, -pole.dot(_k1)).normalize();             // bend direction
    _k3.copy(_k1).multiplyScalar(cosA).addScaledVector(_k2, sinA);              // thigh direction
    _k4.copy(_k1).multiplyScalar(d).addScaledVector(_k3, -THIGH).normalize();   // shin direction
    aimBone(_qT, _k3, _k2);
    aimBone(_qS, _k4, _k2);
    _qS.premultiply(_q1.copy(_qT).invert());
  }

  /**
   * s: { speed, moveX, moveZ (model-space velocity, -Z forward), pitch, crouch, prone,
   *      sprint, ads, air, slide, reload (0..1 or -1), melee (0..1 or -1), dead (0..1),
   *      deadDir, groundY }
   */
  update(dt, s) {
    const b = this.b;
    const def = this.weaponDef;
    const pose = def ? def.pose : 'rifle';
    this.crouchK = damp(this.crouchK, s.crouch ? 1 : 0, 12, dt);
    this.proneK = damp(this.proneK, s.prone ? 1 : 0, 9, dt);
    this.sprintK = damp(this.sprintK, s.sprint ? 1 : 0, 10, dt);
    this.adsK = damp(this.adsK, s.ads || 0, 16, dt);
    this.airK = damp(this.airK, s.air ? 1 : 0, 14, dt);
    this.slideK = damp(this.slideK, s.slide ? 1 : 0, 14, dt);
    this.kick = damp(this.kick, 0, 14, dt);
    this.flinch = damp(this.flinch, 0, 9, dt);
    this.pitch = damp(this.pitch, s.pitch || 0, 22, dt);
    const speed = s.speed || 0;
    const moving = speed > 0.25;
    this.moveK = damp(this.moveK, moving ? 1 : 0, 9, dt);
    const cK = this.crouchK * (1 - this.proneK), pK = this.proneK, slK = this.slideK;
    const dead = s.dead || 0;
    const deadE = smooth(clamp(dead, 0, 1));
    const moveK = this.moveK;

    // lower body turns towards the direction of travel; walking backwards
    // keeps facing forward and steps backwards instead of turning around
    let ang = moving ? Math.atan2(-s.moveX, -s.moveZ) : 0; // 0 = forward, + = left
    let back = false;
    if (Math.abs(ang) > 1.9) { back = true; ang = ang > 0 ? ang - Math.PI : ang + Math.PI; }
    this.hipYaw = damp(this.hipYaw, clamp(ang, -0.9, 0.9) * (1 - pK), 10, dt);

    // --- gait ---------------------------------------------------------------
    // Feet are planted: while a foot is down it slides back under the body at
    // exactly the travel speed, so it stays put on the ground. Cadence, how long
    // each foot stays down and how high it swings change from walk to run to
    // sprint; crouching walks with short quick steps.
    const runK = sstep(2.0, 3.8, speed) * (1 - cK);
    const sprF = sstep(4.9, 6.4, speed) * (1 - cK);
    let freq = lerp(0.85 + 0.12 * speed, 0.85 + 0.15 * speed, runK);     // strides per second
    freq = lerp(freq, 1.5 + 0.25 * speed, cK);
    const duty = lerp(lerp(0.6, lerp(0.31, 0.26, sprF), runK), 0.6, cK);   // share of the stride a foot is down
    this.gaitP = (this.gaitP + freq * dt) % 1;
    this.phase = this.gaitP * Math.PI * 2;
    const P = this.gaitP;
    const stance = moving ? (speed / freq) * duty : 0;                       // ground covered while a foot is down
    const front = lerp(0.42, 0.38, runK);                                     // share of it ahead of the hips
    const lift = (lerp(0.08, 0.26, runK) + 0.08 * sprF) * Math.min(1, speed / 1.2) * (1 - cK * 0.35);
    const kick = (0.14 * runK + 0.08 * sprF) * Math.min(1, speed / 3);     // running heels flick up behind
    const roll = lerp(0.5, 0.85, runK);                                       // heel lift at push-off (rad)
    const strike = lerp(0.26, 0.05, runK) * (1 - cK);                         // toes up at heel strike (rad)
    const amp = clamp(speed / 4.8, 0, 1.2) * moveK * (1 - this.airK * 0.6) * (1 - slK);

    const hy = this.hipYaw;
    const rX = Math.cos(hy), rZ = -Math.sin(hy), fX = -Math.sin(hy), fZ = -Math.cos(hy);
    const ux = speed > 0.05 ? s.moveX / speed : fX, uz = speed > 0.05 ? s.moveZ / speed : fZ;
    const width = lerp(0.1, 0.075, runK) + 0.035 * cK;
    for (const ft of feet) {
      const sgn = ft.sgn, L = sgn < 0;
      const ph = (P + (L ? 0 : 0.5)) % 1;
      // gait: distance along the travel direction, height of the sole, pitch (+ = toes up)
      let along, up = 0, pitch;
      ft.down = ph < duty;
      if (ft.down) {
        const t = ph / duty;
        along = stance * (front - t);
        pitch = strike * (1 - sstep(0, 0.16, t)) - roll * sstep(lerp(0.55, 0.42, runK), 1, t);
      } else {
        // a smooth arc from push-off behind to the next strike in front
        const t = (ph - duty) / (1 - duty), it = 1 - t;
        const x0 = (front - 1) * stance, x3 = front * stance, x1 = x0 - kick, x2 = x3 + 0.12 * stance;
        along = it * it * it * x0 + 3 * it * it * t * x1 + 3 * it * t * t * x2 + t * t * t * x3;
        up = 3 * it * t * (it * 1.6 + t) * lift;
        const mid = -0.2 - 0.3 * runK;
        pitch = t < 0.35 ? lerp(-roll, mid, sstep(0, 0.35, t)) : lerp(mid, strike, sstep(0.35, 0.95, t));
      }
      if (back) pitch *= -0.5;
      // standing: rifle stance, left foot ahead, right foot turned out.
      // crouched: kneel on the right knee with the left foot planted ahead.
      const iLat = L ? lerp(0.12, 0.14, cK) : lerp(0.13, 0.12, cK);
      const iFwd = L ? lerp(0.08, 0.28, cK) : lerp(-0.06, -0.55, cK);
      const iPitch = L ? 0 : -1.3 * cK;
      const gx = ux * along + rX * sgn * width, gz = uz * along + rZ * sgn * width;
      const ix = rX * sgn * iLat + fX * iFwd, iz = rZ * sgn * iLat + fZ * iFwd;
      ft.x = lerp(ix, gx, moveK); ft.z = lerp(iz, gz, moveK); ft.y = up * moveK;
      ft.pitch = lerp(iPitch, pitch, moveK);
      ft.yaw = hy - sgn * lerp(L ? 0.1 : 0.4, 0.08, moveK);
      // roll over the ball of the foot or the heel: the ankle rises and shifts
      const a = ft.pitch < 0 ? BALL_A + ft.pitch : HEEL_A + ft.pitch;
      const r = ft.pitch < 0 ? BALL : HEEL;
      const da = ft.pitch < 0 ? r * Math.cos(a) + 0.13 : r * Math.cos(a) - 0.05;
      const dy = r * Math.sin(a) - ANKLE;
      const fx = -Math.sin(ft.yaw), fz = -Math.cos(ft.yaw);
      ft.x += fx * da; ft.z += fz * da; ft.y += ANKLE + dy;
    }
    const legIK = (1 - this.airK) * (1 - pK) * (1 - slK) * (1 - deadE);

    // --- hips ---------------------------------------------------------------
    // walking vaults over the planted leg (highest mid-stance), running dips
    // into each landing (lowest mid-stance); the pelvis turns and tilts with the stride
    const stepWave = Math.cos(4 * Math.PI * (P - duty / 2));
    const sideWave = Math.cos(2 * Math.PI * (P - duty / 2));
    let hipsY = HIPS_Y - 0.025 * (1 - cK) - cK * (0.395 - 0.09 * moveK) - pK * 0.72 - slK * 0.5;   // knees soft
    hipsY -= (0.012 + 0.04 * runK + 0.02 * sprF) * moveK;
    hipsY += lerp(0.012, -0.03, runK) * stepWave * moveK * (1 - cK * 0.6);
    // never higher than the planted feet allow
    if (legIK > 0.01) {
      let top = Infinity;
      for (const ft of feet) {
        if (!ft.down && moveK > 0.5) continue;
        const jx = rX * ft.sgn * 0.1, jz = rZ * ft.sgn * 0.1;
        const h2 = (ft.x - jx) ** 2 + (ft.z - jz) ** 2;
        top = Math.min(top, ft.y + Math.sqrt(Math.max(0, LEG_REACH * LEG_REACH - h2)) + 0.02);
      }
      hipsY = lerp(hipsY, Math.min(hipsY, top), legIK);
    }
    hipsY = lerp(hipsY, 0.2, deadE);
    const sway = -lerp(0.018, 0.008, runK) * sideWave * moveK * (1 - cK);
    b.hips.position.set(rX * sway, hipsY, rZ * sway);
    const lean = -(0.2 * this.sprintK * moveK + 0.1 * cK + 0.09 * runK * moveK + 0.02 * moveK);
    let hipsX = lean * (1 - pK) + -1.5 * pK + 0.55 * slK;
    hipsX = lerp(hipsX, (s.deadDir || 1) * 1.5, deadE);
    const twistOsc = -lerp(0.08, 0.1, runK) * Math.cos(2 * Math.PI * P) * moveK * (1 - pK) * (1 - slK);
    const tilt = -0.05 * sideWave * moveK * (1 - runK * 0.5) * (1 - cK) * (1 - pK);
    b.hips.rotation.set(hipsX, hy + twistOsc, tilt);

    // --- legs ---------------------------------------------------------------
    // key poses for the air, prone, slide and death, blended with the planted-foot IK
    const sw = Math.sin(this.phase), cw = Math.cos(this.phase);
    if (legIK > 0.001) { b.hips.updateMatrix(); _mInv.copy(b.hips.matrix).invert(); }
    for (const ft of feet) {
      const side = ft.side, L = side === 'L';
      const ph = L ? sw : -sw, pc = L ? cw : -cw;
      let thigh = 0.05, knee = 0.1;
      thigh = lerp(thigh, L ? 0.55 : 0.15, this.airK); knee = lerp(knee, L ? 0.95 : 0.6, this.airK);
      thigh = lerp(thigh, L ? 0.95 : 0.5, slK); knee = lerp(knee, L ? 0.15 : 1.7, slK);
      thigh = lerp(thigh, 0.05 + ph * 0.25 * amp, pK); knee = lerp(knee, 0.08 + Math.max(0, pc) * 0.5 * amp, pK);
      thigh = lerp(thigh, L ? 0.25 : -0.1, deadE); knee = lerp(knee, L ? 0.5 : 0.15, deadE);
      const spread = (L ? -1 : 1) * (0.03 + 0.12 * pK + 0.1 * deadE);
      const tb = b['thigh' + side], sb = b['shin' + side], fb = b['foot' + side];
      tb.rotation.set(thigh, 0, spread);
      sb.rotation.set(-knee, 0, 0);
      fb.rotation.set(clamp(knee - thigh - hipsX * (1 - pK), -0.9, 1.0) * (1 - pK * 0.2) + pK * 0.9, 0, 0);
      if (legIK <= 0.001) continue;
      // ankle target and knee direction (forward and a little out) in hips space
      _v1.set(ft.x, ft.y, ft.z).applyMatrix4(_mInv);
      _v2.set(rX * ft.sgn * 0.15 + fX, 0, rZ * ft.sgn * 0.15 + fZ).transformDirection(_mInv);
      this._legIK(side, _v1, _v2);
      // sole: pitch about the foot's own axis, facing ft.yaw (model space -> hips -> shin)
      _ef.set(ft.pitch, ft.yaw, 0);
      _qF.setFromEuler(_ef).premultiply(_qH.copy(b.hips.quaternion).invert());
      _qF.premultiply(_q2.copy(_qT).multiply(_qS).invert());
      if (legIK >= 0.999) {
        tb.quaternion.copy(_qT); sb.quaternion.copy(_qS); fb.quaternion.copy(_qF);
      } else {
        tb.quaternion.slerp(_qT, legIK); sb.quaternion.slerp(_qS, legIK); fb.quaternion.slerp(_qF, legIK);
      }
    }

    // --- torso --------------------------------------------------------------
    // the chest keeps facing the aim while the hips turn and swing underneath
    const aim = this.pitch * (1 - deadE);
    const twist = -(hy + twistOsc);
    b.spine.rotation.set(aim * 0.42 - lean * 0.5 * (1 - pK) + 0.3 * pK - 0.4 * slK, twist * 0.55, -tilt * 0.5);
    b.chest.rotation.set(aim * 0.46 + 0.22 * pK - 0.25 * slK + this.kick * 0.05, twist * 0.45, this.flinch * 0.25 - tilt * 0.3);
    b.head.rotation.set(aim * 0.12 + 0.45 * pK + 0.1 * cK - 0.25 * deadE, 0, -this.adsK * 0.12 * (pose === 'pistol' ? 0 : 1));

    // --- arms + weapon ------------------------------------------------------
    b.armL.position.copy(b.armL.userData.rest);
    b.armR.position.copy(b.armR.userData.rest);
    const reload = s.reload != null && s.reload >= 0 ? s.reload : -1;
    this.reloadK = damp(this.reloadK, reload >= 0 ? 1 : 0, 14, dt);
    if (dead > 0.05) {
      if (this.weapon) this.weapon.visible = false;
      b.armL.rotation.set(-0.3, 0, -0.9 * deadE); b.foreL.rotation.set(0.5, 0, 0);
      b.armR.rotation.set(0.2, 0, 0.8 * deadE); b.foreR.rotation.set(0.7, 0, 0);
      b.handL.rotation.set(0, 0, 0); b.handR.rotation.set(0, 0, 0);
    } else if (pose === 'melee' || !def) {
      if (this.weapon) this.weapon.visible = true;
      const m = s.melee != null && s.melee >= 0 ? s.melee : -1;
      // arms swing against the legs: right arm forward with the left foot
      const armSwing = Math.cos(2 * Math.PI * P) * 0.55 * amp;
      let ax = 0.35 + armSwing, fx = 1.25, az = 0.12, ay = 0;
      if (m >= 0) {
        // wind up over the shoulder, cut across the body, recover
        if (m < 0.22) { const t = smooth(m / 0.22); ax = lerp(ax, 2.2, t); fx = lerp(fx, 1.5, t); az = lerp(az, 0.5, t); }
        else if (m < 0.55) { const t = smooth((m - 0.22) / 0.33); ax = lerp(2.2, 0.55, t); fx = lerp(1.5, 0.25, t); az = lerp(0.5, -0.75, t); ay = lerp(0, -0.5, t); }
        else { const t = smooth((m - 0.55) / 0.45); ax = lerp(0.55, 0.35, t); fx = lerp(0.25, 1.25, t); az = lerp(-0.75, 0.12, t); ay = lerp(-0.5, 0, t); }
      }
      b.armR.rotation.set(ax, ay, az);
      b.foreR.rotation.set(fx, 0, 0);
      b.handR.rotation.set(0, 0, 0);
      b.armL.rotation.set(0.3 - armSwing, 0, -0.14);
      b.foreL.rotation.set(1.1 + armSwing * 0.4, 0, 0);
      b.handL.rotation.set(0, 0, 0);
    } else {
      if (this.weapon) this.weapon.visible = true;
      const Pz = POSES[pose];
      const sp = this.sprintK * moveK * (1 - this.adsK) * (1 - this.reloadK);
      const ads = this.adsK * (1 - this.reloadK);
      // blend the carry pose
      const mp = this.mountPos, mr = this.mountRot;
      let tx = Pz.hip[0], ty = Pz.hip[1], tz = Pz.hip[2], rx = Pz.hip[3], ry = Pz.hip[4], rz = Pz.hip[5];
      const mix = (Q, k) => { tx = lerp(tx, Q[0], k); ty = lerp(ty, Q[1], k); tz = lerp(tz, Q[2], k); rx = lerp(rx, Q[3], k); ry = lerp(ry, Q[4], k); rz = lerp(rz, Q[5], k); };
      mix(Pz.ads, ads);
      mix(Pz.sprint, sp);
      mix(Pz.reload, this.reloadK);
      if (pK > 0.01) { ty = lerp(ty, 0.2, pK); tz = lerp(tz, pose === 'pistol' ? -0.5 : -0.24, pK); ry = lerp(ry, 0.03, pK); }
      mp.set(damp(mp.x, tx, 18, dt), damp(mp.y, ty, 18, dt), damp(mp.z, tz, 18, dt));
      mr.set(damp(mr.x, rx, 18, dt), damp(mr.y, ry, 18, dt), damp(mr.z, rz, 18, dt));
      // the weapon rides the steps: a small dip on each landing and a sway between feet
      const carry = amp * (1 - ads);
      this.gunMount.position.set(mp.x, mp.y - stepWave * 0.008 * carry, mp.z + this.kick * 0.045);
      _e.set(mr.x + this.kick * 0.09 + stepWave * 0.015 * carry, mr.y, mr.z + sideWave * 0.04 * carry, 'YXZ');
      this.gunMount.quaternion.setFromEuler(_e);
      this.gunMount.updateMatrix();
      this.gripWeapon(reload);
    }

    // blob shadow sticks to the ground under the hips
    this.shadow.position.set(0, (s.groundY != null ? s.groundY - this.root.position.y : 0) + 0.035, lerp(0, -0.5, pK));
    const sh = 1 + pK * 0.5 + deadE * 0.4;
    this.shadow.scale.set(sh, 1, sh + pK * 0.6);
  }

  dispose() {
    if (this.root.parent) this.root.parent.remove(this.root);
    this.mesh.skeleton.dispose();
  }
}
