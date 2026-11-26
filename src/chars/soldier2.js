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
import { SOLDIER2_GLB } from './soldier2_asset.js';
import {
  POSES, UPPER_DIR_L, FORE_DIR_L, UPPER_DIR_R, FORE_DIR_R, UPPER_LEN, FORE_LEN,
  GRIP_R_LOCAL, GRIP_L_LOCAL, HOLD, FP_SHOULDER, NO_SHIFT, FP_WRIST_MAX, FP_WRIST_PASSES,
  REF_SPEEDS, LOCO_SYNC_CLIPS, LOOP_CLIPS,
} from './soldier2_pose.js';

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

const UPPER_BODY_BONES = new Set([
  'chest', 'neck', 'head',
  'clavicleL', 'clavicleR', 'upperArmL', 'upperArmR',
  'forearmL', 'forearmR', 'handL', 'handR',
  'thumbL', 'thumbR', 'fingersL', 'fingersR',
]);
const UPPER_ONLY_CLIPS = new Set(['reload', 'melee', 'grenade', 'hit_flinch']);

// Phone-safe GPU team tinting: shares the single 2048 albedo texture across both teams
// (halves soldier GPU texture RAM and avoids a 2x2048^2 main-thread canvas pixel loop).
function applyTeamTint(mat, kind) {
  const look = TEAM_TINT[kind] || TEAM_TINT.marine;
  const sat = look.sat;
  const mul = new THREE.Vector3(look.mul[0], look.mul[1], look.mul[2]);
  mat.customProgramCacheKey = () => `soldier2_tint_${kind}`;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTeamSat = { value: sat };
    shader.uniforms.uTeamMul = { value: mul };
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uTeamSat;\nuniform vec3 uTeamMul;'
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          vec3 tinted = (vec3(lum) + (diffuseColor.rgb - vec3(lum)) * uTeamSat) * uTeamMul;
          diffuseColor.rgb = clamp(tinted, 0.0, 1.0);
        }`
      );
  };
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
    if (baseMat && baseMat.map) baseMat.map.anisotropy = 4;
    if (baseMat && baseMat.normalMap) baseMat.normalMap.anisotropy = 4;
    if (baseMat && baseMat.roughnessMap) baseMat.roughnessMap.anisotropy = 4;
    const materials = {};
    for (const kind of ['marine', 'enemy']) {
      const m = baseMat ? baseMat.clone() : new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
      applyTeamTint(m, kind);
      m.roughness = 1.0;
      m.metalness = 1.0;
      m.envMapIntensity = 0.7;
      m.needsUpdate = true;
      materials[kind] = m;
    }
    // Keep only upper-body tracks on action clips so prone/crouch postures never pop upright
    const clips = (gltf.animations || []).map((clip) => {
      if (!UPPER_ONLY_CLIPS.has(clip.name)) return clip;
      const filtered = clip.tracks.filter((tr) => {
        const dot = tr.name.indexOf('.');
        const bone = dot >= 0 ? tr.name.slice(0, dot) : tr.name;
        return UPPER_BODY_BONES.has(bone);
      });
      return new THREE.AnimationClip(clip.name, clip.duration, filtered);
    });
    asset = { scene: gltf.scene, clips, materials };
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

const HAND_FREE = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.25, 0, 0));
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _g1 = new THREE.Vector3(), _g2 = new THREE.Vector3(), _g3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _qR = new THREE.Quaternion(), _qL = new THREE.Quaternion(), _qA = new THREE.Quaternion();
const _qPitch = new THREE.Quaternion(), _qRoll = new THREE.Quaternion();
const _e = new THREE.Euler();
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
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
    this._tgt = Object.fromEntries(LOOP_CLIPS.map((n) => [n, 0]));
    this._posture = 0;       // continuous 0=stand -> 1=crouch -> 2=prone (passes smoothly through crouch)
    this._smMoveX = 0;
    this._smMoveZ = 0;
    this._smSpeed = 0;
    this._prevYaw = 0;
    this._turnRateFilt = 0;
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
    const sh = this._fpLongGun ? FP_SHOULDER[side] : NO_SHIFT;
    const rest = arm.userData.rest;
    const Sx = cOff.x + rest.x + sh[0];
    const Sy = cOff.y + rest.y + sh[1];
    const Sz = cOff.z + rest.z + sh[2];

    _v1.set(tx - Sx, ty - Sy, tz - Sz);
    let d = _v1.length();
    _v1.divideScalar(d || 1);
    const reach = UPPER_LEN + FORE_LEN - 0.005;
    const slack = clamp(d - reach, 0, 0.075);
    arm.position.set(rest.x + sh[0], rest.y + sh[1], rest.z + sh[2]).addScaledVector(_v1, slack);
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
    this._fpLongGun = false;
    if (!def || !pts || !w || def.pose === 'melee') return;
    // pistols already sit close to the chest in first person; only long guns need the reach fix
    this._fpLongGun = !!this.fpCam && def.pose !== 'pistol';
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
    if (this.fpCam) this._limitSupportWrist(lx + _g3.x, ly + _g3.y, lz + _g3.z, -out);
    if (onGun < 1) b.handL.quaternion.slerp(HAND_FREE, 1 - onGun);
  }

  /**
   * First person: cap the left wrist bend, then re-aim the arm so the palm
   * (not the wrist) stays on the grip point (gx, gy, gz, chest space).
   */
  _limitSupportWrist(gx, gy, gz, pole) {
    const b = this.b, hand = b.handL.quaternion;
    for (let i = 0; i < FP_WRIST_PASSES; i++) {
      const bend = 2 * Math.acos(clamp(Math.abs(hand.w), 0, 1));
      if (bend <= FP_WRIST_MAX) return;
      _q1.identity().slerp(hand, FP_WRIST_MAX / bend);
      // world (chest-space) orientation the hand will have after the limit
      _qA.copy(b.armL.quaternion).multiply(b.foreL.quaternion).multiply(_q1);
      _g3.copy(GRIP_L_LOCAL).applyQuaternion(_qA);
      this._ik('L', gx - _g3.x, gy - _g3.y, gz - _g3.z, pole);
      // keep that orientation under the re-solved forearm
      hand.copy(b.armL.quaternion).multiply(b.foreL.quaternion).invert().multiply(_qA);
    }
    // the last re-solve can move the forearm again: hard-cap the bend that is left
    const bend = 2 * Math.acos(clamp(Math.abs(hand.w), 0, 1));
    if (bend > FP_WRIST_MAX) hand.copy(_q1.identity().slerp(hand, FP_WRIST_MAX / bend));
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

    // Smooth locomotion inputs to eliminate directional blend kinks & frame-rate jitter
    const rawSpeed = s.speed || 0;
    const rawMx = s.moveX || 0, rawMz = s.moveZ || 0;
    this._smMoveX = damp(this._smMoveX, rawMx, 18, dt);
    this._smMoveZ = damp(this._smMoveZ, rawMz, 18, dt);
    this._smSpeed = damp(this._smSpeed, rawSpeed, 18, dt);
    const speed = rawSpeed > 0.25 ? Math.max(this._smSpeed, rawSpeed * 0.72) : this._smSpeed;
    const mx = this._smMoveX, mz = this._smMoveZ;
    const moving = speed > 0.14;
    this.moveK = damp(this.moveK, moving ? 1 : 0, 14, dt);

    // Double-filtered yaw turn rate & horizontal acceleration (ignore dt > 0.08s spikes)
    const curYaw = this.root.rotation.y || 0;
    let dYaw = curYaw - this._prevYaw;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    this._prevYaw = curYaw;
    if (dt > 0.001 && dt <= 0.08) {
      const instTurn = clamp(dYaw / dt, -4.5, 4.5);
      this._turnRateFilt = damp(this._turnRateFilt, instTurn, 12, dt);
      const accX = clamp((mx - this._prevMoveX) / dt, -14, 14);
      const accZ = clamp((mz - this._prevMoveZ) / dt, -14, 14);
      this._leanX = damp(this._leanX, clamp(accZ * 0.007, -0.085, 0.085), 7, dt);
      this._leanZ = damp(this._leanZ, clamp(-accX * 0.008 - this._turnRate * 0.020 * this.moveK, -0.10, 0.10), 7, dt);
    } else {
      this._turnRateFilt = damp(this._turnRateFilt, 0, 8, dt);
      this._leanX = damp(this._leanX, 0, 7, dt);
      this._leanZ = damp(this._leanZ, 0, 7, dt);
    }
    this._turnRate = damp(this._turnRate, this._turnRateFilt, 9, dt);
    this._prevMoveX = mx; this._prevMoveZ = mz;

    // Staged continuous posture (0=stand -> 1=crouch -> 2=prone) so lay-down/stand-up passes
    // naturally through crouch/kneel instead of snapping flat through the floor
    const targetPosture = s.prone ? 2 : (s.crouch || s.slide ? 1 : 0);
    const postureRate = (targetPosture === 2 || this._posture > 1.05) ? 6.2 : 9.5;
    this._posture = damp(this._posture, targetPosture, postureRate, dt);

    // LOD0 / LOD1 distance switch (1 draw call always; LOD1 kicks in past 22m where fine finger detail is sub-pixel)
    if (this.mesh && this.meshLod1 && s.dist != null) {
      const useLod1 = s.dist > 22 && !this.fpCam;
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
      const tgt = this._tgt;
      for (let i = 0; i < LOOP_CLIPS.length; i++) tgt[LOOP_CLIPS[i]] = 0;
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
            // Squared directional weights from smoothed velocity (-Z forward, +X right) for kink-free blending
            const invS = 1 / (speed || 1);
            const fx = clamp(-mz * invS, 0, 1);
            const bx = clamp( mz * invS, 0, 1);
            const lx = clamp(-mx * invS, 0, 1);
            const rx = clamp( mx * invS, 0, 1);
            const f2 = fx * fx, b2 = bx * bx, l2 = lx * lx, r2 = rx * rx;
            const dSum = f2 + b2 + l2 + r2 || 1;
            const wF = f2 / dSum, wB = b2 / dSum, wL = l2 / dSum, wR = r2 / dSum;

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

      // Crisp locomotion entry/exit (~0.07s) so start/stop plants immediately without sliding
      for (const nm of LOOP_CLIPS) {
        const rate = (nm.startsWith('crouch') || nm.startsWith('prone')) ? 9.5 : 14.5;
        this._w[nm] = damp(this._w[nm], tgt[nm], rate, dt);
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
      if (s.air && !this._wasAir && aliveW > 0 && this._posture < 0.5) this._playOnce('jump_start', 0.07, 1.0);
      if (!s.air && this._wasAir && aliveW > 0 && this._posture < 0.5) this._playOnce('land', 0.05, 1.0);
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

    // --- Post-mixer upper-body aim pitch, inertial lean, ADS cheek-weld & slide pose ---
    const aim = this.pitch * (1 - deadE);
    const aliveLean = (1 - deadE) * (1 - pK * 0.85);
    const turnLead = clamp(this._turnRate * 0.040, -0.16, 0.16) * aliveLean;
    if (b.spine) {
      _qPitch.setFromAxisAngle(X_AXIS, aim * 0.42 - slK * 0.28 + this._leanX * 0.55 * aliveLean);
      b.spine.quaternion.multiply(_qPitch);
      _qRoll.setFromAxisAngle(Z_AXIS, this._leanZ * 0.55 * aliveLean);
      b.spine.quaternion.multiply(_qRoll);
    }
    if (b.chest) {
      _qPitch.setFromAxisAngle(X_AXIS, aim * 0.46 + this.kick * 0.05 - slK * 0.16 + this._leanX * 0.45 * aliveLean);
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
      const cheekTilt = -0.08 * this.adsK * (1 - deadE);
      if (Math.abs(cheekTilt) > 0.002) {
        _qRoll.setFromAxisAngle(Z_AXIS, cheekTilt);
        b.head.quaternion.multiply(_qRoll);
      }
    }
    // Athletic knee/baseball slide pose (lower hips, lead leg extended, trailing leg tucked)
    if (slK > 0.01 && dead <= 0.01 && b.hips) {
      b.hips.position.y = lerp(b.hips.position.y, 0.43, slK);
      _qPitch.setFromAxisAngle(X_AXIS, slK * 0.34);
      b.hips.quaternion.multiply(_qPitch);
      _qYaw.setFromAxisAngle(Y_AXIS, -slK * 0.24);
      b.hips.quaternion.multiply(_qYaw);
      if (b.thighL) { _qPitch.setFromAxisAngle(X_AXIS, -slK * 0.72); b.thighL.quaternion.multiply(_qPitch); }
      if (b.shinL)  { _qPitch.setFromAxisAngle(X_AXIS, -slK * 0.55); b.shinL.quaternion.multiply(_qPitch); }
      if (b.footL)  { _qPitch.setFromAxisAngle(X_AXIS,  slK * 0.30); b.footL.quaternion.multiply(_qPitch); }
      if (b.thighR) { _qPitch.setFromAxisAngle(X_AXIS,  slK * 0.65); b.thighR.quaternion.multiply(_qPitch); }
      if (b.shinR)  { _qPitch.setFromAxisAngle(X_AXIS,  slK * 0.75); b.shinR.quaternion.multiply(_qPitch); }
      if (b.footR)  { _qPitch.setFromAxisAngle(X_AXIS, -slK * 0.45); b.footR.quaternion.multiply(_qPitch); }
    }

    // --- Weapon mount & arm IK onto grips -----------------------------------
    if (b.armL) b.armL.position.copy(b.armL.userData.rest);
    if (b.armR) b.armR.position.copy(b.armR.userData.rest);

    if (dead > 0.05) {
      if (this.weapon) this.weapon.visible = false;
    } else if (pose === 'melee' || !def) {
      if (this.weapon) this.weapon.visible = true;
    } else if (thr < 0) {
      if (this.weapon) {
        this.weapon.visible = true;
        const fpVis = !!this.fpCam;
        for (let i = 0; i < this.weapon.children.length; i++) {
          const ch = this.weapon.children[i];
          if (ch.userData && ch.userData.fpOnly) ch.visible = fpVis;
        }
      }
      const Pz = POSES[pose];
      const sp = this.sprintK * this.moveK * (1 - this.adsK) * (1 - this.reloadK);
      const ads = this.adsK * (1 - this.reloadK);
      const mp = this.mountPos, mr = this.mountRot;
      let tx = Pz.hip[0], ty = Pz.hip[1], tz = Pz.hip[2], rx = Pz.hip[3], ry = Pz.hip[4], rz = Pz.hip[5];
      const mix = (Q, k) => { tx = lerp(tx, Q[0], k); ty = lerp(ty, Q[1], k); tz = lerp(tz, Q[2], k); rx = lerp(rx, Q[3], k); ry = lerp(ry, Q[4], k); rz = lerp(rz, Q[5], k); };
      mix(Pz.ads, ads);
      mix(Pz.sprint, sp);
      mix(Pz.reload, this.reloadK);
      // Prone weapon leveling: compensate ~-0.96 rad chest forward pitch so rifle aims level ahead
      if (pK > 0.01) {
        tx = lerp(tx, 0.06, pK);
        ty = lerp(ty, 0.24, pK);
        tz = lerp(tz, pose === 'pistol' ? -0.44 : -0.22, pK);
        rx = rx + 0.88 * pK;
        ry = lerp(ry, 0.03, pK);
      }
      // Tactical slide rifle cant
      if (slK > 0.01) {
        const slCant = slK * (1 - ads);
        tx += 0.03 * slCant;
        ty -= 0.02 * slCant;
        rz = lerp(rz, 0.42, slCant);
      }
      mp.set(damp(mp.x, tx, 18, dt), damp(mp.y, ty, 18, dt), damp(mp.z, tz, 18, dt));
      mr.set(damp(mr.x, rx, 18, dt), damp(mr.y, ry, 18, dt), damp(mr.z, rz, 18, dt));
      const carry = clamp(speed / 4.8, 0, 1.2) * this.moveK * (1 - ads);
      const stepWave = Math.cos(this.phase * 2), sideWave = Math.cos(this.phase), sideSin = Math.sin(this.phase);
      const swayLag = clamp(this._turnRate * 0.015, -0.04, 0.04) * (1 - ads);
      this.gunMount.position.set(
        mp.x + sideSin * 0.009 * carry,
        mp.y - stepWave * 0.010 * carry - Math.abs(this._leanZ) * 0.04,
        mp.z + this.kick * 0.045,
      );
      _e.set(mr.x + this.kick * 0.09 + stepWave * 0.018 * carry, mr.y - swayLag, mr.z + sideWave * 0.048 * carry + swayLag * 0.5, 'YXZ');
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
