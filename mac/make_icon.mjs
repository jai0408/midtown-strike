// Renders the macOS app icon (1024 px, rounded square with the standard
// margin) with headless Chromium, then mac/build_mac.py packs it as .icns.
//   NODE_PATH=<dir containing playwright> node mac/make_icon.mjs
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));

const art = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="18 18 72 72" width="824" height="824">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0a0f2c"/><stop offset=".55" stop-color="#2a1458"/><stop offset="1" stop-color="#c2255c"/>
    </linearGradient>
  </defs>
  <rect x="18" y="18" width="72" height="72" fill="url(#sky)"/>
  <g fill="#070a1c">
    <rect x="13" y="36" width="14" height="60"/><rect x="26" y="52" width="12" height="40"/><rect x="37" y="26" width="13" height="66"/>
    <rect x="49" y="46" width="10" height="46"/><rect x="58" y="22" width="14" height="70"/><rect x="71" y="42" width="12" height="50"/><rect x="82" y="32" width="13" height="60"/>
  </g>
  <rect x="19" y="40" width="7" height="11" fill="#22d3ee"/><rect x="39" y="31" width="9" height="16" fill="#fde047"/>
  <rect x="60" y="26" width="10" height="13" fill="#f472b6"/><rect x="60" y="43" width="10" height="8" fill="#34d399"/>
  <rect x="84" y="37" width="6" height="15" fill="#fb923c"/><rect x="27" y="58" width="9" height="8" fill="#a78bfa"/>
  <rect x="72" y="48" width="9" height="11" fill="#38bdf8"/>
  <rect x="18" y="74" width="72" height="16" fill="#070a1c" opacity=".55"/>
  <g fill="none" stroke="#0b1026" stroke-linecap="round" stroke-width="7" opacity=".9">
    <circle cx="54" cy="54" r="18"/><path d="M54 28v12M54 68v12M28 54h12M68 54h12"/>
  </g>
  <g fill="none" stroke="#ffb020" stroke-linecap="round" stroke-width="4">
    <circle cx="54" cy="54" r="18"/><path d="M54 28v12M54 68v12M28 54h12M68 54h12"/>
  </g>
  <circle cx="54" cy="54" r="3.2" fill="#fff"/>
</svg>`;

const html = `<!doctype html><html><body style="margin:0;background:transparent">
<div style="width:1024px;height:1024px;display:flex;align-items:center;justify-content:center">
  <div style="width:824px;height:824px;border-radius:185px;overflow:hidden;box-shadow:0 14px 28px rgba(0,0,0,.35)">${art}</div>
</div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
await page.setContent(html);
const out = resolve(here, 'AppIcon.png');
await page.screenshot({ path: out, omitBackground: true });
await browser.close();
console.log('wrote', out);
