// Renders the launcher icon layers with headless Chromium.
//   NODE_PATH=<dir containing playwright> node make_icons.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const res = resolve(here, '../app/src/main/res');

// 108x108 dp adaptive-icon canvas; the middle 66dp is always visible.
const background = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0a0f2c"/>
      <stop offset=".55" stop-color="#2a1458"/>
      <stop offset="1" stop-color="#c2255c"/>
    </linearGradient>
  </defs>
  <rect width="108" height="108" fill="url(#sky)"/>
  <g fill="#070a1c">
    <rect x="0" y="48" width="15" height="60"/><rect x="13" y="30" width="14" height="78"/>
    <rect x="26" y="52" width="12" height="56"/><rect x="37" y="22" width="13" height="86"/>
    <rect x="49" y="44" width="10" height="64"/><rect x="58" y="16" width="14" height="92"/>
    <rect x="71" y="40" width="12" height="68"/><rect x="82" y="28" width="13" height="80"/>
    <rect x="94" y="50" width="14" height="58"/>
  </g>
  <g>
    <rect x="15" y="36" width="10" height="13" fill="#22d3ee"/><rect x="39" y="28" width="9" height="18" fill="#fde047"/>
    <rect x="60" y="22" width="10" height="14" fill="#f472b6"/><rect x="60" y="40" width="10" height="9" fill="#34d399"/>
    <rect x="84" y="34" width="9" height="16" fill="#fb923c"/><rect x="27" y="58" width="9" height="8" fill="#a78bfa"/>
    <rect x="72" y="46" width="9" height="12" fill="#38bdf8"/><rect x="2" y="54" width="10" height="9" fill="#f87171"/>
    <rect x="96" y="56" width="10" height="10" fill="#facc15"/>
  </g>
  <rect y="78" width="108" height="30" fill="#070a1c" opacity=".55"/>
</svg>`;

const foreground = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">
  <g fill="none" stroke="#0b1026" stroke-linecap="round" stroke-width="7.5" opacity=".9">
    <circle cx="54" cy="54" r="19"/>
    <path d="M54 26v13M54 69v13M26 54h13M69 54h13"/>
  </g>
  <g fill="none" stroke="#ffb020" stroke-linecap="round" stroke-width="4.2">
    <circle cx="54" cy="54" r="19"/>
    <path d="M54 26v13M54 69v13M26 54h13M69 54h13"/>
  </g>
  <circle cx="54" cy="54" r="3.4" fill="#ffffff"/>
  <path d="M43 60l11-9 11 9" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity="0"/>
</svg>`;

const page = (inner, size, extra = '') => `<!doctype html><html><body style="margin:0;background:transparent">
<div style="width:${size}px;height:${size}px;position:relative;overflow:hidden;${extra}">${inner}</div></body></html>`;
const layer = (svg) => `<div style="position:absolute;inset:0">${svg}</div>`;

const browser = await chromium.launch();
const shot = async (html, size, out) => {
  const p = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await p.setContent(html);
  mkdirSync(dirname(out), { recursive: true });
  await p.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  await p.close();
  console.log('wrote', out);
};

await shot(page(layer(background), 432), 432, `${res}/drawable-xxxhdpi/ic_launcher_background.png`);
await shot(page(layer(foreground), 432), 432, `${res}/drawable-xxxhdpi/ic_launcher_foreground.png`);
// Legacy (pre-Android 8) icon: the 72dp centre of both layers in a rounded square.
const legacy = (size) => page(
  `<div style="position:absolute;left:-25%;top:-25%;width:150%;height:150%">${layer(background)}${layer(foreground)}</div>`,
  size, 'border-radius:22%');
await shot(legacy(192), 192, `${res}/mipmap-xxxhdpi/ic_launcher.png`);
await shot(legacy(96), 96, `${res}/mipmap-xhdpi/ic_launcher.png`);
// Larger preview for the README.
await shot(legacy(512), 512, resolve(here, '../../docs/icon.png'));
await browser.close();
