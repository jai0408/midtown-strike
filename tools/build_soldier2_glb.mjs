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

  // ---- TORSO (hips -> spine -> chest -> collar) ----------------------------
  const torsoRows = [
    // [y, cz, rx, rFront, rBack]
    [0.84,  0.004, 0.122, 0.092, 0.098],
    [0.89,  0.005, 0.160, 0.106, 0.114],
    [0.95,  0.005, 0.172, 0.110, 0.118],
    [1.02,  0.003, 0.166, 0.106, 0.110],
    [1.09,  0.000, 0.162, 0.104, 0.106],
    [1.18, -0.002, 0.168, 0.108, 0.108],
    [1.28, -0.004, 0.180, 0.115, 0.112],
    [1.38, -0.005, 0.196, 0.118, 0.112],
    [1.46, -0.002, 0.200, 0.108, 0.104],
    [1.51,  0.000, 0.150, 0.084, 0.084],
    [1.545, 0.002, 0.078, 0.068, 0.070],
  ];
  const torsoW = (x, y) => {
    const wNeck = sstep(1.48, 1.54, y);
    const wChest = sstep(1.17, 1.32, y) * (1 - wNeck);
    const wSpine = sstep(0.99, 1.11, y) * (1 - wChest) * (1 - wNeck);
    const wHips = Math.max(0, 1 - wNeck - wChest - wSpine);
    return [[BI.hips, wHips], [BI.spine, wSpine], [BI.chest, wChest], [BI.neck, wNeck]];
  };
  addTube(
    mb,
    torsoRows.map((r) => [0, r[0], r[1]]),
    torsoRows.map((r) => r[2]),
    torsoRows.map((r) => [r[4], r[3]]),
    seg(22), 2.35, [1, 0, 0], 'camo', torsoW
  );

  // ---- NECK & BALACLAVA HEAD (1.52m -> 1.80m) ------------------------------
  const headRows = [
    [1.515,  0.002, 0.062, 0.062, 0.064],
    [1.560,  0.000, 0.056, 0.058, 0.060],
    [1.600, -0.015, 0.064, 0.072, 0.070],
    [1.635, -0.008, 0.074, 0.088, 0.086],
    [1.675, -0.002, 0.079, 0.098, 0.098],
    [1.715,  0.000, 0.081, 0.098, 0.102],
    [1.755,  0.004, 0.074, 0.086, 0.098],
    [1.790,  0.008, 0.052, 0.058, 0.074],
    [1.805,  0.010, 0.022, 0.024, 0.036],
  ];
  // Rigid split at collar (1.535m) so 1P head-hide (head.scale = 0.001) never stretches neck triangles
  const headW = (x, y) => (y > 1.535 ? [[BI.head, 1]] : [[BI.chest, 1]]);
  addTube(
    mb,
    headRows.map((r) => [0, r[0], r[1]]),
    headRows.map((r) => r[2]),
    headRows.map((r) => [r[4], r[3]]),
    seg(18), 2.15, [1, 0, 0], 'balaclava', headW
  );
  // Subtle nose bridge bump under balaclava
  addRoundedBox(mb, [0.026, 0.042, 0.032], [0, 1.678, -0.098], [0.22, 0, 0], bseg(2), 2.4, 'balaclava', rigidW('head'));

  // ---- BALLISTIC GOGGLES / EYEWEAR -----------------------------------------
  const gogPath = [];
  const gSteps = lod === 0 ? 12 : 7;
  for (let k = 0; k <= gSteps; k++) {
    const ph = (-72 + (144 * k) / gSteps) * (Math.PI / 180);
    gogPath.push([0.093 * Math.sin(ph), 1.702, -0.108 * Math.cos(ph)]);
  }
  addTube(mb, gogPath, 0.026, 0.005, seg(8), 3.2, [0, 1, 0], 'lens', rigidW('head'));
  // Goggle frame rim top & bottom
  addTube(mb, gogPath.map((p) => [p[0], p[1] + 0.024, p[2] - 0.002]), 0.006, 0.006, 6, 2.2, [0, 1, 0], 'pads', rigidW('head'));
  addTube(mb, gogPath.map((p) => [p[0], p[1] - 0.024, p[2] - 0.002]), 0.005, 0.005, 6, 2.2, [0, 1, 0], 'pads', rigidW('head'));

  // ---- TACTICAL HELMET (FAST / MICH high-cut, top at 1.832m) ---------------
  const hSeg = seg(24), hRings = lod === 0 ? 8 : 5;
  const hVerts = [], hUvs = [], hFaces = [];
  const colsH = hSeg + 1;
  for (let j = 0; j <= hRings; j++) {
    const vFrac = j / hRings;
    for (let k = 0; k <= hSeg; k++) {
      const th = (2 * Math.PI * k) / hSeg; // 0 = front (-Z)
      const c = Math.cos(th), s = Math.sin(th);
      // High-cut rim over ears, drops down at nape
      const earCut = Math.exp(-Math.pow((Math.abs(s) - 0.92) * 3.5, 2)) * 0.032;
      const rimY = 1.685 + 0.045 * Math.max(0, c) - 0.022 * Math.max(0, -c) + earCut;
      const y = lerp(rimY, 1.832, Math.sin(vFrac * Math.PI * 0.5));
      const tDome = clamp((y - 1.69) / 0.142, 0, 1);
      const rad = Math.sqrt(Math.max(0.002, 1 - tDome * tDome));
      const rx = 0.112 * rad;
      const rz = (c >= 0 ? 0.124 : 0.132) * rad;
      hVerts.push([rx * s, y, 0.008 - rz * c]);
      hUvs.push([k / hSeg, vFrac]);
    }
  }
  for (let j = 0; j < hRings; j++) {
    for (let k = 0; k < hSeg; k++) {
      hFaces.push([j * colsH + k, j * colsH + k + 1, (j + 1) * colsH + k + 1, (j + 1) * colsH + k]);
    }
  }
  mb.addPart(hVerts, hFaces, hUvs, 'helmet', rigidW('head'));

  // Helmet NVG shroud, side ARC rails, Peltor ear-pro headset cups, boom mic, chinstrap
  addRoundedBox(mb, [0.068, 0.052, 0.028], [0, 1.776, -0.112], [-0.35, 0, 0], bseg(2), 2.5, 'metal', rigidW('head'));
  for (const s of [-1, 1]) {
    addRoundedBox(mb, [0.014, 0.022, 0.115], [s * 0.112, 1.745, 0.002], [0, 0, 0], bseg(2), 2.5, 'metal', rigidW('head'));
    // Ear-pro headset cup
    addRoundedBox(mb, [0.036, 0.088, 0.074], [s * 0.104, 1.672, 0.006], [0, 0, 0], bseg(2), 2.2, 'gearDark', rigidW('head'));
    addRoundedBox(mb, [0.012, 0.056, 0.048], [s * 0.120, 1.672, 0.006], [0, 0, 0], 1, 2.2, 'pads', rigidW('head'));
  }
  if (lod === 0) {
    // Boom mic on left headset
    addTube(mb, [[-0.108, 1.660, -0.005], [-0.105, 1.648, -0.055], [-0.082, 1.638, -0.095], [-0.045, 1.634, -0.106]], 0.004, 0.004, 6, 2, [0, 1, 0], 'pads', rigidW('head'));
    // Chinstrap
    addTube(mb, [[-0.095, 1.70, 0.01], [-0.086, 1.64, -0.025], [-0.055, 1.59, -0.065], [0, 1.578, -0.075], [0.055, 1.59, -0.065], [0.086, 1.64, -0.025], [0.095, 1.70, 0.01]], 0.007, 0.003, 6, 2.5, [0, 0, 1], 'gearDark', rigidW('head'));
  }

  // ---- PLATE CARRIER, POUCHES, BATTLE BELT ---------------------------------
  // Front & back plate bags (crisp beveled Cordura silhouettes)
  addRoundedBox(mb, [0.305, 0.315, 0.060], [0, 1.335, -0.128], [0.04, 0, 0], bseg(3), 5.6, 'gear', rigidW('chest'));
  addRoundedBox(mb, [0.300, 0.310, 0.060], [0, 1.335,  0.128], [-0.03, 0, 0], bseg(3), 5.6, 'gear', rigidW('chest'));
  // Cummerbund wrapping lower ribs
  addTube(mb, [[0, 1.14, 0], [0, 1.22, 0], [0, 1.30, 0]], [0.184, 0.190, 0.186], [0.128, 0.134, 0.130], seg(20), 2.8, [1, 0, 0], 'gearDark', (x, y) => {
    const wc = sstep(1.13, 1.24, y);
    return [[BI.chest, wc], [BI.spine, 1 - wc]];
  });
  // Padded shoulder straps
  for (const s of [-1, 1]) {
    addTube(mb, [
      [s * 0.092, 1.475, -0.144], [s * 0.098, 1.522, -0.085],
      [s * 0.106, 1.545,  0.000], [s * 0.098, 1.522,  0.085], [s * 0.092, 1.475,  0.144],
    ], 0.034, 0.012, seg(8), 3.6, [1, 0, 0], 'gear', rigidW('chest'));
  }
  // 3 front M4 magazine pouches + admin pouch + name tape
  for (const mx of [-0.088, 0.0, 0.088]) {
    addRoundedBox(mb, [0.076, 0.136, 0.044], [mx, 1.255, -0.174], [0, 0, 0], bseg(2), 5.8, 'gearDark', rigidW('chest'));
    if (lod === 0) {
      addRoundedBox(mb, [0.078, 0.038, 0.048], [mx, 1.308, -0.176], [0, 0, 0], 1, 5.5, 'gear', rigidW('chest'));
    }
  }
  addRoundedBox(mb, [0.140, 0.068, 0.026], [0.02, 1.398, -0.168], [0, 0, 0], bseg(2), 5.6, 'gearDark', rigidW('chest'));
  // Chest name tape
  addRoundedBox(mb, [0.155, 0.034, 0.008], [0, 1.458, -0.160], [0, 0, 0], 1, 5.0, 'tape', rigidW('chest'));
  // Left side radio + whip antenna
  addRoundedBox(mb, [0.052, 0.142, 0.068], [-0.198, 1.215, -0.01], [0, 0, 0], bseg(2), 5.6, 'gearDark', rigidW('chest'));
  if (lod === 0) {
    addTube(mb, [[-0.198, 1.29, 0.015], [-0.205, 1.45, 0.04], [-0.210, 1.62, 0.065]], 0.005, 0.005, 6, 2, [1, 0, 0], 'pads', rigidW('chest'));
  }
  // Back hydration pack + IFAK pouch
  addRoundedBox(mb, [0.220, 0.275, 0.066], [0, 1.355, 0.186], [0, 0, 0], bseg(2), 5.5, 'gearDark', rigidW('chest'));
  addRoundedBox(mb, [0.125, 0.105, 0.050], [0.065, 1.210, 0.182], [0, 0, 0], bseg(2), 5.5, 'gear', rigidW('chest'));

  // Battle belt + cobra buckle + right holster + left dump pouch
  addTube(mb, [[0, 1.005, 0], [0, 1.035, 0], [0, 1.065, 0]], [0.174, 0.178, 0.172], [0.118, 0.122, 0.116], seg(20), 2.8, [1, 0, 0], 'gearDark', rigidW('hips'));
  addRoundedBox(mb, [0.056, 0.038, 0.014], [0, 1.035, -0.124], [0, 0, 0], 1, 5.0, 'metal', rigidW('hips'));
  addRoundedBox(mb, [0.048, 0.178, 0.088], [0.182, 0.945, 0.015], [0, 0, 0], bseg(2), 5.6, 'gearDark', rigidW('hips'));
  addRoundedBox(mb, [0.048, 0.130, 0.098], [-0.184, 0.965, 0.036], [0, 0, 0], bseg(2), 5.6, 'gearDark', rigidW('hips'));

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
    const samplesF = [0.12, 0.32, 0.58, 0.82, 0.96, 1.0];
    const radsF    = [0.055, 0.054, 0.049, 0.044, 0.042, 0.040];
    for (let i = 0; i < samplesF.length; i++) {
      armPath.push(add(jFore, mul(dirF, samplesF[i] * lenF)));
      armRa.push(radsF[i]); armRb.push(radsF[i] * 0.94);
    }
    const armW = chainWeightFn(
      [jClav, jUp, jFore, jHand],
      [BI['clavicle' + side], BI['upperArm' + side], BI['forearm' + side], BI['hand' + side]],
      [0.055, 0.055, 0.032]
    );
    addTube(mb, armPath, armRa, armRb, seg(16), 2.1, [0, 0, 1], 'camo', armW);
    // Rounded deltoid cap overlapping shoulder joint seamlessly
    addRoundedBox(mb, [0.135, 0.138, 0.142], [s * 0.190, 1.458, 0.002], [0, 0, s * -0.25], bseg(2), 2.1, 'camo', (x) => {
      const wu = sstep(0.155, 0.215, Math.abs(x));
      return [[BI['upperArm' + side], wu], [BI['clavicle' + side], 1 - wu]];
    });

    // Shoulder flag patch on upper arm
    const flagP = add(jUp, mul(dirU, lenU * 0.28));
    const flagRot = [0, 0, s * -0.60];
    addRoundedBox(mb, [0.068, 0.012, 0.046], add(flagP, [0, 0.056, 0]), flagRot, 1, 3.5, 'flag', rigidW('upperArm' + side));

    // Elbow pad (on back/outer side of elbow)
    addRoundedBox(mb, [0.078, 0.065, 0.042], add(jFore, [0, -0.022, 0.048]), [0, 0, s * -0.58], bseg(2), 2.4, 'pads', rigidW('forearm' + side));

    // ---- GLOVED HAND (relaxed grip pose: palm faces inward/down, fingers curved) ----
    // Local hand basis: H_along = dirF (wrist -> knuckles), H_front = -Z (thumb side), H_back = cross(H_front, H_along)*s
    const hAlong = dirF;
    const hFwd = [0, 0, -1];
    const hOut = norm(cross(hAlong, hFwd)); // points up/back-of-hand for L, down/palm for R -> multiply by -s for back-of-hand
    const hBack = mul(hOut, -s);
    const hPt = (al, bk, fw) => add(jHand, add(mul(hAlong, al), add(mul(hBack, bk), mul(hFwd, fw))));

    // Wrist cuff + Palm
    addTube(mb, [hPt(-0.025, 0, 0), hPt(0.0, 0, 0), hPt(0.035, 0, 0), hPt(0.072, 0, 0), hPt(0.088, -0.005, 0)],
      [0.036, 0.038, 0.041, 0.043, 0.038], [0.030, 0.026, 0.021, 0.018, 0.014], seg(12), 2.5, hFwd, 'glove', rigidW('hand' + side));
    // Knuckle guard plate on back of hand
    addRoundedBox(mb, [0.028, 0.014, 0.072], hPt(0.074, 0.018, 0.0), [0, 0, s * -0.58], 1, 2.5, 'pads', rigidW('hand' + side));

    // Relaxed-grip curved fingers (4 individual fingers on LOD0, 2 grouped mittens on LOD1)
    const fingerSpecs = lod === 0
      ? [[0.028, 0.010, [0.032, 0.022, 0.018], [0.40, 0.85, 1.25]],
         [0.010, 0.0105, [0.036, 0.024, 0.019], [0.55, 1.05, 1.50]],
         [-0.009, 0.0098, [0.033, 0.022, 0.018], [0.65, 1.15, 1.60]],
         [-0.027, 0.0086, [0.028, 0.018, 0.016], [0.72, 1.22, 1.65]]]
      : [[0.018, 0.016, [0.034, 0.024, 0.018], [0.48, 0.95, 1.38]],
         [-0.016, 0.015, [0.031, 0.020, 0.017], [0.68, 1.18, 1.62]]];
    const fingW = (x, y, z) => {
      const d = vlen(sub([x, y, z], hPt(0.085, 0, 0)));
      const wf = sstep(0.005, 0.025, d);
      return [[BI['fingers' + side], wf], [BI['hand' + side], 1 - wf]];
    };
    for (const [fwOff, rad, lens, angs] of fingerSpecs) {
      let al = 0.084, bk = -0.004;
      const fpts = [hPt(al, bk, fwOff)];
      const frads = [rad];
      for (let k = 0; k < lens.length; k++) {
        al += Math.cos(angs[k]) * lens[k];
        bk -= Math.sin(angs[k]) * lens[k];
        fpts.push(hPt(al, bk, fwOff));
        frads.push(rad * (1 - 0.14 * (k + 1)));
      }
      addTube(mb, fpts, frads, frads, lod === 0 ? 7 : 6, 2.0, hFwd, 'glove', fingW);
    }
    // Thumb opposing the fingers
    const tpts = [hPt(0.018, -0.010, 0.034), hPt(0.044, -0.024, 0.048), hPt(0.070, -0.036, 0.046), hPt(0.090, -0.042, 0.036)];
    addTube(mb, tpts, [0.014, 0.0125, 0.011, 0.009], [0.014, 0.0125, 0.011, 0.009], 7, 2.0, hBack, 'glove', rigidW('thumb' + side));
  }

  // ---- LEGS (trousers, cargo pockets, knee pads, combat boots) -------------
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? -1 : 1;
    const jHip  = REST_W[BI['thigh' + side]];
    const jKnee = REST_W[BI['shin' + side]];
    const jAnk  = REST_W[BI['foot' + side]];
    const jToe  = REST_W[BI['toe' + side]];

    const legRows = [
      // [y, rx, rFront, rBack]
      [0.955, 0.105, 0.102, 0.108],
      [0.860, 0.100, 0.096, 0.103],
      [0.740, 0.092, 0.088, 0.093],
      [0.620, 0.082, 0.079, 0.081],
      [0.540, 0.076, 0.073, 0.074],
      [0.505, 0.075, 0.073, 0.074],
      [0.455, 0.074, 0.069, 0.078],
      [0.370, 0.072, 0.066, 0.083],
      [0.270, 0.067, 0.063, 0.072],
      [0.210, 0.068, 0.066, 0.068],
    ];
    const lxAt = (y) => lerp(jAnk[0], jHip[0], clamp((y - jAnk[1]) / (jHip[1] - jAnk[1]), 0, 1));
    const lzAt = (y) => lerp(jAnk[2], jHip[2], clamp((y - jAnk[1]) / (jHip[1] - jAnk[1]), 0, 1));
    const legW = (x, y) => {
      if (y > 0.78) {
        const wh = sstep(0.87, 0.96, y);
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
      seg(16), 2.2, [1, 0, 0], 'camo', legW
    );

    // Thigh cargo pocket (snug crisp flap pocket)
    addRoundedBox(mb, [0.036, 0.162, 0.118], [lxAt(0.74) + s * 0.084, 0.74, lzAt(0.74)], [0, 0, 0], bseg(2), 5.6, 'camo', rigidW('thigh' + side));
    // Contoured tactical knee pad + hard cap
    addRoundedBox(mb, [0.098, 0.128, 0.042], [lxAt(0.495), 0.495, lzAt(0.495) - 0.070], [0.10, 0, 0], bseg(2), 3.2, 'pads', rigidW('shin' + side));
    if (lod === 0) {
      addRoundedBox(mb, [0.066, 0.074, 0.018], [lxAt(0.495), 0.495, lzAt(0.495) - 0.088], [0.10, 0, 0], 1, 3.2, 'metal', rigidW('shin' + side));
    }

    // Combat boot shaft (ankle -> lower shin, extends cleanly into heel)
    const shaftW = (x, y) => {
      const ws = sstep(0.075, 0.155, y);
      return [[BI['shin' + side], ws], [BI['foot' + side], 1 - ws]];
    };
    addTube(
      mb,
      [[jAnk[0], 0.036, jAnk[2] + 0.008], [jAnk[0], 0.085, jAnk[2]], [jAnk[0], 0.155, jAnk[2]], [jAnk[0], 0.235, jAnk[2]]],
      [0.052, 0.055, 0.058, 0.062], [0.058, 0.057, 0.059, 0.061], seg(14), 2.2, [1, 0, 0], 'boot', shaftW
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
          // Digital camo macro + micro blocks
          const bx = Math.floor(lu * 64), by = Math.floor(lv * 64);
          const n1 = fbm(bx * 0.14, by * 0.14, 3, 1775) + (hash2(bx, by, 99) - 0.5) * 0.18;
          const n2 = fbm(bx * 0.22 + 5.1, by * 0.22 + 2.7, 2, 2021) + (hash2(bx >> 1, by >> 1, 77) - 0.5) * 0.16;
          const ci = n2 > 0.64 ? 2 : n2 < 0.34 ? 3 : n1 > 0.53 ? 1 : 0;
          [r, g, b] = CAMO_PAL[ci];
          // Ripstop fabric crosshatch weave
          const weave = ((x & 3) === 0 || (y & 3) === 0) ? 0.92 : (((x + y) & 1) ? 1.03 : 0.98);
          const fold = fbm(lu * 10, lv * 26, 3, 404);
          const dirt = clamp(fbm(lu * 7, lv * 7, 3, 808) * 1.4 - 0.55, 0, 1) * (lv < 0.35 ? 0.55 : 0.18);
          // Stitching seam line down center
          const stitch = Math.abs(lu - 0.5) < 0.004 && ((y % 8) < 4) ? 1 : 0;
          r = r * weave * (0.86 + 0.26 * fold) * (1 - dirt * 0.35) + 125 * dirt * 0.35;
          g = g * weave * (0.86 + 0.26 * fold) * (1 - dirt * 0.35) + 112 * dirt * 0.35;
          b = b * weave * (0.86 + 0.26 * fold) * (1 - dirt * 0.35) + 88 * dirt * 0.35;
          if (stitch) { r *= 0.65; g *= 0.65; b *= 0.65; }
          h = 0.5 + (weave - 0.98) * 1.8 + (fold - 0.5) * 0.7 - stitch * 0.35;
          rough = clamp(0.86 + (fold - 0.5) * 0.1 + dirt * 0.08, 0.72, 0.96);
          ao = clamp(0.84 + 0.16 * fold - stitch * 0.15, 0.55, 1.0);
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
          // Dark charcoal ribbed tactical balaclava
          const rib = Math.sin(lu * Math.PI * 96) * 0.5 + 0.5;
          const n = fbm(lu * 14, lv * 14, 2, 333);
          const v = 34 + rib * 10 + n * 12;
          r = v * 0.96; g = v * 0.98; b = v * 1.04;
          h = 0.45 + rib * 0.25 + (n - 0.5) * 0.15;
          rough = 0.90; ao = 0.82 + rib * 0.12;
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
          // Tactical Mechanix-style charcoal/coyote gloves
          const knit = ((x & 2) === 0 || (y & 2) === 0) ? 0.94 : 1.04;
          const n = fbm(lu * 24, lv * 24, 2, 612);
          r = (58 + edgeWear * 20) * knit * (0.88 + 0.22 * n);
          g = (56 + edgeWear * 18) * knit * (0.88 + 0.22 * n);
          b = (52 + edgeWear * 14) * knit * (0.88 + 0.22 * n);
          h = 0.5 + (knit - 0.99) * 1.6 + (n - 0.5) * 0.3;
          rough = 0.72; ao = 0.85;
        } else if (box.name === 'pads') {
          // Hard-shell polymer knee/elbow pads with scuffs
          const scuff = fbm(lu * 18, lv * 18, 3, 911);
          const v = 42 + edgeWear * 26 + scuff * 14;
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
          // Dark tinted ballistic eyewear lens (phone-safe roughness >= 0.16)
          const sheen = Math.pow(1 - Math.abs(lu - 0.5) * 2, 2);
          r = 18 + sheen * 16; g = 24 + sheen * 22; b = 32 + sheen * 30;
          h = 0.55;
          rough = 0.18; metal = 0.15; ao = 0.95;
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
function solveLegIK(side, ankleModel, footPitch, footYaw, toePitch, hipsPos, hipsQ) {
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
  d = clamp(d, 0.14, LEG_MAX);
  const cosA = clamp((THIGH_L * THIGH_L + d * d - SHIN_L * SHIN_L) / (2 * THIGH_L * d), -1, 1);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  // Knee pole: forward (-Z) and slightly outward
  const poleModel = [-Math.sin(footYaw) + s * 0.18 * Math.cos(footYaw), 0, -Math.cos(footYaw) - s * 0.18 * Math.sin(footYaw)];
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
function solveArmIK(side, handTargetChest, elbowPoleChest, palmInChest) {
  const s = side === 'L' ? -1 : 1;
  const clavOff = REST_L[BI['clavicle' + side]];
  const upOff   = REST_L[BI['upperArm' + side]];
  const uRest   = REST_L[BI['forearm' + side]];
  const fRest   = REST_L[BI['hand' + side]];
  const lenU = vlen(uRest), lenF = vlen(fRest);
  const qClav = qEulerYXZ(0, s * -0.06, 0);
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
function makeReadyArms(pose, sway = 0, bob = 0) {
  const out = {};
  let tgtL, tgtR, poleL, poleR;
  if (pose === 'sprint') {
    // Tactical high-port / across-chest rifle carry
    tgtR  = [ 0.04 + sway * 0.015, 0.06 + bob * 0.025, -0.26];
    tgtL  = [-0.14 + sway * 0.020, 0.14 - bob * 0.020, -0.34];
    poleL = [-0.85, -0.50, 0.20];
    poleR = [ 0.85, -0.55, 0.25];
  } else if (pose === 'prone') {
    // Elbows braced forward on ground, hands holding rifle ahead of chest
    tgtR  = [ 0.07, 0.10 + bob * 0.01, -0.34];
    tgtL  = [-0.05, 0.12 - bob * 0.01, -0.48];
    poleL = [-0.75, -0.60, -0.15];
    poleR = [ 0.75, -0.60, -0.15];
  } else {
    // Low-ready tactical rifle hold: right hand on pistol grip, left hand forward on handguard
    tgtR  = [ 0.08 + sway * 0.008, 0.02 + bob * 0.012, -0.30];
    tgtL  = [-0.03 + sway * 0.010, 0.05 + bob * 0.010, -0.48];
    poleL = [-0.70, -0.68, 0.22];
    poleR = [ 0.72, -0.65, 0.28];
  }
  const ikL = solveArmIK('L', tgtL, poleL, [-0.5, -0.8, 0.1]);
  const ikR = solveArmIK('R', tgtR, poleR, [ 0.8,  0.4, 0.2]);
  out.clavicleL = ikL.qClav; out.upperArmL = ikL.qUp; out.forearmL = ikL.qFore; out.handL = ikL.qHand;
  out.clavicleR = ikR.qClav; out.upperArmR = ikR.qUp; out.forearmR = ikR.qFore; out.handR = ikR.qHand;
  // Natural relaxed grip curl on finger groups
  out.thumbL = qEulerYXZ(0.15, -0.25, 0.2);
  out.fingersL = qEulerYXZ(0.0, 0.0, -0.35);
  out.thumbR = qEulerYXZ(0.15, 0.25, -0.2);
  out.fingersR = qEulerYXZ(0.0, 0.0, 0.35);
  return out;
}

// Generate a seamless cyclic locomotion clip with planted-foot IK
function makeLocomotionClip(name, { frames, speed, dirX, dirZ, duty, lift, crouch = 0, sprint = false }) {
  const T = frames / FPS;
  const times = Array.from({ length: frames + 1 }, (_, i) => i / FPS);
  const tracks = {}; // boneIdx -> { t?: [], r?: [] }
  const setR = (b, q) => { ((tracks[b] ||= {}).r ||= []).push(...q); };
  const setT = (b, p) => { ((tracks[b] ||= {}).t ||= []).push(...p); };

  const stanceDist = speed * T * duty;
  const frontShare = speed > 3.5 ? 0.38 : 0.44;
  const backMode = dirZ > 0.5;
  const yawBase = Math.abs(dirX) > 0.5 ? (dirX < 0 ? 0.38 : -0.38) : 0;
  const rollAmp = speed > 3.5 ? 0.78 : 0.48;
  const strikeAmp = speed > 3.5 ? 0.14 : 0.28;
  const latW = crouch ? 0.135 : (speed > 3.5 ? 0.095 : 0.108);

  for (let f = 0; f <= frames; f++) {
    const P = (f % frames) / frames; // 0..1 seamless
    const stepWave = Math.cos(4 * Math.PI * (P - duty * 0.5));
    const sideWave = Math.cos(2 * Math.PI * (P - duty * 0.5));
    const runK = clamp((speed - 1.8) / 3.2, 0, 1);

    // Hips height, sway, forward lean, counter-rotation
    let hy = REST_W[BI.hips][1] - 0.025 - crouch * 0.34 - (0.02 + 0.045 * runK);
    hy += lerp(0.015, -0.028, runK) * stepWave * (1 - crouch * 0.5);
    const sway = -lerp(0.022, 0.012, runK) * sideWave * (1 - crouch * 0.4);
    const leanX = -(0.04 + 0.10 * runK + (sprint ? 0.14 : 0) + crouch * 0.14) * (backMode ? -0.4 : 1);
    const hipYaw = yawBase - lerp(0.07, 0.12, runK) * Math.cos(2 * Math.PI * P);
    const hipRoll = -0.045 * sideWave * (1 - crouch * 0.5);
    const hipsPos = [sway, hy, 0];
    const hipsQ = qEulerYXZ(leanX, hipYaw, hipRoll);

    setT(BI.hips, hipsPos);
    setR(BI.hips, hipsQ);

    // Legs via planted-foot IK
    for (const side of ['L', 'R']) {
      const sgn = side === 'L' ? -1 : 1;
      const ph = (P + (side === 'L' ? 0 : 0.5)) % 1;
      let along, up = 0, pitch = 0, toePitch = 0;
      if (ph < duty) {
        const t = ph / duty;
        along = stanceDist * (frontShare - t);
        // Heel-to-toe foot roll
        const heel = strikeAmp * (1 - sstep(0, 0.18, t));
        const push = rollAmp * sstep(lerp(0.55, 0.42, runK), 1.0, t);
        pitch = (backMode ? -0.5 : 1) * (heel - push);
        toePitch = push * 0.85; // toes stay flat on ground while heel lifts
      } else {
        const t = (ph - duty) / (1 - duty);
        const it = 1 - t;
        const x0 = (frontShare - 1) * stanceDist, x3 = frontShare * stanceDist;
        const kick = (0.10 * runK + (sprint ? 0.08 : 0)) * (backMode ? -0.4 : 1);
        const x1 = x0 - kick, x2 = x3 + 0.10 * stanceDist;
        along = it * it * it * x0 + 3 * it * it * t * x1 + 3 * it * t * t * x2 + t * t * t * x3;
        up = 3 * it * t * (it * 1.5 + t) * lift;
        const mid = -0.22 - 0.25 * runK;
        pitch = t < 0.35 ? lerp(-rollAmp, mid, sstep(0, 0.35, t)) : lerp(mid, strikeAmp, sstep(0.35, 0.95, t));
        if (backMode) pitch *= -0.5;
        toePitch = 0;
      }
      // Foot ankle offset when rolling over heel/ball
      const rollRise = Math.max(0, -pitch) * 0.075 + Math.max(0, pitch) * 0.035;
      const footModel = [
        sgn * latW + dirX * along,
        ANKLE_H + up + rollRise,
        dirZ * along,
      ];
      const ik = solveLegIK(side, footModel, pitch, yawBase * 0.6, toePitch, hipsPos, hipsQ);
      setR(BI['thigh' + side], ik.qThigh);
      setR(BI['shin' + side], ik.qShin);
      setR(BI['foot' + side], ik.qFoot);
      setR(BI['toe' + side], ik.qToe);
    }

    // Counter-rotate spine & chest so upper body stays aimed forward (-Z)
    setR(BI.spine, qEulerYXZ(-leanX * 0.45 + crouch * 0.10, -hipYaw * 0.55, -hipRoll * 0.5));
    setR(BI.chest, qEulerYXZ(-leanX * 0.35 + stepWave * 0.02 * runK, -hipYaw * 0.45, -hipRoll * 0.4));
    setR(BI.neck,  qEulerYXZ(crouch * 0.08, 0, 0));
    setR(BI.head,  qEulerYXZ(crouch * 0.06, 0, 0));

    // Arms following weapon
    const arms = makeReadyArms(sprint ? 'sprint' : 'ready', sideWave, stepWave * runK);
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

  // 1. IDLE (subtle breathing + gentle weight shift, rifle low ready)
  clips.push(makePoseClip('idle', 72, (u) => {
    const br = Math.sin(u * Math.PI * 2);
    const sw = Math.sin(u * Math.PI * 2 + 0.7);
    const hipsPos = [sw * 0.006, REST_W[BI.hips][1] - 0.022 + br * 0.004, 0];
    const hipsQ = qEulerYXZ(-0.02, -0.14 + sw * 0.015, sw * 0.008);
    const ikL = solveLegIK('L', [-0.125, ANKLE_H, -0.09], 0, -0.08, 0, hipsPos, hipsQ);
    const ikR = solveLegIK('R', [ 0.135, ANKLE_H,  0.07], 0, -0.35, 0, hipsPos, hipsQ);
    const arms = makeReadyArms('ready', sw * 0.25, br * 0.35);
    return {
      hipsPos, hipsQ,
      rots: {
        spine: qEulerYXZ(0.02 + br * 0.012, 0.08, 0),
        chest: qEulerYXZ(0.01 + br * 0.018, 0.06, 0),
        neck: qEulerYXZ(-br * 0.01, 0, 0),
        head: qEulerYXZ(-br * 0.01, 0, 0),
        thighL: ikL.qThigh, shinL: ikL.qShin, footL: ikL.qFoot, toeL: ikL.qToe,
        thighR: ikR.qThigh, shinR: ikR.qShin, footR: ikR.qFoot, toeR: ikR.qToe,
        ...arms,
      },
    };
  }));

  // 2-5. WALK (1.5 m/s) 4-way
  clips.push(makeLocomotionClip('walk_fwd',   { frames: 30, speed: 1.5, dirX:  0, dirZ: -1, duty: 0.62, lift: 0.09 }));
  clips.push(makeLocomotionClip('walk_back',  { frames: 30, speed: 1.5, dirX:  0, dirZ:  1, duty: 0.62, lift: 0.08 }));
  clips.push(makeLocomotionClip('walk_left',  { frames: 30, speed: 1.5, dirX: -1, dirZ:  0, duty: 0.62, lift: 0.08 }));
  clips.push(makeLocomotionClip('walk_right', { frames: 30, speed: 1.5, dirX:  1, dirZ:  0, duty: 0.62, lift: 0.08 }));

  // 6-9. RUN (4.7 m/s fwd, 3.6 back, 4.2 strafe)
  clips.push(makeLocomotionClip('run_fwd',   { frames: 18, speed: 4.7, dirX:  0, dirZ: -1, duty: 0.34, lift: 0.24 }));
  clips.push(makeLocomotionClip('run_back',  { frames: 20, speed: 3.6, dirX:  0, dirZ:  1, duty: 0.42, lift: 0.18 }));
  clips.push(makeLocomotionClip('run_left',  { frames: 19, speed: 4.2, dirX: -1, dirZ:  0, duty: 0.38, lift: 0.20 }));
  clips.push(makeLocomotionClip('run_right', { frames: 19, speed: 4.2, dirX:  1, dirZ:  0, duty: 0.38, lift: 0.20 }));

  // 10. SPRINT (6.7 m/s)
  clips.push(makeLocomotionClip('sprint', { frames: 15, speed: 6.7, dirX: 0, dirZ: -1, duty: 0.27, lift: 0.32, sprint: true }));

  // 11. CROUCH IDLE (tactical kneeling stance)
  clips.push(makePoseClip('crouch_idle', 60, (u) => {
    const br = Math.sin(u * Math.PI * 2);
    const hipsPos = [0, 0.565 + br * 0.005, 0.02];
    const hipsQ = qEulerYXZ(-0.14, -0.22, 0);
    const ikL = solveLegIK('L', [-0.14, ANKLE_H, -0.26], 0.0, -0.10, 0, hipsPos, hipsQ);
    const ikR = solveLegIK('R', [ 0.13, 0.12,  0.46], -1.25, -0.15, 0.8, hipsPos, hipsQ);
    const arms = makeReadyArms('ready', 0, br * 0.25);
    return {
      hipsPos, hipsQ,
      rots: {
        spine: qEulerYXZ(0.08 + br * 0.01, 0.12, 0),
        chest: qEulerYXZ(0.06 + br * 0.015, 0.10, 0),
        neck: qEulerYXZ(0.04, 0, 0), head: qEulerYXZ(0.04, 0, 0),
        thighL: ikL.qThigh, shinL: ikL.qShin, footL: ikL.qFoot, toeL: ikL.qToe,
        thighR: ikR.qThigh, shinR: ikR.qShin, footR: ikR.qFoot, toeR: ikR.qToe,
        ...arms,
      },
    };
  }));

  // 12. CROUCH WALK (2.6 m/s)
  clips.push(makeLocomotionClip('crouch_walk', { frames: 24, speed: 2.6, dirX: 0, dirZ: -1, duty: 0.58, lift: 0.11, crouch: 1 }));

  // 13. PRONE IDLE
  clips.push(makePoseClip('prone_idle', 60, (u) => {
    const br = Math.sin(u * Math.PI * 2);
    const hipsPos = [0, 0.21 + br * 0.004, 0.12];
    const hipsQ = qEulerYXZ(-1.48, 0, 0);
    const arms = makeReadyArms('prone', 0, br * 0.2);
    return {
      hipsPos, hipsQ,
      rots: {
        spine: qEulerYXZ(0.28 + br * 0.015, 0, 0),
        chest: qEulerYXZ(0.24 + br * 0.015, 0, 0),
        neck: qEulerYXZ(0.45, 0, 0), head: qEulerYXZ(0.45, 0, 0),
        thighL: qEulerYXZ(0.05, 0, -0.14), shinL: qEulerYXZ(-0.12, 0, 0), footL: qEulerYXZ(0.75, 0, 0), toeL: qEulerYXZ(0, 0, 0),
        thighR: qEulerYXZ(0.05, 0,  0.14), shinR: qEulerYXZ(-0.12, 0, 0), footR: qEulerYXZ(0.75, 0, 0), toeR: qEulerYXZ(0, 0, 0),
        ...arms,
      },
    };
  }));

  // 14. PRONE CRAWL (1.0 m/s)
  clips.push(makePoseClip('prone_crawl', 33, (u) => {
    const s = Math.sin(u * Math.PI * 2), c = Math.cos(u * Math.PI * 2);
    const hipsPos = [s * 0.035, 0.22, 0.12];
    const hipsQ = qEulerYXZ(-1.46, s * 0.14, c * 0.06);
    const arms = makeReadyArms('prone', s * 0.6, c * 0.5);
    return {
      hipsPos, hipsQ,
      rots: {
        spine: qEulerYXZ(0.26, -s * 0.10, 0),
        chest: qEulerYXZ(0.22, -s * 0.08, 0),
        neck: qEulerYXZ(0.45, 0, 0), head: qEulerYXZ(0.45, 0, 0),
        thighL: qEulerYXZ(0.15 + s * 0.32, 0, -0.18), shinL: qEulerYXZ(-0.18 - Math.max(0, c) * 0.55, 0, 0), footL: qEulerYXZ(0.7, 0, 0), toeL: qEulerYXZ(0, 0, 0),
        thighR: qEulerYXZ(0.15 - s * 0.32, 0,  0.18), shinR: qEulerYXZ(-0.18 - Math.max(0, -c) * 0.55, 0, 0), footR: qEulerYXZ(0.7, 0, 0), toeR: qEulerYXZ(0, 0, 0),
        ...arms,
      },
    };
  }));

  // 15. JUMP START
  clips.push(makePoseClip('jump_start', 10, (u) => {
    const k = smooth(u);
    const dip = Math.sin(u * Math.PI) * 0.10;
    const hipsPos = [0, 0.92 - dip + k * 0.08, 0];
    const hipsQ = qEulerYXZ(-0.14 * (1 - k) - 0.05 * k, 0, 0);
    const arms = makeReadyArms('ready', 0, k * 0.4);
    return {
      hipsPos, hipsQ,
      rots: {
        spine: qEulerYXZ(0.08, 0, 0), chest: qEulerYXZ(0.05, 0, 0), neck: qEulerYXZ(0, 0, 0), head: qEulerYXZ(0, 0, 0),
        thighL: qEulerYXZ(lerp(0.25, 0.62, k), 0, -0.05), shinL: qEulerYXZ(lerp(-0.45, -0.95, k), 0, 0), footL: qEulerYXZ(-0.25 * k, 0, 0), toeL: qEulerYXZ(0, 0, 0),
        thighR: qEulerYXZ(lerp(0.20, 0.15, k), 0,  0.05), shinR: qEulerYXZ(lerp(-0.35, -0.55, k), 0, 0), footR: qEulerYXZ(-0.35 * k, 0, 0), toeR: qEulerYXZ(0, 0, 0),
        ...arms,
      },
    };
  }));

  // 16. FALL LOOP
  clips.push(makePoseClip('fall_loop', 18, (u) => {
    const w = Math.sin(u * Math.PI * 2);
    const hipsPos = [0, 0.95 + w * 0.015, 0];
    const hipsQ = qEulerYXZ(-0.08 + w * 0.03, 0, 0);
    const arms = makeReadyArms('ready', w * 0.2, w * 0.25);
    return {
      hipsPos, hipsQ,
      rots: {
        spine: qEulerYXZ(0.06, 0, 0), chest: qEulerYXZ(0.04, 0, 0), neck: qEulerYXZ(0, 0, 0), head: qEulerYXZ(0, 0, 0),
        thighL: qEulerYXZ(0.58 + w * 0.08, 0, -0.06), shinL: qEulerYXZ(-0.92 - w * 0.08, 0, 0), footL: qEulerYXZ(-0.22, 0, 0), toeL: qEulerYXZ(0, 0, 0),
        thighR: qEulerYXZ(0.18 - w * 0.08, 0,  0.06), shinR: qEulerYXZ(-0.58 + w * 0.08, 0, 0), footR: qEulerYXZ(-0.28, 0, 0), toeR: qEulerYXZ(0, 0, 0),
        ...arms,
      },
    };
  }));

  // 17. LAND
  clips.push(makePoseClip('land', 10, (u) => {
    const dip = Math.sin(u * Math.PI);
    const hipsPos = [0, 0.93 - dip * 0.24, 0];
    const hipsQ = qEulerYXZ(-0.05 - dip * 0.22, 0, 0);
    const ikL = solveLegIK('L', [-0.13, ANKLE_H, -0.06], 0, 0, 0, hipsPos, hipsQ);
    const ikR = solveLegIK('R', [ 0.13, ANKLE_H,  0.06], 0, 0, 0, hipsPos, hipsQ);
    const arms = makeReadyArms('ready', 0, -dip * 0.5);
    return {
      hipsPos, hipsQ,
      rots: {
        spine: qEulerYXZ(dip * 0.12, 0, 0), chest: qEulerYXZ(dip * 0.08, 0, 0), neck: qEulerYXZ(0, 0, 0), head: qEulerYXZ(0, 0, 0),
        thighL: ikL.qThigh, shinL: ikL.qShin, footL: ikL.qFoot, toeL: ikL.qToe,
        thighR: ikR.qThigh, shinR: ikR.qShin, footR: ikR.qFoot, toeR: ikR.qToe,
        ...arms,
      },
    };
  }));

  // 18. DEATH FORWARD (pitched forward face down)
  clips.push(makePoseClip('death_fwd', 24, (u) => {
    const k = smooth(u);
    const hipsPos = [0, lerp(0.93, 0.16, k * k), lerp(0, -0.35, k)];
    const hipsQ = qEulerYXZ(lerp(0, -1.52, k), lerp(0, 0.12, k), lerp(0, 0.08, k));
    return {
      hipsPos, hipsQ,
      rots: {
        spine: qEulerYXZ(lerp(0, 0.08, k), 0, 0), chest: qEulerYXZ(lerp(0, 0.05, k), 0, 0),
        neck: qEulerYXZ(lerp(0, -0.15, k), 0, 0), head: qEulerYXZ(lerp(0, -0.15, k), lerp(0, 0.45, k), 0),
        clavicleL: qEulerYXZ(0, 0, 0), upperArmL: qEulerYXZ(lerp(0.5, 0.9, k), 0, lerp(0.5, -0.25, k)), forearmL: qEulerYXZ(0.2, 0.4, 0), handL: qEulerYXZ(0, 0, 0), thumbL: qEulerYXZ(0, 0, 0), fingersL: qEulerYXZ(0, 0, 0),
        clavicleR: qEulerYXZ(0, 0, 0), upperArmR: qEulerYXZ(lerp(0.5, 0.7, k), 0, lerp(-0.5, 0.35, k)), forearmR: qEulerYXZ(0.2, -0.5, 0), handR: qEulerYXZ(0, 0, 0), thumbR: qEulerYXZ(0, 0, 0), fingersR: qEulerYXZ(0, 0, 0),
        thighL: qEulerYXZ(lerp(0.1, 0.25, k), 0, -0.12 * k), shinL: qEulerYXZ(lerp(-0.1, -0.45, k), 0, 0), footL: qEulerYXZ(0.4 * k, 0, 0), toeL: qEulerYXZ(0, 0, 0),
        thighR: qEulerYXZ(lerp(0.05, 0.08, k), 0,  0.15 * k), shinR: qEulerYXZ(lerp(-0.1, -0.18, k), 0, 0), footR: qEulerYXZ(0.4 * k, 0, 0), toeR: qEulerYXZ(0, 0, 0),
      },
    };
  }));

  // 19. DEATH BACK (falls backward onto back)
  clips.push(makePoseClip('death_back', 24, (u) => {
    const k = smooth(u);
    const hipsPos = [0, lerp(0.93, 0.17, k * k), lerp(0, 0.35, k)];
    const hipsQ = qEulerYXZ(lerp(0, 1.52, k), lerp(0, -0.14, k), lerp(0, -0.08, k));
    return {
      hipsPos, hipsQ,
      rots: {
        spine: qEulerYXZ(lerp(0, -0.05, k), 0, 0), chest: qEulerYXZ(lerp(0, -0.05, k), 0, 0),
        neck: qEulerYXZ(lerp(0, 0.12, k), 0, 0), head: qEulerYXZ(lerp(0, 0.15, k), lerp(0, -0.35, k), 0),
        clavicleL: qEulerYXZ(0, 0, 0), upperArmL: qEulerYXZ(lerp(0.4, -0.2, k), 0, lerp(0.5, -0.15, k)), forearmL: qEulerYXZ(0.1, 0.35, 0), handL: qEulerYXZ(0, 0, 0), thumbL: qEulerYXZ(0, 0, 0), fingersL: qEulerYXZ(0, 0, 0),
        clavicleR: qEulerYXZ(0, 0, 0), upperArmR: qEulerYXZ(lerp(0.4, -0.15, k), 0, lerp(-0.5, 0.20, k)), forearmR: qEulerYXZ(0.1, -0.4, 0), handR: qEulerYXZ(0, 0, 0), thumbR: qEulerYXZ(0, 0, 0), fingersR: qEulerYXZ(0, 0, 0),
        thighL: qEulerYXZ(lerp(0.1, 0.22, k), 0, -0.14 * k), shinL: qEulerYXZ(lerp(-0.1, -0.40, k), 0, 0), footL: qEulerYXZ(-0.2 * k, 0, 0), toeL: qEulerYXZ(0, 0, 0),
        thighR: qEulerYXZ(lerp(0.05, -0.06, k), 0,  0.14 * k), shinR: qEulerYXZ(lerp(-0.1, -0.14, k), 0, 0), footR: qEulerYXZ(-0.2 * k, 0, 0), toeR: qEulerYXZ(0, 0, 0),
      },
    };
  }));

  // 20. RELOAD (2.0 s)
  clips.push(makePoseClip('reload', 60, (u) => {
    const dip = Math.sin(u * Math.PI);
    const hipsPos = [0, REST_W[BI.hips][1] - 0.025, 0];
    const hipsQ = qEulerYXZ(-0.03, -0.12, 0);
    const ikL = solveLegIK('L', [-0.125, ANKLE_H, -0.08], 0, -0.08, 0, hipsPos, hipsQ);
    const ikR = solveLegIK('R', [ 0.135, ANKLE_H,  0.07], 0, -0.32, 0, hipsPos, hipsQ);
    const arms = makeReadyArms('ready', 0, 0);
    // Support arm reaches down to mag pouch at u=0.45, back up at u=0.75
    const reach = Math.sin(clamp((u - 0.18) / 0.62, 0, 1) * Math.PI);
    arms.upperArmL = qEulerYXZ(lerp(0.62, 0.25, reach), lerp(0.42, 0.20, reach), lerp(0.58, 0.72, reach));
    arms.forearmL  = qEulerYXZ(0.18, lerp(0.92, 0.45, reach), 0.15);
    return {
      hipsPos, hipsQ,
      rots: {
        spine: qEulerYXZ(0.02 + dip * 0.05, 0.06, -dip * 0.05),
        chest: qEulerYXZ(0.02 + dip * 0.06, 0.06, -dip * 0.06),
        neck: qEulerYXZ(-dip * 0.06, 0, 0), head: qEulerYXZ(-dip * 0.08, 0, 0),
        thighL: ikL.qThigh, shinL: ikL.qShin, footL: ikL.qFoot, toeL: ikL.qToe,
        thighR: ikR.qThigh, shinR: ikR.qShin, footR: ikR.qFoot, toeR: ikR.qToe,
        ...arms,
      },
    };
  }));

  // 21. MELEE STRIKE (0.5 s)
  clips.push(makePoseClip('melee', 15, (u) => {
    const wind = smooth(clamp(u / 0.28, 0, 1));
    const slash = smooth(clamp((u - 0.28) / 0.34, 0, 1));
    const rec = smooth(clamp((u - 0.62) / 0.38, 0, 1));
    const twist = lerp(lerp(0, -0.45, wind), lerp(0.55, 0, rec), slash);
    const hipsPos = [0, REST_W[BI.hips][1] - 0.03, 0];
    const hipsQ = qEulerYXZ(-0.06, twist * 0.35, 0);
    const ikL = solveLegIK('L', [-0.13, ANKLE_H, -0.10], 0, -0.1, 0, hipsPos, hipsQ);
    const ikR = solveLegIK('R', [ 0.14, ANKLE_H,  0.09], 0, -0.3, 0, hipsPos, hipsQ);
    const arms = makeReadyArms('ready', 0, 0);
    const axR = lerp(lerp(0.5, 1.85, wind), lerp(0.55, 0.5, rec), slash);
    const azR = lerp(lerp(-0.72, -0.15, wind), lerp(-1.15, -0.72, rec), slash);
    arms.upperArmR = qEulerYXZ(axR, -0.25 + twist * 0.5, azR);
    arms.forearmR  = qEulerYXZ(0.2, lerp(-1.1, -0.35, slash) * (1 - rec) - 1.08 * rec, -0.15);
    return {
      hipsPos, hipsQ,
      rots: {
        spine: qEulerYXZ(0.05, twist * 0.45, 0), chest: qEulerYXZ(0.04, twist * 0.55, 0),
        neck: qEulerYXZ(0, -twist * 0.4, 0), head: qEulerYXZ(0, -twist * 0.4, 0),
        thighL: ikL.qThigh, shinL: ikL.qShin, footL: ikL.qFoot, toeL: ikL.qToe,
        thighR: ikR.qThigh, shinR: ikR.qShin, footR: ikR.qFoot, toeR: ikR.qToe,
        ...arms,
      },
    };
  }));

  // 22. GRENADE THROW (0.67 s)
  clips.push(makePoseClip('grenade', 20, (u) => {
    const cock = smooth(clamp(u / 0.38, 0, 1));
    const thr  = smooth(clamp((u - 0.38) / 0.30, 0, 1));
    const rec  = smooth(clamp((u - 0.68) / 0.32, 0, 1));
    const twist = lerp(lerp(0, -0.52, cock), lerp(0.42, 0, rec), thr);
    const hipsPos = [0, REST_W[BI.hips][1] - 0.03, 0];
    const hipsQ = qEulerYXZ(-0.05, twist * 0.3, 0);
    const ikL = solveLegIK('L', [-0.13, ANKLE_H, -0.12], 0, -0.1, 0, hipsPos, hipsQ);
    const ikR = solveLegIK('R', [ 0.14, ANKLE_H,  0.10], 0, -0.35, 0, hipsPos, hipsQ);
    const arms = makeReadyArms('ready', 0, 0);
    const pitchR = lerp(lerp(0.5, 2.35, cock), lerp(0.35, 0.5, rec), thr);
    arms.upperArmR = qEulerYXZ(pitchR, -0.2, lerp(-0.72, -0.3, cock * (1 - thr)));
    arms.forearmR  = qEulerYXZ(0.15, lerp(-1.08, -0.25, thr) * (1 - rec) - 1.08 * rec, -0.1);
    return {
      hipsPos, hipsQ,
      rots: {
        spine: qEulerYXZ(0.05, twist * 0.45, 0), chest: qEulerYXZ(0.05, twist * 0.55, 0),
        neck: qEulerYXZ(0, -twist * 0.4, 0), head: qEulerYXZ(0, -twist * 0.4, 0),
        thighL: ikL.qThigh, shinL: ikL.qShin, footL: ikL.qFoot, toeL: ikL.qToe,
        thighR: ikR.qThigh, shinR: ikR.qShin, footR: ikR.qFoot, toeR: ikR.qToe,
        ...arms,
      },
    };
  }));

  // 23. HIT FLINCH (0.30 s)
  clips.push(makePoseClip('hit_flinch', 9, (u) => {
    const k = Math.sin(u * Math.PI);
    const hipsPos = [0, REST_W[BI.hips][1] - 0.025, k * 0.03];
    const hipsQ = qEulerYXZ(k * 0.08, -0.12, k * 0.05);
    const ikL = solveLegIK('L', [-0.125, ANKLE_H, -0.08], 0, -0.08, 0, hipsPos, hipsQ);
    const ikR = solveLegIK('R', [ 0.135, ANKLE_H,  0.07], 0, -0.32, 0, hipsPos, hipsQ);
    const arms = makeReadyArms('ready', k * 0.3, k * 0.3);
    return {
      hipsPos, hipsQ,
      rots: {
        spine: qEulerYXZ(k * 0.16, 0.08, k * 0.14),
        chest: qEulerYXZ(k * 0.22, 0.06 + k * 0.16, k * 0.18),
        neck: qEulerYXZ(k * 0.20, 0, -k * 0.12), head: qEulerYXZ(k * 0.22, 0, -k * 0.15),
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
