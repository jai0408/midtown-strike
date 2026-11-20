#!/usr/bin/env node
// Software PBR preview renderer for src/chars/soldier2_asset.js (reads the real GLB mesh,
// 2048 WebP PBR maps, 25-bone skeleton, and animation clips directly).
// Outputs docs/soldier2_front.jpg, soldier2_side.jpg, soldier2_back.jpg,
// soldier2_run_1..6.jpg, soldier2_fp.jpg, and docs/soldier2_sheet.jpg.
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { SOLDIER2_GLB } from '../src/chars/soldier2_asset.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DOCS = resolve(ROOT, 'docs');
const TMP = '/tmp/soldier2_render';
mkdirSync(TMP, { recursive: true });
mkdirSync(DOCS, { recursive: true });

// ---- Parse GLB ----
const raw = Buffer.from(SOLDIER2_GLB, 'base64');
const jl = raw.readUInt32LE(12);
const gltf = JSON.parse(raw.toString('utf8', 20, 20 + jl));
const bo = 20 + jl;
const bl = raw.readUInt32LE(bo);
const bin = raw.subarray(bo + 8, bo + 8 + bl);

function readAcc(idx) {
  const acc = gltf.accessors[idx];
  const bv = gltf.bufferViews[acc.bufferView];
  const off = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[acc.type];
  const n = acc.count * comps;
  const slice = bin.buffer.slice(bin.byteOffset + off, bin.byteOffset + off + bv.byteLength);
  if (acc.componentType === 5126) return new Float32Array(slice, 0, n);
  if (acc.componentType === 5123) return new Uint16Array(slice, 0, n);
  if (acc.componentType === 5121) return new Uint8Array(slice, 0, n);
  throw new Error('unsupported comp ' + acc.componentType);
}

// Decode WebP images via dwebp -> PPM (P6 binary RGB)
function decodeWebpImage(imgIdx) {
  const im = gltf.images[imgIdx];
  const bv = gltf.bufferViews[im.bufferView];
  const data = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
  const wp = `${TMP}/img_${imgIdx}.webp`;
  const pp = `${TMP}/img_${imgIdx}.ppm`;
  writeFileSync(wp, data);
  execFileSync('/opt/homebrew/bin/dwebp', [wp, '-ppm', '-o', pp], { stdio: 'ignore' });
  const buf = readFileSync(pp);
  // Parse P6 header: "P6\n<w> <h>\n255\n"
  let i = 0, tokens = [];
  while (tokens.length < 4 && i < buf.length) {
    while (i < buf.length && (buf[i] <= 32)) i++;
    if (buf[i] === 35) { while (i < buf.length && buf[i] !== 10) i++; continue; }
    let s = i;
    while (i < buf.length && buf[i] > 32) i++;
    tokens.push(buf.toString('ascii', s, i));
  }
  i++; // single whitespace after maxval
  return { w: Number(tokens[1]), h: Number(tokens[2]), data: buf.subarray(i) };
}

const texCol = decodeWebpImage(0);
const texNrm = decodeWebpImage(1);
const texOrm = decodeWebpImage(2);

// Extract LOD0 mesh
const prim = gltf.meshes[0].primitives[0];
const basePos = readAcc(prim.attributes.POSITION);
const baseNor = readAcc(prim.attributes.NORMAL);
const baseUv  = readAcc(prim.attributes.TEXCOORD_0);
const baseJnt = readAcc(prim.attributes.JOINTS_0);
const baseWgt = readAcc(prim.attributes.WEIGHTS_0);
const indices = readAcc(prim.indices);
const nVerts  = basePos.length / 3;
const nTris   = indices.length / 3;

const skin = gltf.skins[0];
const joints = skin.joints;
const nBones = joints.length;
const ibmAll = readAcc(skin.inverseBindMatrices);
const nodeToBone = new Map(joints.map((ni, bi) => [ni, bi]));
const parentBone = new Int32Array(nBones).fill(-1);
joints.forEach((ni, bi) => {
  for (const ch of gltf.nodes[ni].children || []) {
    if (nodeToBone.has(ch)) parentBone[nodeToBone.get(ch)] = bi;
  }
});

// Matrix4 helpers (column-major Float32Array)
function mat4FromTRS(t, q) {
  const m = new Float32Array(16);
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  m[0] = 1 - (yy + zz); m[1] = xy + wz; m[2] = xz - wy; m[3] = 0;
  m[4] = xy - wz; m[5] = 1 - (xx + zz); m[6] = yz + wx; m[7] = 0;
  m[8] = xz + wy; m[9] = yz - wx; m[10] = 1 - (xx + yy); m[11] = 0;
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
  return m;
}
function mat4Mul(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

// Evaluate animation clip at normalized time u in [0, 1]
function evalPose(clipName, u, hideHead = false) {
  const locT = joints.map((ni) => (gltf.nodes[ni].translation || [0, 0, 0]).slice());
  const locQ = joints.map(() => [0, 0, 0, 1]);
  const anim = clipName ? gltf.animations.find((a) => a.name === clipName) : null;
  if (anim) {
    for (const ch of anim.channels) {
      const bi = nodeToBone.get(ch.target.node);
      if (bi === undefined) continue;
      const samp = anim.samplers[ch.sampler];
      const times = readAcc(samp.input);
      const vals = readAcc(samp.output);
      const tMax = times[times.length - 1] || 1;
      const t = u * tMax;
      let k = 0;
      while (k < times.length - 2 && times[k + 1] < t) k++;
      const f = times[k + 1] > times[k] ? (t - times[k]) / (times[k + 1] - times[k]) : 0;
      if (ch.target.path === 'translation') {
        for (let c = 0; c < 3; c++) locT[bi][c] = vals[k * 3 + c] * (1 - f) + vals[(k + 1) * 3 + c] * f;
      } else if (ch.target.path === 'rotation') {
        let ax = vals[k * 4], ay = vals[k * 4 + 1], az = vals[k * 4 + 2], aw = vals[k * 4 + 3];
        let bx = vals[(k + 1) * 4], by = vals[(k + 1) * 4 + 1], bz = vals[(k + 1) * 4 + 2], bw = vals[(k + 1) * 4 + 3];
        if (ax * bx + ay * by + az * bz + aw * bw < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
        let rx = ax * (1 - f) + bx * f, ry = ay * (1 - f) + by * f, rz = az * (1 - f) + bz * f, rw = aw * (1 - f) + bw * f;
        const l = Math.hypot(rx, ry, rz, rw) || 1;
        locQ[bi] = [rx / l, ry / l, rz / l, rw / l];
      }
    }
  }
  const worldM = new Array(nBones);
  const skinM = new Array(nBones);
  for (let i = 0; i < nBones; i++) {
    const lm = mat4FromTRS(locT[i], locQ[i]);
    if (hideHead && gltf.nodes[joints[i]].name === 'head') {
      lm[0] *= 0.001; lm[5] *= 0.001; lm[10] *= 0.001;
    }
    worldM[i] = parentBone[i] < 0 ? lm : mat4Mul(worldM[parentBone[i]], lm);
    skinM[i] = mat4Mul(worldM[i], ibmAll.subarray(i * 16, i * 16 + 16));
  }
  const outPos = new Float32Array(nVerts * 3);
  const outNor = new Float32Array(nVerts * 3);
  for (let i = 0; i < nVerts; i++) {
    const px = basePos[i * 3], py = basePos[i * 3 + 1], pz = basePos[i * 3 + 2];
    const nx = baseNor[i * 3], ny = baseNor[i * 3 + 1], nz = baseNor[i * 3 + 2];
    let sx = 0, sy = 0, sz = 0, snx = 0, sny = 0, snz = 0;
    for (let k = 0; k < 4; k++) {
      const w = baseWgt[i * 4 + k];
      if (w <= 0) continue;
      const m = skinM[baseJnt[i * 4 + k]];
      sx += w * (m[0] * px + m[4] * py + m[8] * pz + m[12]);
      sy += w * (m[1] * px + m[5] * py + m[9] * pz + m[13]);
      sz += w * (m[2] * px + m[6] * py + m[10] * pz + m[14]);
      snx += w * (m[0] * nx + m[4] * ny + m[8] * nz);
      sny += w * (m[1] * nx + m[5] * ny + m[9] * nz);
      snz += w * (m[2] * nx + m[6] * ny + m[10] * nz);
    }
    const l = Math.hypot(snx, sny, snz) || 1;
    outPos[i * 3] = sx; outPos[i * 3 + 1] = sy; outPos[i * 3 + 2] = sz;
    outNor[i * 3] = snx / l; outNor[i * 3 + 1] = sny / l; outNor[i * 3 + 2] = snz / l;
  }
  return { pos: outPos, nor: outNor };
}

function encodePNG(width, height, rgb) {
  const stride = width * 3 + 1;
  const rawBuf = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    rawBuf[y * stride] = 0;
    rgb.copy(rawBuf, y * stride + 1, y * width * 3, (y + 1) * width * 3);
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
  ihdr[8] = 8; ihdr[9] = 2;
  const idat = deflateSync(rawBuf, { level: 6 });
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// Software PBR rasterizer
function renderView({ W, H, camPos, target, fovDeg, meshes }) {
  const rgb = Buffer.alloc(W * H * 3);
  const zbuf = new Float32Array(W * H).fill(1e9);

  // Camera basis
  const fwd = [target[0] - camPos[0], target[1] - camPos[1], target[2] - camPos[2]];
  const fl = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1;
  fwd[0] /= fl; fwd[1] /= fl; fwd[2] /= fl;
  let rx = fwd[1] * 0 - fwd[2] * 1, ry = fwd[2] * 0 - fwd[0] * 0, rz = fwd[0] * 1 - fwd[1] * 0;
  // right = cross(fwd, up(0,1,0))
  rx = -fwd[2]; ry = 0; rz = fwd[0];
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; rz /= rl;
  const ux = ry * fwd[2] - rz * fwd[1], uy = rz * fwd[0] - rx * fwd[2], uz = rx * fwd[1] - ry * fwd[0];

  const fScale = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const aspect = W / H;

  // Background gradient + studio floor plane (y=0) with soft contact shadow
  for (let y = 0; y < H; y++) {
    const ndcY = 1 - (2 * (y + 0.5)) / H;
    for (let x = 0; x < W; x++) {
      const ndcX = (2 * (x + 0.5)) / W - 1;
      const dx = fwd[0] + rx * (ndcX * aspect / fScale) + ux * (ndcY / fScale);
      const dy = fwd[1] + ry * (ndcX * aspect / fScale) + uy * (ndcY / fScale);
      const dz = fwd[2] + rz * (ndcX * aspect / fScale) + uz * (ndcY / fScale);
      let r = 38 + 26 * (1 - y / H), g = 44 + 30 * (1 - y / H), b = 54 + 34 * (1 - y / H);
      if (dy < -1e-4) {
        const t = -camPos[1] / dy;
        if (t > 0 && t < 35) {
          const fx = camPos[0] + dx * t, fz = camPos[2] + dz * t;
          const fade = Math.exp(-t * 0.08);
          const grid = ((Math.abs(fx % 0.5) < 0.015) || (Math.abs(fz % 0.5) < 0.015)) ? 0.92 : 1.0;
          let sh = 1.0;
          for (const m of meshes) {
            const d2 = (fx - m.ox) ** 2 + (fz - m.oz) ** 2;
            sh *= 1 - 0.55 * Math.exp(-d2 / 0.22);
          }
          const base = (54 * fade + 36 * (1 - fade)) * grid * sh;
          r = base * 0.96; g = base * 0.98; b = base * 1.04;
        }
      }
      const o = (y * W + x) * 3;
      rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b;
    }
  }

  // Lighting
  const sun = [0.55, 0.72, -0.42];
  const sl = Math.hypot(sun[0], sun[1], sun[2]);
  sun[0] /= sl; sun[1] /= sl; sun[2] /= sl;
  const fill = [-0.65, 0.35, 0.68];
  const fl2 = Math.hypot(fill[0], fill[1], fill[2]);
  fill[0] /= fl2; fill[1] /= fl2; fill[2] /= fl2;

  const project = (px, py, pz) => {
    const vx = px - camPos[0], vy = py - camPos[1], vz = pz - camPos[2];
    const cz = vx * fwd[0] + vy * fwd[1] + vz * fwd[2];
    if (cz <= 0.04) return null;
    const cx = vx * rx + vy * ry + vz * rz;
    const cy = vx * ux + vy * uy + vz * uz;
    const sx = ((cx * fScale) / (cz * aspect) * 0.5 + 0.5) * W;
    const sy = (0.5 - (cy * fScale) / cz * 0.5) * H;
    return [sx, sy, cz];
  };

  for (const mesh of meshes) {
    const { pos, nor, ox = 0, oz = 0, tint = 'marine' } = mesh;
    const look = tint === 'enemy' ? { sat: 0.36, mul: [0.48, 0.56, 0.82] } : { sat: 1.05, mul: [1.06, 1.04, 0.96] };
    for (let t = 0; t < nTris; t++) {
      const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
      const p0x = pos[i0 * 3] + ox, p0y = pos[i0 * 3 + 1], p0z = pos[i0 * 3 + 2] + oz;
      const p1x = pos[i1 * 3] + ox, p1y = pos[i1 * 3 + 1], p1z = pos[i1 * 3 + 2] + oz;
      const p2x = pos[i2 * 3] + ox, p2y = pos[i2 * 3 + 1], p2z = pos[i2 * 3 + 2] + oz;
      const s0 = project(p0x, p0y, p0z), s1 = project(p1x, p1y, p1z), s2 = project(p2x, p2y, p2z);
      if (!s0 || !s1 || !s2) continue;

      const area = (s1[0] - s0[0]) * (s2[1] - s0[1]) - (s1[1] - s0[1]) * (s2[0] - s0[0]);
      if (Math.abs(area) < 0.05) continue;
      const invA = 1 / area;

      const minX = Math.max(0, Math.floor(Math.min(s0[0], s1[0], s2[0])));
      const maxX = Math.min(W - 1, Math.ceil(Math.max(s0[0], s1[0], s2[0])));
      const minY = Math.max(0, Math.floor(Math.min(s0[1], s1[1], s2[1])));
      const maxY = Math.min(H - 1, Math.ceil(Math.max(s0[1], s1[1], s2[1])));

      const n0x = nor[i0 * 3], n0y = nor[i0 * 3 + 1], n0z = nor[i0 * 3 + 2];
      const n1x = nor[i1 * 3], n1y = nor[i1 * 3 + 1], n1z = nor[i1 * 3 + 2];
      const n2x = nor[i2 * 3], n2y = nor[i2 * 3 + 1], n2z = nor[i2 * 3 + 2];
      const u0 = baseUv[i0 * 2], v0 = baseUv[i0 * 2 + 1];
      const u1 = baseUv[i1 * 2], v1 = baseUv[i1 * 2 + 1];
      const u2 = baseUv[i2 * 2], v2 = baseUv[i2 * 2 + 1];

      for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
          const w0 = ((s1[0] - px) * (s2[1] - py) - (s1[1] - py) * (s2[0] - px)) * invA;
          const w1 = ((s2[0] - px) * (s0[1] - py) - (s2[1] - py) * (s0[0] - px)) * invA;
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
          const z = w0 * s0[2] + w1 * s1[2] + w2 * s2[2];
          const pi = py * W + px;
          if (z >= zbuf[pi]) continue;
          zbuf[pi] = z;

          const u = Math.max(0, Math.min(0.9999, w0 * u0 + w1 * u1 + w2 * u2));
          const v = Math.max(0, Math.min(0.9999, w0 * v0 + w1 * v1 + w2 * v2));
          const tx = (u * texCol.w) | 0, ty = (v * texCol.h) | 0;
          const to = (ty * texCol.w + tx) * 3;
          let cr = texCol.data[to] / 255, cg = texCol.data[to + 1] / 255, cb = texCol.data[to + 2] / 255;
          const lum = 0.299 * cr + 0.587 * cg + 0.114 * cb;
          cr = Math.min(1, Math.max(0, (lum + (cr - lum) * look.sat) * look.mul[0]));
          cg = Math.min(1, Math.max(0, (lum + (cg - lum) * look.sat) * look.mul[1]));
          cb = Math.min(1, Math.max(0, (lum + (cb - lum) * look.sat) * look.mul[2]));

          const ao = 0.5 + 0.5 * (texOrm.data[to] / 255);
          const rough = Math.max(0.16, texOrm.data[to + 1] / 255);
          const metal = texOrm.data[to + 2] / 255;

          // Perturb normal slightly from normal map
          const mx = (texNrm.data[to] / 255 - 0.5) * 0.45;
          const my = (texNrm.data[to + 1] / 255 - 0.5) * 0.45;
          let nx = w0 * n0x + w1 * n1x + w2 * n2x + mx;
          let ny = w0 * n0y + w1 * n1y + w2 * n2y + my;
          let nz = w0 * n0z + w1 * n1z + w2 * n2z;
          const nl = Math.hypot(nx, ny, nz) || 1;
          nx /= nl; ny /= nl; nz /= nl;

          const wx = w0 * p0x + w1 * p1x + w2 * p2x;
          const wy = w0 * p0y + w1 * p1y + w2 * p2y;
          const wz = w0 * p0z + w1 * p1z + w2 * p2z;
          let vx = camPos[0] - wx, vy = camPos[1] - wy, vz = camPos[2] - wz;
          const vl = Math.hypot(vx, vy, vz) || 1;
          vx /= vl; vy /= vl; vz /= vl;

          const ndl = Math.max(0, nx * sun[0] + ny * sun[1] + nz * sun[2]);
          const ndf = Math.max(0, nx * fill[0] + ny * fill[1] + nz * fill[2]);
          const hemi = 0.5 + 0.5 * ny;
          let hx = sun[0] + vx, hy = sun[1] + vy, hz = sun[2] + vz;
          const hl = Math.hypot(hx, hy, hz) || 1;
          hx /= hl; hy /= hl; hz /= hl;
          const specPow = 4 + (1 - rough) * 90;
          const spec = Math.pow(Math.max(0, nx * hx + ny * hy + nz * hz), specPow) * (0.25 + 0.85 * metal) * (1 - rough * 0.65);
          const rim = Math.pow(1 - Math.max(0, nx * vx + ny * vy + nz * vz), 3) * 0.16;

          const diff = (0.34 + 0.22 * hemi) * ao + ndl * 0.92 + ndf * 0.28;
          let fr = cr * (1 - metal * 0.65) * diff + spec * (0.95 + cr * metal * 0.5) + rim * 0.7;
          let fg = cg * (1 - metal * 0.65) * diff + spec * (0.92 + cg * metal * 0.5) + rim * 0.8;
          let fb = cb * (1 - metal * 0.65) * diff + spec * (0.86 + cb * metal * 0.5) + rim * 0.95;

          // Filmic gamma
          const o = pi * 3;
          rgb[o]     = Math.min(255, Math.max(0, Math.round(Math.pow(fr / (fr + 0.85) * 1.85, 0.92) * 255)));
          rgb[o + 1] = Math.min(255, Math.max(0, Math.round(Math.pow(fg / (fg + 0.85) * 1.85, 0.92) * 255)));
          rgb[o + 2] = Math.min(255, Math.max(0, Math.round(Math.pow(fb / (fb + 0.85) * 1.85, 0.92) * 255)));
        }
      }
    }
  }
  return rgb;
}

function saveJpg(name, W, H, rgb) {
  const pngPath = `${TMP}/${name}.png`;
  const jpgPath = resolve(DOCS, `${name}.jpg`);
  writeFileSync(pngPath, encodePNG(W, H, rgb));
  execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '88', pngPath, '--out', jpgPath], { stdio: 'ignore' });
  console.log('Saved', jpgPath);
  return { W, H, rgb };
}

// ---- Render required views ----
const idlePose = evalPose('idle', 0);

// Front (Marine + Hostile side by side for easy team comparison, plus solo front)
const rFront = saveJpg('soldier2_front', 640, 820, renderView({
  W: 640, H: 820, camPos: [0, 1.05, -2.95], target: [0, 0.94, 0], fovDeg: 40,
  meshes: [{ ...idlePose, ox: -0.42, oz: 0, tint: 'marine' }, { ...idlePose, ox: 0.42, oz: 0, tint: 'enemy' }],
}));
const rSide = saveJpg('soldier2_side', 540, 820, renderView({
  W: 540, H: 820, camPos: [2.75, 1.02, -0.35], target: [0, 0.94, 0], fovDeg: 40,
  meshes: [{ ...idlePose, ox: 0, oz: 0, tint: 'marine' }],
}));
const rBack = saveJpg('soldier2_back', 540, 820, renderView({
  W: 540, H: 820, camPos: [0, 1.05, 2.75], target: [0, 0.94, 0], fovDeg: 40,
  meshes: [{ ...idlePose, ox: 0, oz: 0, tint: 'marine' }],
}));

// First-person hands view (head hidden, looking forward down over arms/hands)
const fpPose = evalPose('idle', 0, true);
const rFp = saveJpg('soldier2_fp', 720, 480, renderView({
  W: 720, H: 480, camPos: [0.0, 1.56, -0.06], target: [0.02, 1.32, -0.62], fovDeg: 68,
  meshes: [{ ...fpPose, ox: 0, oz: 0, tint: 'marine' }],
}));

// 6-frame run sequence
const runFrames = [];
for (let k = 0; k < 6; k++) {
  const rp = evalPose('run_fwd', k / 6);
  runFrames.push(saveJpg(`soldier2_run_${k + 1}`, 420, 600, renderView({
    W: 420, H: 600, camPos: [2.15, 0.98, -1.65], target: [0, 0.90, 0], fovDeg: 42,
    meshes: [{ ...rp, ox: 0, oz: 0, tint: 'marine' }],
  })));
}

// Composite 6-frame run strip into one easy-to-view image docs/soldier2_run_strip.jpg
const SW = 420 * 6, SH = 600;
const strip = Buffer.alloc(SW * SH * 3);
for (let k = 0; k < 6; k++) {
  const src = runFrames[k].rgb;
  for (let y = 0; y < SH; y++) {
    src.copy(strip, (y * SW + k * 420) * 3, y * 420 * 3, (y + 1) * 420 * 3);
  }
}
saveJpg('soldier2_run_strip', SW, SH, strip);

// 6-frame crouch walk strip
const crouchStrip = Buffer.alloc(SW * SH * 3);
for (let k = 0; k < 6; k++) {
  const cp = evalPose('crouch_walk', k / 6);
  const rgb = renderView({
    W: 420, H: 600, camPos: [2.05, 0.82, -1.45], target: [0, 0.68, 0], fovDeg: 42,
    meshes: [{ ...cp, ox: 0, oz: 0, tint: 'marine' }],
  });
  for (let y = 0; y < SH; y++) rgb.copy(crouchStrip, (y * SW + k * 420) * 3, y * 420 * 3, (y + 1) * 420 * 3);
}
saveJpg('soldier2_crouch_strip', SW, SH, crouchStrip);

// 6-frame prone leopard crawl strip
const crawlStrip = Buffer.alloc(SW * SH * 3);
for (let k = 0; k < 6; k++) {
  const pp = evalPose('prone_crawl', k / 6);
  const rgb = renderView({
    W: 420, H: 600, camPos: [1.95, 1.35, -1.35], target: [0, 0.24, -0.05], fovDeg: 42,
    meshes: [{ ...pp, ox: 0, oz: 0, tint: 'marine' }],
  });
  for (let y = 0; y < SH; y++) rgb.copy(crawlStrip, (y * SW + k * 420) * 3, y * 420 * 3, (y + 1) * 420 * 3);
}
saveJpg('soldier2_crawl_strip', SW, SH, crawlStrip);
