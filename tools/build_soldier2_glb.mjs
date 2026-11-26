#!/usr/bin/env node
// Procedural modern infantry soldier (LOD0 ~17.5k tris, LOD1 ~5k tris),
// 2048 PBR texture set (color, normal, ORM) with WebP (EXT_texture_webp),
// 25-bone humanoid A-pose skeleton (-Z forward, +Y up), smooth skin weights,
// and 23 seamless 30 fps in-place animations.
//
// Outputs:
//   src/chars/soldier2_asset.js  (base64 GLB + metadata, <= 4 MB)
//
// Usage: node tools/build_soldier2_glb.mjs
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_JS = resolve(ROOT, 'src/chars/soldier2_asset.js');
const TMP_DIR = '/tmp/soldier2_build';
mkdirSync(TMP_DIR, { recursive: true });

// ============================================================================
// 1. SKELETON (25 bones, A-pose, model faces -Z, +Y up, +X right, height 1.83m)
// ============================================================================
// [name, parentIndex, worldX, worldY, worldZ]
const BONES = [
  ['hips',       -1,  0.000, 0.960,  0.000], // 0
  ['spine',       0,  0.000, 1.070,  0.000], // 1
  ['chest',       1,  0.000, 1.270,  0.000], // 2
  ['neck',        2,  0.000, 1.520,  0.000], // 3
  ['head',        3,  0.000, 1.610,  0.000], // 4

  ['clavicleL',   2, -0.060, 1.485,  0.000], // 5
  ['upperArmL',   5, -0.205, 1.475,  0.000], // 6
  ['forearmL',    6, -0.434, 1.315,  0.015], // 7  (A-pose ~35 deg down)
  ['handL',       7, -0.647, 1.166,  0.000], // 8
  ['thumbL',      8, -0.675, 1.150, -0.025], // 9
  ['fingersL',    8, -0.715, 1.120,  0.005], // 10

  ['clavicleR',   2,  0.060, 1.485,  0.000], // 11
  ['upperArmR',  11,  0.205, 1.475,  0.000], // 12
  ['forearmR',   12,  0.434, 1.315,  0.015], // 13
  ['handR',      13,  0.647, 1.166,  0.000], // 14
  ['thumbR',     14,  0.675, 1.150, -0.025], // 15
  ['fingersR',   14,  0.715, 1.120,  0.005], // 16

  ['thighL',      0, -0.102, 0.935,  0.000], // 17
  ['shinL',      17, -0.108, 0.505, -0.005], // 18
  ['footL',      18, -0.112, 0.085,  0.010], // 19
  ['toeL',       19, -0.112, 0.028, -0.125], // 20

  ['thighR',      0,  0.102, 0.935,  0.000], // 21
  ['shinR',      21,  0.108, 0.505, -0.005], // 22
  ['footR',      22,  0.112, 0.085,  0.010], // 23
  ['toeR',       23,  0.112, 0.028, -0.125], // 24
];

const BI = Object.fromEntries(BONES.map((b, i) => [b[0], i]));
const REST_W = BONES.map((b) => [b[2], b[3], b[4]]);
const REST_L = BONES.map((b) => {
  if (b[1] < 0) return [b[2], b[3], b[4]];
  const p = BONES[b[1]];
  return [b[2] - p[2], b[3] - p[3], b[4] - p[4]];
});

// ============================================================================
// 2. MATH & QUATERNION HELPERS
// ============================================================================
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { const c = clamp(t, 0, 1); return c * c * (3 - 2 * c); };
const sstep = (a, b, x) => smooth((x - a) / (b - a));
const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = vlen(a); return l > 1e-8 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0]; };

function qNorm(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
function qMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
function qConj(q) { return [-q[0], -q[1], -q[2], q[3]]; }
function qAxisAngle(ax, ang) {
  const s = Math.sin(ang * 0.5), c = Math.cos(ang * 0.5);
  const u = norm(ax);
  return [u[0] * s, u[1] * s, u[2] * s, c];
}
// Euler YXZ -> quaternion
function qEulerYXZ(rx, ry, rz) {
  const cx = Math.cos(rx * 0.5), sx = Math.sin(rx * 0.5);
  const cy = Math.cos(ry * 0.5), sy = Math.sin(ry * 0.5);
  const cz = Math.cos(rz * 0.5), sz = Math.sin(rz * 0.5);
  return qNorm([
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ]);
}
function qFromUnitVectors(u, v) {
  const a = norm(u), b = norm(v);
  let r = dot(a, b) + 1;
  if (r < 1e-6) {
    const ortho = Math.abs(a[0]) > Math.abs(a[2]) ? [-a[1], a[0], 0] : [0, -a[2], a[1]];
    return qNorm([ortho[0], ortho[1], ortho[2], 0]);
  }
  const c = cross(a, b);
  return qNorm([c[0], c[1], c[2], r]);
}
function qApply(q, v) {
  const x = v[0], y = v[1], z = v[2];
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}
function qFromBasis(x, y, z) {
  // columns x, y, z -> quaternion
  const m00 = x[0], m01 = y[0], m02 = z[0];
  const m10 = x[1], m11 = y[1], m12 = z[1];
  const m20 = x[2], m21 = y[2], m22 = z[2];
  const tr = m00 + m11 + m22;
  let q;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1.0) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1.0 + m00 - m11 - m22) * 2;
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1.0 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1.0 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  return qNorm(q);
}

// ============================================================================
// 3. UV ATLAS REGIONS (single 2048x2048 texture atlas)
// ============================================================================
// Each region: [u0, v0, u1, v1] in [0, 1] (v=0 is top of image in glTF)
const UV_REG = {
  camo:     [0.01, 0.01, 0.49, 0.49], // uniform combat shirt & trousers
  helmet:   [0.51, 0.01, 0.74, 0.24], // helmet camo cover
  balaclava:[0.76, 0.01, 0.99, 0.24], // ribbed dark balaclava / gaiter
  gear:     [0.51, 0.26, 0.99, 0.49], // coyote plate carrier + MOLLE webbing
  gearDark: [0.01, 0.51, 0.32, 0.74], // darker coyote pouches, straps, dump pouch
  boot:     [0.34, 0.51, 0.65, 0.74], // suede/leather combat boots + laces + dirt
  glove:    [0.67, 0.51, 0.99, 0.74], // tactical gloves + knuckle texture
  pads:     [0.01, 0.76, 0.24, 0.99], // knee/elbow hard-shell pads + straps
  sole:     [0.26, 0.76, 0.49, 0.99], // black rubber lugged boot soles
  metal:    [0.51, 0.76, 0.66, 0.99], // gunmetal buckles, rails, NVG mount
  lens:     [0.68, 0.76, 0.83, 0.99], // tinted ballistic goggles lens & frame
  flag:     [0.85, 0.76, 0.99, 0.86], // shoulder US flag / unit patch
  tape:     [0.85, 0.88, 0.99, 0.96], // chest USMC name tape
};

// ============================================================================
// 4. PROCEDURAL MESH BUILDER (supports LOD0 high-res and LOD1 low-res)
// ============================================================================
class MeshBuilder {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.joints = [];
    this.weights = [];
    this.idx = [];
  }

  addPart(verts, faces, uvs, regName, weightFn) {
    const reg = UV_REG[regName];
    const base = this.pos.length / 3;
    const nV = verts.length;
    const accN = new Float32Array(nV * 3);
    for (const f of faces) {
      const a = verts[f[0]], b = verts[f[1]], c = verts[f[2]];
      const ab = sub(b, a), ac = sub(c, a);
      const fn = cross(ab, ac);
      for (const vi of f) {
        accN[vi * 3] += fn[0];
        accN[vi * 3 + 1] += fn[1];
        accN[vi * 3 + 2] += fn[2];
      }
    }
    for (let i = 0; i < nV; i++) {
      const p = verts[i];
      this.pos.push(p[0], p[1], p[2]);
      const n = norm([accN[i * 3], accN[i * 3 + 1], accN[i * 3 + 2]]);
      this.nor.push(n[0], n[1], n[2]);
      const u = uvs[i][0], v = uvs[i][1];
      this.uv.push(lerp(reg[0], reg[2], clamp(u, 0, 1)), lerp(reg[1], reg[3], clamp(v, 0, 1)));
      const ws = weightFn(p[0], p[1], p[2]).filter((w) => w[1] > 1e-4);
      ws.sort((a, b) => b[1] - a[1]);
      const top = ws.slice(0, 4);
      let sum = 0;
      for (const w of top) sum += w[1];
      if (sum < 1e-6) { top.push([0, 1]); sum = 1; }
      for (let k = 0; k < 4; k++) {
        this.joints.push(k < top.length ? top[k][0] : 0);
        this.weights.push(k < top.length ? top[k][1] / sum : 0);
      }
    }
    for (const f of faces) {
      if (f.length === 3) {
        this.idx.push(base + f[0], base + f[1], base + f[2]);
      } else if (f.length === 4) {
        this.idx.push(base + f[0], base + f[1], base + f[2], base + f[0], base + f[2], base + f[3]);
      }
    }
  }
}

function superellipse(seg, p = 2.0) {
  const out = [];
  for (let k = 0; k <= seg; k++) {
    const t = (2 * Math.PI * k) / seg;
    const c = Math.cos(t), s = Math.sin(t);
    out.push([Math.sign(c) * Math.pow(Math.abs(c), 2 / p), Math.sign(s) * Math.pow(Math.abs(s), 2 / p)]);
  }
  return out;
}

// Loft a tube along a 3D path with per-ring (ra, rb_pos, rb_neg) radii and clean UVs
function addTube(mb, path, raList, rbList, seg, p, ref, regName, weightFn, caps = [true, true], loop = false) {
  const n = path.length;
  const se = superellipse(seg, p);
  const verts = [], uvs = [], faces = [];
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + vlen(sub(path[i], path[i - 1])));
  const totalLen = cum[n - 1] || 1;
  const cols = seg + 1;

  for (let i = 0; i < n; i++) {
    const prev = path[loop ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const next = path[loop ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const T = norm(sub(next, prev));
    let e1 = sub(ref, mul(T, dot(ref, T)));
    if (vlen(e1) < 1e-4) e1 = sub([0, 0, 1], mul(T, T[2]));
    e1 = norm(e1);
    const e2 = cross(T, e1);
    const ra = Array.isArray(raList) ? raList[i] : raList;
    const rb = Array.isArray(rbList) ? rbList[i] : rbList;
    for (let k = 0; k < cols; k++) {
      const [c, s] = se[k];
      const a = Array.isArray(ra) ? (c >= 0 ? ra[0] : ra[1]) : ra;
      const b = Array.isArray(rb) ? (s >= 0 ? rb[0] : rb[1]) : rb;
      verts.push(add(path[i], add(mul(e1, c * a), mul(e2, s * b))));
      uvs.push([k / seg, cum[i] / totalLen]);
    }
  }
  const rings = loop ? n : n - 1;
  for (let i = 0; i < rings; i++) {
    const j = (i + 1) % n;
    for (let k = 0; k < seg; k++) {
      faces.push([i * cols + k, j * cols + k, j * cols + k + 1, i * cols + k + 1]);
    }
  }
  if (!loop && caps[0]) {
    const ci = verts.length;
    verts.push(path[0]); uvs.push([0.5, 0.0]);
    for (let k = 0; k < seg; k++) faces.push([ci, k + 1, k]);
  }
  if (!loop && caps[1]) {
    const ci = verts.length;
    verts.push(path[n - 1]); uvs.push([0.5, 1.0]);
    const r0 = (n - 1) * cols;
    for (let k = 0; k < seg; k++) faces.push([ci, r0 + k, r0 + k + 1]);
  }
  mb.addPart(verts, faces, uvs, regName, weightFn);
}

// Rounded bevelled box (clean subdivided box projected onto superellipsoid)
function addRoundedBox(mb, size, center, rotEuler, seg, p, regName, weightFn) {
  const [w, h, d] = size;
  const q = rotEuler ? qEulerYXZ(rotEuler[0], rotEuler[1], rotEuler[2]) : [0, 0, 0, 1];
  const verts = [], uvs = [], faces = [];
  const N = Math.max(1, seg);
  // 6 faces of a subdivided cube
  const faceDefs = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
    [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
    [[0, 0, 1], [0, 1, 0], [-1, 0, 0]],
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[1, 0, 0], [0, 0, 1], [0, -1, 0]],
  ];
  const invP = 1 / p;
  for (const [uAx, vAx, nAx] of faceDefs) {
    const base = verts.length;
    for (let j = 0; j <= N; j++) {
      const fv = (j / N) * 2 - 1;
      for (let i = 0; i <= N; i++) {
        const fu = (i / N) * 2 - 1;
        let x = uAx[0] * fu + vAx[0] * fv + nAx[0];
        let y = uAx[1] * fu + vAx[1] * fv + nAx[1];
        let z = uAx[2] * fu + vAx[2] * fv + nAx[2];
        const lp = Math.pow(Math.pow(Math.abs(x), p) + Math.pow(Math.abs(y), p) + Math.pow(Math.abs(z), p), invP) || 1;
        const local = [(x / lp) * w * 0.5, (y / lp) * h * 0.5, (z / lp) * d * 0.5];
        verts.push(add(center, qApply(q, local)));
        uvs.push([i / N, j / N]);
      }
    }
    const stride = N + 1;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        faces.push([base + j * stride + i, base + j * stride + i + 1, base + (j + 1) * stride + i + 1, base + (j + 1) * stride + i]);
      }
    }
  }
  mb.addPart(verts, faces, uvs, regName, weightFn);
}

// Smooth skinning helper: blend along a 3-bone chain
function chainWeightFn(joints, boneIds, halfWidths) {
  const cum = [0];
  for (let i = 1; i < joints.length; i++) cum.push(cum[i - 1] + vlen(sub(joints[i], joints[i - 1])));
  return (x, y, z) => {
    const p = [x, y, z];
    let bestD = 1e9, bestS = 0;
    for (let i = 0; i < joints.length - 1; i++) {
      const a = joints[i], b = joints[i + 1];
      const ab = sub(b, a), L = vlen(ab) || 1;
      const t = clamp(dot(sub(p, a), ab) / (L * L), 0, 1);
      const q = add(a, mul(ab, t));
      const d = vlen(sub(p, q));
      if (d < bestD) { bestD = d; bestS = cum[i] + t * L; }
    }
    const out = [];
    for (let i = 0; i < boneIds.length; i++) {
      let w = 1;
      if (i > 0) w *= sstep(cum[i] - halfWidths[i - 1], cum[i] + halfWidths[i - 1], bestS);
      if (i < boneIds.length - 1) w *= (1 - sstep(cum[i + 1] - halfWidths[i], cum[i + 1] + halfWidths[i], bestS));
      if (w > 1e-4) out.push([boneIds[i], w]);
    }
    return out.length ? out : [[boneIds[0], 1]];
  };
}

const rigidW = (name) => () => [[BI[name], 1]];

function buildSoldierMesh(lod) {
  const mb = new MeshBuilder();
  // Detail multipliers for LOD0 (~17k tris) vs LOD1 (~5k tris)
  const S = lod === 0 ? 2.05 : 0.78;
  const seg = (n) => Math.max(6, Math.round(n * S));
  const bseg = (n) => Math.max(1, Math.round(n * (lod === 0 ? 2.0 : 0.75)));

  // ---- TORSO (hips -> spine -> chest -> collar, with waist blousing above belt) ------
  const torsoRows = [
    // [y, cz, rx, rFront, rBack]
    [0.80,  0.006, 0.148, 0.104, 0.114],
    [0.86,  0.006, 0.172, 0.114, 0.122],
    [0.93,  0.005, 0.180, 0.118, 0.126],
    [1.00,  0.003, 0.174, 0.112, 0.116],
    [1.06,  0.001, 0.184, 0.120, 0.122], // subtle shirt blousing fold over battle belt
    [1.11,  0.000, 0.168, 0.108, 0.110],
    [1.18, -0.002, 0.172, 0.112, 0.112],
    [1.28, -0.004, 0.184, 0.118, 0.114],
    [1.38, -0.005, 0.198, 0.120, 0.112],
    [1.46, -0.002, 0.200, 0.108, 0.104],
    [1.51,  0.000, 0.150, 0.084, 0.084],
    [1.545, 0.002, 0.078, 0.068, 0.070],
  ];
  const torsoW = (x, y) => {
    const wNeck = sstep(1.48, 1.54, y);
    const wChest = sstep(1.17, 1.32, y) * (1 - wNeck);
    const wSpine = sstep(1.01, 1.13, y) * (1 - wChest) * (1 - wNeck);
    const wHips = Math.max(0, 1 - wNeck - wChest - wSpine);
    return [[BI.hips, wHips], [BI.spine, wSpine], [BI.chest, wChest], [BI.neck, wNeck]];
  };
  addTube(
    mb,
    torsoRows.map((r) => [0, r[0], r[1]]),
    torsoRows.map((r) => r[2]),
    torsoRows.map((r) => [r[4], r[3]]),
    seg(22), 2.35, [1, 0, 0], 'camo', torsoW, [false, false]
  );
  // Solid pelvis / combat trouser seat extending 7cm below thigh joint (0.935) & overlapping torso/belt
  const pelvisRows = [
    [0.79, 0.006, 0.112, 0.090, 0.098],
    [0.84, 0.006, 0.168, 0.112, 0.120],
    [0.91, 0.005, 0.184, 0.122, 0.130],
    [0.98, 0.004, 0.182, 0.120, 0.126],
    [1.06, 0.002, 0.172, 0.112, 0.116],
  ];
  addTube(
    mb,
    pelvisRows.map((r) => [0, r[0], r[1]]),
    pelvisRows.map((r) => r[2]),
    pelvisRows.map((r) => [r[4], r[3]]),
    seg(20), 2.4, [1, 0, 0], 'camo', rigidW('hips'), [true, false]
  );

  // ---- NECK & BALACLAVA HEAD (1.52m -> 1.77m, tucked inside helmet shell) ---
  const headRows = [
    [1.515,  0.002, 0.062, 0.062, 0.064],
    [1.560,  0.000, 0.056, 0.058, 0.060],
    [1.600, -0.014, 0.064, 0.072, 0.070],
    [1.635, -0.008, 0.072, 0.086, 0.082],
    [1.675, -0.002, 0.075, 0.092, 0.088],
    [1.715,  0.000, 0.070, 0.088, 0.082],
    [1.750,  0.004, 0.058, 0.072, 0.068],
    [1.772,  0.006, 0.038, 0.044, 0.044],
    [1.784,  0.008, 0.016, 0.018, 0.024],
  ];
  // Separate dark tactical collar/gaiter ridge at base of neck for clean helmet-to-collar separation
  addTube(mb, [[0, 1.522, 0.002], [0, 1.562, 0.002], [0, 1.595, -0.004]], [0.068, 0.064, 0.066], [0.068, 0.064, 0.066], seg(16), 2.2, [1, 0, 0], 'pads', rigidW('chest'));
  // Rigid split at collar (1.535m) so 1P head-hide (head.scale = 0.001) never stretches neck triangles
  const headW = (x, y) => (y > 1.535 ? [[BI.head, 1]] : [[BI.chest, 1]]);
  addTube(
    mb,
    headRows.map((r) => [0, r[0], r[1]]),
    headRows.map((r) => r[2]),
    headRows.map((r) => [r[4], r[3]]),
    seg(18), 2.15, [1, 0, 0], 'balaclava', headW
  );
  // Sculpted tactical lower-face half-mask / jaw & nose guard (replaces flat black slab look)
  addRoundedBox(mb, [0.028, 0.044, 0.034], [0, 1.676, -0.100], [0.24, 0, 0], bseg(2), 2.6, 'balaclava', rigidW('head'));
  addRoundedBox(mb, [0.118, 0.068, 0.048], [0, 1.628, -0.082], [-0.14, 0, 0], bseg(2), 2.8, 'pads', rigidW('head'));

  // ---- BALLISTIC GOGGLES / TACTICAL VISOR + HELMET STRAP -------------------
  const gogPath = [];
  const gSteps = lod === 0 ? 14 : 8;
  for (let k = 0; k <= gSteps; k++) {
    const ph = (-76 + (152 * k) / gSteps) * (Math.PI / 180);
    gogPath.push([0.098 * Math.sin(ph), 1.704, -0.114 * Math.cos(ph)]);
  }
  addTube(mb, gogPath, 0.029, 0.007, seg(8), 3.6, [0, 1, 0], 'lens', rigidW('head'));
  // Chunky ballistic goggle frame rims (top brow shield + lower cheek rim + center nose bridge)
  addTube(mb, gogPath.map((p) => [p[0], p[1] + 0.027, p[2] - 0.003]), 0.008, 0.009, 6, 2.6, [0, 1, 0], 'pads', rigidW('head'));
  addTube(mb, gogPath.map((p) => [p[0], p[1] - 0.026, p[2] - 0.003]), 0.007, 0.008, 6, 2.6, [0, 1, 0], 'pads', rigidW('head'));
  // Elastic goggle strap wrapping around rear of helmet
  if (lod === 0) {
    const strapPath = [];
    for (let k = 0; k <= 12; k++) {
      const ph = (76 + (208 * k) / 12) * (Math.PI / 180);
      strapPath.push([0.119 * Math.sin(ph), 1.712, 0.008 - 0.138 * Math.cos(ph)]);
    }
    addTube(mb, strapPath, 0.015, 0.005, 6, 3.0, [0, 1, 0], 'gearDark', rigidW('head'));
  }

  // ---- TACTICAL HELMET (Ops-Core FAST high-cut solid shell + 10mm rim + lining, top at 1.838m)
  const hSeg = seg(24), hRings = lod === 0 ? 9 : 5;
  const hVerts = [], hUvs = [], hFaces = [];
  const colsH = hSeg + 1;
  // Outer dome rings (j = 0..hRings, bottom rim -> crown)
  for (let j = 0; j <= hRings; j++) {
    const vFrac = j / hRings;
    for (let k = 0; k <= hSeg; k++) {
      const th = (2 * Math.PI * k) / hSeg; // 0 = front (-Z), +pi/2 = +X
      const c = Math.cos(th), s = Math.sin(th);
      const earCut = Math.exp(-Math.pow((Math.abs(s) - 0.90) * 3.4, 2)) * 0.040;
      const rimY = 1.678 + 0.044 * Math.max(0, c) - 0.028 * Math.max(0, -c) + earCut;
      const y = lerp(rimY, 1.838, Math.sin(vFrac * Math.PI * 0.5));
      const tDome = clamp((y - 1.672) / 0.166, 0, 1);
      const rad = Math.sqrt(Math.max(0.001, 1 - tDome * tDome * 0.985));
      const rx = 0.116 * rad;
      const rz = (c >= 0 ? 0.128 : 0.137) * rad;
      hVerts.push([rx * s, y, 0.008 - rz * c]);
      hUvs.push([k / hSeg, vFrac]);
    }
  }
  // Outward-facing winding: at +X (th=+pi/2), +k is +Z and +j is +Y -> (+Y x +Z) = +X outward!
  for (let j = 0; j < hRings; j++) {
    for (let k = 0; k < hSeg; k++) {
      hFaces.push([j * colsH + k, (j + 1) * colsH + k, (j + 1) * colsH + k + 1, j * colsH + k + 1]);
    }
  }
  // Solid 10 mm ballistic shell edge rim + recessed dark interior skirt ring so rim shows clearly from rear/side
  const rimInnerIdx = hVerts.length;
  for (let k = 0; k <= hSeg; k++) {
    const o = hVerts[k];
    hVerts.push([o[0] * 0.89, o[1] + 0.002, (o[2] - 0.008) * 0.90 + 0.008]);
    hUvs.push([k / hSeg, 0.02]);
  }
  const rimUpIdx = hVerts.length;
  for (let k = 0; k <= hSeg; k++) {
    const o = hVerts[k];
    hVerts.push([o[0] * 0.86, o[1] + 0.036, (o[2] - 0.008) * 0.87 + 0.008]);
    hUvs.push([k / hSeg, 0.08]);
  }
  for (let k = 0; k < hSeg; k++) {
    // Bottom thickness lip facing downward/outward + inner wall facing inward
    hFaces.push([k, k + 1, rimInnerIdx + k + 1, rimInnerIdx + k]);
    hFaces.push([rimInnerIdx + k, rimInnerIdx + k + 1, rimUpIdx + k + 1, rimUpIdx + k]);
  }
  mb.addPart(hVerts, hFaces, hUvs, 'helmet', rigidW('head'));

  // Molded ballistic helmet rim trim tube accentuating the high-cut & nape silhouette edge
  if (lod === 0) {
    const rimPath = [];
    for (let k = 0; k <= hSeg; k++) rimPath.push(hVerts[k]);
    addTube(mb, rimPath, 0.006, 0.007, 6, 2.4, [0, 1, 0], 'pads', rigidW('head'), [false, false], true);
  }

  // Helmet front 3-hole NVG shroud, rear Velcro/counterweight battery pouch, side ARC rails, Peltor ear-pro cups, boom mic, chinstrap
  addRoundedBox(mb, [0.068, 0.052, 0.026], [0, 1.776, -0.118], [-0.36, 0, 0], bseg(2), 2.3, 'metal', rigidW('head'));
  addRoundedBox(mb, [0.090, 0.050, 0.032], [0, 1.714,  0.132], [ 0.22, 0, 0], bseg(2), 2.5, 'gearDark', rigidW('head'));
  for (const s of [-1, 1]) {
    addRoundedBox(mb, [0.016, 0.024, 0.122], [s * 0.114, 1.745, 0.002], [0, 0, 0], bseg(2), 2.5, 'gearDark', rigidW('head'));
    // Ear-pro headset cup
    addRoundedBox(mb, [0.034, 0.084, 0.070], [s * 0.104, 1.672, 0.006], [0, 0, 0], bseg(2), 2.1, 'gearDark', rigidW('head'));
    addRoundedBox(mb, [0.012, 0.054, 0.046], [s * 0.119, 1.672, 0.006], [0, 0, 0], 1, 2.1, 'pads', rigidW('head'));
  }
  if (lod === 0) {
    // Boom mic on left headset
    addTube(mb, [[-0.108, 1.660, -0.005], [-0.105, 1.648, -0.055], [-0.082, 1.638, -0.095], [-0.045, 1.634, -0.106]], 0.004, 0.004, 6, 2, [0, 1, 0], 'pads', rigidW('head'));
    // Chinstrap
    addTube(mb, [[-0.095, 1.70, 0.01], [-0.086, 1.64, -0.025], [-0.055, 1.59, -0.065], [0, 1.578, -0.075], [0.055, 1.59, -0.065], [0.086, 1.64, -0.025], [0.095, 1.70, 0.01]], 0.007, 0.003, 6, 2.5, [0, 0, 1], 'gearDark', rigidW('head'));
  }

  // ---- ANATOMICAL SAPI PLATE CARRIER, CONTOURED POUCHES, BATTLE BELT -------
  // Curved swimmer-cut front & rear plate bags hugging torso contour (no rigid square brick)
  addTube(mb, [
    [0, 1.185, -0.120], [0, 1.265, -0.132], [0, 1.365, -0.130], [0, 1.445, -0.118], [0, 1.488, -0.105],
  ], [0.148, 0.156, 0.150, 0.124, 0.096], [0.026, 0.030, 0.028, 0.024, 0.018], seg(16), 2.5, [1, 0, 0], 'gear', rigidW('chest'));
  addTube(mb, [
    [0, 1.185,  0.120], [0, 1.265,  0.132], [0, 1.365,  0.128], [0, 1.445,  0.116], [0, 1.488,  0.102],
  ], [0.146, 0.154, 0.148, 0.124, 0.098], [0.026, 0.030, 0.028, 0.024, 0.018], seg(16), 2.5, [1, 0, 0], 'gear', rigidW('chest'));
  // Cummerbund wrapping lower ribs
  addTube(mb, [[0, 1.14, 0], [0, 1.22, 0], [0, 1.30, 0]], [0.184, 0.190, 0.186], [0.128, 0.134, 0.130], seg(20), 2.8, [1, 0, 0], 'gearDark', (x, y) => {
    const wc = sstep(1.13, 1.24, y);
    return [[BI.chest, wc], [BI.spine, 1 - wc]];
  });
  // Padded shoulder straps
  for (const s of [-1, 1]) {
    addTube(mb, [
      [s * 0.092, 1.475, -0.124], [s * 0.098, 1.522, -0.075],
      [s * 0.106, 1.545,  0.000], [s * 0.098, 1.522,  0.075], [s * 0.092, 1.475,  0.124],
    ], 0.034, 0.012, seg(8), 2.4, [1, 0, 0], 'gear', rigidW('chest'));
  }
  // 3 contoured M4 magazine pouches + bungee retention flaps + upper admin pouch + name tape
  for (const mx of [-0.086, 0.0, 0.086]) {
    const rotY = mx === 0 ? 0 : (mx < 0 ? 0.16 : -0.16);
    const mzOff = mx === 0 ? -0.168 : -0.160;
    addRoundedBox(mb, [0.074, 0.132, 0.042], [mx, 1.255, mzOff], [0.04, rotY, 0], bseg(2), 2.6, 'gearDark', rigidW('chest'));
    if (lod === 0) {
      addRoundedBox(mb, [0.076, 0.036, 0.046], [mx, 1.306, mzOff - 0.002], [0.04, rotY, 0], 1, 2.4, 'gear', rigidW('chest'));
    }
  }
  addRoundedBox(mb, [0.138, 0.066, 0.024], [0.015, 1.396, -0.158], [0.06, 0, 0], bseg(2), 2.6, 'gearDark', rigidW('chest'));
  // Chest name tape
  addRoundedBox(mb, [0.148, 0.032, 0.008], [0, 1.452, -0.142], [0.12, 0, 0], 1, 2.4, 'tape', rigidW('chest'));
  // Left side radio + whip antenna
  addRoundedBox(mb, [0.050, 0.138, 0.064], [-0.196, 1.215, -0.01], [0, 0, 0.06], bseg(2), 2.6, 'gearDark', rigidW('chest'));
  if (lod === 0) {
    addTube(mb, [[-0.198, 1.29, 0.015], [-0.205, 1.45, 0.04], [-0.210, 1.62, 0.065]], 0.005, 0.005, 6, 2, [1, 0, 0], 'pads', rigidW('chest'));
  }
  // Contoured back hydration pack + IFAK med pouch
  addTube(mb, [
    [0, 1.21, 0.168], [0, 1.29, 0.178], [0, 1.39, 0.174], [0, 1.465, 0.156],
  ], [0.106, 0.112, 0.104, 0.082], [0.030, 0.034, 0.032, 0.022], seg(14), 2.5, [1, 0, 0], 'gearDark', rigidW('chest'));
  addRoundedBox(mb, [0.118, 0.098, 0.046], [0.065, 1.205, 0.174], [0, -0.12, 0], bseg(2), 2.6, 'gear', rigidW('chest'));

  // Battle belt + cobra buckle + contoured Kydex holster + angled dump pouch
  addTube(mb, [[0, 0.990, 0.002], [0, 1.035, 0.002], [0, 1.080, 0.001]], [0.186, 0.190, 0.182], [0.126, 0.130, 0.124], seg(20), 2.8, [1, 0, 0], 'gearDark', rigidW('hips'), [false, false]);
  addRoundedBox(mb, [0.054, 0.036, 0.014], [0, 1.035, -0.132], [0, 0, 0], 1, 2.8, 'metal', rigidW('hips'));
  addRoundedBox(mb, [0.046, 0.174, 0.082], [0.182, 0.945, 0.015], [0, 0, -0.05], bseg(2), 2.6, 'pads', rigidW('hips'));
  addRoundedBox(mb, [0.046, 0.128, 0.094], [-0.184, 0.965, 0.036], [0.08, 0, 0.06], bseg(2), 2.4, 'gearDark', rigidW('hips'));

  // ---- ARMS (A-pose along clavicle -> upperArm -> forearm -> hand) ---------
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? -1 : 1;
    const jClav = REST_W[BI['clavicle' + side]];
    const jUp   = REST_W[BI['upperArm' + side]];
    const jFore = REST_W[BI['forearm' + side]];
    const jHand = REST_W[BI['hand' + side]];
    const dirU  = norm(sub(jFore, jUp));
    const dirF  = norm(sub(jHand, jFore));
    const lenU  = vlen(sub(jFore, jUp));
    const lenF  = vlen(sub(jHand, jFore));

    const armPath = [
      [s * 0.145, 1.462, 0.002],
      [s * 0.178, 1.474, 0.002],
    ];
    const armRa = [0.058, 0.072], armRb = [0.062, 0.074];
    // Shoulder deltoid -> bicep -> elbow -> forearm -> wrist cuff
    const samplesU = [0.02, 0.14, 0.32, 0.56, 0.78, 0.92, 1.0];
    const radsU    = [0.074, 0.072, 0.065, 0.060, 0.056, 0.053, 0.052];
    for (let i = 0; i < samplesU.length; i++) {
      armPath.push(add(jUp, mul(dirU, samplesU[i] * lenU)));
      armRa.push(radsU[i]); armRb.push(radsU[i] * 0.95);
    }
    // Sleeve tapers with subtle elbow-crook gather + folded cuff hem tucking cleanly into the glove cuff
    const samplesF = [0.12, 0.28, 0.48, 0.72, 0.84, 0.92, 0.96];
    const radsF    = [0.055, 0.053, 0.048, 0.042, 0.037, 0.033, 0.028];
    for (let i = 0; i < samplesF.length; i++) {
      armPath.push(add(jFore, mul(dirF, samplesF[i] * lenF)));
      armRa.push(radsF[i]); armRb.push(radsF[i] * 0.94);
    }
    const armW = chainWeightFn(
      [jClav, jUp, jFore, jHand],
      [BI['clavicle' + side], BI['upperArm' + side], BI['forearm' + side], BI['hand' + side]],
      [0.055, 0.055, 0.032]
    );
    addTube(mb, armPath, armRa, armRb, seg(16), 2.1, [0, 0, 1], 'camo', armW, [false, false]);
    // Rounded deltoid cap overlapping shoulder joint seamlessly
    addRoundedBox(mb, [0.135, 0.138, 0.142], [s * 0.190, 1.458, 0.002], [0, 0, s * -0.25], bseg(2), 2.1, 'camo', (x) => {
      const wu = sstep(0.155, 0.215, Math.abs(x));
      return [[BI['upperArm' + side], wu], [BI['clavicle' + side], 1 - wu]];
    });

    // Shoulder flag patch on upper arm
    const flagP = add(jUp, mul(dirU, lenU * 0.28));
    const flagRot = [0, 0, s * -0.60];
    addRoundedBox(mb, [0.068, 0.012, 0.046], add(flagP, [0, 0.056, 0]), flagRot, 1, 3.5, 'flag', rigidW('upperArm' + side));

    // Low-profile contoured elbow pad sitting flush on outer/back forearm surface (100% forearm weight)
    addRoundedBox(mb, [0.064, 0.046, 0.018], add(jFore, add(mul(dirF, 0.032), [0, -0.008, 0.034])), [0, 0, s * -0.58], bseg(2), 3.4, 'pads', rigidW('forearm' + side));

    // ---- GLOVED HAND (substantial tactical glove hiding sleeve end, 100% hand/finger/thumb skinned) ----
    // Local hand basis: H_along = dirF (wrist -> knuckles), H_front = -Z (thumb side), H_back = cross(H_along, H_front)*(-s)
    const hAlong = dirF;
    const hFwd = [0, 0, -1];
    const hOut = norm(cross(hAlong, hFwd));
    const hBack = mul(hOut, -s);
    const hPt = (al, bk, fw) => add(jHand, add(mul(hAlong, al), add(mul(hBack, bk), mul(hFwd, fw))));

    // Tailored tactical glove cuff (overlaps sleeve cleanly) -> anatomical contoured palm
    addTube(
      mb,
      [hPt(-0.046, 0, 0), hPt(-0.018, 0, 0), hPt(0.010, -0.001, 0), hPt(0.042, -0.002, 0), hPt(0.072, -0.004, 0), hPt(0.086, -0.006, 0)],
      [0.039, 0.035, 0.036, 0.040, 0.041, 0.035],
      [0.037, 0.031, 0.026, 0.022, 0.019, 0.014],
      seg(14), 2.8, hFwd, 'glove', rigidW('hand' + side), [false, true]
    );
    // Molded Velcro wrist-closure cuff band
    addTube(
      mb,
      [hPt(-0.032, 0, 0), hPt(-0.016, 0, 0)],
      [0.039, 0.038],
      [0.036, 0.034],
      seg(12), 2.6, hFwd, 'pads', rigidW('hand' + side), [false, false]
    );
    // Four individually contoured carbon-polymer knuckle armor pods across MCP joints
    if (lod === 0) {
      for (const kw of [0.025, 0.008, -0.009, -0.025]) {
        addRoundedBox(mb, [0.019, 0.013, 0.016], hPt(0.074, 0.018, kw), [0, 0, s * -0.58], 1, 2.8, 'pads', rigidW('hand' + side));
      }
      // Subtle molded dorsal metacarpal flex bar
      addRoundedBox(mb, [0.024, 0.008, 0.064], hPt(0.044, 0.019, 0.0), [0, 0, s * -0.58], 1, 2.6, 'pads', rigidW('hand' + side));
    } else {
      addRoundedBox(mb, [0.024, 0.014, 0.072], hPt(0.074, 0.019, 0.0), [0, 0, s * -0.58], 1, 2.8, 'pads', rigidW('hand' + side));
    }

    // Anatomical knuckle-articulated curled tactical glove fingers (slim, tapered, natural C-wrap grip)
    const fingerSpecs = lod === 0
      ? [[ 0.0265, 0.0088, [0.028, 0.020, 0.015], [0.76, 1.62, 2.34]],
         [ 0.0085, 0.0092, [0.031, 0.022, 0.016], [0.84, 1.72, 2.44]],
         [-0.0095, 0.0085, [0.029, 0.020, 0.015], [0.90, 1.78, 2.50]],
         [-0.0265, 0.0075, [0.024, 0.017, 0.014], [0.96, 1.84, 2.56]]]
      : [[ 0.017, 0.0155, [0.030, 0.021, 0.016], [0.80, 1.66, 2.38]],
         [-0.016, 0.0145, [0.027, 0.019, 0.015], [0.92, 1.80, 2.52]]];
    const fingW = (x, y, z) => {
      const d = vlen(sub([x, y, z], hPt(0.080, 0, 0)));
      const wf = sstep(0.004, 0.022, d);
      return [[BI['fingers' + side], wf], [BI['hand' + side], 1 - wf]];
    };
    for (const [fwOff, rad, lens, angs] of fingerSpecs) {
      let al = 0.080, bk = -0.004;
      const fpts = [hPt(al, bk, fwOff)];
      const fra = [rad * 1.05];
      const frb = [rad * 0.96];
      for (let k = 0; k < lens.length; k++) {
        const dl = lens[k];
        const ca = Math.cos(angs[k]), sa = Math.sin(angs[k]);
        // Mid-phalanx slight pinch + joint knuckle ring for organic gloved silhouette
        const midAl = al + ca * dl * 0.55;
        const midBk = bk - sa * dl * 0.55;
        al += ca * dl;
        bk -= sa * dl;
        const tJoint = 1 - 0.14 * (k + 1);
        const tMid = 1 - 0.14 * (k + 0.55);
        if (lod === 0) {
          fpts.push(hPt(midAl, midBk, fwOff));
          fra.push(rad * tMid * 0.94);
          frb.push(rad * tMid * 0.88);
        }
        fpts.push(hPt(al, bk, fwOff));
        const knuckleBulge = k < 2 ? 1.06 : 0.72; // slight PIP/DIP knuckle pad, tapered rounded fingertip
        fra.push(rad * tJoint * knuckleBulge);
        frb.push(rad * tJoint * (k < 2 ? 0.96 : 0.66));
      }
      addTube(mb, fpts, fra, frb, lod === 0 ? 10 : 6, 2.2, hFwd, 'glove', fingW);
    }
    // Sculpted opposing thumb curving naturally along handguard / receiver flank
    const tpts = [
      hPt(0.014, -0.008, 0.034),
      hPt(0.040, -0.020, 0.048),
      hPt(0.066, -0.030, 0.047),
      hPt(0.084, -0.038, 0.036),
      hPt(0.092, -0.042, 0.028),
    ];
    addTube(mb, tpts, [0.0135, 0.0122, 0.0108, 0.0094, 0.0068], [0.0128, 0.0114, 0.0100, 0.0086, 0.0062], lod === 0 ? 9 : 6, 2.2, hBack, 'glove', rigidW('thumb' + side));
  }

  // ---- LEGS (trousers, cargo pockets, knee pads, combat boots) -------------
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? -1 : 1;
    const jHip  = REST_W[BI['thigh' + side]];
    const jKnee = REST_W[BI['shin' + side]];
    const jAnk  = REST_W[BI['foot' + side]];
    const jToe  = REST_W[BI['toe' + side]];

    const legRows = [
      // [y, rx, rFront, rBack] — top tucked inside pelvis (0.935), knee/boot blousing folds, bottom sunk in boot shaft
      [0.935, 0.096, 0.094, 0.098],
      [0.860, 0.098, 0.095, 0.101],
      [0.740, 0.092, 0.088, 0.093],
      [0.620, 0.082, 0.079, 0.081],
      [0.545, 0.078, 0.075, 0.076],
      [0.505, 0.075, 0.073, 0.074],
      [0.455, 0.074, 0.069, 0.078],
      [0.370, 0.072, 0.066, 0.082],
      [0.295, 0.070, 0.066, 0.072], // trouser cuff bloused above boot collar
      [0.255, 0.073, 0.070, 0.074],
      [0.215, 0.052, 0.050, 0.054],
      [0.155, 0.044, 0.044, 0.046],
    ];
    const lxAt = (y) => lerp(jAnk[0], jHip[0], clamp((y - jAnk[1]) / (jHip[1] - jAnk[1]), 0, 1));
    const lzAt = (y) => lerp(jAnk[2], jHip[2], clamp((y - jAnk[1]) / (jHip[1] - jAnk[1]), 0, 1));
    const legW = (x, y) => {
      if (y > 0.78) {
        const wh = sstep(0.84, 0.935, y);
        return [[BI.hips, wh], [BI['thigh' + side], 1 - wh]];
      }
      const wt = sstep(0.44, 0.57, y);
      return [[BI['thigh' + side], wt], [BI['shin' + side], 1 - wt]];
    };
    addTube(
      mb,
      legRows.map((r) => [lxAt(r[0]), r[0], lzAt(r[0])]),
      legRows.map((r) => r[1]),
      legRows.map((r) => [r[3], r[2]]),
      seg(16), 2.2, [1, 0, 0], 'camo', legW, [false, false]
    );

    // Thigh cargo pocket (snug crisp flap pocket)
    addRoundedBox(mb, [0.036, 0.162, 0.118], [lxAt(0.74) + s * 0.084, 0.74, lzAt(0.74)], [0, 0, 0], bseg(2), 5.6, 'camo', rigidW('thigh' + side));
    // Contoured tactical knee pad + hard cap
    addRoundedBox(mb, [0.098, 0.128, 0.042], [lxAt(0.495), 0.495, lzAt(0.495) - 0.070], [0.10, 0, 0], bseg(2), 3.2, 'pads', rigidW('shin' + side));
    if (lod === 0) {
      addRoundedBox(mb, [0.066, 0.074, 0.018], [lxAt(0.495), 0.495, lzAt(0.495) - 0.088], [0.10, 0, 0], 1, 3.2, 'metal', rigidW('shin' + side));
    }

    // Combat boot shaft (covers shin bottom by > 10cm, open top hugs trouser cuff, no flat caps)
    const shaftW = (x, y) => {
      const ws = sstep(0.075, 0.155, y);
      return [[BI['shin' + side], ws], [BI['foot' + side], 1 - ws]];
    };
    addTube(
      mb,
      [[jAnk[0], 0.036, jAnk[2] + 0.008], [jAnk[0], 0.085, jAnk[2]], [jAnk[0], 0.155, jAnk[2]], [jAnk[0], 0.220, jAnk[2]], [jAnk[0], 0.262, jAnk[2]]],
      [0.052, 0.056, 0.060, 0.066, 0.069], [0.058, 0.058, 0.061, 0.066, 0.069], seg(14), 2.2, [1, 0, 0], 'boot', shaftW, [false, false]
    );

    // Combat boot upper foot + toe box (smooth tapered heel -> rounded toe)
    const footW = (x, y, z) => {
      const wt = sstep(-0.085, -0.145, z);
      return [[BI['toe' + side], wt], [BI['foot' + side], 1 - wt]];
    };
    const fz  = [0.084, 0.066, 0.030, -0.020, -0.075, -0.135, -0.188, -0.220];
    const fy  = [0.054, 0.062, 0.063,  0.058,  0.050,  0.042,  0.034,  0.026];
    const frx = [0.024, 0.044, 0.048,  0.049,  0.051,  0.050,  0.040,  0.022];
    const fry = [0.034, 0.045, 0.046,  0.041,  0.035,  0.028,  0.021,  0.014];
    addTube(mb, fz.map((z, i) => [jAnk[0], fy[i], z]), frx, fry, seg(14), 2.4, [1, 0, 0], 'boot', footW);

    // Lugged rubber sole (bottom strictly at y = 0.000)
    const sy  = [0.014, 0.014, 0.013, 0.013, 0.013, 0.013, 0.013, 0.012];
    const srx = [0.028, 0.047, 0.051, 0.052, 0.054, 0.053, 0.043, 0.025];
    const sry = [0.014, 0.014, 0.013, 0.013, 0.013, 0.013, 0.013, 0.012];
    addTube(mb, fz.map((z, i) => [jAnk[0], sy[i], z]), srx, sry, seg(12), 3.0, [1, 0, 0], 'sole', footW);
  }

  return mb;
}

// ============================================================================
// 5. PROCEDURAL 2048x2048 PBR TEXTURES (Color, Normal, ORM) -> WebP
// ============================================================================
function hash2(x, y, seed = 1337) {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, seed = 1337) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}
function fbm(x, y, oct = 3, seed = 1337) {
  let v = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < oct; i++) { v += amp * vnoise(x * freq, y * freq, seed + i * 31); freq *= 2.02; amp *= 0.5; }
  return v;
}

function encodePNG(width, height, rgb) {
  // Minimal valid 8-bit RGB PNG encoder
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter None
    rgb.copy(raw, y * stride + 1, y * width * 3, (y + 1) * width * 3);
  }
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([t, data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const idat = deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildPBRTextures(SIZE = 2048) {
  console.log(`Generating ${SIZE}x${SIZE} PBR textures (color, normal, ORM)...`);
  const col = Buffer.alloc(SIZE * SIZE * 3);
  const orm = Buffer.alloc(SIZE * SIZE * 3);
  const hgt = new Float32Array(SIZE * SIZE);

  // Precompute region pixel boxes
  const boxes = Object.entries(UV_REG).map(([name, [u0, v0, u1, v1]]) => ({
    name,
    x0: Math.floor(u0 * SIZE), y0: Math.floor(v0 * SIZE),
    x1: Math.ceil(u1 * SIZE),  y1: Math.ceil(v1 * SIZE),
  }));

  // Base fill (neutral tan-grey)
  for (let i = 0; i < SIZE * SIZE; i++) {
    col[i * 3] = 115; col[i * 3 + 1] = 112; col[i * 3 + 2] = 95;
    orm[i * 3] = 220; orm[i * 3 + 1] = 220; orm[i * 3 + 2] = 0;
    hgt[i] = 0.5;
  }

  // Woodland MARPAT-inspired neutral-warm camo palette (easily tinted for hostiles)
  const CAMO_PAL = [
    [82, 94, 58],   // olive green
    [118, 98, 70],  // coyote brown
    [154, 144, 110],// khaki tan
    [42, 46, 36],   // dark charcoal-olive
  ];

  for (const box of boxes) {
    const bw = Math.max(1, box.x1 - box.x0);
    const bh = Math.max(1, box.y1 - box.y0);
    for (let y = box.y0; y < box.y1; y++) {
      const lv = (y - box.y0) / bh;
      for (let x = box.x0; x < box.x1; x++) {
        const lu = (x - box.x0) / bw;
        const idx = y * SIZE + x;
        const o = idx * 3;
        let r = 128, g = 128, b = 128;
        let ao = 0.92, rough = 0.85, metal = 0.0, h = 0.5;

        // Edge wear factor near UV borders of pouches/plates/pads
        const edge = Math.min(lu, 1 - lu, lv, 1 - lv);
        const edgeWear = clamp(1 - edge / 0.06, 0, 1);

        if (box.name === 'camo' || box.name === 'helmet') {
          // High-density tactical micro-digital camo (220x220 fine pattern, crisp in 1P sleeves) + ripstop weave + cloth folds
          const macroX = lu * 28, macroY = lv * 28;
          const bx = Math.floor(lu * 220), by = Math.floor(lv * 220);
          const n1 = fbm(macroX, macroY, 3, 1775) * 0.72 + fbm(bx * 0.18, by * 0.18, 2, 1945) * 0.28 + (hash2(bx, by, 99) - 0.5) * 0.14;
          const n2 = fbm(macroX * 1.4 + 5.1, macroY * 1.4 + 2.7, 2, 2021) + (hash2(bx >> 1, by >> 1, 77) - 0.5) * 0.14;
          const ci = n2 > 0.63 ? 2 : n2 < 0.35 ? 3 : n1 > 0.52 ? 1 : 0;
          [r, g, b] = CAMO_PAL[ci];
          // Fine 2-px ripstop twill crosshatch + natural diagonal cloth crease folds
          const weave = ((x & 3) === 0 || (y & 3) === 0) ? 0.93 : (((x + y) & 1) ? 1.03 : 0.98);
          const crease = Math.sin(lv * Math.PI * 16 + fbm(lu * 6, lv * 6, 2, 313) * 5.0) * 0.5 + 0.5;
          const fold = fbm(lu * 12, lv * 28, 3, 404) * 0.72 + crease * 0.28;
          const dirt = clamp(fbm(lu * 7, lv * 7, 3, 808) * 1.4 - 0.55, 0, 1) * (lv < 0.35 ? 0.52 : 0.16);
          const stitch = Math.abs(lu - 0.5) < 0.003 && ((y % 8) < 4) ? 1 : 0;
          r = r * weave * (0.85 + 0.28 * fold) * (1 - dirt * 0.35) + 125 * dirt * 0.35;
          g = g * weave * (0.85 + 0.28 * fold) * (1 - dirt * 0.35) + 112 * dirt * 0.35;
          b = b * weave * (0.85 + 0.28 * fold) * (1 - dirt * 0.35) + 88 * dirt * 0.35;
          if (stitch) { r *= 0.65; g *= 0.65; b *= 0.65; }
          h = 0.5 + (weave - 0.98) * 1.8 + (fold - 0.5) * 0.95 - stitch * 0.35;
          rough = clamp(0.86 + (fold - 0.5) * 0.1 + dirt * 0.08, 0.72, 0.96);
          ao = clamp(0.82 + 0.18 * fold - stitch * 0.15, 0.52, 1.0);
          // Helmet cover seams & rear/crown Velcro loop panels
          if (box.name === 'helmet') {
            const coverSeam = (Math.abs(lu - 0.18) < 0.008 || Math.abs(lu - 0.82) < 0.008 || Math.abs(lu - 0.50) < 0.007 || lv < 0.045) ? 1 : 0;
            const velcro = (lv > 0.28 && lv < 0.72 && (Math.abs(lu - 0.50) < 0.11 || Math.abs(lu - 0.25) < 0.06 || Math.abs(lu - 0.75) < 0.06)) ? 1 : 0;
            if (coverSeam) { r *= 0.62; g *= 0.62; b *= 0.62; rough = 0.90; ao = 0.68; h -= 0.16; }
            else if (velcro) { r = lerp(r, 118, 0.55); g = lerp(g, 108, 0.55); b = lerp(b, 84, 0.55); rough = 0.95; h += 0.10; }
          }
        } else if (box.name === 'gear' || box.name === 'gearDark') {
          // Coyote Cordura nylon + MOLLE webbing rows + bartack stitching + worn edges
          const baseC = box.name === 'gear' ? [146, 128, 96] : [114, 98, 72];
          const cordura = ((x & 1) ^ (y & 1)) ? 1.04 : 0.95;
          const molleRow = Math.sin(lv * Math.PI * 16);
          const isStrap = molleRow > 0.0 ? 1 : 0;
          const bartack = isStrap && (Math.abs((lu * 12) % 1 - 0.5) < 0.06) ? 1 : 0;
          const grime = fbm(lu * 9, lv * 9, 3, 512);
          const shade = cordura * (0.88 + 0.22 * grime) * (isStrap ? 1.05 : 0.88) * (bartack ? 0.78 : 1.0);
          r = baseC[0] * shade + edgeWear * 26;
          g = baseC[1] * shade + edgeWear * 24;
          b = baseC[2] * shade + edgeWear * 18;
          h = 0.45 + isStrap * 0.28 + (cordura - 0.99) * 1.4 - bartack * 0.22 + (grime - 0.5) * 0.25;
          rough = clamp(0.84 + (grime - 0.5) * 0.12 - edgeWear * 0.08, 0.65, 0.96);
          ao = clamp(0.78 + isStrap * 0.18 - bartack * 0.12, 0.55, 1.0);
        } else if (box.name === 'balaclava') {
          // Tactical ribbed charcoal-olive balaclava with cheek seams & perforated mouth breather mesh
          const rib = Math.sin(lu * Math.PI * 96) * 0.5 + 0.5;
          const n = fbm(lu * 14, lv * 14, 2, 333);
          const frontMask = Math.exp(-Math.pow((lu - 0.75) * 9.0, 2)) * (lv > 0.22 && lv < 0.62 ? 1 : 0);
          const meshDot = frontMask > 0.25 && ((x % 4) < 2) && ((y % 4) < 2) ? 1 : 0;
          const seam = (Math.abs(lu - 0.63) < 0.008 || Math.abs(lu - 0.87) < 0.008) ? 1 : 0;
          const v = 46 + rib * 12 + n * 14 + frontMask * 10 - meshDot * 20 - seam * 14;
          r = v * 0.95; g = v * 0.98; b = v * 1.04;
          h = 0.45 + rib * 0.22 + (n - 0.5) * 0.15 - meshDot * 0.28 + seam * 0.20;
          rough = 0.86; ao = 0.82 + rib * 0.12 - meshDot * 0.18;
        } else if (box.name === 'boot') {
          // Coyote suede combat boot with lace rows and mud/dust near bottom
          const grain = fbm(lu * 45, lv * 45, 3, 701);
          const dirt = smooth(1 - lv * 1.8) * (0.55 + 0.45 * fbm(lu * 12, lv * 12, 3, 709));
          const lace = Math.abs(lu - 0.5) < 0.14 && Math.sin(lv * Math.PI * 22) > 0.55 ? 1 : 0;
          r = lerp(128 * (0.85 + 0.28 * grain), 98, dirt * 0.65) * (lace ? 0.68 : 1);
          g = lerp(108 * (0.85 + 0.28 * grain), 86, dirt * 0.65) * (lace ? 0.68 : 1);
          b = lerp(78  * (0.85 + 0.28 * grain), 66, dirt * 0.65) * (lace ? 0.68 : 1);
          h = 0.45 + grain * 0.28 + lace * 0.32;
          rough = clamp(0.76 + dirt * 0.18, 0.62, 0.96);
          ao = clamp(0.75 + 0.2 * grain - lace * 0.1, 0.55, 1.0);
        } else if (box.name === 'glove') {
          // Tactical Mechanix-style multi-panel charcoal ballistic weave + coyote-slate suede & flex ribs
          const weave = Math.sin(lu * Math.PI * 64) * Math.sin(lv * Math.PI * 64) * 0.5 + 0.5;
          const n = fbm(lu * 26, lv * 26, 3, 612);
          const suedePanel = smooth((lv - 0.42) * 10) * (1 - smooth((lv - 0.84) * 10));
          const flexRib = Math.pow(0.5 + 0.5 * Math.sin(lv * Math.PI * 24), 2) * (1 - suedePanel * 0.6);
          const seam = (Math.abs(lv - 0.42) < 0.010 || Math.abs(lv - 0.84) < 0.010 || Math.abs(lu - 0.5) < 0.008) ? 1 : 0;
          const stitch = seam && (((Math.floor(lu * 120) + Math.floor(lv * 120)) & 1) === 0) ? 1 : 0;
          const baseR = lerp(44, 62, suedePanel) + weave * 5 + flexRib * 6 + edgeWear * 16;
          const baseG = lerp(45, 58, suedePanel) + weave * 5 + flexRib * 6 + edgeWear * 15;
          const baseB = lerp(47, 51, suedePanel) + weave * 5 + flexRib * 5 + edgeWear * 12;
          const grainM = (0.86 + 0.24 * n) * (seam ? (stitch ? 1.18 : 0.72) : 1.0);
          r = baseR * grainM;
          g = baseG * grainM;
          b = baseB * grainM;
          h = 0.46 + weave * 0.12 + flexRib * 0.24 + (n - 0.5) * 0.22 + (stitch ? 0.18 : -seam * 0.22);
          rough = clamp(lerp(0.68, 0.84, suedePanel) - flexRib * 0.06 + (n - 0.5) * 0.12, 0.52, 0.92);
          ao = clamp(0.84 + flexRib * 0.10 - seam * 0.20, 0.58, 1.0);
        } else if (box.name === 'pads') {
          // Hard-shell polymer knee/elbow pads & mask guard with scuffs
          const scuff = fbm(lu * 18, lv * 18, 3, 911);
          const v = 46 + edgeWear * 28 + scuff * 14;
          r = v; g = v * 0.99; b = v * 0.96;
          h = 0.5 + (scuff - 0.5) * 0.25;
          rough = clamp(0.52 - edgeWear * 0.12 + scuff * 0.12, 0.36, 0.72);
          ao = 0.86;
        } else if (box.name === 'sole') {
          // Deep Vibram rubber lug tread
          const lug = ((Math.floor(lu * 10) + Math.floor(lv * 22)) & 1) ? 1 : 0;
          const dirt = fbm(lu * 12, lv * 12, 2, 419);
          r = lerp(26 + lug * 10, 92, dirt * 0.35);
          g = lerp(26 + lug * 10, 82, dirt * 0.35);
          b = lerp(28 + lug * 10, 66, dirt * 0.35);
          h = 0.25 + lug * 0.55;
          rough = 0.90; ao = 0.65 + lug * 0.3;
        } else if (box.name === 'metal') {
          // Brushed gunmetal buckles, rails, NVG shroud (phone-safe roughness >= 0.26)
          const brush = fbm(lu * 40, lv * 6, 2, 121);
          const v = 78 + brush * 34 + edgeWear * 35;
          r = v * 0.96; g = v * 0.98; b = v * 1.02;
          h = 0.5 + (brush - 0.5) * 0.15;
          rough = clamp(0.32 + (brush - 0.5) * 0.12, 0.26, 0.50);
          metal = 0.82; ao = 0.90;
        } else if (box.name === 'lens') {
          // Reflective polarized ballistic visor (amber-blue anti-glare gradient, phone-safe roughness >= 0.16)
          const sheen = Math.pow(1 - Math.abs(lu - 0.5) * 1.8, 2);
          const band = Math.exp(-Math.pow((lv - 0.35) * 4.5, 2));
          r = 26 + sheen * 36 + band * 44;
          g = 42 + sheen * 54 + band * 52;
          b = 64 + sheen * 72 + band * 40;
          h = 0.55;
          rough = 0.16; metal = 0.38; ao = 0.96;
        } else if (box.name === 'flag') {
          // Subdued tactical US flag patch
          const stripe = Math.floor(lv * 13);
          const canton = lu < 0.42 && lv < 7 / 13;
          if (canton) { r = 48; g = 56; b = 78; }
          else if ((stripe & 1) === 0) { r = 135; g = 48; b = 46; }
          else { r = 178; g = 170; b = 148; }
          const weave = ((x + y) & 1) ? 1.03 : 0.96;
          r *= weave; g *= weave; b *= weave;
          h = 0.52 + (weave - 1) * 1.2; rough = 0.84; ao = 0.92;
        } else if (box.name === 'tape') {
          // Chest name tape
          const border = lv < 0.14 || lv > 0.86;
          const letter = !border && lv > 0.3 && lv < 0.7 && lu > 0.1 && lu < 0.9 && ((Math.floor(lu * 32) & 1) === 0);
          r = letter ? 28 : 108; g = letter ? 30 : 114; b = letter ? 24 : 84;
          h = letter ? 0.58 : 0.50; rough = 0.86; ao = 0.92;
        }

        col[o]     = clamp(Math.round(r), 0, 255);
        col[o + 1] = clamp(Math.round(g), 0, 255);
        col[o + 2] = clamp(Math.round(b), 0, 255);
        orm[o]     = clamp(Math.round(ao * 255), 0, 255);
        orm[o + 1] = clamp(Math.round(rough * 255), 0, 255);
        orm[o + 2] = clamp(Math.round(metal * 255), 0, 255);
        hgt[idx]   = h;
      }
    }
  }

  // Compute tangent-space normal map from heightfield via Sobel filter
  const nrm = Buffer.alloc(SIZE * SIZE * 3);
  const strength = 2.6;
  for (let y = 0; y < SIZE; y++) {
    const ym = y > 0 ? y - 1 : 0;
    const yp = y < SIZE - 1 ? y + 1 : SIZE - 1;
    for (let x = 0; x < SIZE; x++) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < SIZE - 1 ? x + 1 : SIZE - 1;
      const dx = (hgt[y * SIZE + xp] - hgt[y * SIZE + xm]) * strength;
      const dy = (hgt[yp * SIZE + x] - hgt[ym * SIZE + x]) * strength;
      const nx = -dx, ny = -dy, nz = 1.0;
      const l = Math.hypot(nx, ny, nz) || 1;
      const o = (y * SIZE + x) * 3;
      nrm[o]     = clamp(Math.round((nx / l * 0.5 + 0.5) * 255), 0, 255);
      nrm[o + 1] = clamp(Math.round((ny / l * 0.5 + 0.5) * 255), 0, 255);
      nrm[o + 2] = clamp(Math.round((nz / l * 0.5 + 0.5) * 255), 0, 255);
    }
  }

  const toWebp = (buf, name, q, lossless = false) => {
    const pngPath = `${TMP_DIR}/${name}.png`;
    const webpPath = `${TMP_DIR}/${name}.webp`;
    writeFileSync(pngPath, encodePNG(SIZE, SIZE, buf));
    const args = lossless
      ? ['-lossless', '-m', '6', '-q', '90', pngPath, '-o', webpPath]
      : ['-m', '6', '-q', String(q), pngPath, '-o', webpPath];
    execFileSync('/opt/homebrew/bin/cwebp', args, { stdio: 'ignore' });
    return readFileSync(webpPath);
  };

  const colWebp = toWebp(col, 'col', 82);
  const nrmWebp = toWebp(nrm, 'nrm', 92);
  const ormWebp = toWebp(orm, 'orm', 88);
  console.log(`WebP maps: color ${(colWebp.length / 1024).toFixed(1)} KB, normal ${(nrmWebp.length / 1024).toFixed(1)} KB, orm ${(ormWebp.length / 1024).toFixed(1)} KB`);
  return { colWebp, nrmWebp, ormWebp };
}

// ============================================================================
// 6. 30 FPS ANIMATION AUTHORING (23 clips, in-place, seamless, planted feet)
// ============================================================================
const FPS = 30;
const THIGH_L = vlen(REST_L[BI.shinL]);
const SHIN_L  = vlen(REST_L[BI.footL]);
const LEG_MAX = THIGH_L + SHIN_L - 0.005;
const ANKLE_H = REST_W[BI.footL][1]; // 0.085m

// Aim a bone whose rest direction is `restDir` onto `targetDir`, with pole `front`
function aimRestBone(restDir, targetDir, front) {
  const rd = norm(restDir);
  const td = norm(targetDir);
  // Build rest basis: y = -rd, z = -frontRest (0,0,1), x = y x z
  const q0 = qFromUnitVectors(rd, td);
  // Twist around td so knee/shin front (-Z) faces `front`
  const curFront = qApply(q0, [0, 0, -1]);
  const f1 = sub(curFront, mul(td, dot(curFront, td)));
  const f2 = sub(front, mul(td, dot(front, td)));
  if (vlen(f1) < 1e-4 || vlen(f2) < 1e-4) return q0;
  const n1 = norm(f1), n2 = norm(f2);
  const c = clamp(dot(n1, n2), -1, 1);
  const s = dot(td, cross(n1, n2));
  const twist = Math.atan2(s, c);
  return qNorm(qMul(qAxisAngle(td, twist), q0));
}

// Solve 2-bone leg IK in hips-local space, returning local rotations [qThigh, qShin, qFoot, qToe]
function solveLegIK(side, ankleModel, footPitch, footYaw, toePitch, hipsPos, hipsQ, kneeOut = 0.22) {
  const s = side === 'L' ? -1 : 1;
  const invHipsQ = qConj(hipsQ);
  const thighRest = REST_L[BI['thigh' + side]];
  const shinRest  = REST_L[BI['shin' + side]];
  const footRest  = REST_L[BI['foot' + side]];
  // Ankle in hips-local space
  const target = qApply(invHipsQ, sub(ankleModel, hipsPos));
  const rel = sub(target, thighRest);
  let d = vlen(rel);
  const dir = d > 1e-5 ? mul(rel, 1 / d) : [0, -1, 0];
  // Soft knee-lock cushion prevents robotic hyper-extension snapping at full leg reach
  const softMax = LEG_MAX - 0.008;
  d = clamp(d, 0.14, softMax);
  const cosA = clamp((THIGH_L * THIGH_L + d * d - SHIN_L * SHIN_L) / (2 * THIGH_L * d), -1, 1);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  // Knee pole: forward (-Z) and naturally slightly outward along foot heading
  const poleModel = [
    -Math.sin(footYaw) + s * kneeOut * Math.cos(footYaw),
    0.04,
    -Math.cos(footYaw) - s * kneeOut * Math.sin(footYaw),
  ];
  let pole = qApply(invHipsQ, poleModel);
  pole = sub(pole, mul(dir, dot(pole, dir)));
  pole = vlen(pole) > 1e-4 ? norm(pole) : [0, 0, -1];

  const thighDir = add(mul(dir, cosA), mul(pole, sinA));
  const kneePos = add(thighRest, mul(thighDir, THIGH_L));
  const shinDir = norm(sub(add(thighRest, mul(dir, d)), kneePos));

  const qThigh = aimRestBone(shinRest, thighDir, pole);
  const qShinW = aimRestBone(footRest, shinDir, pole);
  const qShin  = qNorm(qMul(qConj(qThigh), qShinW));
  // Foot world orientation -> local to shin
  const qFootModel = qEulerYXZ(footPitch, footYaw, 0);
  const qFootHips  = qNorm(qMul(invHipsQ, qFootModel));
  const qFoot      = qNorm(qMul(qConj(qShinW), qFootHips));
  const qToe       = qEulerYXZ(toePitch, 0, 0);
  return { qThigh, qShin, qFoot, qToe };
}

// Aim a bone from restDir -> targetDir while twisting restRef -> targetRef
function aimBoneWithRef(restDir, targetDir, restRef, targetRef) {
  const rd = norm(restDir), td = norm(targetDir);
  const q0 = qFromUnitVectors(rd, td);
  const cur = qApply(q0, restRef);
  const f1 = sub(cur, mul(td, dot(cur, td)));
  const f2 = sub(targetRef, mul(td, dot(targetRef, td)));
  if (vlen(f1) < 1e-4 || vlen(f2) < 1e-4) return q0;
  const n1 = norm(f1), n2 = norm(f2);
  const c = clamp(dot(n1, n2), -1, 1);
  const s = dot(td, cross(n1, n2));
  return qNorm(qMul(qAxisAngle(td, Math.atan2(s, c)), q0));
}

// Analytical 2-bone arm IK in chest-local space (A-pose rest -> exact rifle grip pose)
function solveArmIK(side, handTargetChest, elbowPoleChest, palmInChest, clavShrug = 0, clavFwd = 0) {
  const s = side === 'L' ? -1 : 1;
  const clavOff = REST_L[BI['clavicle' + side]];
  const upOff   = REST_L[BI['upperArm' + side]];
  const uRest   = REST_L[BI['forearm' + side]];
  const fRest   = REST_L[BI['hand' + side]];
  const lenU = vlen(uRest), lenF = vlen(fRest);
  const qClav = qEulerYXZ(0, s * (-0.06 - clavFwd), s * clavShrug);
  const shoulderPos = add(clavOff, qApply(qClav, upOff));

  const rel = sub(handTargetChest, shoulderPos);
  let d = vlen(rel);
  const dir = d > 1e-5 ? mul(rel, 1 / d) : [0, 0, -1];
  d = clamp(d, 0.14, lenU + lenF - 0.008);
  const cosA = clamp((lenU * lenU + d * d - lenF * lenF) / (2 * lenU * d), -1, 1);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));

  let pole = sub(elbowPoleChest, mul(dir, dot(elbowPoleChest, dir)));
  pole = vlen(pole) > 1e-4 ? norm(pole) : [s * 0.7, -0.7, 0.2];

  const uDir = add(mul(dir, cosA), mul(pole, sinA));
  const elbowPos = add(shoulderPos, mul(uDir, lenU));
  const fDir = norm(sub(add(shoulderPos, mul(dir, d)), elbowPos));

  // +Z is the back of the elbow in rest pose -> align +Z toward elbowPole
  const qUpW   = aimBoneWithRef(uRest, uDir, [0, 0, 1], pole);
  const qForeW = aimBoneWithRef(fRest, fDir, [0, 0, 1], pole);
  const qUp    = qNorm(qMul(qConj(qClav), qUpW));
  const qFore  = qNorm(qMul(qConj(qUpW), qForeW));

  // Align hand so palm faces inward toward weapon grip/handguard
  const hRestBack = mul(norm(cross(norm(fRest), [0, 0, -1])), -s);
  const qHandW = aimBoneWithRef(fRest, fDir, hRestBack, palmInChest);
  const qHand  = qNorm(qMul(qConj(qForeW), qHandW));
  return { qClav, qUp, qFore, qHand };
}

// Compute weapon-ready ("rifle low ready") arm rotations via 2-bone IK in chest space
function makeReadyArms(pose, sway = 0, bob = 0, breath = 0, crawlL = 0, crawlR = 0) {
  const out = {};
  let tgtL, tgtR, poleL, poleR;
  let shL = breath * 0.03, shR = breath * 0.03;
  let fwdL = 0, fwdR = 0;

  if (pose === 'sprint') {
    // Tactical high-port / across-chest rifle carry with athletic shoulder pump
    tgtR  = [ 0.05 + sway * 0.024, 0.05 + bob * 0.028, -0.25 - sway * 0.014];
    tgtL  = [-0.15 + sway * 0.028, 0.13 - bob * 0.022, -0.33 + sway * 0.016];
    poleL = [-0.88, -0.48, 0.22];
    poleR = [ 0.88, -0.52, 0.28];
    fwdL = sway * 0.08; fwdR = -sway * 0.08;
  } else if (pose === 'prone') {
    // Elbows braced forward on ground, forearms cradling rifle ahead of chest
    // crawlL / crawlR drive contralateral elbow reach & pull during leopard crawl
    tgtR  = [ 0.08 + crawlR * 0.03, 0.28 + crawlR * 0.11, -0.24 + bob * 0.015];
    tgtL  = [-0.07 - crawlL * 0.03, 0.38 + crawlL * 0.11, -0.22 - bob * 0.015];
    poleL = [-0.88, -0.15, -0.45 - crawlL * 0.12];
    poleR = [ 0.88, -0.15, -0.45 - crawlR * 0.12];
    fwdL = 0.08 + crawlL * 0.12;
    fwdR = 0.08 + crawlR * 0.12;
  } else {
    // Low-ready tactical rifle hold: right hand on pistol grip, left hand forward on handguard
    tgtR  = [ 0.08 + sway * 0.010, 0.02 + bob * 0.014 + breath * 0.005, -0.30];
    tgtL  = [-0.03 + sway * 0.012, 0.05 + bob * 0.012 + breath * 0.004, -0.48];
    poleL = [-0.70, -0.68, 0.22];
    poleR = [ 0.72, -0.65, 0.28];
  }
  const ikL = solveArmIK('L', tgtL, poleL, [-0.5, -0.8, 0.1], shL, fwdL);
  const ikR = solveArmIK('R', tgtR, poleR, [ 0.8,  0.4, 0.2], shR, fwdR);
  out.clavicleL = ikL.qClav; out.upperArmL = ikL.qUp; out.forearmL = ikL.qFore; out.handL = ikL.qHand;
  out.clavicleR = ikR.qClav; out.upperArmR = ikR.qUp; out.forearmR = ikR.qFore; out.handR = ikR.qHand;
  // Natural relaxed grip curl on finger groups
  out.thumbL = qEulerYXZ(0.15, -0.25, 0.2);
  out.fingersL = qEulerYXZ(0.0, 0.0, -0.35);
  out.thumbR = qEulerYXZ(0.15, 0.25, -0.2);
  out.fingersR = qEulerYXZ(0.0, 0.0, 0.35);
  return out;
}

// Generate a seamless, biomechanically grounded cyclic locomotion clip with planted-foot IK,
// pelvic obliquity, phase-lagged spine follow-through, and vestibulo-ocular head stabilization.
function makeLocomotionClip(name, { frames, speed, dirX, dirZ, duty, lift, crouch = 0, sprint = false }) {
  const T = frames / FPS;
  const times = Array.from({ length: frames + 1 }, (_, i) => i / FPS);
  const tracks = {}; // boneIdx -> { t?: [], r?: [] }
  const setR = (b, q) => { ((tracks[b] ||= {}).r ||= []).push(...q); };
  const setT = (b, p) => { ((tracks[b] ||= {}).t ||= []).push(...p); };

  const stanceDist = speed * T * duty;
  const runK = clamp((speed - 1.8) / 2.8, 0, 1);
  const backMode = dirZ > 0.5;
  const strafeMode = Math.abs(dirX) > 0.5;
  const frontShare = crouch ? 0.45 : (strafeMode ? 0.50 : lerp(0.50, 0.44, runK));
  const yawBase = strafeMode ? (dirX < 0 ? 0.24 : -0.24) : 0;
  const rollAmp = crouch ? 0.36 : lerp(0.46, sprint ? 0.92 : 0.82, runK);
  const strikeAmp = crouch ? 0.18 : lerp(0.32, 0.18, runK);
  const latW = crouch ? 0.145 : (strafeMode ? 0.21 : lerp(0.104, 0.088, runK));

  for (let f = 0; f <= frames; f++) {
    const P = (f % frames) / frames; // 0..1 seamless (L contact at P=0, R at P=0.5)
    // Walking: inverted-pendulum vault peaks at mid-stance.
    // Running: absorbs load cleanly through mid-stance, then springs upward into visible flight after toe-off.
    const p2 = P * Math.PI * 2;
    const p4 = P * Math.PI * 4;
    const walkVert = -Math.cos(p4 - 0.35) + 0.18 * Math.sin(p4 * 2);
    const runVert  = -Math.sin(p4 + 0.42) - 0.14 * Math.cos(p4 * 2);
    const stepWave = lerp(walkVert, runVert, runK);
    const sideWave = Math.sin(p2 + 0.35);
    // Phase-lagged waves for organic spine/chest/arm follow-through
    const stepLag1 = Math.sin(p4 - 0.25);
    const stepLag2 = Math.sin(p4 - 0.65);
    const sideLag1 = Math.sin(p2 - 0.15);

    // Tall athletic pelvis carriage during walk/run with real flight amplitude (only crouch drops CoM)
    const baseDrop = crouch ? 0.365 : lerp(0.014, 0.004, runK);
    const bobAmp = crouch ? 0.008 : lerp(0.020, sprint ? 0.056 : 0.048, runK);
    const hy = REST_W[BI.hips][1] - baseDrop + stepWave * bobAmp;
    // Lateral weight transfer over stance foot + subtle pelvic drop on swing side
    const sway = lerp(0.030, 0.016, runK) * sideWave * (crouch ? 1.15 : 1.0);
    const hipRoll = -lerp(0.055, 0.078, runK) * sideWave * (crouch ? 0.55 : 1.0);
    const leanBase = 0.05 + 0.175 * runK + (sprint ? 0.095 : 0) + crouch * 0.18;
    const lean = (backMode ? -0.30 : 1) * leanBase + stepWave * 0.022 * runK;
    const leanX = -0.56 * lean;
    const hipYaw = yawBase - lerp(0.095, sprint ? 0.20 : 0.16, runK) * Math.cos(p2 - 0.12);
    // Subtle fore-aft surge during run/sprint
    const surgeZ = -0.016 * runK * Math.cos(p4);
    const hipsPos = [sway, hy, surgeZ];
    const hipsQ = qEulerYXZ(leanX, hipYaw, hipRoll);

    setT(BI.hips, hipsPos);
    setR(BI.hips, hipsQ);

    // Legs via planted-foot IK with true heel-to-toe roll & strafe clearance
    for (const side of ['L', 'R']) {
      const sgn = side === 'L' ? -1 : 1;
      const ph = (P + (side === 'L' ? 0 : 0.5)) % 1;
      let along, up = 0, pitch = 0, toePitch = 0, latClear = 0;
      if (ph < duty) {
        const t = ph / duty;
        along = stanceDist * (frontShare - t);
        // Smooth heel-strike -> flat-foot mid-stance -> heel-off / toe-off roll
        const heel = strikeAmp * Math.pow(1 - sstep(0, 0.22, t), 1.4);
        const push = rollAmp * Math.pow(sstep(lerp(0.56, 0.40, runK), 1.0, t), 1.2);
        pitch = (backMode ? -0.45 : 1) * (heel - push);
        // Toes stay flat on ground as heel lifts at push-off
        toePitch = Math.max(0, push) * 0.90;
      } else {
        const t = (ph - duty) / (1 - duty);
        const it = 1 - t;
        const x0 = (frontShare - 1) * stanceDist, x3 = frontShare * stanceDist;
        // High-knee recovery & crisp butt-kick on run/sprint
        const kick = (0.14 * runK + (sprint ? 0.11 : 0)) * (backMode ? -0.35 : 1);
        const x1 = x0 - kick, x2 = x3 + 0.14 * stanceDist;
        along = it * it * it * x0 + 3 * it * it * t * x1 + 3 * it * t * t * x2 + t * t * t * x3;
        // Asymmetric lift curve: faster initial knee lift, controlled descent into heel strike
        up = Math.sin(Math.pow(t, 0.78) * Math.PI) * lift;
        // Swing foot clears stance leg laterally during strafes
        if (strafeMode) latClear = sgn * 0.065 * Math.sin(t * Math.PI);
        const midPitch = -0.26 - 0.32 * runK;
        pitch = t < 0.38
          ? lerp(-rollAmp, midPitch, sstep(0, 0.38, t))
          : lerp(midPitch, strikeAmp, sstep(0.38, 0.96, t));
        if (backMode) pitch *= -0.45;
        toePitch = -0.08 * Math.sin(t * Math.PI);
      }
      // Exact ankle vertical rise from heel/ball pivot so sole never sinks into ground;
      // in strafeMode keep lateral stride on each leg's own side (never cross feet into an X)
      const rollRise = Math.max(0, -pitch) * 0.082 + Math.max(0, pitch) * 0.032;
      const alongX = strafeMode ? along * 0.44 : along;
      const footModel = [
        sgn * latW + (strafeMode ? 0 : latClear) + dirX * alongX,
        ANKLE_H + up + rollRise,
        dirZ * along - (strafeMode ? Math.abs(latClear) * 0.55 : 0),
      ];
      // Natural ~7 deg outward foot turnout + directional heading
      const footYaw = yawBase * 0.65 - sgn * (crouch ? 0.18 : 0.11);
      const kneeOut = crouch ? 0.34 : (strafeMode ? 0.28 : 0.20);
      const ik = solveLegIK(side, footModel, pitch, footYaw, toePitch, hipsPos, hipsQ, kneeOut);
      setR(BI['thigh' + side], ik.qThigh);
      setR(BI['shin' + side], ik.qShin);
      setR(BI['foot' + side], ik.qFoot);
      setR(BI['toe' + side], ik.qToe);
    }

    // Additive forward torso lean (~11-14 deg total at run) + counter-rotated hips + level gaze head
    const spYaw = -hipYaw * 0.52 + 0.020 * sideLag1 * runK;
    const chYaw = -hipYaw * 0.48 + 0.024 * sideLag1 * (sprint ? 1.3 : 1.0);
    setR(BI.spine, qEulerYXZ(-0.24 * lean + crouch * 0.06 + stepLag1 * 0.016 * runK, spYaw, -hipRoll * 0.55));
    setR(BI.chest, qEulerYXZ(-0.20 * lean + stepLag2 * 0.020 * runK, chYaw, -hipRoll * 0.45));
    // Neck & head counter-pitch upward so eyes stay locked level on the horizon
    setR(BI.neck,  qEulerYXZ(0.48 * lean + crouch * 0.06 - stepLag2 * 0.014 * runK, -chYaw * 0.25, 0));
    setR(BI.head,  qEulerYXZ(0.48 * lean + crouch * 0.05 - stepLag2 * 0.014 * runK, -chYaw * 0.15, -hipRoll * 0.15));

    // Rifle held tucked at tactical low-ready close to chest, counter-compensated for forward torso lean
    const arms = makeReadyArms(sprint ? 'sprint' : 'ready', sideLag1 * 0.55, stepLag2 * (0.28 + 0.38 * runK) + lean * 0.25, 0);
    for (const [bn, q] of Object.entries(arms)) setR(BI[bn], q);
  }
  return { name, times, tracks, refSpeed: speed };
}

function makePoseClip(name, frames, poseFn) {
  const times = Array.from({ length: frames + 1 }, (_, i) => i / FPS);
  const tracks = {};
  const setR = (b, q) => { ((tracks[b] ||= {}).r ||= []).push(...q); };
  const setT = (b, p) => { ((tracks[b] ||= {}).t ||= []).push(...p); };
  for (let f = 0; f <= frames; f++) {
    const u = f / frames; // 0..1
    const st = poseFn(u);
    setT(BI.hips, st.hipsPos);
    setR(BI.hips, st.hipsQ);
    for (const [bn, q] of Object.entries(st.rots)) setR(BI[bn], q);
  }
  return { name, times, tracks };
}

function buildAllAnimations() {
  const clips = [];

  // 1. IDLE (grounded bladed combat stance, athletic knee flex, breathing, subtle horizon scan)
  clips.push(makePoseClip('idle', 90, (u) => {
    const t = u * Math.PI * 2;
    const br = Math.sin(t) * 0.8 + Math.sin(t * 2 - 0.6) * 0.2;
    const sw = Math.sin(t + 0.85);
    const scan = Math.sin(t - 0.4) * 0.038;
    const hipsPos = [sw * 0.011, REST_W[BI.hips][1] - 0.042 + br * 0.004, sw * 0.003];
    const hipsQ = qEulerYXZ(-0.045, -0.22 + sw * 0.020, sw * 0.015);
    const ikL = solveLegIK('L', [-0.145, ANKLE_H, -0.142], 0, -0.07, 0, hipsPos, hipsQ, 0.24);
    const ikR = solveLegIK('R', [ 0.155, ANKLE_H,  0.108], 0, -0.44, 0, hipsPos, hipsQ, 0.26);
    const arms = makeReadyArms('ready', sw * 0.24, br * 0.28, br);
    return {
      hipsPos, hipsQ,
      rots: {
        spine: qEulerYXZ(0.032 + br * 0.012, 0.12 - sw * 0.010, -sw * 0.008),
        chest: qEulerYXZ(0.022 + br * 0.022, 0.10 - sw * 0.008, -sw * 0.006),
        neck:  qEulerYXZ(-br * 0.014, scan * 0.45, 0),
        head:  qEulerYXZ(-br * 0.012, scan * 0.55, -sw * 0.008),
        thighL: ikL.qThigh, shinL: ikL.qShin, footL: ikL.qFoot, toeL: ikL.qToe,
        thighR: ikR.qThigh, shinR: ikR.qShin, footR: ikR.qFoot, toeR: ikR.qToe,
        ...arms,
      },
    };
  }));

  // 2-5. WALK (1.8 m/s) 4-way
  clips.push(makeLocomotionClip('walk_fwd',   { frames: 32, speed: 1.8, dirX:  0, dirZ: -1, duty: 0.62, lift: 0.105 }));
  clips.push(makeLocomotionClip('walk_back',  { frames: 32, speed: 1.8, dirX:  0, dirZ:  1, duty: 0.62, lift: 0.095 }));
  clips.push(makeLocomotionClip('walk_left',  { frames: 32, speed: 1.8, dirX: -1, dirZ:  0, duty: 0.62, lift: 0.095 }));
  clips.push(makeLocomotionClip('walk_right', { frames: 32, speed: 1.8, dirX:  1, dirZ:  0, duty: 0.62, lift: 0.095 }));

  // 6-9. RUN (4.6 m/s fwd, 3.6 back, 3.8 strafe)
  clips.push(makeLocomotionClip('run_fwd',   { frames: 20, speed: 4.6, dirX:  0, dirZ: -1, duty: 0.32, lift: 0.31 }));
  clips.push(makeLocomotionClip('run_back',  { frames: 20, speed: 3.6, dirX:  0, dirZ:  1, duty: 0.42, lift: 0.20 }));
  clips.push(makeLocomotionClip('run_left',  { frames: 20, speed: 3.8, dirX: -1, dirZ:  0, duty: 0.38, lift: 0.24 }));
  clips.push(makeLocomotionClip('run_right', { frames: 20, speed: 3.8, dirX:  1, dirZ:  0, duty: 0.38, lift: 0.24 }));

  // 10. SPRINT (6.7 m/s)
  clips.push(makeLocomotionClip('sprint', { frames: 16, speed: 6.7, dirX: 0, dirZ: -1, duty: 0.26, lift: 0.36, sprint: true }));

  // 11. CROUCH IDLE (grounded tactical combat kneel with breathing & weight balance)
  clips.push(makePoseClip('crouch_idle', 72, (u) => {
    const t = u * Math.PI * 2;
    const br = Math.sin(t) * 0.8 + Math.sin(t * 2 - 0.5) * 0.2;
    const sw = Math.sin(t + 0.6);
    const hipsPos = [sw * 0.008, 0.555 + br * 0.006, 0.025];
    const hipsQ = qEulerYXZ(-0.16, -0.24 + sw * 0.015, sw * 0.012);
    const ikL = solveLegIK('L', [-0.145, ANKLE_H, -0.27], 0.0, -0.08, 0, hipsPos, hipsQ, 0.32);
    const ikR = solveLegIK('R', [ 0.138, 0.115,  0.45], -1.28, -0.18, 0.88, hipsPos, hipsQ, 0.26);
    const arms = makeReadyArms('ready', sw * 0.15, br * 0.24, br);
    return {
      hipsPos, hipsQ,
      rots: {
        spine: qEulerYXZ(0.09 + br * 0.012, 0.13, -sw * 0.008),
        chest: qEulerYXZ(0.07 + br * 0.018, 0.11, -sw * 0.006),
        neck:  qEulerYXZ(0.05 - br * 0.010, sw * 0.02, 0),
        head:  qEulerYXZ(0.05 - br * 0.010, sw * 0.02, 0),
        thighL: ikL.qThigh, shinL: ikL.qShin, footL: ikL.qFoot, toeL: ikL.qToe,
        thighR: ikR.qThigh, shinR: ikR.qShin, footR: ikR.qFoot, toeR: ikR.qToe,
        ...arms,
      },
    };
  }));

  // 12. CROUCH WALK (2.6 m/s stealthy Groucho walk, level head, planted feet)
  clips.push(makeLocomotionClip('crouch_walk', { frames: 24, speed: 2.6, dirX: 0, dirZ: -1, duty: 0.58, lift: 0.115, crouch: 1 }));

  // 13. PRONE IDLE (natural splayed heels, propped chest, ribcage breathing)
  clips.push(makePoseClip('prone_idle', 72, (u) => {
    const t = u * Math.PI * 2;
    const br = Math.sin(t) * 0.8 + Math.sin(t * 2 - 0.5) * 0.2;
    const sw = Math.sin(t + 0.5) * 0.02;
    const hipsPos = [0, 0.178 + br * 0.004, 0.14];
    const hipsQ = qEulerYXZ(-1.50, 0, sw * 0.4);
    const arms = makeReadyArms('prone', sw * 0.3, br * 0.22, br, 0, 0);
    return {
      hipsPos, hipsQ,
      rots: {
        spine: qEulerYXZ(0.28 + br * 0.018, 0, -sw * 0.2),
        chest: qEulerYXZ(0.26 + br * 0.022, 0, -sw * 0.2),
        neck:  qEulerYXZ(0.46 - br * 0.015, sw * 0.8, 0),
        head:  qEulerYXZ(0.44 - br * 0.015, sw * 0.6, 0),
        // Heels splayed naturally outward so boots lie flat along the ground
        thighL: qEulerYXZ(0.04, -0.22, -0.18), shinL: qEulerYXZ(-0.10, 0, 0), footL: qEulerYXZ(0.85, -0.35, 0.25), toeL: qEulerYXZ(0.10, 0, 0),
        thighR: qEulerYXZ(0.04,  0.22,  0.18), shinR: qEulerYXZ(-0.10, 0, 0), footR: qEulerYXZ(0.85,  0.35, -0.25), toeR: qEulerYXZ(0.10, 0, 0),
        ...arms,
      },
    };
  }));

  // 14. PRONE CRAWL (1.0 m/s contralateral military leopard/low crawl!)
  // Right knee draws forward & pushes while left elbow reaches & pulls, then alternates smoothly
  clips.push(makePoseClip('prone_crawl', 36, (u) => {
    const p = u * Math.PI * 2;
    const s = Math.sin(p), c = Math.cos(p);
    // Smooth drive pulse per leg (0..1 when drawing knee up and pushing back)
    const driveL = Math.pow(Math.max(0,  Math.sin(p)), 0.85);
    const driveR = Math.pow(Math.max(0, -Math.sin(p)), 0.85);
    const pushL  = Math.max(0,  Math.cos(p));
    const pushR  = Math.max(0, -Math.cos(p));
    // Contralateral arm reach: right arm reaches when left leg drives, and vice versa
    const crawlL = -s;
    const crawlR =  s;

    // Pelvis rolls away from driving knee, shifts laterally, and surges with each push
    const hipsPos = [s * 0.042, 0.185 + Math.abs(s) * 0.018, 0.14 - Math.cos(p * 2) * 0.025];
    const hipsQ = qEulerYXZ(-1.46, s * 0.18, c * 0.14);
    const arms = makeReadyArms('prone', s * 0.35, c * 0.25, 0, crawlL, crawlR);
    return {
      hipsPos, hipsQ,
      rots: {
        // S-curve lateral spine flexion counter-balancing hip yaw/roll
        spine: qEulerYXZ(0.26, -s * 0.14, -c * 0.10),
        chest: qEulerYXZ(0.24, -s * 0.12, -c * 0.08),
        neck:  qEulerYXZ(0.45,  s * 0.10, 0),
        head:  qEulerYXZ(0.43,  s * 0.08, -c * 0.04),
        // Left leg: hip abducts & flexes outward, knee bends deeply to ~95 deg, inner boot edge pushes ground
        thighL: qEulerYXZ(0.06 + driveL * 0.62, -0.22 - driveL * 0.35, -0.18 - driveL * 0.42),
        shinL:  qEulerYXZ(-0.12 - driveL * 1.15 - pushL * 0.18, 0, 0),
        footL:  qEulerYXZ(lerp(0.85, 0.15, driveL), -0.35 - driveL * 0.25, 0.25),
        toeL:   qEulerYXZ(driveL * 0.35, 0, 0),
        // Right leg: opposite phase
        thighR: qEulerYXZ(0.06 + driveR * 0.62,  0.22 + driveR * 0.35,  0.18 + driveR * 0.42),
        shinR:  qEulerYXZ(-0.12 - driveR * 1.15 - pushR * 0.18, 0, 0),
        footR:  qEulerYXZ(lerp(0.85, 0.15, driveR),  0.35 + driveR * 0.25, -0.25),
        toeR:   qEulerYXZ(driveR * 0.35, 0, 0),
        ...arms,
      },
    };
  }));

  // 15. JUMP START (anticipation dip -> triple-extension push-off -> knee tuck into flight)
  clips.push(makePoseClip('jump_start', 12, (u) => {
    const dip = Math.sin(clamp(u / 0.38, 0, 1) * Math.PI);
    const launch = smooth(clamp((u - 0.26) / 0.36, 0, 1));
    const tuck = smooth(clamp((u - 0.50) / 0.50, 0, 1));
    const hipsPos = [0, 0.93 - dip * 0.13 + launch * 0.09, -launch * 0.03];
    const hipsQ = qEulerYXZ(-0.06 - dip * 0.14 + launch * 0.08 - tuck * 0.06, -0.06, 0);
    const arms = makeReadyArms('ready', 0, -dip * 0.4 + launch * 0.5);
    return {
      hipsPos, hipsQ,
      rots: {
        spine: qEulerYXZ(0.06 + dip * 0.10 - launch * 0.06, 0.04, 0),
        chest: qEulerYXZ(0.04 + dip * 0.06, 0.02, 0),
        neck:  qEulerYXZ(-dip * 0.08, 0, 0), head: qEulerYXZ(-dip * 0.06, 0, 0),
        thighL: qEulerYXZ(lerp(0.28 + dip * 0.35, 0.68, tuck), 0, -0.06),
        shinL:  qEulerYXZ(lerp(-0.48 - dip * 0.42, -1.02, tuck), 0, 0),
        footL:  qEulerYXZ(lerp(0.10, -0.35, launch), 0, 0), toeL: qEulerYXZ(0, 0, 0),
        thighR: qEulerYXZ(lerp(0.22 + dip * 0.30, 0.20, tuck), 0,  0.06),
        shinR:  qEulerYXZ(lerp(-0.40 - dip * 0.38, -0.62, tuck), 0, 0),
        footR:  qEulerYXZ(lerp(0.10, -0.45, launch), 0, 0), toeR: qEulerYXZ(0, 0, 0),
        ...arms,
      },
    };
  }));

  // 16. FALL LOOP (airborne balance & subtle leg counter-motion)
  clips.push(makePoseClip('fall_loop', 20, (u) => {
    const w = Math.sin(u * Math.PI * 2), c = Math.cos(u * Math.PI * 2);
    const hipsPos = [0, 0.95 + w * 0.016, 0];
    const hipsQ = qEulerYXZ(-0.08 + w * 0.04, -0.06, c * 0.025);
    const arms = makeReadyArms('ready', c * 0.25, w * 0.30);
    return {
      hipsPos, hipsQ,
      rots: {
        spine: qEulerYXZ(0.06 - w * 0.02, 0.04, -c * 0.02),
        chest: qEulerYXZ(0.04 - w * 0.02, 0.02, -c * 0.015),
        neck:  qEulerYXZ(0.02, 0, 0), head: qEulerYXZ(0.02, 0, 0),
        thighL: qEulerYXZ(0.60 + w * 0.10, 0, -0.07), shinL: qEulerYXZ(-0.96 - w * 0.10, 0, 0), footL: qEulerYXZ(-0.24 + c * 0.08, 0, 0), toeL: qEulerYXZ(0, 0, 0),
        thighR: qEulerYXZ(0.20 - w * 0.10, 0,  0.07), shinR: qEulerYXZ(-0.60 + w * 0.10, 0, 0), footR: qEulerYXZ(-0.30 - c * 0.08, 0, 0), toeR: qEulerYXZ(0, 0, 0),
        ...arms,
      },
    };
  }));

  // 17. LAND (weighted impact absorption + elastic recovery)
  clips.push(makePoseClip('land', 12, (u) => {
    // Fast compression (0..0.35), smooth elastic rebound (0.35..1.0)
    const dip = u < 0.35 ? smooth(u / 0.35) : 1 - smooth((u - 0.35) / 0.65);
    const lagDip = u < 0.45 ? smooth(u / 0.45) : 1 - smooth((u - 0.45) / 0.55);
    const hipsPos = [0, 0.93 - dip * 0.27, dip * 0.03];
    const hipsQ = qEulerYXZ(-0.04 - dip * 0.24, -0.10, 0);
    const ikL = solveLegIK('L', [-0.145, ANKLE_H, -0.08], 0, -0.08, 0, hipsPos, hipsQ, 0.30);
    const ikR = solveLegIK('R', [ 0.145, ANKLE_H,  0.08], 0, -0.22, 0, hipsPos, hipsQ, 0.30);
    const arms = makeReadyArms('ready', 0, -lagDip * 0.65);
    return {
      hipsPos, hipsQ,
      rots: {
        spine: qEulerYXZ(lagDip * 0.14, 0.06, 0),
        chest: qEulerYXZ(lagDip * 0.10, 0.04, 0),
        neck:  qEulerYXZ(-lagDip * 0.12, 0, 0), head: qEulerYXZ(-lagDip * 0.10, 0, 0),
        thighL: ikL.qThigh, shinL: ikL.qShin, footL: ikL.qFoot, toeL: ikL.qToe,
        thighR: ikR.qThigh, shinR: ikR.qShin, footR: ikR.qFoot, toeR: ikR.qToe,
        ...arms,
      },
    };
  }));

  // 18. DEATH FORWARD (knees buckle -> gravity drop -> ground impact settle)
  clips.push(makePoseClip('death_fwd', 28, (u) => {
    const buckle = smooth(clamp(u / 0.35, 0, 1));
    const drop = smooth(clamp((u - 0.20) / 0.58, 0, 1));
    const bounce = Math.sin(clamp((u - 0.72) / 0.28, 0, 1) * Math.PI) * 0.025;
    const k = drop * drop;
    const hipsPos = [0, lerp(0.93, 0.165, k) - buckle * 0.14 * (1 - k) + bounce, lerp(0, -0.42, drop)];
    const hipsQ = qEulerYXZ(lerp(0, -1.53, drop), lerp(0, 0.14, drop), lerp(0, 0.09, drop));
    const ikL = solveArmIK('L', [-0.24 * drop - 0.04 * (1 - drop), lerp(0.05, -0.05, drop), lerp(-0.46, -0.28, drop)], [-0.85, -0.4, 0.3], [-0.5, -0.8, 0.1]);
    const ikR = solveArmIK('R', [ 0.22 * drop + 0.08 * (1 - drop), lerp(0.02, -0.06, drop), lerp(-0.30, -0.22, drop)], [ 0.85, -0.4, 0.3], [ 0.8,  0.4, 0.2]);
    return {
      hipsPos, hipsQ,
      rots: {
        spine: qEulerYXZ(lerp(0, 0.10, drop) - buckle * 0.15 * (1 - drop), 0, 0),
        chest: qEulerYXZ(lerp(0, 0.06, drop), 0, 0),
        neck:  qEulerYXZ(lerp(0, -0.14, drop), 0, 0),
        head:  qEulerYXZ(lerp(0, -0.14, drop), lerp(0, 0.52, drop), 0),
        clavicleL: ikL.qClav, upperArmL: ikL.qUp, forearmL: ikL.qFore, handL: ikL.qHand, thumbL: qEulerYXZ(0, 0, 0), fingersL: qEulerYXZ(0, 0, 0),
        clavicleR: ikR.qClav, upperArmR: ikR.qUp, forearmR: ikR.qFore, handR: ikR.qHand, thumbR: qEulerYXZ(0, 0, 0), fingersR: qEulerYXZ(0, 0, 0),
        thighL: qEulerYXZ(lerp(0.1, 0.26, drop) + buckle * 0.30 * (1 - drop), 0, -0.14 * drop),
        shinL:  qEulerYXZ(lerp(-0.1, -0.42, drop) - buckle * 0.55 * (1 - drop), 0, 0),
        footL:  qEulerYXZ(0.45 * drop, -0.2 * drop, 0), toeL: qEulerYXZ(0, 0, 0),
        thighR: qEulerYXZ(lerp(0.05, 0.08, drop) + buckle * 0.25 * (1 - drop), 0, 0.16 * drop),
        shinR:  qEulerYXZ(lerp(-0.1, -0.18, drop) - buckle * 0.45 * (1 - drop), 0, 0),
        footR:  qEulerYXZ(0.45 * drop,  0.2 * drop, 0), toeR: qEulerYXZ(0, 0, 0),
      },
    };
  }));

  // 19. DEATH BACK (stagger back -> drop onto back -> limb settle)
  clips.push(makePoseClip('death_back', 28, (u) => {
    const stag = smooth(clamp(u / 0.30, 0, 1));
    const drop = smooth(clamp((u - 0.18) / 0.60, 0, 1));
    const bounce = Math.sin(clamp((u - 0.74) / 0.26, 0, 1) * Math.PI) * 0.025;
    const k = drop * drop;
    const hipsPos = [0, lerp(0.93, 0.175, k) + bounce, lerp(0, 0.42, drop)];
    const hipsQ = qEulerYXZ(lerp(0, 1.53, drop), lerp(0, -0.16, drop), lerp(0, -0.09, drop));
    const ikL = solveArmIK('L', [-0.30 * drop - 0.03 * (1 - drop), lerp(0.05, -0.10, drop), lerp(-0.46, 0.02, drop)], [-0.9, -0.3, 0.4], [-0.5, -0.8, 0.1]);
    const ikR = solveArmIK('R', [ 0.28 * drop + 0.08 * (1 - drop), lerp(0.02, -0.12, drop), lerp(-0.30, 0.04, drop)], [ 0.9, -0.3, 0.4], [ 0.8,  0.4, 0.2]);
    return {
      hipsPos, hipsQ,
      rots: {
        spine: qEulerYXZ(stag * 0.18 * (1 - drop) - 0.05 * drop, 0, 0),
        chest: qEulerYXZ(stag * 0.14 * (1 - drop) - 0.05 * drop, 0, 0),
        neck:  qEulerYXZ(lerp(0, 0.12, drop), 0, 0),
        head:  qEulerYXZ(lerp(0, 0.16, drop), lerp(0, -0.42, drop), 0),
        clavicleL: ikL.qClav, upperArmL: ikL.qUp, forearmL: ikL.qFore, handL: ikL.qHand, thumbL: qEulerYXZ(0, 0, 0), fingersL: qEulerYXZ(0, 0, 0),
        clavicleR: ikR.qClav, upperArmR: ikR.qUp, forearmR: ikR.qFore, handR: ikR.qHand, thumbR: qEulerYXZ(0, 0, 0), fingersR: qEulerYXZ(0, 0, 0),
        thighL: qEulerYXZ(lerp(0.1, 0.24, drop), 0, -0.16 * drop),
        shinL:  qEulerYXZ(lerp(-0.1, -0.42, drop), 0, 0),
        footL:  qEulerYXZ(-0.22 * drop, -0.25 * drop, 0), toeL: qEulerYXZ(0, 0, 0),
        thighR: qEulerYXZ(lerp(0.05, -0.05, drop), 0, 0.16 * drop),
        shinR:  qEulerYXZ(lerp(-0.1, -0.14, drop), 0, 0),
        footR:  qEulerYXZ(-0.22 * drop,  0.25 * drop, 0), toeR: qEulerYXZ(0, 0, 0),
      },
    };
  }));

  // 20. RELOAD (2.0 s, IK-driven mag swap: grip -> mag well -> chest pouch -> mag well -> grip)
  clips.push(makePoseClip('reload', 60, (u) => {
    const dip = Math.sin(u * Math.PI);
    const hipsPos = [0, REST_W[BI.hips][1] - 0.025, 0];
    const hipsQ = qEulerYXZ(-0.03, -0.14, 0);
    const ikL = solveLegIK('L', [-0.128, ANKLE_H, -0.085], 0, -0.08, 0, hipsPos, hipsQ, 0.22);
    const ikR = solveLegIK('R', [ 0.138, ANKLE_H,  0.075], 0, -0.34, 0, hipsPos, hipsQ, 0.24);
    const seg = (a, b) => smooth(clamp((u - a) / (b - a), 0, 1));
    const toMag   = seg(0.06, 0.22);
    const toPouch = seg(0.24, 0.46);
    const toWell  = seg(0.50, 0.74);
    const toGrip  = seg(0.80, 0.96);
    let lx = lerp(-0.03, 0.04, toMag), ly = lerp(0.05, 0.02, toMag), lz = lerp(-0.48, -0.34, toMag);
    lx = lerp(lx, -0.08, toPouch); ly = lerp(ly, -0.10, toPouch); lz = lerp(lz, -0.22, toPouch);
    lx = lerp(lx,  0.04, toWell);  ly = lerp(ly,  0.02, toWell);  lz = lerp(lz, -0.34, toWell);
    lx = lerp(lx, -0.03, toGrip);  ly = lerp(ly,  0.05, toGrip);  lz = lerp(lz, -0.48, toGrip);
    const armL = solveArmIK('L', [lx, ly, lz], [-0.75, -0.68, 0.22], [-0.5, -0.8, 0.1]);
    const armR = solveArmIK('R', [0.09, 0.04 + dip * 0.02, -0.29], [0.74, -0.62, 0.28], [0.8, 0.4, 0.2]);
    return {
      hipsPos, hipsQ,
      rots: {
        spine: qEulerYXZ(0.02 + dip * 0.05, 0.07, -dip * 0.06),
        chest: qEulerYXZ(0.02 + dip * 0.06, 0.07, -dip * 0.07),
        neck:  qEulerYXZ(-dip * 0.08, 0, 0), head: qEulerYXZ(-dip * 0.10, 0, 0),
        clavicleL: armL.qClav, upperArmL: armL.qUp, forearmL: armL.qFore, handL: armL.qHand,
        clavicleR: armR.qClav, upperArmR: armR.qUp, forearmR: armR.qFore, handR: armR.qHand,
        thumbL: qEulerYXZ(0.15, -0.25, 0.2), fingersL: qEulerYXZ(0, 0, -0.35),
        thumbR: qEulerYXZ(0.15,  0.25, -0.2), fingersR: qEulerYXZ(0, 0,  0.35),
        thighL: ikL.qThigh, shinL: ikL.qShin, footL: ikL.qFoot, toeL: ikL.qToe,
        thighR: ikR.qThigh, shinR: ikR.qShin, footR: ikR.qFoot, toeR: ikR.qToe,
      },
    };
  }));

  // 21. MELEE STRIKE (0.5 s, IK-driven hip-rotated diagonal slash)
  clips.push(makePoseClip('melee', 15, (u) => {
    const wind  = smooth(clamp(u / 0.28, 0, 1));
    const slash = smooth(clamp((u - 0.28) / 0.30, 0, 1));
    const rec   = smooth(clamp((u - 0.58) / 0.42, 0, 1));
    const twist = lerp(lerp(0, -0.48, wind), lerp(0.58, 0, rec), slash);
    const hipsPos = [0, REST_W[BI.hips][1] - 0.035, -slash * (1 - rec) * 0.06];
    const hipsQ = qEulerYXZ(-0.07, twist * 0.35, 0);
    const ikL = solveLegIK('L', [-0.135, ANKLE_H, -0.11], 0, -0.10, 0, hipsPos, hipsQ, 0.24);
    const ikR = solveLegIK('R', [ 0.145, ANKLE_H,  0.09], 0, -0.32, 0, hipsPos, hipsQ, 0.24);
    const rx = lerp(lerp(0.08, 0.34, wind), lerp(-0.24, 0.08, rec), slash);
    const ry = lerp(lerp(0.02, 0.28, wind), lerp(-0.04, 0.02, rec), slash);
    const rz = lerp(lerp(-0.30, -0.12, wind), lerp(-0.48, -0.30, rec), slash);
    const armL = solveArmIK('L', [-0.14, 0.06, -0.34], [-0.78, -0.60, 0.22], [-0.5, -0.8, 0.1]);
    const armR = solveArmIK('R', [rx, ry, rz], [0.85, -0.30, 0.28], [0.8, 0.4, 0.2]);
    return {
      hipsPos, hipsQ,
      rots: {
        spine: qEulerYXZ(0.05, twist * 0.45, 0), chest: qEulerYXZ(0.04, twist * 0.55, 0),
        neck:  qEulerYXZ(0, -twist * 0.45, 0), head: qEulerYXZ(0, -twist * 0.45, 0),
        clavicleL: armL.qClav, upperArmL: armL.qUp, forearmL: armL.qFore, handL: armL.qHand,
        clavicleR: armR.qClav, upperArmR: armR.qUp, forearmR: armR.qFore, handR: armR.qHand,
        thumbL: qEulerYXZ(0.15, -0.25, 0.2), fingersL: qEulerYXZ(0, 0, -0.35),
        thumbR: qEulerYXZ(0.15,  0.25, -0.2), fingersR: qEulerYXZ(0, 0,  0.35),
        thighL: ikL.qThigh, shinL: ikL.qShin, footL: ikL.qFoot, toeL: ikL.qToe,
        thighR: ikR.qThigh, shinR: ikR.qShin, footR: ikR.qFoot, toeR: ikR.qToe,
      },
    };
  }));

  // 22. GRENADE THROW (0.67 s, IK-driven overhand cock, whip throw & follow-through)
  clips.push(makePoseClip('grenade', 20, (u) => {
    const cock = smooth(clamp(u / 0.36, 0, 1));
    const thr  = smooth(clamp((u - 0.36) / 0.28, 0, 1));
    const rec  = smooth(clamp((u - 0.64) / 0.36, 0, 1));
    const twist = lerp(lerp(0, -0.56, cock), lerp(0.46, 0, rec), thr);
    const hipsPos = [0, REST_W[BI.hips][1] - 0.035, -thr * (1 - rec) * 0.05];
    const hipsQ = qEulerYXZ(-0.06, twist * 0.30, 0);
    const ikL = solveLegIK('L', [-0.135, ANKLE_H, -0.13], 0, -0.10, 0, hipsPos, hipsQ, 0.24);
    const ikR = solveLegIK('R', [ 0.145, ANKLE_H,  0.11], 0, -0.36, 0, hipsPos, hipsQ, 0.24);
    const rx = lerp(lerp(0.08, 0.34, cock), lerp(-0.06, 0.08, rec), thr);
    const ry = lerp(lerp(0.02, 0.42, cock), lerp( 0.08, 0.02, rec), thr);
    const rz = lerp(lerp(-0.30, 0.14, cock), lerp(-0.54, -0.30, rec), thr);
    const lx = lerp(lerp(-0.03, -0.10, cock), lerp(-0.18, -0.03, rec), thr);
    const ly = lerp(lerp( 0.05,  0.18, cock), lerp( 0.02,  0.05, rec), thr);
    const lz = lerp(lerp(-0.48, -0.52, cock), lerp(-0.30, -0.48, rec), thr);
    const armL = solveArmIK('L', [lx, ly, lz], [-0.75, -0.55, 0.20], [-0.5, -0.8, 0.1]);
    const armR = solveArmIK('R', [rx, ry, rz], [ 0.85,  0.10, 0.35], [ 0.8,  0.4, 0.2]);
    return {
      hipsPos, hipsQ,
      rots: {
        spine: qEulerYXZ(0.05 - cock * 0.08 * (1 - thr) + thr * 0.10 * (1 - rec), twist * 0.45, 0),
        chest: qEulerYXZ(0.05 - cock * 0.08 * (1 - thr) + thr * 0.10 * (1 - rec), twist * 0.55, 0),
        neck:  qEulerYXZ(0, -twist * 0.45, 0), head: qEulerYXZ(0, -twist * 0.45, 0),
        clavicleL: armL.qClav, upperArmL: armL.qUp, forearmL: armL.qFore, handL: armL.qHand,
        clavicleR: armR.qClav, upperArmR: armR.qUp, forearmR: armR.qFore, handR: armR.qHand,
        thumbL: qEulerYXZ(0.15, -0.25, 0.2), fingersL: qEulerYXZ(0, 0, -0.35),
        thumbR: qEulerYXZ(0.15,  0.25, -0.2), fingersR: qEulerYXZ(0, 0,  0.35),
        thighL: ikL.qThigh, shinL: ikL.qShin, footL: ikL.qFoot, toeL: ikL.qToe,
        thighR: ikR.qThigh, shinR: ikR.qShin, footR: ikR.qFoot, toeR: ikR.qToe,
      },
    };
  }));

  // 23. HIT FLINCH (0.33 s, sharp impact impulse + delayed head whip + damped recovery)
  clips.push(makePoseClip('hit_flinch', 10, (u) => {
    const k = u < 0.28 ? smooth(u / 0.28) : 1 - smooth((u - 0.28) / 0.72);
    const headLag = u < 0.42 ? smooth(clamp((u - 0.08) / 0.34, 0, 1)) : 1 - smooth((u - 0.42) / 0.58);
    const hipsPos = [0, REST_W[BI.hips][1] - 0.025 - k * 0.02, k * 0.035];
    const hipsQ = qEulerYXZ(k * 0.09, -0.12 + k * 0.06, k * 0.05);
    const ikL = solveLegIK('L', [-0.128, ANKLE_H, -0.085], 0, -0.08, 0, hipsPos, hipsQ, 0.22);
    const ikR = solveLegIK('R', [ 0.138, ANKLE_H,  0.075], 0, -0.32, 0, hipsPos, hipsQ, 0.24);
    const arms = makeReadyArms('ready', k * 0.35, k * 0.35);
    return {
      hipsPos, hipsQ,
      rots: {
        spine: qEulerYXZ(k * 0.18, 0.08, k * 0.15),
        chest: qEulerYXZ(k * 0.24, 0.06 + k * 0.18, k * 0.18),
        neck:  qEulerYXZ(headLag * 0.22, 0, -headLag * 0.14),
        head:  qEulerYXZ(headLag * 0.26, 0, -headLag * 0.16),
        thighL: ikL.qThigh, shinL: ikL.qShin, footL: ikL.qFoot, toeL: ikL.qToe,
        thighR: ikR.qThigh, shinR: ikR.qShin, footR: ikR.qFoot, toeR: ikR.qToe,
        ...arms,
      },
    };
  }));

  return clips;
}

// ============================================================================
// 7. GLB PACKER (glTF 2.0 + EXT_texture_webp, LOD0 + LOD1 + Skeleton + 23 Clips)
// ============================================================================
function packGLB(lod0, lod1, tex, clips) {
  const binParts = [];
  let byteOffset = 0;
  const bufferViews = [];
  const accessors = [];

  function pushBytes(buf, target = undefined) {
    const pad = (-byteOffset) & 3;
    if (pad) { binParts.push(Buffer.alloc(pad)); byteOffset += pad; }
    const viewIdx = bufferViews.length;
    const bv = { buffer: 0, byteOffset, byteLength: buf.length };
    if (target) bv.target = target;
    bufferViews.push(bv);
    binParts.push(buf);
    byteOffset += buf.length;
    return viewIdx;
  }

  function pushAccessor(typedArr, componentType, type, target = undefined, computeMinMax = false) {
    const buf = Buffer.from(typedArr.buffer, typedArr.byteOffset, typedArr.byteLength);
    const bvIdx = pushBytes(buf, target);
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
    const count = typedArr.length / comps;
    const acc = { bufferView: bvIdx, componentType, count, type };
    if (computeMinMax) {
      const mn = Array(comps).fill(Infinity), mx = Array(comps).fill(-Infinity);
      for (let i = 0; i < count; i++) {
        for (let c = 0; c < comps; c++) {
          const val = typedArr[i * comps + c];
          if (val < mn[c]) mn[c] = val;
          if (val > mx[c]) mx[c] = val;
        }
      }
      acc.min = mn; acc.max = mx;
    }
    const idx = accessors.length;
    accessors.push(acc);
    return idx;
  }

  // Images (WebP via EXT_texture_webp)
  const bvCol = pushBytes(tex.colWebp);
  const bvNrm = pushBytes(tex.nrmWebp);
  const bvOrm = pushBytes(tex.ormWebp);

  const images = [
    { name: 'soldier2_color',  bufferView: bvCol, mimeType: 'image/webp' },
    { name: 'soldier2_normal', bufferView: bvNrm, mimeType: 'image/webp' },
    { name: 'soldier2_orm',    bufferView: bvOrm, mimeType: 'image/webp' },
  ];
  const samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }];
  const textures = [0, 1, 2].map((src) => ({
    sampler: 0,
    extensions: { EXT_texture_webp: { source: src } },
  }));
  const materials = [{
    name: 'Soldier2Mat',
    pbrMetallicRoughness: {
      baseColorTexture: { index: 0 },
      metallicRoughnessTexture: { index: 2 },
      metallicFactor: 1.0,
      roughnessFactor: 1.0,
    },
    normalTexture: { index: 1, scale: 1.0 },
    occlusionTexture: { index: 2, strength: 0.7 },
  }];

  // Meshes (LOD0 and LOD1)
  function pushMesh(mb, name) {
    const posAcc = pushAccessor(new Float32Array(mb.pos), 5126, 'VEC3', 34962, true);
    const norAcc = pushAccessor(new Float32Array(mb.nor), 5126, 'VEC3', 34962);
    const uvAcc  = pushAccessor(new Float32Array(mb.uv),  5126, 'VEC2', 34962);
    const jntAcc = pushAccessor(new Uint8Array(mb.joints), 5121, 'VEC4', 34962);
    const wgtAcc = pushAccessor(new Float32Array(mb.weights), 5126, 'VEC4', 34962);
    const idxArr = (mb.pos.length / 3) < 65535 ? new Uint16Array(mb.idx) : new Uint32Array(mb.idx);
    const idxComp = idxArr instanceof Uint16Array ? 5123 : 5125;
    const idxAcc = pushAccessor(idxArr, idxComp, 'SCALAR', 34963);
    return {
      name,
      primitives: [{
        attributes: {
          POSITION: posAcc, NORMAL: norAcc, TEXCOORD_0: uvAcc,
          JOINTS_0: jntAcc, WEIGHTS_0: wgtAcc,
        },
        indices: idxAcc,
        material: 0,
      }],
    };
  }
  const meshes = [pushMesh(lod0, 'Soldier_LOD0'), pushMesh(lod1, 'Soldier_LOD1')];

  // Inverse bind matrices (each bone's world rest transform is pure translation REST_W[i])
  const ibm = new Float32Array(BONES.length * 16);
  for (let i = 0; i < BONES.length; i++) {
    const o = i * 16;
    ibm[o] = 1; ibm[o + 5] = 1; ibm[o + 10] = 1; ibm[o + 15] = 1;
    ibm[o + 12] = -REST_W[i][0];
    ibm[o + 13] = -REST_W[i][1];
    ibm[o + 14] = -REST_W[i][2];
  }
  const ibmAcc = pushAccessor(ibm, 5126, 'MAT4');

  // Nodes: 0 = ArmatureRoot, 1..25 = Bones (node index = 1 + boneIdx), 26 = Soldier_LOD0, 27 = Soldier_LOD1
  const nodes = [{ name: 'SoldierRoot', children: [1, 1 + BONES.length, 2 + BONES.length] }];
  const childMap = BONES.map(() => []);
  BONES.forEach((b, i) => { if (b[1] >= 0) childMap[b[1]].push(1 + i); });
  BONES.forEach((b, i) => {
    const nd = { name: b[0], translation: REST_L[i] };
    if (childMap[i].length) nd.children = childMap[i];
    nodes.push(nd);
  });
  nodes.push({ name: 'Soldier_LOD0', mesh: 0, skin: 0 });
  nodes.push({ name: 'Soldier_LOD1', mesh: 1, skin: 0 });

  const skins = [{
    name: 'SoldierRig',
    inverseBindMatrices: ibmAcc,
    skeleton: 1,
    joints: BONES.map((_, i) => 1 + i),
  }];

  // Animations
  const animations = clips.map((clip) => {
    const timeAcc = pushAccessor(new Float32Array(clip.times), 5126, 'SCALAR', undefined, true);
    const samplersA = [], channelsA = [];
    for (const [bStr, tr] of Object.entries(clip.tracks)) {
      const nodeIdx = 1 + Number(bStr);
      if (tr.t) {
        const outAcc = pushAccessor(new Float32Array(tr.t), 5126, 'VEC3');
        const si = samplersA.length;
        samplersA.push({ input: timeAcc, output: outAcc, interpolation: 'LINEAR' });
        channelsA.push({ sampler: si, target: { node: nodeIdx, path: 'translation' } });
      }
      if (tr.r) {
        const outAcc = pushAccessor(new Float32Array(tr.r), 5126, 'VEC4');
        const si = samplersA.length;
        samplersA.push({ input: timeAcc, output: outAcc, interpolation: 'LINEAR' });
        channelsA.push({ sampler: si, target: { node: nodeIdx, path: 'rotation' } });
      }
    }
    return { name: clip.name, samplers: samplersA, channels: channelsA };
  });

  // Pad BIN to 4-byte boundary
  const padEnd = (-byteOffset) & 3;
  if (padEnd) { binParts.push(Buffer.alloc(padEnd)); byteOffset += padEnd; }
  const binBuf = Buffer.concat(binParts);

  const gltf = {
    asset: { version: '2.0', generator: 'Midtown Strike procedural soldier2 builder' },
    extensionsUsed: ['EXT_texture_webp'],
    extensionsRequired: ['EXT_texture_webp'],
    scene: 0,
    scenes: [{ name: 'Scene', nodes: [0] }],
    nodes,
    meshes,
    skins,
    materials,
    textures,
    images,
    samplers,
    animations,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binBuf.length }],
  };

  let jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jPad = (-jsonBuf.length) & 3;
  if (jPad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jPad, 0x20)]);

  const totalLen = 12 + 8 + jsonBuf.length + 8 + binBuf.length;
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 4, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLen, 8);

  const jHead = Buffer.alloc(8);
  jHead.writeUInt32LE(jsonBuf.length, 0);
  jHead.write('JSON', 4, 4, 'ascii');

  const bHead = Buffer.alloc(8);
  bHead.writeUInt32LE(binBuf.length, 0);
  bHead.write('BIN\0', 4, 4, 'ascii');

  return Buffer.concat([header, jHead, jsonBuf, bHead, binBuf]);
}

// ============================================================================
// MAIN
// ============================================================================
const lod0 = buildSoldierMesh(0);
const lod1 = buildSoldierMesh(1);
const lod0Tris = lod0.idx.length / 3;
const lod1Tris = lod1.idx.length / 3;
console.log(`Built meshes: LOD0 ${lod0.pos.length / 3} verts / ${lod0Tris} tris | LOD1 ${lod1.pos.length / 3} verts / ${lod1Tris} tris`);

const tex = buildPBRTextures(2048);
const clips = buildAllAnimations();
console.log(`Authored ${clips.length} animation clips @ ${FPS} fps: ${clips.map((c) => c.name).join(', ')}`);

const glb = packGLB(lod0, lod1, tex, clips);
const glbPath = `${TMP_DIR}/soldier2.glb`;
writeFileSync(glbPath, glb);

const b64 = glb.toString('base64');
const meta = {
  lod0Verts: lod0.pos.length / 3,
  lod0Tris,
  lod1Verts: lod1.pos.length / 3,
  lod1Tris,
  bones: BONES.length,
  tex: 2048,
  fps: FPS,
  clips: clips.map((c) => c.name),
  refSpeeds: Object.fromEntries(clips.filter((c) => c.refSpeed).map((c) => [c.name, c.refSpeed])),
  glbBytes: glb.length,
};

const jsOut = [
  '// Generated by tools/build_soldier2_glb.mjs. Do not edit by hand.',
  '// Original procedural modern infantry soldier: LOD0 + LOD1, 2048 WebP PBR (EXT_texture_webp), 25-bone rig, 23 clips @ 30 fps.',
  `export const SOLDIER2_META = ${JSON.stringify(meta)};`,
  `export const SOLDIER2_GLB = '${b64}';`,
  '',
].join('\n');

writeFileSync(OUT_JS, jsOut, 'utf8');
console.log(`Wrote ${OUT_JS} (${(jsOut.length / 1024 / 1024).toFixed(2)} MB | GLB ${(glb.length / 1024 / 1024).toFixed(2)} MB)`);
rmSync(`${TMP_DIR}/col.png`, { force: true });
rmSync(`${TMP_DIR}/nrm.png`, { force: true });
rmSync(`${TMP_DIR}/orm.png`, { force: true });
