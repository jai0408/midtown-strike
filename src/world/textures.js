// Every texture in the game is painted at start-up on 2D canvases, so the app
// ships no image files at all.
import * as THREE from 'three';
import { RNG } from '../core/util.js';
import { STREETS, AVENUES } from './layout.js';

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

// ---------------------------------------------------------------------------
// Ground
// ---------------------------------------------------------------------------
export function asphaltTexture() {
  const rng = new RNG(11);
  const c = makeCanvas(256, 256), g = c.getContext('2d');
  g.fillStyle = '#3a3c42';
  g.fillRect(0, 0, 256, 256);
  speckle(g, 256, 256, rng, 5000, ['#4a4d55', '#2c2e33', '#55585f', '#33353a'], 2, 0.5);
  // patched repairs and cracks
  for (let i = 0; i < 5; i++) {
    g.globalAlpha = 0.18;
    g.fillStyle = rng.pick(['#26282c', '#484b52']);
    g.fillRect(rng.next() * 220, rng.next() * 220, 20 + rng.next() * 50, 10 + rng.next() * 40);
  }
  g.globalAlpha = 0.35;
  g.strokeStyle = '#1d1e22';
  g.lineWidth = 1;
  for (let i = 0; i < 6; i++) {
    g.beginPath();
    let x = rng.next() * 256, y = rng.next() * 256;
    g.moveTo(x, y);
    for (let k = 0; k < 6; k++) {
      x += rng.range(-22, 22);
      y += rng.range(-22, 22);
      g.lineTo(x, y);
    }
    g.stroke();
  }
  g.globalAlpha = 1;
  return toTexture(c);
}

export function pavingTexture() {
  const rng = new RNG(12);
  const c = makeCanvas(256, 256), g = c.getContext('2d');
  g.fillStyle = '#b9b7b0';
  g.fillRect(0, 0, 256, 256);
  speckle(g, 256, 256, rng, 4000, ['#c9c7c0', '#a3a19a', '#d4d2cc', '#959389'], 2, 0.45);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      g.globalAlpha = 0.08 * rng.next();
      g.fillStyle = rng.pick(['#000', '#fff']);
      g.fillRect(i * 64, j * 64, 64, 64);
    }
  }
  g.globalAlpha = 0.55;
  g.strokeStyle = '#6f6d66';
  g.lineWidth = 2;
  for (let i = 0; i <= 4; i++) {
    g.beginPath(); g.moveTo(i * 64, 0); g.lineTo(i * 64, 256); g.stroke();
    g.beginPath(); g.moveTo(0, i * 64); g.lineTo(256, i * 64); g.stroke();
  }
  // old chewing gum, the true New York sidewalk texture
  g.globalAlpha = 0.35;
  g.fillStyle = '#4b4a46';
  for (let i = 0; i < 40; i++) {
    g.beginPath();
    g.arc(rng.next() * 256, rng.next() * 256, 1 + rng.next() * 1.6, 0, 7);
    g.fill();
  }
  g.globalAlpha = 1;
  return toTexture(c);
}

/**
 * Road paint, tiling along V only. Columns (U): lane dashes | zebra crossing |
 * solid white | solid yellow.
 */
export function markingsTexture() {
  const c = makeCanvas(64, 64), g = c.getContext('2d');
  g.clearRect(0, 0, 64, 64);
  g.fillStyle = 'rgba(232,232,224,0.92)';
  g.fillRect(2, 0, 12, 26);        // dash: 40% painted
  g.fillRect(18, 0, 12, 32);       // zebra: 50% painted
  g.fillRect(34, 0, 12, 64);       // solid white
  g.fillStyle = 'rgba(236,190,60,0.92)';
  g.fillRect(50, 0, 12, 64);       // solid yellow
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
  { name: 'glass', cols: 8, rows: 16, tileW: 22, tileH: 60, wall: '#31475e', glass: ['#1d2f44', '#243a52', '#2b4563'], lit: 0.34, run: true, warm: 0.25, mx: 0.06, my: 0.1 },
  { name: 'slab', cols: 8, rows: 16, tileW: 20, tileH: 58, wall: '#22252b', glass: ['#11161d', '#161d27', '#1b2430'], lit: 0.3, run: true, warm: 0.45, mx: 0.14, my: 0.16 },
  { name: 'stone', cols: 8, rows: 16, tileW: 26, tileH: 56, wall: '#a39a86', glass: ['#1c222b', '#232a35'], lit: 0.3, run: false, warm: 0.85, mx: 0.24, my: 0.22 },
  { name: 'brick', cols: 8, rows: 16, tileW: 22, tileH: 50, wall: '#7a4636', glass: ['#191c22', '#20242c'], lit: 0.34, run: false, warm: 0.9, mx: 0.27, my: 0.24, brick: true },
  { name: 'loft', cols: 8, rows: 16, tileW: 28, tileH: 62, wall: '#7d7f82', glass: ['#1b2330', '#222c3b'], lit: 0.26, run: false, warm: 0.6, mx: 0.12, my: 0.18, panes: true },
  { name: 'deco', cols: 8, rows: 16, tileW: 22, tileH: 58, wall: '#5d574d', glass: ['#161a21', '#1d222b'], lit: 0.3, run: false, warm: 0.8, mx: 0.3, my: 0.14, piers: true },
];

export function facadeTextures(def, seed) {
  const rng = new RNG(seed);
  const W = 256, H = 512;
  const a = makeCanvas(W, H), e = makeCanvas(W, H);
  const g = a.getContext('2d'), ge = e.getContext('2d');
  g.fillStyle = def.wall;
  g.fillRect(0, 0, W, H);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, W, H);
  speckle(g, W, H, rng, 2500, ['#000', '#fff'], 2, 0.07);
  const cw = W / def.cols, ch = H / def.rows;
  if (def.brick) {
    g.globalAlpha = 0.16;
    g.fillStyle = '#2a1510';
    for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 1);
    for (let y = 0; y < H; y += 4) for (let x = (y / 4) % 2 ? 0 : 5; x < W; x += 10) g.fillRect(x, y, 1, 4);
    g.globalAlpha = 1;
  }
  if (def.piers) {
    for (let c = 0; c < def.cols; c++) {
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.fillRect(c * cw, 0, 3, H);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(c * cw + 3, 0, 2, H);
    }
  }
  for (let r = 0; r < def.rows; r++) {
    const floorLit = def.run ? rng.chance(def.lit * 1.25) : false;
    const floorWarm = rng.chance(def.warm);
    for (let c = 0; c < def.cols; c++) {
      const x = c * cw + cw * def.mx, y = r * ch + ch * def.my;
      const w = cw * (1 - 2 * def.mx), h = ch * (1 - def.my * 1.6);
      g.fillStyle = rng.pick(def.glass);
      g.fillRect(x, y, w, h);
      // faint sky reflection towards the top of each pane
      const refl = g.createLinearGradient(0, y, 0, y + h);
      refl.addColorStop(0, 'rgba(150,170,220,0.22)');
      refl.addColorStop(1, 'rgba(150,170,220,0)');
      g.fillStyle = refl;
      g.fillRect(x, y, w, h);
      const lit = def.run ? floorLit && rng.chance(0.86) : rng.chance(def.lit);
      if (lit) {
        const warm = def.run ? floorWarm : rng.chance(def.warm);
        const base = warm ? rng.pick(['#ffd08a', '#ffbf6e', '#ffe0ae', '#f7b25c']) : rng.pick(['#d6e8ff', '#bcd8ff', '#e8f1ff', '#9fd0ff']);
        const k = 0.55 + rng.next() * 0.45;
        ge.globalAlpha = k;
        ge.fillStyle = base;
        ge.fillRect(x, y, w, h);
        // blinds / furniture shadows so that lit windows are not flat
        ge.globalAlpha = 0.35;
        ge.fillStyle = '#000';
        if (rng.chance(0.5)) ge.fillRect(x, y, w, h * rng.range(0.15, 0.55));
        if (rng.chance(0.4)) ge.fillRect(x + w * rng.next() * 0.6, y + h * 0.55, w * 0.3, h * 0.45);
        ge.globalAlpha = 1;
        g.globalAlpha = 0.5 * k;
        g.fillStyle = base;
        g.fillRect(x, y, w, h);
        g.globalAlpha = 1;
      }
      if (def.panes) {
        g.fillStyle = def.wall;
        ge.fillStyle = '#000';
        for (let k = 1; k < 3; k++) {
          g.fillRect(x + (w * k) / 3 - 0.5, y, 1, h);
          ge.fillRect(x + (w * k) / 3 - 0.5, y, 1, h);
        }
        g.fillRect(x, y + h / 2 - 0.5, w, 1);
        ge.fillRect(x, y + h / 2 - 0.5, w, 1);
      }
      if (!def.run) {
        g.fillStyle = 'rgba(255,255,255,0.13)';
        g.fillRect(x - 1, y + h, w + 2, 2); // sill
        g.fillStyle = 'rgba(0,0,0,0.3)';
        g.fillRect(x - 1, y - 2, w + 2, 2); // lintel shadow
      }
    }
    if (def.run) {
      g.fillStyle = 'rgba(0,0,0,0.28)';
      g.fillRect(0, r * ch, W, 2);
    }
  }
  return { map: toTexture(a), emissive: toTexture(e) };
}

// ---------------------------------------------------------------------------
// Street-level shop fronts (self-lit atlas, 4 x 3 cells)
// ---------------------------------------------------------------------------
export const SHOP_COLS = 4, SHOP_ROWS = 3;
const SHOP_NAMES = ['DELI & GRILL', 'PIZZA', 'GIFTS NYC', 'PHARMACY', 'COFFEE', 'ELECTRONICS', 'BAGELS', 'NEWS & LOTTO', 'DINER', 'CITY BANK', 'HOTEL', 'THEATRE TICKETS'];
const SHOP_HUES = [8, 28, 320, 150, 24, 200, 40, 265, 350, 215, 45, 0];

export function shopTexture() {
  const rng = new RNG(31);
  const W = 1024, H = 512, cw = W / SHOP_COLS, ch = H / SHOP_ROWS;
  const c = makeCanvas(W, H), g = c.getContext('2d');
  g.fillStyle = '#0c0d10';
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < SHOP_COLS * SHOP_ROWS; i++) {
    const x = (i % SHOP_COLS) * cw, y = Math.floor(i / SHOP_COLS) * ch;
    const hue = SHOP_HUES[i];
    const shuttered = i === 3 || i === 9;
    g.fillStyle = '#15161a';
    g.fillRect(x, y, cw, ch);
    // sign band
    g.fillStyle = `hsl(${hue} 70% ${shuttered ? 18 : 36}%)`;
    g.fillRect(x + 4, y + 6, cw - 8, 34);
    g.fillStyle = shuttered ? '#8a8d92' : '#fff';
    g.font = '700 21px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(SHOP_NAMES[i], x + cw / 2, y + 24, cw - 20);
    const gy = y + 46, gh = ch - 60;
    if (shuttered) {
      g.fillStyle = '#4c5057';
      g.fillRect(x + 8, gy, cw - 16, gh);
      g.fillStyle = '#33363c';
      for (let k = 0; k < gh; k += 6) g.fillRect(x + 8, gy + k, cw - 16, 2);
    } else {
      const warm = rng.chance(0.65);
      const grad = g.createLinearGradient(0, gy, 0, gy + gh);
      if (warm) { grad.addColorStop(0, '#ffe3a8'); grad.addColorStop(1, '#c9772e'); }
      else { grad.addColorStop(0, '#e6f4ff'); grad.addColorStop(1, '#6fa6d6'); }
      g.fillStyle = grad;
      g.fillRect(x + 8, gy, cw - 16, gh);
      // shelves and display silhouettes
      g.fillStyle = 'rgba(40,22,10,0.55)';
      for (let k = 0; k < 9; k++) {
        const w = 10 + rng.next() * 26, h = 12 + rng.next() * 46;
        g.fillRect(x + 12 + rng.next() * (cw - 40 - w), gy + gh - h, w, h);
      }
      g.fillStyle = 'rgba(30,18,8,0.4)';
      g.fillRect(x + 8, gy + gh * 0.36, cw - 16, 3);
      // mullions and door
      g.fillStyle = '#17181c';
      const doorX = x + cw * rng.pick([0.2, 0.5, 0.75]);
      g.fillRect(doorX - 17, gy, 3, gh);
      g.fillRect(doorX + 14, gy, 3, gh);
      g.fillRect(x + cw / 2 - 1, gy, 2, gh * 0.36);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(doorX - 14, gy + 4, 28, gh - 4);
      g.fillStyle = '#d8d8d8';
      g.fillRect(doorX + 8, gy + gh * 0.55, 3, 12);
    }
    g.fillStyle = '#0a0a0c';
    g.fillRect(x, y + ch - 12, cw, 12);
    g.fillRect(x, y, 4, ch);
    g.fillRect(x + cw - 4, y, 4, ch);
  }
  return toTexture(c, { repeat: false });
}

// ---------------------------------------------------------------------------
// Billboards. All brands and shows are invented.
// ---------------------------------------------------------------------------
const BRANDS = [
  ['NOVA', 'feel the spark'], ['ZENITH', 'cola'], ['AURORA', 'skincare'], ['PRISM', 'see more'],
  ['VOLT', 'energy drink'], ['ECHO', 'audio'], ['LUXE', 'new york'], ['ORBIT', 'air'],
  ['PULSE', 'fitness'], ['KITE', 'mobile'], ['EMBER', 'grill'], ['TIDAL', 'swimwear'],
  ['HALO', 'phones'], ['RIVET', 'denim'], ['COMET', 'pizza'], ['MAPLE', '& co.'],
  ['ATLAS', 'bank'], ['FABLE', 'books'], ['QUARTZ', 'watches'], ['JUNO', 'streaming'],
];
const SHOWS = ['THE MIDNIGHT HOUR', 'STARLIGHT REVUE', 'CITY OF GLASS', 'THE LAST ENCORE', 'NEON HEARTS', 'A WINTER IN HARLEM'];
const PALETTES = [
  ['#ff2d6f', '#ff9a3c'], ['#00c2ff', '#2b4bff'], ['#ffe44d', '#ff7a00'], ['#19e68c', '#008a7a'],
  ['#b44dff', '#ff3d9a'], ['#ffffff', '#b8c4d8'], ['#ff3b30', '#7a0010'], ['#00e5d0', '#0061ff'],
  ['#ffd000', '#ff2d55'], ['#7dff5a', '#0fa858'], ['#ff8a00', '#e52e71'], ['#30cfd0', '#330867'],
];

function drawAd(g, x, y, w, h, rng, idx) {
  const pal = PALETTES[idx % PALETTES.length];
  const kind = idx % 6;
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  const grad = g.createLinearGradient(x, y, x + w, y + h);
  grad.addColorStop(0, pal[0]);
  grad.addColorStop(1, pal[1]);
  g.fillStyle = grad;
  g.fillRect(x, y, w, h);
  const dark = pal[0] === '#ffffff' || pal[0] === '#ffe44d' || pal[0] === '#ffd000' || pal[0] === '#7dff5a';
  const ink = dark ? '#111' : '#fff';
  const tall = h > w;
  const brand = BRANDS[(idx * 7 + 3) % BRANDS.length];
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (kind === 0 || kind === 3) {
    // big wordmark with shapes
    g.globalAlpha = 0.22;
    g.fillStyle = dark ? '#000' : '#fff';
    for (let i = 0; i < 5; i++) {
      g.beginPath();
      g.arc(x + rng.next() * w, y + rng.next() * h, (0.15 + rng.next() * 0.35) * Math.min(w, h), 0, 7);
      g.fill();
    }
    g.globalAlpha = 1;
    g.fillStyle = ink;
    g.font = `900 italic ${Math.floor(Math.min(w / (brand[0].length * 0.68), h * 0.42))}px sans-serif`;
    g.fillText(brand[0], x + w / 2, y + h * 0.45, w * 0.92);
    g.font = `600 ${Math.floor(Math.min(w, h) * 0.1)}px sans-serif`;
    g.fillText(brand[1].toUpperCase(), x + w / 2, y + h * (tall ? 0.62 : 0.8), w * 0.9);
  } else if (kind === 1) {
    // product silhouette (bottle / phone / can)
    g.fillStyle = dark ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.92)';
    const px = x + w * (tall ? 0.5 : 0.24), py = y + h * (tall ? 0.36 : 0.5);
    const ph = Math.min(w, h) * 0.62, pw = ph * 0.34;
    g.beginPath();
    if (g.roundRect) g.roundRect(px - pw / 2, py - ph / 2 + ph * 0.18, pw, ph * 0.82, pw * 0.22);
    else g.rect(px - pw / 2, py - ph / 2 + ph * 0.18, pw, ph * 0.82); // older WebViews
    g.fill();
    g.fillRect(px - pw * 0.2, py - ph / 2, pw * 0.4, ph * 0.22);
    g.fillStyle = pal[1];
    g.fillRect(px - pw / 2, py, pw, ph * 0.2);
    g.fillStyle = ink;
    g.font = `900 ${Math.floor(Math.min(w * 0.2, h * 0.24))}px sans-serif`;
    g.fillText(brand[0], x + w * (tall ? 0.5 : 0.66), y + h * (tall ? 0.78 : 0.42), w * (tall ? 0.9 : 0.6));
    g.font = `500 ${Math.floor(Math.min(w, h) * 0.08)}px sans-serif`;
    g.fillText(brand[1].toUpperCase(), x + w * (tall ? 0.5 : 0.66), y + h * (tall ? 0.88 : 0.64), w * 0.6);
  } else if (kind === 2) {
    // theatre poster
    g.fillStyle = '#0b0b12';
    g.fillRect(x, y, w, h);
    g.strokeStyle = pal[0];
    g.lineWidth = Math.max(3, Math.min(w, h) * 0.03);
    g.strokeRect(x + g.lineWidth, y + g.lineWidth, w - g.lineWidth * 2, h - g.lineWidth * 2);
    g.fillStyle = pal[0];
    g.font = `600 ${Math.floor(Math.min(w, h) * 0.08)}px sans-serif`;
    g.fillText('NOW PLAYING', x + w / 2, y + h * 0.2, w * 0.8);
    g.fillStyle = '#fff';
    const title = SHOWS[idx % SHOWS.length].split(' ');
    const fs = Math.floor(Math.min(w * 0.17, h * 0.16));
    g.font = `900 ${fs}px serif`;
    const lines = tall ? title : [title.slice(0, Math.ceil(title.length / 2)).join(' '), title.slice(Math.ceil(title.length / 2)).join(' ')];
    lines.forEach((l, i) => g.fillText(l, x + w / 2, y + h * 0.5 + (i - (lines.length - 1) / 2) * fs * 1.05, w * 0.86));
    g.fillStyle = pal[1];
    g.font = `700 ${Math.floor(Math.min(w, h) * 0.07)}px sans-serif`;
    g.fillText('★ ★ ★ ★ ★', x + w / 2, y + h * 0.84, w * 0.8);
  } else if (kind === 4) {
    // bold stripes
    g.fillStyle = dark ? 'rgba(0,0,0,0.16)' : 'rgba(255,255,255,0.2)';
    const sw = Math.max(w, h) / 9;
    for (let i = -10; i < 20; i++) {
      g.beginPath();
      g.moveTo(x + i * sw * 2, y);
      g.lineTo(x + i * sw * 2 + sw, y);
      g.lineTo(x + i * sw * 2 + sw - h, y + h);
      g.lineTo(x + i * sw * 2 - h, y + h);
      g.fill();
    }
    g.fillStyle = ink;
    g.font = `900 ${Math.floor(Math.min(w / (brand[0].length * 0.7), h * 0.5))}px sans-serif`;
    g.fillText(brand[0], x + w / 2, y + h / 2, w * 0.9);
  } else {
    // sale / slogan card
    g.fillStyle = '#0d0f14';
    g.fillRect(x + w * 0.06, y + h * 0.08, w * 0.88, h * 0.84);
    g.fillStyle = pal[0];
    g.font = `900 ${Math.floor(Math.min(w * 0.22, h * 0.3))}px sans-serif`;
    g.fillText(rng.pick(['OPEN 24/7', 'NEW YORK', 'TONIGHT', 'LIVE', 'ON SALE', 'NYC ♥']), x + w / 2, y + h * 0.42, w * 0.8);
    g.fillStyle = '#fff';
    g.font = `600 ${Math.floor(Math.min(w, h) * 0.09)}px sans-serif`;
    g.fillText(`${brand[0]} ${brand[1].toUpperCase()}`, x + w / 2, y + h * 0.7, w * 0.78);
  }
  // LED panel seams
  g.globalAlpha = 0.1;
  g.fillStyle = '#000';
  for (let i = 1; i < 6; i++) {
    g.fillRect(x + (w * i) / 6, y, 1, h);
    g.fillRect(x, y + (h * i) / 6, w, 1);
  }
  g.globalAlpha = 1;
  g.restore();
}

/** Static ads: 8 landscape cells on the top half, 8 portrait cells below. */
export const AD_LAND = [], AD_PORT = [];
for (let i = 0; i < 8; i++) {
  AD_LAND.push({ u0: (i % 4) / 4, v0: 1 - (Math.floor(i / 4) + 1) / 4, u1: (i % 4 + 1) / 4, v1: 1 - Math.floor(i / 4) / 4 });
  AD_PORT.push({ u0: i / 8, v0: 0, u1: (i + 1) / 8, v1: 0.5 });
}
export function adsTexture() {
  const rng = new RNG(77);
  const c = makeCanvas(2048, 1024), g = c.getContext('2d');
  for (let i = 0; i < 8; i++) drawAd(g, (i % 4) * 512, Math.floor(i / 4) * 256, 512, 256, rng, i);
  for (let i = 0; i < 8; i++) drawAd(g, i * 256, 512, 256, 512, rng, i + 8 + (i % 2 ? 0 : 3));
  return toTexture(c, { repeat: false });
}

/** Animated screens: 4 x 4 frames; the material steps its UV offset between them. */
export function adsAnimTexture() {
  const rng = new RNG(99);
  const c = makeCanvas(1024, 1024), g = c.getContext('2d');
  for (let i = 0; i < 16; i++) drawAd(g, (i % 4) * 256, Math.floor(i / 4) * 256, 256, 256, rng, i * 5 + 1);
  const t = toTexture(c, { repeat: true });
  return t;
}

export function tickerTexture() {
  const c = makeCanvas(2048, 64), g = c.getContext('2d');
  g.fillStyle = '#080604';
  g.fillRect(0, 0, 2048, 64);
  g.fillStyle = '#ffb21a';
  g.font = '700 40px monospace';
  g.textBaseline = 'middle';
  g.fillText('● MIDTOWN EVACUATION ORDER REMAINS IN EFFECT ● MARINES SECURE TIMES SQUARE ● HOSTILES REPORTED NEAR BRYANT PARK ●', 8, 34, 2032);
  // LED dot mask
  g.fillStyle = 'rgba(0,0,0,0.35)';
  for (let x = 0; x < 2048; x += 4) g.fillRect(x, 0, 1, 64);
  for (let y = 0; y < 64; y += 4) g.fillRect(0, y, 2048, 1);
  return toTexture(c, { repeat: true });
}

// ---------------------------------------------------------------------------
// Street-name signs (8 x 16 atlas of 256x64 cells)
// ---------------------------------------------------------------------------
export function signsTexture() {
  const c = makeCanvas(2048, 1024), g = c.getContext('2d');
  const cells = {};
  const labels = [];
  for (const s of STREETS) { labels.push(`W ${s.n} St`); labels.push(`E ${s.n} St`); }
  for (const a of AVENUES) labels.push(a.name.replace(' AV', ' Av').replace('MADISON', 'Madison').replace('PARK', 'Park').replace('LEXINGTON', 'Lexington'));
  labels.push('Broadway', 'Times Sq', 'SUBWAY', 'POLICE', 'TKTS', 'ONE WAY');
  labels.forEach((label, i) => {
    const col = i % 8, row = Math.floor(i / 8);
    const x = col * 256, y = row * 64;
    const special = label === 'SUBWAY' || label === 'POLICE' || label === 'TKTS' || label === 'ONE WAY';
    g.fillStyle = label === 'SUBWAY' ? '#101114' : label === 'POLICE' ? '#123a8c' : label === 'TKTS' ? '#c8102e' : label === 'ONE WAY' ? '#111' : '#0c6b3d';
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

// ---------------------------------------------------------------------------
// Sprites
// ---------------------------------------------------------------------------
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
