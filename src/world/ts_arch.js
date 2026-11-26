// Times Square hero architecture, structural billboard rigs, and neon dressing.
import { clamp } from '../core/util.js';
import { C, mulC } from './geo.js';
import { CURB, broadwayX } from './layout.js';
import { F_DEFAULT, F_ALL, F_BUILDING, S_CONCRETE, S_GLASS, S_METAL } from '../core/physics.js';
import { AD_LAND, AD_PORT, AD_PALETTES, SHOP_COLS, SHOP_ROWS, FACADES } from './textures.js';
import { addBuilding } from './city.js';
import { hash2 } from './plants.js';

const ANIM_UV = [0.004, 0.004, 0.246, 0.246];
const TRUSS_DARK = C('#15171c');
const TRUSS_STEEL = C('#262a33');
const TRUSS_TRIM = C('#3b404c');
const STONE_BASE = C('#6a665f');
const BRONZE = C('#3a3e38');

/** Helper: draw a box aligned to an outward wall tangent `(ux, uz)` & normal `(nx, nz)`. */
function wallPrism(G, ax, az, bx, bz, y0, y1, offIn, offOut, col, cTop) {
  const len = Math.max(0.01, Math.hypot(bx - ax, bz - az));
  const nx = (bz - az) / len, nz = -(bx - ax) / len;
  const p0x = ax + nx * offIn, p0z = az + nz * offIn;
  const p1x = bx + nx * offIn, p1z = bz + nz * offIn;
  const q0x = ax + nx * offOut, q0z = az + nz * offOut;
  const q1x = bx + nx * offOut, q1z = bz + nz * offOut;
  // Front (+n), back (-n), right side (B end), left side (A end), top
  G.wall(q0x, q0z, q1x, q1z, y0, y1, col, null, cTop);
  G.wall(p1x, p1z, p0x, p0z, y0, y1, mulC(col, 0.72));
  G.wall(q1x, q1z, p1x, p1z, y0, y1, mulC(col, 0.85));
  G.wall(p0x, p0z, q0x, q0z, y0, y1, mulC(col, 0.85));
  G.quad([p0x, y1, p0z], [q0x, y1, q0z], [q1x, y1, q1z], [p1x, y1, p1z], cTop || mulC(col, 1.15));
  G.quad([q0x, y0, q0z], [p0x, y0, p0z], [p1x, y0, p1z], [q1x, y0, q1z], mulC(col, 0.55));
}

function addScreenLight(ctx, mx, mz, nx, nz, w, h, y0, col) {
  if (!ctx.light || y0 >= 52 || w <= 4.0) return;
  const hAtten = clamp(1.10 - y0 / 48, 0.14, 1.0);
  const rad = clamp(Math.sqrt(w * h) * 0.95 + 4, 8, 17);
  const pushOut = clamp(4.0 + y0 * 0.16, 4.0, 10.5);
  const str = clamp(Math.sqrt(w * h) * 0.0175 * hAtten, 0.08, 0.32);
  ctx.light(mx + nx * pushOut, mz + nz * pushOut, rad, col, str);
}

/**
 * Framed billboard mounted proud of a facade on dark-steel struts, with optional
 * bottom maintenance catwalk or vinyl gooseneck lamps. Returns the chosen ad index.
 */
export function framedBillboard(ctx, rng, ax, az, bx, bz, y0, y1, opts = {}) {
  const len = Math.hypot(bx - ax, bz - az);
  const h = y1 - y0;
  if (len < 2 || h < 2) return opts.avoidIdx ?? -1;
  const ux = (bx - ax) / len, uz = (bz - az) / len;
  const nx = uz, nz = -ux;
  const mx = (ax + bx) / 2, mz = (az + bz) / 2;
  const out = opts.out ?? 0.92;
  const cabDepth = opts.cabDepth ?? 0.44;
  const back = Math.max(0.14, out - cabDepth);
  const rim = clamp(Math.min(len, h) * 0.025, 0.14, 0.28);

  const F = ctx.B('flat', mx, mz);
  F.setRM(0.42, 0.75);
  // Steel backing cabinet projecting proud of the facade
  wallPrism(F, ax - ux * rim, az - uz * rim, bx + ux * rim, bz + uz * rim, y0 - rim, y1 + rim, back, out - 0.03, TRUSS_DARK, TRUSS_TRIM);
  // Top & bottom projecting steel frame channels
  wallPrism(F, ax - ux * (rim + 0.06), az - uz * (rim + 0.06), bx + ux * (rim + 0.06), bz + uz * (rim + 0.06),
    y1, y1 + rim + 0.08, out - 0.18, out + 0.08, TRUSS_STEEL, TRUSS_TRIM);
  wallPrism(F, ax - ux * (rim + 0.06), az - uz * (rim + 0.06), bx + ux * (rim + 0.06), bz + uz * (rim + 0.06),
    y0 - rim - 0.08, y0, out - 0.18, out + 0.08, TRUSS_STEEL, TRUSS_TRIM);

  // Horizontal mounting struts tying the cabinet back into the facade
  const strutCols = len >= 14 ? 3 : 2;
  for (let i = 0; i < strutCols; i++) {
    const t = strutCols === 1 ? 0.5 : 0.14 + 0.72 * (i / (strutCols - 1));
    const sx = ax + (bx - ax) * t, sz = az + (bz - az) * t;
    const sy = y0 + h * 0.5;
    wallPrism(F, sx - ux * 0.1, sz - uz * 0.1, sx + ux * 0.1, sz + uz * 0.1, sy - 0.12, sy + 0.12, 0, back + 0.04, TRUSS_DARK);
  }

  // Maintenance catwalk + rail on hero wide boards
  if ((opts.catwalk ?? (len >= 13 && h >= 10)) && y0 > 8) {
    const cwY = y0 - rim - 0.12;
    wallPrism(F, ax - ux * 0.2, az - uz * 0.2, bx + ux * 0.2, bz + uz * 0.2, cwY - 0.12, cwY, out - 0.2, out + 0.85, TRUSS_STEEL, TRUSS_TRIM);
    wallPrism(F, ax - ux * 0.2, az - uz * 0.2, bx + ux * 0.2, bz + uz * 0.2, cwY + 0.82, cwY + 0.90, out + 0.78, out + 0.86, TRUSS_TRIM);
    for (let i = 0; i < strutCols; i++) {
      const t = 0.06 + 0.88 * (i / Math.max(1, strutCols - 1));
      const sx = ax + (bx - ax) * t, sz = az + (bz - az) * t;
      wallPrism(F, sx - ux * 0.04, sz - uz * 0.04, sx + ux * 0.04, sz + uz * 0.04, cwY, cwY + 0.88, out + 0.78, out + 0.86, TRUSS_DARK);
    }
  }

  // Gooseneck flood arms along top edge of static vinyls
  if (opts.staticVinyl) {
    const nLamps = Math.max(2, Math.min(4, Math.round(len / 5)));
    for (let i = 0; i < nLamps; i++) {
      const t = (i + 0.5) / nLamps;
      const lx = ax + (bx - ax) * t, lz = az + (bz - az) * t;
      wallPrism(F, lx - ux * 0.05, lz - uz * 0.05, lx + ux * 0.05, lz + uz * 0.05, y1 + 0.1, y1 + 0.22, out, out + 0.95, TRUSS_DARK);
      wallPrism(F, lx - ux * 0.16, lz - uz * 0.16, lx + ux * 0.16, lz + uz * 0.16, y1 - 0.04, y1 + 0.14, out + 0.82, out + 1.06, TRUSS_TRIM);
    }
  }
  F.setRM(0.85, 0);

  // Pick artwork via deterministic non-repeating shuffle decks so no creative repeats >2x in one view
  const drawDeck = (deckKey, lenPool) => {
    let deck = ctx[deckKey];
    if (!deck || !deck.length) {
      deck = Array.from({ length: lenPool }, (_, i) => i);
      for (let i = deck.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        const tmp = deck[i]; deck[i] = deck[j]; deck[j] = tmp;
      }
      ctx[deckKey] = deck;
    }
    return deck.pop();
  };
  let col, adIdx = -1;
  const anim = opts.forceAnim || (!opts.staticVinyl && rng.chance(opts.animChance ?? 0.34));
  if (anim) {
    let slot = drawDeck('_adDeckAnim', 16);
    if (32 + slot === opts.avoidIdx) slot = (slot + 5) % 16;
    const cx0 = slot % 4, cy0 = 3 - Math.floor(slot / 4);
    adIdx = 32 + slot;
    const cu = cx0 / 4, cv = cy0 / 4;
    ctx.B(rng.chance(0.5) ? 'adsA' : 'adsB', mx, mz).wall(
      ax + nx * out, az + nz * out, bx + nx * out, bz + nz * out,
      y0, y1, null, [cu + ANIM_UV[0], cv + ANIM_UV[1], cu + ANIM_UV[2], cv + ANIM_UV[3]],
    );
    col = AD_PALETTES[slot % AD_PALETTES.length][0];
  } else {
    const isLand = len >= h;
    const pool = isLand ? AD_LAND : AD_PORT;
    const offset = isLand ? 0 : 16;
    let pick = drawDeck(isLand ? '_adDeckLand' : '_adDeckPort', pool.length);
    if (offset + pick === opts.avoidIdx) pick = (pick + 5) % pool.length;
    adIdx = offset + pick;
    const cell = pool[pick];
    ctx.B('ads', mx, mz).wall(
      ax + nx * out, az + nz * out, bx + nx * out, bz + nz * out,
      y0, y1, null, [cell.u0 + 0.002, cell.v0 + 0.003, cell.u1 - 0.002, cell.v1 - 0.003],
    );
    col = cell.color;
  }

  addScreenLight(ctx, mx, mz, nx, nz, len, h, y0, col);
  return adIdx;
}

/** Vertical double-sided blade sign cantilevered off a building facade. */
export function bladeSign(ctx, x, z, nx, nz, y0, y1, adIdx = 0) {
  const depth = 2.05;
  const thick = 0.24;
  const tx = -nz, tz = nx; // tangent perpendicular to outward normal
  const p0x = x + nx * 0.15, p0z = z + nz * 0.15;
  const p1x = x + nx * depth, p1z = z + nz * depth;
  const mx = (p0x + p1x) / 2, mz = (p0z + p1z) / 2;

  const F = ctx.B('flat', mx, mz);
  F.setRM(0.4, 0.8);
  // Steel mounting brackets connecting blade to wall
  for (const by of [y0 + 0.5, (y0 + y1) / 2, y1 - 0.5]) {
    const bAx = x - tx * 0.16, bAz = z - tz * 0.16;
    const bBx = x + tx * 0.16, bBz = z + tz * 0.16;
    wallPrism(F, bAx, bAz, bBx, bBz, by - 0.08, by + 0.08, 0, 0.35, TRUSS_DARK, TRUSS_TRIM);
  }
  // Blade cabinet body + top/bottom caps
  const cAx = p0x - tx * (thick * 0.5), cAz = p0z - tz * (thick * 0.5);
  const cBx = p0x + tx * (thick * 0.5), cBz = p0z + tz * (thick * 0.5);
  wallPrism(F, cAx, cAz, cBx, cBz, y0 - 0.14, y1 + 0.14, 0, depth - 0.12, TRUSS_DARK, TRUSS_TRIM);
  F.setRM(0.85, 0);

  const cell = AD_PORT[Math.abs(adIdx) % AD_PORT.length];
  const uv = [cell.u0 + 0.002, cell.v0 + 0.003, cell.u1 - 0.002, cell.v1 - 0.003];
  const A = ctx.B('ads', mx, mz);
  const fOff = thick * 0.5 + 0.03;
  // Side +tangent and -tangent faces
  A.wall(p0x + tx * fOff, p0z + tz * fOff, p1x + tx * fOff, p1z + tz * fOff, y0, y1, null, uv);
  A.wall(p1x - tx * fOff, p1z - tz * fOff, p0x - tx * fOff, p0z - tz * fOff, y0, y1, null, uv);
}

/** 90-degree wrap-around LED screen spanning two adjacent walls cleanly at a corner. */
export function wrapCornerAd(ctx, rng, cornerX, cornerZ, ax, az, bx, bz, y0, y1, opts = {}) {
  const out = opts.out ?? 0.95;
  const idxA = framedBillboard(ctx, rng, ax, az, cornerX, cornerZ, y0, y1, { ...opts, out, catwalk: true });
  // Ensure corner wrap uses continuous horizontal ticker feel or cohesive matched/contrasting panel
  const idxB = framedBillboard(ctx, rng, cornerX, cornerZ, bx, bz, y0, y1, { ...opts, out, catwalk: true, avoidIdx: idxA });
  const lenA = Math.hypot(cornerX - ax, cornerZ - az);
  const lenB = Math.hypot(bx - cornerX, bz - cornerZ);
  if (lenA > 1 && lenB > 1) {
    const nAx = (cornerZ - az) / lenA, nAz = -(cornerX - ax) / lenA;
    const nBx = (bz - cornerZ) / lenB, nBz = -(bx - cornerX) / lenB;
    const cx = cornerX + (nAx + nBx) * (out * 0.55);
    const cz = cornerZ + (nAz + nBz) * (out * 0.55);
    const F = ctx.B('flat', cornerX, cornerZ);
    F.setRM(0.38, 0.8);
    F.box(cx - 0.42, y0 - 0.25, cz - 0.42, cx + 0.42, y1 + 0.25, cz + 0.42, TRUSS_STEEL, 31, TRUSS_TRIM);
    F.setRM(0.85, 0);
  }
  return idxB;
}

/** One Times Square: tapered wedge prow closing the south end of Times Square. */
export function buildOneTimesSquare(ctx) {
  const { rng, world, B } = ctx;
  const x0 = 19, x1 = 41, z0 = 171, z1 = 221, h = 110;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  // Tapered footprint: narrow 11m north prow flaring to 22m south stern
  const xL0 = 24.4, xR0 = 35.6, xL1 = x0, xR1 = x1;
  const midZ = 207, top = CURB + h, setY = CURB + 84;
  const SHOP_H = 4.6;

  // Main shaft cladding (modern dark slab curtain wall) + upper stepped crown
  const def = FACADES[1];
  const F = B('flat', cx, cz, 3);
  const G = B('facade1', cx, cz, 3);
  const S = B('shop', cx, cz);
  const E = B('glow', cx, cz);

  const emitWedgeWalls = (xl0, xr0, za, xl1, xr1, zb, y0, y1, tint, shopGround) => {
    const faces = [
      [xl0, za, xr0, za],
      [xr0, za, xr1, zb],
      [xr1, zb, xl1, zb],
      [xl1, zb, xl0, za],
    ];
    let run = 0.15;
    for (const [ax, az, bx, bz] of faces) {
      const len = Math.hypot(bx - ax, bz - az);
      let yLow = y0;
      if (shopGround) {
        yLow = y0 + SHOP_H;
        const n = Math.max(1, Math.round(len / 8));
        for (let k = 0; k < n; k++) {
          const t0 = k / n, t1 = (k + 1) / n;
          const cell = (k * 3 + Math.floor(ax + az)) % (SHOP_COLS * SHOP_ROWS);
          const ci = ((cell % (SHOP_COLS * SHOP_ROWS)) + SHOP_COLS * SHOP_ROWS) % (SHOP_COLS * SHOP_ROWS);
          const cu = (ci % SHOP_COLS) / SHOP_COLS, cv = 1 - (Math.floor(ci / SHOP_COLS) + 1) / SHOP_ROWS;
          S.wall(ax + (bx - ax) * t0, az + (bz - az) * t0, ax + (bx - ax) * t1, az + (bz - az) * t1, y0, yLow,
            null, [cu + 0.002, cv + 0.004, cu + 1 / SHOP_COLS - 0.002, cv + 1 / SHOP_ROWS - 0.004]);
        }
      }
      G.wall(ax, az, bx, bz, yLow, y1, tint, [run, yLow / def.tileH, run + len / def.tileW, y1 / def.tileH]);
      run += len / def.tileW;
    }
    F.setRM(0.92, 0);
    F.quad([xl0, y1, za], [xl1, y1, zb], [xr1, y1, zb], [xr0, y1, za], C('#27292e'));
  };

  emitWedgeWalls(xL0, xR0, z0, xL1, xR1, z1, CURB, setY, [0.76, 0.78, 0.84], true);
  // Podium stone cornice & steel belt above storefront level
  F.setRM(0.55, 0.55);
  wallPrism(F, xL0, z0, xR0, z0, CURB + SHOP_H - 0.05, CURB + SHOP_H + 0.5, 0, 0.48, STONE_BASE, mulC(STONE_BASE, 1.2));
  wallPrism(F, xR0, z0, xR1, z1, CURB + SHOP_H - 0.05, CURB + SHOP_H + 0.5, 0, 0.48, STONE_BASE, mulC(STONE_BASE, 1.2));
  wallPrism(F, xL1, z1, xL0, z0, CURB + SHOP_H - 0.05, CURB + SHOP_H + 0.5, 0, 0.48, STONE_BASE, mulC(STONE_BASE, 1.2));

  // Upper setback crown tier (y = 84..110)
  emitWedgeWalls(xL0 + 1.1, xR0 - 1.1, z0 + 1.4, xL1 - 1.4, xR1 + 1.4, z1 - 3.0, setY, top, [0.72, 0.76, 0.84], false);

  // Exposed dark steel exoskeleton truss armature on the north prow facing Times Square
  F.setRM(0.38, 0.82);
  for (const px of [xL0 + 0.2, xR0 - 0.2]) {
    wallPrism(F, px - 0.22, z0, px + 0.22, z0, CURB + SHOP_H, top - 1, -0.1, 0.95, TRUSS_STEEL, TRUSS_TRIM);
  }
  for (const zy of [27, 43, 59, 75, 92, 107]) {
    wallPrism(F, xL0 - 0.1, z0, xR0 + 0.1, z0, zy - 0.28, zy + 0.28, -0.05, 0.95, TRUSS_DARK, TRUSS_TRIM);
  }

  // Stacked varied-height framed billboards on the iconic north prow (no duplicate adjacent ads)
  let y = 11.4;
  let prevAd = -1;
  for (const [hh, inset, anim] of [[15, 0.1, true], [13.5, 0.2, false], [16.5, 0.15, true], [12.5, 0.35, true], [15.5, 0.2, false], [14.5, 0.8, true]]) {
    prevAd = framedBillboard(ctx, rng, xL0 + inset, z0, xR0 - inset, z0, y, y + hh, {
      forceAnim: anim, out: 1.05, catwalk: true, avoidIdx: prevAd,
    });
    y += hh + 1.4;
  }

  // Staggered screens on the tapered East & West flanks (using parametric coordinates along wedge walls)
  const atT = (ax, az, bx, bz, t) => [ax + (bx - ax) * t, az + (bz - az) * t];
  for (const [t0, t1, yA, yB, anim] of [
    [0.05, 0.44, 12, 34, false], [0.48, 0.92, 14, 38, true],
    [0.06, 0.50, 38, 62, true], [0.54, 0.94, 42, 68, false],
    [0.10, 0.60, 66, 84, false],
  ]) {
    const [eAx, eAz] = atT(xR0, z0, xR1, z1, t0), [eBx, eBz] = atT(xR0, z0, xR1, z1, t1);
    prevAd = framedBillboard(ctx, rng, eAx, eAz, eBx, eBz, yA, yB, { forceAnim: anim, out: 0.92, catwalk: true, avoidIdx: prevAd });
    const [wAx, wAz] = atT(xL1, z1, xL0, z0, 1 - t1), [wBx, wBz] = atT(xL1, z1, xL0, z0, 1 - t0);
    prevAd = framedBillboard(ctx, rng, wAx, wAz, wBx, wBz, yA, yB, { forceAnim: !anim, out: 0.92, catwalk: true, avoidIdx: prevAd });
  }
  framedBillboard(ctx, rng, xR1 - 1, z1, xL1 + 1, z1, 16, 44, { out: 0.85, avoidIdx: prevAd });

  // Glowing news ticker wrapping prow and both flanks cleanly with steel backing
  const tickerWalls = [
    [xL0 - 0.1, z0, xR0 + 0.1, z0, 0.0, 0.55],
    [xR0, z0, xR1, z1, 0.55, 2.35],
    [xL1, z1, xL0, z0, 2.35, 4.15],
  ];
  for (const [ax, az, bx, bz, u0, u1] of tickerWalls) {
    const len = Math.hypot(bx - ax, bz - az);
    const nx = (bz - az) / len, nz = -(bx - ax) / len;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    wallPrism(F, ax, az, bx, bz, 7.2, 10.3, 0.1, 0.62, TRUSS_DARK, TRUSS_TRIM);
    ctx.B('ticker', mx, mz).wall(ax + nx * 0.68, az + nz * 0.68, bx + nx * 0.68, bz + nz * 0.68, 7.55, 9.95, null, [u0, 0, u1, 1]);
  }

  // Tapered broadcast steel mast + New Year's Eve geodesic ball
  const bx = (xL0 + xR0) / 2, bz = z0 + 6.5;
  F.setRM(0.35, 0.85);
  F.taper([bx - 1.6, bz - 1.6, bx + 1.6, bz + 1.6], top, [bx - 0.45, bz - 0.45, bx + 0.45, bz + 0.45], top + 14, TRUSS_STEEL);
  F.box(bx - 0.28, top + 14, bz - 0.28, bx + 0.28, top + 24.5, bz + 0.28, C('#aeb6c4'), 15);
  F.setRM(0.85, 0);
  E.blob(bx, top + 26.2, bz, 2.6, 2.6, 2.6, C('#eef6ff', 1.2));
  ctx.glow(bx, top + 26.2, bz, '#d8ecff', 9);
  ctx.glow(bx, top + 26.2, bz, '#ffffff', 4);

  world.addBox(x0, 0, z0, x1, top, z1, F_ALL | F_BUILDING, S_CONCRETE);
  ctx.buildings.push({ x0, z0, x1, z1, h, style: 1, nearTS: true, noAds: true, shops: 15 });
}

/** North Bowtie tower: stepped hotel tower + structural truss sign stack & corner wrap. */
export function buildNorthBowtieTower(ctx) {
  const { rng } = ctx;
  const n1 = { x0: -29, z0: -205, x1: -17, z1: -171 };
  const n2 = { x0: -38, z0: -231, x1: -17, z1: -205 };
  addBuilding(ctx, { ...n1, h: 96, style: 0, tint: [0.85, 0.9, 1], shops: 15, noAds: true, noRoof: true, tiers: [[n1.x0, n1.z0, n1.x1, n1.z1, CURB, CURB + 96]] });
  addBuilding(ctx, { ...n2, h: 112, style: 0, tint: [0.85, 0.9, 1], shops: 15, noAds: true });

  // Stepped steel billboard truss frame on south prow facing Times Square
  const F = ctx.B('flat', -23, -171);
  F.setRM(0.38, 0.8);
  for (const sx of [n1.x0 + 0.3, n1.x1 - 0.3]) {
    F.box(sx - 0.2, CURB + 8, n1.z1 - 0.1, sx + 0.2, CURB + 95, n1.z1 + 0.85, TRUSS_STEEL, 15, TRUSS_TRIM);
  }
  F.setRM(0.85, 0);

  let y = 11.2, prevAd = -1;
  // Base wrap-around LED screen at the south-east corner (-17, -171)
  prevAd = wrapCornerAd(ctx, rng, n1.x1, n1.z1, n1.x1, n1.z1 - 15, n1.x0 + 0.4, n1.z1, y, y + 12, { forceAnim: true, avoidIdx: prevAd });
  y += 13.5;
  for (const hh of [13, 10, 14, 11, 12]) {
    prevAd = framedBillboard(ctx, rng, n1.x1 - 0.35, n1.z1, n1.x0 + 0.35, n1.z1, y, y + hh, {
      forceAnim: hh >= 12, out: 0.95, catwalk: hh >= 12, avoidIdx: prevAd,
    });
    y += hh + 1.4;
  }
  for (let yy = 26; yy < 80; yy += 24) {
    prevAd = framedBillboard(ctx, rng, n1.x1, n1.z0 + 1, n1.x1, n1.z1 - 1, yy, yy + 20, { out: 0.85, avoidIdx: prevAd });
  }
  // Glowing news ticker band above ground shops
  const T = ctx.B('ticker', -23, -171);
  wallPrism(F, n1.x0, n1.z1, n1.x1, n1.z1, 7.2, 10.1, 0, 0.62, TRUSS_DARK, TRUSS_TRIM);
  T.wall(n1.x1, n1.z1 + 0.68, n1.x0, n1.z1 + 0.68, 7.5, 9.8, null, [0, 0, 0.65, 1]);
}

/** Iconic red illuminated glass TKTS steps, steel flank ribs, ticket booth & Father Duffy statue. */
export function buildTktsSteps(ctx) {
  const { world } = ctx;
  const E = ctx.B('glow', -26, -128);
  const F = ctx.B('flat', -26, -128);
  const sx0 = -34, sx1 = -18, sz = -118, run = 1.2, rise = 0.36, steps = 12;
  const topY = CURB + steps * rise, zTop = sz - steps * run, zBack = -141;

  const redTreadHi = C('#ff4656', 1.25), redTreadLo = C('#cc1828');
  const riserGlow = C('#740c16'), sideGlass = C('#4a0810');
  const nosing = C('#14171d'), flankWhite = C('#d6dce4'), seamSteel = C('#2e323c');

  // Layered illuminated red glass treads (brightest) + dimmer ruby backlit risers + dark steel nosings
  for (let i = 0; i < steps; i++) {
    const zf = sz - i * run, zb = sz - (i + 1) * run, zMid = (zf + zb) * 0.5, yt = CURB + (i + 1) * rise;
    const stepBright = 0.85 + (i / steps) * 0.28;
    E.setRM(0.14, 0.05);
    E.floor(sx0, zMid, sx1, zf, yt, mulC(redTreadHi, stepBright));
    E.floor(sx0, zb, sx1, zMid, yt, mulC(redTreadLo, stepBright));
    E.wall(sx1, zf, sx0, zf, yt - rise, yt, mulC(riserGlow, stepBright));
    E.setRM(0.85, 0);
    F.setRM(0.45, 0.65);
    F.box(sx0, yt - 0.06, zf - 0.11, sx1, yt + 0.015, zf + 0.032, nosing, 16 | 4 | 1 | 2);
    for (let mx = sx0 + 2.6; mx < sx1 - 1.0; mx += 2.6) {
      F.box(mx - 0.025, yt - rise, zf - 0.02, mx + 0.025, yt, zf + 0.026, seamSteel, 4 | 1 | 2);
    }
    world.addBox(sx0, CURB, zb, sx1, yt, zf, F_DEFAULT, S_GLASS);
  }
  // Upper glass promenade deck
  E.setRM(0.14, 0.05);
  E.floor(sx0, zBack, sx1, zTop, topY, redTreadLo);
  E.setRM(0.85, 0);
  world.addBox(sx0, CURB, zBack, sx1, topY, zTop, F_DEFAULT, S_GLASS);

  // Darker glazed side walls + continuous diagonal white-steel structural flank stringers
  F.setRM(0.14, 0.20);
  F.quad([sx0, CURB, sz], [sx0, CURB, zBack], [sx0, topY, zBack], [sx0, topY, zTop], sideGlass);
  F.quad([sx1, CURB, zBack], [sx1, CURB, sz], [sx1, topY, zTop], [sx1, topY, zBack], sideGlass);
  F.wall(sx0, zBack, sx1, zBack, CURB, topY, mulC(sideGlass, 0.85));
  F.setRM(0.35, 0.75);
  for (const fx of [sx0 - 0.14, sx1 + 0.02]) {
    const f0 = fx, f1 = fx + 0.12;
    F.box(f0, CURB, zBack - 0.2, f1, topY + 1.05, zBack + 0.25, flankWhite, 31);
    F.box(f0, topY - 0.16, zBack, f1, topY + 0.05, zTop + 0.15, flankWhite, 31);
    F.quad([f0, CURB + rise, sz], [f0, CURB, sz], [f0, topY - 0.22, zTop], [f0, topY + 0.04, zTop], flankWhite);
    F.quad([f1, CURB, sz], [f1, CURB + rise, sz], [f1, topY + 0.04, zTop], [f1, topY - 0.22, zTop], flankWhite);
    F.quad([f0, CURB + rise, sz], [f0, topY + 0.04, zTop], [f1, topY + 0.04, zTop], [f1, CURB + rise, sz], mulC(flankWhite, 1.12));
  }

  // Sleek steel-and-glass top platform railing + north balustrade collider
  F.box(sx0, topY, zBack, sx1, topY + 0.08, zBack + 0.16, C('#20242c'), 31);
  F.box(sx0, topY + 0.96, zBack, sx1, topY + 1.05, zBack + 0.14, C('#d8dee6'), 31);
  for (let px = sx0 + 0.5; px <= sx1 - 0.5; px += 1.6) {
    F.box(px - 0.04, topY, zBack + 0.03, px + 0.04, topY + 1.0, zBack + 0.11, C('#2a2f38'), 31);
  }
  world.addBox(sx0, CURB, zBack, sx1, topY + 1.0, zBack + 0.15, F_DEFAULT, S_CONCRETE);

  // Recessed TIX ticket pavilion under the north wall: canopy, illuminated service bays, stanchions & sign
  F.setRM(0.45, 0.65);
  F.box(sx0 + 1.0, CURB, zBack - 2.6, sx1 - 1.0, CURB + 3.4, zBack, C('#1b1e24'), 31, TRUSS_TRIM);
  F.box(sx0 + 0.4, CURB + 3.4, zBack - 3.6, sx1 - 0.4, CURB + 3.75, zBack + 0.1, C('#2b303a'), 31, flankWhite);
  for (let bx = sx0 + 2.2; bx < sx1 - 2.2; bx += 2.6) {
    F.box(bx - 0.08, CURB + 0.95, zBack - 2.68, bx + 0.08, CURB + 2.6, zBack - 2.55, C('#14161b'), 15);
    E.wall(bx + 1.1, zBack - 2.62, bx + 0.12, zBack - 2.62, CURB + 1.05, CURB + 2.45, C('#ffd8c4', 0.85));
  }
  const tk = ctx.signCells.TIX;
  ctx.B('signs', -26, zBack - 3.6).wall(sx1 - 2.2, zBack - 3.64, sx0 + 2.2, zBack - 3.64, CURB + 3.42, CURB + 3.92, null, [tk.u0, tk.v0, tk.u1, tk.v1]);
  // Queue stanchions on the north concourse
  for (let px = sx0 + 1.5; px <= sx1 - 1.5; px += 2.6) {
    F.cyl(px, zBack - 4.4, CURB, CURB + 0.92, 0.035, 0.035, 6, C('#8c929c'));
  }

  // Ruby glow pools around the steps
  for (const [px, pz] of [[-26, -112], [-26, -128], [-37, -126], [-15, -126]]) {
    ctx.pool(px, pz, 11, '#e62234', 0.34);
    if (ctx.light) ctx.light(px, pz, 14, '#e62234', 0.40);
  }

  // Sculpted bronze standing memorial statue on a stepped granite plinth (no cross behind)
  const S = ctx.B('flat', -26, -104);
  S.setRM(0.75, 0.05);
  S.box(-27.2, CURB, -105.2, -24.8, CURB + 0.42, -102.8, STONE_BASE, 31, mulC(STONE_BASE, 1.15));
  S.box(-26.85, CURB + 0.42, -104.85, -25.15, CURB + 1.95, -103.15, mulC(STONE_BASE, 0.90), 31, STONE_BASE);
  S.box(-26.55, CURB + 1.95, -104.55, -25.45, CURB + 2.18, -103.45, mulC(STONE_BASE, 1.05), 31);
  // Bronze plaque on front face
  S.setRM(0.40, 0.72);
  S.box(-26.55, CURB + 0.85, -103.14, -25.45, CURB + 1.50, -103.10, BRONZE, 4);
  // Standing bronze figure: boots/legs -> overcoat -> torso/shoulders -> head -> raised arm
  S.cyl(-26.14, -103.95, CURB + 2.18, CURB + 3.05, 0.11, 0.10, 6, BRONZE, false);
  S.cyl(-25.86, -104.05, CURB + 2.18, CURB + 3.05, 0.11, 0.10, 6, BRONZE, false);
  S.cyl(-26.0, -104.0, CURB + 2.90, CURB + 3.85, 0.25, 0.30, 8, BRONZE, true, mulC(BRONZE, 1.15));
  S.box(-26.32, CURB + 3.25, -104.16, -25.68, CURB + 3.82, -103.84, mulC(BRONZE, 1.06), 31);
  S.cyl(-26.0, -104.0, CURB + 3.85, CURB + 4.02, 0.09, 0.08, 6, BRONZE, false);
  S.blob(-26.0, CURB + 4.18, -103.98, 0.15, 0.19, 0.16, BRONZE);
  S.box(-25.72, CURB + 3.55, -104.02, -25.52, CURB + 4.08, -103.72, BRONZE, 31);
  S.setRM(0.85, 0);
  world.addBox(-27.1, CURB, -105.2, -24.9, CURB + 4.5, -103.0, F_DEFAULT, S_CONCRETE);
}

/** NYPD Times Square substation booth: dark smoked glass, heavy mullions, cantilevered blue frieze roof. */
export function buildNypdBooth(ctx) {
  const { world } = ctx;
  const x0 = 22, z0 = 138, x1 = 34, z1 = 145;
  const PB = ctx.B('flat', 28, 141.5);
  const E = ctx.B('glow', 28, 141.5);

  // Dark granite base plinth + gunmetal steel booth body
  PB.setRM(0.65, 0.15);
  PB.box(x0 - 0.08, CURB, z0 - 0.08, x1 + 0.08, CURB + 0.22, z1 + 0.08, C('#16181e'), 31, C('#282d36'));
  PB.setRM(0.42, 0.58);
  PB.box(x0, CURB + 0.22, z0, x1, CURB + 3.25, z1, C('#252b35'), 31, C('#323946'));
  // NYPD blue & stainless trim band below the observation sill
  PB.box(x0 - 0.04, CURB + 0.85, z0 - 0.04, x1 + 0.04, CURB + 1.08, z1 + 0.04, C('#184eb8'), 15);
  PB.box(x0 - 0.04, CURB + 1.08, z0 - 0.04, x1 + 0.04, CURB + 1.16, z1 + 0.04, C('#c8d2de'), 15);

  // Dark smoked-glass recessed observation windows + crisp steel mullions (no blown-out cyan sheet)
  PB.setRM(0.08, 0.88);
  PB.box(x0 + 0.85, CURB + 1.22, z0 - 0.02, x1 - 0.85, CURB + 2.55, z0 + 0.03, C('#111b28'), 8);
  PB.box(x0 - 0.02, CURB + 1.24, z0 + 0.95, x0 + 0.03, CURB + 2.52, z1 - 0.95, C('#111b28'), 2);
  PB.box(x1 - 0.03, CURB + 1.24, z0 + 0.95, x1 + 0.02, CURB + 2.52, z1 - 0.95, C('#111b28'), 1);

  PB.setRM(0.4, 0.7);
  for (const mx of [x0 + 3.2, x0 + 6.0, x0 + 8.8]) {
    PB.box(mx - 0.07, CURB + 1.16, z0 - 0.07, mx + 0.07, CURB + 2.6, z0 + 0.04, C('#171b22'), 15);
  }
  PB.box(x0 + 0.8, CURB + 2.52, z0 - 0.07, x1 - 0.8, CURB + 2.62, z0 + 0.04, C('#171b22'), 15);
  PB.box(x0 - 0.07, CURB + 1.22, (z0 + z1) / 2 - 0.07, x0 + 0.04, CURB + 2.56, (z0 + z1) / 2 + 0.07, C('#171b22'), 15);

  // Subtle warm interior desk monitor glow inside dark glass
  E.box(x0 + 1.8, CURB + 1.28, z0 + 0.01, x1 - 1.8, CURB + 2.15, z0 + 0.02, C('#4a729c', 0.55), 8);

  // Cantilevered overhang roof + illuminated blue NYPD cornice & twin roof beacons
  PB.box(x0 - 0.45, CURB + 3.25, z0 - 0.55, x1 + 0.45, CURB + 3.45, z1 + 0.45, C('#1c2028'), 31, C('#2c323e'));
  E.box(x0 - 0.48, CURB + 3.45, z0 - 0.58, x1 + 0.48, CURB + 3.74, z1 + 0.48, C('#2262e8', 1.1), 15);
  PB.box(x0 - 0.5, CURB + 3.74, z0 - 0.6, x1 + 0.5, CURB + 3.84, z1 + 0.5, C('#1c2028'), 31);
  E.cyl(x0 + 0.6, z0 + 0.4, CURB + 3.84, CURB + 4.12, 0.14, 0.14, 8, C('#3a84ff', 1.3));
  E.cyl(x1 - 0.6, z0 + 0.4, CURB + 3.84, CURB + 4.12, 0.14, 0.14, 8, C('#3a84ff', 1.3));

  const pc = ctx.signCells.POLICE;
  ctx.B('signs', 28, 141).wall(x0 + 3, z0 - 0.59, x1 - 3, z0 - 0.59, CURB + 2.74, CURB + 3.24, null, [pc.u0, pc.v0, pc.u1, pc.v1]);
  // Protective concrete-filled steel bollards guarding the north approach
  PB.setRM(0.45, 0.7);
  for (let bx = x0 + 0.8; bx <= x1 - 0.8; bx += 2.6) {
    PB.cyl(bx, z0 - 1.25, CURB, CURB + 0.92, 0.12, 0.12, 8, C('#262b33'), true, C('#505763'));
  }
  PB.setRM(0.85, 0);

  world.addBox(x0, CURB, z0, x1, CURB + 3.75, z1, F_DEFAULT, S_METAL);
  if (ctx.occluder) ctx.occluder(x0, z0, x1, z1, 1.5, 0.34);
  ctx.pool(28, 134, 9.5, '#3070ee', 0.42);
  if (ctx.light) {
    ctx.light(28, 134, 13, '#2f74ff', 0.55);
    ctx.light(19, 141.5, 10, '#4b8eff', 0.36);
  }
  ctx.glow(28, CURB + 3.6, 138, '#3b7bff', 2.0);
}

/** Dress Times Square facades with varied billboard scales: wraps, blades, tickers, framed vinyls & LEDs. */
export function dressTimesSquareBillboards(ctx) {
  const { rng, world } = ctx;
  for (const b of ctx.buildings.slice()) {
    if (!b.nearTS || b.noAds || b.h < 14) continue;
    const walls = [
      [b.x0, b.z0, b.x1, b.z0, 0, -1],
      [b.x1, b.z0, b.x1, b.z1, 1, 0],
      [b.x1, b.z1, b.x0, b.z1, 0, 1],
      [b.x0, b.z1, b.x0, b.z0, -1, 0],
    ];
    let lastAd = -1;
    for (const [ax, az, bx2, bz2, nx, nz] of walls) {
      const mx = (ax + bx2) / 2, mz = (az + bz2) / 2;
      const len = Math.hypot(bx2 - ax, bz2 - az);
      if (len < 9) continue;
      const axis = broadwayX(mz) * 0.5;
      const toward = (axis - mx) * nx;
      let maxY;
      const broadwayFacing = nx !== 0 && toward > 0 && Math.abs(axis - mx) < 78 && mz > -250 && mz < 250;
      const crossFacing = nz !== 0 && Math.abs(mx - axis) < 105 && mz > -250 && mz < 250;
      if (broadwayFacing) maxY = Math.min(b.h - 3, 58);
      else if (crossFacing) maxY = Math.min(b.h - 3, 25);
      else continue;

      if (!world.fits(mx + nx * 3, CURB + 6, mz + nz * 3, 1.5, 4)) continue;
      const ux = (bx2 - ax) / len, uz = (bz2 - az) / len;

      // Occasional horizontal amber news ticker ribbon right above shop fascia on major Broadway walls
      let yStart = 6.2 + rng.range(0, 1.4);
      if (broadwayFacing && len >= 18 && hash2(mx, mz, 3) < 0.45) {
        const F = ctx.B('flat', mx, mz);
        F.setRM(0.42, 0.75);
        wallPrism(F, ax + ux * 0.8, az + uz * 0.8, bx2 - ux * 0.8, bz2 - uz * 0.8, 5.9, 8.2, 0.1, 0.56, TRUSS_DARK, TRUSS_TRIM);
        F.setRM(0.85, 0);
        ctx.B('ticker', mx, mz).wall(
          ax + ux * 0.8 + nx * 0.62, az + uz * 0.8 + nz * 0.62,
          bx2 - ux * 0.8 + nx * 0.62, bz2 - uz * 0.8 + nz * 0.62,
          6.15, 7.95, null, [0, 0, len / 22, 1],
        );
        yStart = 8.9;
      }

      // Selective projecting vertical theatre/retail blade sign near wall end
      if (maxY > 22 && len > 14 && hash2(ax, az, 7) < 0.42) {
        const bp = 1.6;
        const idx = Math.floor(hash2(mx, mz, 9) * AD_PORT.length);
        bladeSign(ctx, ax + ux * bp, az + uz * bp, nx, nz, 8.5, Math.min(23, maxY - 2), idx);
      }

      let yy = yStart;
      while (yy + 6 < maxY) {
        const rowH = Math.min(rng.range(7.2, 16.5), maxY - yy);
        let s = rng.range(0.9, 2.8);
        while (s + 7 < len - 0.9) {
          const w = Math.min(rng.range(8.5, 22), len - 0.9 - s);
          if (rng.chance(0.16)) { s += w + 1.0; continue; }
          const staticVinyl = !broadwayFacing && rng.chance(0.5);
          lastAd = framedBillboard(ctx, rng,
            ax + ux * s, az + uz * s, ax + ux * (s + w), az + uz * (s + w),
            yy, yy + rowH - 1.1,
            { avoidIdx: lastAd, staticVinyl, out: staticVinyl ? 0.65 : 0.92, catwalk: !staticVinyl && w >= 11 && rowH >= 10 },
          );
          s += w + rng.range(0.8, 1.7);
        }
        yy += rowH + rng.range(0.6, 1.3);
      }
    }
  }
}
