// Storefront, street-sign, and sprite procedural canvas textures.
import { RNG } from '../core/util.js';
import { STREETS, AVENUES } from './layout.js';
import { makeCanvas, toTexture, normalCanvas } from './textures.js';

const rgbRM = (r, m) => `rgb(0,${Math.round(r * 255)},${Math.round(m * 255)})`;
const gray = (v) => `rgb(${v | 0},${v | 0},${v | 0})`;

export const SHOP_COLS = 4, SHOP_ROWS = 3;
const SHOP_NAMES = ['MERCER DELI', "JOE'S SLICE", 'MIDTOWN BOOKS', 'APOTHECARY', 'ROAST & CO.', 'SOUND LAB', 'BAGEL HOUSE', 'NEWSSTAND', 'BROADWAY DINER', 'METRO BANK', 'HOTEL ASTOR', 'BOX OFFICE'];
const SHOP_HUES = [14, 24, 338, 158, 28, 205, 36, 252, 352, 214, 42, 4];

export function shopTexture() {
  return shopTextures().map;
}

/** Street-level storefronts: full PBR set { map, normalMap, orm, emissive } with deep recessed glass, steel mullions & selective warm/cool interior pools. */
export function shopTextures() {
  const rng = new RNG(31);
  const W = 1024, H = 512, SW = 512, SH = 256, cw = W / SHOP_COLS, ch = H / SHOP_ROWS;
  const mk = (w, h, k) => { const c = makeCanvas(w, h), g = c.getContext('2d'); g.scale(k, k); return [c, g]; };
  const [c, g] = mk(W, H, 1), [hc, gh] = mk(SW, SH, 0.5), [oc, go] = mk(SW, SH, 0.5), [ec, ge] = mk(SW, SH, 0.5);
  const fill = (cv, col, x, y, w, h, al = 1) => { cv.globalAlpha = al; cv.fillStyle = col; cv.fillRect(x, y, w, h); cv.globalAlpha = 1; };

  fill(g, '#0d0f13', 0, 0, W, H);
  fill(gh, gray(178), 0, 0, W, H);
  fill(go, rgbRM(0.58, 0.32), 0, 0, W, H);
  fill(ge, '#000', 0, 0, W, H);

  for (let i = 0; i < SHOP_COLS * SHOP_ROWS; i++) {
    const x = (i % SHOP_COLS) * cw, y = Math.floor(i / SHOP_COLS) * ch;
    const hue = SHOP_HUES[i];
    const shuttered = i === 3 || i === 9;
    fill(g, '#14161b', x, y, cw, ch);
    fill(gh, gray(192), x, y, cw, ch);
    fill(go, rgbRM(0.44, 0.62), x, y, cw, ch);

    const fasciaBg = shuttered ? '#1b1d22' : `hsl(${hue} 44% 16%)`;
    fill(g, fasciaBg, x + 5, y + 6, cw - 10, 34);
    fill(gh, gray(222), x + 5, y + 6, cw - 10, 34);
    fill(gh, gray(46), x + 5, y + 40, cw - 10, 5);
    fill(go, rgbRM(shuttered ? 0.64 : 0.34, 0.16), x + 5, y + 6, cw - 10, 34);
    if (!shuttered) fill(ge, `hsl(${hue} 58% 22%)`, x + 5, y + 6, cw - 10, 34, 0.45);

    const drawSignText = (cv, col, al = 1) => {
      cv.globalAlpha = al; cv.fillStyle = col;
      cv.font = '700 20px sans-serif'; cv.textAlign = 'center'; cv.textBaseline = 'middle';
      cv.fillText(SHOP_NAMES[i], x + cw / 2, y + 23, cw - 22);
      cv.globalAlpha = 1;
    };
    drawSignText(g, shuttered ? '#7b7f86' : '#f2efe8');
    if (!shuttered) drawSignText(ge, '#fff3dc', 0.85);

    const gy = y + 46, ghPx = ch - 60;
    if (shuttered) {
      fill(g, '#393d45', x + 8, gy, cw - 16, ghPx);
      fill(go, rgbRM(0.62, 0.54), x + 8, gy, cw - 16, ghPx);
      fill(gh, gray(118), x + 8, gy, cw - 16, ghPx);
      for (let k = 0; k < ghPx; k += 6) {
        fill(g, '#202329', x + 8, gy + k, cw - 16, 2.2);
        fill(g, 'rgba(255,255,255,0.06)', x + 8, gy + k + 2.2, cw - 16, 1.4);
        fill(gh, gray(68), x + 8, gy + k, cw - 16, 2);
        fill(gh, gray(162), x + 8, gy + k + 2, cw - 16, 3);
      }
      fill(g, '#1b1d22', x + 8, gy + ghPx - 8, cw - 16, 8);
      fill(gh, gray(192), x + 8, gy + ghPx - 8, cw - 16, 8);
    } else {
      const warm = rng.chance(0.7);
      const baseGrad = g.createLinearGradient(0, gy, 0, gy + ghPx);
      baseGrad.addColorStop(0, warm ? '#2c1f16' : '#182430');
      baseGrad.addColorStop(0.55, '#121419');
      baseGrad.addColorStop(1, '#08090c');
      fill(g, baseGrad, x + 8, gy, cw - 16, ghPx);

      fill(gh, gray(56), x + 8, gy, cw - 16, ghPx);
      fill(go, rgbRM(0.08, 0.85), x + 8, gy, cw - 16, ghPx);

      for (let p = 0; p < 2; p++) {
        const px = x + cw * (0.3 + p * 0.4 + (rng.next() - 0.5) * 0.08);
        const py = gy + ghPx * 0.22;
        const rad = cw * 0.34;
        const rg = g.createRadialGradient(px, py, 2, px, py, rad);
        rg.addColorStop(0, warm ? 'rgba(255,212,148,0.75)' : 'rgba(196,228,255,0.68)');
        rg.addColorStop(0.45, warm ? 'rgba(180,108,42,0.28)' : 'rgba(90,145,195,0.24)');
        rg.addColorStop(1, 'rgba(0,0,0,0)');
        fill(g, rg, x + 8, gy, cw - 16, ghPx);

        const reg = ge.createRadialGradient(px, py, 2, px, py, rad * 0.9);
        reg.addColorStop(0, warm ? 'rgba(255,204,132,0.72)' : 'rgba(176,216,255,0.62)');
        reg.addColorStop(0.5, warm ? 'rgba(140,78,28,0.22)' : 'rgba(65,112,160,0.18)');
        reg.addColorStop(1, 'rgba(0,0,0,0)');
        fill(ge, reg, x + 8, gy, cw - 16, ghPx);
      }

      g.fillStyle = 'rgba(7,8,11,0.72)';
      ge.fillStyle = 'rgba(0,0,0,0.72)';
      for (let k = 0; k < 8; k++) {
        const w = 10 + rng.next() * 24, h = 14 + rng.next() * 44;
        const rx = x + 12 + rng.next() * (cw - 36 - w);
        g.fillRect(rx, gy + ghPx - h, w, h);
        ge.fillRect(rx, gy + ghPx - h, w, h);
      }
      fill(g, 'rgba(12,14,18,0.55)', x + 8, gy + ghPx * 0.36, cw - 16, 3);

      const doorX = x + cw * rng.pick([0.22, 0.5, 0.76]);
      const mullion = (mx, my, mw, mh) => {
        fill(g, '#16191f', mx, my, mw, mh);
        fill(gh, gray(208), mx, my, mw, mh);
        fill(go, rgbRM(0.32, 0.78), mx, my, mw, mh);
        fill(ge, '#000', mx, my, mw, mh);
      };
      mullion(x + 8, gy + ghPx * 0.24, cw - 16, 3.5);
      mullion(doorX - 18, gy, 4, ghPx);
      mullion(doorX + 14, gy, 4, ghPx);
      mullion(x + cw / 2 - 1.5, gy, 3, ghPx * 0.24);
      fill(g, 'rgba(0,0,0,0.42)', doorX - 14, gy + 4, 28, ghPx - 4);
      fill(ge, '#000', doorX - 14, gy + 4, 28, ghPx - 4, 0.55);
      fill(g, '#b8bec6', doorX + 8, gy + ghPx * 0.54, 3, 12);
      fill(gh, gray(225), doorX + 8, gy + ghPx * 0.54, 3, 12);
    }

    fill(g, '#131418', x, y + ch - 13, cw, 13);
    fill(gh, gray(202), x, y + ch - 13, cw, 13);
    fill(go, rgbRM(0.68, 0.08), x, y + ch - 13, cw, 13);
    fill(ge, '#000', x, y + ch - 13, cw, 13);
    fill(g, '#101115', x, y, 5, ch);
    fill(g, '#101115', x + cw - 5, y, 5, ch);
    fill(gh, gray(212), x, y, 5, ch);
    fill(gh, gray(212), x + cw - 5, y, 5, ch);
    fill(go, rgbRM(0.52, 0.38), x, y, 5, ch);
    fill(go, rgbRM(0.52, 0.38), x + cw - 5, y, 5, ch);
    fill(ge, '#000', x, y, 5, ch);
    fill(ge, '#000', x + cw - 5, y, 5, ch);
  }

  for (let i = 0; i < SHOP_COLS * SHOP_ROWS; i++) {
    const x = (i % SHOP_COLS) * cw, y = Math.floor(i / SHOP_COLS) * ch;
    const gy = y + 46, ghPx = ch - 60;
    if (i !== 3 && i !== 9) {
      fill(g, 'rgba(14,18,26,0.38)', x + 8, gy, cw - 16, ghPx);
      const dk = g.createLinearGradient(0, gy, 0, gy + ghPx);
      dk.addColorStop(0, 'rgba(6,8,14,0.34)'); dk.addColorStop(0.48, 'rgba(6,8,14,0)'); dk.addColorStop(1, 'rgba(4,5,9,0.52)');
      fill(g, dk, x + 8, gy, cw - 16, ghPx);
      fill(g, 'rgba(0,0,0,0.55)', x + 8, gy + ghPx - 8, cw - 16, 8);
    }
    fill(g, 'rgba(0,0,0,0.16)', x + 5, y + 6, cw - 10, 34);
    for (let k = 0; k < 12; k++) {
      const sx = x + 10 + rng.next() * (cw - 20), len = 18 + rng.next() * 52;
      const gr = g.createLinearGradient(0, y + 40, 0, y + 40 + len);
      gr.addColorStop(0, 'rgba(0,0,0,0.24)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      fill(g, gr, sx, y + 40, 2 + rng.next() * 3.5, len);
    }
  }
  g.fillStyle = 'rgba(0,0,0,0.45)';
  for (let k = 0; k < 800; k++) { g.globalAlpha = 0.03 + rng.next() * 0.09; g.fillRect(rng.next() * W, rng.next() * H, 1 + rng.next() * 3, 1 + rng.next() * 3); }
  g.globalAlpha = 1;

  const hd = gh.getImageData(0, 0, SW, SH).data, hf = new Float32Array(SW * SH);
  for (let i = 0; i < SW * SH; i++) hf[i] = hd[i * 4] / 255;
  const normalMap = toTexture(normalCanvas(hf, SW, SH, 3.0), { repeat: false, srgb: false });
  const orm = toTexture(oc, { repeat: false, srgb: false });
  return {
    map: toTexture(c, { repeat: false }),
    normalMap,
    orm,
    emissive: toTexture(ec, { repeat: false }),
  };
}

/** Street-name & transit signs (8 x 16 atlas of 256x64 cells; fictional TIX booth sign). */
export function signsTexture() {
  const c = makeCanvas(2048, 1024), g = c.getContext('2d');
  const cells = {};
  const labels = [];
  for (const s of STREETS) { labels.push(`W ${s.n} St`); labels.push(`E ${s.n} St`); }
  for (const a of AVENUES) labels.push(a.name.replace(' AV', ' Av').replace('MADISON', 'Madison').replace('PARK', 'Park').replace('LEXINGTON', 'Lexington'));
  labels.push('Broadway', 'Times Sq', 'SUBWAY', 'POLICE', 'TIX', 'ONE WAY');
  labels.forEach((label, i) => {
    const col = i % 8, row = Math.floor(i / 8);
    const x = col * 256, y = row * 64;
    const special = label === 'SUBWAY' || label === 'POLICE' || label === 'TIX' || label === 'ONE WAY';
    g.fillStyle = label === 'SUBWAY' ? '#101114' : label === 'POLICE' ? '#123a8c' : label === 'TIX' ? '#c8102e' : label === 'ONE WAY' ? '#111' : '#0c6b3d';
    g.fillRect(x, y, 256, 64);
    g.strokeStyle = '#fff';
    g.lineWidth = 3;
    g.strokeRect(x + 4, y + 4, 248, 56);
    g.fillStyle = '#fff';
    g.font = `${special ? 800 : 700} 38px sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, x + 128, y + 34, 232);
    cells[label] = { u0: x / 2048, u1: (x + 256) / 2048, v0: 1 - (y + 64) / 1024, v1: 1 - y / 1024 };
  });
  return { texture: toTexture(c, { repeat: false }), cells };
}

export function glowTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  const c = makeCanvas(64, 64), g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return toTexture(c, { repeat: false, aniso: false });
}

export function smokeTexture() {
  const rng = new RNG(5);
  const c = makeCanvas(64, 64), g = c.getContext('2d');
  for (let i = 0; i < 26; i++) {
    const x = 32 + rng.range(-14, 14), y = 32 + rng.range(-14, 14), r = rng.range(8, 18);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.22)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }
  return toTexture(c, { repeat: false, aniso: false });
}

export function flashTexture() {
  const c = makeCanvas(64, 64), g = c.getContext('2d');
  g.translate(32, 32);
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, 30);
  grad.addColorStop(0, 'rgba(255,255,235,1)');
  grad.addColorStop(0.3, 'rgba(255,200,90,0.9)');
  grad.addColorStop(1, 'rgba(255,120,20,0)');
  g.fillStyle = grad;
  for (let i = 0; i < 6; i++) {
    g.rotate(Math.PI / 3);
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(-7, -14);
    g.lineTo(0, -31);
    g.lineTo(7, -14);
    g.fill();
  }
  g.beginPath();
  g.arc(0, 0, 11, 0, 7);
  g.fill();
  return toTexture(c, { repeat: false, aniso: false });
}

/** Weathered wood-plank crate texture set (256x256 albedo, normal, ORM) with plank gaps & nails. */
export function crateTextures() {
  const S = 256, rng = new RNG(612);
  const c = makeCanvas(S, S), g = c.getContext('2d');
  const hc = makeCanvas(S, S), gh = hc.getContext('2d');
  const oc = makeCanvas(S, S), go = oc.getContext('2d');
  g.fillStyle = '#a4875e'; g.fillRect(0, 0, S, S);
  gh.fillStyle = gray(148); gh.fillRect(0, 0, S, S);
  go.fillStyle = rgbRM(0.86, 0.0); go.fillRect(0, 0, S, S);
  const planks = 5, ph = S / planks;
  for (let i = 0; i < planks; i++) {
    const y0 = i * ph, tint = 0.88 + rng.next() * 0.24;
    g.fillStyle = `rgb(${Math.round(166 * tint)},${Math.round(134 * tint)},${Math.round(92 * tint)})`;
    g.fillRect(0, y0 + 2, S, ph - 4);
    for (let k = 0; k < 28; k++) {
      g.fillStyle = rng.chance(0.5) ? 'rgba(65,42,20,0.16)' : 'rgba(225,195,148,0.12)';
      const gy = y0 + 4 + rng.next() * (ph - 8);
      g.fillRect(0, gy, S, 1 + rng.next() * 2);
      gh.fillStyle = gray(132 + rng.next() * 34); gh.fillRect(0, gy, S, 1.5);
    }
    g.fillStyle = '#241a10'; g.fillRect(0, y0, S, 3);
    gh.fillStyle = gray(40); gh.fillRect(0, y0, S, 3);
  }
  // Outer bevel frame + diagonal cross-brace + corner nail rows
  g.strokeStyle = '#6f5534'; g.lineWidth = 22; g.strokeRect(11, 11, S - 22, S - 22);
  gh.strokeStyle = gray(215); gh.lineWidth = 22; gh.strokeRect(11, 11, S - 22, S - 22);
  g.strokeStyle = '#7e623d'; g.lineWidth = 18;
  g.beginPath(); g.moveTo(16, S - 16); g.lineTo(S - 16, 16); g.stroke();
  gh.strokeStyle = gray(196); gh.lineWidth = 18;
  g.beginPath(); gh.moveTo(16, S - 16); gh.lineTo(S - 16, 16); gh.stroke();
  g.fillStyle = '#2c2f36';
  for (let i = 0; i < planks; i++) {
    for (const nx of [12, S - 12]) {
      g.beginPath(); g.arc(nx, i * ph + ph * 0.5, 2.6, 0, Math.PI * 2); g.fill();
    }
  }
  const hd = gh.getImageData(0, 0, S, S).data, hf = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) hf[i] = hd[i * 4] / 255;
  return {
    map: toTexture(c, { repeat: false }),
    normalMap: toTexture(normalCanvas(hf, S, S, 2.8), { repeat: false, srgb: false }),
    orm: toTexture(oc, { repeat: false, srgb: false }),
  };
}

/** Corrugated shipping container PBR set (256x256) with vertical ribs, rust streaks & chipped paint. */
export function containerTextures() {
  const S = 256, rng = new RNG(914);
  const c = makeCanvas(S, S), g = c.getContext('2d');
  const hc = makeCanvas(S, S), gh = hc.getContext('2d');
  const oc = makeCanvas(S, S), go = oc.getContext('2d');
  g.fillStyle = '#c8ccd2'; g.fillRect(0, 0, S, S);
  gh.fillStyle = gray(128); gh.fillRect(0, 0, S, S);
  go.fillStyle = rgbRM(0.56, 0.35); go.fillRect(0, 0, S, S);
  const ribs = 14, rw = S / ribs;
  for (let i = 0; i < ribs; i++) {
    const x0 = i * rw;
    const gr = g.createLinearGradient(x0, 0, x0 + rw, 0);
    gr.addColorStop(0, '#90959c'); gr.addColorStop(0.28, '#e2e5ea');
    gr.addColorStop(0.68, '#d4d8de'); gr.addColorStop(1, '#7c8188');
    g.fillStyle = gr; g.fillRect(x0, 12, rw, S - 24);
    const hr = gh.createLinearGradient(x0, 0, x0 + rw, 0);
    hr.addColorStop(0, gray(70)); hr.addColorStop(0.3, gray(212));
    hr.addColorStop(0.7, gray(196)); hr.addColorStop(1, gray(64));
    gh.fillStyle = hr; gh.fillRect(x0, 12, rw, S - 24);
  }
  // Top & bottom structural header rails
  g.fillStyle = '#757b84'; g.fillRect(0, 0, S, 13); g.fillRect(0, S - 14, S, 14);
  gh.fillStyle = gray(232); gh.fillRect(0, 0, S, 13); gh.fillRect(0, S - 14, S, 14);
  // Subtle rust drips & chipped bare steel scuffs near bottom sill
  for (let i = 0; i < 36; i++) {
    const rx = rng.next() * S, ry = 10 + rng.next() * 40, len = 18 + rng.next() * 68;
    const dg = g.createLinearGradient(0, ry, 0, ry + len);
    dg.addColorStop(0, 'rgba(116,58,28,0.42)'); dg.addColorStop(1, 'rgba(116,58,28,0)');
    g.fillStyle = dg; g.fillRect(rx, ry, 1.5 + rng.next() * 3, len);
  }
  for (let i = 0; i < 42; i++) {
    g.fillStyle = rng.chance(0.5) ? 'rgba(92,48,26,0.38)' : 'rgba(165,172,180,0.35)';
    g.fillRect(rng.next() * S, S - 26 + rng.next() * 22, 4 + rng.next() * 14, 1.5 + rng.next() * 3);
    go.fillStyle = rgbRM(0.76, 0.2); go.fillRect(rng.next() * S, S - 26 + rng.next() * 22, 6, 2);
  }
  // Subtle ISO data stencil block
  g.fillStyle = 'rgba(240,242,245,0.52)';
  g.fillRect(S - 54, 24, 34, 5); g.fillRect(S - 54, 33, 24, 4);
  const hd = gh.getImageData(0, 0, S, S).data, hf = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) hf[i] = hd[i * 4] / 255;
  return {
    map: toTexture(c, { repeat: false }),
    normalMap: toTexture(normalCanvas(hf, S, S, 2.6), { repeat: false, srgb: false }),
    orm: toTexture(oc, { repeat: false, srgb: false }),
  };
}
