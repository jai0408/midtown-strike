// Procedural Midtown: turns the street plan into merged render meshes, a
// collision world, a navigation graph and a minimap image.
import * as THREE from 'three';
import { RNG, clamp } from '../core/util.js';
import { World, F_ALL, F_BUILDING, S_CONCRETE, S_GLASS } from '../core/physics.js';
import {
  HALF, CURB, AVENUES, STREETS, broadwayX, BW_ROAD, BW_HW, PLAZA_Z0, PLAZA_Z1,
  groundAt, makeBlocks,
} from './layout.js';
import { Geo, C, mulC } from './geo.js';
import * as T from './textures.js';
import { waterTower } from './props.js';
import { specialBlock, buildLandmarks, populateStreets } from './landmarks.js';
import { buildNav } from './nav.js';

const CHUNKS = 5;
export const SHOP_H = 4.6;

// which vertex attributes each material family needs
const LAYOUT = {
  walk: { uv: true }, flat: {}, glow: { normal: false }, marks: { uv: true, color: false },
  shop: { uv: true, normal: false, color: false }, ads: { uv: true, normal: false, color: false },
  adsA: { uv: true, normal: false, color: false }, adsB: { uv: true, normal: false, color: false },
  ticker: { uv: true, normal: false, color: false }, signs: { uv: true, normal: false, color: false },
  pool: { uv: true, normal: false },
};
for (let i = 0; i < T.FACADES.length; i++) LAYOUT['facade' + i] = { uv: true };

// draw distance per family (metres); Infinity = fog decides
const RANGE = { flat: 520, glow: 700, marks: 380, shop: 560, signs: 160, pool: 420 };

function makeMaterials() {
  const M = {};
  M.ground = new THREE.MeshLambertMaterial({ map: T.asphaltTexture() });
  M.walk = new THREE.MeshLambertMaterial({ map: T.pavingTexture(), vertexColors: true });
  M.flat = new THREE.MeshLambertMaterial({ vertexColors: true });
  M.glow = new THREE.MeshBasicMaterial({ vertexColors: true });
  M.marks = new THREE.MeshLambertMaterial({
    map: T.markingsTexture(), transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  T.FACADES.forEach((def, i) => {
    const tex = T.facadeTextures(def, 100 + i * 17);
    M['facade' + i] = new THREE.MeshLambertMaterial({
      map: tex.map, emissiveMap: tex.emissive, emissive: 0xffffff, emissiveIntensity: 1.0, vertexColors: true,
    });
  });
  M.shop = new THREE.MeshBasicMaterial({ map: T.shopTexture(), color: 0xd8d8d8 });
  M.ads = new THREE.MeshBasicMaterial({ map: T.adsTexture() });
  const anim = T.adsAnimTexture();
  M.adsA = new THREE.MeshBasicMaterial({ map: anim });
  const anim2 = anim.clone();
  anim2.needsUpdate = true;
  M.adsB = new THREE.MeshBasicMaterial({ map: anim2 });
  M.ticker = new THREE.MeshBasicMaterial({ map: T.tickerTexture() });
  const signs = T.signsTexture();
  M.signs = new THREE.MeshBasicMaterial({ map: signs.texture, color: 0xb8b8b8 });
  M.signCells = signs.cells;
  const glow = T.glowTexture();
  M.pool = new THREE.MeshBasicMaterial({
    map: glow, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
  M.points = new THREE.PointsMaterial({
    map: glow, size: 4.2, sizeAttenuation: true, vertexColors: true, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  return M;
}

// ---------------------------------------------------------------------------
// District character: lot sizes, heights and facade mix
// ---------------------------------------------------------------------------
// styles: 0 glass, 1 slab, 2 stone, 3 brick, 4 loft, 5 deco
function district(cx, cz) {
  const nearBowtie = Math.abs(cx - broadwayX(cz) * 0.5) < 190 && cz > -420 && cz < 420;
  if (cx < -860 && cz > 840) return { w: [55, 110], h: [170, 330], pow: 0.8, tall: 0, styles: [0, 0, 0, 1], through: 1 };
  if (cx < -580) {
    const on42 = Math.abs(cz - 280) < 90;
    return { w: on42 ? [30, 70] : [9, 26], h: on42 ? [60, 190] : [14, 30], pow: on42 ? 1.2 : 1.4, tall: on42 ? 0 : 0.05, tallH: [80, 170], styles: on42 ? [0, 0, 1, 4] : [3, 3, 3, 4, 4, 2], through: on42 ? 0.7 : 0.05 };
  }
  if (cx < -300) return { w: [14, 42], h: [18, 64], pow: 1.6, tall: 0.14, tallH: [100, 200], styles: [3, 3, 4, 4, 2, 5, 0], through: 0.2 };
  if (nearBowtie) return { w: [24, 62], h: [28, 95], pow: 1.3, tall: 0.42, tallH: [130, 235], styles: [0, 0, 1, 2, 5, 5, 4], through: 0.45 };
  if (cx > 250 && cx < 600 && cz < 260 && cz > -1000) return { w: [50, 110], h: [140, 250], pow: 1.0, tall: 0.1, tallH: [230, 280], styles: [1, 1, 0, 0, 2], through: 0.75 };
  if (cx > 600) return { w: [28, 80], h: [70, 190], pow: 1.2, tall: 0.14, tallH: [200, 260], styles: [1, 0, 0, 2, 5, 2], through: 0.55 };
  if (cz > 500) return { w: [18, 52], h: [32, 88], pow: 1.3, tall: 0.08, tallH: [110, 180], styles: [4, 4, 2, 3, 5], through: 0.35 };
  if (cz < -640) return { w: [24, 70], h: [50, 150], pow: 1.3, tall: 0.14, tallH: [170, 260], styles: [2, 5, 0, 1, 2], through: 0.5 };
  return { w: [22, 60], h: [40, 130], pow: 1.3, tall: 0.2, tallH: [150, 230], styles: [0, 1, 2, 5, 4], through: 0.45 };
}

const TINTS = [
  [1, 1, 1], [0.9, 0.92, 1], [1, 0.95, 0.88], [0.82, 0.84, 0.9], [1.08, 1.0, 0.94], [0.9, 0.86, 0.84], [0.75, 0.8, 0.9], [1.1, 1.05, 1.0],
];
const ROOF = C('#26282c'), ROOF2 = C('#33363b');

export function buildCity({ onProgress } = {}) {
  const rng = new RNG(20260411);
  const world = new World(HALF + 16, 32);
  world.groundAt = groundAt;
  const M = makeMaterials();
  const group = new THREE.Group();
  group.name = 'city';

  // -- chunked geometry builders -------------------------------------------
  const builders = new Map();
  const B = (mat, x, z, grid = CHUNKS) => {
    const size = (HALF * 2) / grid;
    const cx = clamp(Math.floor((x + HALF) / size), 0, grid - 1);
    const cz = clamp(Math.floor((z + HALF) / size), 0, grid - 1);
    const key = `${mat}|${grid}|${cx}|${cz}`;
    let b = builders.get(key);
    if (!b) {
      b = new Geo(LAYOUT[mat]);
      b.mat = mat;
      builders.set(key, b);
    }
    return b;
  };
  const pointChunks = new Map();
  const ctx = {
    world, rng, B, M,
    signCells: M.signCells,
    buildings: [],   // footprints for minimap / billboards
    vehicles: [],
    stations: [],
    parks: [],       // rects drawn green on the minimap
    plazas: [],
    emitters: [],    // fire / smoke effect anchors
    lampCount: 0,
    /** Additive glow sprite (street lamps, signals, neon). */
    glow(x, y, z, color, size = 1) {
      const key = `${clamp(Math.floor((x + HALF) / 460), 0, 4)}|${clamp(Math.floor((z + HALF) / 460), 0, 4)}`;
      let p = pointChunks.get(key);
      if (!p) pointChunks.set(key, (p = { pos: [], col: [] }));
      const c = C(color, 0.55 * size);
      p.pos.push(x, y, z);
      p.col.push(c[0], c[1], c[2]);
    },
    /** Pool of light painted on the ground. */
    pool(x, z, r, color, k = 0.5) {
      const y = groundAt(x, z) + 0.03;
      B('pool', x, z).floor(x - r, z - r, x + r, z + r, y, C(color, k), [0, 0, 1, 1]);
    },
  };

  // -- ground ---------------------------------------------------------------
  {
    const size = (HALF + 500) * 2;
    const g = new THREE.PlaneGeometry(size, size);
    g.rotateX(-Math.PI / 2);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (size / 7), uv.getY(i) * (size / 7));
    const mesh = new THREE.Mesh(g, M.ground);
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }

  // -- blocks: sidewalk slabs + buildings ----------------------------------
  const blocks = makeBlocks();
  const SLAB = [1, 1, 1], PLAZA = C('#8d8a86'), KERB = C('#8f8d88');
  const clipPoly = (poly, side, off, slope) => {
    // keep the part with side*(x - (slope*z + off)) >= 0
    const out = [];
    const f = (p) => side * (p[0] - (slope * p[1] + off));
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const fa = f(a), fb = f(b);
      if (fa >= 0) out.push(a);
      if ((fa >= 0) !== (fb >= 0)) {
        const t = fa / (fa - fb);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    return out;
  };
  const emitSlab = (poly, col) => {
    if (poly.length < 3) return;
    let mx = 0, mz = 0;
    for (const p of poly) { mx += p[0]; mz += p[1]; }
    mx /= poly.length; mz /= poly.length;
    const G = B('walk', mx, mz, 3);
    G._reserve(poly.length, (poly.length - 2) * 3);
    const base = G.nv;
    for (const p of poly) G.vert(p[0], CURB, p[1], 0, 1, 0, p[0] / 3.2, -p[1] / 3.2, col);
    // polygons are clockwise on a north-up map -> reverse the fan for +Y
    for (let i = 1; i < poly.length - 1; i++) {
      G.idx[G.ni++] = base; G.idx[G.ni++] = base + i + 1; G.idx[G.ni++] = base + i;
    }
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if (Math.abs(a[0]) > HALF + 5 && Math.abs(b[0]) > HALF + 5) continue;
      if (Math.abs(a[1]) > HALF + 5 && Math.abs(b[1]) > HALF + 5) continue;
      G.wall(a[0], a[1], b[0], b[1], 0, CURB, KERB, [0, 0, 0.05, 0.05]);
    }
  };

  let built = 0;
  for (const blk of blocks) {
    const cx = (blk.x0 + blk.x1) / 2, cz = (blk.z0 + blk.z1) / 2;
    const zMid = clamp(cz, -HALF, HALF);
    const inPlaza = blk.sz1 > PLAZA_Z0 && blk.sz0 < PLAZA_Z1;
    const bMin = Math.min(broadwayX(blk.z0), broadwayX(blk.z1)), bMax = Math.max(broadwayX(blk.z0), broadwayX(blk.z1));
    const crossesBroadway = bMax + BW_HW > blk.x0 && bMin - BW_HW < blk.x1 && Math.abs(blk.z0) <= HALF;

    // sidewalk slab (clipped where Broadway's roadway cuts through)
    const rect = [[blk.sx0, blk.sz0], [blk.sx1, blk.sz0], [blk.sx1, blk.sz1], [blk.sx0, blk.sz1]];
    const special = specialBlock(blk);
    if (crossesBroadway && !inPlaza) {
      const slope = zMid > 0 ? 0.318 : 0.25;
      emitSlab(clipPoly(rect, -1, -BW_ROAD, slope), SLAB);
      emitSlab(clipPoly(rect, 1, BW_ROAD, slope), SLAB);
    } else {
      emitSlab(rect, inPlaza && crossesBroadway ? PLAZA : SLAB);
    }
    if (special) {
      special(ctx, blk);
      continue;
    }

    // lots
    const d = district(cx, cz);
    const depth = blk.z1 - blk.z0;
    const lots = [];
    if (blk.border) {
      // one row of backdrop towers just outside the playable area
      const horizontal = Math.abs(cz) > HALF - 40;
      const vertical = Math.abs(cx) > HALF - 40;
      if (cz < -HALF + 40) continue; // north edge is the park
      if (cx < -HALF + 40) continue; // west edge is the river
      let x0 = blk.x0, x1 = blk.x1, z0 = blk.z0, z1 = blk.z1;
      if (vertical) { x0 = Math.max(x0, HALF - 12); x1 = x0 + 46; }
      if (horizontal) { z0 = Math.max(z0, HALF - 18); z1 = z0 + 46; }
      if (vertical && horizontal) continue;
      const along = vertical ? z1 - z0 : x1 - x0;
      let p = 0;
      while (p < along - 6) {
        let w = rng.range(26, 70);
        if (along - p - w < 20) w = along - p;
        lots.push(vertical ? { x0, x1, z0: z0 + p, z1: z0 + p + w } : { x0: x0 + p, x1: x0 + p + w, z0, z1 });
        p += w;
      }
      for (const lot of lots) {
        const h = rng.range(45, 170);
        addBuilding(ctx, { ...lot, h, style: rng.pick([0, 1, 2, 4, 5]), tint: rng.pick(TINTS), shops: 0, simple: true });
      }
      continue;
    }
    let x = blk.x0;
    const width = blk.x1 - blk.x0;
    while (x < blk.x1 - 3) {
      let w = rng.range(d.w[0], d.w[1]);
      if (blk.x1 - (x + w) < d.w[0]) w = blk.x1 - x;
      const end = x < blk.x0 + 1 || x + w > blk.x1 - 1; // lot fronts an avenue
      if (rng.chance(d.through) || depth < 44 || (end && rng.chance(0.5))) {
        lots.push({ x0: x, x1: x + w, z0: blk.z0, z1: blk.z1, end });
      } else {
        const mid = (blk.z0 + blk.z1) / 2 + rng.range(-5, 5);
        lots.push({ x0: x, x1: x + w, z0: blk.z0, z1: mid, end });
        lots.push({ x0: x, x1: x + w, z0: mid, z1: blk.z1, end });
      }
      x += w;
    }
    for (const lot of lots) {
      // carve Broadway (and the Times Square bowtie) out of the lot
      let parts = [lot];
      if (crossesBroadway) {
        let e0 = Math.min(broadwayX(lot.z0), broadwayX(lot.z1)) - BW_HW;
        let e1 = Math.max(broadwayX(lot.z0), broadwayX(lot.z1)) + BW_HW;
        if (lot.z1 > PLAZA_Z0 - 80 && lot.z0 < PLAZA_Z1) {
          if (cz > 0) e0 = Math.min(e0, 15); else e1 = Math.max(e1, -15);
        }
        parts = [];
        if (lot.x1 <= e0 || lot.x0 >= e1) parts.push(lot);
        else {
          if (e0 - lot.x0 >= 10) parts.push({ ...lot, x1: e0, bw: 2 });
          if (lot.x1 - e1 >= 10) parts.push({ ...lot, x0: e1, bw: 8 });
        }
      }
      for (const p of parts) {
        const w = p.x1 - p.x0, dp = p.z1 - p.z0;
        const lotC = (p.x0 + p.x1) / 2;
        const nearTS = Math.abs(lotC - broadwayX(cz) * 0.5) < 120 && cz > -260 && cz < 260;
        if (!nearTS && rng.chance(0.045) && w > 14) {
          ctx.plazas.push({ x0: p.x0, z0: p.z0, x1: p.x1, z1: p.z1, kind: rng.pick(['parking', 'plaza', 'site']) });
          continue;
        }
        let h = d.h[0] + (d.h[1] - d.h[0]) * Math.pow(rng.next(), d.pow);
        const big = w * dp > 1100;
        if (d.tall && big && rng.chance(d.tall * (p.end ? 1.6 : 1))) h = rng.range(d.tallH[0], d.tallH[1]);
        if (w < 13) h = Math.min(h, 45);
        let style = rng.pick(d.styles);
        if (h > 150 && (style === 3 || style === 4)) style = rng.pick([0, 1, 5]);
        // storefronts on walls that face a street
        let shops = 0;
        if (Math.abs(p.z0 - blk.z0) < 0.1) shops |= 1;
        if (Math.abs(p.x1 - blk.x1) < 0.1) shops |= 2;
        if (Math.abs(p.z1 - blk.z1) < 0.1) shops |= 4;
        if (Math.abs(p.x0 - blk.x0) < 0.1) shops |= 8;
        if (p.bw) shops |= p.bw;
        addBuilding(ctx, { ...p, h, style, tint: rng.pick(TINTS), shops, nearTS });
      }
    }
    if ((++built & 31) === 0 && onProgress) onProgress(0.1 + 0.4 * (built / blocks.length));
  }

  buildRoadMarkings(ctx);
  if (onProgress) onProgress(0.55);
  buildLandmarks(ctx);
  if (onProgress) onProgress(0.7);
  populateStreets(ctx);
  if (onProgress) onProgress(0.85);
  world.finalize();

  // -- meshes ---------------------------------------------------------------
  const chunks = [];
  let tris = 0;
  for (const [key, b] of builders) {
    if (!b.ni) continue;
    const mesh = new THREE.Mesh(b.build(), M[b.mat]);
    mesh.matrixAutoUpdate = false;
    mesh.name = key;
    if (b.mat === 'marks') mesh.renderOrder = 1;
    if (b.mat === 'pool') mesh.renderOrder = 2;
    mesh.userData.range = RANGE[b.mat] || Infinity;
    tris += b.ni / 3;
    group.add(mesh);
    chunks.push(mesh);
  }
  for (const [, p] of pointChunks) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(p.col, 3));
    g.computeBoundingSphere();
    const pts = new THREE.Points(g, M.points);
    pts.matrixAutoUpdate = false;
    pts.renderOrder = 3;
    pts.userData.range = 900;
    group.add(pts);
    chunks.push(pts);
  }
  builders.clear();

  const nav = buildNav(world);
  if (onProgress) onProgress(0.95);

  // animated billboards
  let tA = 0, tB = 0, fA = 0, fB = 5;
  const update = (dt, camPos, drawScale = 1) => {
    tA += dt; tB += dt;
    if (tA > 2.6) { tA = 0; fA = (fA + 1) % 16; M.adsA.map.offset.set((fA % 4) / 4, Math.floor(fA / 4) / 4); }
    if (tB > 1.7) { tB = 0; fB = (fB + 3) % 16; M.adsB.map.offset.set((fB % 4) / 4, Math.floor(fB / 4) / 4); }
    M.ticker.map.offset.x = (M.ticker.map.offset.x + dt * 0.035) % 1;
    for (let i = 0; i < chunks.length; i++) {
      const m = chunks[i], r = m.userData.range;
      if (r === Infinity) continue;
      const s = m.geometry.boundingSphere;
      const dx = s.center.x - camPos.x, dz = s.center.z - camPos.z;
      m.visible = Math.hypot(dx, dz) - s.radius < r * drawScale;
    }
  };

  return { group, world, nav, ctx, materials: M, update, stats: { tris: Math.round(tris), colliders: world.count, meshes: chunks.length } };
}

// ---------------------------------------------------------------------------
// A building: stacked tiers with facade walls, storefronts and a roof.
// ---------------------------------------------------------------------------
export function addBuilding(ctx, b) {
  const { rng, world, B } = ctx;
  const def = T.FACADES[b.style];
  const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
  const G = B('facade' + b.style, cx, cz, 3);
  const base = Math.abs(cx) > HALF || Math.abs(cz) > HALF ? 0 : CURB;
  const w = b.x1 - b.x0, d = b.z1 - b.z0;
  const tint = b.tint || [1, 1, 1];
  const top = base + b.h;

  // tiers: [x0,z0,x1,z1,y0,y1]
  const tiers = [];
  if (b.tiers) tiers.push(...b.tiers);
  else if (!b.simple && b.h > 55 && Math.min(w, d) > 22 && rng.chance(b.style === 0 ? 0.45 : 0.8)) {
    const podium = base + Math.min(b.h * rng.range(0.18, 0.42), 48);
    const i1 = rng.range(2.5, Math.min(w, d) * 0.14);
    tiers.push([b.x0, b.z0, b.x1, b.z1, base, podium]);
    if (b.h > 120 && rng.chance(0.6)) {
      const mid = podium + (top - podium) * rng.range(0.55, 0.8);
      const i2 = i1 + rng.range(2, Math.min(w, d) * 0.12);
      tiers.push([b.x0 + i1, b.z0 + i1, b.x1 - i1, b.z1 - i1, podium, mid]);
      tiers.push([b.x0 + i2, b.z0 + i2, b.x1 - i2, b.z1 - i2, mid, top]);
    } else {
      tiers.push([b.x0 + i1, b.z0 + i1, b.x1 - i1, b.z1 - i1, podium, top]);
    }
  } else tiers.push([b.x0, b.z0, b.x1, b.z1, base, top]);

  const uOff = rng.next(), vOff = Math.floor(rng.next() * def.rows) / def.rows;
  const R = B('flat', cx, cz, 3);
  tiers.forEach((t, ti) => {
    const [x0, z0, x1, z1, y0, y1] = t;
    const walls = [[x0, z0, x1, z0, 1], [x1, z0, x1, z1, 2], [x1, z1, x0, z1, 4], [x0, z1, x0, z0, 8]];
    let run = uOff;
    for (const [ax, az, bx, bz, bit] of walls) {
      const len = Math.hypot(bx - ax, bz - az);
      let yLow = y0;
      if (ti === 0 && b.shops & bit) {
        yLow = y0 + SHOP_H;
        const S = B('shop', cx, cz);
        const n = Math.max(1, Math.round(len / 8));
        for (let k = 0; k < n; k++) {
          const t0 = k / n, t1 = (k + 1) / n;
          const cell = rng.int(0, T.SHOP_COLS * T.SHOP_ROWS - 1);
          const cu = (cell % T.SHOP_COLS) / T.SHOP_COLS, cv = 1 - (Math.floor(cell / T.SHOP_COLS) + 1) / T.SHOP_ROWS;
          S.wall(ax + (bx - ax) * t0, az + (bz - az) * t0, ax + (bx - ax) * t1, az + (bz - az) * t1, y0, yLow,
            null, [cu + 0.002, cv + 0.004, cu + 1 / T.SHOP_COLS - 0.002, cv + 1 / T.SHOP_ROWS - 0.004]);
        }
      }
      const u1 = run + len / def.tileW;
      G.wall(ax, az, bx, bz, yLow, y1, tint, [run, yLow / def.tileH + vOff, u1, y1 / def.tileH + vOff]);
      run = u1;
    }
    R.floor(x0, z0, x1, z1, y1, ti === tiers.length - 1 ? ROOF : ROOF2);
  });

  // roof furniture
  const last = tiers[tiers.length - 1];
  const rx = (last[0] + last[2]) / 2, rz = (last[1] + last[3]) / 2, rw = last[2] - last[0], rd = last[3] - last[1];
  if (!b.simple && !b.noRoof) {
    if (b.h < 75 && b.style >= 2 && rw > 9 && rd > 9 && rng.chance(0.4)) {
      waterTower(ctx, rx + rng.range(-0.25, 0.25) * rw, top, rz + rng.range(-0.25, 0.25) * rd);
    } else if (rw > 10 && rd > 10) {
      const mw = rw * rng.range(0.25, 0.5), md = rd * rng.range(0.25, 0.5), mh = rng.range(2.5, 6);
      R.box(rx - mw / 2, top, rz - md / 2, rx + mw / 2, top + mh, rz + md / 2, ROOF2, 31, mulC(ROOF2, 1.25));
      if (b.h > 140 && rng.chance(0.5)) {
        R.box(rx - 0.25, top + mh, rz - 0.25, rx + 0.25, top + mh + rng.range(14, 40), rz + 0.25, C('#55585f'), 15);
        ctx.glow(rx, top + mh + 14, rz, '#ff3030', 1.6);
      }
    }
  }
  world.addBox(b.x0, 0, b.z0, b.x1, top, b.z1, F_ALL | F_BUILDING, b.style === 0 || b.style === 1 ? S_GLASS : S_CONCRETE);
  const rec = { x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1, h: b.h, style: b.style, nearTS: !!b.nearTS, noAds: !!b.noAds };
  ctx.buildings.push(rec);
  return rec;
}

// ---------------------------------------------------------------------------
// Lane lines and zebra crossings
// ---------------------------------------------------------------------------
function buildRoadMarkings(ctx) {
  const { B } = ctx;
  const Y = 0.02;
  const U = T.MARK_U;
  // strip running north-south: u across (x), v along z
  const stripNS = (x, z0, z1, w, u, period) => {
    B('marks', x, (z0 + z1) / 2).quad([x - w / 2, Y, z1], [x + w / 2, Y, z1], [x + w / 2, Y, z0], [x - w / 2, Y, z0],
      null, [u[0], 0, u[1], (z1 - z0) / period]);
  };
  // strip running east-west: u across (z), v along x
  const stripEW = (z, x0, x1, w, u, period) => {
    B('marks', (x0 + x1) / 2, z).quad([x1, Y, z + w / 2], [x1, Y, z - w / 2], [x0, Y, z - w / 2], [x0, Y, z + w / 2],
      null, [u[0], 0, u[1], (x1 - x0) / period]);
  };
  for (const a of AVENUES) {
    for (let i = 0; i < STREETS.length - 1; i++) {
      const z0 = STREETS[i].z + STREETS[i].hw + 1, z1 = STREETS[i + 1].z - STREETS[i + 1].hw - 1;
      const lanes = a.road >= 14 ? [-9, -6, 6, 9] : a.road >= 10 ? [-6, -3, 0, 3, 6] : [-4.5, -1.5, 1.5, 4.5];
      for (const off of lanes) stripNS(a.x + off, z0, z1, 0.16, U.dash, 9);
      stripNS(a.x - a.road + 0.5, z0, z1, 0.14, U.white, 4);
      stripNS(a.x + a.road - 0.5, z0, z1, 0.14, U.white, 4);
    }
  }
  for (const s of STREETS) {
    for (let i = 0; i < AVENUES.length - 1; i++) {
      const x0 = AVENUES[i].x + AVENUES[i].hw + 1, x1 = AVENUES[i + 1].x - AVENUES[i + 1].hw - 1;
      if (s.major) {
        stripEW(s.z - 0.18, x0, x1, 0.14, U.yellow, 4);
        stripEW(s.z + 0.18, x0, x1, 0.14, U.yellow, 4);
        stripEW(s.z - 4.5, x0, x1, 0.15, U.dash, 9);
        stripEW(s.z + 4.5, x0, x1, 0.15, U.dash, 9);
      } else {
        stripEW(s.z, x0, x1, 0.15, U.dash, 9);
      }
    }
  }
  // zebra crossings on all four arms of every intersection
  for (const a of AVENUES) {
    for (const s of STREETS) {
      const zs = s.z + s.road + 0.8, zn = s.z - s.road - 0.8;
      const cw = s.hw - s.road - 1.4;
      // across the avenue (stripes repeat along x)
      stripEW(zs + cw / 2, a.x - a.road, a.x + a.road, cw, U.zebra, 1.3);
      stripEW(zn - cw / 2, a.x - a.road, a.x + a.road, cw, U.zebra, 1.3);
      // across the street (stripes repeat along z)
      const xe = a.x + a.road + 0.8, xw = a.x - a.road - 0.8;
      const aw = a.hw - a.road - 1.4;
      stripNS(xe + aw / 2, s.z - s.road, s.z + s.road, aw, U.zebra, 1.3);
      stripNS(xw - aw / 2, s.z - s.road, s.z + s.road, aw, U.zebra, 1.3);
    }
  }
}
