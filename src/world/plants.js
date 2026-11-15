// Street trees and shrubs: tapering bark limbs with leaf-card crowns.
// Meshes are generated once (seeded, so identical every run) and stamped into the
// chunked 'bark' and 'foliage' builders with a per-tree yaw / scale / tint.
// Leaf cards sample the atlas painted by textures.js foliageTextures():
//   cells 0-3 honey locust sprigs, 4-7 plane leaves, 8-11 pear leaves, 12-15 dense clumps.

const rand = (s) => () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const clamp01 = (x) => Math.max(0, Math.min(1, x));

class MB {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.col = []; this.idx = []; }
  get nv() { return this.pos.length / 3; }
  v(p, n, u, v, c) { const i = this.nv; this.pos.push(p[0], p[1], p[2]); this.nor.push(n[0], n[1], n[2]); this.uv.push(u, v); this.col.push(c[0], c[1], c[2]); return i; }
  get tris() { return this.idx.length / 3; }
}

/** Tapered tube along a polyline. */
function tube(B, pts, radii, sides, col0, col1) {
  const nu = Math.max(1, Math.round((Math.PI * 2 * radii[0]) / 0.7));
  let vAcc = 0;
  const base = B.nv;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const t = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    const up = Math.abs(t[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
    const n = norm(cross(up, t)), bb = cross(t, n);
    if (i > 0) vAcc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]) / 0.7;
    const k = col0 + (col1 - col0) * (i / (pts.length - 1));
    for (let s = 0; s <= sides; s++) {
      const an = (s / sides) * Math.PI * 2, cs = Math.cos(an), sn = Math.sin(an);
      const d = [n[0] * cs + bb[0] * sn, n[1] * cs + bb[1] * sn, n[2] * cs + bb[2] * sn];
      B.v(add(pts[i], d, radii[i]), d, (s / sides) * nu, vAcc, [k, k, k]);
    }
  }
  const ring = sides + 1;
  for (let i = 0; i < pts.length - 1; i++) {
    for (let s = 0; s < sides; s++) {
      const a = base + i * ring + s, b = a + 1, c = a + ring + 1, d = a + ring;
      B.idx.push(a, d, c, a, c, b);
    }
  }
}

const SPECIES = {
  locust: { H: 2.7, r0: 0.15, limbs: 5, crownR: 3.1, ry: 0.85, size: 1.9, per: 8, cells: [0, 1, 2, 3], up: 0.14, elev: [0.45, 0.85], tip: 0.95, bark: [0.5, 0.46, 0.43] },
  plane: { H: 3.0, r0: 0.17, limbs: 5, crownR: 3.5, ry: 0.8, size: 2.5, per: 6, cells: [4, 5, 6, 7], up: 0.1, elev: [0.5, 0.95], tip: 1.0, bark: [1.15, 1.1, 0.95] },
  pear: { H: 2.3, r0: 0.12, limbs: 6, crownR: 2.2, ry: 1.25, size: 1.65, per: 8, cells: [8, 9, 10, 11], up: 0.3, elev: [0.25, 0.6], tip: 0.75, bark: [0.75, 0.66, 0.6] },
};
export const TREE_KINDS = ['locust', 'plane', 'pear'];

function cellUV(cell, flip, inset = 0.004) {
  const cx = cell % 4, cy = Math.floor(cell / 4);
  let u0 = cx / 4 + inset, u1 = (cx + 1) / 4 - inset;
  const v0 = 1 - (cy + 1) / 4 + inset, v1 = 1 - cy / 4 - inset;
  if (flip) [u0, u1] = [u1, u0];
  return [u0, v0, u1, v1];
}

/** One leaf card: bottom edge at `c - v*0.4s`, shading normal supplied. */
function card(L, c, nn, roll, s, cell, flip, shadeN, col) {
  const up = [0, 1, 0];
  let u = norm(cross(nn, Math.abs(nn[1]) > 0.97 ? [1, 0, 0] : up));
  let v = cross(u, nn);
  if (Math.abs(nn[1]) < 0.97) { // pull the card's long axis toward vertical so sprigs stand up
    const w = norm(add(up, nn, -dot(up, nn)));
    v = w; u = cross(w, nn);
  }
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const v2 = [v[0] * cr + u[0] * sr, v[1] * cr + u[1] * sr, v[2] * cr + u[2] * sr];
  const u2 = [u[0] * cr - v[0] * sr, u[1] * cr - v[1] * sr, u[2] * cr - v[2] * sr];
  const [a, b, d, e] = cellUV(cell, flip);
  const h = s * 0.5;
  const p0 = add(add(c, u2, -h), v2, -0.4 * s), p1 = add(add(c, u2, h), v2, -0.4 * s);
  const p2 = add(add(c, u2, h), v2, 0.6 * s), p3 = add(add(c, u2, -h), v2, 0.6 * s);
  const i = L.nv;
  L.v(p0, shadeN, a, b, col); L.v(p1, shadeN, d, b, col); L.v(p2, shadeN, d, e, col); L.v(p3, shadeN, a, e, col);
  L.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
}

const _cache = new Map();

/** Street-tree variant: { bark: MB, leaf: MB }. */
export function treeMesh(kind, seed) {
  const key = kind + seed;
  let m = _cache.get(key);
  if (m) return m;
  const P = SPECIES[kind], R = rand(seed * 7919 + kind.length * 131);
  const Bk = new MB(), L = new MB();
  const lean = [(R() - 0.5) * 0.35, (R() - 0.5) * 0.35];
  const H = P.H * (0.9 + R() * 0.25);
  const trunk = [];
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    trunk.push([lean[0] * t * t + Math.sin(t * 5 + seed) * 0.03, H * t, lean[1] * t * t]);
  }
  tube(Bk, trunk, [P.r0 * 1.3, P.r0 * 0.95, P.r0 * 0.82, P.r0 * 0.72], 6, 0.55, 1.0);
  const top = trunk[3];
  const terms = [];
  const nL = P.limbs;
  const az0 = R() * 6.28;
  for (let i = 0; i < nL; i++) {
    const az = az0 + (i / nL) * 6.283 + (R() - 0.5) * 0.7;
    const el = i === 0 ? 0.18 : P.elev[0] + R() * (P.elev[1] - P.elev[0]);
    let dir = norm([Math.sin(el) * Math.cos(az), Math.cos(el), Math.sin(el) * Math.sin(az)]);
    const len = P.crownR * (0.8 + R() * 0.3) * (i === 0 ? 0.9 : 1);
    let p = top.slice();
    const pts = [p], rad = [P.r0 * 0.62];
    for (let k = 1; k <= 3; k++) {
      dir = norm([dir[0] + (R() - 0.5) * 0.3, dir[1] + P.up * 1.3, dir[2] + (R() - 0.5) * 0.3]);
      p = add(p, dir, len / 3);
      pts.push(p); rad.push(P.r0 * 0.62 * (1 - k * 0.27));
    }
    tube(Bk, pts, rad, 3, 0.9, 1.0);
    terms.push({ p: pts[3], d: dir, w: 1.0 });
    for (const k of [2, 3]) { // leafy side twigs (cards only, no extra bark)
      const sd = norm([dir[0] + (R() - 0.5) * 1.8, dir[1] * 0.5 + 0.2, dir[2] + (R() - 0.5) * 1.8]);
      terms.push({ p: add(pts[k], sd, len * 0.3), d: sd, w: k === 3 ? 1.0 : 0.8 });
    }
  }
  // crown shading volume
  const cc = [lean[0], H + P.crownR * P.ry * 0.7, lean[1]];
  const dims = [P.crownR * 1.1, P.crownR * P.ry, P.crownR * 1.1];
  const per = P.per;
  for (const t of terms) {
    const n = Math.round(per * t.w);
    for (let k = 0; k < n; k++) {
      let o;
      do { o = [R() * 2 - 1, R() * 2 - 1, R() * 2 - 1]; } while (dot(o, o) > 1);
      const c = add(add(t.p, o, P.tip * 0.75), t.d, 0.25);
      const rel = [(c[0] - cc[0]) / dims[0], (c[1] - cc[1]) / dims[1], (c[2] - cc[2]) / dims[2]];
      const d = Math.min(1.25, Math.hypot(rel[0], rel[1], rel[2]));
      const sh = norm([rel[0], rel[1] + 0.45, rel[2]]);
      const nn = norm(add(sh, [R() - 0.5, R() - 0.5, R() - 0.5], 0.9));
      const ao = (0.42 + 0.58 * Math.pow(d, 0.9)) * (0.82 + 0.3 * clamp01((c[1] - H) / (P.crownR * 1.7)));
      const j = 0.9 + R() * 0.2, hue = R() - 0.5;
      card(L, c, nn, (R() - 0.5) * 1.5, P.size * (0.8 + R() * 0.45), P.cells[Math.floor(R() * P.cells.length)], R() < 0.5,
        norm(add(sh, nn, 0.25)), [ao * j * (1 + hue * 0.12), ao * j, ao * j * (1 - hue * 0.14)]);
    }
  }
  const bk = P.bark;
  for (let i = 0; i < Bk.col.length; i += 3) { Bk.col[i] *= bk[0]; Bk.col[i + 1] *= bk[1]; Bk.col[i + 2] *= bk[2]; }
  m = { bark: Bk, leaf: L };
  _cache.set(key, m);
  return m;
}

/** Dense clumpy dome (unit radius, y>=0) for planter shrubs. */
export function shrubMesh(seed) {
  const key = 'shrub' + seed;
  let m = _cache.get(key);
  if (m) return m;
  const R = rand(seed * 104729 + 17), L = new MB();
  for (let i = 0; i < 34; i++) {
    const a = R() * 6.283, el = Math.pow(R(), 0.7) * 1.45, r = i < 8 ? 0.45 : 0.82 + R() * 0.15;
    const dir = [Math.cos(el) * Math.cos(a), Math.sin(el), Math.cos(el) * Math.sin(a)];
    const c = [dir[0] * r, dir[1] * r * 0.95 + 0.1, dir[2] * r];
    const sh = norm([dir[0], dir[1] + 0.35, dir[2]]);
    const ao = 0.5 + 0.5 * Math.min(1, el / 1.0 + R() * 0.2);
    card(L, c, norm(add(sh, [R() - 0.5, R() - 0.5, R() - 0.5], 0.6)), R() * 6.28, 0.95 + R() * 0.35, 12 + Math.floor(R() * 4), R() < 0.5, sh, [ao, ao, ao]);
  }
  m = { bark: new MB(), leaf: L };
  _cache.set(key, m);
  return m;
}

/** Clipped hedge: rounded box of length len (x), width wd (z), height h. */
export function hedgeMesh(len, wd, h, seed) {
  const R = rand(seed * 31337 + 5), L = new MB();
  const step = 0.5;
  const put = (c, nrm, ao) => {
    const nn = norm(add(nrm, [R() - 0.5, R() - 0.5, R() - 0.5], 0.5));
    card(L, c, nn, R() * 6.28, 0.78 + R() * 0.3, 12 + Math.floor(R() * 4), R() < 0.5, norm(add(nrm, [0, 0.3, 0])), [ao, ao, ao]);
  };
  for (let x = step / 2; x < len; x += step) {
    const xx = x - len / 2 + (R() - 0.5) * 0.15;
    for (let z = step / 2; z < wd; z += step) put([xx, h - 0.1 + R() * 0.1, z - wd / 2 + (R() - 0.5) * 0.15], [0, 1, 0], 0.95 + R() * 0.1);
    for (let y = 0.3; y < h - 0.1; y += step) {
      const ao = 0.55 + 0.45 * (y / h);
      put([xx, y, -wd / 2 - 0.05], [0, 0.1, -1], ao);
      put([xx, y, wd / 2 + 0.05], [0, 0.1, 1], ao);
    }
  }
  for (let y = 0.3; y < h - 0.1; y += step) for (const sx of [-1, 1]) put([sx * (len / 2 + 0.05), y, 0], [sx, 0.1, 0], 0.55 + 0.45 * (y / h));
  return { bark: new MB(), leaf: L };
}

/** Stamp a mesh into a Geo builder. tint: [r,g,b] multiplier. */
export function emit(G, mesh, x, y, z, yaw, sx, sy, sz, tint = [1, 1, 1]) {
  if (!mesh.nv) return;
  G._reserve(mesh.nv, mesh.idx.length);
  G.setXform(x, y, z, yaw);
  const base = G.nv, p = mesh.pos, n = mesh.nor, u = mesh.uv, c = mesh.col, col = [0, 0, 0];
  for (let i = 0; i < mesh.nv; i++) {
    col[0] = c[i * 3] * tint[0]; col[1] = c[i * 3 + 1] * tint[1]; col[2] = c[i * 3 + 2] * tint[2];
    G.vert(p[i * 3] * sx, p[i * 3 + 1] * sy, p[i * 3 + 2] * sz, n[i * 3], n[i * 3 + 1], n[i * 3 + 2], u[i * 2], u[i * 2 + 1], col);
  }
  for (let i = 0; i < mesh.idx.length; i++) G.idx[G.ni++] = base + mesh.idx[i];
  G.resetXform();
}

/** Deterministic 0..1 from a position (never touches the city RNG). */
export const hash2 = (x, z, k = 0) => { const v = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453; return v - Math.floor(v); };
