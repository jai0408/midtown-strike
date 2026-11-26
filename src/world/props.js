// Street furniture, vehicles and other merged props. Each helper writes
// geometry into the chunked builders and registers colliders.
import { C, mulC } from './geo.js';
import { CURB, groundAt } from './layout.js';
import { decodeVehicle } from './vehicle_material.js';
import { treeMesh, shrubMesh, emit, TREE_KINDS, hash2 as hashK } from './plants.js';
import { VEHICLE_ASSETS } from './vehicles_asset.js';
import { AD_LAND } from './textures.js';
import { F_DEFAULT, F_SOLID, F_BULLET, F_CAMERA, F_SEE, S_METAL, S_CONCRETE, S_WOOD, S_DIRT, S_GLASS } from '../core/physics.js';

const BLACK = C('#101114'), TIRE = C('#0b0b0d'), GLASS = C('#152030'), CHROME = C('#8a8f98');
const HEAD = C('#fff3c4'), TAIL = C('#ff2a1a'), CONCRETE = C('#9a9892'), STEEL = C('#3a3d42');
const POLE = C('#2b2e33'), GREEN_DARK = C('#1f3d2a');

export const CAR_COLORS = ['#c9ccd1', '#1b1c20', '#6a6e75', '#7a1d1d', '#1f3a66', '#e8e8e8', '#3b3f46', '#58606b', '#2d4a3a', '#8a8d92'].map((h) => C(h));
const TAXI = C('#f0b90b'), POLICE_W = C('#eef0f2'), POLICE_B = C('#1c3f94'), BUS_B = C('#1d4f91'), BUS_W = C('#e6e8ea');
const ARMY = C('#6b6248'), ARMY_D = C('#4f4936'), TRUCK_W = C('#d9d9d4');

// Roughness / metalness pairs for G.setRM (flat city material, see core/pbr.js)
const R_CAST = [0.6, 0.7], R_PAINT = [0.45, 0.3], R_CONC = [0.9, 0], R_GLASS = [0.08, 0.85];
const R_RUBBER = [0.95, 0], R_WOOD = [0.7, 0], R_DEF = [0.85, 0], R_FABRIC = [0.95, 0], R_GALV = [0.4, 0.8];
const rm = (G, r) => G.setRM(r[0], r[1]);
/** Weathered version of a saturated colour: pull toward its luma, darken. */
function mute(hex, sat = 0.55, k = 0.85) {
  const c = C(hex), l = c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
  return [(l + (c[0] - l) * sat) * k, (l + (c[1] - l) * sat) * k, (l + (c[2] - l) * sat) * k];
}
/** Deterministic 0..1 value from a position (no rng: must not disturb the city seed). */
const hash2 = (x, z) => { const v = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453; return v - Math.floor(v); };

/** Axis-aligned bounds of a yawed rectangle, registered as one collider. */
function addYawBox(ctx, x, z, yaw, hl, hw, y0, y1, flags = F_DEFAULT, surf = S_METAL) {
  const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
  // local length runs along -Z (forward); width along X
  const ex = hw * c + hl * s, ez = hw * s + hl * c;
  return ctx.world.addBox(x - ex, y0, z - ez, x + ex, y1, z + ez, flags, surf);
}

/**
 * Vehicles are built in Blender (tools/blender/build_vehicles.py) facing -Z
 * (local); `yaw` rotates them about Y. Body paint is a tint applied here.
 * kind: sedan | taxi | police | suv | van | truck | bus | humvee | wreck
 */
const WRECK_K = [0.16, 0.14, 0.13];
const VWHITE = [1, 1, 1];
/** Thin glow polygon (both windings: the glow material is single sided). */
function glowQuad(E, q, col) {
  E.quad(q[0], q[1], q[2], q[3], col);
  E.quad(q[3], q[2], q[1], q[0], col);
}
function drawVehicle(G, E, kind, tint, tint2, lightsOn, big) {
  const wreck = kind === 'wreck';
  const a = VEHICLE_ASSETS[wreck ? 'sedan' : kind];
  const m = decodeVehicle(a.mesh, a.meta);
  // UV-mapped 'veh' family: colour = paint tint (white for fixed parts), rm = (baked ao, burnt)
  // A burnt-out wreck is flagged in rm.y: the material turns everything dark, rough and dull.
  G._reserve(m.nv, m.ni);
  const base = G.nv, r0 = G.rough, m0 = G.metal;
  const t1 = tint || VWHITE, t2 = tint2 || tint || VWHITE;
  for (let i = 0; i < m.nv; i++) {
    const k = i * 3, mk = m.mask[i];
    G.rough = m.ao[i]; G.metal = wreck ? 1 : 0;
    G.vert(m.pos[k], m.pos[k + 1], m.pos[k + 2], m.nor[k], m.nor[k + 1], m.nor[k + 2], m.uv[i * 2], m.uv[i * 2 + 1],
      wreck ? WRECK_K : mk === 1 ? t1 : mk === 2 ? t2 : VWHITE);
  }
  G.rough = r0; G.metal = m0;
  for (let i = 0; i < m.ni; i++) G.idx[G.ni++] = base + m.idx[i];
  if (wreck) return;
  const tk = lightsOn ? 1 : big ? 0.35 : 0.3;
  if (lightsOn) for (const q of a.lights.head) glowQuad(E, q, HEAD);
  for (const q of a.lights.tail) glowQuad(E, q, mulC(TAIL, tk));
  const roof = a.lights.roof;
  if (kind === 'taxi' && roof[0]) { const b = roof[0]; E.box(b[0], b[1], b[2], b[3], b[4], b[5], C('#fff6c2', lightsOn ? 1 : 0.5), 63); }
  if (kind === 'police' && roof[1]) {
    let b = roof[0]; E.box(b[0], b[1], b[2], b[3], b[4], b[5], C('#ff2030'), 63);
    b = roof[1]; E.box(b[0], b[1], b[2], b[3], b[4], b[5], C('#2a6bff'), 63);
  }
}

export function vehicle(ctx, kind, x, z, yaw, rng, lightsOn = false) {
  const y = groundAt(x, z);
  const G = ctx.B('veh', x, z).setXform(x, y, z, yaw);
  const E = ctx.B('glow', x, z).setXform(x, y, z, yaw);
  let L = 4.6, W = 1.84, H = 1.45, col = rng.pick(CAR_COLORS);
  let hood = 0.86, roofF = 0.9, roofB = -1.25;
  if (kind === 'taxi') col = TAXI;
  else if (kind === 'police') col = POLICE_W;
  else if (kind === 'suv') { L = 4.9; W = 1.95; H = 1.8; hood = 1.02; roofF = 1.0; roofB = -2.1; }
  else if (kind === 'humvee') { L = 4.8; W = 2.2; H = 1.9; hood = 1.15; roofF = 0.5; roofB = -2.2; col = null; }
  else if (kind === 'wreck') col = WRECK_K;
  const hl = L / 2, hw = W / 2;

  if (kind === 'bus' || kind === 'van' || kind === 'truck') {
    const isBus = kind === 'bus';
    L = isBus ? 12 : kind === 'truck' ? 8.2 : 5.6;
    W = isBus ? 2.55 : kind === 'truck' ? 2.45 : 2.0;
    H = isBus ? 3.1 : kind === 'truck' ? 3.4 : 2.3;
    const l2 = L / 2, w2 = W / 2;
    // (the order of the rng calls is part of the city seed: keep it)
    const body = isBus ? BUS_W : kind === 'truck' ? TRUCK_W : rng.pick(CAR_COLORS);
    const cab = kind === 'truck' ? rng.pick(CAR_COLORS) : body;
    drawVehicle(G, E, kind, body, cab, lightsOn, true);
    G.resetXform(); E.resetXform();
    addYawBox(ctx, x, z, yaw, l2, w2, y, y + H);
    ctx.vehicles.push({ x, z, yaw, hl: l2, hw: w2 });
    return;
  }

  drawVehicle(G, E, kind, col, col, lightsOn, false);
  if (kind === 'police') ctx.glow(x, y + H + 0.3, z, rng.chance(0.5) ? '#ff3344' : '#3b7bff', 3);
  G.resetXform(); E.resetXform();
  if (lightsOn) {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    ctx.pool(x + fx * (hl + 4), z + fz * (hl + 4), 5, '#ffe9b0', 0.5);
  }
  // two colliders so that characters can use the bonnet as low cover
  addYawBox(ctx, x, z, yaw, hl, hw, y, y + hood);
  const cz = (roofF + roofB) / 2, cl = (roofF - roofB) / 2 + 0.3;
  addYawBox(ctx, x - Math.sin(yaw) * cz * -1, z - Math.cos(yaw) * cz * -1, yaw, cl, hw - 0.1, y + hood, y + H, F_DEFAULT, S_GLASS);
  ctx.vehicles.push({ x, z, yaw, hl, hw });
}

/** 4-sided 3D beam from point A to point B (radius r) for curved arms / struts. */
function beamSeg(G, ax, ay, az, bx, by, bz, r, col) {
  const dx = bx - ax, dz = bz - az, hLen = Math.hypot(dx, dz) || 1;
  // Side offset perpendicular to horizontal projection, plus vertical offset
  const px = (-dz / hLen) * r, pz = (dx / hLen) * r;
  const vx = (dx / hLen) * r * 0.35, vz = (dz / hLen) * r * 0.35;
  G.quad([ax - px, ay + r, az - pz], [bx - px, by + r, bz - pz], [bx + px, by + r, bz + pz], [ax + px, ay + r, az + pz], mulC(col, 1.18));
  G.quad([ax + px, ay - r, az + pz], [bx + px, by - r, bz + pz], [bx - px, by - r, bz - pz], [ax - px, ay - r, az - pz], mulC(col, 0.7));
  G.quad([ax + px + vx, ay + r, az + pz + vz], [bx + px + vx, by + r, bz + pz + vz], [bx + px + vx, by - r, bz + pz + vz], [ax + px + vx, ay - r, az + pz + vz], col);
  G.quad([bx - px - vx, by + r, bz - pz - vz], [ax - px - vx, ay + r, az - pz - vz], [ax - px - vx, ay - r, az - pz - vz], [bx - px - vx, by - r, bz - pz - vz], mulC(col, 0.85));
}

export function lampPost(ctx, x, z, dirX, dirZ, color = '#ffd9a0') {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  rm(G, R_CAST);
  // Fluted cast-iron octagonal NYC base, stepped collar, tapered steel shaft
  G.cyl(x, z, y, y + 0.92, 0.22, 0.13, 8, POLE, false);
  G.box(x - 0.17, y + 0.90, z - 0.17, x + 0.17, y + 1.02, z + 0.17, mulC(POLE, 1.25), 31);
  rm(G, R_PAINT);
  G.cyl(x, z, y + 1.02, y + 7.6, 0.115, 0.075, 8, POLE, false);
  // Swept NYC cobra-head mast arm arching up to luminaire height
  const mx = x + dirX * 1.15, mz = z + dirZ * 1.15;
  const hx = x + dirX * 2.55, hz = z + dirZ * 2.55;
  beamSeg(G, x, y + 7.55, z, mx, y + 8.32, mz, 0.055, POLE);
  beamSeg(G, mx, y + 8.32, mz, hx - dirX * 0.2, y + 8.58, hz - dirZ * 0.2, 0.048, POLE);
  // Cobra-head cast-aluminum luminaire housing aligned with mast direction
  rm(G, R_GALV);
  const alongX = Math.abs(dirX) >= Math.abs(dirZ);
  const lx = alongX ? 0.44 : 0.21, lz = alongX ? 0.21 : 0.44;
  G.box(hx - lx, y + 8.48, hz - lz, hx + lx, y + 8.66, hz + lz, C('#7b828c'), 31, C('#9aa1ab'));
  const E = ctx.B('glow', x, z);
  E.box(hx - lx * 0.72, y + 8.38, hz - lz * 0.72, hx + lx * 0.72, y + 8.49, hz + lz * 0.72, C(color, 1.35), 31 | 32);
  rm(G, R_DEF);
  ctx.glow(hx, y + 8.4, hz, color, 1.35);
  ctx.pool(hx + dirX * 1.4, hz + dirZ * 1.4, 8.5, color, 0.30);
  if (ctx.light) ctx.light(hx + dirX * 1.5, hz + dirZ * 1.5, 9.5, '#ffc978', 0.42);
}

export function trafficLight(ctx, x, z, dirX, dirZ, green, labels) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  rm(G, R_CAST);
  G.cyl(x, z, y, y + 0.72, 0.17, 0.105, 8, POLE, false);
  rm(G, R_PAINT);
  G.box(x - 0.1, y + 0.72, z - 0.1, x + 0.1, y + 6.42, z + 0.1, POLE, 15);
  const ax = x + dirX * 4.5, az = z + dirZ * 4.5;
  G.box(Math.min(x, ax) - 0.07, y + 6.1, Math.min(z, az) - 0.07, Math.max(x, ax) + 0.07, y + 6.26, Math.max(z, az) + 0.07, POLE, 31 | 32);
  // NYC DOT weathered yellow vertical signal body + dark sun-hood visors & inactive lenses
  const dotYellow = C('#d49b1a');
  G.box(ax - 0.21, y + 5.08, az - 0.21, ax + 0.21, y + 6.12, az + 0.21, dotYellow, 31 | 32, mulC(dotYellow, 1.15));
  for (const hy of [5.18, 5.47, 5.76]) {
    G.box(ax - 0.24, y + hy + 0.22, az - 0.24, ax + 0.24, y + hy + 0.29, az + 0.24, C('#16181c'), 31);
    G.box(ax - 0.22, y + hy, az - 0.22, ax + 0.22, y + hy + 0.21, az + 0.22, C('#111316'), 15);
  }
  const E = ctx.B('glow', x, z);
  const lit = green ? C('#35ff7a') : C('#ff3020');
  const ly = green ? y + 5.18 : y + 5.76;
  E.box(ax - 0.225, ly + 0.02, az - 0.225, ax + 0.225, ly + 0.21, az + 0.225, lit, 15);
  // Pole-mounted pedestrian WALK / DON'T WALK signal housing at crosswalk height
  const px = x + dirX * 0.24, pz = z + dirZ * 0.24;
  G.box(px - 0.16, y + 2.74, pz - 0.16, px + 0.16, y + 3.16, pz + 0.16, C('#1e2127'), 31, C('#2c3038'));
  const pedCol = green ? C('#eef4ff', 1.05) : C('#ff4a20', 1.1);
  E.box(px - 0.165, y + 2.81, pz - 0.165, px + 0.165, y + 3.09, pz + 0.165, pedCol, 15);
  rm(G, R_DEF);
  ctx.glow(ax, ly + 0.1, az, green ? '#35ff7a' : '#ff3020', 0.7);
  // street name blades
  if (labels) {
    const S = ctx.B('signs', x, z);
    const put = (label, alongX, yy) => {
      const cell = ctx.signCells[label];
      if (!cell) return;
      const uv = [cell.u0, cell.v0, cell.u1, cell.v1];
      const w = 0.9;
      if (alongX) {
        S.wall(x - w, z + 0.02, x + w, z + 0.02, yy, yy + 0.42, null, uv);
        S.wall(x + w, z - 0.02, x - w, z - 0.02, yy, yy + 0.42, null, uv);
      } else {
        S.wall(x - 0.02, z - w, x - 0.02, z + w, yy, yy + 0.42, null, uv);
        S.wall(x + 0.02, z + w, x + 0.02, z - w, yy, yy + 0.42, null, uv);
      }
    };
    put(labels[0], true, y + 3.6);
    put(labels[1], false, y + 4.1);
  }
}

export function jerseyBarrier(ctx, x, z, alongX, len = 3) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  const hl = len / 2;
  const b = alongX ? [x - hl, z - 0.3, x + hl, z + 0.3] : [x - 0.3, z - hl, x + 0.3, z + hl];
  // weathered poured concrete, a little different per barrier (position hash, not the city rng)
  const v = 0.88 + 0.2 * hash2(x, z);
  const base = [0.30 * v, 0.295 * v, 0.28 * v];
  const rect = (w) => (alongX ? [x - hl, z - w / 2, x + hl, z + w / 2] : [x - w / 2, z - hl, x + w / 2, z + hl]);
  rm(G, R_CONC);
  // New Jersey profile: vertical toe, shallow slope, steep slope, flat cap
  G.taper(rect(0.6), y, rect(0.6), y + 0.1, mulC(base, 0.62), false);
  G.taper(rect(0.6), y + 0.1, rect(0.42), y + 0.36, mulC(base, 0.78), false, mulC(base, 0.95));
  G.taper(rect(0.42), y + 0.36, rect(0.2), y + 0.95, mulC(base, 0.95), true, mulC(base, 1.18));
  // lifting slots and a stained hairline on the cap
  if (len > 2) G.box(x - (alongX ? hl - 0.02 : 0.05), y + 0.97, z - (alongX ? 0.05 : hl - 0.02), x + (alongX ? hl - 0.02 : 0.05), y + 0.975, z + (alongX ? 0.05 : hl - 0.02), mulC(base, 0.8), 16);
  rm(G, R_DEF);
  ctx.world.addBox(b[0], y, b[1] + (alongX ? 0.1 : 0), b[2], y + 0.95, b[3] - (alongX ? 0.1 : 0), F_DEFAULT, S_CONCRETE);
  if (ctx.occluder) ctx.occluder(b[0], b[1], b[2], b[3], 0.9, 0.48);
}

export function sandbags(ctx, x, z, alongX, len = 2.6, h = 1.05) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  const col = C('#8c7b58'), col2 = C('#75664a');
  const hl = len / 2, hw = 0.38;
  const rows = Math.round(h / 0.26);
  rm(G, R_FABRIC);
  for (let r = 0; r < rows; r++) {
    const inset = r * 0.03, off = (r % 2) * 0.22;
    const y0 = y + r * (h / rows), y1 = y + (r + 1) * (h / rows) - 0.02;
    const c = r % 2 ? col : col2;
    if (alongX) G.box(x - hl + inset + off * 0.3, y0, z - hw + inset, x + hl - inset, y1, z + hw - inset, mulC(c, 0.8), 31, mulC(c, 1.1));
    else G.box(x - hw + inset, y0, z - hl + inset + off * 0.3, x + hw - inset, y1, z + hl - inset, mulC(c, 0.8), 31, mulC(c, 1.1));
  }
  rm(G, R_DEF);
  if (alongX) {
    ctx.world.addBox(x - hl, y, z - hw, x + hl, y + h, z + hw, F_DEFAULT, S_DIRT);
    if (ctx.occluder) ctx.occluder(x - hl, z - hw, x + hl, z + hw, 0.9, 0.46);
  } else {
    ctx.world.addBox(x - hw, y, z - hl, x + hw, y + h, z + hl, F_DEFAULT, S_DIRT);
    if (ctx.occluder) ctx.occluder(x - hw, z - hl, x + hw, z + hl, 0.9, 0.46);
  }
}

export function crate(ctx, x, z, size = 1.2, stack = 1, kind = 'wood') {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  const h = size / 2;
  const col = kind === 'wood' ? C('#7a6240') : C('#4b5436');
  const post = mulC(col, 0.62), plank = mulC(col, 0.82);
  rm(G, R_WOOD);
  for (let i = 0; i < stack; i++) {
    const o = i * 0.07;
    const y0 = y + i * size, y1 = y + (i + 1) * size;
    G.box(x - h + o, y0, z - h + o, x + h - o, y1, z + h - o, plank, 31, mulC(col, 1.15));
    // horizontal battens
    G.box(x - h + o - 0.02, y0 + size * 0.2, z - h + o - 0.02, x + h - o + 0.02, y0 + size * 0.3, z + h - o + 0.02, post, 15);
    G.box(x - h + o - 0.02, y0 + size * 0.7, z - h + o - 0.02, x + h - o + 0.02, y0 + size * 0.8, z + h - o + 0.02, post, 15);
    // corner posts
    const p = 0.07;
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const cx = x + sx * (h - o), cz = z + sz * (h - o);
      G.box(cx - p - (sx > 0 ? -0.015 : 0.015), y0, cz - p - (sz > 0 ? -0.015 : 0.015), cx + p + (sx > 0 ? 0.015 : -0.015), y1, cz + p + (sz > 0 ? 0.015 : -0.015), post, 31, mulC(post, 1.2));
    }
    if (kind !== 'wood') G.box(x - h * 0.55, y0 + size * 0.36, z + h - o + 0.021, x + h * 0.55, y0 + size * 0.64, z + h - o + 0.026, C('#b9b27a'), 4);
  }
  rm(G, R_DEF);
  ctx.world.addBox(x - h, y, z - h, x + h, y + size * stack, z + h, F_DEFAULT, kind === 'wood' ? S_WOOD : S_METAL);
  if (ctx.occluder) ctx.occluder(x - h, z - h, x + h, z + h, 0.9, 0.38);
}

export function container(ctx, x, z, alongX, color) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  const hl = 3.05, hw = 1.22, h = 2.6;
  const col = mute(color, 0.45, 0.62 + 0.2 * hash2(x, z));
  const lite = mulC(col, 1.18), ribCol = mulC(col, 0.88), grime = C('#1b1d22');
  const x0 = alongX ? x - hl : x - hw, x1 = alongX ? x + hl : x + hw;
  const z0 = alongX ? z - hw : z - hl, z1 = alongX ? z + hw : z + hl;
  rm(G, R_PAINT);
  G.box(x0, y, z0, x1, y + h, z1, mulC(col, 0.72), 31, lite);
  // Real 3D corrugated steel ribs protruding 3.5 cm on both long sides
  const n = 14, out = 0.035, ya = y + 0.16, yb = y + h - 0.14;
  for (let k = 0; k < n; k++) {
    const t0 = (k + 0.26) / n, t1 = (k + 0.74) / n;
    if (alongX) {
      const xa = x0 + (x1 - x0) * t0, xb = x0 + (x1 - x0) * t1;
      G.box(xa, ya, z0 - out, xb, yb, z0, ribCol, 1 | 2 | 8 | 16);
      G.box(xa, ya, z1, xb, yb, z1 + out, ribCol, 1 | 2 | 4 | 16);
    } else {
      const za = z0 + (z1 - z0) * t0, zb = z0 + (z1 - z0) * t1;
      G.box(x0 - out, ya, za, x0, yb, zb, ribCol, 2 | 4 | 8 | 16);
      G.box(x1, ya, za, x1 + out, yb, zb, ribCol, 1 | 4 | 8 | 16);
    }
  }
  // Welded steel corner posts, ISO corner castings & dark weathered base rail
  const p = 0.15;
  for (const px of [x0, x1 - p]) for (const pz of [z0, z1 - p]) {
    G.box(px - 0.014, y, pz - 0.014, px + p + 0.014, y + h, pz + p + 0.014, mulC(col, 0.68), 31, mulC(col, 0.9));
    G.box(px - 0.025, y + h - 0.14, pz - 0.025, px + p + 0.025, y + h + 0.015, pz + p + 0.025, grime, 31);
  }
  G.box(x0 - 0.015, y, z0 - 0.015, x1 + 0.015, y + 0.15, z1 + 0.015, grime, 15);
  // Door end: galvanized locking bars, cam keepers & center seam
  rm(G, R_GALV);
  const bars = [0.14, 0.36, 0.64, 0.86];
  for (const f of bars) {
    if (alongX) { const bx = x1 + 0.0, bz = z0 + (z1 - z0) * f; G.box(bx, y + 0.18, bz - 0.022, bx + 0.048, y + h - 0.18, bz + 0.022, C('#7b8086'), 31); }
    else { const bz = z1 + 0.0, bx = x0 + (x1 - x0) * f; G.box(bx - 0.022, y + 0.18, bz, bx + 0.022, y + h - 0.18, bz + 0.048, C('#7b8086'), 31); }
  }
  rm(G, R_PAINT);
  if (alongX) G.box(x1 + 0.002, y + 0.1, (z0 + z1) / 2 - 0.012, x1 + 0.014, y + h - 0.1, (z0 + z1) / 2 + 0.012, grime, 1);
  else G.box((x0 + x1) / 2 - 0.012, y + 0.1, z1 + 0.002, (x0 + x1) / 2 + 0.012, y + h - 0.1, z1 + 0.014, grime, 4);
  rm(G, R_DEF);
  ctx.world.addBox(x0, y, z0, x1, y + h, z1, F_DEFAULT, S_METAL);
  if (ctx.occluder) ctx.occluder(x0, z0, x1, z1, 1.5, 0.30);
}

export function planter(ctx, x, z, w = 1.4, d = 1.4, shrub = true) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  rm(G, R_CONC);
  const stone = C('#6c6b67');
  G.box(x - w / 2, y, z - d / 2, x + w / 2, y + 0.7, z + d / 2, mulC(stone, 0.8), 31, mulC(stone, 1.15));
  // cast rim and plinth give the block some shape
  G.box(x - w / 2 - 0.04, y + 0.66, z - d / 2 - 0.04, x + w / 2 + 0.04, y + 0.75, z + d / 2 + 0.04, mulC(stone, 1.25), 31);
  G.box(x - w / 2 - 0.03, y, z - d / 2 - 0.03, x + w / 2 + 0.03, y + 0.08, z + d / 2 + 0.03, mulC(stone, 0.6), 31);
  rm(G, R_FABRIC);
  ctx.B('soil', x, z).floor(x - w / 2 + 0.1, z - d / 2 + 0.1, x + w / 2 - 0.1, z + d / 2 - 0.1, y + 0.76, [0.8, 0.75, 0.75], [0, 0, w, d]);
  if (shrub) {
    const q = hashK(x, z, 7), sm = shrubMesh(1 + Math.floor(q * 3));
    emit(ctx.B('foliage', x, z), sm.leaf, x, y + 0.72, z, hashK(x, z, 8) * 6.283, w * 0.5, 0.95 + 0.4 * q, d * 0.5, [0.85 + 0.25 * q, 0.9 + 0.2 * q, 0.85]);
  }
  rm(G, R_DEF);
  ctx.world.addBox(x - w / 2, y, z - d / 2, x + w / 2, y + 0.75, z + d / 2, F_DEFAULT, S_CONCRETE);
  if (ctx.occluder) ctx.occluder(x - w / 2, z - d / 2, x + w / 2, z + d / 2, 0.85, 0.46);
}

export function bench(ctx, x, z, alongX, len = 3.2) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  const hl = len / 2, hw = 0.32;
  const x0 = alongX ? x - hl : x - hw, x1 = alongX ? x + hl : x + hw;
  const z0 = alongX ? z - hw : z - hl, z1 = alongX ? z + hw : z + hl;
  const conc = C('#6b6a67'), wood = C('#6a5237');
  // concrete plinth with a timber slat top
  rm(G, R_CONC);
  G.box(x0, y, z0, x1, y + 0.36, z1, mulC(conc, 0.8), 31, mulC(conc, 1.1));
  rm(G, R_WOOD);
  const slats = 4, sw = (2 * hw) / slats;
  for (let i = 0; i < slats; i++) {
    const a = -hw + i * sw + 0.012, b = -hw + (i + 1) * sw - 0.012;
    if (alongX) G.box(x0, y + 0.36, z + a, x1, y + 0.48, z + b, mulC(wood, 0.9 + 0.1 * (i % 2)), 31, mulC(wood, 1.15));
    else G.box(x + a, y + 0.36, z0, x + b, y + 0.48, z1, mulC(wood, 0.9 + 0.1 * (i % 2)), 31, mulC(wood, 1.15));
  }
  rm(G, R_DEF);
  ctx.world.addBox(x0, y, z0, x1, y + 0.48, z1, F_SOLID | F_BULLET, S_CONCRETE);
}

export function tree(ctx, x, z, rng, scale = 1) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  const h = (4 + rng.next() * 2.5) * scale, r = (2.2 + rng.next() * 1.3) * scale;
  const g1 = C(rng.pick(['#1f4a2a', '#24552f', '#1b4226', '#2b5a2c']));
  const jx = rng.range(-0.8, 0.8), jz = rng.range(-0.8, 0.8); // rng draws kept for seed stability
  // species / variant / yaw come from the position, never from the city rng
  const kind = TREE_KINDS[Math.floor(hashK(x, z, 1) * 3) % 3], seed = 1 + Math.floor(hashK(x, z, 2) * 3);
  const mesh = treeMesh(kind, seed);
  const tall = 0.85 + 0.3 * ((h / scale - 4) / 2.5), wide = 0.85 + 0.3 * ((r / scale - 2.2) / 1.3);
  const k = 0.88 + 0.3 * (g1[1] / 0.12);
  const tint = [k * (0.94 + 0.12 * hashK(x, z, 3)), k, k * (0.9 + 0.2 * hashK(x, z, 4))];
  const yaw = hashK(x, z, 5) * 6.283;
  emit(ctx.B('bark', x, z), mesh.bark, x, y, z, yaw, wide * scale, tall * scale, wide * scale);
  emit(ctx.B('foliage', x, z), mesh.leaf, x, y, z, yaw, wide * scale, tall * scale, wide * scale, tint);
  // ground cover: iron-framed tree pit on pavement, mulch ring on lawns
  const inPark = ctx.parks.some((q) => x > q.x0 && x < q.x1 && z > q.z0 && z < q.z1);
  const S = ctx.B('soil', x, z);
  const hw = inPark ? 0.75 : 0.62;
  S.floor(x - hw, z - hw, x + hw, z + hw, y + (inPark ? 0.06 : 0.03), [0.75 + 0.3 * hashK(x, z, 6), 0.7, 0.7], [0, 0, hw * 2, hw * 2]);
  if (!inPark) {
    rm(G, R_CAST);
    const iron = C('#26282b'), y1 = y + 0.045, f = 0.1;
    G.box(x - hw - f, y, z - hw - f, x + hw + f, y1, z - hw, iron, 20);
    G.box(x - hw - f, y, z + hw, x + hw + f, y1, z + hw + f, iron, 20);
    G.box(x - hw - f, y, z - hw, x - hw, y1, z + hw, iron, 20);
    G.box(x + hw, y, z - hw, x + hw + f, y1, z + hw, iron, 20);
    for (let i = -2; i <= 2; i++) if (i) G.box(x + i * 0.28 - 0.02, y, z - hw, x + i * 0.28 + 0.02, y1, z + hw, iron, 16);
    rm(G, R_DEF);
  }
  ctx.world.addBox(x - 0.22, y, z - 0.22, x + 0.22, y + h, z + 0.22, F_SOLID | F_BULLET | F_CAMERA, S_WOOD);
}

export function hydrant(ctx, x, z) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  const red = mute('#b3261e', 0.8, 0.78), redD = mulC(red, 0.7), cap = C('#b8a04a');
  rm(G, R_CAST);
  G.cyl(x, z, y, y + 0.09, 0.16, 0.15, 8, redD, false);                  // bolted flange
  G.cyl(x, z, y + 0.09, y + 0.5, 0.115, 0.105, 8, red, false, mulC(red, 1.1));  // barrel
  G.cyl(x, z, y + 0.5, y + 0.6, 0.125, 0.11, 8, mulC(red, 0.9), false);  // bonnet collar
  G.cyl(x, z, y + 0.6, y + 0.66, 0.1, 0.07, 8, red, true, mulC(red, 1.1)); // dome
  G.cyl(x, z, y + 0.66, y + 0.69, 0.035, 0.035, 6, cap, true);           // operating nut
  // side outlets and the big pumper nozzle, with chained caps
  G.box(x - 0.2, y + 0.32, z - 0.055, x + 0.2, y + 0.43, z + 0.055, red, 31, mulC(red, 1.1));
  G.box(x - 0.23, y + 0.3, z - 0.065, x - 0.19, y + 0.45, z + 0.065, cap, 31);
  G.box(x + 0.19, y + 0.3, z - 0.065, x + 0.23, y + 0.45, z + 0.065, cap, 31);
  G.box(x - 0.075, y + 0.2, z + 0.1, x + 0.075, y + 0.35, z + 0.2, red, 31, mulC(red, 1.1));
  G.box(x - 0.085, y + 0.19, z + 0.19, x + 0.085, y + 0.36, z + 0.225, cap, 31);
  rm(G, R_DEF);
  ctx.world.addBox(x - 0.14, y, z - 0.14, x + 0.14, y + 0.62, z + 0.14, F_SOLID | F_BULLET, S_METAL);
}

export function trashCan(ctx, x, z) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  const body = C('#26322b'), rim = C('#171c19');
  rm(G, R_PAINT);
  G.cyl(x, z, y, y + 0.88, 0.28, 0.34, 8, body, false, mulC(body, 1.25));    // wire-mesh basket
  G.cyl(x, z, y + 0.84, y + 0.92, 0.355, 0.355, 8, rim, false);              // rolled rim
  G.cyl(x, z, y, y + 0.08, 0.3, 0.3, 8, rim, false);                          // base ring
  G.cyl(x, z, y + 0.9, y + 0.95, 0.36, 0.3, 8, C('#0c0e0d'), true);           // dark opening
  rm(G, R_DEF);
  ctx.world.addBox(x - 0.3, y, z - 0.3, x + 0.3, y + 0.95, z + 0.3, F_SOLID | F_BULLET, S_METAL);
}

export function mailbox(ctx, x, z) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  const blue = C('#27385e'), blueD = mulC(blue, 0.7);
  rm(G, R_PAINT);
  G.box(x - 0.22, y + 0.05, z - 0.2, x + 0.22, y + 0.2, z + 0.2, blueD, 31);           // pedestal
  G.box(x - 0.28, y + 0.2, z - 0.25, x + 0.28, y + 0.95, z + 0.25, mulC(blue, 0.85), 31, mulC(blue, 1.15));
  const tb = [x - 0.28, z - 0.25, x + 0.28, z + 0.25], tt = [x - 0.24, z - 0.2, x + 0.24, z + 0.2];
  G.taper(tb, y + 0.95, tt, y + 1.1, blue, true, mulC(blue, 1.25));                     // domed top
  G.box(x - 0.2, y + 0.62, z + 0.25, x + 0.2, y + 0.84, z + 0.28, blueD, 31);           // pull-down chute door
  G.box(x - 0.2, y + 0.62, z - 0.28, x + 0.2, y + 0.84, z - 0.25, blueD, 31);
  rm(G, R_CAST);
  G.box(x - 0.16, y + 0.78, z + 0.28, x + 0.16, y + 0.805, z + 0.295, C('#9a9ea3'), 31); // handle
  G.box(x - 0.16, y + 0.78, z - 0.295, x + 0.16, y + 0.805, z - 0.28, C('#9a9ea3'), 31);
  rm(G, R_DEF);
  ctx.world.addBox(x - 0.3, y, z - 0.3, x + 0.3, y + 1.15, z + 0.3, F_DEFAULT, S_METAL);
}

export function newsstand(ctx, x, z, alongX) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  const hl = 1.9, hw = 1.1;
  const x0 = alongX ? x - hl : x - hw, x1 = alongX ? x + hl : x + hw;
  const z0 = alongX ? z - hw : z - hl, z1 = alongX ? z + hw : z + hl;
  const body = C('#2e4236'), trim = C('#1e2822'), frame = C('#454c54');
  rm(G, R_PAINT);
  G.box(x0, y + 0.12, z0, x1, y + 2.5, z1, mulC(body, 0.88), 31, mulC(body, 1.2));
  G.box(x0 - 0.04, y, z0 - 0.04, x1 + 0.04, y + 0.12, z1 + 0.04, mulC(trim, 0.7), 31);   // plinth
  for (const px of [x0, x1 - 0.12]) for (const pz of [z0, z1 - 0.12]) G.box(px - 0.02, y + 0.12, pz - 0.02, px + 0.14, y + 2.5, pz + 0.14, trim, 31); // posts
  G.box(x0 - 0.25, y + 2.5, z0 - 0.25, x1 + 0.25, y + 2.62, z1 + 0.25, trim, 31 | 32);     // roof slab
  G.box(x0 - 0.27, y + 2.44, z0 - 0.27, x1 + 0.27, y + 2.5, z1 + 0.27, mulC(trim, 1.5), 15);
  // Illuminated NYC street-side backlit ad panel on the back wall (replaces the old solid black panel)
  const ad = AD_LAND[Math.floor(hash2(x * 1.7 + 3, z * 1.3 - 5) * AD_LAND.length) % AD_LAND.length];
  const adUv = [ad.u0 + 0.004, ad.v0 + 0.006, ad.u1 - 0.004, ad.v1 - 0.006];
  rm(G, R_CAST);
  if (alongX) {
    G.box(x0 + 0.14, y + 0.92, z0 - 0.045, x1 - 0.14, y + 2.18, z0 + 0.01, frame, 31);
    ctx.B('ads', x, z).wall(x0 + 0.22, z0 - 0.052, x1 - 0.22, z0 - 0.052, y + 1.0, y + 2.1, null, adUv);
  } else {
    G.box(x0 - 0.045, y + 0.92, z0 + 0.14, x0 + 0.01, y + 2.18, z1 - 0.14, frame, 31);
    ctx.B('ads', x, z).wall(x0 - 0.052, z1 - 0.22, x0 - 0.052, z0 + 0.22, y + 1.0, y + 2.1, null, adUv);
  }
  rm(G, R_PAINT);
  G.box(x0 + 0.1, y + 0.85, z0 + 0.1, x1 - 0.1, y + 1.0, z1 - 0.1, mulC(body, 1.5), 16);   // counter ledge
  // Warm lit service window + subtle vertical mullions on the front side
  const E = ctx.B('glow', x, z);
  if (alongX) {
    E.box(x0 + 0.2, y + 1.0, z1, x1 - 0.2, y + 2.1, z1 + 0.02, C('#ffd58a', 0.9), 4);
    G.box(x - 0.04, y + 1.0, z1 + 0.02, x + 0.04, y + 2.1, z1 + 0.04, trim, 31);
    G.box(x0 + 0.2, y + 1.48, z1 + 0.02, x1 - 0.2, y + 1.54, z1 + 0.04, trim, 31);
  } else {
    E.box(x1, y + 1.0, z0 + 0.2, x1 + 0.02, y + 2.1, z1 - 0.2, C('#ffd58a', 0.9), 1);
    G.box(x1 + 0.02, y + 1.0, z - 0.04, x1 + 0.04, y + 2.1, z + 0.04, trim, 31);
    G.box(x1 + 0.02, y + 1.48, z0 + 0.2, x1 + 0.04, y + 1.54, z1 - 0.2, trim, 31);
  }
  rm(G, R_DEF);
  ctx.world.addBox(x0, y, z0, x1, y + 2.6, z1, F_DEFAULT, S_METAL);
  if (ctx.occluder) ctx.occluder(x0, z0, x1, z1, 1.25, 0.34);
  ctx.pool(x + (alongX ? 0 : 2), z + (alongX ? 2 : 0), 5.5, '#ffd58a', 0.58);
  ctx.pool(x + (alongX ? 0 : -2), z + (alongX ? -2 : 0), 5.5, ad.color || '#88ccff', 0.42);
  if (ctx.light) {
    ctx.light(x + (alongX ? 0 : 2.2), z + (alongX ? 2.2 : 0), 7.5, '#ffd58a', 0.45);
    ctx.light(x + (alongX ? 0 : -2.2), z + (alongX ? -2.2 : 0), 7.5, ad.color || '#88ccff', 0.42);
  }
}

/** Subway entrance: railings around a stair well with globe lamps. Fast-travel point. */
export function subwayEntrance(ctx, x, z, alongX, name) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  const hl = 2.6, hw = 1.0, col = C('#1c3f2e');
  const x0 = alongX ? x - hl : x - hw, x1 = alongX ? x + hl : x + hw;
  const z0 = alongX ? z - hw : z - hl, z1 = alongX ? z + hw : z + hl;
  rm(G, R_PAINT);
  // dark stair well
  G.floor(x0 + 0.1, z0 + 0.1, x1 - 0.1, z1 - 0.1, y + 0.03, C('#050506'));
  const t = 0.12, h = 1.05;
  const rail = (ax0, az0, ax1, az1) => {
    G.box(ax0, y, az0, ax1, y + h - 0.06, az1, mulC(col, 0.9), 31);
    G.box(ax0 - 0.02, y + h - 0.06, az0 - 0.02, ax1 + 0.02, y + h, az1 + 0.02, mulC(col, 1.5), 31);   // cap rail
    ctx.world.addBox(ax0, y, az0, ax1, y + h, az1, F_DEFAULT, S_METAL);
  };
  if (alongX) {
    rail(x0, z0, x1, z0 + t); rail(x0, z1 - t, x1, z1); rail(x0, z0, x0 + t, z1);
  } else {
    rail(x0, z0, x0 + t, z1); rail(x1 - t, z0, x1, z1); rail(x0, z0, x1, z0 + t);
  }
  rm(G, R_DEF);
  // globe lamps on posts at the open end
  const E = ctx.B('glow', x, z);
  const ends = alongX ? [[x1, z0], [x1, z1]] : [[x0, z1], [x1, z1]];
  for (const [px, pz] of ends) {
    G.setRM(R_PAINT[0], R_PAINT[1]);
    G.cyl(px, pz, y, y + 2.6, 0.08, 0.06, 6, col, false);
    G.setRM(R_DEF[0], R_DEF[1]);
    E.blob(px, y + 2.8, pz, 0.24, 0.24, 0.24, C('#7dffb0'));
    ctx.glow(px, y + 2.8, pz, '#7dffb0', 0.8);
  }
  // sign
  const S = ctx.B('signs', x, z);
  const cell = ctx.signCells.SUBWAY;
  const uv = [cell.u0, cell.v0, cell.u1, cell.v1];
  if (alongX) {
    S.wall(x1 + 0.05, z0, x1 + 0.05, z1, y + 2.0, y + 2.5, null, uv);
    S.wall(x1 - 0.05, z1, x1 - 0.05, z0, y + 2.0, y + 2.5, null, uv);
  } else {
    S.wall(x1, z1 + 0.05, x0, z1 + 0.05, y + 2.0, y + 2.5, null, uv);
    S.wall(x0, z1 - 0.05, x1, z1 - 0.05, y + 2.0, y + 2.5, null, uv);
  }
  ctx.pool(x, z, 6, '#7dffb0', 0.35);
  ctx.stations.push({ x: alongX ? x1 + 1.6 : x, z: alongX ? z : z1 + 1.6, name });
}

/** Sidewalk shed: the green scaffolding that is on every other NYC block. */
export function scaffold(ctx, x0, z0, x1, z1) {
  const y = groundAt((x0 + x1) / 2, (z0 + z1) / 2);
  const G = ctx.B('flat', (x0 + x1) / 2, (z0 + z1) / 2);
  const green = C('#22402f');
  rm(G, R_WOOD);
  G.box(x0, y + 2.9, z0, x1, y + 3.9, z1, mulC(green, 0.9), 31 | 32, mulC(green, 1.2));
  rm(G, R_GALV);
  const alongX = x1 - x0 > z1 - z0;
  const n = Math.max(2, Math.round((alongX ? x1 - x0 : z1 - z0) / 3));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const px = alongX ? x0 + (x1 - x0) * t : x0, pz = alongX ? z0 : z0 + (z1 - z0) * t;
    const qx = alongX ? px : x1, qz = alongX ? z1 : pz;
    G.box(px - 0.05, y, pz - 0.05, px + 0.05, y + 2.9, pz + 0.05, STEEL, 15);
    G.box(qx - 0.05, y, qz - 0.05, qx + 0.05, y + 2.9, qz + 0.05, STEEL, 15);
  }
  rm(G, R_DEF);
  ctx.world.addBox(x0, y + 2.9, z0, x1, y + 3.9, z1, F_SOLID | F_BULLET | F_SEE, S_WOOD);
}

export function tent(ctx, x, z, alongX) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  const hl = 3, hw = 2.2, col = C('#4f5a3d');
  const b = alongX ? [x - hl, z - hw, x + hl, z + hw] : [x - hw, z - hl, x + hw, z + hl];
  const t = alongX ? [x - hl, z - 0.15, x + hl, z + 0.15] : [x - 0.15, z - hl, x + 0.15, z + hl];
  rm(G, R_FABRIC);
  G.box(b[0], y, b[1], b[2], y + 1.7, b[3], mulC(col, 0.8), 15, mulC(col, 1.05));
  G.taper(b, y + 1.7, t, y + 2.8, mulC(col, 1.0), true, mulC(col, 1.25));
  rm(G, R_DEF);
  ctx.world.addBox(b[0], y, b[1], b[2], y + 2.4, b[3], F_DEFAULT, S_DIRT);
}

export function flagPole(ctx, x, z, color) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  rm(G, [0.3, 0.9]);
  G.cyl(x, z, y, y + 9, 0.06, 0.04, 6, CHROME, true);
  G.blob(x, y + 9.05, z, 0.07, 0.07, 0.07, C('#c9b46a'));
  rm(G, R_FABRIC);
  const c = mute(color, 0.8, 0.85);
  G.quad([x + 0.05, y + 7.4, z], [x + 2.0, y + 7.5, z + 0.2], [x + 2.0, y + 8.8, z + 0.2], [x + 0.05, y + 8.9, z], c);
  G.quad([x + 2.0, y + 7.5, z + 0.2], [x + 0.05, y + 7.4, z], [x + 0.05, y + 8.9, z], [x + 2.0, y + 8.8, z + 0.2], c);
  rm(G, R_DEF);
}

export function bollard(ctx, x, z) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  rm(G, R_PAINT);
  G.cyl(x, z, y, y + 0.95, 0.1, 0.1, 6, C('#2c2e33'), true, C('#55585f'));
  G.cyl(x, z, y + 0.86, y + 0.9, 0.115, 0.115, 6, C('#8f9399'), false);  // reflective band
  rm(G, R_DEF);
}

export function waterTower(ctx, x, y, z) {
  const G = ctx.B('flat', x, z);
  const wood = C('#4a3526');
  rm(G, R_CAST);
  for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) G.box(x + dx * 1.1 - 0.08, y, z + dz * 1.1 - 0.08, x + dx * 1.1 + 0.08, y + 2.2, z + dz * 1.1 + 0.08, STEEL, 15);
  rm(G, R_WOOD);
  G.cyl(x, z, y + 2.2, y + 5.4, 1.75, 1.75, 8, wood, false, mulC(wood, 1.25));
  G.cyl(x, z, y + 5.4, y + 6.5, 1.85, 0.05, 8, C('#2a2420'), false);
  rm(G, R_CAST);
  for (const hy of [2.9, 3.9, 4.9]) G.cyl(x, z, y + hy, y + hy + 0.07, 1.78, 1.78, 8, STEEL, false);  // hoops
  rm(G, R_DEF);
}

export function manhole(ctx, x, z) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  const damp = C('#08090b'), iron = C('#15171b'), dish = C('#0f1114'), rim = C('#5a606b'), rib = C('#262a30');
  rm(G, [0.30, 0.05]);
  G.cyl(x, z, y + 0.002, y + 0.007, 0.64, 0.60, 12, damp, true);
  rm(G, [0.62, 0.72]);
  G.cyl(x, z, y + 0.007, y + 0.017, 0.48, 0.47, 12, iron, true, rim);
  G.cyl(x, z, y + 0.016, y + 0.021, 0.42, 0.41, 12, dish, true, iron);
  rm(G, [0.28, 0.88]);
  G.cyl(x, z, y + 0.017, y + 0.023, 0.46, 0.44, 12, rim, false);
  rm(G, [0.58, 0.70]);
  G.box(x - 0.30, y + 0.019, z - 0.030, x + 0.30, y + 0.025, z + 0.030, rib, 31);
  G.box(x - 0.030, y + 0.019, z - 0.30, x + 0.030, y + 0.025, z + 0.30, rib, 31);
  rm(G, R_DEF);
}

export function stormDrain(ctx, x, z, alongZ = true) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  const hx = alongZ ? 0.26 : 0.52, hz = alongZ ? 0.52 : 0.26;
  const sump = C('#0b0c0e'), iron = C('#353940'), bar = C('#4a4f57');
  rm(G, R_CAST);
  G.floor(x - hx, z - hz, x + hx, z + hz, y + 0.006, sump);
  // Perimeter frame
  G.box(x - hx - 0.04, y + 0.004, z - hz - 0.04, x + hx + 0.04, y + 0.020, z - hz + 0.04, iron, 31);
  G.box(x - hx - 0.04, y + 0.004, z + hz - 0.04, x + hx + 0.04, y + 0.020, z + hz + 0.04, iron, 31);
  G.box(x - hx - 0.04, y + 0.004, z - hz + 0.04, x - hx + 0.04, y + 0.020, z + hz - 0.04, iron, 31);
  G.box(x + hx - 0.04, y + 0.004, z - hz + 0.04, x + hx + 0.04, y + 0.020, z + hz - 0.04, iron, 31);
  // Grate bars
  for (let i = -2; i <= 2; i++) {
    const off = i * 0.16;
    if (alongZ) G.box(x - hx + 0.03, y + 0.008, z + off - 0.022, x + hx - 0.03, y + 0.022, z + off + 0.022, bar, 31);
    else G.box(x + off - 0.022, y + 0.008, z - hz + 0.03, x + off + 0.022, y + 0.022, z + hz - 0.03, bar, 31);
  }
  rm(G, R_DEF);
}

/** Cluster of 3 staggered NYC sidewalk newspaper/magazine honor boxes. */
export function newsBoxCluster(ctx, x, z, alongZ = true) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  const colors = ['#7e2420', '#204578', '#225238'];
  for (let i = -1; i <= 1; i++) {
    const off = i * 0.58;
    const jit = (hash2(x + i * 7.1, z) - 0.5) * 0.08;
    const bx = alongZ ? x + jit : x + off;
    const bz = alongZ ? z + off : z + jit;
    const col = C(colors[(i + 3) % colors.length]);
    rm(G, R_CAST);
    G.box(bx - 0.21, y, bz - 0.21, bx + 0.21, y + 0.28, bz + 0.21, BLACK, 15);
    rm(G, R_PAINT);
    G.box(bx - 0.23, y + 0.28, bz - 0.23, bx + 0.23, y + 1.06, bz + 0.23, col, 31, mulC(col, 1.2));
    // Overhang rain hood & recessed front window pane
    G.box(bx - 0.25, y + 1.03, bz - 0.25, bx + 0.25, y + 1.11, bz + 0.25, mulC(col, 0.85), 31, mulC(col, 1.15));
    rm(G, R_GLASS);
    if (alongZ) {
      G.box(bx - 0.24, y + 0.62, bz - 0.14, bx - 0.22, y + 0.94, bz + 0.14, C('#b9c6d4'), 2);
      G.box(bx + 0.22, y + 0.62, bz - 0.14, bx + 0.24, y + 0.94, bz + 0.14, C('#b9c6d4'), 1);
    } else {
      G.box(bx - 0.14, y + 0.62, bz - 0.24, bx + 0.14, y + 0.94, bz - 0.22, C('#b9c6d4'), 8);
      G.box(bx - 0.14, y + 0.62, bz + 0.22, bx + 0.14, y + 0.94, bz + 0.24, C('#b9c6d4'), 4);
    }
  }
  rm(G, R_DEF);
  if (alongZ) ctx.world.addBox(x - 0.28, y, z - 0.84, x + 0.28, y + 1.12, z + 0.84, F_DEFAULT, S_METAL);
  else ctx.world.addBox(x - 0.84, y, z - 0.28, x + 0.84, y + 1.12, z + 0.28, F_DEFAULT, S_METAL);
}

/** Flush NYC subway sidewalk ventilation vault grate with steel curbing and iron bars. */
export function sidewalkVent(ctx, x, z, alongZ = true) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  const hx = alongZ ? 0.68 : 1.45, hz = alongZ ? 1.45 : 0.68;
  rm(G, R_CAST);
  G.floor(x - hx, z - hz, x + hx, z + hz, y + 0.005, C('#060709'));
  const rim = C('#3a3e46'), bar = C('#505660');
  G.box(x - hx - 0.06, y + 0.004, z - hz - 0.06, x + hx + 0.06, y + 0.028, z - hz + 0.04, rim, 31);
  G.box(x - hx - 0.06, y + 0.004, z + hz - 0.04, x + hx + 0.06, y + 0.028, z + hz + 0.06, rim, 31);
  G.box(x - hx - 0.06, y + 0.004, z - hz + 0.04, x - hx + 0.04, y + 0.028, z + hz - 0.04, rim, 31);
  G.box(x + hx - 0.04, y + 0.004, z - hz + 0.04, x + hx + 0.06, y + 0.028, z + hz - 0.04, rim, 31);
  for (let i = -3; i <= 3; i++) {
    const off = i * 0.36;
    if (alongZ) G.box(x - hx + 0.04, y + 0.010, z + off - 0.024, x + hx - 0.04, y + 0.026, z + off + 0.024, bar, 31);
    else G.box(x + off - 0.024, y + 0.010, z - hz + 0.04, x + off + 0.024, y + 0.026, z + hz - 0.04, bar, 31);
  }
  rm(G, R_DEF);
}

export { BLACK, STEEL, CONCRETE, POLE };
