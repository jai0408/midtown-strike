// Weapon stats and low-poly weapon models.
//
// Damage is a list of [range in metres, damage] steps (CoD-style drop-off);
// spread and recoil are in degrees; times in seconds.
import * as THREE from 'three';
import { Geo, C, mulC } from '../world/geo.js';

export const CATEGORIES = [
  { id: 'assault', label: 'ASSAULT RIFLE', short: 'AR' },
  { id: 'sniper', label: 'SNIPER RIFLE', short: 'SNIPER' },
  { id: 'handgun', label: 'HANDGUN', short: 'PISTOL' },
  { id: 'melee', label: 'MELEE', short: 'MELEE' },
];

export const WEAPONS = {
  // --- assault rifles -------------------------------------------------------
  m4: {
    id: 'm4', name: 'M4', cat: 'assault', desc: 'Balanced carbine. Fast, controllable, reliable.',
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
  // --- handguns -------------------------------------------------------------
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
  axe: {
    id: 'axe', name: 'Tomahawk', cat: 'melee', desc: 'Heavier swing with a longer reach.',
    dmg: [[10, 150]], reach: 2.8, lunge: 3.0, swing: 0.64, hitAt: 0.3, mobility: 1.05,
    sound: 'swish', pose: 'melee', bars: { damage: 100, rate: 50, accuracy: 100, mobility: 90, range: 6 },
  },
};

export const DEFAULT_LOADOUT = { assault: 'm4', sniper: 'm40', handgun: 'm9', melee: 'knife' };
export const weaponsIn = (cat) => Object.values(WEAPONS).filter((w) => w.cat === cat);

export function damageAt(def, dist) {
  const d = def.dmg;
  for (let i = 0; i < d.length; i++) if (dist <= d[i][0]) return d[i][1];
  return d[d.length - 1][1];
}

// ---------------------------------------------------------------------------
// Models. Guns point down -Z with the pistol grip at the origin.
// ---------------------------------------------------------------------------
const GUN = C('#26282c'), GUN2 = C('#3a3d43'), TAN = C('#7a6748'), WOOD = C('#6b4226'), OLIVE = C('#4d5239');
const STEELC = C('#9a9da3'), BLADE = C('#c9ccd1');

function tubeZ(G, x, y, z0, z1, r, col, sides = 6) {
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2;
    const p0 = [x + Math.cos(a0) * r, y + Math.sin(a0) * r], p1 = [x + Math.cos(a1) * r, y + Math.sin(a1) * r];
    G.quad([p0[0], p0[1], z1], [p1[0], p1[1], z1], [p1[0], p1[1], z0], [p0[0], p0[1], z0], col);
  }
}
const bx = (G, x, y0, y1, z0, z1, col) => G.box(-x, y0, z0, x, y1, z1, col, 63);

const BUILD = {
  m4(G) {
    bx(G, 0.022, 0.01, 0.075, -0.22, 0.06, GUN);
    bx(G, 0.026, 0.015, 0.072, -0.52, -0.22, TAN);
    tubeZ(G, 0, 0.045, -0.7, -0.52, 0.01, GUN2);
    tubeZ(G, 0, 0.045, -0.75, -0.7, 0.014, GUN);
    bx(G, 0.006, 0.07, 0.108, -0.5, -0.47, GUN);
    bx(G, 0.012, 0.075, 0.086, -0.5, 0.05, GUN2);
    bx(G, 0.02, 0.086, 0.134, -0.11, -0.03, GUN);
    tubeZ(G, 0, 0.045, 0.06, 0.2, 0.014, GUN2);
    G.taper([-0.02, 0.15, 0.02, 0.31], -0.035, [-0.02, 0.17, 0.02, 0.31], 0.075, TAN);
    G.taper([-0.015, 0.02, 0.015, 0.06], -0.09, [-0.015, -0.005, 0.015, 0.04], 0.012, GUN);
    G.taper([-0.012, -0.15, 0.012, -0.095], -0.15, [-0.012, -0.13, 0.012, -0.075], 0.012, GUN2);
    return { muzzle: [0, 0.045, -0.76], left: [0, 0.015, -0.37], right: [0, -0.035, 0.03], mag: [0, -0.12, -0.11] };
  },
  ak47(G) {
    bx(G, 0.022, 0.01, 0.07, -0.2, 0.08, GUN);
    bx(G, 0.025, 0.005, 0.06, -0.44, -0.2, WOOD);
    bx(G, 0.014, 0.06, 0.085, -0.5, -0.2, GUN2);
    tubeZ(G, 0, 0.04, -0.72, -0.44, 0.009, GUN2);
    bx(G, 0.006, 0.05, 0.1, -0.69, -0.66, GUN);
    bx(G, 0.004, 0.07, 0.092, -0.14, -0.12, GUN);
    G.taper([-0.019, 0.08, 0.019, 0.36], -0.05, [-0.019, 0.08, 0.019, 0.34], 0.06, WOOD);
    G.taper([-0.015, 0.03, 0.015, 0.07], -0.095, [-0.015, 0.005, 0.015, 0.045], 0.012, WOOD);
    G.taper([-0.013, -0.2, 0.013, -0.14], -0.1, [-0.013, -0.13, 0.013, -0.07], 0.012, GUN2);
    G.taper([-0.013, -0.26, 0.013, -0.2], -0.19, [-0.013, -0.2, 0.013, -0.14], -0.1, GUN2);
    return { muzzle: [0, 0.04, -0.73], left: [0, 0.0, -0.33], right: [0, -0.035, 0.04], mag: [0, -0.14, -0.14] };
  },
  m16(G) {
    bx(G, 0.022, 0.01, 0.075, -0.22, 0.06, GUN);
    tubeZ(G, 0, 0.042, -0.56, -0.22, 0.03, GUN2, 8);
    tubeZ(G, 0, 0.045, -0.86, -0.56, 0.01, GUN2);
    tubeZ(G, 0, 0.045, -0.9, -0.86, 0.014, GUN);
    G.taper([-0.006, -0.6, 0.006, -0.55], 0.06, [-0.004, -0.585, 0.004, -0.565], 0.115, GUN);
    bx(G, 0.008, 0.075, 0.1, -0.2, -0.17, GUN);
    bx(G, 0.008, 0.075, 0.1, -0.02, 0.01, GUN);
    bx(G, 0.008, 0.1, 0.115, -0.2, 0.01, GUN);
    G.taper([-0.02, 0.06, 0.02, 0.36], -0.05, [-0.02, 0.06, 0.02, 0.36], 0.07, GUN2);
    G.taper([-0.015, 0.02, 0.015, 0.06], -0.09, [-0.015, -0.005, 0.015, 0.04], 0.012, GUN);
    G.taper([-0.012, -0.15, 0.012, -0.095], -0.15, [-0.012, -0.13, 0.012, -0.075], 0.012, GUN2);
    return { muzzle: [0, 0.045, -0.91], left: [0, 0.01, -0.4], right: [0, -0.035, 0.03], mag: [0, -0.12, -0.11] };
  },
  m40(G) {
    G.taper([-0.024, -0.46, 0.024, 0.12], -0.02, [-0.022, -0.46, 0.022, 0.12], 0.045, OLIVE);
    G.taper([-0.022, 0.12, 0.022, 0.42], -0.07, [-0.022, 0.12, 0.022, 0.42], 0.05, OLIVE);
    bx(G, 0.018, 0.045, 0.075, -0.3, 0.1, GUN);
    tubeZ(G, 0, 0.055, -1.06, -0.3, 0.012, GUN2);
    tubeZ(G, 0, 0.055, -1.13, -1.06, 0.018, GUN);
    tubeZ(G, 0, 0.125, -0.26, 0.07, 0.019, GUN, 8);
    tubeZ(G, 0, 0.125, -0.36, -0.26, 0.029, GUN, 8);
    tubeZ(G, 0, 0.125, 0.07, 0.12, 0.024, GUN, 8);
    bx(G, 0.008, 0.075, 0.108, -0.2, -0.17, GUN2);
    bx(G, 0.008, 0.075, 0.108, -0.02, 0.01, GUN2);
    G.box(0.018, 0.05, 0.03, 0.06, 0.062, 0.045, STEELC, 63);
    bx(G, 0.014, -0.06, -0.02, -0.16, -0.09, GUN);
    for (const s of [-1, 1]) G.box(s * 0.03 - 0.004, -0.02, -0.72, s * 0.03 + 0.004, -0.005, -0.44, GUN2, 63);
    return { muzzle: [0, 0.055, -1.14], left: [0, -0.02, -0.34], right: [0, -0.04, 0.06], mag: [0, -0.06, -0.12], bolt: [0.05, 0.056, 0.04] };
  },
  m107(G) {
    bx(G, 0.03, 0.0, 0.095, -0.5, 0.26, GUN);
    bx(G, 0.026, 0.0, 0.085, 0.26, 0.42, GUN2);
    G.taper([-0.022, 0.3, 0.022, 0.42], -0.09, [-0.022, 0.32, 0.022, 0.42], 0.0, GUN2);
    tubeZ(G, 0, 0.055, -1.2, -0.5, 0.017, GUN2, 8);
    bx(G, 0.04, 0.025, 0.085, -1.3, -1.2, GUN);
    bx(G, 0.014, 0.095, 0.108, -0.46, 0.2, GUN2);
    tubeZ(G, 0, 0.15, -0.26, 0.1, 0.022, GUN, 8);
    tubeZ(G, 0, 0.15, -0.38, -0.26, 0.033, GUN, 8);
    tubeZ(G, 0, 0.15, 0.1, 0.15, 0.026, GUN, 8);
    bx(G, 0.008, 0.108, 0.13, -0.2, -0.17, GUN2);
    bx(G, 0.008, 0.108, 0.13, 0.0, 0.03, GUN2);
    bx(G, 0.02, -0.14, 0.0, -0.2, -0.07, GUN2);
    G.taper([-0.015, 0.02, 0.015, 0.065], -0.1, [-0.015, -0.005, 0.015, 0.045], 0.0, GUN);
    for (const s of [-1, 1]) G.taper([s * 0.07 - 0.005, -0.5, s * 0.07 + 0.005, -0.48], -0.2, [s * 0.03 - 0.005, -0.5, s * 0.03 + 0.005, -0.48], 0.01, GUN2);
    return { muzzle: [0, 0.055, -1.31], left: [0, -0.03, -0.32], right: [0, -0.04, 0.04], mag: [0, -0.1, -0.14] };
  },
  m9(G) {
    bx(G, 0.014, 0.02, 0.058, -0.15, 0.05, GUN);
    bx(G, 0.013, 0.0, 0.022, -0.1, 0.05, GUN2);
    G.taper([-0.014, 0.01, 0.014, 0.065], -0.1, [-0.014, -0.005, 0.014, 0.05], 0.004, GUN2);
    bx(G, 0.004, 0.058, 0.066, 0.02, 0.035, GUN);
    return { muzzle: [0, 0.04, -0.16], left: [0.0, -0.05, 0.035], right: [0, -0.04, 0.03], mag: [0, -0.09, 0.03] };
  },
  d50(G) {
    G.taper([-0.017, -0.21, 0.017, 0.06], 0.015, [-0.011, -0.21, 0.011, 0.06], 0.07, STEELC);
    bx(G, 0.015, -0.005, 0.018, -0.12, 0.06, mulC(STEELC, 0.8));
    G.taper([-0.016, 0.01, 0.016, 0.07], -0.115, [-0.016, -0.005, 0.016, 0.055], -0.002, GUN);
    bx(G, 0.004, 0.07, 0.08, 0.02, 0.04, GUN);
    return { muzzle: [0, 0.045, -0.22], left: [0.0, -0.055, 0.04], right: [0, -0.045, 0.03], mag: [0, -0.1, 0.03] };
  },
  // melee weapons live in the hand: grip along Z, blade forward (-Z)
  knife(G) {
    G.box(-0.012, -0.016, -0.04, 0.012, 0.016, 0.08, GUN, 63);
    G.box(-0.006, -0.03, -0.05, 0.006, 0.03, -0.04, GUN2, 63);
    G.taper([-0.002, -0.05, 0.002, -0.05], -0.02, [-0.002, -0.25, 0.002, -0.05], 0.02, BLADE);
    G.quad([-0.002, -0.02, -0.05], [-0.002, 0.02, -0.05], [-0.002, 0.02, -0.25], [-0.002, -0.02, -0.05], BLADE);
    G.box(-0.0025, -0.02, -0.19, 0.0025, 0.02, -0.05, BLADE, 63);
    return { muzzle: [0, 0, -0.25] };
  },
  axe(G) {
    G.box(-0.012, -0.014, -0.34, 0.012, 0.014, 0.1, WOOD, 63);
    G.taper([-0.006, -0.36, 0.006, -0.26], -0.11, [-0.014, -0.34, 0.014, -0.28], 0.03, GUN2);
    G.taper([-0.003, -0.39, 0.003, -0.23], -0.14, [-0.006, -0.36, 0.006, -0.26], -0.11, BLADE);
    return { muzzle: [0, -0.1, -0.34] };
  },
};

let gunMaterial = null;
const modelCache = new Map();

/** Returns a new Mesh for the weapon plus its attachment points. */
export function makeWeaponModel(id) {
  if (!gunMaterial) gunMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  let entry = modelCache.get(id);
  if (!entry) {
    const G = new Geo();
    const points = BUILD[id](G);
    entry = { geometry: G.build(), points };
    modelCache.set(id, entry);
  }
  const mesh = new THREE.Mesh(entry.geometry, gunMaterial);
  mesh.frustumCulled = false;
  return { mesh, points: entry.points };
}
