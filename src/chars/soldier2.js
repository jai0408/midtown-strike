// Realistic animated soldier (v1.6.0): GLB with LOD0 (~15.3k tris) + LOD1 (~4.9k tris),
// 2048 WebP PBR maps (color, normal, ORM), 25-bone humanoid A-pose rig, and 23 30fps clips
// driven by THREE.AnimationMixer with post-mixer aim pitch and two-bone weapon grip IK.
//
// Exports the EXACT same public API as src/chars/soldier.js so actor.js and player.js work
// interchangeably with either model.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { glowTexture } from '../world/textures.js';
import { clamp, damp, lerp, smooth } from '../core/util.js';
import { makeWeaponModel } from '../game/weapons.js';
import { SOLDIER2_META, SOLDIER2_GLB } from './soldier2_asset.js';

// ============================================================================
// Asset loading & per-team material tinting (shared across all soldiers)
// ============================================================================
let asset = null; // { scene, clips, materials: { marine, enemy } }
let shadowMat = null;
const shadowGeo = new THREE.PlaneGeometry(1.5, 1.5).rotateX(-Math.PI / 2);

const TEAM_TINT = {
  marine: { sat: 1.05, mul: [1.06, 1.04, 0.96] }, // tan / woodland green
  enemy:  { sat: 0.36, mul: [0.48, 0.56, 0.82] }, // dark blue-grey
};

function decodeBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function makeTintedColorMap(baseTex, kind) {
  const img = baseTex && baseTex.image;
  if (!img) return baseTex;
  const w = img.width || 2048, h = img.height || 2048;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data;
  const look = TEAM_TINT[kind] || TEAM_TINT.marine;
  const [mr, mg, mb] = look.mul, sat = look.sat;
  for (let i = 0, n = w * h; i < n; i++) {
    const o = i * 4;
    const r = d[o], g = d[o + 1], b = d[o + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    d[o]     = Math.min(255, Math.max(0, (lum + (r - lum) * sat) * mr));
    d[o + 1] = Math.min(255, Math.max(0, (lum + (g - lum) * sat) * mg));
    d[o + 2] = Math.min(255, Math.max(0, (lum + (b - lum) * sat) * mb));
  }
  ctx.putImageData(id, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = false;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

export async function loadSoldier2Assets() {
  if (asset) return true;
  try {
    const loader = new GLTFLoader();
    const gltf = await new Promise((resolve, reject) => {
      loader.parse(decodeBase64(SOLDIER2_GLB), '', resolve, reject);
    });
    let baseMat = null;
    gltf.scene.traverse((o) => {
      if (o.isSkinnedMesh && !baseMat) baseMat = o.material;
    });
    const materials = {};
    for (const kind of ['marine', 'enemy']) {
      const m = baseMat ? baseMat.clone() : new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
      if (baseMat && baseMat.map) {
        m.map = makeTintedColorMap(baseMat.map, kind);
      }
      if (m.normalMap) m.normalMap.anisotropy = 4;
      if (m.roughnessMap) m.roughnessMap.anisotropy = 4;
      m.roughness = 1.0;
      m.metalness = 1.0;
      m.envMapIntensity = 0.7;
      m.needsUpdate = true;
      materials[kind] = m;
    }
    asset = { scene: gltf.scene, clips: gltf.animations || [], materials };
    return true;
  } catch (e) {
    console.warn('loadSoldier2Assets failed:', e);
    asset = null;
    return false;
  }
}

export function isSoldier2Ready() {
  return !!asset;
}

// ============================================================================
// Weapon carry poses & hand grip math (adapted for 25-bone A-pose skeleton)
// ============================================================================
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

// Rest A-pose arm vectors from build_soldier2_glb.mjs:
// upperArmL -> forearmL: (-0.229, -0.160, +0.015), forearmL -> handL: (-0.213, -0.149, -0.015)
const UPPER_DIR_L = new THREE.Vector3(-0.229, -0.160,  0.015).normalize();
const FORE_DIR_L  = new THREE.Vector3(-0.213, -0.149, -0.015).normalize();
const UPPER_DIR_R = new THREE.Vector3( 0.229, -0.160,  0.015).normalize();
const FORE_DIR_R  = new THREE.Vector3( 0.213, -0.149, -0.015).normalize();
const UPPER_LEN = Math.hypot(0.229, 0.160, 0.015); // 0.2797 m
const FORE_LEN  = Math.hypot(0.213, 0.149, 0.015); // 0.2604 m

// Hand rest basis -> standard (-Y along fingers, +X right) conversion quaternions
// In A-pose rest, handL fingers point along FORE_DIR_L, palm faces down-inward, thumb faces -Z.
// We map the canonical grip frame (X=back-of-R / palm-of-L, -Y=fingers, Z=cross) to A-pose hand space.
function restHandBasis(side) {
  const s = side === 'L' ? -1 : 1;
  const along = (side === 'L' ? FORE_DIR_L : FORE_DIR_R).clone();
  const fwd = new THREE.Vector3(0, 0, -1);
  const back = new THREE.Vector3().crossVectors(along, fwd).normalize().multiplyScalar(-s);
  // Canonical hand frame used by handTurn: +X = s * back, -Y = along, +Z = cross(X, Y)
  const x = back.clone().multiplyScalar(s);
  const y = along.clone().negate();
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
const HAND_REST_L_INV = restHandBasis('L').invert();
const HAND_REST_R_INV = restHandBasis('R').invert();

// Grip channel center in hand-local space (A-pose)
const GRIP_R_LOCAL = FORE_DIR_R.clone().multiplyScalar(0.068).add(new THREE.Vector3(-0.016, -0.014, 0.004));
const GRIP_L_LOCAL = FORE_DIR_L.clone().multiplyScalar(0.068).add(new THREE.Vector3( 0.016, -0.014, 0.004));

function handTurn(xAxis, fingers) {
  const x = new THREE.Vector3(...xAxis).normalize();
  const f = new THREE.Vector3(...fingers);
  const y = f.addScaledVector(x, -f.dot(x)).normalize().negate();
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
const TRIGGER_HAND = handTurn([1, 0, 0], [0, -0.34, -0.94]);
const HOLD = {
  rifle: {
    R: TRIGGER_HAND.clone().multiply(HAND_REST_R_INV),
    L: handTurn([0.22, 1, 0.1], [1, -0.12, -0.3]).multiply(HAND_REST_L_INV),
    rOff: [0, 0, 0], lOff: [0, -0.008, 0],
  },
  pistol: {
    R: TRIGGER_HAND.clone().multiply(HAND_REST_R_INV),
    L: handTurn([1, 0.12, 0.1], [0.35, -0.42, -1]).multiply(HAND_REST_L_INV),
    rOff: [0, -0.004, -0.004], lOff: [-0.03, -0.018, -0.012], elbows: 0.35,
  },
};
HOLD.sniper = HOLD.rifle;

const HAND_FREE = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.25, 0, 0));
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _g1 = new THREE.Vector3(), _g2 = new THREE.Vector3(), _g3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _qR = new THREE.Quaternion(), _qL = new THREE.Quaternion(), _qA = new THREE.Quaternion();
const _qPitch = new THREE.Quaternion(), _qRoll = new THREE.Quaternion();
const _e = new THREE.Euler();
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

const REF_SPEEDS = SOLDIER2_META.refSpeeds || {
  walk_fwd: 1.5, walk_back: 1.5, walk_left: 1.5, walk_right: 1.5,
  run_fwd: 4.7, run_back: 3.6, run_left: 4.2, run_right: 4.2,
  sprint: 6.7, crouch_walk: 2.6, prone_crawl: 1.0,
};

const LOCO_SYNC_CLIPS = [
  'walk_fwd', 'walk_back', 'walk_left', 'walk_right',
  'run_fwd', 'run_back', 'run_left', 'run_right', 'sprint', 'crouch_walk',
];
const LOOP_CLIPS = [
  'idle', ...LOCO_SYNC_CLIPS,
  'crouch_idle', 'prone_idle', 'prone_crawl', 'fall_loop',
];
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const _qYaw = new THREE.Quaternion();

export class Soldier {
  constructor(kind = 'marine') {
    this.kind = kind;
    this.root = new THREE.Group();
    this.b = {};
    this.bones = [];
    this.rigRoot = null;
    this.mesh = null;
    this.meshLod1 = null;
    this.mixer = null;
    this.actions = {};

    if (asset) {
      const cloned = cloneSkinned(asset.scene);
      this.rigRoot = cloned;
      this.root.add(cloned);
      const mat = asset.materials[kind] || asset.materials.marine;
      cloned.traverse((o) => {
        if (o.isBone) {
          o.userData.rest = o.position.clone();
          this.b[o.name] = o;
          this.bones.push(o);
        } else if (o.isSkinnedMesh) {
          o.material = mat;
          o.castShadow = true;
          o.frustumCulled = true;
          o.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.92, 0), 2.0);
          if (o.name === 'Soldier_LOD1') {
            this.meshLod1 = o;
            o.visible = false;
          } else {
            this.mesh = o;
          }
        }
      });
      // Map aliases expected by soldier.js / actor.js / player.js
      this.b.armL = this.b.upperArmL;
      this.b.armR = this.b.upperArmR;
      this.b.foreL = this.b.forearmL;
      this.b.foreR = this.b.forearmR;

      // Setup AnimationMixer & all 23 clips
      this.mixer = new THREE.AnimationMixer(cloned);
      for (const clip of asset.clips) {
        const act = this.mixer.clipAction(clip);
        this.actions[clip.name] = act;
        if (LOOP_CLIPS.includes(clip.name)) {
          act.setLoop(THREE.LoopRepeat, Infinity);
          act.setEffectiveWeight(clip.name === 'idle' ? 1 : 0);
          act.play();
        } else {
          act.setLoop(THREE.LoopOnce, 1);
          act.clampWhenFinished = clip.name.startsWith('death_');
          act.setEffectiveWeight(0);
        }
      }
      // Randomize initial phase so bots don't march in lockstep
      this.mixer.update(Math.random() * 1.5);
    } else {
      // Safe fallback dummy hierarchy if asset failed to decode
      const dummy = new THREE.Bone();
      dummy.name = 'chest';
      this.b = { hips: dummy, spine: dummy, chest: dummy, head: dummy, armL: dummy, armR: dummy, foreL: dummy, foreR: dummy, handL: dummy, handR: dummy };
      this.mesh = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.8, 0.3), new THREE.MeshStandardMaterial({ color: 0x556644 }));
      this.root.add(this.mesh);
    }

    // Weapon mounts
    this.gunMount = new THREE.Group();
    this.b.chest.add(this.gunMount);
    this.handMount = new THREE.Group();
    this.handMount.position.copy(GRIP_R_LOCAL);
    this.b.handR.add(this.handMount);
    this.weapon = null;
    this.weaponDef = null;
    this.points = null;

    // Ground blob shadow
    if (!shadowMat) {
      shadowMat = new THREE.MeshBasicMaterial({
        map: glowTexture('rgba(0,0,0,0.85)', 'rgba(0,0,0,0)'), transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, color: 0x000000,
      });
    }
    this.shadow = new THREE.Mesh(shadowGeo, shadowMat);
    this.shadow.renderOrder = 2;
    this.root.add(this.shadow);

    // Public animation state fields (exact parity with Soldier)
    this.gaitP = Math.random();
    this.phase = 0;
    this.crouchK = 0; this.proneK = 0; this.sprintK = 0; this.adsK = 0; this.airK = 0; this.slideK = 0;
    this.moveK = 0; this.reloadK = 0; this.kick = 0; this.flinch = 0; this.pitch = 0;
    this.fpCam = null;
    this.mountPos = new THREE.Vector3(0.085, 0.085, -0.15);
    this.mountRot = new THREE.Vector3(0, 0.2, 0);

    // Internal clip state trackers (phase-locked locomotion + staged posture + inertial lean)
    this._w = Object.fromEntries(LOOP_CLIPS.map((n) => [n, n === 'idle' ? 1 : 0]));
    this._posture = 0;       // continuous 0=stand -> 1=crouch -> 2=prone (passes smoothly through crouch)
    this._prevYaw = 0;
    this._turnRate = 0;
    this._prevMoveX = 0;
    this._prevMoveZ = 0;
    this._leanX = 0;
    this._leanZ = 0;
    this._wasAir = false;
    this._wasDead = false;
    this._wasReload = false;
    this._wasMelee = false;
    this._wasThrow = false;
    this._lastFlinch = 0;
    this._lod1 = false;
  }

  setKind(kind) {
    this.kind = kind;
    if (!asset) return;
    const mat = asset.materials[kind] || asset.materials.marine;
    if (this.mesh) this.mesh.material = mat;
    if (this.meshLod1) this.meshLod1.material = mat;
  }

  setWeapon(def) {
    if (this.weaponDef === def) return;
    if (this.weapon && this.weapon.parent) this.weapon.parent.remove(this.weapon);
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

  muzzleWorld(out) {
    if (!this.weapon || !this.points) return this.b.chest.getWorldPosition(out);
    const p = this.points.muzzle;
    out.set(p[0], p[1], p[2]);
    return this.weapon.localToWorld(out);
  }

  headWorld(out) {
    return out.set(0, 0.12, -0.01).applyMatrix4(this.b.head.matrixWorld);
  }

  /** Two-bone arm IK in chest space for A-pose rest skeleton. */
  _ik(side, tx, ty, tz, poleX) {
    const clav = this.b['clavicle' + side];
    const arm = this.b['arm' + side];
    const fore = this.b['fore' + side];
    if (!arm || !fore) return;
    // Keep clavicle neutral during weapon grip so shoulder origin is exact in chest space
    if (clav) clav.quaternion.identity();
    const restU = side === 'L' ? UPPER_DIR_L : UPPER_DIR_R;
    const restF = side === 'L' ? FORE_DIR_L : FORE_DIR_R;
    const cOff = clav ? clav.position : _v4.set(0, 0, 0);
    const Sx = cOff.x + arm.userData.rest.x;
    const Sy = cOff.y + arm.userData.rest.y;
    const Sz = cOff.z + arm.userData.rest.z;

    _v1.set(tx - Sx, ty - Sy, tz - Sz);
    let d = _v1.length();
    _v1.divideScalar(d || 1);
    const reach = UPPER_LEN + FORE_LEN - 0.005;
    const slack = clamp(d - reach, 0, 0.075);
    arm.position.copy(arm.userData.rest).addScaledVector(_v1, slack);
    d = clamp(d - slack, 0.08, reach);

    const cosA = clamp((UPPER_LEN * UPPER_LEN + d * d - FORE_LEN * FORE_LEN) / (2 * UPPER_LEN * d), -1, 1);
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    _v2.set(poleX, -1, 0.38);
    _v2.addScaledVector(_v1, -_v2.dot(_v1));
    if (_v2.lengthSq() < 1e-6) _v2.set(poleX, 0, 1);
    _v2.normalize();

    _v3.copy(_v1).multiplyScalar(UPPER_LEN * cosA).addScaledVector(_v2, UPPER_LEN * sinA);
    _v4.copy(_v1).multiplyScalar(d).sub(_v3).normalize();
    _v3.normalize();

    arm.quaternion.setFromUnitVectors(restU, _v3);
    _q1.setFromUnitVectors(restF, _v4);
    fore.quaternion.copy(arm.quaternion).invert().multiply(_q1);
  }

  /** Places both hands on the weapon grips (3P or 1P), with reload choreography. */
  gripWeapon(reload = -1) {
    const def = this.weaponDef, pts = this.points, w = this.weapon;
    if (!def || !pts || !w || def.pose === 'melee') return;
    const H = HOLD[def.pose] || HOLD.rifle, sc = w.scale.x, gm = this.gunMount, m = gm.matrix;
    _qR.copy(gm.quaternion).multiply(H.R);
    _qL.copy(gm.quaternion).multiply(H.L);
    _g1.set(pts.right[0] * sc + H.rOff[0], pts.right[1] * sc + H.rOff[1], pts.right[2] * sc + H.rOff[2]).applyMatrix4(m);
    _g2.set(pts.left[0] * sc + H.lOff[0], pts.left[1] * sc + H.lOff[1], pts.left[2] * sc + H.lOff[2]).applyMatrix4(m);
    _g1.sub(_g3.copy(GRIP_R_LOCAL).applyQuaternion(_qR));
    _g3.copy(GRIP_L_LOCAL).applyQuaternion(_qL);
    _g2.sub(_g3);

    let lx = _g2.x, ly = _g2.y, lz = _g2.z, onGun = 1;
    if (reload >= 0 && pts.mag) {
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
    const out = H.elbows || 0.75;
    this._ik('R', _g1.x, _g1.y, _g1.z, out);
    this._ik('L', lx, ly, lz, -out);

    const b = this.b;
    _qA.copy(b.armR.quaternion).multiply(b.foreR.quaternion).invert();
    b.handR.quaternion.copy(_qA).multiply(_qR);
    _qA.copy(b.armL.quaternion).multiply(b.foreL.quaternion).invert();
    b.handL.quaternion.copy(_qA).multiply(_qL);
    if (onGun < 1) b.handL.quaternion.slerp(HAND_FREE, 1 - onGun);
  }

  _playOnce(name, fadeIn = 0.08, timeScale = 1.0) {
    const act = this.actions[name];
    if (!act) return;
    act.reset();
    act.setEffectiveTimeScale(timeScale);
    act.setEffectiveWeight(1);
    act.fadeIn(fadeIn);
    act.play();
  }

  update(dt, s) {
    const b = this.b;
    const def = this.weaponDef;
    const pose = def ? def.pose : 'rifle';

    this.crouchK = damp(this.crouchK, s.crouch ? 1 : 0, 12, dt);
    this.proneK  = damp(this.proneK,  s.prone ? 1 : 0, 9, dt);
    this.sprintK = damp(this.sprintK, s.sprint ? 1 : 0, 10, dt);
    this.adsK    = damp(this.adsK,    s.ads || 0, 16, dt);
    this.airK    = damp(this.airK,    s.air ? 1 : 0, 14, dt);
    this.slideK  = damp(this.slideK,  s.slide ? 1 : 0, 14, dt);
    this.kick    = damp(this.kick,    0, 14, dt);
    this.flinch  = damp(this.flinch,  0, 9, dt);
    this.pitch   = damp(this.pitch,   s.pitch || 0, 22, dt);

    const speed = s.speed || 0;
    const moving = speed > 0.16;
    this.moveK = damp(this.moveK, moving ? 1 : 0, 10, dt);

    // Track yaw turn rate & horizontal acceleration for subtle inertial banking/lean
    const curYaw = this.root.rotation.y || 0;
    let dYaw = curYaw - this._prevYaw;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    this._prevYaw = curYaw;
    const safeDt = Math.max(dt, 0.004);
    this._turnRate = damp(this._turnRate, clamp(dYaw / safeDt, -5, 5), 10, dt);
    const mx = s.moveX || 0, mz = s.moveZ || 0;
    const accX = clamp((mx - this._prevMoveX) / safeDt, -18, 18);
    const accZ = clamp((mz - this._prevMoveZ) / safeDt, -18, 18);
    this._prevMoveX = mx; this._prevMoveZ = mz;
    this._leanX = damp(this._leanX, clamp(accZ * 0.008, -0.10, 0.10), 8, dt);
    this._leanZ = damp(this._leanZ, clamp(-accX * 0.009 - this._turnRate * 0.022 * this.moveK, -0.12, 0.12), 8, dt);

    // Staged continuous posture (0=stand -> 1=crouch -> 2=prone) so lay-down/stand-up passes
    // naturally through crouch/kneel instead of snapping flat through the floor
    const targetPosture = s.prone ? 2 : (s.crouch || s.slide ? 1 : 0);
    const postureRate = (targetPosture === 2 || this._posture > 1.05) ? 6.2 : 9.5;
    this._posture = damp(this._posture, targetPosture, postureRate, dt);

    // LOD0 / LOD1 distance switch (1 draw call always)
    if (this.mesh && this.meshLod1 && s.dist != null) {
      const useLod1 = s.dist > 34 && !this.fpCam;
      if (useLod1 !== this._lod1) {
        this._lod1 = useLod1;
        this.mesh.visible = !useLod1;
        this.meshLod1.visible = useLod1;
      }
    }

    const dead = s.dead || 0;
    const deadE = smooth(clamp(dead, 0, 1));
    const pK = clamp(this._posture - 1, 0, 1), slK = this.slideK;
    const reload = s.reload != null && s.reload >= 0 ? s.reload : -1;
    const melee = s.melee != null && s.melee >= 0 ? s.melee : -1;
    const thr = s.throw != null && s.throw >= 0 ? s.throw : -1;
    this.reloadK = damp(this.reloadK, reload >= 0 ? 1 : 0, 14, dt);

    if (this.mixer) {
      // --- Compute target weights for all cyclic clips ----------------------
      const tgt = Object.fromEntries(LOOP_CLIPS.map((n) => [n, 0]));
      const aliveW = dead > 0.01 ? 0 : 1;

      if (aliveW > 0) {
        const airW = s.air ? 1 : 0;
        const groundW = 1 - airW;
        // Smooth triangular posture weights: stand <-> crouch <-> prone
        const standW  = groundW * clamp(1 - this._posture, 0, 1);
        const crouchW = groundW * clamp(1 - Math.abs(this._posture - 1), 0, 1);
        const proneW  = groundW * clamp(this._posture - 1, 0, 1);

        if (airW > 0) tgt.fall_loop = airW;

        if (proneW > 0.001) {
          const mv = smooth(clamp((speed - 0.08) / 0.42, 0, 1));
          tgt.prone_idle  = proneW * (1 - mv);
          tgt.prone_crawl = proneW * mv;
          if (this.actions.prone_crawl) {
            this.actions.prone_crawl.setEffectiveTimeScale(clamp(speed / REF_SPEEDS.prone_crawl, 0.35, 1.9));
          }
        }

        if (crouchW > 0.001) {
          const mv = s.slide ? 0 : smooth(clamp((speed - 0.10) / 0.50, 0, 1));
          tgt.crouch_idle = crouchW * (1 - mv);
          tgt.crouch_walk = crouchW * mv;
        }

        if (standW > 0.001) {
          if (speed < 0.14) {
            tgt.idle = standW;
          } else {
            // Smooth directional weights from model-space velocity (-Z forward, +X right)
            const invS = 1 / (speed || 1);
            const fx = clamp(-mz * invS, 0, 1);
            const bx = clamp( mz * invS, 0, 1);
            const lx = clamp(-mx * invS, 0, 1);
            const rx = clamp( mx * invS, 0, 1);
            const dSum = fx + bx + lx + rx || 1;
            const wF = fx / dSum, wB = bx / dSum, wL = lx / dSum, wR = rx / dSum;

            // Smooth speed tier blending: idle (0) -> walk (1.5) -> run (4.7) -> sprint (6.7)
            const wWalkTier = speed < 1.5
              ? smooth(clamp(speed / 1.5, 0, 1))
              : 1 - smooth(clamp((speed - 1.5) / 2.5, 0, 1));
            const wIdleTier = speed < 1.5 ? 1 - wWalkTier : 0;
            const wSprintTier = (s.sprint && wF > 0.45) ? smooth(clamp((speed - 4.7) / 1.8, 0, 1)) : 0;
            const wRunTier = clamp(1 - wIdleTier - wWalkTier - wSprintTier, 0, 1);

            tgt.idle       = standW * wIdleTier;
            tgt.walk_fwd   = standW * wWalkTier * wF;
            tgt.walk_back  = standW * wWalkTier * wB;
            tgt.walk_left  = standW * wWalkTier * wL;
            tgt.walk_right = standW * wWalkTier * wR;
            tgt.run_fwd    = standW * wRunTier  * wF;
            tgt.run_back   = standW * wRunTier  * wB;
            tgt.run_left   = standW * wRunTier  * wL;
            tgt.run_right  = standW * wRunTier  * wR;
            tgt.sprint     = standW * wSprintTier;
          }
        }
      }

      // Smooth cross-fades (~0.16-0.24s) with slightly softer transitions for posture changes
      const fadeRate = 9.5;
      for (const nm of LOOP_CLIPS) {
        this._w[nm] = damp(this._w[nm], tgt[nm], fadeRate, dt);
        if (this.actions[nm]) this.actions[nm].setEffectiveWeight(this._w[nm]);
      }

      // --- Phase-locked locomotion sync (zero leg scissoring / zero foot sliding) ---
      // All 10 ground locomotion clips share L heel-strike at phase 0 and R at 0.5.
      // Advance one unified normalized gait phase from the weighted blended stride length.
      let locoWSum = 0, blendedStride = 0;
      for (const nm of LOCO_SYNC_CLIPS) {
        const w = this._w[nm];
        if (w > 0.001 && this.actions[nm]) {
          const dur = this.actions[nm].getClip().duration || 0.7;
          const ref = REF_SPEEDS[nm] || 3.0;
          blendedStride += w * (ref * dur);
          locoWSum += w;
        }
      }
      if (locoWSum > 0.001 && speed > 0.08) {
        const stride = Math.max(0.75, blendedStride / locoWSum);
        const freq = clamp(speed / stride, 0.35, 2.8);
        this.gaitP = (this.gaitP + freq * dt) % 1;
      } else {
        this.gaitP = (this.gaitP + 0.38 * dt) % 1;
      }
      this.phase = this.gaitP * Math.PI * 2;
      for (const nm of LOCO_SYNC_CLIPS) {
        const act = this.actions[nm];
        if (act) {
          act.setEffectiveTimeScale(0);
          act.time = this.gaitP * act.getClip().duration;
        }
      }

      // --- One-shot action triggers -----------------------------------------
      if (s.air && !this._wasAir && aliveW > 0) this._playOnce('jump_start', 0.07, 1.0);
      if (!s.air && this._wasAir && aliveW > 0) this._playOnce('land', 0.05, 1.0);
      this._wasAir = !!s.air;

      const isDead = dead > 0.01;
      if (isDead && !this._wasDead) {
        const dClip = (s.deadDir || 1) < 0 ? 'death_fwd' : 'death_back';
        this._playOnce(dClip, 0.10, 1.0);
      } else if (!isDead && this._wasDead) {
        if (this.actions.death_fwd) this.actions.death_fwd.stop();
        if (this.actions.death_back) this.actions.death_back.stop();
      }
      this._wasDead = isDead;

      const isReload = reload >= 0;
      if (isReload && !this._wasReload && aliveW > 0) {
        const dur = this.actions.reload ? this.actions.reload.getClip().duration : 2.0;
        const wDur = (def && def.reload) || 2.0;
        this._playOnce('reload', 0.14, dur / wDur);
      } else if (!isReload && this._wasReload && this.actions.reload) {
        this.actions.reload.fadeOut(0.18);
      }
      this._wasReload = isReload;

      const isMelee = melee >= 0;
      if (isMelee && !this._wasMelee && aliveW > 0) this._playOnce('melee', 0.06, 1.0);
      this._wasMelee = isMelee;

      const isThrow = thr >= 0;
      if (isThrow && !this._wasThrow && aliveW > 0) this._playOnce('grenade', 0.07, 1.0);
      this._wasThrow = isThrow;

      if (Math.abs(this.flinch) > 0.65 && Math.abs(this._lastFlinch) <= 0.65 && aliveW > 0) {
        this._playOnce('hit_flinch', 0.04, 1.0);
      }
      this._lastFlinch = this.flinch;

      // Advance mixer (updates idle, prone_idle, prone_crawl, crouch_idle, fall_loop, and one-shots)
      this.mixer.update(dt);
    }

    // --- Post-mixer upper-body aim pitch, inertial lean & slide pose --------
    const aim = this.pitch * (1 - deadE);
    const aliveLean = (1 - deadE) * (1 - pK * 0.85);
    const turnLead = clamp(this._turnRate * 0.045, -0.18, 0.18) * aliveLean;
    if (b.spine) {
      _qPitch.setFromAxisAngle(X_AXIS, aim * 0.42 - slK * 0.35 + this._leanX * 0.55 * aliveLean);
      b.spine.quaternion.multiply(_qPitch);
      _qRoll.setFromAxisAngle(Z_AXIS, this._leanZ * 0.55 * aliveLean);
      b.spine.quaternion.multiply(_qRoll);
    }
    if (b.chest) {
      _qPitch.setFromAxisAngle(X_AXIS, aim * 0.46 + this.kick * 0.05 - slK * 0.22 + this._leanX * 0.45 * aliveLean);
      b.chest.quaternion.multiply(_qPitch);
      _qYaw.setFromAxisAngle(Y_AXIS, turnLead * 0.45);
      b.chest.quaternion.multiply(_qYaw);
      const rollAmt = this._leanZ * 0.45 * aliveLean + this.flinch * 0.16;
      if (Math.abs(rollAmt) > 0.002) {
        _qRoll.setFromAxisAngle(Z_AXIS, rollAmt);
        b.chest.quaternion.multiply(_qRoll);
      }
    }
    if (b.head) {
      _qPitch.setFromAxisAngle(X_AXIS, aim * 0.12);
      b.head.quaternion.multiply(_qPitch);
      _qYaw.setFromAxisAngle(Y_AXIS, turnLead * 0.55);
      b.head.quaternion.multiply(_qYaw);
    }
    if (slK > 0.01 && b.hips) {
      _qPitch.setFromAxisAngle(X_AXIS, slK * 0.55);
      b.hips.quaternion.multiply(_qPitch);
    }

    // --- Weapon mount & arm IK onto grips -----------------------------------
    if (b.armL) b.armL.position.copy(b.armL.userData.rest);
    if (b.armR) b.armR.position.copy(b.armR.userData.rest);

    if (dead > 0.05) {
      if (this.weapon) this.weapon.visible = false;
    } else if (pose === 'melee' || !def) {
      if (this.weapon) this.weapon.visible = true;
    } else if (thr < 0) {
      if (this.weapon) this.weapon.visible = true;
      const Pz = POSES[pose];
      const sp = this.sprintK * this.moveK * (1 - this.adsK) * (1 - this.reloadK);
      const ads = this.adsK * (1 - this.reloadK);
      const mp = this.mountPos, mr = this.mountRot;
      let tx = Pz.hip[0], ty = Pz.hip[1], tz = Pz.hip[2], rx = Pz.hip[3], ry = Pz.hip[4], rz = Pz.hip[5];
      const mix = (Q, k) => { tx = lerp(tx, Q[0], k); ty = lerp(ty, Q[1], k); tz = lerp(tz, Q[2], k); rx = lerp(rx, Q[3], k); ry = lerp(ry, Q[4], k); rz = lerp(rz, Q[5], k); };
      mix(Pz.ads, ads);
      mix(Pz.sprint, sp);
      mix(Pz.reload, this.reloadK);
      if (pK > 0.01) { ty = lerp(ty, 0.2, pK); tz = lerp(tz, pose === 'pistol' ? -0.5 : -0.24, pK); ry = lerp(ry, 0.03, pK); }
      mp.set(damp(mp.x, tx, 18, dt), damp(mp.y, ty, 18, dt), damp(mp.z, tz, 18, dt));
      mr.set(damp(mr.x, rx, 18, dt), damp(mr.y, ry, 18, dt), damp(mr.z, rz, 18, dt));
      const carry = clamp(speed / 4.8, 0, 1.2) * this.moveK * (1 - ads);
      const stepWave = Math.cos(this.phase * 2), sideWave = Math.cos(this.phase);
      this.gunMount.position.set(mp.x, mp.y - stepWave * 0.008 * carry, mp.z + this.kick * 0.045);
      _e.set(mr.x + this.kick * 0.09 + stepWave * 0.015 * carry, mr.y, mr.z + sideWave * 0.04 * carry, 'YXZ');
      this.gunMount.quaternion.setFromEuler(_e);
      this.gunMount.updateMatrix();
      this.gripWeapon(reload);
    }

    // Ground blob shadow
    this.shadow.position.set(0, (s.groundY != null ? s.groundY - this.root.position.y : 0) + 0.035, lerp(0, -0.5, pK));
    const sh = 1 + pK * 0.5 + deadE * 0.4;
    this.shadow.scale.set(sh, 1, sh + pK * 0.6);
  }

  dispose() {
    if (this.mixer) this.mixer.stopAllAction();
    if (this.root.parent) this.root.parent.remove(this.root);
    if (this.mesh && this.mesh.skeleton) this.mesh.skeleton.dispose();
    if (this.meshLod1 && this.meshLod1.skeleton) this.meshLod1.skeleton.dispose();
  }
}
