// Weapon stats and weapon models.
//
// Damage is a list of [range in metres, damage] steps (CoD-style drop-off);
// spread and recoil are in degrees; times in seconds.
import * as THREE from 'three';
import { pbrMaterial } from '../core/pbr.js';
import { meshGeometry } from '../core/meshasset.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { WEAPON_ASSETS } from './weapons_asset.js';
import { WEAPON_GLB } from './weapons_glb.js';

export const CATEGORIES = [
  { id: 'assault', label: 'ASSAULT RIFLE', short: 'AR' },
  { id: 'sniper', label: 'SNIPER RIFLE', short: 'SNIPER' },
  { id: 'handgun', label: 'HANDGUN', short: 'PISTOL' },
  { id: 'melee', label: 'MELEE', short: 'MELEE' },
];

export const WEAPONS = {
  // --- assault rifles -------------------------------------------------------
  m4: {
    id: 'm4', name: 'M4', cat: 'assault', optic: 'holo', desc: 'Balanced carbine. Fast, controllable, reliable.',
    mode: 'auto', rpm: 780, mag: 30, reserve: 180, reload: 2.0,
    dmg: [[22, 27], [42, 23], [70, 19]], head: 1.45, limb: 0.92, range: 320,
    hip: 1.9, ads: 0.2, recoilV: 0.34, recoilH: 0.18, adsTime: 0.22, adsFov: 40, adsMove: 0.62, mobility: 1.0,
    sound: 'rifle', pose: 'rifle', bars: { damage: 55, rate: 78, accuracy: 72, mobility: 70, range: 60 },
  },
  ak47: {
    id: 'ak47', name: 'AK-47', cat: 'assault', desc: 'Hits hard at any range, kicks harder.',
    mode: 'auto', rpm: 600, mag: 30, reserve: 180, reload: 2.4,
    dmg: [[26, 34], [48, 28], [80, 24]], head: 1.45, limb: 0.92, range: 340,
    hip: 2.3, ads: 0.24, recoilV: 0.52, recoilH: 0.3, adsTime: 0.25, adsFov: 40, adsMove: 0.58, mobility: 0.97,
    sound: 'rifleHeavy', pose: 'rifle', bars: { damage: 72, rate: 60, accuracy: 55, mobility: 62, range: 68 },
  },
  m16: {
    id: 'm16', name: 'M16', cat: 'assault', desc: 'Three-round burst. Lethal in disciplined hands.',
    mode: 'burst', burst: 3, burstDelay: 0.22, rpm: 900, mag: 30, reserve: 180, reload: 2.1,
    dmg: [[32, 34], [58, 29], [90, 25]], head: 1.5, limb: 0.92, range: 360,
    hip: 2.1, ads: 0.15, recoilV: 0.3, recoilH: 0.1, adsTime: 0.24, adsFov: 38, adsMove: 0.6, mobility: 0.98,
    sound: 'rifle', pose: 'rifle', bars: { damage: 70, rate: 58, accuracy: 82, mobility: 66, range: 76 },
  },
  // --- sniper rifles --------------------------------------------------------
  m40: {
    id: 'm40', name: 'M40A5', cat: 'sniper', desc: 'Bolt action. One shot to the chest or head.',
    mode: 'bolt', rpm: 46, mag: 5, reserve: 30, reload: 3.0,
    dmg: [[1000, 125]], head: 2.0, limb: 0.78, range: 900,
    hip: 7.5, ads: 0.0, recoilV: 3.0, recoilH: 0.5, adsTime: 0.34, adsFov: 13, adsMove: 0.36, mobility: 0.93,
    scope: true, sound: 'sniper', pose: 'sniper', bars: { damage: 92, rate: 16, accuracy: 94, mobility: 52, range: 96 },
  },
  m107: {
    id: 'm107', name: 'M107 .50', cat: 'sniper', desc: 'Semi-auto anti-materiel rifle. Stops anything.',
    mode: 'semi', rpm: 115, mag: 8, reserve: 32, reload: 3.6,
    dmg: [[1000, 150]], head: 2.0, limb: 0.82, range: 900,
    hip: 9.0, ads: 0.04, recoilV: 4.4, recoilH: 1.1, adsTime: 0.46, adsFov: 11, adsMove: 0.3, mobility: 0.87,
    scope: true, sound: 'sniperHeavy', pose: 'sniper', bars: { damage: 100, rate: 30, accuracy: 86, mobility: 38, range: 100 },
  },
  ksr29: {
    id: 'ksr29', name: 'KSR-29', cat: 'sniper', desc: 'Bipod-ready bolt-action. One shot to the chest or head.',
    mode: 'bolt', rpm: 42, mag: 5, reserve: 30, reload: 3.2,
    dmg: [[1000, 128]], head: 2.0, limb: 0.78, range: 900,
    hip: 7.8, ads: 0.0, recoilV: 3.3, recoilH: 0.55, adsTime: 0.36, adsFov: 12, adsMove: 0.34, mobility: 0.91,
    scope: true, sound: 'sniper', pose: 'sniper', bars: { damage: 94, rate: 14, accuracy: 95, mobility: 48, range: 97 },
  },
  // --- handguns -------------------------------------------------------------
  m1911: {
    id: 'm1911', name: 'M1911', cat: 'handgun', desc: 'Classic .45 slab-sided sidearm. Hits harder, kicks harder.',
    mode: 'semi', rpm: 360, mag: 8, reserve: 56, reload: 1.6,
    dmg: [[12, 42], [24, 31], [42, 22]], head: 1.5, limb: 0.92, range: 110,
    hip: 1.5, ads: 0.3, recoilV: 1.15, recoilH: 0.38, adsTime: 0.15, adsFov: 50, adsMove: 0.9, mobility: 1.03,
    sound: 'pistol', pose: 'pistol', bars: { damage: 52, rate: 46, accuracy: 60, mobility: 88, range: 28 },
  },
  m9: {
    id: 'm9', name: 'M9', cat: 'handgun', desc: 'Standard-issue 9 mm sidearm. Quick on the draw.',
    mode: 'semi', rpm: 420, mag: 15, reserve: 75, reload: 1.45,
    dmg: [[13, 36], [26, 27], [46, 20]], head: 1.5, limb: 0.92, range: 120,
    hip: 1.4, ads: 0.28, recoilV: 0.9, recoilH: 0.32, adsTime: 0.14, adsFov: 50, adsMove: 0.9, mobility: 1.05,
    sound: 'pistol', pose: 'pistol', bars: { damage: 40, rate: 55, accuracy: 62, mobility: 92, range: 30 },
  },
  d50: {
    id: 'd50', name: '.50 GS', cat: 'handgun', desc: 'Hand cannon. Two shots is usually one too many.',
    mode: 'semi', rpm: 185, mag: 7, reserve: 42, reload: 1.8,
    dmg: [[15, 68], [32, 50], [55, 36]], head: 1.6, limb: 0.9, range: 140,
    hip: 1.8, ads: 0.3, recoilV: 2.6, recoilH: 0.7, adsTime: 0.18, adsFov: 50, adsMove: 0.86, mobility: 1.02,
    sound: 'pistolHeavy', pose: 'pistol', bars: { damage: 76, rate: 26, accuracy: 58, mobility: 84, range: 38 },
  },
  // --- melee ----------------------------------------------------------------
  knife: {
    id: 'knife', name: 'Combat Knife', cat: 'melee', desc: 'Silent, instant, and it makes you faster.',
    dmg: [[10, 150]], reach: 2.3, lunge: 3.4, swing: 0.46, hitAt: 0.2, mobility: 1.1,
    sound: 'swish', pose: 'melee', bars: { damage: 100, rate: 70, accuracy: 100, mobility: 100, range: 4 },
  },
  sword: {
    id: 'sword', name: 'Longsword', cat: 'melee', desc: 'A fantasy blade with real reach. Slow, but it cuts anything.',
    dmg: [[10, 150]], reach: 3.0, lunge: 2.8, swing: 0.7, hitAt: 0.32, mobility: 1.0,
    sound: 'swish', pose: 'melee', bars: { damage: 100, rate: 42, accuracy: 100, mobility: 84, range: 8 },
  },
  axe: {
    id: 'axe', name: 'Tomahawk', cat: 'melee', desc: 'Heavier swing with a longer reach.',
    dmg: [[10, 150]], reach: 2.8, lunge: 3.0, swing: 0.64, hitAt: 0.3, mobility: 1.05,
    sound: 'swish', pose: 'melee', bars: { damage: 100, rate: 50, accuracy: 100, mobility: 90, range: 6 },
  },
};

export const DEFAULT_LOADOUT = { assault: 'm4', sniper: 'ksr29', handgun: 'm1911', melee: 'knife' };
export const weaponsIn = (cat) => Object.values(WEAPONS).filter((w) => w.cat === cat);

export function damageAt(def, dist) {
  const d = def.dmg;
  for (let i = 0; i < d.length; i++) if (dist <= d[i][0]) return d[i][1];
  return d[d.length - 1][1];
}

// ---------------------------------------------------------------------------
// Models. Built in Blender (tools/blender/build_weapons.py): bevelled parts,
// round barrels and scopes, ambient occlusion baked into the vertex colours.
// Guns point down -Z with the pistol grip at the origin.
// ---------------------------------------------------------------------------
// Real overall lengths (m). The Blender meshes are authored around the game's
// older, oversized hand anchors, so each gun is scaled back to true size.
const REAL_LENGTH = { m4: 0.8, ak47: 0.88, m16: 1.0, m40: 1.12, m107: 1.45, m9: 0.217, d50: 0.273 };

let gunMaterial = null;
const modelCache = new Map();

// ---------------------------------------------------------------------------
// Third-party glTF weapons (tools/blender/import_weapons.py -> weapons_glb.js,
// credits in docs/CREDITS.md). Decoded once at boot; the models are already in
// true size (fit = 1) with the grip near the origin and the muzzle toward -Z.
// ---------------------------------------------------------------------------
const glbModels = new Map();   // id -> { scene, points }

function decodeBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export async function loadWeaponAssets() {
  const loader = new GLTFLoader();
  await Promise.all(Object.keys(WEAPON_GLB).map((id) => new Promise((resolve) => {
    try {
      loader.parse(decodeBase64(WEAPON_GLB[id].glb), '', (gltf) => {
        gltf.scene.traverse((o) => {
          if (!o.isMesh) return;
          o.castShadow = true;
          o.frustumCulled = false;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            if (!m) continue;
            m.envMapIntensity = 1.0;
            if (m.map && m.map.anisotropy !== undefined) m.map.anisotropy = 4;
            if (m.normalMap && m.normalMap.anisotropy !== undefined) m.normalMap.anisotropy = 4;
          }
        });
        glbModels.set(id, { scene: gltf.scene, points: WEAPON_GLB[id].points });
        resolve();
      }, (e) => { console.warn('weapon glb failed', id, e); resolve(); });
    } catch (e) { console.warn('weapon glb failed', id, e); resolve(); }
  })));
}

/** Returns a new Mesh (or Group, for the glTF weapons) for the weapon plus its attachment points. */
export function makeWeaponModel(id) {
  const glb = glbModels.get(id);
  if (glb) {
    const mesh = glb.scene.clone(true);   // geometry and materials are shared
    mesh.userData.fit = 1;                // already true size
    return { mesh, points: glb.points };
  }
  if (!gunMaterial) gunMaterial = pbrMaterial({ grain: 260, grainAmount: 0.16 });
  let entry = modelCache.get(id);
  if (!entry) {
    const a = WEAPON_ASSETS[id];
    const geometry = meshGeometry(a.mesh, a.meta);
    geometry.computeBoundingBox();
    const len = geometry.boundingBox.max.z - geometry.boundingBox.min.z;
    entry = { geometry, points: a.points, fit: REAL_LENGTH[id] && len > 0 ? REAL_LENGTH[id] / len : 0 };
    modelCache.set(id, entry);
  }
  const mesh = new THREE.Mesh(entry.geometry, gunMaterial);
  mesh.castShadow = true;
  mesh.userData.fit = entry.fit;   // true-size scale (0 = keep the pose's own scale)
  mesh.frustumCulled = false;
  return { mesh, points: entry.points };
}
