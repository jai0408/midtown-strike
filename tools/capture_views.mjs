#!/usr/bin/env node
// Renders a fixed set of in-game camera views of the BUILT game to JPEGs, plus
// render-time numbers, so visual changes can be judged before / after without a
// person at the keyboard.
//
//   npm run build && node tools/capture_views.mjs [outDir] [--only name1,name2]
//
// Uses the Chrome for Testing build that Playwright installs (no npm packages)
// over the DevTools protocol, loads android/app/src/main/assets/game/index.html
// from disk and drives it through window.__game. Output: <outDir>/<view>.jpg and
// <outDir>/report.json ({ view: { renderMs, p90Ms, drawCalls, triangles } }).
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GAME = join(ROOT, 'android/app/src/main/assets/game/index.html');
const WIDTH = 1600, HEIGHT = 900;          // landscape, like a phone held sideways
const LOAD_TIMEOUT_MS = 180000;
const MATCH_SETTLE_MS = 3500;

// name -> how to frame it. yaw/pitch in radians; view 'tpp' or 'fpp'.
export const VIEWS = [
  { name: 'midtown_high_street', mode: 'tdm', quality: 'high', view: 'tpp', yaw: 0, pitch: -0.1 },
  { name: 'midtown_high_shops', mode: 'tdm', quality: 'high', view: 'tpp', yaw: 2.2, pitch: -0.1 },
  { name: 'midtown_high_plaza', mode: 'tdm', quality: 'high', view: 'tpp', yaw: 4.0, pitch: -0.1 },
  { name: 'midtown_high_fpp', mode: 'tdm', quality: 'high', view: 'fpp', yaw: 0, pitch: -0.05 },
  { name: 'midtown_medium_street', mode: 'tdm', quality: 'medium', view: 'tpp', yaw: 0, pitch: -0.1 },
  { name: 'midtown_medium_shops', mode: 'tdm', quality: 'medium', view: 'tpp', yaw: 2.2, pitch: -0.1 },
  { name: 'lodge_high_yard', mode: 'lodge', quality: 'high', view: 'tpp', yaw: 0, pitch: -0.05 },
  { name: 'lodge_high_forest', mode: 'lodge', quality: 'high', view: 'tpp', yaw: 2.2, pitch: -0.05 },
  { name: 'lodge_high_trail', mode: 'lodge', quality: 'high', view: 'tpp', yaw: 4.0, pitch: -0.05 },
  { name: 'lodge_high_fpp', mode: 'lodge', quality: 'high', view: 'fpp', yaw: 0, pitch: -0.05 },
  { name: 'lodge_medium_yard', mode: 'lodge', quality: 'medium', view: 'tpp', yaw: 0, pitch: -0.05 },
];

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = join(homedir(), 'Library/Caches/ms-playwright');
  const dirs = existsSync(base) ? readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
  for (const d of dirs) {
    const p = join(base, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    if (existsSync(p)) return p;
  }
  throw new Error('No Chrome for Testing found: run `npx playwright install chromium` or set CHROME_PATH');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'ms-capture-'));
  const proc = spawn(findChrome(), [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    `--window-size=${WIDTH},${HEIGHT}`, '--allow-file-access-from-files',
    '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', 'about:blank',
  ], { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  if (!existsSync(portFile)) throw new Error('Chrome did not start (no DevToolsActivePort)');
  const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('No page target in Chrome');
  const close = () => { proc.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch { /* temp dir */ } };
  return { wsUrl: page.webSocketDebuggerUrl, close };
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: ok, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else ok(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((ok, reject) => {
    const n = ++id;
    pending.set(n, { resolve: ok, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const ready = new Promise((ok, reject) => { ws.onopen = ok; ws.onerror = () => reject(new Error('DevTools socket failed')); });
  return { ready, send, close: () => ws.close() };
}

/** Runs an async page expression and returns its JSON value (throws on page errors). */
async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

// Page-side helper: frame one view, render it, time a few renders, return a JPEG.
const PAGE_SHOT = `async (v, settleMs) => {
  const G = window.__game;
  G.settings.view = v.view;
  G.settings.quality = v.quality; G.view.setQuality(v.quality); if (G.map.setQuality) G.map.setQuality(v.quality);
  if (G.state !== 'playing' || !G.game.mode || G.game.mode.id !== v.mode) {
    await G.start(v.mode);
    await new Promise((r) => setTimeout(r, settleMs));
  }
  const g = G.game, p = g.player;
  p.fp = v.view === 'fpp';
  g.paused = false;
  for (let i = 0; i < 10; i++) { p.yaw = v.yaw; p.pitch = v.pitch; G.step(1, 1 / 60); }
  const r = G.view.renderer, gl = r.getContext(), px = new Uint8Array(4), times = [];
  for (let i = 0; i < 12; i++) {
    const t0 = performance.now(); G.view.render(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const stats = { renderMs: +times[6].toFixed(2), p90Ms: +times[10].toFixed(2), drawCalls: r.info.render.calls, triangles: r.info.render.triangles };
  G.view.render();
  return { stats, jpg: r.domElement.toDataURL('image/jpeg', 0.9) };
}`;

async function main() {
  const args = process.argv.slice(2);
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? new Set(args[onlyIdx + 1].split(',')) : null;
  const outDir = resolve(ROOT, args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--only') || 'docs/visual_audit');
  if (!existsSync(GAME)) throw new Error(`Built game not found at ${GAME}: run npm run build first`);
  mkdirSync(outDir, { recursive: true });
  const views = VIEWS.filter((v) => !only || only.has(v.name));

  const chrome = await launch();
  const cdp = connect(chrome.wsUrl);
  const report = {};
  try {
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: pathToFileURL(GAME).href });
    const t0 = Date.now();
    while (!(await evaluate(cdp, '!!(window.__game && window.__game.start)'))) {
      if (Date.now() - t0 > LOAD_TIMEOUT_MS) throw new Error('game did not finish loading');
      await sleep(500);
    }
    for (const v of views) {
      const res = await evaluate(cdp, `(${PAGE_SHOT})(${JSON.stringify(v)}, ${MATCH_SETTLE_MS})`);
      writeFileSync(join(outDir, v.name + '.jpg'), Buffer.from(res.jpg.split(',')[1], 'base64'));
      report[v.name] = res.stats;
      console.log(`${v.name.padEnd(24)} ${String(res.stats.renderMs).padStart(6)} ms  calls ${res.stats.drawCalls}`);
    }
    writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`wrote ${views.length} views to ${outDir}`);
  } finally {
    cdp.close();
    chrome.close();
  }
}

main().catch((e) => { console.error('capture_views:', e.message); process.exit(1); });
