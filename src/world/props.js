// Street furniture, vehicles and other merged props. Each helper writes
// geometry into the chunked builders and registers colliders.
import { C, mulC } from './geo.js';
import { CURB, groundAt } from './layout.js';
import { F_DEFAULT, F_SOLID, F_BULLET, F_CAMERA, F_SEE, S_METAL, S_CONCRETE, S_WOOD, S_DIRT, S_GLASS } from '../core/physics.js';

const BLACK = C('#101114'), TIRE = C('#0b0b0d'), GLASS = C('#152030'), CHROME = C('#8a8f98');
const HEAD = C('#fff3c4'), TAIL = C('#ff2a1a'), CONCRETE = C('#9a9892'), STEEL = C('#3a3d42');
const POLE = C('#2b2e33'), GREEN_DARK = C('#1f3d2a');

export const CAR_COLORS = ['#c9ccd1', '#1b1c20', '#6a6e75', '#7a1d1d', '#1f3a66', '#e8e8e8', '#3b3f46', '#58606b', '#2d4a3a', '#8a8d92'].map((h) => C(h));
const TAXI = C('#f0b90b'), POLICE_W = C('#eef0f2'), POLICE_B = C('#1c3f94'), BUS_B = C('#1d4f91'), BUS_W = C('#e6e8ea');
const ARMY = C('#6b6248'), ARMY_D = C('#4f4936'), TRUCK_W = C('#d9d9d4');

/** Axis-aligned bounds of a yawed rectangle, registered as one collider. */
function addYawBox(ctx, x, z, yaw, hl, hw, y0, y1, flags = F_DEFAULT, surf = S_METAL) {
  const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
  // local length runs along -Z (forward); width along X
  const ex = hw * c + hl * s, ez = hw * s + hl * c;
  return ctx.world.addBox(x - ex, y0, z - ez, x + ex, y1, z + ez, flags, surf);
}

/**
 * Vehicles are modelled facing -Z (local), `yaw` rotates them about Y.
 * kind: sedan | taxi | police | suv | van | truck | bus | humvee | wreck
 */
export function vehicle(ctx, kind, x, z, yaw, rng, lightsOn = false) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z).setXform(x, y, z, yaw);
  const E = ctx.B('glow', x, z).setXform(x, y, z, yaw);
  let L = 4.6, W = 1.84, H = 1.45, col = rng.pick(CAR_COLORS), cabin = GLASS;
  let hood = 0.86, roofF = 0.9, roofB = -1.25, clear = 0.28;
  if (kind === 'taxi') col = TAXI;
  else if (kind === 'police') col = POLICE_W;
  else if (kind === 'suv') { L = 4.9; W = 1.95; H = 1.8; hood = 1.02; roofF = 1.0; roofB = -2.1; }
  else if (kind === 'humvee') { L = 4.8; W = 2.2; H = 1.9; hood = 1.15; roofF = 0.5; roofB = -2.2; col = ARMY; cabin = ARMY_D; clear = 0.45; }
  else if (kind === 'wreck') { col = C('#1a1614'); cabin = C('#0c0a09'); }
  const hl = L / 2, hw = W / 2;

  if (kind === 'bus' || kind === 'van' || kind === 'truck') {
    const isBus = kind === 'bus';
    L = isBus ? 12 : kind === 'truck' ? 8.2 : 5.6;
    W = isBus ? 2.55 : kind === 'truck' ? 2.45 : 2.0;
    H = isBus ? 3.1 : kind === 'truck' ? 3.4 : 2.3;
    const l2 = L / 2, w2 = W / 2;
    const body = isBus ? BUS_W : kind === 'truck' ? TRUCK_W : rng.pick(CAR_COLORS);
    if (kind === 'truck') {
      // cab + cargo box
      G.box(-w2 * 0.92, 0.5, -l2, w2 * 0.92, 2.5, -l2 + 2.0, rng.pick(CAR_COLORS), 31);
      G.box(-w2 * 0.86, 1.5, -l2 - 0.02, w2 * 0.86, 2.3, -l2 + 0.6, GLASS, 15 | 16);
      G.box(-w2, 0.9, -l2 + 2.15, w2, H, l2, body, 31);
    } else {
      G.box(-w2, 0.42, -l2, w2, H, l2, body, 31);
      // window band
      const wy0 = isBus ? 1.5 : 1.25, wy1 = isBus ? 2.55 : 1.95;
      G.box(-w2 - 0.02, wy0, -l2 - 0.02, w2 + 0.02, wy1, isBus ? l2 - 0.4 : -l2 + 2.2, GLASS, 15);
      if (isBus) G.box(-w2 - 0.03, 0.75, -l2 - 0.03, w2 + 0.03, 1.2, l2 + 0.03, BUS_B, 15);
    }
    for (const az of [-l2 + 1.4, l2 - 1.6]) G.box(-w2 - 0.03, 0, az - 0.48, w2 + 0.03, 0.96, az + 0.48, TIRE, 15);
    if (lightsOn) {
      E.box(-w2 + 0.15, 0.7, -l2 - 0.03, -w2 + 0.5, 0.95, -l2, HEAD, 8);
      E.box(w2 - 0.5, 0.7, -l2 - 0.03, w2 - 0.15, 0.95, -l2, HEAD, 8);
    }
    E.box(-w2 + 0.1, 0.8, l2, -w2 + 0.4, 1.05, l2 + 0.03, mulC(TAIL, lightsOn ? 1 : 0.35), 4);
    E.box(w2 - 0.4, 0.8, l2, w2 - 0.1, 1.05, l2 + 0.03, mulC(TAIL, lightsOn ? 1 : 0.35), 4);
    G.resetXform(); E.resetXform();
    addYawBox(ctx, x, z, yaw, l2, w2, y, y + H);
    ctx.vehicles.push({ x, z, yaw, hl: l2, hw: w2 });
    return;
  }

  // lower body
  G.box(-hw, clear, -hl, hw, hood, hl, col, 31);
  // cabin (tapered greenhouse)
  G.taper([-hw + 0.06, roofB - 0.35, hw - 0.06, roofF + 0.55], hood, [-hw + 0.2, roofB, hw - 0.2, roofF], H, cabin, true, kind === 'humvee' ? ARMY : col);
  // wheels: one dark slab per axle
  const wr = kind === 'humvee' ? 0.46 : 0.34;
  for (const az of [-hl + 0.85, hl - 0.9]) G.box(-hw - 0.03, 0, az - wr, hw + 0.03, wr * 2, az + wr, TIRE, 15);
  if (kind === 'taxi') {
    E.box(-0.28, H, -0.25, 0.28, H + 0.16, 0.05, C('#fff6c2', lightsOn ? 1 : 0.5), 31);
  } else if (kind === 'police') {
    G.box(-hw - 0.01, 0.5, -hl * 0.55, hw + 0.01, 0.74, hl * 0.6, POLICE_B, 3);
    E.box(-0.5, H, -0.2, -0.04, H + 0.13, 0.05, C('#ff2030'), 31);
    E.box(0.04, H, -0.2, 0.5, H + 0.13, 0.05, C('#2a6bff'), 31);
    ctx.glow(x, y + H + 0.3, z, rng.chance(0.5) ? '#ff3344' : '#3b7bff', 3);
  }
  const hk = lightsOn ? 1 : 0.12;
  E.box(-hw + 0.1, hood - 0.26, -hl - 0.02, -hw + 0.52, hood - 0.08, -hl, mulC(HEAD, hk), 8);
  E.box(hw - 0.52, hood - 0.26, -hl - 0.02, hw - 0.1, hood - 0.08, -hl, mulC(HEAD, hk), 8);
  E.box(-hw + 0.08, hood - 0.24, hl, -hw + 0.5, hood - 0.08, hl + 0.02, mulC(TAIL, lightsOn ? 1 : 0.3), 4);
  E.box(hw - 0.5, hood - 0.24, hl, hw - 0.08, hood - 0.08, hl + 0.02, mulC(TAIL, lightsOn ? 1 : 0.3), 4);
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

export function lampPost(ctx, x, z, dirX, dirZ, color = '#ffd9a0') {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  G.box(x - 0.09, y, z - 0.09, x + 0.09, y + 8.6, z + 0.09, POLE, 15);
  const hx = x + dirX * 2.4, hz = z + dirZ * 2.4;
  G.box(Math.min(x, hx) - 0.06, y + 8.45, Math.min(z, hz) - 0.06, Math.max(x, hx) + 0.06, y + 8.6, Math.max(z, hz) + 0.06, POLE, 31);
  const E = ctx.B('glow', x, z);
  E.box(hx - 0.32, y + 8.28, hz - 0.32, hx + 0.32, y + 8.46, hz + 0.32, C(color), 31 | 32);
  ctx.glow(hx, y + 8.3, hz, color, 1);
  ctx.pool(hx + dirX * 1.5, hz + dirZ * 1.5, 11, color, 0.55);
}

export function trafficLight(ctx, x, z, dirX, dirZ, green, labels) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  G.box(x - 0.1, y, z - 0.1, x + 0.1, y + 6.4, z + 0.1, POLE, 15);
  const ax = x + dirX * 4.5, az = z + dirZ * 4.5;
  G.box(Math.min(x, ax) - 0.07, y + 6.1, Math.min(z, az) - 0.07, Math.max(x, ax) + 0.07, y + 6.25, Math.max(z, az) + 0.07, POLE, 31 | 32);
  // signal head
  G.box(ax - 0.2, y + 5.1, az - 0.2, ax + 0.2, y + 6.1, az + 0.2, C('#d6b000'), 31 | 32);
  const E = ctx.B('glow', x, z);
  const lit = green ? C('#35ff7a') : C('#ff3020');
  const ly = green ? y + 5.2 : y + 5.75;
  E.box(ax - 0.22, ly, az - 0.22, ax + 0.22, ly + 0.26, az + 0.22, lit, 15);
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
  const t = alongX ? [x - hl, z - 0.1, x + hl, z + 0.1] : [x - 0.1, z - hl, x + 0.1, z + hl];
  G.taper(b, y, t, y + 0.95, CONCRETE, true, mulC(CONCRETE, 1.1));
  ctx.world.addBox(b[0], y, b[1] + (alongX ? 0.1 : 0), b[2], y + 0.95, b[3] - (alongX ? 0.1 : 0), F_DEFAULT, S_CONCRETE);
}

export function sandbags(ctx, x, z, alongX, len = 2.6, h = 1.05) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  const col = C('#8c7b58'), col2 = C('#75664a');
  const hl = len / 2, hw = 0.38;
  const rows = Math.round(h / 0.26);
  for (let r = 0; r < rows; r++) {
    const inset = r * 0.03, off = (r % 2) * 0.22;
    const y0 = y + r * (h / rows), y1 = y + (r + 1) * (h / rows) - 0.02;
    if (alongX) G.box(x - hl + inset + off * 0.3, y0, z - hw + inset, x + hl - inset, y1, z + hw - inset, r % 2 ? col : col2, 31);
    else G.box(x - hw + inset, y0, z - hl + inset + off * 0.3, x + hw - inset, y1, z + hl - inset, r % 2 ? col : col2, 31);
  }
  if (alongX) ctx.world.addBox(x - hl, y, z - hw, x + hl, y + h, z + hw, F_DEFAULT, S_DIRT);
  else ctx.world.addBox(x - hw, y, z - hl, x + hw, y + h, z + hl, F_DEFAULT, S_DIRT);
}

export function crate(ctx, x, z, size = 1.2, stack = 1, kind = 'wood') {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  const h = size / 2;
  const col = kind === 'wood' ? C('#7a6240') : C('#4f5a3a');
  for (let i = 0; i < stack; i++) {
    const o = i * 0.07;
    G.box(x - h + o, y + i * size, z - h + o, x + h - o, y + (i + 1) * size, z + h - o, col, 31, mulC(col, 1.15));
    G.box(x - h + o - 0.02, y + i * size + size * 0.45, z - h + o - 0.02, x + h - o + 0.02, y + i * size + size * 0.55, z + h - o + 0.02, mulC(col, 0.7), 15);
  }
  ctx.world.addBox(x - h, y, z - h, x + h, y + size * stack, z + h, F_DEFAULT, kind === 'wood' ? S_WOOD : S_METAL);
}

export function container(ctx, x, z, alongX, color) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  const hl = 3.05, hw = 1.22, h = 2.6;
  const col = C(color);
  const x0 = alongX ? x - hl : x - hw, x1 = alongX ? x + hl : x + hw;
  const z0 = alongX ? z - hw : z - hl, z1 = alongX ? z + hw : z + hl;
  G.box(x0, y, z0, x1, y + h, z1, col, 31, mulC(col, 1.1));
  // corrugation hint: darker bands
  for (let k = 1; k < 6; k++) {
    if (alongX) G.box(x0 + (k * (x1 - x0)) / 6 - 0.06, y + 0.15, z0 - 0.02, x0 + (k * (x1 - x0)) / 6 + 0.06, y + h - 0.15, z1 + 0.02, mulC(col, 0.72), 12);
    else G.box(x0 - 0.02, y + 0.15, z0 + (k * (z1 - z0)) / 6 - 0.06, x1 + 0.02, y + h - 0.15, z0 + (k * (z1 - z0)) / 6 + 0.06, mulC(col, 0.72), 3);
  }
  ctx.world.addBox(x0, y, z0, x1, y + h, z1, F_DEFAULT, S_METAL);
}

export function planter(ctx, x, z, w = 1.4, d = 1.4, shrub = true) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  G.box(x - w / 2, y, z - d / 2, x + w / 2, y + 0.75, z + d / 2, C('#6f6e6a'), 31, C('#8a8985'));
  G.floor(x - w / 2 + 0.1, z - d / 2 + 0.1, x + w / 2 - 0.1, z + d / 2 - 0.1, y + 0.76, C('#2a2218'));
  if (shrub) G.blob(x, y + 1.15, z, w * 0.45, 0.55, d * 0.45, C('#1e4a2b'), C('#2f6b3c'));
  ctx.world.addBox(x - w / 2, y, z - d / 2, x + w / 2, y + 0.75, z + d / 2, F_DEFAULT, S_CONCRETE);
}

export function bench(ctx, x, z, alongX, len = 3.2) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  const hl = len / 2, hw = 0.32;
  const x0 = alongX ? x - hl : x - hw, x1 = alongX ? x + hl : x + hw;
  const z0 = alongX ? z - hw : z - hl, z1 = alongX ? z + hw : z + hl;
  G.box(x0, y, z0, x1, y + 0.48, z1, C('#4c4b49'), 31, C('#77767a'));
  ctx.world.addBox(x0, y, z0, x1, y + 0.48, z1, F_SOLID | F_BULLET, S_CONCRETE);
}

export function tree(ctx, x, z, rng, scale = 1) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  const h = (4 + rng.next() * 2.5) * scale, r = (2.2 + rng.next() * 1.3) * scale;
  G.box(x - 0.16, y, z - 0.16, x + 0.16, y + h, z + 0.16, C('#2e241b'), 15);
  const g1 = C(rng.pick(['#1f4a2a', '#24552f', '#1b4226', '#2b5a2c']));
  const g2 = mulC(g1, 1.5);
  G.blob(x, y + h + r * 0.5, z, r, r * 0.95, r, g1, g2);
  G.blob(x + rng.range(-0.8, 0.8) * scale, y + h + r * 1.05, z + rng.range(-0.8, 0.8) * scale, r * 0.68, r * 0.7, r * 0.68, g1, g2);
  ctx.world.addBox(x - 0.22, y, z - 0.22, x + 0.22, y + h, z + 0.22, F_SOLID | F_BULLET | F_CAMERA, S_WOOD);
}

export function hydrant(ctx, x, z) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  G.cyl(x, z, y, y + 0.62, 0.13, 0.11, 6, C('#a31d1d'), true, C('#c22a2a'));
  G.box(x - 0.2, y + 0.36, z - 0.06, x + 0.2, y + 0.5, z + 0.06, C('#8a1717'), 31);
  ctx.world.addBox(x - 0.14, y, z - 0.14, x + 0.14, y + 0.62, z + 0.14, F_SOLID | F_BULLET, S_METAL);
}

export function trashCan(ctx, x, z) {
  const y = groundAt(x, z);
  ctx.B('flat', x, z).cyl(x, z, y, y + 0.95, 0.3, 0.36, 8, GREEN_DARK, true, C('#0c0e0d'));
  ctx.world.addBox(x - 0.3, y, z - 0.3, x + 0.3, y + 0.95, z + 0.3, F_SOLID | F_BULLET, S_METAL);
}

export function mailbox(ctx, x, z) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  G.box(x - 0.3, y + 0.12, z - 0.3, x + 0.3, y + 1.15, z + 0.3, C('#1c3f94'), 31, C('#2a55b8'));
  ctx.world.addBox(x - 0.3, y, z - 0.3, x + 0.3, y + 1.15, z + 0.3, F_DEFAULT, S_METAL);
}

export function newsstand(ctx, x, z, alongX) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  const hl = 1.9, hw = 1.1;
  const x0 = alongX ? x - hl : x - hw, x1 = alongX ? x + hl : x + hw;
  const z0 = alongX ? z - hw : z - hl, z1 = alongX ? z + hw : z + hl;
  G.box(x0, y, z0, x1, y + 2.5, z1, C('#27402f'), 31, C('#325540'));
  G.box(x0 - 0.25, y + 2.5, z0 - 0.25, x1 + 0.25, y + 2.62, z1 + 0.25, C('#1a2a20'), 31 | 32);
  const E = ctx.B('glow', x, z);
  if (alongX) E.box(x0 + 0.2, y + 1.0, z1, x1 - 0.2, y + 2.1, z1 + 0.02, C('#ffd58a', 0.8), 4);
  else E.box(x1, y + 1.0, z0 + 0.2, x1 + 0.02, y + 2.1, z1 - 0.2, C('#ffd58a', 0.8), 1);
  ctx.world.addBox(x0, y, z0, x1, y + 2.6, z1, F_DEFAULT, S_METAL);
  ctx.pool(x + (alongX ? 0 : 2), z + (alongX ? 2 : 0), 5, '#ffd58a', 0.5);
}

/** Subway entrance: railings around a stair well with globe lamps. Fast-travel point. */
export function subwayEntrance(ctx, x, z, alongX, name) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  const hl = 2.6, hw = 1.0, col = C('#1d4a33');
  const x0 = alongX ? x - hl : x - hw, x1 = alongX ? x + hl : x + hw;
  const z0 = alongX ? z - hw : z - hl, z1 = alongX ? z + hw : z + hl;
  // dark stair well
  G.floor(x0 + 0.1, z0 + 0.1, x1 - 0.1, z1 - 0.1, y + 0.03, C('#050506'));
  const t = 0.12, h = 1.05;
  const rail = (ax0, az0, ax1, az1) => {
    G.box(ax0, y, az0, ax1, y + h, az1, col, 31, mulC(col, 1.3));
    ctx.world.addBox(ax0, y, az0, ax1, y + h, az1, F_DEFAULT, S_METAL);
  };
  if (alongX) {
    rail(x0, z0, x1, z0 + t); rail(x0, z1 - t, x1, z1); rail(x0, z0, x0 + t, z1);
  } else {
    rail(x0, z0, x0 + t, z1); rail(x1 - t, z0, x1, z1); rail(x0, z0, x1, z0 + t);
  }
  // globe lamps on posts at the open end
  const E = ctx.B('glow', x, z);
  const ends = alongX ? [[x1, z0], [x1, z1]] : [[x0, z1], [x1, z1]];
  for (const [px, pz] of ends) {
    G.box(px - 0.06, y, pz - 0.06, px + 0.06, y + 2.6, pz + 0.06, col, 15);
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
  const green = C('#1f4d36');
  G.box(x0, y + 2.9, z0, x1, y + 3.9, z1, green, 31 | 32, mulC(green, 1.2));
  const alongX = x1 - x0 > z1 - z0;
  const n = Math.max(2, Math.round((alongX ? x1 - x0 : z1 - z0) / 3));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const px = alongX ? x0 + (x1 - x0) * t : x0, pz = alongX ? z0 : z0 + (z1 - z0) * t;
    const qx = alongX ? px : x1, qz = alongX ? z1 : pz;
    G.box(px - 0.05, y, pz - 0.05, px + 0.05, y + 2.9, pz + 0.05, STEEL, 15);
    G.box(qx - 0.05, y, qz - 0.05, qx + 0.05, y + 2.9, qz + 0.05, STEEL, 15);
  }
  ctx.world.addBox(x0, y + 2.9, z0, x1, y + 3.9, z1, F_SOLID | F_BULLET | F_SEE, S_WOOD);
}

export function tent(ctx, x, z, alongX) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  const hl = 3, hw = 2.2, col = C('#55603f');
  const b = alongX ? [x - hl, z - hw, x + hl, z + hw] : [x - hw, z - hl, x + hw, z + hl];
  const t = alongX ? [x - hl, z - 0.15, x + hl, z + 0.15] : [x - 0.15, z - hl, x + 0.15, z + hl];
  G.box(b[0], y, b[1], b[2], y + 1.7, b[3], col, 15);
  G.taper(b, y + 1.7, t, y + 2.8, mulC(col, 1.15), true);
  ctx.world.addBox(b[0], y, b[1], b[2], y + 2.4, b[3], F_DEFAULT, S_DIRT);
}

export function flagPole(ctx, x, z, color) {
  const y = groundAt(x, z);
  const G = ctx.B('flat', x, z);
  G.box(x - 0.05, y, z - 0.05, x + 0.05, y + 9, z + 0.05, CHROME, 15);
  const c = C(color);
  G.quad([x + 0.05, y + 7.4, z], [x + 2.0, y + 7.5, z + 0.2], [x + 2.0, y + 8.8, z + 0.2], [x + 0.05, y + 8.9, z], c);
  G.quad([x + 2.0, y + 7.5, z + 0.2], [x + 0.05, y + 7.4, z], [x + 0.05, y + 8.9, z], [x + 2.0, y + 8.8, z + 0.2], c);
}

export function bollard(ctx, x, z) {
  const y = groundAt(x, z);
  ctx.B('flat', x, z).cyl(x, z, y, y + 0.95, 0.1, 0.1, 6, C('#2c2e33'), true, C('#55585f'));
}

export function waterTower(ctx, x, y, z) {
  const G = ctx.B('flat', x, z);
  const wood = C('#4a3526');
  for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) G.box(x + dx * 1.1 - 0.08, y, z + dz * 1.1 - 0.08, x + dx * 1.1 + 0.08, y + 2.2, z + dz * 1.1 + 0.08, STEEL, 15);
  G.cyl(x, z, y + 2.2, y + 5.4, 1.75, 1.75, 8, wood, false, mulC(wood, 1.25));
  G.cyl(x, z, y + 5.4, y + 6.5, 1.85, 0.05, 8, C('#2a2420'), false);
}

export { BLACK, STEEL, CONCRETE, POLE };
