// Every texture in the game is painted at start-up on 2D canvases, so the app
// ships no image files at all.
import * as THREE from 'three';
import { RNG } from '../core/util.js';
export { AD_PALETTES, AD_LAND, AD_PORT, adsTexture, adsAnimTexture, tickerTexture } from './ad_art.js';
export { SHOP_COLS, SHOP_ROWS, shopTexture, shopTextures, signsTexture, glowTexture, smokeTexture, flashTexture, crateTextures, containerTextures } from './shop_textures.js';

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

let maxAniso = 4;
export function setMaxAnisotropy(v) {
  maxAniso = Math.min(8, v || 1);
}
export const getMaxAnisotropy = () => maxAniso;

export function toTexture(canvas, { repeat = true, srgb = true, aniso = true, nearest = false } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (nearest) {
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestMipmapLinearFilter;
  }
  t.anisotropy = aniso ? maxAniso : 1;
  return t;
}

function speckle(ctx, w, h, rng, n, colors, maxSize = 2, alpha = 0.25) {
  for (let i = 0; i < n; i++) {
    ctx.globalAlpha = alpha * rng.next();
    ctx.fillStyle = rng.pick(colors);
    const s = 1 + rng.next() * maxSize;
    ctx.fillRect(rng.next() * w, rng.next() * h, s, s);
  }
  ctx.globalAlpha = 1;
}

// --- procedural PBR helpers -------------------------------------------------
/** Tileable fractal value noise in [0,1]. */
function fbm(w, h, seed, base = 4, oct = 4, gain = 0.5) {
  const out = new Float32Array(w * h);
  const rng = new RNG(seed);
  let amp = 1, tot = 0;
  const xi0 = new Int32Array(w), xi1 = new Int32Array(w), xt = new Float32Array(w);
  for (let o = 0; o < oct; o++) {
    const p = base << o;
    const lat = new Float32Array(p * p);
    for (let i = 0; i < lat.length; i++) lat[i] = rng.next();
    for (let x = 0; x < w; x++) {
      const fx = (x / w) * p, x0 = Math.floor(fx);
      let t = fx - x0; t = t * t * (3 - 2 * t);
      xi0[x] = x0 % p; xi1[x] = (x0 + 1) % p; xt[x] = t;
    }
    for (let y = 0; y < h; y++) {
      const fy = (y / h) * p, y0 = Math.floor(fy);
      let ty = fy - y0; ty = ty * ty * (3 - 2 * ty);
      const r0 = (y0 % p) * p, r1 = ((y0 + 1) % p) * p;
      for (let x = 0; x < w; x++) {
        const a = lat[r0 + xi0[x]], b = lat[r0 + xi1[x]], c = lat[r1 + xi0[x]], d = lat[r1 + xi1[x]];
        const t = xt[x];
        out[y * w + x] += amp * ((a + (b - a) * t) * (1 - ty) + (c + (d - c) * t) * ty);
      }
    }
    tot += amp; amp *= gain;
  }
  for (let i = 0; i < out.length; i++) out[i] /= tot;
  return out;
}

/** Height field (0..1, tileable) -> tangent-space normal map canvas. */
export function normalCanvas(hf, w, h, strength) {
  const c = makeCanvas(w, h), g = c.getContext('2d');
  const img = g.createImageData(w, h), d = img.data;
  for (let y = 0; y < h; y++) {
    const ym = ((y - 1 + h) % h) * w, yp = ((y + 1) % h) * w, y0 = y * w;
    for (let x = 0; x < w; x++) {
      const xm = (x - 1 + w) % w, xp = (x + 1) % w;
      const dx = (hf[y0 + xp] - hf[y0 + xm]) * strength;
      const dy = (hf[yp + x] - hf[ym + x]) * strength;
      let nx = -dx, ny = dy, nz = 1;
      const l = 1 / Math.hypot(nx, ny, nz);
      const i = (y0 + x) * 4;
      d[i] = (nx * l * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * l * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * l * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

const rgbRM = (r, m) => `rgb(0,${Math.round(r * 255)},${Math.round(m * 255)})`;
const gray = (v) => `rgb(${v | 0},${v | 0},${v | 0})`;

/** Run `fn(ox, oy)` at the 9 wrapped offsets so features stay tileable. */
function wrapped(W, H, fn) {
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) fn(ox * W, oy * H);
}

/**
 * Combine painted albedo / height / rough-metal canvases with per-pixel
 * aggregate noise, then derive the normal map. Returns textures.
 */
function finishSurface(A, Hc, O, W, Hh, { grain = 0.3, grainH = 0.25, blotch = 0.15, nStrength = 3, seed = 5, blotchBase = 3 }) {
  const ga = A.getContext('2d'), gh = Hc.getContext('2d'), go = O.getContext('2d');
  const ia = ga.getImageData(0, 0, W, Hh), ih = gh.getImageData(0, 0, W, Hh), io = go.getImageData(0, 0, W, Hh);
  const blot = fbm(W, Hh, seed + 1, blotchBase, 5, 0.55);
  const rng = new RNG(seed);
  const hf = new Float32Array(W * Hh);
  const da = ia.data, dh = ih.data, dor = io.data;
  for (let i = 0; i < W * Hh; i++) {
    const n = rng.next();
    const k = (1 + (n - 0.5) * grain) * (1 + (blot[i] - 0.5) * blotch * 2);
    da[i * 4] = Math.min(255, da[i * 4] * k);
    da[i * 4 + 1] = Math.min(255, da[i * 4 + 1] * k);
    da[i * 4 + 2] = Math.min(255, da[i * 4 + 2] * k);
    hf[i] = dh[i * 4] / 255 + (n - 0.5) * grainH * 0.08 + (blot[i] - 0.5) * 0.02;
    dor[i * 4 + 1] = Math.min(255, Math.max(8, dor[i * 4 + 1] + (n - 0.5) * 30 - (blot[i] - 0.5) * 20));
  }
  ga.putImageData(ia, 0, 0);
  go.putImageData(io, 0, 0);
  return { map: toTexture(A), normalMap: toTexture(normalCanvas(hf, W, Hh, nStrength), { srgb: false }), orm: toTexture(O, { srgb: false }) };
}

// ---------------------------------------------------------------------------
// Ground
// ---------------------------------------------------------------------------
/** Road surface: 7 m tile. Returns { map, normalMap, orm }. */
export function asphaltTexture() {
  const rng = new RNG(11);
  const S = 512;
  const mk = () => { const c = makeCanvas(S, S); return [c, c.getContext('2d')]; };
  const [A, ga] = mk(), [Hc, gh] = mk(), [O, go] = mk();
  ga.fillStyle = '#2c2e33'; ga.fillRect(0, 0, S, S);
  gh.fillStyle = gray(128); gh.fillRect(0, 0, S, S);
  go.fillStyle = rgbRM(0.92, 0); go.fillRect(0, 0, S, S);
  // Subtle micro-cracks (fine low-contrast hairline fissures; macro cracks & patches are world-space)
  const lines = [];
  for (let i = 0; i < 10; i++) {
    const pts = [[rng.next() * S, rng.next() * S]];
    const n = 4 + (rng.next() * 6 | 0), ang = rng.next() * 6.28;
    for (let k = 0; k < n; k++) {
      const p = pts[k]; const a = ang + rng.range(-0.75, 0.75);
      pts.push([p[0] + Math.cos(a) * rng.range(8, 22), p[1] + Math.sin(a) * rng.range(8, 22)]);
    }
    lines.push(pts);
  }
  for (const pts of lines) {
    wrapped(S, S, (ox, oy) => {
      ga.lineJoin = gh.lineJoin = go.lineJoin = 'round';
      for (const [g, col, lw, al] of [
        [ga, '#17181b', 0.95, 0.48],
        [gh, gray(104), 1.15, 0.55],
        [go, rgbRM(0.95, 0), 1.0, 0.85],
      ]) {
        g.globalAlpha = al; g.strokeStyle = col; g.lineWidth = lw; g.beginPath();
        pts.forEach((p, k) => (k ? g.lineTo(p[0] + ox, p[1] + oy) : g.moveTo(p[0] + ox, p[1] + oy)));
        g.stroke();
      }
    });
  }
  ga.globalAlpha = gh.globalAlpha = go.globalAlpha = 1;
  // Dense multi-scale basalt/quartz aggregate stones
  for (let i = 0; i < 3600; i++) {
    const x = rng.next() * S, y = rng.next() * S, r = 0.65 + rng.next() * 1.45;
    const v = rng.chance(0.44) ? 'rgba(130,134,142,0.42)' : 'rgba(10,11,13,0.48)';
    ga.fillStyle = v; ga.beginPath(); ga.arc(x, y, r, 0, 7); ga.fill();
    gh.fillStyle = rng.chance(0.5) ? gray(168) : gray(90); gh.globalAlpha = 0.66; gh.beginPath(); gh.arc(x, y, r, 0, 7); gh.fill(); gh.globalAlpha = 1;
  }
  return finishSurface(A, Hc, O, S, S, { grain: 1.08, grainH: 1.85, blotch: 0.14, nStrength: 4.4, seed: 21 });
}

/** Sidewalk: 3.2 m tile holding 2 x 2 poured slabs (1.6 m). Returns { map, normalMap, orm }. */
export function pavingTexture() {
  const rng = new RNG(12);
  const S = 512, SL = S / 2, J = 0.1 * S;       // joints offset so kerb UV corner stays plain concrete
  const mk = () => { const c = makeCanvas(S, S); return [c, c.getContext('2d')]; };
  const [A, ga] = mk(), [Hc, gh] = mk(), [O, go] = mk();
  ga.fillStyle = '#aaa79f'; ga.fillRect(0, 0, S, S);
  gh.fillStyle = gray(128); gh.fillRect(0, 0, S, S);
  go.fillStyle = rgbRM(0.86, 0); go.fillRect(0, 0, S, S);
  // slab tone variation
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    const x = J + i * SL, y = J + j * SL, a = rng.range(0.04, 0.16), light = rng.chance(0.5);
    wrapped(S, S, (ox, oy) => {
      ga.globalAlpha = a; ga.fillStyle = light ? '#e8e2d4' : '#4a463e'; ga.fillRect(x + ox, y + oy, SL, SL);
      go.globalAlpha = 1; go.fillStyle = rgbRM(0.8 + rng.next() * 0.0 + (light ? 0.04 : 0.08), 0);
    });
  }
  ga.globalAlpha = 1;
  // slab-surface stains and soiling
  for (let i = 0; i < 22; i++) {
    const x = rng.next() * S, y = rng.next() * S, r = 10 + rng.next() * 50, a = 0.05 + rng.next() * 0.12;
    const dark = rng.chance(0.8);
    wrapped(S, S, (ox, oy) => {
      const gr = ga.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      gr.addColorStop(0, dark ? `rgba(40,36,30,${a})` : `rgba(240,235,220,${a})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
      ga.fillStyle = gr; ga.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    });
  }
  // joints: dark groove, lighter tooled edge, soil collected along them
  for (let k = 0; k < 2; k++) {
    const p = J + k * SL;
    for (const horiz of [true, false]) {
      const R = (g, col, off, th, al) => { g.globalAlpha = al; g.fillStyle = col; horiz ? g.fillRect(0, p + off, S, th) : g.fillRect(p + off, 0, th, S); };
      R(ga, '#58554e', -5, 10, 0.25); R(ga, '#2a2824', -1.5, 3, 0.9); R(ga, '#d3cfc4', 2, 3, 0.35);
      R(gh, gray(40), -1.5, 3, 1); R(gh, gray(150), -4, 2.5, 0.8); R(gh, gray(145), 2, 2.5, 0.8);
      R(go, rgbRM(0.97, 0), -3, 6, 1);
    }
  }
  ga.globalAlpha = gh.globalAlpha = go.globalAlpha = 1;
  // hairline cracks
  for (let i = 0; i < 7; i++) {
    let x = rng.next() * S, y = rng.next() * S, a = rng.next() * 6.28;
    wrapped(S, S, () => {});
    const pts = [[x, y]];
    for (let k = 0; k < 8; k++) { a += rng.range(-0.8, 0.8); x += Math.cos(a) * rng.range(8, 24); y += Math.sin(a) * rng.range(8, 24); pts.push([x, y]); }
    wrapped(S, S, (ox, oy) => {
      for (const [g, col, lw] of [[ga, 'rgba(25,23,20,0.75)', 1.1], [gh, gray(45), 1.6]]) {
        g.strokeStyle = col; g.lineWidth = lw; g.beginPath();
        pts.forEach((p, k) => (k ? g.lineTo(p[0] + ox, p[1] + oy) : g.moveTo(p[0] + ox, p[1] + oy)));
        g.stroke();
      }
    });
  }
  // chewing gum: dark flat discs, slightly glossy
  for (let i = 0; i < 140; i++) {
    const x = rng.next() * S, y = rng.next() * S, r = 1.2 + rng.next() * 2.2, v = 50 + rng.next() * 25;
    ga.fillStyle = `rgba(${v},${v - 4},${v - 8},0.7)`; ga.beginPath(); ga.arc(x, y, r, 0, 7); ga.fill();
    go.fillStyle = rgbRM(0.5, 0); go.beginPath(); go.arc(x, y, r, 0, 7); go.fill();
    gh.fillStyle = gray(140); gh.beginPath(); gh.arc(x, y, r, 0, 7); gh.fill();
  }
  return finishSurface(A, Hc, O, S, S, { grain: 0.4, grainH: 1.0, blotch: 0.12, nStrength: 3.5, seed: 33 });
}

/**
 * Road paint, tiling along V only. Columns (U): lane dashes | zebra crossing |
 * solid white | solid yellow. Worn, dusty, with tyre-scuffed gaps.
 */
export function markingsTexture() {
  const S = 256, K = S / 64;
  const c = makeCanvas(S, S), g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  g.fillStyle = 'rgba(214,214,204,0.95)';
  g.fillRect(2 * K, 0, 12 * K, 26 * K);
  g.fillRect(18 * K, 0, 12 * K, 32 * K);
  g.fillRect(34 * K, 0, 12 * K, 64 * K);
  g.fillStyle = 'rgba(214,170,44,0.95)';
  g.fillRect(50 * K, 0, 12 * K, 64 * K);
  const img = g.getImageData(0, 0, S, S), d = img.data;
  const n1 = fbm(S, S, 71, 4, 4, 0.55), n2 = fbm(S, S, 72, 16, 3, 0.6);
  for (let i = 0; i < S * S; i++) {
    if (!d[i * 4 + 3]) continue;
    const wear = Math.min(1, Math.max(0, (n1[i] - 0.28) * 4.0));  // erosion
    const dust = 0.72 + 0.3 * n2[i];
    d[i * 4] *= dust; d[i * 4 + 1] *= dust; d[i * 4 + 2] *= dust * 0.97;
    d[i * 4 + 3] *= Math.min(1, wear * (0.55 + n2[i] * 0.7));
  }
  g.putImageData(img, 0, 0);
  const t = toTexture(c, { aniso: true });
  t.wrapS = THREE.ClampToEdgeWrapping;
  return t;
}
export const MARK_U = { dash: [3 / 64, 13 / 64], zebra: [19 / 64, 29 / 64], white: [35 / 64, 45 / 64], yellow: [51 / 64, 61 / 64] };

// ---------------------------------------------------------------------------
// Building facades: albedo + emissive (lit windows) pairs
// ---------------------------------------------------------------------------
export const FACADES = [
  // name, grid, tile size in metres, colours
  { name: 'glass', cols: 8, rows: 16, tileW: 22, tileH: 60, wall: '#3a4d60', glass: ['#1d2f44', '#243a52', '#2b4563'], lit: 0.34, run: true, warm: 0.25, mx: 0.06, my: 0.1 },
  { name: 'slab', cols: 8, rows: 16, tileW: 20, tileH: 58, wall: '#2b2e34', glass: ['#11161d', '#161d27', '#1b2430'], lit: 0.3, run: true, warm: 0.45, mx: 0.14, my: 0.16 },
  { name: 'stone', cols: 8, rows: 16, tileW: 26, tileH: 56, wall: '#948e7e', glass: ['#1c222b', '#232a35'], lit: 0.3, run: false, warm: 0.85, mx: 0.24, my: 0.22 },
  { name: 'brick', cols: 8, rows: 16, tileW: 22, tileH: 50, wall: '#6e4234', glass: ['#191c22', '#20242c'], lit: 0.34, run: false, warm: 0.9, mx: 0.27, my: 0.24, brick: true },
  { name: 'loft', cols: 8, rows: 16, tileW: 28, tileH: 62, wall: '#74767a', glass: ['#1b2330', '#222c3b'], lit: 0.26, run: false, warm: 0.6, mx: 0.12, my: 0.18, panes: true },
  { name: 'deco', cols: 8, rows: 16, tileW: 22, tileH: 58, wall: '#585349', glass: ['#161a21', '#1d222b'], lit: 0.3, run: false, warm: 0.8, mx: 0.3, my: 0.14, piers: true },
];

export function facadeTextures(def, seed) {
  const rng = new RNG(seed);
  const W = 512, H = 1024, SW = 256, SH = 512;     // albedo full-res; height / ORM / emissive half-res
  const mk = (w, h, k) => { const c = makeCanvas(w, h), g = c.getContext('2d'); g.scale(k, k); return [c, g]; };
  const [a, g] = mk(W, H, 1), [hc, gh] = mk(SW, SH, 0.5), [oc, go] = mk(SW, SH, 0.5), [e, ge] = mk(SW, SH, 0.5);
  const fill = (cv, col, x, y, w, h, al = 1) => { cv.globalAlpha = al; cv.fillStyle = col; cv.fillRect(x, y, w, h); cv.globalAlpha = 1; };
  const mas = !def.run;                     // masonry-like wall vs curtain wall
  const wallRough = def.run ? 0.38 : 0.9, wallMetal = def.run ? 0.55 : 0;
  fill(g, def.wall, 0, 0, W, H);
  fill(gh, gray(128), 0, 0, W, H);
  fill(go, rgbRM(wallRough, wallMetal), 0, 0, W, H);
  fill(ge, '#000', 0, 0, W, H);
  const cw = W / def.cols, ch = H / def.rows;

  // ---- wall surface coursing ------------------------------------------------
  if (def.brick) {
    const BH = 6, BL = 19;
    for (let r = 0, y = 0; y < H; r++, y += BH) {
      const off = r % 2 ? BL / 2 : 0;
      for (let x = -off; x < W; x += BL) {
        const t = rng.next();
        fill(g, t < 0.5 ? '#000' : t < 0.8 ? '#a0603f' : '#fff', x, y, BL, BH, 0.04 + rng.next() * 0.16);
        fill(gh, gray(135 + rng.next() * 25), x, y, BL, BH);
      }
      fill(g, '#9b9486', 0, y + BH - 1, W, 1, 0.45); fill(gh, gray(70), 0, y + BH - 1, W, 1);
      for (let x = -off; x < W; x += BL) { fill(g, '#9b9486', x, y, 1, BH, 0.4); fill(gh, gray(70), x, y, 1, BH); }
    }
  } else if (def.name === 'stone' || def.piers) {
    for (let y = 0, r = 0; y < H; y += 15, r++) {
      let x = -rng.next() * 40;
      while (x < W) {
        const bw = 36 + rng.next() * 44, t = rng.next();
        fill(g, t < 0.5 ? '#000' : '#fff', x, y, bw, 15, 0.02 + rng.next() * 0.1);
        fill(gh, gray(132 + rng.next() * 14), x, y, bw, 15);
        fill(g, '#2e2b25', x, y, 1, 15, 0.4); fill(gh, gray(80), x, y, 1.5, 15);
        x += bw;
      }
      fill(g, '#2e2b25', 0, y, W, 1, 0.4); fill(gh, gray(80), 0, y, W, 1.5);
    }
  } else if (def.panes) {            // cast-iron / precast panel loft
    for (let x = 0; x < W; x += cw) { fill(g, '#000', x, 0, 1.5, H, 0.3); fill(gh, gray(95), x, 0, 2, H); }
    for (let y = 0; y < H; y += ch) { fill(g, '#000', 0, y, W, 1.5, 0.25); fill(gh, gray(95), 0, y, W, 2); }
  } else {                           // curtain wall: fine vertical fins
    for (let x = 0; x < W; x += cw / 3) { fill(g, '#000', x, 0, 1, H, 0.22); fill(gh, gray(150), x, 0, 1.5, H); }
  }
  if (def.piers) {
    for (let c = 0; c < def.cols; c++) {
      fill(g, '#fff', c * cw, 0, 5, H, 0.1); fill(g, '#000', c * cw + 5, 0, 4, H, 0.25);
      fill(gh, gray(190), c * cw, 0, 5, H); fill(gh, gray(95), c * cw + 5, 0, 4, H);
    }
  }
  // fine height noise is added in finishSurface; weathering is painted below

  // ---- windows ------------------------------------------------------------
  const glassTones = def.name === 'glass'
    ? ['#355a7c', '#2f526f', '#3b6285', '#2b4a68']      // blue-green curtain glass reflects more
    : def.glass;
  const glassR = def.name === 'glass' ? 0.045 : 0.07, glassM = def.name === 'glass' ? 0.95 : 0.8;
  for (let r = 0; r < def.rows; r++) {
    const floorLit = def.run ? rng.chance(def.lit * 1.25) : false;
    const floorWarm = rng.chance(def.warm);
    const floorBr = 0.3 + rng.next() * 0.45;
    if (def.run) {                         // spandrel (opaque band) under every floor
      const sy = r * ch + ch * (1 - def.my * 0.6);
      fill(g, '#14181d', 0, sy, W, ch - (sy - r * ch), 0.55);
      fill(go, rgbRM(0.3, 0.6), 0, sy, W, ch - (sy - r * ch));
      fill(gh, gray(150), 0, sy, W, 2);
    }
    for (let c = 0; c < def.cols; c++) {
      const x = c * cw + cw * def.mx, y = r * ch + ch * def.my;
      const w = cw * (1 - 2 * def.mx), h = ch * (1 - def.my * 1.6);
      // reveal / frame
      fill(g, mas ? '#1b1c1e' : '#2a2d31', x - 2, y - 2, w + 4, h + 4, 0.95);
      fill(go, rgbRM(0.45, 0.8), x - 2, y - 2, w + 4, h + 4);
      fill(gh, gray(185), x - 2, y - 2, w + 4, h + 4);
      // glass pane
      fill(g, rng.pick(glassTones), x, y, w, h);
      fill(gh, gray(mas ? 60 : 90), x, y, w, h);
      fill(go, rgbRM(glassR + rng.next() * 0.05, glassM), x, y, w, h);
      // faint sky / opposite-building reflection and grime film
      const refl = g.createLinearGradient(0, y, 0, y + h);
      refl.addColorStop(0, 'rgba(160,185,225,0.16)');
      refl.addColorStop(0.55, 'rgba(120,140,170,0.05)');
      refl.addColorStop(1, 'rgba(20,24,30,0.18)');
      fill(g, refl, x, y, w, h);
      if (rng.chance(0.35)) {                      // diagonal glint
        g.fillStyle = 'rgba(255,255,255,0.05)';
        g.beginPath(); g.moveTo(x + w * 0.2, y + h); g.lineTo(x + w * 0.55, y); g.lineTo(x + w * 0.8, y); g.lineTo(x + w * 0.45, y + h); g.fill();
      }
      // interior: closed blinds, curtains or open/dark
      const lit = def.run ? floorLit && rng.chance(0.86) : rng.chance(def.lit);
      const blindKind = rng.next();
      let blindH = 0, curtain = false;
      if (blindKind < 0.35) blindH = h * rng.range(0.15, 0.95);
      else if (blindKind < 0.45) curtain = true;
      if (blindH > 0) {
        fill(g, lit ? '#d8cdb0' : '#8d8878', x, y, w, blindH, lit ? 0.5 : 0.7);
        for (let sy = y; sy < y + blindH; sy += 3) fill(g, '#000', x, sy + 2, w, 1, 0.22);
        fill(go, rgbRM(0.85, 0), x, y, w, blindH);
        fill(gh, gray(100), x, y, w, blindH);
      } else if (curtain) {
        fill(g, '#5b4b44', x, y, w * 0.28, h, 0.7); fill(g, '#5b4b44', x + w * 0.72, y, w * 0.28, h, 0.7);
        fill(go, rgbRM(0.9, 0), x, y, w * 0.28, h); fill(go, rgbRM(0.9, 0), x + w * 0.72, y, w * 0.28, h);
      }
      if (lit) {
        const warm = def.run ? floorWarm : rng.chance(def.warm);
        const base = warm ? rng.pick(['#ffc47a', '#ffb860', '#ffd69a', '#f2a64e']) : rng.pick(['#cfe2f5', '#b4d0ee', '#dbe8f6', '#9cc4e8']);
        const k = (def.run ? floorBr : 0.28) * (0.65 + rng.next() * 0.7) + (def.run ? 0 : rng.next() * 0.3);
        const grd = ge.createLinearGradient(0, y, 0, y + h);
        grd.addColorStop(0, base); grd.addColorStop(1, '#000');
        ge.globalAlpha = Math.min(0.85, k * 1.15); ge.fillStyle = grd; ge.fillRect(x, y, w, h);
        ge.globalAlpha = Math.min(0.85, k * 0.35); ge.fillStyle = base; ge.fillRect(x, y, w, h);
        ge.globalAlpha = 1;
        // blinds / curtains / furniture silhouettes in the emissive map
        if (blindH > 0) {
          ge.globalAlpha = 0.65; ge.fillStyle = '#000'; ge.fillRect(x, y, w, blindH);
          for (let sy = y; sy < y + blindH; sy += 3) { ge.globalAlpha = 0.5; ge.fillStyle = base; ge.fillRect(x, sy, w, 1); }
          ge.globalAlpha = 1;
        } else if (curtain) {
          fill(ge, '#000', x, y, w * 0.28, h, 0.75); fill(ge, '#000', x + w * 0.72, y, w * 0.28, h, 0.75);
        } else if (rng.chance(0.5)) {
          fill(ge, '#000', x + w * rng.next() * 0.6, y + h * 0.5, w * rng.range(0.2, 0.4), h * 0.5, 0.7);
        }
        fill(g, base, x, y, w, h, 0.12 * Math.min(1, k * 1.5));
      }
      // mullions
      if (def.panes) {
        for (let m = 1; m < 3; m++) { fill(g, '#26292d', x + (w * m) / 3 - 1, y, 2, h, 0.95); fill(ge, '#000', x + (w * m) / 3 - 1, y, 2, h); fill(gh, gray(170), x + (w * m) / 3 - 1, y, 2, h); }
        fill(g, '#26292d', x, y + h / 2 - 1, w, 2, 0.95); fill(ge, '#000', x, y + h / 2 - 1, w, 2); fill(gh, gray(170), x, y + h / 2 - 1, w, 2);
      } else if (def.run || rng.chance(0.5)) {
        fill(g, '#26292d', x + w / 2 - 1, y, 2, h, 0.9); fill(ge, '#000', x + w / 2 - 1, y, 2, h); fill(gh, gray(170), x + w / 2 - 1, y, 2, h);
      }
      if (mas) {
        // projecting stone sill, lintel shadow and rain-streaked staining below
        fill(g, '#cfc9ba', x - 3, y + h + 1, w + 6, 4, 0.55); fill(gh, gray(215), x - 3, y + h + 1, w + 6, 4);
        fill(g, '#000', x - 3, y + h + 5, w + 6, 3, 0.35);
        fill(g, '#000', x - 2, y - 5, w + 4, 4, 0.35);
        const ns = 2 + (rng.next() * 3 | 0);
        for (let s = 0; s < ns; s++) {
          const sx = x + rng.next() * w, len = 18 + rng.next() * 60, wd = 2 + rng.next() * 6;
          const gr = g.createLinearGradient(0, y + h + 5, 0, y + h + 5 + len);
          gr.addColorStop(0, `rgba(20,16,12,${0.1 + rng.next() * 0.17})`); gr.addColorStop(1, 'rgba(20,16,12,0)');
          g.fillStyle = gr; g.fillRect(sx, y + h + 5, wd, len);
        }
      }
    }
    if (def.run) {                                    // slab edge between floors
      fill(g, '#000', 0, r * ch, W, 3, 0.35); fill(gh, gray(190), 0, r * ch, W, 3);
    }
  }
  // ---- soiling: long vertical streaks and darker base ----------------------
  for (let i = 0; i < 30; i++) {
    const sx = rng.next() * W, len = 120 + rng.next() * 500, sy = rng.next() * (H - len), wd = 3 + rng.next() * 14;
    const gr = g.createLinearGradient(0, sy, 0, sy + len);
    gr.addColorStop(0, 'rgba(10,8,6,0)'); gr.addColorStop(0.3, `rgba(10,8,6,${0.04 + rng.next() * 0.08})`); gr.addColorStop(1, 'rgba(10,8,6,0)');
    g.fillStyle = gr; g.fillRect(sx, sy, wd, len);
  }
  const base = g.createLinearGradient(0, H * 0.82, 0, H);
  base.addColorStop(0, 'rgba(12,10,8,0)'); base.addColorStop(1, 'rgba(12,10,8,0.2)');
  fill(g, base, 0, H * 0.82, W, H * 0.18);

  // ---- finish: tonal blotches + grain on albedo, normal map from height -----
  const ga = g.getImageData(0, 0, W, H), d = ga.data;
  const blot = fbm(W, H, seed + 3, 4, 5, 0.55);
  for (let i = 0; i < W * H; i++) {
    const k = 1 + (blot[i] - 0.5) * (mas ? 0.34 : 0.14) + ((i * 2654435761) >>> 24) / 255 * 0.05 - 0.025;
    d[i * 4] *= k; d[i * 4 + 1] *= k; d[i * 4 + 2] *= k;
  }
  g.putImageData(ga, 0, 0);
  const hd = gh.getImageData(0, 0, SW, SH).data, hf = new Float32Array(SW * SH);
  const hn = fbm(SW, SH, seed + 4, 32, 3, 0.6);
  for (let i = 0; i < SW * SH; i++) hf[i] = hd[i * 4] / 255 + (hn[i] - 0.5) * (mas ? 0.05 : 0.01);
  const normal = normalCanvas(hf, SW, SH, mas ? 3.2 : 2.2);
  // roughness variation (dirt film on the wall)
  const od = go.getImageData(0, 0, SW, SH), rn = fbm(SW, SH, seed + 5, 8, 4, 0.55);
  for (let i = 0; i < SW * SH; i++) od.data[i * 4 + 1] = Math.min(255, od.data[i * 4 + 1] * (0.88 + rn[i] * 0.2));
  go.putImageData(od, 0, 0);
  const orm = toTexture(oc, { srgb: false });
  return { map: toTexture(a), emissive: toTexture(e), normalMap: toTexture(normal, { srgb: false }), roughnessMap: orm, metalnessMap: orm };
}

// Street-level shops, street signs, and glow/smoke/flash sprites live in ./shop_textures.js
// and billboards live in ./ad_art.js (both re-exported at the top of this file).

// ---------------------------------------------------------------------------
// Soldier uniform atlas (512 x 512). Left half: camouflage. Right half: flat
// swatches, flag patch and name tape.
// ---------------------------------------------------------------------------
export const KIT = {
  // u0,v0,u1,v1 rectangles in UV space (v up)
  camo: [0.01, 0.01, 0.49, 0.99],
  gear: [0.52, 0.89, 0.61, 0.98],
  gearDark: [0.64, 0.89, 0.73, 0.98],
  boot: [0.76, 0.89, 0.85, 0.98],
  skin: [0.88, 0.89, 0.97, 0.98],
  black: [0.52, 0.77, 0.61, 0.86],
  glove: [0.64, 0.77, 0.73, 0.86],
  accent: [0.76, 0.77, 0.85, 0.86],
  metal: [0.88, 0.77, 0.97, 0.86],
  flag: [0.52, 0.52, 0.74, 0.66],
  tape: [0.52, 0.42, 0.98, 0.5],
};

function digitalCamo(g, x0, y0, w, h, colors, seed, cell = 4) {
  const rng = new RNG(seed);
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  // layered value noise -> banded into the palette, then pixelated
  const grids = [];
  for (const size of [5, 9, 17]) {
    const pts = [];
    for (let i = 0; i < (size + 1) * (size + 1); i++) pts.push(rng.next());
    grids.push({ size, pts });
  }
  const sample = (gr, u, v) => {
    const fx = u * gr.size, fz = v * gr.size;
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const p = (a, b) => gr.pts[(b % gr.size) * (gr.size + 1) + (a % gr.size)];
    const a = p(ix, iz), b = p(ix + 1, iz), c2 = p(ix, iz + 1), d = p(ix + 1, iz + 1);
    return a + (b - a) * tx + (c2 - a) * tz + (a - b - c2 + d) * tx * tz;
  };
  // two independent fields: one picks the base colour (large shapes), the
  // other scatters the light and dark accent patches on top
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const u = i / gw, v = j / gh;
      const n1 = sample(grids[0], u, v) * 0.6 + sample(grids[1], u + 0.37, v + 0.11) * 0.4 + (rng.next() - 0.5) * 0.07;
      const n2 = sample(grids[1], u, v) * 0.5 + sample(grids[2], u, v) * 0.5 + (rng.next() - 0.5) * 0.07;
      const k = n2 > 0.62 ? 2 : n2 < 0.36 ? 3 : n1 > 0.5 ? 1 : 0;
      g.fillStyle = colors[k];
      g.fillRect(x0 + i * cell, y0 + j * cell, cell, cell);
    }
  }
}

export function soldierTexture(kind) {
  const c = makeCanvas(512, 512), g = c.getContext('2d');
  const marine = kind === 'marine';
  g.fillStyle = '#000';
  g.fillRect(0, 0, 512, 512);
  if (marine) {
    // woodland MARPAT: green, coyote brown, khaki and black "pixels"
    digitalCamo(g, 0, 0, 256, 512, ['#4a5a35', '#6e5a3b', '#a39672', '#23241d'], 1775, 4);
  } else {
    // hostile force: dark urban pattern
    digitalCamo(g, 0, 0, 256, 512, ['#2e3035', '#3a3c42', '#55575c', '#17181a'], 404, 5);
  }
  const sw = (rect, color, noise = 0.06) => {
    const x = rect[0] * 512, y = (1 - rect[3]) * 512, w = (rect[2] - rect[0]) * 512, h = (rect[3] - rect[1]) * 512;
    g.fillStyle = color;
    g.fillRect(x - 3, y - 3, w + 6, h + 6);
    const rng = new RNG(Math.floor(x * 7 + y));
    for (let i = 0; i < 120; i++) {
      g.globalAlpha = noise * rng.next();
      g.fillStyle = rng.chance(0.5) ? '#000' : '#fff';
      g.fillRect(x + rng.next() * w, y + rng.next() * h, 2, 2);
    }
    g.globalAlpha = 1;
    return [x, y, w, h];
  };
  sw(KIT.gear, marine ? '#8a7350' : '#2a2c30');       // coyote plate carrier / black rig
  sw(KIT.gearDark, marine ? '#6d5a3d' : '#1c1d20');
  sw(KIT.boot, marine ? '#8f744f' : '#18181a');       // coyote suede boots
  sw(KIT.skin, marine ? '#c79a74' : '#2a2a2c');       // hostiles wear balaclavas
  sw(KIT.black, '#141518');
  sw(KIT.glove, marine ? '#5e5138' : '#121214');
  sw(KIT.accent, marine ? '#6b7a4a' : '#b3202a');     // hostiles: red arm band
  sw(KIT.metal, '#3b3d42');
  // shoulder flag patch
  {
    const [x, y, w, h] = sw(KIT.flag, marine ? '#b22234' : '#b3202a', 0);
    if (marine) {
      g.fillStyle = '#fff';
      for (let i = 1; i < 13; i += 2) g.fillRect(x, y + (h * i) / 13, w, h / 13);
      g.fillStyle = '#3c3b6e';
      g.fillRect(x, y, w * 0.42, (h * 7) / 13);
      g.fillStyle = '#fff';
      for (let r = 0; r < 4; r++) for (let k = 0; k < 5; k++) g.fillRect(x + 4 + k * 8.5, y + 4 + r * 8.5, 2.5, 2.5);
    } else {
      g.fillStyle = '#111';
      g.fillRect(x + w * 0.42, y, w * 0.16, h);
    }
  }
  // chest tape
  {
    const [x, y, w, h] = sw(KIT.tape, marine ? '#5c6a45' : '#1c1d20', 0.03);
    g.fillStyle = marine ? '#15180f' : '#b3202a';
    g.font = '800 26px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(marine ? 'U.S. MARINES' : 'HOSTILE', x + w / 2, y + h / 2 + 1, w - 12);
  }
  const t = toTexture(c, { repeat: false });
  t.magFilter = THREE.NearestFilter; // keep the camouflage "pixels" crisp up close
  return t;
}

// ---------------------------------------------------------------------------
// Vegetation: leaf atlas (colour + separate alpha so no dark halos), bark, grass
// ---------------------------------------------------------------------------
/**
 * 1024 atlas, 4x4 cells of 256: 0-3 honey locust sprigs, 4-7 plane leaves,
 * 8-11 pear twigs, 12-15 dense clumps. Returns { map, alphaMap }.
 */
export function foliageTextures() {
  const S = 1024, CS = 256;
  const cC = makeCanvas(S, S), cA = makeCanvas(S, S);
  const gC = cC.getContext('2d'), gA = cA.getContext('2d');
  gC.fillStyle = '#2a4a1e'; gC.fillRect(0, 0, S, S);
  gA.fillStyle = '#000'; gA.fillRect(0, 0, S, S);
  const rng = new RNG(7711);
  const hsl = (h, s, l) => `hsl(${h | 0},${s | 0}%,${l | 0}%)`;
  // leaf shape in a local frame: base at origin, tip at (len, 0)
  const shape = (g, len, wid, pointy) => {
    g.beginPath();
    g.moveTo(0, 0);
    g.bezierCurveTo(len * 0.2, wid, len * (pointy ? 0.6 : 0.75), wid * 0.85, len, 0);
    g.bezierCurveTo(len * (pointy ? 0.6 : 0.75), -wid * 0.85, len * 0.2, -wid, 0, 0);
    g.closePath();
  };
  const leaf = (x, y, ang, len, wid, h, s, l, pointy = true, vein = true) => {
    for (const [g, isA] of [[gC, false], [gA, true]]) {
      g.save(); g.translate(x, y); g.rotate(ang);
      shape(g, len, wid, pointy);
      if (isA) { g.fillStyle = '#fff'; g.fill(); } else {
        const gr = g.createLinearGradient(0, -wid, 0, wid);
        gr.addColorStop(0, hsl(h, s, l * 0.82)); gr.addColorStop(0.5, hsl(h, s, l * 1.12)); gr.addColorStop(1, hsl(h, s, l * 0.9));
        g.fillStyle = gr; g.fill();
        g.globalAlpha = 0.3; g.strokeStyle = hsl(h, s, l * 0.6); g.lineWidth = 1; g.stroke(); g.globalAlpha = 1;
        if (vein) {
          g.strokeStyle = hsl(h, s - 10, l * 1.3); g.lineWidth = Math.max(1, wid * 0.07);
          g.beginPath(); g.moveTo(0, 0); g.lineTo(len * 0.95, 0); g.stroke();
          g.lineWidth = 0.8; g.globalAlpha = 0.5;
          for (let k = 1; k < 5; k++) { g.beginPath(); g.moveTo(len * k * 0.18, 0); g.lineTo(len * (k * 0.18 + 0.15), wid * 0.6); g.moveTo(len * k * 0.18, 0); g.lineTo(len * (k * 0.18 + 0.15), -wid * 0.6); g.stroke(); }
          g.globalAlpha = 1;
        }
      }
      g.restore();
    }
  };
  const line = (x0, y0, x1, y1, w, col) => {
    gC.strokeStyle = col; gC.lineWidth = w; gC.lineCap = 'round';
    gC.beginPath(); gC.moveTo(x0, y0); gC.lineTo(x1, y1); gC.stroke();
    gA.strokeStyle = '#fff'; gA.lineWidth = w; gA.lineCap = 'round';
    gA.beginPath(); gA.moveTo(x0, y0); gA.lineTo(x1, y1); gA.stroke();
  };
  for (let cell = 0; cell < 16; cell++) {
    const ox = (cell % 4) * CS, oy = Math.floor(cell / 4) * CS;
    const kind = cell >> 2;
    gC.save(); gA.save();
    gC.beginPath(); gC.rect(ox, oy, CS, CS); gC.clip();
    gA.beginPath(); gA.rect(ox, oy, CS, CS); gA.clip();
    if (kind === 0) { // honey locust: feathery compound leaf, bipinnate hint
      const bend = (rng.next() - 0.5) * 50;
      const stemX = ox + CS / 2, stemY = oy + CS - 6;
      const pt = (t) => [stemX + bend * t * t + Math.sin(t * 3) * 6, stemY - t * (CS - 30)];
      for (let t = 0; t < 1; t += 0.01) { const [a, b] = pt(t), [c, d] = pt(t + 0.01); line(a, b, c, d, 2.4 - t * 1.2, '#5d6b2a'); }
      const nP = 11;
      for (let i = 0; i < nP; i++) {
        const t = 0.1 + (i / (nP - 1)) * 0.88, [px, py] = pt(t);
        const sz = (1 - t * 0.45) * 62;
        for (const side of [-1, 1]) {
          const a = -Math.PI / 2 + side * (1.15 - t * 0.35) + (rng.next() - 0.5) * 0.2;
          line(px, py, px + Math.cos(a) * sz * 0.9, py + Math.sin(a) * sz * 0.9, 1.4, '#6e8a30');
          for (let k = 1; k <= 5; k++) {
            const q = k / 5, lx = px + Math.cos(a) * sz * q, ly = py + Math.sin(a) * sz * q;
            for (const s2 of [-1, 1]) leaf(lx, ly, a + s2 * 1.35, 17, 5.2, 72 + rng.next() * 18, 55 + rng.next() * 15, 40 + rng.next() * 14, false, false);
          }
        }
        const [tx, ty] = pt(1);
        if (i === nP - 1) leaf(tx, ty, -Math.PI / 2, 20, 6, 80, 60, 50, false, false);
      }
    } else if (kind === 1) { // plane: big palmate leaves
      const two = [[CS * 0.5, CS * 0.98, 1.0, 0], [CS * 0.22, CS * 0.78, 0.55, -0.9], [CS * 0.8, CS * 0.82, 0.5, 1.0]];
      for (const [lx, ly, sc, rot] of two) {
        const bx = ox + lx, by = oy + ly, h = 88 + rng.next() * 14, l = 38 + rng.next() * 8;
        const ang = [-70, -35, 0, 35, 70], lenS = [0.62, 0.9, 1, 0.9, 0.62], wS = [20, 28, 32, 28, 20];
        line(bx, by, bx + Math.sin(rot) * 14, by - 24 * sc, 3 * sc, '#6d7a3a');
        const hx = bx + Math.sin(rot) * 14, hy = by - 24 * sc;
        for (let i = 0; i < 5; i++) {
          const a = -Math.PI / 2 + rot + (ang[i] * Math.PI) / 180;
          leaf(hx, hy, a, 98 * lenS[i] * sc, wS[i] * sc, h + (rng.next() - 0.5) * 6, 42, l + (rng.next() - 0.5) * 4, true, true);
        }
        leaf(hx, hy, -Math.PI / 2 + rot, 40 * sc, 24 * sc, h, 42, l, false, false);
      }
    } else if (kind === 2) { // pear: glossy ovate leaves on a twig
      const stemX = ox + CS / 2, stemY = oy + CS - 6, bend = (rng.next() - 0.5) * 40;
      const pt = (t) => [stemX + bend * t * t, stemY - t * (CS - 40)];
      for (let t = 0; t < 1; t += 0.02) { const [a, b] = pt(t), [c, d] = pt(t + 0.02); line(a, b, c, d, 3 - t * 1.6, '#4a3a28'); }
      for (let i = 0; i < 8; i++) {
        const t = 0.12 + i * 0.105, [px, py] = pt(t), side = i % 2 ? 1 : -1;
        leaf(px, py, -Math.PI / 2 + side * (0.9 - t * 0.3) + (rng.next() - 0.5) * 0.3, 78 - t * 20, 30 - t * 8, 100 + rng.next() * 12, 46, 24 + rng.next() * 6, true, true);
      }
      const [tx, ty] = pt(1);
      leaf(tx, ty, -Math.PI / 2, 60, 24, 105, 48, 28, true, true);
    } else { // clumps: densely packed small leaves, solid core so no holes
      const cx = ox + CS / 2, cy = oy + CS / 2;
      gA.fillStyle = '#fff'; gA.beginPath(); gA.arc(cx, cy, 78, 0, 7); gA.fill();
      gC.fillStyle = '#1f3d1a'; gC.beginPath(); gC.arc(cx, cy, 78, 0, 7); gC.fill();
      for (let i = 0; i < 150; i++) {
        const a = rng.next() * 6.283, r = Math.sqrt(rng.next()) * 100;
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
        const lum = 20 + (1 - r / 110) * 8 + rng.next() * 16;
        leaf(x, y, a + (rng.next() - 0.5) * 1.4, 34 + rng.next() * 14, 12 + rng.next() * 5, 100 + rng.next() * 14 - (kind === 3 ? 0 : 0), 45 + rng.next() * 12, lum, true, false);
      }
    }
    gC.restore(); gA.restore();
  }
  const map = toTexture(cC, { repeat: false });
  const alphaMap = toTexture(cA, { repeat: false, srgb: false });
  return { map, alphaMap };
}

/** Tileable furrowed bark, 512 px = ~1.4 m. Returns { map, normalMap }. */
export function barkTextures() {
  const W = 512, H = 512, rng = new RNG(4242);
  const ridge1 = fbm(W, 1, 11, 24, 3, 0.55), warp = fbm(W, H, 12, 3, 4, 0.5), blot = fbm(W, H, 13, 5, 4, 0.5), brk = fbm(W, H, 14, 8, 3, 0.5);
  const hf = new Float32Array(W * H);
  const c = makeCanvas(W, H), g = c.getContext('2d');
  const img = g.createImageData(W, H), d = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const xs = (x + Math.floor((warp[i] - 0.5) * 70) + W * 2) % W;
      const r = ridge1[xs];
      let h = Math.abs(r - 0.5) * 2; // 0 = crest... valleys at 0.5 crossings
      h = Math.pow(1 - h, 0.7);
      h = h * (0.75 + 0.25 * brk[i]) - (brk[i] > 0.62 ? 0.25 : 0);
      h = Math.max(0, Math.min(1, h)) * 0.8 + blot[i] * 0.2;
      hf[i] = h;
      const k = 0.3 + h * 0.7, n = 0.92 + rng.next() * 0.16;
      d[i * 4] = Math.min(255, (92 * k + 14) * n * (0.9 + blot[i] * 0.25));
      d[i * 4 + 1] = Math.min(255, (82 * k + 12) * n * (0.9 + blot[i] * 0.2));
      d[i * 4 + 2] = Math.min(255, (72 * k + 10) * n * (0.9 + blot[i] * 0.15));
      d[i * 4 + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return { map: toTexture(c), normalMap: toTexture(normalCanvas(hf, W, H, 5), { srgb: false }) };
}

/** Mown lawn, 512 px = 4 m. Returns { map, normalMap }. */
export function grassTextures() {
  const W = 512, H = 512, rng = new RNG(9090);
  const blot = fbm(W, H, 21, 4, 5, 0.55), fine = fbm(W, H, 22, 32, 3, 0.6);
  const c = makeCanvas(W, H), g = c.getContext('2d');
  const img = g.createImageData(W, H), d = img.data;
  const hf = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const b = blot[i], f = fine[i];
    const k = 0.78 + b * 0.5 + (f - 0.5) * 0.5;
    d[i * 4] = Math.min(255, 62 * k + 8 * (1 - b)); d[i * 4 + 1] = Math.min(255, 104 * k); d[i * 4 + 2] = Math.min(255, 38 * k); d[i * 4 + 3] = 255;
    hf[i] = f;
  }
  g.putImageData(img, 0, 0);
  const cols = ['#4f8a2c', '#6aa23a', '#3c7424', '#86b44a', '#2f5e1d'];
  g.lineCap = 'round';
  wrapped(W, H, (ox, oy) => {
    const r2 = new RNG(777);
    for (let i = 0; i < 5200; i++) {
      const x = r2.next() * W + ox, y = r2.next() * H + oy;
      if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
      const l = 5 + r2.next() * 9, a = -Math.PI / 2 + (r2.next() - 0.5) * 1.1;
      g.globalAlpha = 0.25 + r2.next() * 0.45;
      g.strokeStyle = cols[(r2.next() * cols.length) | 0];
      g.lineWidth = 1 + r2.next() * 0.8;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
  });
  g.globalAlpha = 1;
  // faint clover / dry flecks
  for (let i = 0; i < 160; i++) {
    g.fillStyle = rng.chance(0.5) ? 'rgba(150,150,70,0.35)' : 'rgba(35,70,25,0.4)';
    g.beginPath(); g.arc(rng.next() * W, rng.next() * H, 1 + rng.next() * 3, 0, 7); g.fill();
  }
  return { map: toTexture(c), normalMap: toTexture(normalCanvas(hf, W, H, 1.6), { srgb: false }) };
}

/** Dark soil / wood mulch, 256 px = 1 m. */
export function soilTexture() {
  const W = 256, H = 256, rng = new RNG(5151);
  const blot = fbm(W, H, 31, 6, 4, 0.55);
  const c = makeCanvas(W, H), g = c.getContext('2d');
  const img = g.createImageData(W, H), d = img.data;
  for (let i = 0; i < W * H; i++) {
    const k = 0.55 + blot[i] * 0.8 + (rng.next() - 0.5) * 0.35;
    d[i * 4] = 110 * k; d[i * 4 + 1] = 82 * k; d[i * 4 + 2] = 58 * k; d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  for (let i = 0; i < 260; i++) {
    g.strokeStyle = rng.chance(0.5) ? 'rgba(110,78,50,0.7)' : 'rgba(30,20,14,0.7)';
    g.lineWidth = 1.5 + rng.next() * 2; g.lineCap = 'round';
    const x = rng.next() * W, y = rng.next() * H, a = rng.next() * 6.28, l = 4 + rng.next() * 8;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  return toTexture(c);
}
