// App shell: boot, menus, settings, the frame loop and the Android host hooks.
import { createScene } from './game/scene.js';
import { buildCity } from './world/city.js';
import { Game, MODES } from './game/game.js';
import { Input } from './game/input.js';
import { AudioSys } from './game/audio.js';
import { Hud } from './ui/hud.js';
import { WEAPONS, CATEGORIES, DEFAULT_LOADOUT, weaponsIn } from './game/weapons.js';
import { fmtTime } from './core/util.js';

const VERSION = '1.0.0';
const STORE = 'midtown-strike-v1';
const DEFAULTS = {
  difficulty: 'regular', quality: 'medium', sensitivity: 1, autoFire: false, aimAssist: true,
  holdAds: false, leftFire: false, invertY: false, volume: 0.8, showFps: false,
  loadout: { ...DEFAULT_LOADOUT },
};

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || '{}');
    const s = { ...DEFAULTS, ...raw, loadout: { ...DEFAULTS.loadout, ...(raw.loadout || {}) } };
    for (const c of CATEGORIES) if (!WEAPONS[s.loadout[c.id]] || WEAPONS[s.loadout[c.id]].cat !== c.id) s.loadout[c.id] = DEFAULTS.loadout[c.id];
    return s;
  } catch (e) {
    return { ...DEFAULTS, loadout: { ...DEFAULTS.loadout } };
  }
}
function saveSettings() {
  try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch (e) { /* private mode */ }
}

const settings = loadSettings();
const ui = document.getElementById('ui');
const canvas = document.getElementById('view');
ui.innerHTML = `
  <div id="hud" class="hidden"></div>
  <div id="menu" class="screen hidden"></div>
  <div id="overlay" class="screen dim hidden"></div>
  <div id="loading"><div class="logo">MIDTOWN <span>STRIKE</span></div><div class="track"><i></i></div><p>DEPLOYING TO TIMES SQUARE</p></div>
  <div id="rotate">ROTATE YOUR DEVICE<br>TO LANDSCAPE</div>`;
const $ = (sel) => ui.querySelector(sel);
const menuEl = $('#menu'), overlayEl = $('#overlay'), loadingEl = $('#loading');
const progress = (p) => { loadingEl.querySelector('i').style.width = Math.round(p * 100) + '%'; };

let view, city, game, hud, input, audio;
let state = 'loading';     // loading | menu | playing | paused | results | travel | map
let tab = 'play';
let lastMode = 'tdm';

// ---------------------------------------------------------------------------
// boot (two frames apart so the loading screen paints first)
// ---------------------------------------------------------------------------
requestAnimationFrame(() => setTimeout(boot, 30));

function boot() {
  try {
    view = createScene(canvas, settings.quality);
  } catch (e) {
    loadingEl.querySelector('p').textContent = 'WEBGL IS NOT AVAILABLE ON THIS DEVICE';
    return;
  }
  progress(0.08);
  setTimeout(() => {
    city = buildCity({ onProgress: progress });
    view.scene.add(city.group);
    audio = new AudioSys();
    audio.setVolume(settings.volume);
    hud = new Hud($('#hud'), city);
    input = new Input($('#hud'), canvas);
    input.setStickElements(hud.el.stick, hud.el.knob);
    input.holdAds = settings.holdAds;
    input.onPause = () => { if (state === 'playing') pause(); else if (state === 'paused') resume(); };
    game = new Game({ view, city, hud, input, audio, settings });
    hud.openTravel = () => openTravel(true);
    hud.results = showResults;
    progress(1);
    // compile shaders / upload textures before the first interactive frame
    view.camera.position.set(60, 40, 260);
    view.camera.lookAt(0, 20, 0);
    view.render();
    loadingEl.classList.add('hidden');
    showMenu();
    window.addEventListener('resize', () => view.resize());
    // small debug surface, also used by the automated playtests
    window.__game = {
      get game() { return game; }, view, city, settings, start: startMatch, get state() { return state; },
      step(n = 1, dt = 1 / 30) { for (let i = 0; i < n; i++) { game.update(dt); input.endFrame(); } view.render(); },
    };
    requestAnimationFrame(frame);
  }, 30);
}

// ---------------------------------------------------------------------------
// frame loop with dynamic resolution
// ---------------------------------------------------------------------------
let last = 0, menuT = 0, ema = 16.7, slowT = 0, fastT = 0, fpsT = 0, frames = 0, pendingScale = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const raw = Math.min(250, now - last || 16.7);
  last = now;
  const dt = Math.min(0.05, raw / 1000);
  // resizing clears the canvas, so it must happen before this frame is drawn
  if (pendingScale) { view.setScale(pendingScale); pendingScale = 0; }
  view.resize();
  if (state === 'playing') {
    game.update(dt);
    if (input.pressed.map) openTravel(false);
    input.endFrame();
  } else if (state === 'menu') {
    // slow flight around the bowtie behind the menu
    menuT += dt;
    const a = menuT * 0.045 + 0.6;
    view.camera.position.set(Math.sin(a) * 135 + 6, 48 + Math.sin(menuT * 0.11) * 14, Math.cos(a) * 170 + 30);
    view.camera.lookAt(6, 30, 20);
    if (Math.abs(view.camera.fov - 58) > 0.01) { view.camera.fov = 58; view.camera.updateProjectionMatrix(); }
    city.update(dt, view.camera.position, view.quality.draw);
    game.fx.update(dt, view.camera, canvas.height);
  } else if (state === 'results') {
    game.update(dt);
    input.endFrame();
  }
  if (state !== 'paused' && state !== 'travel' && state !== 'map') view.render();

  // keep the frame rate up on slower phones by trading resolution
  if (state === 'playing') {
    ema += (raw - ema) * 0.06;
    if (ema > 27) { slowT += dt; fastT = 0; } else if (ema < 18.5) { fastT += dt; slowT = 0; } else { slowT = 0; fastT = 0; }
    if (slowT > 1.5) { pendingScale = view.getScale() * 0.87; slowT = 0; }
    if (fastT > 6) { pendingScale = Math.min(1, view.getScale() * 1.07); fastT = 0; }
    frames++; fpsT += raw;
    if (fpsT > 500) {
      if (settings.showFps) hud.el.fps.textContent = Math.round((frames * 1000) / fpsT) + ' fps · ' + Math.round(view.getScale() * 100) + '%';
      frames = 0; fpsT = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// menu
// ---------------------------------------------------------------------------
function showMenu() {
  state = 'menu';
  input.enabled = false;
  hud.hide();
  overlayEl.classList.add('hidden');
  menuEl.classList.remove('hidden');
  if (document.exitPointerLock) document.exitPointerLock();
  renderMenu();
}

const seg = (key, options) => `<div class="seg" data-key="${key}">${options.map(([v, label]) => `<button data-val="${v}" class="${String(settings[key]) === String(v) ? 'active' : ''}">${label}</button>`).join('')}</div>`;
const settingsHtml = (full) => `
  <div class="settings">
    ${full ? `<div class="set"><label>Difficulty<small>Enemy accuracy and reactions</small></label>${seg('difficulty', [['recruit', 'Recruit'], ['regular', 'Regular'], ['hardened', 'Hardened'], ['veteran', 'Veteran']])}</div>` : ''}
    <div class="set"><label>Graphics<small>Resolution and draw distance</small></label>${seg('quality', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']])}</div>
    <div class="set"><label>Look sensitivity</label><input type="range" min="0.4" max="2.2" step="0.05" value="${settings.sensitivity}" data-key="sensitivity"></div>
    <div class="set"><label>Fire mode<small>Auto fires when the crosshair is on a hostile</small></label>${seg('autoFire', [[false, 'Manual'], [true, 'Auto']])}</div>
    <div class="set"><label>Aim assist</label>${seg('aimAssist', [[true, 'On'], [false, 'Off']])}</div>
    <div class="set"><label>Aim down sights</label>${seg('holdAds', [[false, 'Tap'], [true, 'Hold']])}</div>
    <div class="set"><label>Left fire button</label>${seg('leftFire', [[false, 'Off'], [true, 'On']])}</div>
    <div class="set"><label>Invert vertical look</label>${seg('invertY', [[false, 'Off'], [true, 'On']])}</div>
    <div class="set"><label>Volume</label><input type="range" min="0" max="1" step="0.05" value="${settings.volume}" data-key="volume"></div>
    <div class="set"><label>Show frame rate</label>${seg('showFps', [[false, 'Off'], [true, 'On']])}</div>
  </div>`;

function bindSettings(rootEl, rerender) {
  rootEl.querySelectorAll('.seg').forEach((s) => s.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const key = s.dataset.key;
    let v = b.dataset.val;
    if (v === 'true') v = true; else if (v === 'false') v = false;
    settings[key] = v;
    applySettings(key);
    audio.unlock(); audio.ui();
    rerender();
  }));
  rootEl.querySelectorAll('input[type=range]').forEach((r) => r.addEventListener('input', () => {
    settings[r.dataset.key] = +r.value;
    applySettings(r.dataset.key);
  }));
}

function applySettings(key) {
  if (key === 'quality') view.setQuality(settings.quality);
  if (key === 'volume') audio.setVolume(settings.volume);
  if (key === 'holdAds') { input.holdAds = settings.holdAds; input.ads = false; }
  if (key === 'leftFire') hud.el.fire2.style.display = settings.leftFire ? '' : 'none';
  if (key === 'showFps') hud.el.fps.style.display = settings.showFps ? '' : 'none';
  saveSettings();
}

function renderMenu() {
  const tabs = [['play', 'DEPLOY'], ['loadout', 'LOADOUT'], ['settings', 'SETTINGS'], ['help', 'CONTROLS']];
  let body = '';
  if (tab === 'play') {
    body = `<div class="cards">${Object.values(MODES).map((m) => `
      <div class="card"><small>${m.place}</small><h2>${m.name}</h2><p>${m.blurb}</p><button class="cta" data-mode="${m.id}">PLAY</button></div>`).join('')}</div>`;
  } else if (tab === 'loadout') {
    body = `<div class="loadout">${CATEGORIES.map((c) => {
      const w = WEAPONS[settings.loadout[c.id]];
      const bars = [['DAMAGE', w.bars.damage], ['FIRE RATE', w.bars.rate], ['ACCURACY', w.bars.accuracy], ['MOBILITY', w.bars.mobility], ['RANGE', w.bars.range]];
      return `<div class="lo"><small>${c.label}</small>
        <div class="pick"><button data-cat="${c.id}" data-dir="-1">‹</button><b>${w.name}</b><button data-cat="${c.id}" data-dir="1">›</button></div>
        <p>${w.desc}</p>${bars.map(([n, v]) => `<div class="bar"><span>${n}</span><i><b style="width:${v}%"></b></i></div>`).join('')}</div>`;
    }).join('')}</div>`;
  } else if (tab === 'settings') {
    body = settingsHtml(true);
  } else {
    body = `<div class="help">
      <h3>MOVE</h3><p>Drag anywhere on the left half of the screen. Push the stick past its ring to sprint. Tap crouch while sprinting to slide.</p>
      <h3>AIM AND FIRE</h3><p>Drag on the right half to look. Hold the red button to fire; you can keep dragging on it to track a target. ADS raises your sights: tighter spread, less recoil, slower movement.</p>
      <h3>STANCES</h3><p>Crouch and prone steady your aim and make you harder to hit. Jump next to a car, barrier or crate to climb over it.</p>
      <h3>WEAPONS</h3><p>You carry one weapon from each class: assault rifle, sniper rifle, handgun and a melee weapon. Tap a slot to switch. Sniper rifles use a scope when you aim. The knife lunges at close targets and makes you run faster.</p>
      <h3>HEALTH AND AMMO</h3><p>Health comes back when you stay out of fire for a few seconds. Every elimination tops up your reserve ammunition; every fifth one earns a grenade.</p>
      <h3>CITY SWEEP</h3><p>Follow the amber marker to the nearest hostile strongpoint and eliminate its garrison. Green subway entrances let you fast travel across the map and restock.</p>
      <h3>KEYBOARD (BROWSER)</h3><p>WASD move · Shift sprint · Space jump · C crouch · Z prone · Mouse aim and fire · Right mouse ADS · R reload · 1–4 weapons · G grenade · F interact · M map · Esc pause</p>
    </div>`;
  }
  menuEl.innerHTML = `
    <div class="head">
      <div><div class="logo">MIDTOWN <span>STRIKE</span></div><div class="tagline">MARINES · TIMES SQUARE · 2 SQUARE MILES</div></div>
      <div class="tabs">${tabs.map(([id, label]) => `<button class="tab ${tab === id ? 'active' : ''}" data-tab="${id}">${label}</button>`).join('')}</div>
    </div>
    <div class="body">${body}</div>
    <div class="foot"><span>v${VERSION}</span><span>${isAndroid() ? '' : 'Best in landscape on a phone · runs fully offline'}</span></div>`;
  menuEl.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; audio.unlock(); audio.ui(); renderMenu(); }));
  menuEl.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => startMatch(b.dataset.mode)));
  menuEl.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => {
    const list = weaponsIn(b.dataset.cat);
    const i = list.findIndex((w) => w.id === settings.loadout[b.dataset.cat]);
    settings.loadout[b.dataset.cat] = list[(i + +b.dataset.dir + list.length) % list.length].id;
    saveSettings();
    audio.unlock(); audio.ui();
    renderMenu();
  }));
  bindSettings(menuEl, renderMenu);
}

const isAndroid = () => typeof window.AndroidHost !== 'undefined';

// ---------------------------------------------------------------------------
// match flow
// ---------------------------------------------------------------------------
function startMatch(modeId) {
  lastMode = modeId;
  audio.unlock();
  audio.ui();
  if (!isAndroid()) {
    // in a mobile browser: go full screen and try to hold landscape
    const el = document.documentElement;
    if (input.isTouch || 'ontouchstart' in window) {
      try {
        const p = el.requestFullscreen && el.requestFullscreen();
        if (p && p.then) p.then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape').catch(() => {})).catch(() => {});
      } catch (e) { /* not allowed */ }
    }
  }
  menuEl.classList.add('hidden');
  overlayEl.classList.add('hidden');
  input.reset();
  game.start(modeId, settings.loadout);
  view.setScale(1);
  ema = 16.7;
  input.enabled = true;
  state = 'playing';
}

function pause() {
  if (state !== 'playing') return;
  state = 'paused';
  game.paused = true;
  input.enabled = false;
  input.reset();
  if (document.exitPointerLock) document.exitPointerLock();
  renderPause();
}

function renderPause() {
  overlayEl.classList.remove('hidden');
  overlayEl.innerHTML = `<div class="panel"><h1>PAUSED</h1><div class="sub">${game.mode.name}</div>
    ${settingsHtml(false)}
    <div class="row" style="margin-top:3vh"><button class="cta" data-a="resume">RESUME</button><button class="cta ghost" data-a="restart">RESTART</button><button class="cta ghost" data-a="quit">QUIT TO MENU</button></div></div>`;
  bindSettings(overlayEl, renderPause);
  overlayEl.querySelector('[data-a=resume]').addEventListener('click', resume);
  overlayEl.querySelector('[data-a=restart]').addEventListener('click', () => startMatch(lastMode));
  overlayEl.querySelector('[data-a=quit]').addEventListener('click', quit);
}

function resume() {
  if (state !== 'paused' && state !== 'travel' && state !== 'map') return;
  overlayEl.classList.add('hidden');
  game.paused = false;
  input.reset();
  input.enabled = true;
  audio.resume();
  state = 'playing';
  last = performance.now();
}

function quit() {
  game.stop();
  showMenu();
}

function showResults(r) {
  state = 'results';
  input.enabled = false;
  input.reset();
  if (document.exitPointerLock) document.exitPointerLock();
  overlayEl.classList.remove('hidden');
  overlayEl.innerHTML = `<div class="panel"><h1 class="${r.win ? 'win' : 'lose'}">${r.title}</h1>
    <div class="sub">${r.mode}${r.score ? ` · MARINES ${r.score[0]} – ${r.score[1]} HOSTILES` : ''}</div>
    <div class="stats">
      <div><b>${r.kills}</b><span>ELIMINATIONS</span></div><div><b>${r.deaths}</b><span>DEATHS</span></div>
      <div><b>${r.accuracy}%</b><span>ACCURACY</span></div><div><b>${r.headshots}</b><span>HEADSHOTS</span></div>
      <div><b>${fmtTime(r.time)}</b><span>TIME</span></div>
    </div>
    <div class="row"><button class="cta" data-a="again">PLAY AGAIN</button><button class="cta ghost" data-a="menu">MAIN MENU</button></div></div>`;
  overlayEl.querySelector('[data-a=again]').addEventListener('click', () => startMatch(lastMode));
  overlayEl.querySelector('[data-a=menu]').addEventListener('click', quit);
}

/** Full map. With travel=true the subway stations can be selected. */
function openTravel(travel) {
  if (state !== 'playing') return;
  state = travel ? 'travel' : 'map';
  game.paused = true;
  input.enabled = false;
  input.reset();
  if (document.exitPointerLock) document.exitPointerLock();
  overlayEl.classList.remove('hidden');
  const stations = game.stations.slice().sort((a, b) => a.name.localeCompare(b.name));
  overlayEl.innerHTML = `<div class="panel"><div class="travel"><canvas width="640" height="640"></canvas>
    <div class="list"><h2>${travel ? 'SUBWAY · FAST TRAVEL' : 'MIDTOWN'}</h2>
    ${travel ? stations.map((s, i) => `<button data-i="${i}">${s.name}</button>`).join('') : `<p style="font-size:2.3vh;line-height:1.5;opacity:.85">White arrow: you. Blue: Marines. Green dots: subway entrances${game.sectors ? ' (walk up to one to fast travel). Red circles: hostile strongpoints; blue ones are secured.' : '. The dashed line is the combat zone.'}</p>`}
    <button class="close" data-a="close">${travel ? 'CANCEL' : 'CLOSE'}</button></div></div></div>`;
  const cv = overlayEl.querySelector('canvas');
  const spots = hud.drawFullMap(cv, game);
  const go = (st) => { game.travelTo(st); resume(); };
  if (travel) {
    overlayEl.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => go(stations[+b.dataset.i])));
    cv.addEventListener('click', (e) => {
      const r = cv.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      let best = null, bd = 0.05;
      for (const s of spots) { const d = Math.hypot(s.x - x, s.y - y); if (d < bd) { bd = d; best = s.st; } }
      if (best) go(best);
    });
  }
  overlayEl.querySelector('[data-a=close]').addEventListener('click', resume);
}

// ---------------------------------------------------------------------------
// host integration (Android activity) and page lifecycle
// ---------------------------------------------------------------------------
window.onHostBack = () => {
  if (state === 'playing') pause();
  else if (state === 'paused' || state === 'travel' || state === 'map') resume();
  else if (state === 'results') quit();
  else if (state === 'menu') {
    if (tab !== 'play') { tab = 'play'; renderMenu(); }
    else if (isAndroid()) window.AndroidHost.exit();
  }
};
window.onHostPause = () => { if (state === 'playing') pause(); if (audio) audio.suspend(); };
window.onHostResume = () => { if (audio && state !== 'paused') audio.resume(); };
document.addEventListener('visibilitychange', () => { if (document.hidden) window.onHostPause(); else window.onHostResume(); });
// the page must never scroll or zoom
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());
