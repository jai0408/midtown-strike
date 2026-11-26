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
  ['MAISON VERO', 'new york · paris', '#e6b87d', '#140c12'],
  ['CHRONO APEX', 'calibre 9040', '#58c4ff', '#0b1018'],
  ['ORBIT AUDIO', 'studio pro', '#ff4d6d', '#120b14'],
  ['KINETIC RUN', 'carbon series', '#4dffb8', '#091210'],
  ['CASK & RYE', 'small batch', '#f0a848', '#160d08'],
  ['NORDIC SKIN', 'pure botanical', '#a6d8ff', '#0c151c'],
  ['MERIDIAN', 'private wealth', '#d8c28a', '#10141c'],
  ['SOLARIS', 'electric gt', '#ff7a33', '#120e12'],
  ['VELO AIR', 'nonstop global', '#66d9ff', '#091422'],
  ['RIVET & CO', 'selvedge denim', '#e85d3f', '#141110'],
  ['ASTOR ROAST', 'reserve blend', '#d99a52', '#17100a'],
  ['LUMINA', 'oled cinema', '#c466ff', '#0e0918'],
];

const SHOWS = [
  ['THE GLASS HARBOR', 'NOW PLAYING · BROADWAY', '#e8b954', '#0b1222'],
  ['MIDNIGHT REVUE', 'NEW MUSICAL COMEDY', '#ff3b5c', '#180912'],
  ['CITY OF SILENCE', 'LIMITED ENGAGEMENT', '#7ac4ff', '#09111d'],
  ['ACT III: ENCORE', '8 TONY NOMINATIONS', '#f2cf72', '#170e0b'],
  ['NEON NOCTURNE', 'ORIGINAL DRAMA', '#42e3b5', '#081716'],
  ['WINTER ON 5TH', 'MATINEE & EVENING', '#ff8c42', '#140d16'],
];

export const AD_PALETTES = BRANDS.map((b) => [b[2], b[3]]);

function drawBokeh(g, x, y, w, h, rng, color, count = 8) {
  g.save();
  for (let i = 0; i < count; i++) {
    const bx = x + rng.next() * w;
    const by = y + rng.next() * h;
    const br = (0.04 + rng.next() * 0.14) * Math.min(w, h);
    const rg = g.createRadialGradient(bx, by, 0, bx, by, br);
    rg.addColorStop(0, color);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalAlpha = 0.08 + rng.next() * 0.16;
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
  const darkBg = br[3];

  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();

  if (style === 0) {
    // 1. Luxury fashion / fragrance studio portrait silhouette + rim light
    const bg = g.createRadialGradient(x + w * 0.38, y + h * 0.42, 4, x + w * 0.45, y + h * 0.5, Math.max(w, h) * 0.85);
    bg.addColorStop(0, '#362129');
    bg.addColorStop(0.55, darkBg);
    bg.addColorStop(1, '#040406');
    g.fillStyle = bg;
    g.fillRect(x, y, w, h);
    drawBokeh(g, x, y, w, h, rng, accent, 10);

    // Rim-lit model silhouette (head, neck, coat shoulder)
    const cx = x + w * (tall ? 0.5 : 0.30);
    const cy = y + h * (tall ? 0.36 : 0.54);
    const sc = Math.min(w, h);
    g.fillStyle = '#09070a';
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
    g.strokeStyle = accent;
    g.lineWidth = Math.max(1.5, sc * 0.014);
    g.globalAlpha = 0.72;
    g.beginPath();
    g.arc(cx, cy - sc * 0.15, sc * 0.132, -2.3, -0.4);
    g.stroke();
    g.globalAlpha = 1;

    // Editorial serif typography
    const tx = x + w * (tall ? 0.5 : 0.68);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#f5efe6';
    g.font = `700 ${Math.floor(Math.min(w * (tall ? 0.12 : 0.075), h * 0.15))}px Georgia, serif`;
    g.fillText(br[0], tx, y + h * (tall ? 0.74 : 0.44), w * (tall ? 0.86 : 0.52));
    g.fillStyle = accent;
    g.font = `600 ${Math.floor(Math.min(w, h) * 0.055)}px sans-serif`;
    g.fillText(br[1].toUpperCase(), tx, y + h * (tall ? 0.84 : 0.60), w * 0.6);
  } else if (style === 1) {
    // 2. Luxury watch / precision hardware macro on dark reflective plinth
    const bg = g.createLinearGradient(x, y, x, y + h);
    bg.addColorStop(0, '#070b12');
    bg.addColorStop(0.68, '#101824');
    bg.addColorStop(1, '#04060a');
    g.fillStyle = bg;
    g.fillRect(x, y, w, h);

    // Subtle studio horizon floor reflection
    g.fillStyle = 'rgba(130, 185, 255, 0.08)';
    g.fillRect(x, y + h * 0.72, w, h * 0.28);

    const cx = x + w * (tall ? 0.5 : 0.28);
    const cy = y + h * (tall ? 0.36 : 0.50);
    const rad = Math.min(w, h) * (tall ? 0.24 : 0.30);

    // Strap + steel case + dial
    g.fillStyle = '#1c2128';
    g.fillRect(cx - rad * 0.48, cy - rad * 1.45, rad * 0.96, rad * 2.9);
    const bezel = g.createLinearGradient(cx - rad, cy - rad, cx + rad, cy + rad);
    bezel.addColorStop(0, '#cfd6df');
    bezel.addColorStop(0.5, '#525b66');
    bezel.addColorStop(1, '#dce3ec');
    g.fillStyle = bezel;
    g.beginPath();
    g.arc(cx, cy, rad, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#090d14';
    g.beginPath();
    g.arc(cx, cy, rad * 0.84, 0, Math.PI * 2);
    g.fill();

    // Dial indices & hands
    g.strokeStyle = accent;
    g.lineWidth = Math.max(1.2, rad * 0.05);
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * rad * 0.66, cy + Math.sin(a) * rad * 0.66);
      g.lineTo(cx + Math.cos(a) * rad * 0.79, cy + Math.sin(a) * rad * 0.79);
      g.stroke();
    }
    g.strokeStyle = '#ffffff';
    g.lineWidth = Math.max(1.5, rad * 0.06);
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + rad * 0.44, cy - rad * 0.34);
    g.moveTo(cx, cy);
    g.lineTo(cx - rad * 0.25, cy - rad * 0.56);
    g.stroke();

    const tx = x + w * (tall ? 0.5 : 0.68);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#eef4ff';
    g.font = `700 ${Math.floor(Math.min(w * (tall ? 0.12 : 0.075), h * 0.14))}px sans-serif`;
    g.fillText(br[0], tx, y + h * (tall ? 0.75 : 0.43), w * (tall ? 0.86 : 0.54));
    g.fillStyle = accent;
    g.font = `500 ${Math.floor(Math.min(w, h) * 0.052)}px sans-serif`;
    g.fillText(br[1].toUpperCase(), tx, y + h * (tall ? 0.85 : 0.59), w * 0.56);
  } else if (style === 2) {
    // 3. Broadway Playbill / Stage Musical Key Art
    const bg = g.createLinearGradient(x, y, x, y + h);
    bg.addColorStop(0, sh[3]);
    bg.addColorStop(0.65, '#190b16');
    bg.addColorStop(1, '#07060a');
    g.fillStyle = bg;
    g.fillRect(x, y, w, h);

    // Diagonal stage spotlight beams
    for (const bx of [0.22, 0.78]) {
      const sg = g.createLinearGradient(x + w * bx, y, x + w * 0.5, y + h * 0.85);
      sg.addColorStop(0, 'rgba(255,220,150,0.22)');
      sg.addColorStop(1, 'rgba(255,220,150,0)');
      g.fillStyle = sg;
      g.beginPath();
      g.moveTo(x + w * bx, y);
      g.lineTo(x + w * (bx + 0.08), y);
      g.lineTo(x + w * 0.68, y + h);
      g.lineTo(x + w * 0.32, y + h);
      g.closePath();
      g.fill();
    }

    // Skyline silhouette along bottom
    g.fillStyle = '#050508';
    for (let k = 0; k < 14; k++) {
      const bw = w / 14;
      const bh = (0.08 + rng.next() * 0.14) * h;
      g.fillRect(x + k * bw, y + h - bh, bw + 1, bh);
    }

    // Fine gold art-deco border
    const pad = Math.min(w, h) * 0.055;
    g.strokeStyle = sh[2];
    g.lineWidth = Math.max(1.5, Math.min(w, h) * 0.012);
    g.strokeRect(x + pad, y + pad, w - pad * 2, h - pad * 2);

    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = sh[2];
    g.font = `600 ${Math.floor(Math.min(w, h) * 0.05)}px sans-serif`;
    g.fillText(sh[1], x + w * 0.5, y + h * 0.22, w * 0.82);

    const words = sh[0].split(' ');
    const fs = Math.floor(Math.min(w * 0.13, h * 0.15));
    g.fillStyle = '#fff9ee';
    g.font = `900 ${fs}px Georgia, serif`;
    const lines = tall ? words : [words.slice(0, 2).join(' '), words.slice(2).join(' ')].filter(Boolean);
    lines.forEach((ln, li) => g.fillText(ln, x + w * 0.5, y + h * 0.48 + (li - (lines.length - 1) * 0.5) * fs * 1.12, w * 0.82));

    g.fillStyle = sh[2];
    g.font = `700 ${Math.floor(Math.min(w, h) * 0.048)}px sans-serif`;
    g.fillText('★ ★ ★ ★ ★   WINTER GARDEN', x + w * 0.5, y + h * 0.80, w * 0.78);
  } else if (style === 3) {
    // 4. Cinematic Film / Streaming Key Art (teal-amber horizon + dramatic silhouette)
    const sky = g.createLinearGradient(x, y, x, y + h);
    sky.addColorStop(0, '#0a1426');
    sky.addColorStop(0.55, '#1d3c5e');
    sky.addColorStop(0.84, '#d96b38');
    sky.addColorStop(1, '#120c0e');
    g.fillStyle = sky;
    g.fillRect(x, y, w, h);

    // Anamorphic cyan flare bar
    const fl = g.createLinearGradient(x, y + h * 0.56, x + w, y + h * 0.56);
    fl.addColorStop(0, 'rgba(90,210,255,0)');
    fl.addColorStop(0.5, 'rgba(130,225,255,0.45)');
    fl.addColorStop(1, 'rgba(90,210,255,0)');
    g.fillStyle = fl;
    g.fillRect(x, y + h * 0.54, w, Math.max(2, h * 0.025));

    // City / figure foreground silhouette
    g.fillStyle = '#07080c';
    g.fillRect(x, y + h * 0.74, w, h * 0.26);
    const fx = x + w * 0.26;
    g.beginPath();
    g.arc(fx, y + h * 0.56, Math.min(w, h) * 0.055, 0, Math.PI * 2);
    g.fill();
    g.fillRect(fx - Math.min(w, h) * 0.045, y + h * 0.61, Math.min(w, h) * 0.09, h * 0.20);

    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.font = `800 ${Math.floor(Math.min(w * 0.11, h * 0.15))}px sans-serif`;
    g.fillText(sh[0], x + w * 0.56, y + h * 0.36, w * 0.78);
    g.fillStyle = '#d4e2f2';
    g.font = `600 ${Math.floor(Math.min(w, h) * 0.045)}px sans-serif`;
    g.fillText('AN ORIGINAL FEATURE  ·  STREAMING FRIDAY', x + w * 0.56, y + h * 0.88, w * 0.82);
  } else if (style === 4) {
    // 5. Craft Beverage / Espresso Bistro Studio Shot (smooth tapered glass silhouette)
    const bg = g.createRadialGradient(x + w * 0.35, y + h * 0.5, 4, x + w * 0.45, y + h * 0.5, Math.max(w, h) * 0.78);
    bg.addColorStop(0, '#402612');
    bg.addColorStop(0.6, '#180e08');
    bg.addColorStop(1, '#050404');
    g.fillStyle = bg;
    g.fillRect(x, y, w, h);
    drawBokeh(g, x, y, w, h, rng, '#ffb85c', 8);

    const cx = x + w * (tall ? 0.5 : 0.28);
    const cy = y + h * (tall ? 0.38 : 0.52);
    const bh = Math.min(w, h) * 0.62;
    const bw = bh * 0.34;

    const bgGlass = g.createLinearGradient(cx - bw * 0.5, cy, cx + bw * 0.5, cy);
    bgGlass.addColorStop(0, '#2a1608');
    bgGlass.addColorStop(0.32, '#b06222');
    bgGlass.addColorStop(0.62, '#4a220c');
    bgGlass.addColorStop(0.88, '#e8a256');
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
    // Gold foil capsule + subtle rim highlight + cream label
    g.fillStyle = '#c89b4b';
    g.fillRect(cx - bw * 0.17, cy - bh * 0.48, bw * 0.34, bh * 0.12);
    g.fillStyle = 'rgba(255,245,220,0.40)';
    g.fillRect(cx - bw * 0.34, cy - bh * 0.12, Math.max(2, bw * 0.08), bh * 0.50);
    g.fillStyle = '#ebe2cf';
    g.fillRect(cx - bw * 0.44, cy - bh * 0.02, bw * 0.88, bh * 0.24);

    const tx = x + w * (tall ? 0.5 : 0.67);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#f8e6cc';
    g.font = `700 ${Math.floor(Math.min(w * (tall ? 0.12 : 0.075), h * 0.14))}px Georgia, serif`;
    g.fillText(br[0], tx, y + h * (tall ? 0.76 : 0.42), w * (tall ? 0.85 : 0.54));
    g.fillStyle = '#d99a52';
    g.font = `600 ${Math.floor(Math.min(w, h) * 0.05)}px sans-serif`;
    g.fillText(br[1].toUpperCase(), tx, y + h * (tall ? 0.86 : 0.58), w * 0.56);
  } else if (style === 5) {
    // 6. Athletic / Automotive Dynamic Energy Streaks on Dark Charcoal
    g.fillStyle = '#0b0d12';
    g.fillRect(x, y, w, h);
    for (let s = 0; s < 7; s++) {
      const sy = y + h * (0.18 + s * 0.11);
      const sg = g.createLinearGradient(x, sy, x + w, sy - h * 0.22);
      sg.addColorStop(0, 'rgba(0,0,0,0)');
      sg.addColorStop(0.45, accent);
      sg.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalAlpha = s % 2 ? 0.35 : 0.18;
      g.strokeStyle = sg;
      g.lineWidth = Math.max(2, Math.min(w, h) * (s % 2 ? 0.025 : 0.01));
      g.beginPath();
      g.moveTo(x - w * 0.1, sy + h * 0.15);
      g.lineTo(x + w * 1.1, sy - h * 0.28);
      g.stroke();
    }
    g.globalAlpha = 1;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.font = `900 italic ${Math.floor(Math.min(w * 0.11, h * 0.18))}px sans-serif`;
    g.fillText(br[0], x + w * 0.09, y + h * 0.42, w * 0.82);
    g.fillStyle = accent;
    g.font = `700 ${Math.floor(Math.min(w, h) * 0.065)}px sans-serif`;
    g.fillText(`${br[1].toUpperCase()}  //  ZERO LIMITS`, x + w * 0.09, y + h * 0.64, w * 0.82);
  } else {
    // 7. Swiss Editorial / Cultural Exhibit / Static Print Aesthetic
    g.fillStyle = '#e8e2d5';
    g.fillRect(x, y, w, h);
    g.fillStyle = '#15181f';
    g.fillRect(x + w * 0.05, y + h * 0.08, w * 0.90, h * 0.03);
    g.fillRect(x + w * 0.05, y + h * 0.89, w * 0.90, h * 0.015);
    const gx = x + w * (tall ? 0.5 : 0.24), gy = y + h * (tall ? 0.38 : 0.52);
    const gr = Math.min(w, h) * 0.22;
    g.fillStyle = accent;
    g.beginPath();
    g.arc(gx, gy, gr, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#15181f';
    g.lineWidth = Math.max(2, gr * 0.14);
    g.beginPath();
    g.arc(gx + gr * 0.35, gy + gr * 0.18, gr * 0.68, 0, Math.PI * 2);
    g.stroke();

    const tx = x + w * (tall ? 0.5 : 0.68);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#14171e';
    g.font = `800 ${Math.floor(Math.min(w * (tall ? 0.115 : 0.078), h * 0.14))}px sans-serif`;
    g.fillText(br[0], tx, y + h * (tall ? 0.74 : 0.44), w * (tall ? 0.84 : 0.54));
    g.fillStyle = '#484d58';
    g.font = `600 ${Math.floor(Math.min(w, h) * 0.052)}px sans-serif`;
    g.fillText(br[1].toUpperCase(), tx, y + h * (tall ? 0.84 : 0.60), w * 0.54);
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
