// Weapon carry poses, A-pose hand IK basis constants, and locomotion clip metadata for Soldier2.
import * as THREE from 'three';
import { SOLDIER2_META } from './soldier2_asset.js';

export const POSES = {
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

export const UPPER_DIR_L = new THREE.Vector3(-0.229, -0.160,  0.015).normalize();
export const FORE_DIR_L  = new THREE.Vector3(-0.213, -0.149, -0.015).normalize();
export const UPPER_DIR_R = new THREE.Vector3( 0.229, -0.160,  0.015).normalize();
export const FORE_DIR_R  = new THREE.Vector3( 0.213, -0.149, -0.015).normalize();
export const UPPER_LEN = Math.hypot(0.229, 0.160, 0.015);
export const FORE_LEN  = Math.hypot(0.213, 0.149, 0.015);

function restHandBasis(side) {
  const s = side === 'L' ? -1 : 1;
  const along = (side === 'L' ? FORE_DIR_L : FORE_DIR_R).clone();
  const fwd = new THREE.Vector3(0, 0, -1);
  const back = new THREE.Vector3().crossVectors(along, fwd).normalize().multiplyScalar(-s);
  const x = back.clone().multiplyScalar(s);
  const y = along.clone().negate();
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
const HAND_REST_L_INV = restHandBasis('L').invert();
const HAND_REST_R_INV = restHandBasis('R').invert();

export const GRIP_R_LOCAL = FORE_DIR_R.clone().multiplyScalar(0.068).add(new THREE.Vector3(-0.016, -0.014, 0.004));
export const GRIP_L_LOCAL = FORE_DIR_L.clone().multiplyScalar(0.068).add(new THREE.Vector3( 0.016, -0.014, 0.004));

function handTurn(xAxis, fingers) {
  const x = new THREE.Vector3(...xAxis).normalize();
  const f = new THREE.Vector3(...fingers);
  const y = f.addScaledVector(x, -f.dot(x)).normalize().negate();
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
const TRIGGER_HAND = handTurn([1, 0, 0], [0, -0.34, -0.94]);
export const HOLD = {
  rifle: {
    R: TRIGGER_HAND.clone().multiply(HAND_REST_R_INV),
    L: handTurn([0.24, 0.96, 0.12], [0.95, 0.04, -0.30]).multiply(HAND_REST_L_INV),
    rOff: [0, 0, 0], lOff: [-0.015, -0.014, 0.004],
  },
  pistol: {
    R: TRIGGER_HAND.clone().multiply(HAND_REST_R_INV),
    L: handTurn([1, 0.12, 0.1], [0.35, -0.42, -1]).multiply(HAND_REST_L_INV),
    rOff: [0, -0.004, -0.004], lOff: [-0.03, -0.018, -0.012], elbows: 0.35,
  },
};
HOLD.sniper = HOLD.rifle;

export const FP_SHOULDER = { L: [0.0, -0.08, -0.13], R: [0.0, -0.03, -0.06] };
export const NO_SHIFT = [0, 0, 0];
export const FP_WRIST_MAX = 0.35;
export const FP_WRIST_PASSES = 2;

export const REF_SPEEDS = SOLDIER2_META.refSpeeds || {
  walk_fwd: 1.5, walk_back: 1.5, walk_left: 1.5, walk_right: 1.5,
  run_fwd: 4.7, run_back: 3.6, run_left: 4.2, run_right: 4.2,
  sprint: 6.7, crouch_walk: 2.6, prone_crawl: 1.0,
};

export const LOCO_SYNC_CLIPS = [
  'walk_fwd', 'walk_back', 'walk_left', 'walk_right',
  'run_fwd', 'run_back', 'run_left', 'run_right', 'sprint', 'crouch_walk',
];
export const LOOP_CLIPS = [
  'idle', ...LOCO_SYNC_CLIPS,
  'crouch_idle', 'prone_idle', 'prone_crawl', 'fall_loop',
];
