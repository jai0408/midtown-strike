// Editorial & photographic procedural billboard artwork for Times Square.
// 100% fictional brands and shows — zero real trademarks or game assets.
// Produces 48 distinct creatives (16 landscape + 16 portrait static, 16 animated)
// across 14 graphic archetypes so no creative repeats >2x in any view.
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
  ['KAIRO FIT', 'altitude 04', '#ff4057', '#ffbe30'],
  ['NORTHSTAR', 'alpine shell', '#38e4ff', '#10548c'],
  ['VANDEN', 'modern home', '#f79256', '#7a3b69'],
  ['SONIC BLVD', 'live tour 26', '#ffe44d', '#d91e85'],
];

const SHOWS = [
  ['THE GLASS HARBOR', 'NOW PLAYING · BROADWAY', '#ffe066', '#162b5c', 'ASTORIA THEATRE'],
  ['MIDNIGHT REVUE', 'NEW MUSICAL COMEDY', '#ff4d6d', '#5e1438', 'CRESCENT STAGE'],
  ['CITY OF SILENCE', 'LIMITED ENGAGEMENT', '#52d1ff', '#113462', 'MERIDIAN HALL'],
  ['ACT III: ENCORE', '8 STAGE AWARDS', '#ffd859', '#5a1e12', 'SAVOY BROADWAY'],
  ['NEON NOCTURNE', 'ORIGINAL DRAMA', '#36f5bd', '#0b4448', 'ASTORIA THEATRE'],
  ['WINTER ON 5TH', 'MATINEE & EVENING', '#ff9f45', '#4c1848', 'CRESCENT STAGE'],
];

// Schedule of distinct visual styles across 48 slots (portrait silhouette & watch limited to <= 2 static slots)
const STYLE_MAP = [
  7, 8, 9, 10, 11, 12, 13, 1,   // 0..7 land row 0
  2, 3, 4, 5, 0, 6, 8, 10,      // 8..15 land row 1
  11, 1, 12, 7, 3, 13, 9, 4,    // 16..23 port row 2
  2, 5, 8, 10, 0, 6, 7, 12,     // 24..31 port row 3
  5, 7, 9, 11, 13, 1, 3, 8,     // 32..39 anim
  10, 12, 2, 4, 5, 7, 9, 11,    // 40..47 anim
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
  const style = STYLE_MAP[idx % STYLE_MAP.length];
  const br = BRANDS[idx % BRANDS.length];
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
  } else if (style === 6) {
    // 7. Crisp Dark Luxury Watch Macro (capped <= 2 slots)
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
  } else if (style === 7) {
    // 8. Swiss Bold Typography Campaign (crisp yellow/red/cobalt poster)
    g.fillStyle = accent; g.fillRect(x, y, w, h);
    g.fillStyle = '#111319';
    g.fillRect(x + w * 0.05, y + h * 0.07, w * 0.90, h * 0.04);
    g.fillRect(x + w * 0.05, y + h * 0.89, w * 0.90, h * 0.04);
    g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.font = `900 ${Math.floor(Math.min(w * 0.14, h * 0.22))}px sans-serif`;
    g.fillText(br[0], x + w * 0.06, y + h * 0.38, w * 0.88);
    g.fillStyle = '#111319';
    g.font = `800 ${Math.floor(Math.min(w, h) * 0.08)}px sans-serif`;
    g.fillText(br[1].toUpperCase(), x + w * 0.06, y + h * 0.64, w * 0.88);
  } else if (style === 8) {
    // 9. Athletic Diagonal Stripes & Sneaker/Motion Graphic
    const bg = g.createLinearGradient(x, y, x + w, y + h);
    bg.addColorStop(0, '#0c1b33'); bg.addColorStop(1, accent2);
    g.fillStyle = bg; g.fillRect(x, y, w, h);
    g.fillStyle = accent;
    for (let k = 0; k < 4; k++) {
      g.beginPath();
      const ox = x + w * (0.06 + k * 0.18);
      g.moveTo(ox, y + h); g.lineTo(ox + w * 0.10, y + h);
      g.lineTo(ox + w * 0.34, y); g.lineTo(ox + w * 0.24, y);
      g.closePath(); g.fill();
    }
    g.fillStyle = 'rgba(10,14,22,0.72)';
    g.fillRect(x + w * 0.06, y + h * 0.28, w * 0.88, h * 0.44);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.font = `900 italic ${Math.floor(Math.min(w * 0.13, h * 0.20))}px sans-serif`;
    g.fillText(br[0], x + w * 0.5, y + h * 0.44, w * 0.80);
    g.fillStyle = '#ffe45e';
    g.font = `700 ${Math.floor(Math.min(w, h) * 0.06)}px sans-serif`;
    g.fillText('NEXT GEN  //  2026', x + w * 0.5, y + h * 0.63, w * 0.78);
  } else if (style === 9) {
    // 10. Clean Architectural Skyline & Travel Card
    const bg = g.createLinearGradient(x, y, x, y + h);
    bg.addColorStop(0, '#ff8e53'); bg.addColorStop(0.55, '#fe6b8b'); bg.addColorStop(1, '#261d42');
    g.fillStyle = bg; g.fillRect(x, y, w, h);
    g.fillStyle = '#ffe8a3';
    g.beginPath(); g.arc(x + w * 0.72, y + h * 0.32, Math.min(w, h) * 0.16, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#18142c';
    for (let k = 0; k < 9; k++) {
      const bw = w / 9, bh = h * (0.18 + ((k * 37) % 10) * 0.028);
      g.fillRect(x + k * bw, y + h - bh, bw + 1, bh);
    }
    g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.font = `900 ${Math.floor(Math.min(w * 0.12, h * 0.18))}px sans-serif`;
    g.fillText(br[0], x + w * 0.08, y + h * 0.28, w * 0.56);
    g.font = `700 ${Math.floor(Math.min(w, h) * 0.06)}px sans-serif`;
    g.fillText(br[1].toUpperCase(), x + w * 0.08, y + h * 0.44, w * 0.54);
  } else if (style === 10) {
    // 11. Duotone Split-Screen Editorial
    g.fillStyle = '#ffffff'; g.fillRect(x, y, w, h);
    g.fillStyle = accent;
    if (tall) g.fillRect(x, y, w, h * 0.52); else g.fillRect(x, y, w * 0.5, h);
    g.fillStyle = accent2;
    g.beginPath();
    g.arc(x + w * (tall ? 0.5 : 0.25), y + h * (tall ? 0.26 : 0.5), Math.min(w, h) * 0.18, 0, Math.PI * 2);
    g.fill();
    const tx = x + w * (tall ? 0.5 : 0.75);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#14171f';
    g.font = `900 ${Math.floor(Math.min(w * (tall ? 0.12 : 0.08), h * 0.16))}px Georgia, serif`;
    g.fillText(br[0], tx, y + h * (tall ? 0.70 : 0.42), w * (tall ? 0.86 : 0.44));
    g.fillStyle = accent;
    g.font = `700 ${Math.floor(Math.min(w, h) * 0.056)}px sans-serif`;
    g.fillText(br[1].toUpperCase(), tx, y + h * (tall ? 0.84 : 0.60), w * 0.44);
  } else if (style === 11) {
    // 12. Warm Coffee / Spirits / Culinary Hero Card
    const bg = g.createRadialGradient(x + w * 0.5, y + h * 0.5, 4, x + w * 0.5, y + h * 0.5, Math.max(w, h) * 0.7);
    bg.addColorStop(0, '#ffcb6b'); bg.addColorStop(0.55, '#d96b27'); bg.addColorStop(1, '#4a1808');
    g.fillStyle = bg; g.fillRect(x, y, w, h);
    g.strokeStyle = 'rgba(255,244,214,0.42)'; g.lineWidth = 3;
    g.strokeRect(x + w * 0.06, y + h * 0.08, w * 0.88, h * 0.84);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#fff9ec';
    g.font = `800 ${Math.floor(Math.min(w * 0.125, h * 0.18))}px Georgia, serif`;
    g.fillText(br[0], x + w * 0.5, y + h * 0.42, w * 0.80);
    g.fillStyle = '#240b04';
    g.fillRect(x + w * 0.18, y + h * 0.56, w * 0.64, h * 0.14);
    g.fillStyle = '#ffe29a';
    g.font = `700 ${Math.floor(Math.min(w, h) * 0.055)}px sans-serif`;
    g.fillText(br[1].toUpperCase(), x + w * 0.5, y + h * 0.63, w * 0.60);
  } else if (style === 12) {
    // 13. Minimalist Hardware Grid & Glow Badge
    g.fillStyle = '#141923'; g.fillRect(x, y, w, h);
    g.strokeStyle = 'rgba(140,210,255,0.16)'; g.lineWidth = 1;
    for (let i = 1; i < 8; i++) {
      g.beginPath(); g.moveTo(x + (w * i) / 8, y); g.lineTo(x + (w * i) / 8, y + h); g.stroke();
      g.beginPath(); g.moveTo(x, y + (h * i) / 8); g.lineTo(x + w, y + (h * i) / 8); g.stroke();
    }
    const gr = g.createLinearGradient(x, y, x + w, y + h);
    gr.addColorStop(0, accent); gr.addColorStop(1, accent2);
    g.fillStyle = gr;
    g.fillRect(x + w * 0.08, y + h * 0.14, w * 0.84, h * 0.14);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.font = `900 ${Math.floor(Math.min(w * 0.125, h * 0.19))}px sans-serif`;
    g.fillText(br[0], x + w * 0.5, y + h * 0.52, w * 0.84);
    g.fillStyle = accent;
    g.font = `700 ${Math.floor(Math.min(w, h) * 0.06)}px monospace`;
    g.fillText(`SERIES // ${br[1].toUpperCase()}`, x + w * 0.5, y + h * 0.74, w * 0.80);
  } else {
    // 14. Neon Concert / Nightlife Colorwave
    const bg = g.createLinearGradient(x, y, x + w, y);
    bg.addColorStop(0, '#4a00e0'); bg.addColorStop(0.5, accent); bg.addColorStop(1, '#00c6ff');
    g.fillStyle = bg; g.fillRect(x, y, w, h);
    g.fillStyle = '#ffffff';
    for (let r = 0; r < 5; r++) {
      g.globalAlpha = 0.18 + r * 0.08;
      g.beginPath(); g.arc(x + w * 0.5, y + h * 0.5, Math.min(w, h) * (0.45 - r * 0.07), 0, Math.PI * 2); g.stroke();
    }
    g.globalAlpha = 1;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.font = `900 ${Math.floor(Math.min(w * 0.13, h * 0.20))}px sans-serif`;
    g.fillText(br[0], x + w * 0.5, y + h * 0.42, w * 0.84);
    g.fillStyle = '#fff59d';
    g.font = `800 ${Math.floor(Math.min(w, h) * 0.065)}px sans-serif`;
    g.fillText(br[1].toUpperCase(), x + w * 0.5, y + h * 0.64, w * 0.82);
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
for (let i = 0; i < 16; i++) {
  const b = BRANDS[i % BRANDS.length];
  AD_LAND.push({ u0: (i % 4) / 4, v0: 1 - (Math.floor(i / 4) + 1) / 8, u1: (i % 4 + 1) / 4, v1: 1 - Math.floor(i / 4) / 8, color: b[2] });
  const pb = BRANDS[(i + 8) % BRANDS.length];
  AD_PORT.push({ u0: (i % 8) / 8, v0: (1 - Math.floor(i / 8)) * 0.25, u1: (i % 8 + 1) / 8, v1: (2 - Math.floor(i / 8)) * 0.25, color: pb[2] });
}

export function adsTexture() {
  const rng = new RNG(77);
  const c = makeCanvas(2048, 2048), g = c.getContext('2d');
  for (let i = 0; i < 16; i++) drawEditorialAd(g, (i % 4) * 512, Math.floor(i / 4) * 256, 512, 256, rng, i);
  for (let i = 0; i < 16; i++) drawEditorialAd(g, (i % 8) * 256, 1024 + Math.floor(i / 8) * 512, 256, 512, rng, i + 16);
  return toTex(c, false);
}

export function adsAnimTexture() {
  const rng = new RNG(99);
  const c = makeCanvas(1024, 1024), g = c.getContext('2d');
  for (let i = 0; i < 16; i++) drawEditorialAd(g, (i % 4) * 256, Math.floor(i / 4) * 256, 256, 256, rng, i + 32);
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
