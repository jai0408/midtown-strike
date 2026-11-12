// Match orchestration: actors, bullets, grenades, game modes and scoring.
import * as THREE from 'three';
import { Player } from './player.js';
import { Bot, MARINE_NAMES, HOSTILE_NAMES, pickHostileWeapon } from './bot.js';
import { MARINES, HOSTILES, HEAD, LEGS, STAND } from './actor.js';
import { FX } from './fx.js';
import { damageAt, WEAPONS } from './weapons.js';
import { F_BULLET, F_SEE, GRAVITY } from '../core/physics.js';
import { LANDMARKS, HALF, groundAt } from '../world/layout.js';
import { clamp, rand, pick } from '../core/util.js';
import { makeCanvas, toTexture } from '../world/textures.js';

const DIFF = { recruit: 0.7, regular: 1.0, hardened: 1.25, veteran: 1.5 };
const _v = new THREE.Vector3();
const hitCopy = { x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, surf: 0 };

export const MODES = {
  tdm: {
    id: 'tdm', name: 'TEAM DEATHMATCH', place: 'TIMES SQUARE',
    blurb: '6 v 6 in the Times Square bowtie. First team to 30 eliminations wins.',
    scoreLimit: 30, timeLimit: 480,
    bounds: { x0: -160, x1: 180, z0: -215, z1: 215 },
    spawns: [
      [[4, 122], [30, 130], [-5, 150], [42, 104], [-70, 162], [96, 162]],
      [[-4, -108], [-30, -100], [5, -150], [-38, -152], [70, -162], [-96, -162]],
    ],
    hotspots: [[0, 0], [22, 100], [-22, -100], [42, 62], [-30, -60], [4, 150], [-4, -150], [-90, 4], [100, 84], [-26, -128], [60, 2], [-60, 82], [30, -82]],
  },
  sweep: {
    id: 'sweep', name: 'CITY SWEEP', place: 'ALL OF MIDTOWN · 2 SQ MI',
    blurb: 'Open world. Clear every hostile strongpoint across the whole map with your fire team. Subway stations are fast travel.',
    sectors: ['bryantPark', 'heraldSquare', 'grandCentral', 'rockefeller', 'pennPlaza', 'hellsKitchen', 'parkAvenue', 'columbusCircle', 'hudsonYards'],
    garrison: 7,
  },
};

let markerTex = null;
function allyMarker() {
  if (!markerTex) {
    const c = makeCanvas(64, 64), g = c.getContext('2d');
    g.fillStyle = '#3aa0ff';
    g.strokeStyle = '#06203a';
    g.lineWidth = 4;
    g.beginPath(); g.moveTo(10, 14); g.lineTo(54, 14); g.lineTo(32, 52); g.closePath();
    g.fill(); g.stroke();
    markerTex = toTexture(c, { repeat: false, aniso: false });
  }
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: markerTex, depthWrite: false, fog: false, sizeAttenuation: true }));
  s.scale.set(0.34, 0.34, 1);
  s.position.set(0, 2.15, 0);
  s.renderOrder = 7;
  return s;
}

export class Game {
  constructor({ view, city, hud, input, audio, settings }) {
    this.view = view;
    this.scene = view.scene;
    this.camera = view.camera;
    this.city = city;
    this.world = city.world;
    this.nav = city.nav;
    this.hud = hud;
    this.input = input;
    this.audio = audio;
    this.settings = settings;
    this.fx = new FX(this.scene);
    this.fx.setEmitters(city.ctx.emitters);
    this.actors = [];
    this.grenades = [];
    this.timers = [];
    this.time = 0;
    this.running = false;
    this.paused = false;
    this.mode = null;
    this.player = null;
    this.threat = 1;
    this.over = false;
    this.grenadeGeo = new THREE.SphereGeometry(0.075, 8, 6);
    this.grenadeMat = new THREE.MeshLambertMaterial({ color: 0x2c3a22 });
    this.stations = city.ctx.stations;
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------
  start(modeId, loadout) {
    this.stop();
    const mode = (this.mode = MODES[modeId]);
    this.time = 0;
    this.over = false;
    this.paused = false;
    this.running = true;
    this.result = null;
    this.score = [0, 0];
    this.clock = mode.timeLimit || 0;
    this.elapsed = 0;
    this.player = new Player(this, loadout);
    this.actors.push(this.player);
    this.respawnT = 0;
    this.names = { m: 0, h: Math.floor(Math.random() * HOSTILE_NAMES.length) };
    this.prompt = null;
    this.nearStation = null;
    this.objective = null;
    if (modeId === 'tdm') this._setupTdm();
    else this._setupSweep();
    this.hud.begin(this);
    this.audio.startAmbient();
  }

  stop() {
    for (const a of this.actors) a.dispose();
    this.actors.length = 0;
    for (const g of this.grenades) this.scene.remove(g.mesh);
    this.grenades.length = 0;
    this.timers.length = 0;
    this.player = null;
    this.running = false;
    this.audio.stopAmbient();
  }

  after(delay, fn) {
    this.timers.push({ t: delay, fn });
  }

  findFree(x, z, radius = 6) {
    const w = this.world;
    for (let i = 0; i < 24; i++) {
      const r = i === 0 ? 0 : radius * Math.sqrt(i / 24), a = i * 2.4;
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      if (Math.abs(px) > HALF - 4 || Math.abs(pz) > HALF - 4) continue;
      if (w.fits(px, w.groundAt(px, pz), pz, 0.55, 1.9)) return { x: px, z: pz };
    }
    return { x, z };
  }

  spawnBot(team, x, z, yaw, o = {}) {
    const name = o.name || (team === MARINES ? MARINE_NAMES[this.names.m++ % MARINE_NAMES.length] : HOSTILE_NAMES[this.names.h++ % HOSTILE_NAMES.length]);
    const weapon = o.weapon || (team === MARINES ? pick(['m4', 'm4', 'm16', 'm4', 'ak47']) : pickHostileWeapon());
    const bot = new Bot(this, team, name, weapon, o.skill || this.settings.difficulty);
    const p = this.findFree(x, z);
    bot.place(p.x, p.z, yaw);
    bot.px = p.x; bot.pz = p.z;
    Object.assign(bot, { kind: o.kind || 'tdm', home: o.home || null, follow: o.follow || null, wander: o.wander || null, sector: o.sector || null });
    if (team === MARINES) bot.soldier.root.add(allyMarker());
    bot.updateModel(0.016);
    this.actors.push(bot);
    return bot;
  }

  removeActor(a) {
    const i = this.actors.indexOf(a);
    if (i >= 0) this.actors.splice(i, 1);
    a.dispose();
  }

  // -------------------------------------------------------------------------
  // Team Deathmatch
  // -------------------------------------------------------------------------
  _setupTdm() {
    const m = this.mode;
    const s0 = m.spawns[0], s1 = m.spawns[1];
    this.player.revive(s0[0][0], s0[0][1], 0);
    const wander = (bot) => {
      // head for the fighting: a living enemy's rough position, or a hotspot
      const foes = this.actors.filter((a) => a.alive && a.team !== bot.team);
      if (foes.length && Math.random() < 0.7) {
        const f = pick(foes);
        return { x: clamp(f.x + rand(-14, 14), m.bounds.x0 + 8, m.bounds.x1 - 8), z: clamp(f.z + rand(-14, 14), m.bounds.z0 + 8, m.bounds.z1 - 8) };
      }
      const h = pick(m.hotspots);
      return { x: h[0] + rand(-6, 6), z: h[1] + rand(-6, 6) };
    };
    for (let i = 1; i < 6; i++) this.spawnBot(MARINES, s0[i % 3][0] + rand(-7, 7), s0[i % 3][1] + rand(-5, 5), 0, { wander });
    for (let i = 0; i < 6; i++) this.spawnBot(HOSTILES, s1[i % 3][0] + rand(-7, 7), s1[i % 3][1] + rand(-5, 5), Math.PI, { wander });
    this.hud.banner('TEAM DEATHMATCH', 'First to ' + m.scoreLimit + ' eliminations');
  }

  _tdmSpawn(team) {
    const list = this.mode.spawns[team];
    let best = list[0], bd = -1;
    for (const s of list) {
      let d = Infinity;
      for (const a of this.actors) if (a.alive && a.team !== team) d = Math.min(d, Math.hypot(a.x - s[0], a.z - s[1]));
      d += rand(0, 25);
      if (d > bd) { bd = d; best = s; }
    }
    return this.findFree(best[0] + rand(-6, 6), best[1] + rand(-5, 5));
  }

  _updateTdm(dt) {
    const m = this.mode, p = this.player;
    this.clock -= dt;
    // respawns
    for (const a of this.actors) {
      if (a.alive || a.isPlayer) continue;
      if (a.deadT > 4) {
        const s = this._tdmSpawn(a.team);
        a.revive(s.x, s.z, a.team === MARINES ? 0 : Math.PI);
      }
    }
    // leaving the combat zone
    const b = m.bounds;
    if (p.alive && (p.x < b.x0 || p.x > b.x1 || p.z < b.z0 || p.z > b.z1)) {
      p.oobT += dt;
      this.hud.warn('RETURN TO THE COMBAT ZONE  ' + Math.max(0, Math.ceil(6 - p.oobT)));
      if (p.oobT > 6) p.takeDamage(999, null, null, false, p.x, p.z);
    } else if (p.oobT > 0) { p.oobT = 0; this.hud.warn(null); }
    if (!this.over) {
      if (this.score[0] >= m.scoreLimit || this.score[1] >= m.scoreLimit || this.clock <= 0) {
        this.finish(this.score[0] > this.score[1] ? 'VICTORY' : this.score[0] < this.score[1] ? 'DEFEAT' : 'DRAW');
      }
    }
  }

  // -------------------------------------------------------------------------
  // City Sweep (open world)
  // -------------------------------------------------------------------------
  _setupSweep() {
    const m = this.mode, p = this.player;
    this.sectors = m.sectors.map((key) => ({ key, name: LANDMARKS[key].name, x: LANDMARKS[key].x, z: LANDMARKS[key].z, r: 58, remaining: m.garrison, secured: false, bots: [], spawnT: 0 }));
    this.base = { x: 8, z: 150 };
    p.revive(this.base.x, this.base.z, 0);
    this.squad = [];
    for (let i = 0; i < 2; i++) this._spawnSquadMate(i);
    this.patrolT = 26;
    this.squadT = 0;
    this.hud.banner('CITY SWEEP', 'Clear all ' + this.sectors.length + ' hostile strongpoints');
  }

  _spawnSquadMate(i) {
    const p = this.player;
    const a = p.yaw + (i ? 2.4 : -2.4);
    const bot = this.spawnBot(MARINES, p.x + Math.sin(a) * 3.5, p.z + Math.cos(a) * 3.5, p.yaw, { kind: 'squad', follow: p, weapon: i ? 'm16' : 'm4', skill: 'hardened' });
    bot.lane = i ? 1 : -1;
    bot.maxHp = bot.hp = 160;
    this.squad[i] = bot;
  }

  _hiddenSpot(cx, cz, rMin, rMax) {
    for (let k = 0; k < 14; k++) {
      const a = rand(0, 6.283), r = rand(rMin, rMax);
      const x = clamp(cx + Math.cos(a) * r, -HALF + 6, HALF - 6), z = clamp(cz + Math.sin(a) * r, -HALF + 6, HALF - 6);
      if (!this.world.fits(x, this.world.groundAt(x, z), z, 0.6, 1.9)) continue;
      if (k < 10 && this.inPlayerView(x, z)) continue;
      return { x, z };
    }
    return null;
  }

  _updateSweep(dt) {
    const p = this.player;
    this.elapsed += dt;
    let nearest = null, nd = Infinity, left = 0;
    for (const s of this.sectors) {
      if (s.secured) continue;
      left++;
      const d = Math.hypot(p.x - s.x, p.z - s.z);
      if (d < nd) { nd = d; nearest = s; }
      const alive = s.bots.filter((b) => b.alive).length;
      s.spawnT -= dt;
      if (d < 210 && alive < Math.min(5, s.remaining) && s.spawnT <= 0) {
        const spot = this._hiddenSpot(s.x, s.z, 4, 46);
        if (spot) {
          const home = { x: s.x, z: s.z, r: 42 };
          const bot = this.spawnBot(HOSTILES, spot.x, spot.z, rand(0, 6.28), {
            kind: 'garrison', home, sector: s,
            wander: () => this.findFree(s.x + rand(-38, 38), s.z + rand(-38, 38), 5),
          });
          s.bots.push(bot);
          s.spawnT = alive < 2 ? 0.2 : 2.5;
        }
      }
      if (d > 340 && s.bots.length) {
        for (const b of s.bots) this.removeActor(b);
        s.bots.length = 0;
      }
    }
    this.objective = nearest ? { x: nearest.x, z: nearest.z, name: nearest.name, dist: nd, left, remaining: nearest.remaining } : null;

    // roaming patrols keep the streets between strongpoints dangerous
    this.patrolT -= dt;
    if (this.patrolT <= 0 && p.alive) {
      this.patrolT = rand(24, 42);
      const hostiles = this.actors.filter((a) => a.team === HOSTILES && a.alive).length;
      const inSector = nd < 90;
      if (hostiles < (inSector ? 6 : 5)) {
        const node = this.nav.randomNode(p.x, p.z, 75, 150);
        if (node && !this.inPlayerView(node.x, node.z)) {
          const n = 2 + (Math.random() < 0.4 ? 1 : 0);
          for (let i = 0; i < n; i++) {
            this.spawnBot(HOSTILES, node.x + rand(-5, 5), node.z + rand(-5, 5), 0, {
              kind: 'patrol', weapon: pick(['ak47', 'm4', 'ak47', 'm16', 'knife', 'm9']),
              wander: () => ({ x: p.x + rand(-12, 12), z: p.z + rand(-12, 12) }),
            });
          }
        }
      }
    }
    // clean up bodies and far-away patrols
    for (let i = this.actors.length - 1; i >= 0; i--) {
      const a = this.actors[i];
      if (a.isPlayer || a.team !== HOSTILES) continue;
      const far = Math.hypot(a.x - p.x, a.z - p.z) > 360;
      if ((!a.alive && a.deadT > 9) || (a.kind === 'patrol' && far)) {
        if (a.sector) { const k = a.sector.bots.indexOf(a); if (k >= 0) a.sector.bots.splice(k, 1); }
        this.removeActor(a);
      }
    }
    // fallen squad mates rejoin after a while
    for (let i = 0; i < this.squad.length; i++) {
      const s = this.squad[i];
      if (!s.alive && s.deadT > 18 && p.alive) {
        const spot = this._hiddenSpot(p.x, p.z, 8, 22) || this.findFree(p.x - Math.sin(p.yaw) * -6, p.z - Math.cos(p.yaw) * -6);
        s.revive(spot.x, spot.z, p.yaw);
        this.hud.toast(s.name + ' rejoined the fire team', null, 'info');
      }
    }
    // fast travel prompt
    this.nearStation = null;
    if (p.alive) {
      for (const st of this.stations) {
        if (Math.abs(st.x - p.x) < 3.4 && Math.abs(st.z - p.z) < 3.4) { this.nearStation = st; break; }
      }
    }
    this.hud.setPrompt(this.nearStation ? 'SUBWAY · FAST TRAVEL + RESUPPLY' : null);
    if (this.nearStation && this.input.pressed.interact) this.hud.openTravel(this);
    if (!left && !this.over) this.finish('MISSION COMPLETE');
  }

  travelTo(st) {
    const p = this.player;
    const spot = this.findFree(st.x, st.z, 4);
    p.place(spot.x, spot.z, p.yaw);
    p.camY = p.body.y + 1.6;
    p.resupply();
    p.hp = p.maxHp;
    this.squad.forEach((s, i) => {
      if (!s.alive) return;
      const q = this.findFree(spot.x + (i ? 3 : -3), spot.z + 3, 4);
      s.place(q.x, q.z, p.yaw);
      s.path = null; s.target = null;
    });
    this.audio.pickup();
    this.hud.toast('ARRIVED: ' + st.name, 'Ammo and grenades restocked', 'info');
  }

  // -------------------------------------------------------------------------
  // per-frame
  // -------------------------------------------------------------------------
  update(dt) {
    if (!this.running || this.paused) return;
    this.time += dt;
    const p = this.player, input = this.input;
    for (let i = this.timers.length - 1; i >= 0; i--) {
      const t = this.timers[i];
      t.t -= dt;
      if (t.t <= 0) { this.timers.splice(i, 1); t.fn(); }
    }
    // how hard the bots press the player: difficulty, shared out over attackers
    let guns = 0;
    for (const a of this.actors) if (!a.isPlayer && a.alive && a.target === p && a.visible) guns++;
    this.threat = (DIFF[this.settings.difficulty] || 1) / (1 + Math.max(0, guns - 1) * 0.3);

    p.update(dt, this.over ? this.input.idle : input);
    const cam = this.camera.position;
    for (const a of this.actors) {
      if (a.isPlayer) continue;
      const d = Math.hypot(a.x - cam.x, a.z - cam.z);
      a.far = d > 150;
      a.update(dt);
      a.soldier.root.visible = d < 520;
      a.updateModel(dt, d < 170);
    }
    // keep bodies from overlapping
    const A = this.actors;
    for (let i = 0; i < A.length; i++) {
      const a = A[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < A.length; j++) {
        const b = A[j];
        if (!b.alive) continue;
        const dx = b.body.x - a.body.x, dz = b.body.z - a.body.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > 0.64 || d2 < 1e-6 || Math.abs(a.body.y - b.body.y) > 1.5) continue;
        const d = Math.sqrt(d2), push = (0.8 - d) * 0.5;
        const wa = a.isPlayer ? 0.25 : b.isPlayer ? 0.75 : 0.5;
        a.body.x -= (dx / d) * push * wa * 2; a.body.z -= (dz / d) * push * wa * 2;
        b.body.x += (dx / d) * push * (1 - wa) * 2; b.body.z += (dz / d) * push * (1 - wa) * 2;
      }
    }
    this._updateGrenades(dt);

    // player death and respawn
    if (!p.alive && !this.over) {
      this.respawnT -= dt;
      if (this.respawnT <= 0) this._respawnPlayer();
    }
    if (this.mode.id === 'tdm') this._updateTdm(dt);
    else this._updateSweep(dt);

    this.fx.update(dt, this.camera, this.view.renderer.domElement.height);
    this.city.update(dt, cam, this.view.quality.draw);
    this.audio.updateAmbient(dt);
    this.hud.update(this, dt);
  }

  _respawnPlayer() {
    const p = this.player;
    let s;
    if (this.mode.id === 'tdm') s = this._tdmSpawn(MARINES);
    else {
      // nearest secured strongpoint, else the Times Square base
      let best = this.base, bd = Math.hypot(p.x - best.x, p.z - best.z);
      for (const q of this.sectors) {
        if (!q.secured) continue;
        const d = Math.hypot(p.x - q.x, p.z - q.z);
        if (d < bd) { bd = d; best = q; }
      }
      s = this.findFree(best.x + rand(-5, 5), best.z + rand(-5, 5), 12);
      // bots forget about a dead player
      for (const a of this.actors) if (!a.isPlayer && a.target === p) { a.target = null; a.path = null; }
    }
    p.revive(s.x, s.z, this.mode.id === 'tdm' ? 0 : p.yaw);
    this.input.ads = false;
    this.hud.respawned();
  }

  inPlayerView(x, z) {
    const cam = this.camera.position, p = this.player;
    const dx = x - cam.x, dz = z - cam.z, d = Math.hypot(dx, dz);
    if (d < 18) return true;
    if (d > 420) return false;
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    if ((dx * fx + dz * fz) / d < 0.25) return false;
    return this.world.clear(cam.x, cam.y, cam.z, x, groundAt(x, z) + 1.3, z, F_SEE);
  }

  // -------------------------------------------------------------------------
  // combat
  // -------------------------------------------------------------------------
  audio3d(kind, x, z) {
    const cam = this.camera.position;
    const dx = x - cam.x, dz = z - cam.z, d = Math.hypot(dx, dz);
    if (d > 420) return;
    const yaw = this.player ? this.player.yaw : 0;
    const pan = d > 0.5 ? clamp((dx * Math.cos(yaw) - dz * Math.sin(yaw)) / d, -1, 1) * 0.85 : 0;
    if (kind === 'explosion') this.audio.explosion(d, pan);
    else if (kind === 'swish') { if (d < 25) this.audio.swish(); }
    else this.audio.shot(kind, d, pan);
  }

  noise(x, z, team, radius) {
    for (const a of this.actors) {
      if (a.isPlayer || !a.alive || a.team === team) continue;
      if (Math.abs(a.x - x) < radius && Math.abs(a.z - z) < radius) a.hear(x, z);
    }
  }

  playerShot(p, dx, dy, dz, def) {
    const w = this.world, cam = this.camera.position;
    const ex = p.x, ey = p.eyeY(), ez = p.z;
    // start level with the player so nothing between camera and player is hit
    const s0 = Math.max(0, (ex - cam.x) * dx + (ey - cam.y) * dy + (ez - cam.z) * dz);
    const sx = cam.x + dx * s0, sy = cam.y + dy * s0, sz = cam.z + dz * s0;
    let tW = w.raycast(sx, sy, sz, dx, dy, dz, def.range, F_BULLET);
    let worldHit = tW < Infinity;
    if (worldHit) Object.assign(hitCopy, w.hit);
    let bt = worldHit ? tW : def.range, best = null, part = 1;
    for (const a of this.actors) {
      if (!a.alive || a.team === p.team) continue;
      const t = a.rayHit(sx, sy, sz, dx, dy, dz, bt);
      if (t >= 0 && t < bt) { bt = t; best = a; part = a.hitPart; }
    }
    let hx = sx + dx * bt, hy = sy + dy * bt, hz = sz + dz * bt;
    // the bullet really leaves from the weapon: cover in front of it stops the shot
    const mx = hx - ex, my = hy - ey, mz = hz - ez, ml = Math.hypot(mx, my, mz);
    if (ml > 1.2) {
      const t2 = w.raycast(ex, ey, ez, mx / ml, my / ml, mz / ml, ml - 0.5, F_BULLET);
      if (t2 < ml - 0.5) {
        Object.assign(hitCopy, w.hit);
        worldHit = true; best = null;
        hx = hitCopy.x; hy = hitCopy.y; hz = hitCopy.z;
      }
    }
    // tracer from the muzzle
    const muz = p.scoped ? _v.set(ex + dx * 0.6, ey - 0.08, ez + dz * 0.6) : p.soldier.muzzleWorld(_v);
    this.fx.tracer(muz.x, muz.y, muz.z, hx, hy, hz, true, !!def.scope);
    if (!p.scoped) this.fx.muzzle(muz.x, muz.y, muz.z, !!def.scope);
    if (best) {
      const dist = Math.hypot(hx - ex, hy - ey, hz - ez);
      const head = part === HEAD;
      const dmg = damageAt(def, dist) * (head ? def.head : part === LEGS ? def.limb : 1);
      this.fx.blood(hx, hy, hz, dx, dy, dz);
      p.stats.hits++;
      p.stats.damage += Math.min(dmg, best.hp);
      if (head) p.stats.headshots++;
      const killed = best.takeDamage(dmg, p, def, head, ex, ez);
      this.hud.hitMarker(killed, head);
      this.audio.hit(head);
    } else if (worldHit) {
      this.fx.impact(hitCopy.x, hitCopy.y, hitCopy.z, hitCopy.nx, hitCopy.ny, hitCopy.nz, hitCopy.surf);
    }
  }

  botShot(bot, t, def, hit, d, chestVisible) {
    const w = this.world, cam = this.camera.position;
    const near = Math.hypot(bot.x - cam.x, bot.z - cam.z) < 170;
    const muz = near ? bot.soldier.muzzleWorld(_v) : _v.set(bot.x, bot.eyeY(), bot.z);
    const mx = muz.x, my = muz.y, mz = muz.z;
    let ex, ey, ez;
    if (hit) {
      const r = Math.random();
      const head = !chestVisible ? r < 0.6 : r < 0.07;
      const legs = !head && r > 0.76;
      ex = t.x + rand(-0.12, 0.12); ez = t.z + rand(-0.12, 0.12);
      ey = head ? t.eyeY() + 0.06 : legs ? t.y + 0.5 : t.chestY() + rand(-0.15, 0.15);
      let dmg = damageAt(def, d) * (head ? def.head : legs ? def.limb : 1);
      if (t.isPlayer && def.scope) dmg = Math.min(dmg, 85); // never one-shot the player out of nowhere
      const dx = ex - mx, dz = ez - mz, l = Math.hypot(dx, dz) || 1;
      this.fx.blood(ex, ey, ez, dx / l, 0, dz / l);
      t.takeDamage(dmg, bot, def, head, bot.x, bot.z);
    } else {
      // a near miss, carried on to whatever is behind the target
      const a = rand(0, 6.283), off = rand(0.55, 1.7);
      const tx = t.x + Math.cos(a) * off, ty = t.chestY() + Math.sin(a) * off * 0.7, tz = t.z + Math.sin(a) * off;
      let dx = tx - mx, dy = ty - my, dz = tz - mz;
      const l = Math.hypot(dx, dy, dz) || 1;
      dx /= l; dy /= l; dz /= l;
      const tw = w.raycast(mx, my, mz, dx, dy, dz, l + 60, F_BULLET);
      const e = Math.min(tw, l + 60);
      ex = mx + dx * e; ey = my + dy * e; ez = mz + dz * e;
      if (tw < Infinity && near) this.fx.impact(w.hit.x, w.hit.y, w.hit.z, w.hit.nx, w.hit.ny, w.hit.nz, w.hit.surf);
      if (t.isPlayer && Math.random() < 0.55) this.audio.whiz(rand(-0.8, 0.8));
    }
    this.fx.tracer(mx, my, mz, ex, ey, ez, bot.team === MARINES, !!def.scope);
    if (near) this.fx.muzzle(mx, my, mz, !!def.scope);
    this.audio3d(def.sound, bot.x, bot.z);
    this.noise(bot.x, bot.z, bot.team, 55);
  }

  throwGrenade(owner, x, y, z, vx, vy, vz) {
    const mesh = new THREE.Mesh(this.grenadeGeo, this.grenadeMat);
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
    this.grenades.push({ owner, x, y, z, vx, vy, vz, fuse: 2.6, mesh, rest: false });
  }

  _updateGrenades(dt) {
    const w = this.world;
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      g.fuse -= dt;
      if (g.fuse <= 0) {
        this.scene.remove(g.mesh);
        this.grenades.splice(i, 1);
        this.explode(g.x, g.y, g.z, g.owner);
        continue;
      }
      if (!g.rest) {
        g.vy -= GRAVITY * dt;
        let remaining = dt;
        for (let k = 0; k < 3 && remaining > 1e-5; k++) {
          const sp = Math.hypot(g.vx, g.vy, g.vz);
          if (sp < 1e-4) break;
          const dx = g.vx / sp, dy = g.vy / sp, dz = g.vz / sp, step = sp * remaining;
          const t = w.raycast(g.x, g.y, g.z, dx, dy, dz, step + 0.08, F_BULLET);
          if (t > step + 0.08) {
            g.x += dx * step; g.y += dy * step; g.z += dz * step;
            break;
          }
          const move = Math.max(0, t - 0.08);
          g.x += dx * move; g.y += dy * move; g.z += dz * move;
          remaining -= move / sp;
          // bounce
          const h = w.hit, vn = g.vx * h.nx + g.vy * h.ny + g.vz * h.nz;
          g.vx = (g.vx - 1.42 * vn * h.nx) * 0.72; g.vy = (g.vy - 1.42 * vn * h.ny) * 0.72; g.vz = (g.vz - 1.42 * vn * h.nz) * 0.72;
          if (Math.abs(vn) > 1.5) this.audio.bounce(Math.hypot(g.x - this.camera.position.x, g.z - this.camera.position.z));
          if (h.ny > 0.7 && Math.hypot(g.vx, g.vy, g.vz) < 1.1) { g.rest = true; g.vx = g.vy = g.vz = 0; break; }
        }
      }
      g.mesh.position.set(g.x, g.y, g.z);
    }
  }

  explode(x, y, z, owner) {
    const R = 7.5, w = this.world;
    this.fx.explosion(x, y, z);
    this.audio3d('explosion', x, z);
    const cam = this.camera.position;
    const cd = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
    this.fx.shake = Math.max(this.fx.shake, clamp(1.4 - cd / 22, 0, 1));
    for (const a of this.actors.slice()) {
      if (!a.alive) continue;
      const d = Math.hypot(a.x - x, a.chestY() - y, a.z - z);
      if (d > R) continue;
      if (owner && a.team === owner.team && a !== owner) continue;
      let dmg = 170 * (1 - d / R) + 12;
      if (!w.clear(x, y + 0.5, z, a.x, a.chestY(), a.z, F_BULLET)) dmg *= 0.2;
      if (a === owner) dmg *= 0.6;
      const killed = a.takeDamage(dmg, owner, { name: 'Frag Grenade', id: 'frag' }, false, x, z);
      if (owner && owner.isPlayer && a !== owner) this.hud.hitMarker(killed, false);
    }
    this.noise(x, z, -1, 90);
  }

  onKill(attacker, victim, def, head) {
    if (attacker && attacker !== victim) attacker.kills++;
    const weapon = def ? def.name : '';
    this.hud.feed(attacker && attacker !== victim ? attacker.name : null, weapon, victim.name, attacker ? attacker.team : victim.team, victim.team, head);
    if (this.mode.id === 'tdm') {
      if (attacker && attacker.team !== victim.team) this.score[attacker.team]++;
      else if (!attacker || attacker === victim) this.score[1 - victim.team]++; // suicide / out of bounds
    } else if (victim.sector && !victim.sector.secured) {
      const s = victim.sector;
      s.remaining = Math.max(0, s.remaining - 1);
      if (s.remaining === 0) {
        s.secured = true;
        this.player.resupply();
        this.audio.objective();
        const left = this.sectors.filter((q) => !q.secured).length;
        this.hud.banner(s.name + ' SECURED', left ? left + ' strongpoint' + (left > 1 ? 's' : '') + ' remaining · ammo restocked' : 'All strongpoints cleared');
      }
    }
    const p = this.player;
    if (attacker === p && victim !== p) {
      this.audio.kill();
      this.hud.toast(head ? 'HEADSHOT' : 'ELIMINATED', victim.name, head ? 'head' : 'kill');
      // scavenge a little ammunition from every kill
      for (const s of p.slots) if (s.def.mag) s.reserve = Math.min(s.def.reserve, s.reserve + Math.ceil(s.def.mag * 0.4));
      if (p.kills % 5 === 0 && p.grenades < 3) { p.grenades++; this.hud.toast('GRENADE +1', null, 'info'); }
    }
    if (victim === p) {
      this.respawnT = this.mode.id === 'tdm' ? 3.5 : 4.5;
      this.input.ads = false;
      this.hud.died(attacker && attacker !== p ? attacker.name : null, weapon, this.respawnT);
    }
  }

  finish(text) {
    if (this.over) return;
    this.over = true;
    const p = this.player;
    this.result = {
      title: text, mode: this.mode.name,
      win: text === 'VICTORY' || text === 'MISSION COMPLETE',
      score: this.mode.id === 'tdm' ? this.score.slice() : null,
      kills: p.kills, deaths: p.deaths,
      accuracy: p.stats.shots ? Math.round((100 * p.stats.hits) / p.stats.shots) : 0,
      headshots: p.stats.headshots,
      time: this.mode.id === 'tdm' ? this.mode.timeLimit - Math.max(0, this.clock) : this.elapsed,
    };
    if (this.result.win) this.audio.objective(); else this.audio.defeat();
    this.after(1.6, () => this.hud.results(this.result));
  }
}
