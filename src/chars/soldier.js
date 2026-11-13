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
import { SOLDIER_META, SOLDIER_MESH, SOLDIER_ID, SOLDIER_AO } from './soldier_asset.js';

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
const HIPS_Y = 0.95, UPPER = 0.28, LOWER = 0.31;

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
// Blender-built model (tools/blender/build_soldier.py): a smooth-skinned mesh
// plus two baked maps. `baked` stays null if decoding fails, and the game then
// falls back to the procedural model above.
// ---------------------------------------------------------------------------
let baked = null;

function decodeMesh() {
  const bin = atob(SOLDIER_MESH), n = SOLDIER_META.verts, bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  let off = 0;
  const take = (len) => { const b = bytes.buffer.slice(off, off + len); off += len; return b; };
  const p16 = new Int16Array(take(n * 6)), n8 = new Int8Array(take(n * 3));
  const uv16 = new Uint16Array(take(n * 4)), sk = new Uint8Array(take(n * 3));
  const index = new Uint16Array(take(SOLDIER_META.tris * 6));
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (let i = 0; i < n * 3; i++) { pos[i] = p16[i] / SOLDIER_META.scale; nor[i] = n8[i] / 127; }
  for (let i = 0; i < n * 2; i++) uv[i] = uv16[i] / 65535;
  for (let i = 0; i < n; i++) {
    si[i * 4] = sk[i * 3]; si[i * 4 + 1] = sk[i * 3 + 1];
    sw[i * 4] = sk[i * 3 + 2] / 255; sw[i * 4 + 1] = 1 - sk[i * 3 + 2] / 255;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeBoundingSphere();
  return g;
}

function imageData(src, size) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, size, size);
      resolve(g.getImageData(0, 0, size, size).data);
    };
    img.onerror = () => reject(new Error('soldier map failed to decode'));
    img.src = src;
  });
}

/** Decodes the Blender asset. Call once before the first Soldier is created. */
export async function loadSoldierAssets() {
  try {
    const size = SOLDIER_META.tex;
    const [id, ao] = await Promise.all([imageData(SOLDIER_ID, size), imageData(SOLDIER_AO, size)]);
    baked = { geometry: decodeMesh(), id, ao, size };
  } catch (e) {
    baked = null;
  }
  return !!baked;
}

// colours per team, indexed by the material ids of the baked ID map
const hex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const PALETTE = {
  marine: {
    camo: [0x4d5e37, 0x71603f, 0xa69a76, 0x23241d].map(hex),       // woodland MARPAT
    flat: [0, 0, 0x8c7552, 0x6d5a3d, 0x94794f, 0xc99c76, 0x16171a, 0x5e5138, 0x56653a, 0xb22234, 0x5c6a45, 0x3b3d42].map((h) => hex(h)),
  },
  enemy: {
    camo: [0x2f3136, 0x3b3d43, 0x55575c, 0x17181a].map(hex),       // dark urban
    flat: [0, 0, 0x2b2d31, 0x1c1d20, 0x19191b, 0x2a2a2c, 0x121214, 0x121214, 0xc22530, 0xb3202a, 0x1c1d20, 0x3b3d42].map((h) => hex(h)),
  },
};

function bakedTexture(kind) {
  const { id, ao, size } = baked, pal = PALETTE[kind] || PALETTE.marine;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size), d = img.data;
  const base = pal.flat[2];
  for (let i = 0, n = size * size; i < n; i++) {
    const v = id[i * 4], m = v >> 4;
    let col = base, shade = 1;
    if (m) {
      col = m === 1 ? pal.camo[v & 3] : pal.flat[m];
      // baked ambient occlusion: creases and the undersides of the kit go dark
      shade = 0.46 + 0.54 * (ao[i * 4] / 255);
    }
    d[i * 4] = col[0] * shade; d[i * 4 + 1] = col[1] * shade; d[i * 4 + 2] = col[2] * shade; d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // flag patch and name tape live in a reserved strip of the atlas
  const rect = (r) => [r[0] * size, (1 - r[3]) * size, (r[2] - r[0]) * size, (r[3] - r[1]) * size];
  const [fx, fy, fw, fh] = rect(SOLDIER_META.patch.flag);
  const [tx, ty, tw, th] = rect(SOLDIER_META.patch.tape);
  const marine = kind !== 'enemy';
  g.fillStyle = marine ? '#b22234' : '#b3202a';
  g.fillRect(fx - 2, fy - 2, fw + 4, fh + 4);
  if (marine) {
    g.fillStyle = '#f1f1f1';
    for (let k = 1; k < 13; k += 2) g.fillRect(fx - 2, fy + (fh * k) / 13, fw + 4, fh / 13);
    g.fillStyle = '#3c3b6e';
    g.fillRect(fx - 2, fy - 2, fw * 0.42 + 2, (fh * 7) / 13 + 2);
    g.fillStyle = '#fff';
    for (let r = 0; r < 4; r++) for (let k = 0; k < 5; k++) g.fillRect(fx + 4 + k * 9, fy + 5 + r * 10, 3, 3);
  } else {
    g.fillStyle = '#111';
    g.fillRect(fx + fw * 0.42, fy - 2, fw * 0.16, fh + 4);
  }
  g.fillStyle = marine ? '#5c6a45' : '#1c1d20';
  g.fillRect(tx - 2, ty - 2, tw + 4, th + 4);
  g.fillStyle = marine ? '#14170e' : '#c22530';
  g.font = `800 ${Math.round(th * 0.72)}px sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(marine ? 'U.S. MARINES' : 'HOSTILE', tx + tw / 2, ty + th / 2 + 1, tw - 6);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const textures = {};
const materials = {};
function kitMaterial(kind) {
  if (!materials[kind]) {
    textures[kind] = baked ? bakedTexture(kind) : soldierTexture(kind);
    materials[kind] = new THREE.MeshLambertMaterial({ map: textures[kind] });
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
    this.phase = Math.random() * 6;
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

  _ik(side, tx, ty, tz, poleX) {
    // shoulder and target in chest space
    const arm = this.b['arm' + side], fore = this.b['fore' + side];
    const S = arm.userData.rest;
    _v1.set(tx - S.x, ty - S.y, tz - S.z);
    const reach = UPPER + LOWER - 0.006;
    const d = clamp(_v1.length(), 0.08, reach);
    _v1.normalize();
    const cosA = clamp((UPPER * UPPER + d * d - LOWER * LOWER) / (2 * UPPER * d), -1, 1);
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
   * s: { speed, moveX, moveZ (local, -Z forward), pitch, crouch, prone, sprint,
   *      ads, air, slide, reload (0..1 or -1), melee (0..1 or -1), dead (0..1),
   *      deadDir, visible }
   */
  update(dt, s) {
    const b = this.b;
    const def = this.weaponDef;
    const pose = def ? def.pose : 'rifle';
    this.crouchK = damp(this.crouchK, s.crouch ? 1 : 0, 12, dt);
    this.proneK = damp(this.proneK, s.prone ? 1 : 0, 9, dt);
    this.sprintK = damp(this.sprintK, s.sprint ? 1 : 0, 10, dt);
    this.adsK = damp(this.adsK, s.ads || 0, 16, dt);
    this.airK = damp(this.airK, s.air ? 1 : 0, 12, dt);
    this.slideK = damp(this.slideK, s.slide ? 1 : 0, 14, dt);
    this.kick = damp(this.kick, 0, 14, dt);
    this.flinch = damp(this.flinch, 0, 9, dt);
    this.pitch = damp(this.pitch, s.pitch || 0, 22, dt);
    const speed = s.speed || 0;
    const moving = speed > 0.25;
    this.moveK = damp(this.moveK, moving ? 1 : 0, 10, dt);
    const cK = this.crouchK * (1 - this.proneK), pK = this.proneK, slK = this.slideK;

    // lower body turns towards the direction of travel; walking backwards
    // plays the cycle in reverse instead of turning around
    let ang = moving ? Math.atan2(-s.moveX, -s.moveZ) : 0; // 0 = forward, + = left
    let back = false;
    if (Math.abs(ang) > 1.9) { back = true; ang = ang > 0 ? ang - Math.PI : ang + Math.PI; }
    this.hipYaw = damp(this.hipYaw, clamp(ang, -0.9, 0.9) * (1 - pK), 10, dt);
    const stride = lerp(1.5, 3.1, clamp(speed / 6.6, 0, 1));
    this.phase += dt * (speed / stride) * Math.PI * 2 * (back ? -1 : 1);
    const sw = Math.sin(this.phase), cw = Math.cos(this.phase);
    const amp = clamp(speed / 4.8, 0, 1.2) * this.moveK * (1 - this.airK * 0.6) * (1 - slK);

    const dead = s.dead || 0;
    const deadE = smooth(clamp(dead, 0, 1));

    // --- hips ---------------------------------------------------------------
    const bob = Math.abs(sw) * 0.045 * amp;
    let hipsY = HIPS_Y - cK * 0.365 - pK * 0.72 - slK * 0.5 - bob;
    hipsY = lerp(hipsY, 0.2, deadE);
    b.hips.position.set(0, hipsY, 0);
    const lean = -(0.2 * this.sprintK * this.moveK + 0.1 * cK + 0.05 * amp);
    let hipsX = lean * (1 - pK) + -1.5 * pK + 0.55 * slK;
    hipsX = lerp(hipsX, (s.deadDir || 1) * 1.5, deadE);
    b.hips.rotation.set(hipsX, this.hipYaw, sw * 0.04 * amp);

    // --- legs ---------------------------------------------------------------
    for (const side of ['L', 'R']) {
      const ph = side === 'L' ? sw : -sw, pc = side === 'L' ? cw : -cw;
      let thigh = ph * 0.82 * amp;
      let knee = (0.12 + Math.max(0, pc) * 1.15) * amp;
      // crouch: knees up, heels under the hips
      thigh = lerp(thigh, 1.1 + ph * 0.3 * amp, cK);
      knee = lerp(knee, 1.9 + Math.max(0, pc) * 0.25 * amp, cK);
      // airborne: tucked
      thigh = lerp(thigh, side === 'L' ? 0.55 : 0.15, this.airK * (1 - cK));
      knee = lerp(knee, side === 'L' ? 0.95 : 0.6, this.airK * (1 - cK));
      // slide: leading leg straight out, trailing leg folded
      thigh = lerp(thigh, side === 'L' ? 0.95 : 0.5, slK);
      knee = lerp(knee, side === 'L' ? 0.15 : 1.7, slK);
      // prone: straight behind, crawling a little
      thigh = lerp(thigh, 0.05 + ph * 0.25 * amp, pK);
      knee = lerp(knee, 0.08 + Math.max(0, pc) * 0.5 * amp, pK);
      thigh = lerp(thigh, side === 'L' ? 0.25 : -0.1, deadE);
      knee = lerp(knee, side === 'L' ? 0.5 : 0.15, deadE);
      const spread = (side === 'L' ? -1 : 1) * (0.03 + 0.12 * pK + 0.1 * deadE + 0.05 * cK);
      b['thigh' + side].rotation.set(thigh, 0, spread);
      b['shin' + side].rotation.set(-knee, 0, 0);
      // keep the sole roughly flat
      b['foot' + side].rotation.set(clamp(knee - thigh - hipsX * (1 - pK), -0.9, 1.0) * (1 - pK * 0.2) + pK * 0.9, 0, 0);
    }

    // --- torso --------------------------------------------------------------
    const aim = this.pitch * (1 - deadE);
    const twist = -this.hipYaw;
    b.spine.rotation.set(aim * 0.42 - lean * 0.5 * (1 - pK) + 0.3 * pK - 0.4 * slK, twist * 0.5 - sw * 0.06 * amp, 0);
    b.chest.rotation.set(aim * 0.46 + 0.22 * pK - 0.25 * slK + this.kick * 0.05, twist * 0.5 - sw * 0.05 * amp, this.flinch * 0.25);
    b.head.rotation.set(aim * 0.12 + 0.45 * pK + 0.1 * cK - 0.25 * deadE, 0, -this.adsK * 0.12 * (pose === 'pistol' ? 0 : 1));

    // --- arms + weapon ------------------------------------------------------
    const reload = s.reload != null && s.reload >= 0 ? s.reload : -1;
    this.reloadK = damp(this.reloadK, reload >= 0 ? 1 : 0, 14, dt);
    if (dead > 0.05) {
      if (this.weapon) this.weapon.visible = false;
      b.armL.rotation.set(-0.3, 0, -0.9 * deadE); b.foreL.rotation.set(0.5, 0, 0);
      b.armR.rotation.set(0.2, 0, 0.8 * deadE); b.foreR.rotation.set(0.7, 0, 0);
    } else if (pose === 'melee' || !def) {
      if (this.weapon) this.weapon.visible = true;
      const m = s.melee != null && s.melee >= 0 ? s.melee : -1;
      let ax = 0.35 - sw * 0.55 * amp, fx = 1.25, az = 0.12, ay = 0;
      if (m >= 0) {
        // wind up over the shoulder, cut across the body, recover
        if (m < 0.22) { const t = smooth(m / 0.22); ax = lerp(ax, 2.2, t); fx = lerp(fx, 1.5, t); az = lerp(az, 0.5, t); }
        else if (m < 0.55) { const t = smooth((m - 0.22) / 0.33); ax = lerp(2.2, 0.55, t); fx = lerp(1.5, 0.25, t); az = lerp(0.5, -0.75, t); ay = lerp(0, -0.5, t); }
        else { const t = smooth((m - 0.55) / 0.45); ax = lerp(0.55, 0.35, t); fx = lerp(0.25, 1.25, t); az = lerp(-0.75, 0.12, t); ay = lerp(-0.5, 0, t); }
      }
      b.armR.rotation.set(ax, ay, az);
      b.foreR.rotation.set(fx, 0, 0);
      b.handR.rotation.set(0, 0, 0);
      b.armL.rotation.set(0.3 + sw * 0.55 * amp, 0, -0.14);
      b.foreL.rotation.set(1.1, 0, 0);
    } else {
      if (this.weapon) this.weapon.visible = true;
      const P = POSES[pose];
      const sp = this.sprintK * this.moveK * (1 - this.adsK) * (1 - this.reloadK);
      const ads = this.adsK * (1 - this.reloadK);
      // blend the carry pose
      const mp = this.mountPos, mr = this.mountRot;
      let tx = P.hip[0], ty = P.hip[1], tz = P.hip[2], rx = P.hip[3], ry = P.hip[4], rz = P.hip[5];
      const mix = (Q, k) => { tx = lerp(tx, Q[0], k); ty = lerp(ty, Q[1], k); tz = lerp(tz, Q[2], k); rx = lerp(rx, Q[3], k); ry = lerp(ry, Q[4], k); rz = lerp(rz, Q[5], k); };
      mix(P.ads, ads);
      mix(P.sprint, sp);
      mix(P.reload, this.reloadK);
      if (pK > 0.01) { ty = lerp(ty, 0.2, pK); tz = lerp(tz, pose === 'pistol' ? -0.5 : -0.24, pK); ry = lerp(ry, 0.03, pK); }
      mp.set(damp(mp.x, tx, 18, dt), damp(mp.y, ty, 18, dt), damp(mp.z, tz, 18, dt));
      mr.set(damp(mr.x, rx, 18, dt), damp(mr.y, ry, 18, dt), damp(mr.z, rz, 18, dt));
      const runBob = sw * 0.02 * amp * (1 - ads);
      this.gunMount.position.set(mp.x, mp.y + Math.abs(cw) * 0.018 * amp * (1 - ads) + runBob * sp, mp.z + this.kick * 0.045);
      _e.set(mr.x + this.kick * 0.09, mr.y, mr.z + runBob * 2 * sp, 'YXZ');
      this.gunMount.quaternion.setFromEuler(_e);
      this.gunMount.updateMatrix();
      // hands follow the weapon's grip points (chest space)
      const pts = this.points, sc = this.weapon.scale.x;
      _v1.set(pts.right[0] * sc, pts.right[1] * sc, pts.right[2] * sc).applyMatrix4(this.gunMount.matrix);
      const rxh = _v1.x, ryh = _v1.y, rzh = _v1.z;
      _v1.set(pts.left[0] * sc, pts.left[1] * sc, pts.left[2] * sc).applyMatrix4(this.gunMount.matrix);
      let lx = _v1.x, ly = _v1.y, lz = _v1.z;
      if (reload >= 0) {
        // support hand: grip -> magazine -> belt -> magazine -> grip
        _v1.set(pts.mag[0] * sc, pts.mag[1] * sc, pts.mag[2] * sc).applyMatrix4(this.gunMount.matrix);
        const mx = _v1.x, my = _v1.y, mz = _v1.z;
        const beltX = -0.12, beltY = -0.22, beltZ = -0.1;
        const seg = (a0, a1) => smooth(clamp((reload - a0) / (a1 - a0), 0, 1));
        const toMag = seg(0.05, 0.22), toBelt = seg(0.25, 0.48), back = seg(0.52, 0.76), toGrip = seg(0.82, 0.98);
        let hx = lerp(lx, mx, toMag), hy = lerp(ly, my, toMag), hz = lerp(lz, mz, toMag);
        hx = lerp(hx, beltX, toBelt); hy = lerp(hy, beltY, toBelt); hz = lerp(hz, beltZ, toBelt);
        hx = lerp(hx, mx, back); hy = lerp(hy, my, back); hz = lerp(hz, mz, back);
        lx = lerp(hx, lx, toGrip); ly = lerp(hy, ly, toGrip); lz = lerp(hz, lz, toGrip);
      }
      this._ik('R', rxh, ryh, rzh, 0.75);
      this._ik('L', lx, ly, lz, -0.75);
      b.handR.rotation.set(0.25, 0, 0);
      b.handL.rotation.set(0.3, 0, 0);
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
