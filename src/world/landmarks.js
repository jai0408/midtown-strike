// Hand-placed parts of the map: the Times Square bowtie, parks, landmark
// towers, the waterfront and all the street dressing.
import { RNG, clamp } from '../core/util.js';
import { C, mulC } from './geo.js';
import {
  HALF, CURB, AVENUES, STREETS, streetZ, broadwayX, BW_HW, PLAZA_Z0, PLAZA_Z1,
  groundAt, RAISED_RECTS, RAISED_CIRCLES, avenueById, LANDMARKS,
} from './layout.js';
import { F_DEFAULT, F_SOLID, F_BULLET, F_CAMERA, F_SEE, F_BUILDING, F_ALL, S_CONCRETE, S_METAL, S_GLASS, S_DIRT } from '../core/physics.js';
import { AD_LAND, AD_PORT } from './textures.js';
import { addBuilding } from './city.js';
import * as P from './props.js';

const A = (id) => avenueById(id);
const LAWN = C('#2c5a2e'), LAWN2 = C('#356b35'), PATH = C('#8a7f68'), STONE = C('#8c8678'), WATER = C('#0d2238');
const NEON = ['#ff2d6f', '#00c2ff', '#ffe44d', '#19e68c', '#b44dff', '#ff7a00', '#ffffff', '#ff3b30', '#30cfd0'];
const WHITE_TINT = [1.25, 1.25, 1.22];

const noop = () => {};
const lawn = (ctx, x0, z0, x1, z1, col = LAWN) => {
  ctx.B('flat', (x0 + x1) / 2, (z0 + z1) / 2).floor(x0, z0, x1, z1, CURB + 0.03, col);
  ctx.parks.push({ x0, z0, x1, z1 });
};
const paved = (ctx, x0, z0, x1, z1, col = PATH) => ctx.B('flat', (x0 + x1) / 2, (z0 + z1) / 2).floor(x0, z0, x1, z1, CURB + 0.045, col);
const lowWall = (ctx, x0, z0, x1, z1, h = 0.95, col = STONE) => {
  ctx.B('flat', (x0 + x1) / 2, (z0 + z1) / 2).box(x0, CURB, z0, x1, CURB + h, z1, col, 31, mulC(col, 1.2));
  ctx.world.addBox(x0, CURB, z0, x1, CURB + h, z1, F_DEFAULT, S_CONCRETE);
};
/** Emissive panel on an axis-aligned wall (outward normal to the left of A->B). */
function panel(ctx, mat, ax, az, bx, bz, y0, y1, uv, out = 0.45) {
  const len = Math.hypot(bx - ax, bz - az);
  const nx = ((bz - az) / len) * out, nz = (-(bx - ax) / len) * out;
  const mx = (ax + bx) / 2, mz = (az + bz) / 2;
  ctx.B('flat', mx, mz).wall(ax + nx * 0.8, az + nz * 0.8, bx + nx * 0.8, bz + nz * 0.8, y0 - 0.35, y1 + 0.35, C('#0b0c0f'));
  ctx.B(mat, mx, mz).wall(ax + nx, az + nz, bx + nx, bz + nz, y0, y1, null, uv);
}
const ANIM_UV = [0.004, 0.004, 0.246, 0.246];
function adPanel(ctx, rng, ax, az, bx, bz, y0, y1, forceAnim = false) {
  const w = Math.hypot(bx - ax, bz - az), h = y1 - y0;
  const r = rng.next();
  if (forceAnim || r < 0.32) {
    // every screen starts on a different frame of the 4x4 sheet
    const cu = rng.int(0, 3) / 4, cv = rng.int(0, 3) / 4;
    return panel(ctx, rng.chance(0.5) ? 'adsA' : 'adsB', ax, az, bx, bz, y0, y1, [cu + ANIM_UV[0], cv + ANIM_UV[1], cu + ANIM_UV[2], cv + ANIM_UV[3]]);
  }
  const c = w >= h ? rng.pick(AD_LAND) : rng.pick(AD_PORT);
  panel(ctx, 'ads', ax, az, bx, bz, y0, y1, [c.u0 + 0.002, c.v0 + 0.003, c.u1 - 0.002, c.v1 - 0.003]);
}

// ---------------------------------------------------------------------------
// Blocks with custom content. Returns a function, {reserve:[...]} or null.
// ---------------------------------------------------------------------------
export function specialBlock(blk) {
  if (blk.col < 0 || blk.border) return null;
  const key = `${AVENUES[blk.col].id}:${blk.nSouth}`;
  switch (key) {
    case '6:40': return bryantPark;
    case '6:41': return noop;
    case 'MAD:42': return grandCentral;
    case 'MAD:43': case 'MAD:44': case 'PARK:42': case 'PARK:43': case 'PARK:44': return noop;
    case '6:49': return rockefeller;
    case '8:31': return arena;
    case '8:32': return noop;
    case '6:33': return landmarkTower({ side: 'east', w: 74, h: 320, style: 5, spire: 120, tiers: 4, name: 'empire' });
    case 'LEX:42': return landmarkTower({ side: 'west', w: 48, h: 250, style: 5, spire: 70, tiers: 4, name: 'chrysler' });
    case '7:42': return landmarkTower({ side: 'east', w: 62, h: 288, style: 0, spire: 78, tiers: 2 });
    case '8:57': return landmarkTower({ side: 'east', w: 34, h: 430, style: 0, spire: 0, tiers: 3, at: 0.55 });
    case '7:56': return landmarkTower({ side: 'west', w: 20, h: 420, style: 5, spire: 14, tiers: 4, at: 0.45 });
    case 'PARK:56': return landmarkTower({ side: 'west', w: 30, h: 410, style: 2, spire: 0, tiers: 1, tint: WHITE_TINT });
    default: return null;
  }
}

/** One signature tower at an end of the block; the rest gets ordinary lots. */
function landmarkTower(o) {
  return (ctx, blk) => {
    const { rng } = ctx;
    const depth = blk.z1 - blk.z0;
    const d = Math.min(depth, o.w * 1.15);
    let x0;
    if (o.at != null) x0 = blk.x0 + (blk.x1 - blk.x0 - o.w) * o.at;
    else x0 = o.side === 'east' ? blk.x1 - o.w : blk.x0;
    const x1 = x0 + o.w;
    const z0 = blk.z0 + (depth - d) / 2, z1 = z0 + d;
    const base = CURB, top = base + o.h;
    const tiers = [];
    for (let i = 0; i < o.tiers; i++) {
      const t0 = i === 0 ? 0 : 0.3 + (0.7 * (i - 1)) / Math.max(1, o.tiers - 1) + (i === 1 ? 0 : 0.1);
      const t1 = i === o.tiers - 1 ? 1 : 0.3 + (0.7 * i) / Math.max(1, o.tiers - 1) + 0.1;
      const inset = i * Math.min(o.w, d) * 0.1;
      tiers.push([x0 + inset, z0 + inset, x1 - inset, z1 - inset, base + o.h * Math.min(t0, 1), base + o.h * Math.min(t1, 1)]);
    }
    addBuilding(ctx, { x0, z0, x1, z1, h: o.h, style: o.style, tint: o.tint || [1, 1, 1], shops: 15, tiers, noRoof: true, noAds: true });
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    if (o.spire) {
      const G = ctx.B('flat', cx, cz, 3);
      const r = Math.min(o.w, d) * (0.5 - o.tiers * 0.1) * 0.8;
      const steel = C('#9aa0aa');
      G.cyl(cx, cz, top, top + o.spire * 0.45, Math.max(2, r), Math.max(1, r * 0.45), 8, steel, false, mulC(steel, 1.3));
      G.cyl(cx, cz, top + o.spire * 0.45, top + o.spire, Math.max(1, r * 0.45), 0.15, 6, steel, false, mulC(steel, 1.4));
      const lit = o.name === 'empire' ? '#ffffff' : o.name === 'chrysler' ? '#ffe2a8' : '#9fd0ff';
      for (let k = 0; k < 5; k++) ctx.glow(cx, top + (o.spire * k) / 5, cz, lit, 5 - k * 0.6);
      ctx.glow(cx, top + o.spire, cz, '#ff3030', 3);
    } else {
      ctx.glow(cx, top + 2, cz, '#ff3030', 2.5);
    }
    // fill the rest of the block with normal buildings
    const fill = (fx0, fx1) => {
      let x = fx0;
      while (x < fx1 - 12) {
        let w = rng.range(26, 60);
        if (fx1 - (x + w) < 20) w = fx1 - x;
        const e0 = Math.min(broadwayX(blk.z0), broadwayX(blk.z1)) - BW_HW, e1 = Math.max(broadwayX(blk.z0), broadwayX(blk.z1)) + BW_HW;
        const lot = { x0: x, x1: x + w, z0: blk.z0, z1: blk.z1 };
        x += w;
        const zc = (blk.z0 + blk.z1) / 2;
        let lo = e0, hi = e1;
        if (zc > PLAZA_Z0 - 80 && zc < PLAZA_Z1) { if (zc > 0) lo = Math.min(lo, 15); else hi = Math.max(hi, -15); }
        const parts = [];
        if (lot.x1 <= lo || lot.x0 >= hi) parts.push(lot);
        else {
          if (lo - lot.x0 >= 10) parts.push({ ...lot, x1: lo });
          if (lot.x1 - hi >= 10) parts.push({ ...lot, x0: hi });
        }
        for (const p of parts) {
          addBuilding(ctx, { ...p, h: rng.range(60, 190), style: rng.pick([0, 1, 2, 5]), tint: [1, 1, 1], shops: 15, nearTS: Math.abs(zc) < 260 && Math.abs((p.x0 + p.x1) / 2) < 200 });
        }
      }
    };
    fill(blk.x0, x0);
    fill(x1, blk.x1);
  };
}

function bryantPark(ctx, blk) {
  const { rng } = ctx;
  const a6 = A('6'), a5 = A('5');
  const s41 = streetZ(41);
  const x0 = a6.x + a6.hw, x1 = a5.x - a5.hw;
  const z0 = streetZ(42) + 15, z1 = streetZ(40) - 9;
  // close 41st St through the park
  RAISED_RECTS.push({ x0: a6.x + a6.road, x1: a5.x - a5.road, z0: s41 - 5.2, z1: s41 + 5.2 });
  ctx.B('walk', (x0 + x1) / 2, s41, 3).floor(a6.x + a6.road, s41 - 5.2, a5.x - a5.road, s41 + 5.2, CURB, [1, 1, 1], [0, 0, 60, 3]);
  // library on the 5th Avenue side
  const lib = { x0: x1 - 82, z0: z0 + 8, x1: x1 - 6, z1: z1 - 8 };
  addBuilding(ctx, { ...lib, h: 30, style: 2, tint: [1.2, 1.18, 1.1], shops: 0, noRoof: true, noAds: true, tiers: [[lib.x0, lib.z0, lib.x1, lib.z1, CURB, CURB + 24], [lib.x0 + 8, lib.z0 + 8, lib.x1 - 8, lib.z1 - 8, CURB + 24, CURB + 30]] });
  for (const dz of [-14, 14]) { // the two lions
    const lx = lib.x1 + 3, lz = (lib.z0 + lib.z1) / 2 + dz;
    ctx.B('flat', lx, lz).box(lx - 1, CURB, lz - 1.6, lx + 1, CURB + 1.4, lz + 1.6, STONE, 31);
    ctx.B('flat', lx, lz).blob(lx, CURB + 2.1, lz, 0.8, 0.8, 1.5, C('#b9b3a4'));
    ctx.world.addBox(lx - 1, CURB, lz - 1.6, lx + 1, CURB + 2.6, lz + 1.6, F_DEFAULT, S_CONCRETE);
  }
  // lawn, gravel paths, plane trees
  const px0 = x0 + 6, px1 = lib.x0 - 10;
  paved(ctx, px0, z0 + 4, px1, z1 - 4, PATH);
  lawn(ctx, px0 + 22, z0 + 26, px1 - 12, z1 - 26, LAWN);
  ctx.parks.push({ x0, z0, x1: lib.x0 - 4, z1 });
  for (let x = px0 + 6; x < px1 - 4; x += 9.5) {
    for (const z of [z0 + 9, z0 + 17, z1 - 9, z1 - 17]) P.tree(ctx, x + rng.range(-0.6, 0.6), z + rng.range(-0.6, 0.6), rng, 1.25);
  }
  // fountain at the 6th Avenue end
  const fx = px0 + 11, fz = (z0 + z1) / 2;
  const G = ctx.B('flat', fx, fz);
  G.cyl(fx, fz, CURB, CURB + 0.7, 5.2, 5.2, 12, STONE, false);
  G.cyl(fx, fz, CURB + 0.55, CURB + 0.6, 5.0, 0.01, 12, C('#1c4a6a'), false);
  G.cyl(fx, fz, CURB, CURB + 2.4, 0.5, 0.35, 6, STONE);
  G.cyl(fx, fz, CURB + 2.4, CURB + 2.6, 1.7, 1.9, 8, STONE);
  ctx.world.addBox(fx - 4.2, CURB, fz - 4.2, fx + 4.2, CURB + 0.7, fz + 4.2, F_DEFAULT, S_CONCRETE);
  ctx.world.addBox(fx - 0.6, CURB, fz - 0.6, fx + 0.6, CURB + 2.6, fz + 0.6, F_DEFAULT, S_CONCRETE);
  ctx.pool(fx, fz, 12, '#9fd0ff', 0.35);
  // balustrades around the lawn (cover) with gaps
  const lx0 = px0 + 22, lx1 = px1 - 12, lz0 = z0 + 26, lz1 = z1 - 26;
  for (let x = lx0; x < lx1 - 6; x += 16) {
    lowWall(ctx, x, lz0 - 1.2, x + 10, lz0 - 0.7);
    lowWall(ctx, x + 4, lz1 + 0.7, x + 14, lz1 + 1.2);
  }
  // encampment on the lawn: this is one of the hostile strongpoints
  const cx = (lx0 + lx1) / 2, cz = (lz0 + lz1) / 2;
  P.tent(ctx, cx - 14, cz - 6, true);
  P.tent(ctx, cx + 10, cz + 8, true);
  P.sandbags(ctx, cx - 4, cz + 12, true, 4);
  P.sandbags(ctx, cx + 20, cz - 8, false, 4);
  P.sandbags(ctx, cx - 26, cz + 4, false, 4);
  P.crate(ctx, cx + 2, cz - 3, 1.2, 2, 'ammo');
  P.crate(ctx, cx + 3.6, cz - 2.6, 1.2, 1, 'ammo');
  P.crate(ctx, cx - 18, cz + 10, 1.1, 1);
  for (let i = 0; i < 10; i++) P.bench(ctx, lx0 + 6 + i * 11, i % 2 ? lz0 - 5 : lz1 + 5, true);
  for (let x = px0 + 4; x < px1; x += 30) {
    P.lampPost(ctx, x, z0 + 13, 0, 1, '#ffe7b8');
    P.lampPost(ctx, x + 15, z1 - 13, 0, -1, '#ffe7b8');
  }
}

function grandCentral(ctx) {
  const mad = A('MAD'), lex = A('LEX'), park = A('PARK');
  const x0 = mad.x + mad.hw + 12, x1 = lex.x - lex.hw - 12;
  const zS = streetZ(42) - 15 - 4, zN = streetZ(45) + 9 + 4;
  const zMid = zS - 118;
  // terminal hall
  const T0 = { x0, z0: zMid, x1, z1: zS };
  addBuilding(ctx, { ...T0, h: 40, style: 2, tint: [1.18, 1.14, 1.04], shops: 0, noRoof: true, noAds: true, tiers: [[T0.x0, T0.z0, T0.x1, T0.z1, CURB, CURB + 34], [T0.x0 + 30, T0.z0 + 14, T0.x1 - 30, T0.z1 - 14, CURB + 34, CURB + 40]] });
  // three great arched windows facing 42nd Street + clock
  const E = ctx.B('glow', park.x, zS);
  for (const dx of [-46, 0, 46]) {
    E.box(park.x + dx - 13, CURB + 6, zS, park.x + dx + 13, CURB + 27, zS + 0.3, C('#ffcf8a', 0.9), 4);
    E.box(park.x + dx - 9, CURB + 27, zS, park.x + dx + 9, CURB + 30, zS + 0.3, C('#ffcf8a', 0.9), 4);
    ctx.pool(park.x + dx, zS + 12, 16, '#ffcf8a', 0.4);
  }
  const G = ctx.B('flat', park.x, zS);
  G.box(park.x - 9, CURB + 40, zS - 16, park.x + 9, CURB + 46, zS - 10, C('#b9b3a4'), 31);
  E.cyl(park.x, zS - 9.9, CURB + 41, CURB + 41.01, 0, 0, 3, C('#fff'));
  ctx.glow(park.x, CURB + 43, zS - 9.5, '#fff2c0', 4);
  // slab tower straddling Park Avenue behind the terminal
  addBuilding(ctx, { x0: x0 + 34, z0: zN, x1: x1 - 34, z1: zMid, h: 246, style: 1, tint: [0.95, 0.95, 1], shops: 0, noAds: true, tiers: [[x0 + 34, zN, x1 - 34, zMid, CURB, CURB + 246]] });
  // forecourt furniture
  for (let x = x0 + 10; x < x1; x += 28) P.planter(ctx, x, zS + 6, 2.4, 1.4);
  P.sandbags(ctx, park.x - 20, zS + 9, true, 5);
  P.sandbags(ctx, park.x + 22, zS + 9, true, 5);
  P.vehicle(ctx, 'humvee', park.x + 4, zS + 14, Math.PI / 2, ctx.rng);
}

function rockefeller(ctx, blk) {
  const { rng } = ctx;
  const { x0, x1, z0, z1 } = blk;
  // slab tower with setbacks on the 6th Avenue side
  const tx1 = x0 + 104;
  addBuilding(ctx, { x0, z0, x1: tx1, z1, h: 259, style: 2, tint: [1.1, 1.08, 1.0], shops: 15, noAds: true, noRoof: true, tiers: [[x0, z0, tx1, z1, CURB, CURB + 60], [x0 + 8, z0 + 10, tx1 - 8, z1 - 10, CURB + 60, CURB + 190], [x0 + 22, z0 + 16, tx1 - 22, z1 - 16, CURB + 190, CURB + 259]] });
  ctx.glow((x0 + tx1) / 2, CURB + 262, (z0 + z1) / 2, '#ff3030', 3);
  // plaza with the rink
  const px0 = tx1 + 6, px1 = x1 - 46;
  const cz = (z0 + z1) / 2;
  paved(ctx, px0, z0, px1, z1, C('#77736c'));
  const rx0 = px0 + 16, rx1 = px1 - 10, rz0 = cz - 16, rz1 = cz + 16;
  ctx.B('flat', (rx0 + rx1) / 2, cz).floor(rx0, rz0, rx1, rz1, CURB + 0.06, C('#bfd9e6'));
  ctx.pool((rx0 + rx1) / 2, cz, 30, '#bfe6ff', 0.3);
  const t = 0.5;
  lowWall(ctx, rx0 - t, rz0 - t, rx1 + t, rz0);                 // north
  lowWall(ctx, rx0 - t, rz1, rx1 + t, rz1 + t);                 // south
  lowWall(ctx, rx0 - t, rz0, rx0, cz - 4);                      // west, with a gap
  lowWall(ctx, rx0 - t, cz + 4, rx0, rz1);
  lowWall(ctx, rx1, rz0, rx1 + t, cz - 4);
  lowWall(ctx, rx1, cz + 4, rx1 + t, rz1);
  // flags of the world (invented colours) around the rink
  let k = 0;
  for (let x = rx0 - 3; x <= rx1 + 3; x += 7.5) {
    P.flagPole(ctx, x, rz0 - 4, NEON[k++ % NEON.length]);
    P.flagPole(ctx, x, rz1 + 4, NEON[k++ % NEON.length]);
  }
  // gilded statue and the big tree
  const sx = px0 + 9;
  const G = ctx.B('flat', sx, cz);
  G.box(sx - 2.5, CURB, cz - 5, sx + 2.5, CURB + 2.2, cz + 5, C('#3a3a3d'), 31);
  ctx.B('glow', sx, cz).blob(sx, CURB + 3.6, cz, 1.2, 1.4, 2.8, C('#d9a520', 0.9));
  ctx.world.addBox(sx - 2.5, CURB, cz - 5, sx + 2.5, CURB + 4.6, cz + 5, F_DEFAULT, S_CONCRETE);
  const tx = px0 + 2, tz = cz;
  G.cyl(tx, tz, CURB, CURB + 3, 0.6, 0.6, 6, C('#2e241b'));
  G.cyl(tx, tz, CURB + 2.5, CURB + 24, 6.5, 0.2, 10, C('#16402a'), false, C('#2a6b3f'));
  ctx.world.addBox(tx - 1.5, CURB, tz - 1.5, tx + 1.5, CURB + 20, tz + 1.5, F_DEFAULT, S_DIRT);
  for (let i = 0; i < 60; i++) {
    const h = rng.range(3, 22), r = 6.4 * (1 - (h - 2.5) / 21.5) + 0.2, a = rng.next() * 6.283;
    ctx.glow(tx + Math.cos(a) * r, CURB + h, tz + Math.sin(a) * r, rng.pick(NEON), 0.9);
  }
  ctx.glow(tx, CURB + 24.4, tz, '#fff2a0', 4);
  // low buildings framing the channel gardens on the 5th Avenue side
  addBuilding(ctx, { x0: px1 + 4, z0, x1, z1: cz - 7, h: 26, style: 2, tint: [1.1, 1.08, 1.0], shops: 15, noAds: true });
  addBuilding(ctx, { x0: px1 + 4, z0: cz + 7, x1, z1, h: 26, style: 2, tint: [1.1, 1.08, 1.0], shops: 15, noAds: true });
  for (let x = px1 + 8; x < x1 - 2; x += 8) P.planter(ctx, x, cz, 3, 2.2);
  ctx.plazas.push({ x0: px0, z0, x1: px1, z1, kind: 'done' });
}

function arena(ctx) {
  const a8 = A('8'), a7 = A('7');
  const s32 = streetZ(32);
  RAISED_RECTS.push({ x0: a8.x + a8.road, x1: a7.x - a7.road, z0: s32 - 5.2, z1: s32 + 5.2 });
  ctx.B('walk', -140, s32, 3).floor(a8.x + a8.road, s32 - 5.2, a7.x - a7.road, s32 + 5.2, CURB, [1, 1, 1], [0, 0, 60, 3]);
  const cx = -176, cz = s32, r = 62, h = 42;
  const G = ctx.B('flat', cx, cz, 3);
  const conc = C('#8f8a80');
  G.cyl(cx, cz, CURB, CURB + h, r, r, 28, conc, true, mulC(conc, 1.15));
  G.cyl(cx, cz, CURB + h, CURB + h + 5, r * 0.55, r * 0.5, 16, C('#3c3e44'), true);
  const E = ctx.B('glow', cx, cz);
  E.cyl(cx, cz, CURB + 30, CURB + 34, r + 0.2, r + 0.2, 28, C('#2a6bff', 0.8), false);
  for (const [hx, hz] of [[r, r * 0.42], [r * 0.42, r], [r * 0.77, r * 0.77]]) {
    ctx.world.addBox(cx - hx, 0, cz - hz, cx + hx, CURB + h, cz + hz, F_ALL | F_BUILDING, S_CONCRETE);
  }
  ctx.buildings.push({ x0: cx - r * 0.8, z0: cz - r * 0.8, x1: cx + r * 0.8, z1: cz + r * 0.8, h, style: 4, round: r, cx, cz, noAds: true });
  for (let k = 0; k < 8; k++) ctx.pool(cx + Math.cos(k * 0.785) * (r + 6), cz + Math.sin(k * 0.785) * (r + 6), 12, '#6b9bff', 0.35);
  // office tower on the 7th Avenue side
  addBuilding(ctx, { x0: -92, z0: streetZ(33) + 14, x1: -19, z1: streetZ(31) - 14, h: 228, style: 1, tint: [0.9, 0.95, 1.05], shops: 15, noAds: true });
}

// ---------------------------------------------------------------------------
// Times Square
// ---------------------------------------------------------------------------
function timesSquare(ctx) {
  const { rng, world } = ctx;
  const E = (x, z) => ctx.B('glow', x, z);
  const F = (x, z) => ctx.B('flat', x, z);

  // --- One Times Square: the narrow tower closing the south end -----------
  const o = { x0: 19, z0: 171, x1: 41, z1: 221, h: 110 };
  addBuilding(ctx, { ...o, style: 1, tint: [0.8, 0.8, 0.85], shops: 15, noRoof: true, noAds: true, tiers: [[o.x0, o.z0, o.x1, o.z1, CURB, CURB + o.h]] });
  // stacked screens on the north face, tall ads on the long sides
  let y = 12;
  for (const hh of [15, 13, 16, 12, 15, 14]) {
    adPanel(ctx, rng, o.x0 + 0.5, o.z0, o.x1 - 0.5, o.z0, y, y + hh, true);
    y += hh + 1.2;
  }
  for (let yy = 12; yy < 96; yy += 29) {
    adPanel(ctx, rng, o.x1, o.z0 + 1, o.x1, o.z1 - 1, yy, yy + 26);
    adPanel(ctx, rng, o.x0, o.z1 - 1, o.x0, o.z0 + 1, yy, yy + 26);
    adPanel(ctx, rng, o.x1 - 0.5, o.z1, o.x0 + 0.5, o.z1, yy, yy + 26);
  }
  // news ticker wrapping the base
  panel(ctx, 'ticker', o.x0, o.z0, o.x1, o.z0, 7.5, 10, [0, 0, 0.5, 1], 0.5);
  panel(ctx, 'ticker', o.x1, o.z0, o.x1, o.z1, 7.5, 10, [0.5, 0, 1.6, 1], 0.5);
  panel(ctx, 'ticker', o.x0, o.z1, o.x0, o.z0, 7.5, 10, [1.6, 0, 2.7, 1], 0.5);
  // the New Year's ball on its mast
  const bx = (o.x0 + o.x1) / 2, bz = o.z0 + 6, top = CURB + o.h;
  F(bx, bz).box(bx - 0.3, top, bz - 0.3, bx + 0.3, top + 23, bz + 0.3, C('#9aa0aa'), 15);
  E(bx, bz).blob(bx, top + 25, bz, 2.4, 2.4, 2.4, C('#e8f4ff'));
  ctx.glow(bx, top + 25, bz, '#cfe8ff', 9);
  ctx.glow(bx, top + 25, bz, '#ffffff', 4);

  // --- north end: slim hotel tower with its sign stack ---------------------
  const n1 = { x0: -29, z0: -205, x1: -17, z1: -171 }, n2 = { x0: -38, z0: -231, x1: -17, z1: -205 };
  addBuilding(ctx, { ...n1, h: 96, style: 0, tint: [0.85, 0.9, 1], shops: 15, noAds: true, noRoof: true, tiers: [[n1.x0, n1.z0, n1.x1, n1.z1, CURB, CURB + 96]] });
  addBuilding(ctx, { ...n2, h: 112, style: 0, tint: [0.85, 0.9, 1], shops: 15, noAds: true });
  y = 9;
  for (const hh of [10, 13, 9, 14, 11, 12]) {
    adPanel(ctx, rng, n1.x1 - 0.3, n1.z1, n1.x0 + 0.3, n1.z1, y, y + hh, hh > 11);
    y += hh + 1;
  }
  for (let yy = 10; yy < 80; yy += 24) adPanel(ctx, rng, n1.x1, n1.z0, n1.x1, n1.z1, yy, yy + 21);

  // --- the red steps -------------------------------------------------------
  const sx0 = -34, sx1 = -18, sz = -118, run = 1.2, rise = 0.36, steps = 12;
  const red = C('#e0121f'), redHot = C('#ff3b3b');
  const Gs = E(-26, -128);
  for (let i = 0; i < steps; i++) {
    const zf = sz - i * run, zb = sz - (i + 1) * run, yt = CURB + (i + 1) * rise;
    Gs.floor(sx0, zb, sx1, zf, yt, red);
    Gs.wall(sx1, zf, sx0, zf, yt - rise, yt, redHot); // riser faces south
    world.addBox(sx0, CURB, zb, sx1, yt, zf, F_DEFAULT, S_GLASS);
  }
  const topY = CURB + steps * rise, zTop = sz - steps * run, zBack = -141;
  Gs.floor(sx0, zBack, sx1, zTop, topY, red);
  world.addBox(sx0, CURB, zBack, sx1, topY, zTop, F_DEFAULT, S_GLASS);
  // glass sides and the ticket booth wall behind
  Gs.quad([sx0, CURB, sz], [sx0, CURB, zBack], [sx0, topY, zBack], [sx0, topY, zTop], mulC(red, 0.75));
  Gs.quad([sx1, CURB, zBack], [sx1, CURB, sz], [sx1, topY, zTop], [sx1, topY, zBack], mulC(red, 0.75));
  Gs.wall(sx0, zBack, sx1, zBack, CURB, topY, mulC(red, 0.6));
  const tk = ctx.signCells.TKTS;
  ctx.B('signs', -26, zBack).wall(sx0 + 3, zBack - 0.05, sx1 - 3, zBack - 0.05, CURB + 1.3, CURB + 3.6, null, [tk.u0, tk.v0, tk.u1, tk.v1]);
  // railing at the top so that it reads as a platform
  lowWall(ctx, sx0, zBack, sx1, zBack + 0.15, 1.0, C('#5a0a10'));
  for (const [px, pz] of [[-26, -110], [-26, -128], [-40, -126], [-12, -126]]) ctx.pool(px, pz, 13, '#ff2030', 0.42);
  // statue in front of the steps
  F(-26, -104).box(-26.9, CURB, -105, -25.1, CURB + 2.0, -103.2, STONE, 31);
  F(-26, -104).box(-26.35, CURB + 2.0, -104.4, -25.65, CURB + 4.5, -103.8, C('#3d4a44'), 31);
  F(-26, -104).box(-26.15, CURB + 2.0, -105.0, -25.85, CURB + 7.4, -104.7, STONE, 31);
  F(-26, -104).box(-27.0, CURB + 5.6, -105.0, -25.0, CURB + 6.0, -104.7, STONE, 31 | 32);
  world.addBox(-26.9, CURB, -105, -25.1, CURB + 4.5, -103.2, F_DEFAULT, S_CONCRETE);

  // --- police booth in the south plaza -------------------------------------
  {
    const x0 = 22, z0 = 138, x1 = 34, z1 = 145;
    F(28, 141).box(x0, CURB, z0, x1, CURB + 3.4, z1, C('#20242c'), 31, C('#2c3340'));
    E(28, 141).box(x0 - 0.1, CURB + 3.4, z0 - 0.1, x1 + 0.1, CURB + 3.75, z1 + 0.1, C('#2a6bff'), 15);
    E(28, 141).box(x0 + 1, CURB + 1.1, z0 - 0.05, x1 - 1, CURB + 2.6, z0, C('#bfe0ff', 0.8), 8);
    const pc = ctx.signCells.POLICE;
    ctx.B('signs', 28, 141).wall(x0 + 3, z0 - 0.1, x1 - 3, z0 - 0.1, CURB + 2.7, CURB + 3.3, null, [pc.u0, pc.v0, pc.u1, pc.v1]);
    world.addBox(x0, CURB, z0, x1, CURB + 3.75, z1, F_DEFAULT, S_METAL);
    ctx.pool(28, 134, 10, '#3b7bff', 0.5);
    ctx.glow(28, CURB + 3.6, 138, '#3b7bff', 2);
  }

  // --- billboards on every facade that looks onto the bowtie ---------------
  for (const b of ctx.buildings.slice()) {
    if (!b.nearTS || b.noAds || b.h < 14) continue;
    const walls = [[b.x0, b.z0, b.x1, b.z0, 0, -1], [b.x1, b.z0, b.x1, b.z1, 1, 0], [b.x1, b.z1, b.x0, b.z1, 0, 1], [b.x0, b.z1, b.x0, b.z0, -1, 0]];
    for (const [ax, az, bx2, bz2, nx, nz] of walls) {
      const mx = (ax + bx2) / 2, mz = (az + bz2) / 2;
      const len = Math.hypot(bx2 - ax, bz2 - az);
      if (len < 9) continue;
      const axis = broadwayX(mz) * 0.5;
      const toward = (axis - mx) * nx;
      let maxY;
      if (nx !== 0 && toward > 0 && Math.abs(axis - mx) < 78 && mz > -250 && mz < 250) maxY = Math.min(b.h - 3, 58);
      else if (nz !== 0 && Math.abs(mx - axis) < 105 && mz > -250 && mz < 250) maxY = Math.min(b.h - 3, 24);
      else continue;
      // the wall must actually be exposed (not a party wall)
      if (!world.fits(mx + nx * 3, CURB + 6, mz + nz * 3, 1.5, 4)) continue;
      const ux = (bx2 - ax) / len, uz = (bz2 - az) / len;
      let yy = 6.2 + rng.range(0, 1.5);
      while (yy + 6 < maxY) {
        const rowH = Math.min(rng.range(7, 17), maxY - yy);
        let s = rng.range(0.8, 3);
        while (s + 7 < len - 0.8) {
          let w = Math.min(rng.range(8, 24), len - 0.8 - s);
          if (rng.chance(0.14)) { s += w + 1; continue; }
          adPanel(ctx, rng, ax + ux * s, az + uz * s, ax + ux * (s + w), az + uz * (s + w), yy, yy + rowH - 1);
          if (yy < 9 && rng.chance(0.75)) ctx.pool(mx + nx * 9 + ux * (s + w / 2 - len / 2), mz + nz * 9 + uz * (s + w / 2 - len / 2), rng.range(10, 17), rng.pick(NEON), 0.3);
          s += w + rng.range(0.6, 1.6);
        }
        yy += rowH + rng.range(0.4, 1.2);
      }
    }
  }

  // --- plaza furniture along the pedestrianised Broadway -------------------
  for (let z = PLAZA_Z1 - 22; z > PLAZA_Z0 + 12; z -= 11) {
    if (STREETS.some((s) => Math.abs(z - s.z) < s.hw + 2)) continue;
    const bx2 = broadwayX(z);
    const side = z > 0 ? 1 : -1;
    const r = rng.next();
    if (r < 0.3) P.planter(ctx, bx2 + side * rng.range(-5, 5), z, 3.2, 1.3);
    else if (r < 0.55) P.bench(ctx, bx2 + side * rng.range(-5, 5), z, false, 3.4);
    else if (r < 0.7) P.planter(ctx, bx2 - 6, z, 1.4, 1.4);
    else if (r < 0.8) P.trashCan(ctx, bx2 + 6.5, z);
    if (rng.chance(0.5)) P.bollard(ctx, bx2 - 7.2, z + 4);
    if (rng.chance(0.5)) P.bollard(ctx, bx2 + 7.2, z + 4);
  }
  // café tables (red umbrellas) in the south plaza
  for (let i = 0; i < 9; i++) {
    const z = 96 + i * 6.5, x = broadwayX(z) + rng.range(-4.5, 4.5);
    if (STREETS.some((s) => Math.abs(z - s.z) < s.hw + 2)) continue;
    const yy = groundAt(x, z);
    F(x, z).cyl(x, z, yy, yy + 0.75, 0.05, 0.05, 4, C('#2c2e33'), false);
    F(x, z).cyl(x, z, yy + 0.72, yy + 0.76, 0.5, 0.5, 8, C('#c9ccd1'));
    F(x, z).cyl(x, z, yy + 0.75, yy + 2.3, 0.03, 0.03, 4, C('#2c2e33'), false);
    F(x, z).cyl(x, z, yy + 2.1, yy + 2.5, 1.3, 0.05, 8, C('#c8102e'), false, C('#e3243f'));
  }

  // --- battlefield dressing: this is the Team Deathmatch arena -------------
  const v = (kind, x, z, yaw, lights) => P.vehicle(ctx, kind, x, z, yaw, rng, lights);
  // 7th Avenue, south to north
  v('humvee', -4.5, 268, 0.08); v('humvee', 4.2, 281, -0.06); v('truck', -5, 300, 0);
  P.sandbags(ctx, 0, 252, true, 5); P.jerseyBarrier(ctx, -6.5, 246, true); P.jerseyBarrier(ctx, 6.5, 246, true);
  v('taxi', 4.5, 214, 0.2, true); v('sedan', -5.2, 198, Math.PI + 0.1); v('bus', -1.5, 176, 1.32);
  P.jerseyBarrier(ctx, 5.5, 150, true); P.jerseyBarrier(ctx, -5.5, 136, true); v('taxi', -3.5, 122, 0.4);
  P.container(ctx, 5, 104, false, '#1f5aa6'); v('police', -5.6, 92, 0.1, true); P.crate(ctx, 1.5, 100, 1.2, 2);
  v('suv', 3.2, 62, Math.PI - 0.3); P.sandbags(ctx, -4, 50, true, 4.5); P.jerseyBarrier(ctx, 4.5, 38, true);
  v('taxi', -5.4, 22, 0); v('van', 4.8, 12, 0.15); P.crate(ctx, -1, 8, 1.1, 1);
  P.jerseyBarrier(ctx, -2, -14, true, 4); P.jerseyBarrier(ctx, 4.5, -22, true); v('wreck', -4.6, -34, 0.6);
  ctx.emitters.push({ x: -4.6, y: 1.2, z: -34, kind: 'fire' });
  ctx.pool(-4.6, -34, 9, '#ff7a1a', 0.6);
  P.container(ctx, -5.2, -58, false, '#a33a1f'); v('taxi', 4.4, -52, Math.PI + 0.2); P.sandbags(ctx, 3.5, -72, true, 4.5);
  v('bus', 2.2, -98, -1.25); v('sedan', -5.5, -112, 0); P.jerseyBarrier(ctx, -5.5, -128, true); P.jerseyBarrier(ctx, 5.5, -140, true);
  v('police', 5.2, -168, Math.PI, true); v('suv', -4.6, -186, 0.25); P.crate(ctx, 0.5, -178, 1.2, 2, 'ammo');
  v('truck', 4.6, -222, Math.PI); P.sandbags(ctx, -2, -246, true, 5); v('van', -5.2, -262, Math.PI); v('humvee', 4.8, -282, Math.PI + 0.1);
  P.jerseyBarrier(ctx, -6.5, -240, true); P.jerseyBarrier(ctx, 6.5, -240, true);
  // plazas
  P.sandbags(ctx, 30, 118, false, 4); P.crate(ctx, 36, 104, 1.2, 2); P.container(ctx, 22, 78, false, '#2a7a4a');
  P.sandbags(ctx, 14, 44, false, 4); P.crate(ctx, 18, 24, 1.1, 1); P.jerseyBarrier(ctx, 12.5, 60, false, 4);
  P.sandbags(ctx, -14, -44, false, 4); P.crate(ctx, -17, -62, 1.2, 2, 'ammo'); P.jerseyBarrier(ctx, -13, -30, false, 4);
  P.container(ctx, -33, -90, true, '#c9a227'); P.sandbags(ctx, -40, -150, true, 4.5);
  // cross streets get a few abandoned cars each
  for (const n of [43, 44, 45, 46, 47]) {
    const z = streetZ(n);
    for (const x of [-150, -92, -52, 62, 104, 160, 220]) {
      if (Math.abs(x - broadwayX(z)) < 17 || rng.chance(0.3)) continue;
      v(rng.pick(['sedan', 'taxi', 'taxi', 'suv', 'van']), x + rng.range(-8, 8), z + rng.pick([-2.4, 2.4]), rng.pick([-1, 1]) * Math.PI / 2 + rng.range(-0.15, 0.15), rng.chance(0.3));
    }
  }
  // 42nd Street: theatre marquees
  for (const b of ctx.buildings) {
    if (b.noAds || b.h < 12) continue;
    const onDeuce = Math.abs(b.z0 - (streetZ(42) + 15)) < 0.5 || Math.abs(b.z1 - (streetZ(42) - 15)) < 0.5;
    const side = Math.abs(b.z0 - (streetZ(42) + 15)) < 0.5 ? -1 : 1; // -1: building south of the street, faces north
    const theatreRow = (Math.abs(b.z1 - (streetZ(44) - 9)) < 0.5 || Math.abs(b.z0 - (streetZ(44) + 9)) < 0.5 || Math.abs(b.z1 - (streetZ(46) - 9)) < 0.5 || Math.abs(b.z0 - (streetZ(46) + 9)) < 0.5);
    const cx = (b.x0 + b.x1) / 2;
    if (cx < -265 || cx > 265 || b.x1 - b.x0 < 14) continue;
    if (!(onDeuce || theatreRow) || !rng.chance(onDeuce ? 0.75 : 0.5)) continue;
    let zf, dir;
    if (onDeuce) { zf = side < 0 ? b.z0 : b.z1; dir = side < 0 ? -1 : 1; }
    else if (Math.abs(b.z1 - (streetZ(44) - 9)) < 0.5 || Math.abs(b.z1 - (streetZ(46) - 9)) < 0.5) { zf = b.z1; dir = 1; }
    else { zf = b.z0; dir = -1; }
    marquee(ctx, cx, zf, dir, Math.min(13, b.x1 - b.x0 - 3), rng);
  }
}

/** Theatre canopy with a lit underside and a vertical blade sign. */
function marquee(ctx, x, z, dir, w, rng) {
  const y0 = CURB + 4.7, col = rng.pick(NEON);
  const z0 = dir > 0 ? z : z - 3.2, z1 = dir > 0 ? z + 3.2 : z;
  const G = ctx.B('flat', x, z), E = ctx.B('glow', x, z);
  G.box(x - w / 2, y0, z0, x + w / 2, y0 + 1.5, z1, C('#17181c'), 31);
  E.quad([x - w / 2 + 0.2, y0 - 0.02, z0 + 0.2], [x + w / 2 - 0.2, y0 - 0.02, z0 + 0.2], [x + w / 2 - 0.2, y0 - 0.02, z1 - 0.2], [x - w / 2 + 0.2, y0 - 0.02, z1 - 0.2], C('#ffe2a0', 0.95));
  const zf = dir > 0 ? z1 + 0.03 : z0 - 0.03;
  const c = rng.pick(AD_LAND);
  const uv = [c.u0, c.v0 + 0.06, c.u1, c.v1 - 0.06];
  if (dir > 0) ctx.B('ads', x, z).wall(x + w / 2, zf, x - w / 2, zf, y0 + 0.1, y0 + 1.4, null, uv);
  else ctx.B('ads', x, z).wall(x - w / 2, zf, x + w / 2, zf, y0 + 0.1, y0 + 1.4, null, uv);
  // blade sign
  const bx = x + rng.pick([-1, 1]) * (w / 2 - 0.8);
  const bz0 = dir > 0 ? z + 0.1 : z - 1.5, bz1 = dir > 0 ? z + 1.5 : z - 0.1;
  E.box(bx - 0.18, y0 + 2, bz0, bx + 0.18, y0 + 12, bz1, C(col, 0.95), 3);
  G.box(bx - 0.14, y0 + 1.8, bz0 - 0.1, bx + 0.14, y0 + 12.2, bz1 + 0.1, C('#101114'), 12 | 16);
  ctx.pool(x, z + dir * 3, 9, '#ffe2a0', 0.5);
  ctx.glow(bx, y0 + 7, (bz0 + bz1) / 2, col, 2);
}

// ---------------------------------------------------------------------------
export function buildLandmarks(ctx) {
  const { rng, world } = ctx;
  timesSquare(ctx);

  // --- Columbus Circle ------------------------------------------------------
  {
    const c = LANDMARKS.columbusCircle;
    RAISED_CIRCLES.push({ x: c.x, z: c.z, r: 11 });
    const G = ctx.B('flat', c.x, c.z);
    G.cyl(c.x, c.z, 0, CURB, 11, 11, 20, STONE, true, C('#9a958a'));
    G.cyl(c.x, c.z, CURB, CURB + 0.8, 6, 5.6, 12, STONE, true);
    G.cyl(c.x, c.z, CURB + 0.8, CURB + 21, 0.9, 0.7, 8, C('#b9b3a4'), true);
    G.box(c.x - 0.5, CURB + 21, c.z - 0.5, c.x + 0.5, CURB + 24.5, c.z + 0.5, C('#c9c3b4'), 31);
    world.addBox(c.x - 4.2, CURB, c.z - 4.2, c.x + 4.2, CURB + 0.8, c.z + 4.2, F_DEFAULT, S_CONCRETE);
    world.addBox(c.x - 0.9, CURB, c.z - 0.9, c.x + 0.9, CURB + 24, c.z + 0.9, F_DEFAULT, S_CONCRETE);
    for (let k = 0; k < 6; k++) ctx.pool(c.x + Math.cos(k * 1.047) * 8, c.z + Math.sin(k * 1.047) * 8, 9, '#ffe7b8', 0.4);
    ctx.glow(c.x, CURB + 25, c.z, '#fff2c0', 3);
    ctx.plazas.push({ x0: c.x - 11, z0: c.z - 11, x1: c.x + 11, z1: c.z + 11, kind: 'done' });
  }

  // --- Central Park's southern edge ----------------------------------------
  {
    const z0 = -HALF - 320, z1 = STREETS[0].z - STREETS[0].hw - 1.2;
    ctx.B('flat', 0, z1 - 40, 1).floor(-HALF - 200, z0, HALF + 200, z1, CURB + 0.03, LAWN);
    ctx.parks.push({ x0: -HALF, z0: -HALF, x1: HALF, z1 });
    // the stone wall marks the edge of the playable area
    const wz = -HALF + 1.5;
    ctx.B('flat', 0, wz, 3).box(-HALF, CURB, wz - 0.4, HALF, CURB + 1.5, wz, STONE, 31, mulC(STONE, 1.2));
    world.addBox(-HALF, 0, wz - 3, HALF, 6, wz, F_SOLID | F_BULLET | F_CAMERA, S_CONCRETE);
    for (let x = -HALF + 8; x < HALF - 8; x += rng.range(9, 16)) P.tree(ctx, x, z1 - rng.range(2.5, 8), rng, 1.3);
    for (let i = 0; i < 260; i++) {
      const x = rng.range(-HALF - 150, HALF + 150), z = rng.range(z0 + 20, wz - 6);
      const y = CURB, G = ctx.B('flat', clamp(x, -HALF, HALF), -HALF + 5);
      const h = rng.range(5, 9), r = rng.range(3, 5.5);
      const g1 = C(rng.pick(['#1f4a2a', '#24552f', '#1b4226']));
      G.box(x - 0.2, y, z - 0.2, x + 0.2, y + h, z + 0.2, C('#2e241b'), 15);
      G.blob(x, y + h + r * 0.5, z, r, r, r, g1, mulC(g1, 1.5));
    }
    for (let x = -HALF + 30; x < HALF; x += 64) P.lampPost(ctx, x, z1 - 5, 0, 1, '#ffe7b8');
  }

  // --- Hudson River along the western edge ---------------------------------
  {
    const x1 = -HALF - 8;
    ctx.B('flat', x1 - 200, 0, 1).floor(-HALF - 900, -HALF - 300, x1, HALF + 300, CURB + 0.02, WATER);
    const fx = -HALF + 1.2;
    for (let z = -HALF; z < HALF; z += 3.05) ctx.B('flat', fx, z).taper([fx - 0.3, z, fx + 0.3, z + 3], CURB, [fx - 0.1, z, fx + 0.1, z + 3], CURB + 0.95, C('#9a9892'), true);
    world.addBox(fx - 3, 0, -HALF, fx + 0.3, 6, HALF, F_SOLID | F_BULLET | F_CAMERA, S_CONCRETE);
    // piers and the far shore
    for (let z = -HALF + 120; z < HALF; z += 230) {
      const G = ctx.B('flat', -HALF, z);
      G.box(x1 - 150, CURB, z - 14, x1, CURB + 0.6, z + 14, C('#5c5a55'), 31);
      G.box(x1 - 130, CURB + 0.6, z - 11, x1 - 20, CURB + 9, z + 11, C('#39424d'), 31, C('#4a5563'));
      ctx.glow(x1 - 150, CURB + 3, z, '#ff3030', 2);
    }
    const shore = new RNG(909);
    for (let z = -HALF - 250; z < HALF + 250; z += shore.range(24, 60)) {
      const w = shore.range(20, 50), h = shore.range(18, 110), x = -HALF - 860 + shore.range(-30, 30);
      const G = ctx.B('flat', -HALF, clamp(z, -HALF, HALF), 1);
      G.box(x, 0, z, x + 40, h, z + w, C('#141a26'), 31);
      for (let k = 0; k < 5; k++) ctx.glow(x + 41, shore.range(4, h), z + shore.range(1, w - 1), shore.pick(['#ffd9a0', '#cfe6ff', '#ffd9a0']), 2.5);
    }
  }

  // --- Park Avenue median ---------------------------------------------------
  {
    const a = A('PARK');
    for (let i = 0; i < STREETS.length - 1; i++) {
      const z0 = STREETS[i].z + STREETS[i].hw + 4, z1 = STREETS[i + 1].z - STREETS[i + 1].hw - 4;
      const zc = (z0 + z1) / 2;
      if (zc > 0 && zc < 240) continue; // Grand Central sits here
      const G = ctx.B('flat', a.x, zc);
      G.box(a.x - 2.2, 0, z0, a.x + 2.2, 0.42, z1, C('#6f6e6a'), 31);
      G.floor(a.x - 1.9, z0 + 0.3, a.x + 1.9, z1 - 0.3, 0.44, LAWN2);
      world.addBox(a.x - 2.2, 0, z0, a.x + 2.2, 0.42, z1, F_SOLID | F_BULLET, S_CONCRETE);
      for (let z = z0 + 5; z < z1 - 3; z += 12) G.blob(a.x, 1.15, z, 1.3, 0.8, 1.3, C('#1e4a2b'), C('#2f6b3c'));
    }
  }

  // --- empty lots: parking, pocket plazas, construction sites ---------------
  for (const p of ctx.plazas) {
    const w = p.x1 - p.x0, d = p.z1 - p.z0, cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2;
    if (p.kind === 'parking') {
      paved(ctx, p.x0 + 0.5, p.z0 + 0.5, p.x1 - 0.5, p.z1 - 0.5, C('#3b3d42'));
      for (let x = p.x0 + 3; x < p.x1 - 3; x += 3.1) {
        for (let z = p.z0 + 5; z < p.z1 - 4; z += 12) {
          if (rng.chance(0.3)) P.vehicle(ctx, rng.pick(['sedan', 'sedan', 'suv', 'taxi']), x, z, rng.pick([0, Math.PI]), rng);
        }
      }
      P.lampPost(ctx, cx, cz, 1, 0, '#cfe6ff');
    } else if (p.kind === 'plaza') {
      paved(ctx, p.x0 + 0.5, p.z0 + 0.5, p.x1 - 0.5, p.z1 - 0.5, C('#7d7a74'));
      lawn(ctx, cx - w * 0.25, cz - d * 0.2, cx + w * 0.25, cz + d * 0.2, LAWN2);
      for (let k = 0; k < 4; k++) P.tree(ctx, cx + (k % 2 ? 1 : -1) * w * 0.3, cz + (k < 2 ? 1 : -1) * d * 0.3, rng);
      P.bench(ctx, cx, cz - d * 0.2 - 2, true);
      P.bench(ctx, cx, cz + d * 0.2 + 2, true);
      P.lampPost(ctx, cx - w * 0.3, cz, 1, 0, '#ffe7b8');
    } else if (p.kind === 'site') {
      paved(ctx, p.x0 + 0.5, p.z0 + 0.5, p.x1 - 0.5, p.z1 - 0.5, C('#5d5648'));
      const cols = ['#1f5aa6', '#a33a1f', '#2a7a4a', '#c9a227', '#6a6e75'];
      for (let k = 0; k < Math.min(5, Math.floor(w / 5)); k++) {
        if (rng.chance(0.7)) P.container(ctx, p.x0 + 3 + k * (w - 6) / Math.max(1, Math.min(5, Math.floor(w / 5))), cz + rng.range(-d * 0.3, d * 0.3), false, rng.pick(cols));
      }
      for (let k = 0; k < 5; k++) P.crate(ctx, rng.range(p.x0 + 2, p.x1 - 2), rng.range(p.z0 + 2, p.z1 - 2), 1.2, rng.int(1, 2));
      // steel frame of the unfinished building
      const G = ctx.B('flat', cx, cz);
      const steel = C('#7a3b22');
      for (let k = 0; k < 3; k++) for (const sx of [p.x0 + 2, p.x1 - 2]) G.box(sx - 0.25, CURB, p.z0 + 3 + k * (d - 6) / 2 - 0.25, sx + 0.25, CURB + 18, p.z0 + 3 + k * (d - 6) / 2 + 0.25, steel, 15);
      for (const yy of [6, 12, 18]) G.box(p.x0 + 2, CURB + yy - 0.3, p.z0 + 2.7, p.x1 - 2, CURB + yy, p.z1 - 2.7, steel, 31 | 32);
      ctx.glow(cx, CURB + 19, cz, '#ffb21a', 2);
    }
  }
}

// ---------------------------------------------------------------------------
// Lamps, signals, vehicles and sidewalk clutter for the whole grid
// ---------------------------------------------------------------------------
export function populateStreets(ctx) {
  const { rng, world } = ctx;
  const free = (x, z, r = 0.6) => world.fits(x, groundAt(x, z), z, r, 2.2);
  const nearStreet = (z, pad) => STREETS.some((s) => Math.abs(z - s.z) < s.hw + pad);
  const nearAvenue = (x, pad) => AVENUES.some((a) => Math.abs(x - a.x) < a.hw + pad);
  const onBroadway = (x, z, pad = 16) => Math.abs(x - broadwayX(z)) < pad;
  const density = (x, z) => {
    const d = Math.hypot(x - 10, z - 20);
    return d < 420 ? 0.15 : d < 800 ? 0.075 : 0.04;
  };
  const kinds = ['sedan', 'sedan', 'sedan', 'sedan', 'taxi', 'taxi', 'suv', 'suv', 'van', 'police', 'truck', 'humvee'];
  const arena = (x, z) => Math.abs(x) < 12 && z > -300 && z < 310; // dressed by hand

  // street lamps
  let alt = 0;
  for (const a of AVENUES) {
    for (let z = -HALF + 22; z < HALF - 10; z += 46) {
      if (nearStreet(z, 4)) continue;
      const side = alt++ % 2 ? 1 : -1;
      const x = a.x + side * (a.road + 1.1);
      if (free(x, z)) P.lampPost(ctx, x, z, -side, 0);
    }
  }
  for (const s of STREETS) {
    for (let x = -HALF + 40; x < HALF - 10; x += 58) {
      if (nearAvenue(x, 4) || onBroadway(x, s.z, 14)) continue;
      const side = alt++ % 2 ? 1 : -1;
      const z = s.z + side * (s.road + 0.9);
      if (free(x, z)) P.lampPost(ctx, x, z, 0, -side, s.major ? '#ffe7b8' : '#ffd9a0');
    }
  }
  // Broadway gets its own lamps outside the plaza
  for (let z = -HALF + 30; z < HALF - 20; z += 52) {
    if (z > PLAZA_Z0 - 10 && z < PLAZA_Z1 + 10) continue;
    if (nearStreet(z, 4)) continue;
    const x = broadwayX(z) + (alt++ % 2 ? 9.2 : -9.2);
    if (nearAvenue(x, 2) || !free(x, z)) continue;
    P.lampPost(ctx, x, z, x > broadwayX(z) ? -1 : 1, 0);
  }

  // signals + street-name blades at every intersection
  for (const a of AVENUES) {
    for (const s of STREETS) {
      const sLabel = `${a.x < 560 ? 'W' : 'E'} ${s.n} St`;
      const aLabel = a.name.replace(' AV', ' Av').replace('MADISON', 'Madison').replace('PARK', 'Park').replace('LEXINGTON', 'Lexington');
      const x1 = a.x + a.road + 0.9, z1 = s.z - s.road - 0.9;
      const x2 = a.x - a.road - 0.9, z2 = s.z + s.road + 0.9;
      const green = rng.chance(0.5);
      if (free(x1, z1)) P.trafficLight(ctx, x1, z1, -1, 0, green, [sLabel, aLabel]);
      if (free(x2, z2)) P.trafficLight(ctx, x2, z2, 1, 0, green, [sLabel, aLabel]);
    }
  }

  // parked and abandoned vehicles
  for (const s of STREETS) {
    for (let i = 0; i < AVENUES.length - 1; i++) {
      const x0 = AVENUES[i].x + AVENUES[i].hw + 7, x1 = AVENUES[i + 1].x - AVENUES[i + 1].hw - 7;
      for (const side of [-1, 1]) {
        const z = s.z + side * (s.road - 1.25);
        for (let x = x0; x < x1; x += 6.4) {
          if (!rng.chance(density(x, z)) || onBroadway(x, z) || arena(x, z)) continue;
          if (!free(x, z, 2.6)) continue;
          P.vehicle(ctx, rng.pick(kinds), x, z, (side > 0 ? -1 : 1) * Math.PI / 2 + rng.range(-0.04, 0.04), rng, rng.chance(0.12));
        }
      }
      // something left in the roadway
      if (rng.chance(s.major ? 0.8 : 0.3)) {
        const x = rng.range(x0 + 10, x1 - 10), z = s.z + rng.range(-1.5, 1.5) * (s.major ? 3 : 0.6);
        if (!onBroadway(x, z) && free(x, z, 4)) P.vehicle(ctx, rng.pick(s.major ? ['bus', 'truck', 'taxi', 'sedan', 'police'] : ['sedan', 'taxi', 'van']), x, z, rng.pick([-1, 1]) * Math.PI / 2 + rng.range(-0.35, 0.35), rng, rng.chance(0.3));
      }
    }
  }
  for (const a of AVENUES) {
    for (let i = 0; i < STREETS.length - 1; i++) {
      const z0 = STREETS[i].z + STREETS[i].hw + 7, z1 = STREETS[i + 1].z - STREETS[i + 1].hw - 7;
      for (const side of [-1, 1]) {
        const x = a.x + side * (a.road - 1.25);
        for (let z = z0; z < z1; z += 6.6) {
          if (!rng.chance(density(x, z) * 0.9) || onBroadway(x, z) || arena(x, z)) continue;
          if (!free(x, z, 2.6)) continue;
          P.vehicle(ctx, rng.pick(kinds), x, z, (side > 0 ? 0 : Math.PI) + rng.range(-0.04, 0.04), rng, rng.chance(0.12));
        }
      }
      const n = rng.chance(0.55) ? (rng.chance(0.3) ? 2 : 1) : 0;
      for (let k = 0; k < n; k++) {
        const z = rng.range(z0 + 6, z1 - 6), x = a.x + rng.range(-1, 1) * (a.road - 4.5);
        if (onBroadway(x, z) || arena(x, z) || !free(x, z, 6.5)) continue;
        P.vehicle(ctx, rng.pick(['bus', 'taxi', 'taxi', 'sedan', 'suv', 'truck', 'police', 'van']), x, z, rng.pick([0, Math.PI]) + rng.range(-0.3, 0.3), rng, rng.chance(0.3));
      }
    }
  }

  // burning wrecks: beacons of smoke that help with orientation
  const wrecks = new RNG(4242);
  for (let i = 0; i < 16; i++) {
    const a = wrecks.pick(AVENUES), s = wrecks.pick(STREETS);
    const x = a.x + wrecks.range(-4, 4), z = s.z + wrecks.range(18, 60) * wrecks.sign();
    if (Math.abs(z) > HALF - 30 || arena(x, z) || !free(x, z, 3.5)) continue;
    P.vehicle(ctx, 'wreck', x, z, wrecks.range(0, 6.28), wrecks);
    ctx.emitters.push({ x, y: groundAt(x, z) + 1.2, z, kind: 'fire' });
    ctx.pool(x, z, 9, '#ff7a1a', 0.6);
  }

  // sidewalk clutter
  for (const s of STREETS) {
    for (let i = 0; i < AVENUES.length - 1; i++) {
      const x0 = AVENUES[i].x + AVENUES[i].hw + 4, x1 = AVENUES[i + 1].x - AVENUES[i + 1].hw - 4;
      const residential = AVENUES[i].x < -300;
      for (const side of [-1, 1]) {
        const zc = s.z + side * (s.road + 0.9);
        const put = (fn, x, ...args) => { if (!onBroadway(x, zc, 12) && free(x, zc, 0.5)) fn(ctx, x, zc, ...args); };
        put(P.hydrant, rng.range(x0, x1));
        if (rng.chance(0.5)) put(P.trashCan, x0 + 1.5);
        if (rng.chance(0.25)) put(P.mailbox, x1 - 2);
        const treeP = residential ? 0.22 : 0.05;
        for (let x = x0 + 8; x < x1 - 8; x += 14) if (rng.chance(treeP)) put(P.tree, x + rng.range(-2, 2), rng);
        if (rng.chance(0.09)) {
          const sx = rng.range(x0 + 5, x1 - 45), len = rng.range(18, 38);
          const zb = s.z + side * s.hw;
          if (!onBroadway(sx + len / 2, zb, 40)) P.scaffold(ctx, sx, Math.min(zb, zb - side * 3), sx + len, Math.max(zb, zb - side * 3));
        }
      }
    }
  }
  for (const a of AVENUES) {
    for (let i = 0; i < STREETS.length - 1; i++) {
      const z0 = STREETS[i].z + STREETS[i].hw + 5, z1 = STREETS[i + 1].z - STREETS[i + 1].hw - 5;
      for (const side of [-1, 1]) {
        const xc = a.x + side * (a.road + 1.0);
        const zc = (z0 + z1) / 2;
        if (rng.chance(0.5) && free(xc, z0 + 1, 0.5) && !onBroadway(xc, z0, 12)) P.trashCan(ctx, xc, z0 + 1);
        if (rng.chance(0.1) && free(xc + side * 2.2, zc, 2.4) && !onBroadway(xc, zc, 14)) P.newsstand(ctx, xc + side * 1.6, zc + rng.range(-10, 10), false);
        if (rng.chance(0.12)) for (let z = z0 + 6; z < z1 - 4; z += 13) if (free(xc, z, 0.5) && !onBroadway(xc, z, 12)) P.tree(ctx, xc, z, rng, 0.9);
      }
    }
  }

  // roadblocks at random intersections
  const rb = new RNG(777);
  for (let i = 0; i < 34; i++) {
    const a = rb.pick(AVENUES), s = rb.pick(STREETS);
    if (arena(a.x, s.z)) continue;
    const along = rb.chance(0.5);
    if (along) {
      const z = s.z + rb.sign() * (s.hw + rb.range(6, 20));
      for (let x = a.x - a.road + 1.5; x < a.x + a.road - 1; x += 3.3) if (rb.chance(0.7) && free(x, z, 1.8)) P.jerseyBarrier(ctx, x, z, true);
      if (free(a.x + 2, z + 3, 2)) P.sandbags(ctx, a.x + rb.range(-5, 5), z + 3.2, true, 4);
    } else {
      const x = a.x + rb.sign() * (a.hw + rb.range(8, 26));
      for (let z = s.z - s.road + 1.5; z < s.z + s.road - 1; z += 3.3) if (rb.chance(0.75) && free(x, z, 1.8)) P.jerseyBarrier(ctx, x, z, false);
    }
    if (rb.chance(0.4)) {
      const cx = a.x + rb.sign() * (a.road + 2.5), cz = s.z + rb.sign() * (s.hw + 3);
      if (free(cx, cz, 1.2)) P.crate(ctx, cx, cz, 1.2, rb.int(1, 2), rb.chance(0.5) ? 'ammo' : 'wood');
    }
  }

  // sector strongpoints (besides the hand-built ones)
  const strong = (l, list) => {
    for (const [fn, dx, dz, ...args] of list) {
      const x = l.x + dx, z = l.z + dz;
      if (free(x, z, 2.2)) fn(ctx, x, z, ...args);
    }
  };
  strong(LANDMARKS.heraldSquare, [[P.sandbags, -14, -8, true, 5], [P.sandbags, 12, 10, false, 5], [P.container, -4, 16, true, '#1f5aa6'], [P.crate, 6, -6, 1.2, 2, 'ammo'], [P.tent, 20, -16, true], [P.jerseyBarrier, -8, 4, false, 4]]);
  strong(LANDMARKS.hudsonYards, [[P.container, -10, -6, false, '#a33a1f'], [P.container, -6, -6, false, '#2a7a4a'], [P.sandbags, 8, 8, true, 5], [P.sandbags, -16, 12, false, 5], [P.crate, 4, -10, 1.2, 2, 'ammo'], [P.tent, 16, -12, false], [P.container, 10, 20, true, '#c9a227']]);
  strong(LANDMARKS.hellsKitchen, [[P.sandbags, -6, -4, true, 5], [P.sandbags, 10, 6, false, 4], [P.crate, -2, 8, 1.2, 2], [P.container, 14, -8, false, '#6a6e75'], [P.jerseyBarrier, -12, 6, false, 4], [P.tent, -16, -14, true]]);
  strong(LANDMARKS.columbusCircle, [[P.sandbags, -16, 14, true, 5], [P.sandbags, 16, 12, false, 5], [P.crate, -14, -14, 1.2, 2, 'ammo'], [P.jerseyBarrier, 15, -16, true, 4], [P.container, -22, 2, false, '#1f5aa6']]);
  strong(LANDMARKS.parkAvenue, [[P.sandbags, -8, -10, true, 5], [P.sandbags, 9, 12, true, 5], [P.container, -9, 18, false, '#2a7a4a'], [P.crate, 8, -6, 1.2, 2, 'ammo'], [P.tent, -22, -4, false], [P.jerseyBarrier, 10, 2, false, 4]]);
  strong(LANDMARKS.pennPlaza, [[P.sandbags, 132, -66, true, 5], [P.container, 146, -40, false, '#a33a1f'], [P.crate, 138, -52, 1.2, 2, 'ammo'], [P.sandbags, 150, -20, false, 5]]);

  // subway entrances = fast-travel stations
  const st = (name, aid, n, sx, sz) => {
    const a = A(aid), z = streetZ(n), s = STREETS.find((q) => q.n === n);
    const x = a.x + sx * (a.road + 1.9), zz = z + sz * (s.hw + 6.5);
    P.subwayEntrance(ctx, x, zz, false, name);
  };
  st('TIMES SQ – 42 ST', '7', 42, -1, -1);
  st('BRYANT PARK', '6', 42, 1, -1);
  st('GRAND CENTRAL', 'LEX', 42, -1, 1);
  st('ROCKEFELLER CTR', '6', 49, 1, 1);
  st('COLUMBUS CIRCLE', '8', 58, 1, 1);
  st('HERALD SQ – 34 ST', '6', 34, -1, 1);
  st('HUDSON YARDS', '11', 34, 1, 1);
  st("HELL'S KITCHEN – 50 ST", '9', 50, 1, -1);
  st('PENN STATION', '7', 33, 1, 1);
  st('PARK AV – 53 ST', 'LEX', 53, -1, -1);
  st('5 AV – 59 ST', '5', 59, -1, 1);
  st('10 AV – 41 ST', '10', 41, 1, -1);
}
