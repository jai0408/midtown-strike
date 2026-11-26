// Editorial & photographic procedural billboard artwork for Times Square.
// 100% fictional brands and shows — zero real trademarks or game assets.
// Produces 32 distinct creatives (8 landscape + 8 portrait static, 16 animated)
// plus a sharp amber/crimson LED news ticker strip.
import * as THREE from 'three';
import { RNG } from '../core/util.js';

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toTex(canvas, repeat = false) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const BRANDS = [
  ['MAISON VERO', 'new york · paris', '#ff4d8d', '#ff9e44'],
  ['CHRONO APEX', 'calibre 9040', '#2cc8ff', '#1b4bff'],
  ['ORBIT AUDIO', 'studio pro', '#ff3b6b', '#8e24ff'],
  ['KINETIC RUN', 'carbon series', '#1ee89a', '#00a896'],
  ['CASK & RYE', 'small batch', '#ffb838', '#d95b16'],
  ['NORDIC SKIN', 'pure botanical', '#42c6ff', '#0077e6'],
  ['MERIDIAN', 'private wealth', '#f5c451', '#1a3a6c'],
  ['SOLARIS', 'electric gt', '#ff7324', '#ff2d64'],
  ['VELO AIR', 'nonstop global', '#00d2ff', '#2e58ff'],
  ['RIVET & CO', 'selvedge denim', '#ff5238', '#ffb32c'],
  ['ASTOR ROAST', 'reserve blend', '#ff9f40', '#8c3312'],
  ['LUMINA', 'oled cinema', '#c855ff', '#2e8bff'],
];

const SHOWS = [
  ['THE GLASS HARBOR', 'NOW PLAYING · BROADWAY', '#ffe066', '#162b5c', 'ASTORIA THEATRE'],
  ['MIDNIGHT REVUE', 'NEW MUSICAL COMEDY', '#ff4d6d', '#5e1438', 'CRESCENT STAGE'],
  ['CITY OF SILENCE', 'LIMITED ENGAGEMENT', '#52d1ff', '#113462', 'MERIDIAN HALL'],
  ['ACT III: ENCORE', '8 STAGE AWARDS', '#ffd859', '#5a1e12', 'SAVOY BROADWAY'],
  ['NEON NOCTURNE', 'ORIGINAL DRAMA', '#36f5bd', '#0b4448', 'ASTORIA THEATRE'],
  ['WINTER ON 5TH', 'MATINEE & EVENING', '#ff9f45', '#4c1848', 'CRESCENT STAGE'],
];

export const AD_PALETTES = BRANDS.map((b) => [b[2], b[3]]);

function drawBokeh(g, x, y, w, h, rng, color, count = 8) {
  g.save();
  for (let i = 0; i < count; i++) {
    const bx = x + rng.next() * w;
    const by = y + rng.next() * h;
    const br = (0.05 + rng.next() * 0.16) * Math.min(w, h);
    const rg = g.createRadialGradient(bx, by, 0, bx, by, br);
    rg.addColorStop(0, color);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalAlpha = 0.18 + rng.next() * 0.24;
    g.fillStyle = rg;
    g.beginPath();
    g.arc(bx, by, br, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}

function drawEditorialAd(g, x, y, w, h, rng, idx) {
  const tall = h > w * 1.1;
  const style = idx % 7;
  const br = BRANDS[(idx * 5 + 1) % BRANDS.length];
  const sh = SHOWS[idx % SHOWS.length];
  const accent = br[2];
  const accent2 = br[3];

  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();

  if (style === 0) {
    // 1. Bright sunset/editorial fashion portrait against vivid photographic gradient wash
    const bg = g.createLinearGradient(x, y, x + w, y + h);
    bg.addColorStop(0, accent2);
    bg.addColorStop(0.55, accent);
    bg.addColorStop(1, '#ffd488');
    g.fillStyle = bg;
    g.fillRect(x, y, w, h);
    drawBokeh(g, x, y, w, h, rng, '#ffffff', 8);

    const cx = x + w * (tall ? 0.5 : 0.30);
    const cy = y + h * (tall ? 0.36 : 0.54);
    const sc = Math.min(w, h);
    g.fillStyle = 'rgba(20, 12, 22, 0.88)';
    g.beginPath();
    g.ellipse(cx, cy - sc * 0.15, sc * 0.13, sc * 0.17, 0, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.moveTo(cx - sc * 0.32, y + h);
    g.quadraticCurveTo(cx - sc * 0.24, cy + sc * 0.05, cx - sc * 0.07, cy - sc * 0.02);
    g.lineTo(cx + sc * 0.07, cy - sc * 0.02);
    g.quadraticCurveTo(cx + sc * 0.24, cy + sc * 0.05, cx + sc * 0.32, y + h);
    g.closePath();
    g.fill();
    g.strokeStyle = '#ffffff';
    g.lineWidth = Math.max(2, sc * 0.016);
    g.globalAlpha = 0.85;
    g.beginPath();
    g.arc(cx, cy - sc * 0.15, sc * 0.134, -2.3, -0.4);
    g.stroke();
    g.globalAlpha = 1;

    const tx = x + w * (tall ? 0.5 : 0.68);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.font = `800 ${Math.floor(Math.min(w * (tall ? 0.125 : 0.078), h * 0.16))}px Georgia, serif`;
    g.fillText(br[0], tx, y + h * (tall ? 0.74 : 0.44), w * (tall ? 0.86 : 0.52));
    g.fillStyle = '#16121a';
    g.font = `700 ${Math.floor(Math.min(w, h) * 0.058)}px sans-serif`;
    g.fillText(br[1].toUpperCase(), tx, y + h * (tall ? 0.84 : 0.60), w * 0.6);
  } else if (style === 1) {
    // 2. Pure white/ivory luxury fashion & skincare campaign with crisp vivid color block
    g.fillStyle = '#f8f6f1';
    g.fillRect(x, y, w, h);
    const barG = g.createLinearGradient(x, y, x + w, y + h);
    barG.addColorStop(0, accent);
    barG.addColorStop(1, accent2);
    g.fillStyle = barG;
    if (tall) g.fillRect(x + w * 0.08, y + h * 0.08, w * 0.84, h * 0.44);
    else g.fillRect(x + w * 0.05, y + h * 0.10, w * 0.42, h * 0.80);

    const cx = x + w * (tall ? 0.5 : 0.26);
    const cy = y + h * (tall ? 0.30 : 0.50);
    const sc = Math.min(w, h);
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(cx, cy, sc * 0.16, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#12151c';
    g.beginPath();
    g.arc(cx + sc * 0.05, cy, sc * 0.09, 0, Math.PI * 2);
    g.fill();

    const tx = x + w * (tall ? 0.5 : 0.73);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#12151c';
    g.font = `900 ${Math.floor(Math.min(w * (tall ? 0.12 : 0.08), h * 0.16))}px sans-serif`;
    g.fillText(br[0], tx, y + h * (tall ? 0.69 : 0.43), w * (tall ? 0.86 : 0.46));
    g.fillStyle = accent2;
    g.font = `700 ${Math.floor(Math.min(w, h) * 0.056)}px sans-serif`;
    g.fillText(br[1].toUpperCase(), tx, y + h * (tall ? 0.81 : 0.60), w * 0.46);
  } else if (style === 2) {
    // 3. Vibrant jewel-tone Broadway Musical / Stage Key Art (invented theatre name)
    const bg = g.createLinearGradient(x, y, x + w * 0.3, y + h);
    bg.addColorStop(0, sh[3]);
    bg.addColorStop(0.55, sh[2]);
    bg.addColorStop(1, '#1c1028');
    g.fillStyle = bg;
    g.fillRect(x, y, w, h);

    for (const bx of [0.22, 0.78]) {
      const sg = g.createLinearGradient(x + w * bx, y, x + w * 0.5, y + h * 0.85);
      sg.addColorStop(0, 'rgba(255,244,196,0.42)');
      sg.addColorStop(1, 'rgba(255,244,196,0)');
      g.fillStyle = sg;
      g.beginPath();
      g.moveTo(x + w * bx, y);
      g.lineTo(x + w * (bx + 0.10), y);
      g.lineTo(x + w * 0.72, y + h);
      g.lineTo(x + w * 0.28, y + h);
      g.closePath();
      g.fill();
    }

    g.fillStyle = 'rgba(10,8,18,0.68)';
    for (let k = 0; k < 14; k++) {
      const bw = w / 14;
      const bh = (0.07 + rng.next() * 0.12) * h;
      g.fillRect(x + k * bw, y + h - bh, bw + 1, bh);
    }

    const pad = Math.min(w, h) * 0.05;
    g.strokeStyle = '#fff5d6';
    g.lineWidth = Math.max(2, Math.min(w, h) * 0.015);
    g.strokeRect(x + pad, y + pad, w - pad * 2, h - pad * 2);

    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#fff3c4';
    g.font = `700 ${Math.floor(Math.min(w, h) * 0.052)}px sans-serif`;
    g.fillText(sh[1], x + w * 0.5, y + h * 0.21, w * 0.82);

    const words = sh[0].split(' ');
    const fs = Math.floor(Math.min(w * 0.135, h * 0.16));
    g.fillStyle = '#ffffff';
    g.font = `900 ${fs}px Georgia, serif`;
    const lines = tall ? words : [words.slice(0, 2).join(' '), words.slice(2).join(' ')].filter(Boolean);
    lines.forEach((ln, li) => g.fillText(ln, x + w * 0.5, y + h * 0.48 + (li - (lines.length - 1) * 0.5) * fs * 1.12, w * 0.84));

    g.fillStyle = '#ffe58f';
    g.font = `700 ${Math.floor(Math.min(w, h) * 0.05)}px sans-serif`;
    g.fillText(`★ ★ ★ ★ ★   ${sh[4]}`, x + w * 0.5, y + h * 0.81, w * 0.80);
  } else if (style === 3) {
    // 4. High-luminance Cinema / Streaming Key Art (bright sky + warm golden sunset + clear skyband)
    const sky = g.createLinearGradient(x, y, x, y + h);
    sky.addColorStop(0, '#1e6fd9');
    sky.addColorStop(0.50, '#58b4ff');
    sky.addColorStop(0.80, '#ffb454');
    sky.addColorStop(1, '#261428');
    g.fillStyle = sky;
    g.fillRect(x, y, w, h);

    const fl = g.createLinearGradient(x, y + h * 0.58, x + w, y + h * 0.58);
    fl.addColorStop(0, 'rgba(255,255,255,0)');
    fl.addColorStop(0.5, 'rgba(255,250,220,0.65)');
    fl.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = fl;
    g.fillRect(x, y + h * 0.56, w, Math.max(3, h * 0.032));

    g.fillStyle = '#12101a';
    g.fillRect(x, y + h * 0.78, w, h * 0.22);
    const fx = x + w * 0.24;
    g.beginPath();
    g.arc(fx, y + h * 0.58, Math.min(w, h) * 0.055, 0, Math.PI * 2);
    g.fill();
    g.fillRect(fx - Math.min(w, h) * 0.045, y + h * 0.63, Math.min(w, h) * 0.09, h * 0.18);

    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.font = `900 ${Math.floor(Math.min(w * 0.12, h * 0.16))}px sans-serif`;
    g.fillText(sh[0], x + w * 0.56, y + h * 0.36, w * 0.80);
    g.fillStyle = '#ffe9b8';
    g.font = `700 ${Math.floor(Math.min(w, h) * 0.05)}px sans-serif`;
    g.fillText('AN ORIGINAL FEATURE  ·  STREAMING FRIDAY', x + w * 0.56, y + h * 0.89, w * 0.84);
  } else if (style === 4) {
    // 5. Saturated full-bleed Studio Product Bottle Shot on vibrant backlit gradient
    const bg = g.createRadialGradient(x + w * 0.32, y + h * 0.48, 6, x + w * 0.45, y + h * 0.5, Math.max(w, h) * 0.82);
    bg.addColorStop(0, '#ffe396');
    bg.addColorStop(0.45, accent);
    bg.addColorStop(1, accent2);
    g.fillStyle = bg;
    g.fillRect(x, y, w, h);
    drawBokeh(g, x, y, w, h, rng, '#ffffff', 9);

    const cx = x + w * (tall ? 0.5 : 0.28);
    const cy = y + h * (tall ? 0.38 : 0.52);
    const bh = Math.min(w, h) * 0.64;
    const bw = bh * 0.34;

    const bgGlass = g.createLinearGradient(cx - bw * 0.5, cy, cx + bw * 0.5, cy);
    bgGlass.addColorStop(0, '#1e1008');
    bgGlass.addColorStop(0.32, '#c87228');
    bgGlass.addColorStop(0.62, '#5a280e');
    bgGlass.addColorStop(0.88, '#ffd082');
    bgGlass.addColorStop(1, '#1c0f06');
    g.fillStyle = bgGlass;
    g.beginPath();
    g.moveTo(cx - bw * 0.16, cy - bh * 0.48);
    g.lineTo(cx + bw * 0.16, cy - bh * 0.48);
    g.lineTo(cx + bw * 0.18, cy - bh * 0.30);
    g.bezierCurveTo(cx + bw * 0.46, cy - bh * 0.22, cx + bw * 0.50, cy - bh * 0.08, cx + bw * 0.50, cy + bh * 0.44);
    g.lineTo(cx - bw * 0.50, cy + bh * 0.44);
    g.bezierCurveTo(cx - bw * 0.50, cy - bh * 0.08, cx - bw * 0.46, cy - bh * 0.22, cx - bw * 0.18, cy - bh * 0.30);
    g.closePath();
    g.fill();
    g.fillStyle = '#e6b85c';
    g.fillRect(cx - bw * 0.17, cy - bh * 0.48, bw * 0.34, bh * 0.12);
    g.fillStyle = 'rgba(255,250,235,0.58)';
    g.fillRect(cx - bw * 0.34, cy - bh * 0.12, Math.max(2, bw * 0.09), bh * 0.50);
    g.fillStyle = '#fff9ee';
    g.fillRect(cx - bw * 0.44, cy - bh * 0.02, bw * 0.88, bh * 0.24);

    const tx = x + w * (tall ? 0.5 : 0.67);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.font = `900 ${Math.floor(Math.min(w * (tall ? 0.12 : 0.078), h * 0.15))}px Georgia, serif`;
    g.fillText(br[0], tx, y + h * (tall ? 0.76 : 0.42), w * (tall ? 0.85 : 0.54));
    g.fillStyle = '#151218';
    g.font = `700 ${Math.floor(Math.min(w, h) * 0.054)}px sans-serif`;
    g.fillText(br[1].toUpperCase(), tx, y + h * (tall ? 0.86 : 0.58), w * 0.56);
  } else if (style === 5) {
    // 6. Radiant Animated LED Motion Wall (electric color sweep + dynamic neon ribbons)
    const bg = g.createLinearGradient(x, y, x + w, y + h);
    bg.addColorStop(0, accent2);
    bg.addColorStop(0.5, accent);
    bg.addColorStop(1, '#fff07c');
    g.fillStyle = bg;
    g.fillRect(x, y, w, h);
    for (let s = 0; s < 7; s++) {
      const sy = y + h * (0.16 + s * 0.12);
      g.globalAlpha = s % 2 ? 0.42 : 0.24;
      g.strokeStyle = s % 2 ? '#ffffff' : '#101422';
      g.lineWidth = Math.max(3, Math.min(w, h) * (s % 2 ? 0.036 : 0.016));
      g.beginPath();
      g.moveTo(x - w * 0.1, sy + h * 0.16);
      g.lineTo(x + w * 1.1, sy - h * 0.28);
      g.stroke();
    }
    g.globalAlpha = 1;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.font = `900 italic ${Math.floor(Math.min(w * 0.12, h * 0.20))}px sans-serif`;
    g.fillText(br[0], x + w * 0.08, y + h * 0.42, w * 0.84);
    g.fillStyle = '#11141e';
    g.font = `800 ${Math.floor(Math.min(w, h) * 0.072)}px sans-serif`;
    g.fillText(`${br[1].toUpperCase()}  //  ZERO LIMITS`, x + w * 0.08, y + h * 0.65, w * 0.84);
  } else {
    // 7. Crisp Dark Luxury Watch Macro (kept at ~14% frequency for contrast punch)
    const bg = g.createLinearGradient(x, y, x, y + h);
    bg.addColorStop(0, '#09111e');
    bg.addColorStop(0.68, '#142236');
    bg.addColorStop(1, '#060a10');
    g.fillStyle = bg;
    g.fillRect(x, y, w, h);

    const cx = x + w * (tall ? 0.5 : 0.28);
    const cy = y + h * (tall ? 0.36 : 0.50);
    const rad = Math.min(w, h) * (tall ? 0.24 : 0.30);
    g.fillStyle = '#202630';
    g.fillRect(cx - rad * 0.48, cy - rad * 1.45, rad * 0.96, rad * 2.9);
    const bezel = g.createLinearGradient(cx - rad, cy - rad, cx + rad, cy + rad);
    bezel.addColorStop(0, '#dbe2eb');
    bezel.addColorStop(0.5, '#596370');
    bezel.addColorStop(1, '#e6edf5');
    g.fillStyle = bezel;
    g.beginPath();
    g.arc(cx, cy, rad, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#09101c';
    g.beginPath();
    g.arc(cx, cy, rad * 0.84, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = accent;
    g.lineWidth = Math.max(1.5, rad * 0.06);
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * rad * 0.66, cy + Math.sin(a) * rad * 0.66);
      g.lineTo(cx + Math.cos(a) * rad * 0.80, cy + Math.sin(a) * rad * 0.80);
      g.stroke();
    }
    g.strokeStyle = '#ffffff';
    g.lineWidth = Math.max(1.8, rad * 0.07);
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + rad * 0.44, cy - rad * 0.34);
    g.moveTo(cx, cy);
    g.lineTo(cx - rad * 0.25, cy - rad * 0.56);
    g.stroke();

    const tx = x + w * (tall ? 0.5 : 0.68);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.font = `800 ${Math.floor(Math.min(w * (tall ? 0.12 : 0.078), h * 0.15))}px sans-serif`;
    g.fillText(br[0], tx, y + h * (tall ? 0.75 : 0.43), w * (tall ? 0.86 : 0.54));
    g.fillStyle = accent;
    g.font = `600 ${Math.floor(Math.min(w, h) * 0.056)}px sans-serif`;
    g.fillText(br[1].toUpperCase(), tx, y + h * (tall ? 0.85 : 0.59), w * 0.56);
  }

  // Subtle LED cabinet module gridlines + edge vignette
  g.globalAlpha = 0.12;
  g.fillStyle = '#000';
  for (let i = 1; i < 6; i++) g.fillRect(x + (w * i) / 6, y, 1, h);
  for (let i = 1; i < 4; i++) g.fillRect(x, y + (h * i) / 4, w, 1);
  g.globalAlpha = 1;
  g.strokeStyle = 'rgba(0,0,0,0.45)';
  g.lineWidth = 4;
  g.strokeRect(x + 1, y + 1, w - 2, h - 2);
  g.restore();
}

export const AD_LAND = [], AD_PORT = [];
for (let i = 0; i < 8; i++) {
  const b = BRANDS[(i * 5 + 1) % BRANDS.length];
  AD_LAND.push({ u0: (i % 4) / 4, v0: 1 - (Math.floor(i / 4) + 1) / 4, u1: (i % 4 + 1) / 4, v1: 1 - Math.floor(i / 4) / 4, color: b[2] });
  const pb = BRANDS[((i + 8) * 5 + 1) % BRANDS.length];
  AD_PORT.push({ u0: i / 8, v0: 0, u1: (i + 1) / 8, v1: 0.5, color: pb[2] });
}

export function adsTexture() {
  const rng = new RNG(77);
  const c = makeCanvas(2048, 1024), g = c.getContext('2d');
  for (let i = 0; i < 8; i++) drawEditorialAd(g, (i % 4) * 512, Math.floor(i / 4) * 256, 512, 256, rng, i);
  for (let i = 0; i < 8; i++) drawEditorialAd(g, i * 256, 512, 256, 512, rng, i + 8);
  return toTex(c, false);
}

export function adsAnimTexture() {
  const rng = new RNG(99);
  const c = makeCanvas(1024, 1024), g = c.getContext('2d');
  for (let i = 0; i < 16; i++) drawEditorialAd(g, (i % 4) * 256, Math.floor(i / 4) * 256, 256, 256, rng, i + 16);
  return toTex(c, true);
}

export function tickerTexture() {
  const c = makeCanvas(2048, 64), g = c.getContext('2d');
  g.fillStyle = '#070504';
  g.fillRect(0, 0, 2048, 64);
  g.fillStyle = '#ff2828';
  g.fillRect(0, 4, 2048, 3);
  g.fillRect(0, 57, 2048, 3);
  g.fillStyle = '#ffb82e';
  g.font = '700 34px monospace';
  g.textBaseline = 'middle';
  g.fillText('● TIMES SQ ADVISORY: PERIMETER SECURE ● BROADWAY CORRIDOR RESTRICTED ● TRANSIT RUNNING ON EXPRESS TRACKS ●', 8, 34, 2032);
  g.fillStyle = 'rgba(0,0,0,0.38)';
  for (let x = 0; x < 2048; x += 4) g.fillRect(x, 0, 1, 64);
  for (let y = 0; y < 64; y += 4) g.fillRect(0, y, 2048, 1);
  return toTex(c, true);
}
