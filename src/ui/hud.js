// In-match HUD: touch controls, crosshair, minimap, compass, kill feed,
// health/ammo, damage indicators and the overlays shown during a match.
import * as THREE from 'three';
import { HALF, AVENUES, STREETS, broadwayX, districtName, crossStreet, LANDMARKS } from '../world/layout.js';
import { makeCanvas } from '../world/textures.js';
import { CATEGORIES } from '../game/weapons.js';
import { MARINES } from '../game/actor.js';
import { clamp, fmtTime } from '../core/util.js';

const ICON = {
  fire: '<svg viewBox="0 0 48 48"><path d="M24 5c5 5 7 10 7 15v17a3 3 0 0 1-3 3h-8a3 3 0 0 1-3-3V20c0-5 2-10 7-15z" fill="currentColor"/><rect x="17" y="34" width="14" height="3" fill="#0008"/></svg>',
  ads: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><circle cx="24" cy="24" r="13"/><path d="M24 5v10M24 33v10M5 24h10M33 24h10"/><circle cx="24" cy="24" r="1.6" fill="currentColor"/></svg>',
  jump: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 26l12-12 12 12M12 38l12-12 12 12"/></svg>',
  crouch: '<svg viewBox="0 0 48 48" fill="currentColor"><circle cx="27" cy="11" r="5"/><path d="M22 18l8 1 3 9-7 3 5 9-4 3-7-11-1-7-5 5-3 9-5-1 3-11z"/></svg>',
  prone: '<svg viewBox="0 0 48 48" fill="currentColor"><circle cx="38" cy="24" r="4.6"/><path d="M4 31l11-4 16-2 3 6-15 3-14 2zM31 26l8 5 5 0 0 4-7 0-8-4z"/></svg>',
  reload: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M38 24a14 14 0 1 1-4.5-10.3"/><path d="M34 6v9h-9"/></svg>',
  grenade: '<svg viewBox="0 0 48 48" fill="currentColor"><rect x="19" y="6" width="10" height="7" rx="1.5"/><path d="M29 8h7v9h-3v-6h-4z"/><ellipse cx="24" cy="29" rx="12" ry="14"/></svg>',
  pause: '<svg viewBox="0 0 48 48" fill="currentColor"><rect x="13" y="10" width="8" height="28" rx="2"/><rect x="27" y="10" width="8" height="28" rx="2"/></svg>',
};

const HTML = `
<div id="vignette"></div>
<div id="scope"><i></i></div>
<canvas id="minimap" width="220" height="220" data-act="map"></canvas>
<div id="locname"><b></b><small></small></div>
<div id="topbar">
  <div class="team blue"><b id="score0">0</b><span>MARINES</span></div>
  <div id="clock">0:00</div>
  <div class="team red"><span>HOSTILES</span><b id="score1">0</b></div>
</div>
<div id="objective"></div>
<div id="compass"><div id="compass-strip"></div><i id="compass-obj"></i><i id="compass-tick"></i></div>
<div id="btn-pause" class="btn" data-act="pause">${ICON.pause}</div>
<div id="fps"></div>
<div id="feed"></div>
<div id="crosshair"><i class="t"></i><i class="b"></i><i class="l"></i><i class="r"></i><i class="dot"></i></div>
<div id="hitmarker"><i></i><i></i><i></i><i></i></div>
<div id="target"><b></b><i><u></u></i></div>
<div id="dmg"></div>
<div id="marker"><i></i><span></span></div>
<div id="toast"></div>
<div id="banner"><b></b><span></span></div>
<div id="warn"></div>
<div id="prompt" data-act="interact"></div>
<div id="status">
  <div id="health"><div id="health-bar"></div></div>
  <div id="ammo"><b id="ammo-mag">30</b><span id="ammo-res">180</span><em id="wname">M4</em></div>
</div>
<div id="weapons">${CATEGORIES.map((c, i) => `<div class="slot" data-act="slot" data-slot="${i}"><span>${c.short}</span><b></b><i></i></div>`).join('')}</div>
<div id="stick"><div id="knob"></div></div>
<div class="btn b-fire" data-act="fire">${ICON.fire}</div>
<div class="btn b-fire2" data-act="fire2">${ICON.fire}</div>
<div class="btn b-ads" data-act="ads">${ICON.ads}<small>ADS</small></div>
<div class="btn b-jump" data-act="jump">${ICON.jump}</div>
<div class="btn b-crouch" data-act="crouch">${ICON.crouch}</div>
<div class="btn b-prone" data-act="prone">${ICON.prone}</div>
<div class="btn b-reload" data-act="reload">${ICON.reload}</div>
<div class="btn b-grenade" data-act="grenade">${ICON.grenade}<small id="gren-n">2</small></div>
<div id="dead"><b>ELIMINATED</b><span id="dead-by"></span><em id="dead-t"></em></div>
`;

const _p = new THREE.Vector3();

export class Hud {
  constructor(root, city) {
    this.root = root;
    root.innerHTML = HTML;
    const $ = (id) => root.querySelector(id);
    this.el = {
      vignette: $('#vignette'), scope: $('#scope'), minimap: $('#minimap'), loc: $('#locname'), topbar: $('#topbar'),
      score0: $('#score0'), score1: $('#score1'), clock: $('#clock'), objective: $('#objective'),
      compassStrip: $('#compass-strip'), compassObj: $('#compass-obj'), feed: $('#feed'), cross: $('#crosshair'),
      hit: $('#hitmarker'), dmg: $('#dmg'), marker: $('#marker'), toast: $('#toast'), banner: $('#banner'), warn: $('#warn'),
      prompt: $('#prompt'), hp: $('#health-bar'), mag: $('#ammo-mag'), res: $('#ammo-res'), wname: $('#wname'),
      slots: [...root.querySelectorAll('.slot')], stick: $('#stick'), knob: $('#knob'), gren: $('#gren-n'),
      dead: $('#dead'), deadBy: $('#dead-by'), deadT: $('#dead-t'), fire2: root.querySelector('.b-fire2'), fps: $('#fps'),
      ads: root.querySelector('.b-ads'), target: $('#target'),
    };
    this.cache = {};
    this.mapCtx = this.el.minimap.getContext('2d');
    this.base = this._drawBaseMap(city);
    this.hitT = 0;
    this.flash = 0;
    this.toasts = [];
    this.bannerT = 0;
    this.mapT = 0;
    this.locT = 0;
    this.deadT = 0;
    this.onTravel = null;
    // compass labels: three turns so that it can scroll seamlessly
    const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    let strip = '';
    for (let k = 0; k < 24; k++) strip += `<span class="${k % 2 ? 'minor' : ''}">${names[k % 8]}</span>`;
    this.el.compassStrip.innerHTML = strip;
  }

  _set(key, value, fn) {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    fn(value);
  }

  /** Whole-map image (2.5 m per pixel), north up. */
  _drawBaseMap(city) {
    const S = 2.5, N = Math.round((HALF * 2) / S);
    const c = makeCanvas(N, N), g = c.getContext('2d');
    const X = (x) => (x + HALF) / S, Z = (z) => (z + HALF) / S;
    g.fillStyle = '#20232c';
    g.fillRect(0, 0, N, N);
    // sidewalks / blocks slightly lighter than the roadway
    g.fillStyle = '#2b2f3a';
    for (let c2 = -1; c2 < AVENUES.length; c2++) {
      const x0 = c2 < 0 ? -HALF : AVENUES[c2].x + AVENUES[c2].road, x1 = c2 + 1 >= AVENUES.length ? HALF : AVENUES[c2 + 1].x - AVENUES[c2 + 1].road;
      for (let r = -1; r < STREETS.length; r++) {
        const z0 = r < 0 ? -HALF : STREETS[r].z + STREETS[r].road, z1 = r + 1 >= STREETS.length ? HALF : STREETS[r + 1].z - STREETS[r + 1].road;
        g.fillRect(X(x0), Z(z0), (x1 - x0) / S, (z1 - z0) / S);
      }
    }
    // Broadway
    g.strokeStyle = '#20232c';
    g.lineWidth = 16 / S;
    g.beginPath();
    g.moveTo(X(broadwayX(-HALF)), Z(-HALF));
    g.lineTo(X(0), Z(0));
    g.lineTo(X(broadwayX(HALF)), Z(HALF));
    g.stroke();
    g.fillStyle = '#244a2c';
    for (const p of city.ctx.parks) g.fillRect(X(p.x0), Z(p.z0), (p.x1 - p.x0) / S, (p.z1 - p.z0) / S);
    for (const b of city.ctx.buildings) {
      if (Math.abs(b.x0) > HALF || Math.abs(b.z0) > HALF) continue;
      g.fillStyle = b.nearTS ? '#5d6480' : b.h > 150 ? '#565d70' : '#454b5b';
      if (b.round) { g.beginPath(); g.arc(X(b.cx), Z(b.cz), b.round / S, 0, 7); g.fill(); }
      else g.fillRect(X(b.x0) + 0.5, Z(b.z0) + 0.5, (b.x1 - b.x0) / S - 1, (b.z1 - b.z0) / S - 1);
    }
    g.fillStyle = '#10283f';
    g.fillRect(0, 0, 3, N);
    // the bowtie glows
    const grad = g.createRadialGradient(X(8), Z(30), 4, X(8), Z(30), 120);
    grad.addColorStop(0, 'rgba(255,90,170,0.16)');
    grad.addColorStop(1, 'rgba(255,90,170,0)');
    g.fillStyle = grad;
    g.fillRect(X(-300), Z(-300), 600 / S, 660 / S);
    return { canvas: c, scale: S, size: N };
  }

  begin(game) {
    this.root.classList.remove('hidden');
    const tdm = game.mode.id === 'tdm';
    this.el.topbar.style.display = tdm ? '' : 'none';
    this.el.objective.style.display = tdm ? 'none' : '';
    this.el.dead.classList.remove('show');
    this.el.feed.innerHTML = '';
    this.el.toast.innerHTML = '';
    this.el.dmg.innerHTML = '';
    this.el.fire2.style.display = game.settings.leftFire ? '' : 'none';
    this.el.fps.style.display = game.settings.showFps ? '' : 'none';
    this.warn(null);
    this.setPrompt(null);
    this.cache = {};
    this.toasts.length = 0;
    this.root.classList.toggle('touch', game.input.isTouch || 'ontouchstart' in window);
  }

  hide() {
    this.root.classList.add('hidden');
  }

  hitMarker(kill, head) {
    this.hitT = 0.22;
    this.el.hit.className = 'show' + (kill ? ' kill' : '') + (head ? ' head' : '');
  }

  damageFrom(x, z, amount) {
    this.flash = Math.min(1, this.flash + 0.35 + amount / 120);
    const d = document.createElement('i');
    d._x = x; d._z = z; d._t = 1.3;
    this.el.dmg.appendChild(d);
    while (this.el.dmg.children.length > 5) this.el.dmg.removeChild(this.el.dmg.firstChild);
  }

  feed(killer, weapon, victim, killerTeam, victimTeam, head) {
    const d = document.createElement('div');
    const cls = (t) => (t === MARINES ? 'blue' : 'red');
    d.innerHTML = (killer ? `<b class="${cls(killerTeam)}">${killer}</b>` : '') + `<i>${weapon || '✕'}${head ? ' ◎' : ''}</i><b class="${cls(victimTeam)}">${victim}</b>`;
    d._t = 6;
    this.el.feed.appendChild(d);
    while (this.el.feed.children.length > 5) this.el.feed.removeChild(this.el.feed.firstChild);
  }

  toast(text, sub, kind = 'kill') {
    const d = document.createElement('div');
    d.className = kind;
    d.innerHTML = `<b>${text}</b>${sub ? `<span>${sub}</span>` : ''}`;
    d._t = 1.9;
    this.el.toast.appendChild(d);
    while (this.el.toast.children.length > 3) this.el.toast.removeChild(this.el.toast.firstChild);
  }

  banner(title, sub) {
    const b = this.el.banner;
    b.firstElementChild.textContent = title;
    b.lastElementChild.textContent = sub || '';
    b.classList.remove('show');
    void b.offsetWidth;
    b.classList.add('show');
    this.bannerT = 3.4;
  }

  warn(text) {
    this._set('warn', text || '', (v) => { this.el.warn.textContent = v; this.el.warn.style.display = v ? '' : 'none'; });
  }

  setPrompt(text) {
    this._set('prompt', text || '', (v) => { this.el.prompt.textContent = v; this.el.prompt.style.display = v ? '' : 'none'; });
  }

  died(by, weapon, t) {
    this.el.dead.classList.add('show');
    this.el.deadBy.textContent = by ? `by ${by}${weapon ? ' · ' + weapon : ''}` : '';
    this.deadT = t;
  }

  respawned() {
    this.el.dead.classList.remove('show');
    this.flash = 0;
  }

  // -------------------------------------------------------------------------
  update(game, dt) {
    const p = game.player, el = this.el, cam = game.camera;
    const W = window.innerWidth, H = window.innerHeight;

    // crosshair
    const def = p.def;
    const showCross = p.alive && !p.scoped && !game.over;
    this._set('cross', showCross ? (def.cat === 'melee' ? 2 : 1) : 0, (v) => { el.cross.style.display = v ? '' : 'none'; el.cross.classList.toggle('melee', v === 2); });
    if (showCross) {
      const gap = Math.round(clamp((Math.tan((p.spread * Math.PI) / 180) / Math.tan((cam.fov * Math.PI) / 360)) * (H / 2), 3, H * 0.2));
      this._set('gap', gap, (v) => el.cross.style.setProperty('--gap', v + 'px'));
      this._set('aimOn', p.aimOn, (v) => el.cross.classList.toggle('on', v));
    }
    this._set('scope', p.scoped, (v) => el.scope.classList.toggle('show', v));
    // name and health of the hostile under the crosshair
    const ta = p.alive && p.aimOn && p.aimActor && p.aimActor.alive ? p.aimActor : null;
    this._set('tname', ta ? ta.name : '', (v) => { el.target.style.display = v ? '' : 'none'; el.target.firstElementChild.textContent = v; });
    if (ta) this._set('thp', Math.round((ta.hp / ta.maxHp) * 20), (v) => { el.target.lastElementChild.firstElementChild.style.width = v * 5 + '%'; });
    if (this.hitT > 0) { this.hitT -= dt; if (this.hitT <= 0) el.hit.className = ''; }

    // health + damage
    this.flash = Math.max(0, this.flash - dt * 1.6);
    const hurt = clamp(1 - p.hp / p.maxHp, 0, 1);
    this._set('vig', Math.round((Math.pow(hurt, 1.5) * 0.85 + this.flash * 0.5) * 20), (v) => { el.vignette.style.opacity = v / 20; });
    this._set('hp', Math.round(p.hp), (v) => { el.hp.style.width = v + '%'; el.hp.classList.toggle('low', v < 35); });
    for (let i = el.dmg.children.length - 1; i >= 0; i--) {
      const d = el.dmg.children[i];
      d._t -= dt;
      if (d._t <= 0) { el.dmg.removeChild(d); continue; }
      const rel = Math.atan2(d._x - p.x, -(d._z - p.z)) + p.yaw;
      d.style.transform = `translate(-50%,-50%) rotate(${rel}rad) translateY(-21vh)`;
      d.style.opacity = Math.min(1, d._t * 1.6);
    }

    // weapons
    const w = p.cur;
    this._set('mag', def.mag ? w.mag : -1, (v) => { el.mag.textContent = v < 0 ? '—' : v; el.mag.classList.toggle('low', v >= 0 && v <= def.mag * 0.25); });
    this._set('res', def.mag ? w.reserve : -1, (v) => { el.res.textContent = v < 0 ? '' : v; });
    this._set('wname', def.name + (p.reloadT >= 0 ? ' · RELOADING' : ''), (v) => { el.wname.textContent = v; });
    this._set('slot', p.slot, (v) => el.slots.forEach((s, i) => s.classList.toggle('active', i === v)));
    for (let i = 0; i < 4; i++) {
      const s = p.slots[i];
      this._set('sn' + i, s.def.name, (v) => { el.slots[i].children[1].textContent = v; });
      this._set('sa' + i, s.def.mag ? s.mag + ' / ' + s.reserve : '∞', (v) => { el.slots[i].children[2].textContent = v; });
    }
    this._set('gren', p.grenades, (v) => { el.gren.textContent = v; el.gren.parentElement.classList.toggle('empty', v === 0); });
    this._set('adsOn', game.input.ads, (v) => el.ads.classList.toggle('on', v));

    // score / clock / objective
    if (game.mode.id === 'tdm') {
      this._set('s0', game.score[0], (v) => { el.score0.textContent = v; });
      this._set('s1', game.score[1], (v) => { el.score1.textContent = v; });
      this._set('clock', fmtTime(game.clock), (v) => { el.clock.textContent = v; });
    } else {
      const o = game.objective;
      this._set('obj', o ? `${o.name} · ${Math.round(o.dist)} m · ${o.remaining} hostile${o.remaining === 1 ? '' : 's'} · ${o.left} left` : 'ALL STRONGPOINTS CLEARED', (v) => { el.objective.textContent = v; });
    }

    // compass
    const hdg = ((-p.yaw * 180) / Math.PI % 360 + 360) % 360;
    el.compassStrip.style.transform = `translateX(${(-(hdg + 360) * 2).toFixed(1)}px)`;
    const o = game.objective;
    let markerShown = false;
    if (o && game.mode.id !== 'tdm') {
      const bearing = (Math.atan2(o.x - p.x, -(o.z - p.z)) * 180) / Math.PI;
      let rel = ((bearing - hdg + 540) % 360) - 180;
      el.compassObj.style.display = '';
      el.compassObj.style.transform = `translateX(${clamp(rel * 2, -118, 118)}px)`;
      // world marker
      _p.set(o.x, 14, o.z).project(cam);
      if (_p.z < 1 && Math.abs(_p.x) < 0.94 && Math.abs(_p.y) < 0.9 && o.dist > 45) {
        markerShown = true;
        el.marker.style.transform = `translate(${((_p.x * 0.5 + 0.5) * W).toFixed(0)}px, ${((-_p.y * 0.5 + 0.5) * H).toFixed(0)}px)`;
        this._set('mk', Math.round(o.dist / 5) * 5, (v) => { el.marker.lastElementChild.textContent = v + ' m'; });
      }
    } else el.compassObj.style.display = 'none';
    this._set('mkShow', markerShown, (v) => { el.marker.style.display = v ? '' : 'none'; });

    // timed elements
    for (const list of [el.feed, el.toast]) {
      for (let i = list.children.length - 1; i >= 0; i--) {
        const d = list.children[i];
        d._t -= dt;
        if (d._t <= 0) list.removeChild(d);
        else if (d._t < 0.5) d.style.opacity = d._t * 2;
      }
    }
    if (this.bannerT > 0) { this.bannerT -= dt; if (this.bannerT <= 0) el.banner.classList.remove('show'); }
    if (!p.alive && !game.over) {
      this.deadT = Math.max(0, this.deadT - dt);
      this._set('deadT', Math.ceil(this.deadT), (v) => { el.deadT.textContent = 'Redeploying in ' + v; });
    }

    // minimap + location (throttled)
    this.mapT -= dt;
    if (this.mapT <= 0) { this.mapT = 0.066; this._minimap(game); }
    this.locT -= dt;
    if (this.locT <= 0) {
      this.locT = 0.5;
      this._set('loc1', districtName(p.x, p.z), (v) => { el.loc.firstElementChild.textContent = v; });
      this._set('loc2', crossStreet(p.x, p.z), (v) => { el.loc.lastElementChild.textContent = v; });
    }
  }

  _minimap(game) {
    const g = this.mapCtx, size = 220, half = size / 2, p = game.player;
    const R = 95;                       // metres shown from the centre to the edge
    const k = half / R;                 // px per metre
    const b = this.base;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, size, size);
    g.save();
    g.beginPath();
    g.arc(half, half, half - 2, 0, 7);
    g.clip();
    g.fillStyle = '#10141c';
    g.fillRect(0, 0, size, size);
    g.translate(half, half);
    g.rotate(p.yaw);
    // base map: source rectangle around the player
    const sp = k * b.scale;             // screen px per map px
    g.imageSmoothingEnabled = true;
    g.drawImage(b.canvas, -((p.x + HALF) / b.scale) * sp, -((p.z + HALF) / b.scale) * sp, b.size * sp, b.size * sp);
    // strongpoints
    if (game.sectors) {
      for (const s of game.sectors) {
        const x = (s.x - p.x) * k, z = (s.z - p.z) * k;
        if (Math.hypot(x, z) > half + 40) continue;
        g.strokeStyle = s.secured ? 'rgba(80,170,255,0.9)' : 'rgba(255,70,70,0.9)';
        g.fillStyle = s.secured ? 'rgba(80,170,255,0.16)' : 'rgba(255,70,70,0.16)';
        g.lineWidth = 2;
        g.beginPath(); g.arc(x, z, s.r * k, 0, 7); g.fill(); g.stroke();
      }
    }
    for (const st of game.stations) {
      const x = (st.x - p.x) * k, z = (st.z - p.z) * k;
      if (Math.hypot(x, z) > half) continue;
      g.fillStyle = '#7dffb0';
      g.fillRect(x - 3, z - 3, 6, 6);
    }
    const now = game.time;
    for (const a of game.actors) {
      if (a === p || !a.alive) continue;
      const dx = a.x - p.x, dz = a.z - p.z, d = Math.hypot(dx, dz);
      if (d > R + 6) continue;
      if (a.team === MARINES) g.fillStyle = '#4db2ff';
      else {
        // hostiles show up while they are shooting or right on top of you
        if (now - a.lastShotT > 2.2 && d > 16) continue;
        g.fillStyle = '#ff4040';
      }
      g.beginPath(); g.arc(dx * k, dz * k, a.team === MARINES ? 4 : 4.6, 0, 7); g.fill();
    }
    g.restore();
    // objective pointer on the rim
    const o = game.objective;
    if (o && o.dist > R) {
      const ang = Math.atan2(o.x - p.x, -(o.z - p.z)) + p.yaw;
      g.save();
      g.translate(half + Math.sin(ang) * (half - 9), half - Math.cos(ang) * (half - 9));
      g.rotate(ang);
      g.fillStyle = '#ffb020';
      g.beginPath(); g.moveTo(0, -8); g.lineTo(6, 5); g.lineTo(-6, 5); g.closePath(); g.fill();
      g.restore();
    }
    // player arrow and rim
    g.fillStyle = '#fff';
    g.strokeStyle = '#0a0f2c';
    g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(half, half - 9); g.lineTo(half + 6.5, half + 7); g.lineTo(half, half + 3.5); g.lineTo(half - 6.5, half + 7); g.closePath();
    g.fill(); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = 2.5;
    g.beginPath(); g.arc(half, half, half - 2, 0, 7); g.stroke();
  }

  /** Full-map picture for the travel / overview screen. Returns hit-test data. */
  drawFullMap(canvas, game) {
    const g = canvas.getContext('2d'), N = canvas.width, b = this.base, p = game.player;
    const k = N / (HALF * 2);
    g.clearRect(0, 0, N, N);
    g.drawImage(b.canvas, 0, 0, N, N);
    const X = (x) => (x + HALF) * k, Z = (z) => (z + HALF) * k;
    g.textAlign = 'center';
    g.font = `700 ${Math.round(N * 0.02)}px sans-serif`;
    if (game.sectors) {
      for (const s of game.sectors) {
        g.strokeStyle = s.secured ? '#50aaff' : '#ff4646';
        g.fillStyle = s.secured ? 'rgba(80,170,255,0.22)' : 'rgba(255,70,70,0.22)';
        g.lineWidth = 2;
        g.beginPath(); g.arc(X(s.x), Z(s.z), s.r * k, 0, 7); g.fill(); g.stroke();
        g.fillStyle = '#fff';
        g.fillText(s.name, X(s.x), Z(s.z) - s.r * k - 4);
      }
    } else {
      g.fillStyle = '#fff';
      g.fillText('TIMES SQUARE', X(8), Z(-360));
      const bd = game.mode.bounds;
      g.strokeStyle = '#ffb020';
      g.setLineDash([6, 4]);
      g.strokeRect(X(bd.x0), Z(bd.z0), (bd.x1 - bd.x0) * k, (bd.z1 - bd.z0) * k);
      g.setLineDash([]);
    }
    const spots = [];
    for (const st of game.stations) {
      g.fillStyle = '#7dffb0';
      g.strokeStyle = '#06301c';
      g.lineWidth = 2;
      g.beginPath(); g.arc(X(st.x), Z(st.z), N * 0.014, 0, 7); g.fill(); g.stroke();
      spots.push({ st, x: X(st.x) / N, y: Z(st.z) / N });
    }
    for (const a of game.actors) {
      if (!a.alive || a === p || a.team !== MARINES) continue;
      g.fillStyle = '#4db2ff';
      g.beginPath(); g.arc(X(a.x), Z(a.z), N * 0.006, 0, 7); g.fill();
    }
    g.save();
    g.translate(X(p.x), Z(p.z));
    g.rotate(-p.yaw);
    g.fillStyle = '#fff';
    g.strokeStyle = '#000';
    const s = N * 0.016;
    g.beginPath(); g.moveTo(0, -s); g.lineTo(s * 0.7, s * 0.8); g.lineTo(0, s * 0.4); g.lineTo(-s * 0.7, s * 0.8); g.closePath();
    g.fill(); g.stroke();
    g.restore();
    return spots;
  }
}
