// AI soldiers. Perception (field of view, line of sight, hearing), a small
// state machine (patrol / hunt / fight / search), path following on the
// street graph with local unsticking, and burst fire with a hit model that
// depends on range, stance, movement and skill.
import { Actor, STAND, CROUCH, PRONE, MARINES } from './actor.js';
import { WEAPONS, damageAt } from './weapons.js';
import { F_SEE, F_BULLET } from '../core/physics.js';
import { clamp, angleDiff, rand, pick } from '../core/util.js';

export const SKILLS = {
  recruit: { acc: 0.15, react: 0.85, turn: 4.0, burst: [2, 4], pause: [0.7, 1.4] },
  regular: { acc: 0.23, react: 0.6, turn: 5.5, burst: [3, 5], pause: [0.55, 1.1] },
  hardened: { acc: 0.32, react: 0.42, turn: 7.0, burst: [3, 6], pause: [0.4, 0.9] },
  veteran: { acc: 0.42, react: 0.3, turn: 9.0, burst: [4, 7], pause: [0.3, 0.7] },
};
const RUN = 4.5, WALK = 2.4;

export class Bot extends Actor {
  constructor(game, team, name, weaponId, skill = 'regular') {
    super(game, team, name);
    this.skill = SKILLS[skill] || SKILLS.regular;
    this.setWeapon(WEAPONS[weaponId]);
    this.mag = this.def.mag || 0;
    this.role = this.def.cat === 'melee' ? 'rusher' : this.def.cat === 'sniper' ? 'sniper' : 'assault';
    this.sight = this.role === 'sniper' ? 260 : 120;
    this.target = null;
    this.visible = false;
    this.seenT = 99;          // seconds since the target was last seen
    this.lastSeen = { x: 0, z: 0 };
    this.aware = 0;           // 0..1 reaction build-up
    this.alertT = 0;
    this.thinkT = Math.random() * 0.3;
    this.goal = null;         // {x,z}
    this.path = null;
    this.pathI = 0;
    this.repathT = 0;
    this.lane = rand(-1, 1);
    this.strafe = Math.random() < 0.5 ? -1 : 1;
    this.strafeT = rand(0.5, 1.5);
    this.crouchT = 0;
    this.fireCd = rand(0.2, 0.8);
    this.burst = 0;
    this.pauseT = 0;
    this.engageT = 0;
    this.stuckT = 0;
    this.stuckN = 0;
    this.px = 0; this.pz = 0;
    this.sideT = 0; this.sideX = 0; this.sideZ = 0; this.sideSign = 0;
    this.blocker = -1; this.wantX = 0; this.wantZ = 0;
    this.home = null;         // {x,z,r} guards stay near it until alerted
    this.follow = null;       // actor to escort (squad mates)
    this.wander = null;       // function returning the next patrol goal
    this.kind = 'tdm';
    this.far = false;
    this.idleT = 0;
  }

  revive(x, z, yaw) {
    super.revive(x, z, yaw);
    this.mag = this.def.mag || 0;
    this.target = null;
    this.path = null;
    this.goal = null;
    this.aware = 0;
    this.seenT = 99;
    this.burst = 0;
    this.stuckN = 0;
    this.px = x; this.pz = z;
  }

  onHurt(amount, attacker) {
    if (attacker && attacker.alive && attacker.team !== this.team) {
      this.alertT = 4;
      if (!this.visible) {
        this.target = attacker;
        this.lastSeen.x = attacker.x; this.lastSeen.z = attacker.z;
        this.seenT = 0.5;
      }
      if (this.aware < 0.5) this.aware = 0.5;
    }
  }

  /** Someone fired nearby. */
  hear(x, z) {
    if (this.target && this.seenT < 2) return;
    this.alertT = Math.max(this.alertT, 3);
    if (!this.target) {
      this.lastSeen.x = x + rand(-6, 6); this.lastSeen.z = z + rand(-6, 6);
      this.investigate = true;
      this.path = null;
    }
  }

  _canSee(a) {
    const w = this.game.world, b = this.body;
    const ey = this.eyeY();
    return w.clear(b.x, ey, b.z, a.x, a.chestY(), a.z, F_SEE) || w.clear(b.x, ey, b.z, a.x, a.eyeY(), a.z, F_SEE);
  }

  _think() {
    const g = this.game, b = this.body;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    let best = null, bs = Infinity;
    for (const a of g.actors) {
      if (!a.alive || a.team === this.team) continue;
      const dx = a.x - b.x, dz = a.z - b.z, d = Math.hypot(dx, dz);
      if (d > this.sight) continue;
      // outside the field of view only counts when close or already alerted
      if (d > 12 && this.alertT <= 0 && a !== this.target && (dx * fx + dz * fz) / d < 0.2) continue;
      // crouching / prone targets are harder to notice at range
      if (a !== this.target && a.stance !== STAND && d > (a.stance === PRONE ? 45 : 80) && this.alertT <= 0) continue;
      let score = d - (a === this.target ? 10 : 0);
      if (score >= bs) continue;
      if (!this._canSee(a)) continue;
      best = a; bs = score;
    }
    if (best) {
      if (best !== this.target) { this.aware = Math.min(this.aware, 0.35); this.engageT = 0; }
      this.target = best;
      this.visible = true;
      this.seenT = 0;
      this.lastSeen.x = best.x; this.lastSeen.z = best.z;
      this.investigate = false;
    } else {
      this.visible = false;
      if (this.target && (!this.target.alive || this.seenT > 9)) { this.target = null; this.path = null; }
    }
  }

  _setGoal(x, z) {
    this.goal = { x, z };
    const b = this.body;
    const raw = this.game.nav.findPath(b.x, b.z, x, z);
    // shift intermediate waypoints sideways so squads do not walk in single file
    for (let i = 0; i < raw.length - 1; i++) {
      const p0 = i === 0 ? { x: b.x, z: b.z } : raw[i - 1], p1 = raw[i + 1];
      const dx = p1.x - p0.x, dz = p1.z - p0.z, l = Math.hypot(dx, dz) || 1;
      raw[i] = { x: raw[i].x + (-dz / l) * this.lane * 4.5, z: raw[i].z + (dx / l) * this.lane * 4.5 };
    }
    this.path = raw;
    this.pathI = 0;
    this.repathT = rand(4, 7);
  }

  /** Walk the current path. Returns true on arrival. */
  _follow(dt, speed) {
    if (!this.path || this.pathI >= this.path.length) return true;
    const b = this.body, p = this.path[this.pathI];
    let dx = p.x - b.x, dz = p.z - b.z;
    const d = Math.hypot(dx, dz);
    if (d < (this.pathI === this.path.length - 1 ? 2.2 : 4)) {
      this.pathI++;
      return this.pathI >= this.path.length;
    }
    dx /= d; dz /= d;
    this._steer(dt, dx, dz, speed, true);
    return false;
  }

  _steer(dt, dx, dz, speed, face) {
    const b = this.body;
    this.wantX = dx; this.wantZ = dz;
    if (this.sideT > 0) {
      // walk around whatever we were stuck on
      this.sideT -= dt;
      dx = dx * 0.3 + this.sideX; dz = dz * 0.3 + this.sideZ;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
    }
    if (face) this.yaw += angleDiff(this.yaw, Math.atan2(-dx, -dz)) * Math.min(1, dt * 7);
    this.wantMove = true;
    if (this.mantle) { this._updateMantle(dt); return; }
    this.move(dt, dx, dz, speed);
    if (b.hitBox >= 0) this.blocker = b.hitBox;
  }

  _unstick(dt) {
    this.stuckT += dt;
    if (this.stuckT < 0.45) return;
    this.stuckT = 0;
    const b = this.body;
    const moved = Math.hypot(b.x - this.px, b.z - this.pz);
    this.px = b.x; this.pz = b.z;
    if (!this.wantMove || moved > 0.5) { this.stuckN = 0; if (this.sideT <= 0) this.sideSign = 0; return; }
    this.stuckN++;
    if (this.stuckN === 1 && this.tryMantle(1.5)) return;
    if (this.stuckN <= 4) {
      // go round the obstacle by its nearer end, and commit to that side
      const w = this.game.world, i = this.blocker;
      const alongZ = Math.abs(this.wantZ || 0) > Math.abs(this.wantX || 0);
      let side = this.sideSign || (Math.random() < 0.5 ? -1 : 1), dist = 2.5;
      if (i >= 0 && w.flags[i]) {
        const lo = alongZ ? b.x - w.minX[i] : b.z - w.minZ[i], hi = alongZ ? w.maxX[i] - b.x : w.maxZ[i] - b.z;
        if (this.stuckN === 1 || !this.sideSign) side = lo < hi ? -1 : 1;
        dist = Math.min(14, Math.max(1.2, (side < 0 ? lo : hi) + 1.1));
      }
      if (this.stuckN === 3) side = -side; // that way was blocked too: try the other end
      this.sideSign = side;
      this.sideX = alongZ ? side : 0; this.sideZ = alongZ ? 0 : side;
      this.sideT = dist / 4 + 0.25;
      if (this.stuckN === 2 && b.onGround) { b.vy = 5.6; b.onGround = false; }
    } else if (this.stuckN === 5) {
      this.path = null;
      this.lane = rand(-1, 1);
    } else if (this.stuckN > 9) {
      // hopelessly wedged: slip to the nearest street node when nobody is looking
      const n = this.game.nav.nodes[this.game.nav.nearest(b.x, b.z, false)];
      if (n && !this.game.inPlayerView(b.x, b.z)) this.place(n.x + rand(-3, 3), n.z + rand(-3, 3), this.yaw);
      this.stuckN = 0;
      this.path = null;
    }
  }

  // -------------------------------------------------------------------------
  update(dt) {
    const g = this.game, b = this.body;
    this.invuln = Math.max(0, this.invuln - dt);
    if (!this.alive) {
      this.deadT += dt;
      b.vx *= 0.85; b.vz *= 0.85;
      if (this.deadT < 1) g.world.stepBody(b, dt);
      this.speed = 0;
      return;
    }
    this.alertT -= dt;
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = this.far ? 0.6 : 0.22 + Math.random() * 0.08;
      this._think();
    }
    if (this.target) this.seenT += this.visible ? 0 : dt;
    this.wantMove = false;
    this.sprinting = false;
    this.adsK = 0;
    this.repathT -= dt;
    this.fireCd -= dt;
    this.crouchT -= dt;

    if (this.reloadT >= 0) {
      this.reloadT += dt;
      if (this.reloadT >= this.def.reload) { this.reloadT = -1; this.mag = this.def.mag; }
    }
    if (this.meleeT >= 0) {
      this.meleeT += dt;
      if (this.meleeT >= this.def.swing) this.meleeT = -1;
    }

    const t = this.target;
    if (t && t.alive && (this.visible || this.seenT < 1.2)) this._fight(dt, t);
    else if (t && t.alive) this._search(dt);
    else this._roam(dt);

    if (!this.wantMove) {
      if (this.mantle) this._updateMantle(dt);
      else this.move(dt, 0, 0, 0);
    }
    this._unstick(dt);
    if (this.crouchT <= 0 && this.stance === CROUCH && this.role !== 'sniper') this.setStance(STAND);
  }

  _fight(dt, t) {
    const g = this.game, b = this.body, def = this.def, sk = this.skill;
    const dx = t.x - b.x, dz = t.z - b.z, d = Math.hypot(dx, dz) || 0.01;
    const want = Math.atan2(-dx, -dz);
    const err = angleDiff(this.yaw, want);
    this.yaw += clamp(err, -sk.turn * dt, sk.turn * dt);
    this.pitch = Math.atan2(t.chestY() - this.eyeY(), d);
    this.engageT += dt;
    this.aware = Math.min(1, this.aware + dt / sk.react);
    this.adsK = d > 14 || this.role === 'sniper' ? 1 : 0;
    const nx = dx / d, nz = dz / d;

    if (this.role === 'rusher') {
      // zig-zag in, then cut
      this.strafeT -= dt;
      if (this.strafeT <= 0) { this.strafe = -this.strafe; this.strafeT = rand(0.35, 0.8); }
      const k = d > 6 ? 0.45 : 0;
      this.sprinting = d > 5;
      this._steer(dt, nx - nz * this.strafe * k, nz + nx * this.strafe * k, d > 5 ? 6.2 : 5.0, false);
      if (d < def.reach - 0.3 && this.meleeT < 0 && this.fireCd <= 0 && Math.abs(err) < 0.5 && Math.abs(t.y - b.y) < 1.5) {
        this.meleeT = 0;
        this.fireCd = def.swing + 0.5;
        g.audio3d('swish', b.x, b.z);
        // the hit lands a moment later if the victim is still in reach
        g.after(def.hitAt, () => {
          if (!this.alive || !t.alive) return;
          if (Math.hypot(t.x - this.x, t.z - this.z) < def.reach + 0.2) {
            g.fx.blood(t.x, t.chestY(), t.z, nx, 0, nz);
            t.takeDamage(t.isPlayer ? 70 : 150, this, def, false, this.x, this.z);
          }
        });
      }
      return;
    }

    // positioning
    const ideal = this.role === 'sniper' ? [55, 400] : def.cat === 'handgun' ? [6, 22] : [11, 38];
    let mx = 0, mz = 0, sp = 0;
    this.strafeT -= dt;
    if (this.strafeT <= 0) {
      this.strafe = Math.random() < 0.5 ? -1 : 1;
      this.strafeT = rand(0.7, 2.0);
      if (Math.random() < 0.3 && d > 10) { this.setStance(CROUCH); this.crouchT = rand(1, 2.6); }
    }
    if (this.role === 'sniper') {
      if (this.stance === STAND) { this.setStance(CROUCH); this.crouchT = 99; }
      if (d < 22) { mx = -nx; mz = -nz; sp = RUN * 0.8; }
    } else if (d > ideal[1] && this.visible) {
      mx = nx - nz * this.strafe * 0.5; mz = nz + nx * this.strafe * 0.5; sp = RUN;
    } else if (d < ideal[0]) {
      mx = -nx - nz * this.strafe * 0.7; mz = -nz + nx * this.strafe * 0.7; sp = RUN * 0.8;
    } else if (this.stance !== CROUCH) {
      mx = -nz * this.strafe; mz = nx * this.strafe; sp = this.reloadT >= 0 ? RUN : RUN * 0.62;
    }
    // squad mates do not leave their leader, guards do not leave their post
    const anchor = this.follow || this.home;
    if (anchor && sp > 0) {
      const ax = (this.follow ? anchor.x : anchor.x) - b.x, az = (this.follow ? anchor.z : anchor.z) - b.z;
      const ad = Math.hypot(ax, az);
      if (ad > (this.follow ? 28 : (anchor.r || 40) * 1.6)) { mx = ax / ad; mz = az / ad; sp = RUN; }
    }
    if (sp > 0) {
      const l = Math.hypot(mx, mz) || 1;
      this._steer(dt, mx / l, mz / l, sp, false);
    }

    // shooting
    if (this.reloadT >= 0 || !this.visible) return;
    if (this.mag <= 0) { this.reloadT = 0; this.burst = 0; return; }
    if (this.aware < 1 || Math.abs(err) > 0.2) return;
    this.pauseT -= dt;
    if (this.burst <= 0) {
      if (this.pauseT > 0) return;
      this.burst = def.mode === 'auto' ? Math.round(rand(sk.burst[0], sk.burst[1])) : def.mode === 'burst' ? 3 : 1;
      if (this.role === 'sniper' && this.engageT < 1.3) { this.burst = 0; return; }
    }
    if (this.fireCd > 0) return;
    this.fireCd = Math.max(60 / def.rpm, def.mode === 'auto' ? 0.105 : def.mode === 'burst' ? 0.09 : 0.3);
    this.burst--;
    this.mag--;
    if (this.burst <= 0) this.pauseT = this.role === 'sniper' ? rand(1.6, 2.6) : rand(sk.pause[0], sk.pause[1]) * (def.mode === 'auto' ? 1 : 0.7);
    this.lastShotT = g.time;
    this.soldier.kick = 1;

    // hit model
    let p = sk.acc;
    if (this.role === 'sniper') p = clamp(sk.acc * 1.7, 0.2, 0.7) * (d < 30 ? 0.6 : 1);
    else p *= d < 8 ? 1.35 : d < 20 ? 1.35 - (0.35 * (d - 8)) / 12 : d < 45 ? 1 - (0.42 * (d - 20)) / 25 : d < 90 ? 0.58 - (0.3 * (d - 45)) / 45 : 0.2;
    if (t.speed > 5.6) p *= 0.6; else if (t.speed > 2) p *= 0.82;
    if (!t.body.onGround) p *= 0.65;
    if (t.sliding) p *= 0.55;
    if (t.stance === CROUCH) p *= 0.86; else if (t.stance === PRONE) p *= 0.72;
    if (this.speed > 2) p *= 0.8;
    if (this.engageT < 0.7) p *= 0.55;
    const w = g.world;
    const chest = w.clear(b.x, this.eyeY(), b.z, t.x, t.chestY(), t.z, F_BULLET);
    if (!chest) p *= 0.4; // only the head is showing
    if (t.isPlayer) {
      p *= g.threat;                      // difficulty + number of guns already on the player
      if (t.hp < 35) p *= 0.6;            // a little mercy at low health
    } else p *= 0.75;
    g.botShot(this, t, def, Math.random() < p, d, chest);
  }

  _search(dt) {
    // go to where the target was last seen
    this.aware = Math.max(0, this.aware - dt * 0.25);
    if (!this.path || this.repathT <= 0) this._setGoal(this.lastSeen.x, this.lastSeen.z);
    this.sprinting = true;
    if (this._follow(dt, RUN)) {
      // nothing here: look around, then give up
      this.yaw += dt * 1.6;
      if (this.seenT > 6) { this.target = null; this.path = null; }
    }
  }

  _roam(dt) {
    const g = this.game, b = this.body;
    this.aware = Math.max(0, this.aware - dt * 0.4);
    this.pitch *= 0.9;
    if (this.investigate) {
      if (!this.path) this._setGoal(this.lastSeen.x, this.lastSeen.z);
      if (this._follow(dt, RUN)) { this.investigate = false; this.path = null; }
      return;
    }
    if (this.follow) {
      // squad mate: keep a loose formation around the leader
      const l = this.follow;
      const d = Math.hypot(l.x - b.x, l.z - b.z);
      if (d > 90 && !g.inPlayerView(b.x, b.z)) {
        // left behind (fast travel, sprinting leader): catch up out of sight
        const fx = Math.sin(l.yaw), fz = Math.cos(l.yaw);
        const tx = l.x + fx * 9 + rand(-3, 3), tz = l.z + fz * 9 + rand(-3, 3);
        if (g.world.fits(tx, g.world.groundAt(tx, tz), tz, 0.5, 1.9)) this.place(tx, tz, l.yaw);
      } else if (d > 7) {
        if (!this.path || this.repathT <= 0 || Math.hypot(this.goal.x - l.x, this.goal.z - l.z) > 10) {
          const a = this.lane * 2.2 + l.yaw;
          this._setGoal(l.x + Math.sin(a) * 4.5, l.z + Math.cos(a) * 4.5);
        }
        this.sprinting = d > 16;
        this._follow(dt, d > 16 ? 6.4 : RUN);
      } else this.yaw += angleDiff(this.yaw, l.yaw + this.lane * 0.8) * Math.min(1, dt * 3);
      return;
    }
    if (!this.path || this.repathT <= -20) {
      this.idleT -= dt;
      if (this.idleT > 0) { this.yaw += dt * 0.5 * this.strafe; return; }
      const next = this.wander ? this.wander(this) : null;
      if (next) this._setGoal(next.x, next.z);
      else { this.idleT = 2; return; }
    }
    const patrol = this.home && !this.alertT > 0;
    if (this._follow(dt, patrol ? WALK : RUN)) {
      this.path = null;
      this.idleT = this.home ? rand(2, 6) : rand(0, 1.2);
    }
  }
}

export const MARINE_NAMES = ['Sgt. Alvarez', 'Cpl. Nguyen', 'LCpl. Brooks', 'Pfc. Ortiz', 'Cpl. Hayes', 'LCpl. Kim', 'Sgt. Walker', 'Pfc. Rossi'];
export const HOSTILE_NAMES = ['Viper', 'Jackal', 'Wraith', 'Mamba', 'Raven', 'Cobra', 'Hyena', 'Shade', 'Kestrel', 'Lynx', 'Scorpion', 'Fang', 'Moth', 'Onyx', 'Rook', 'Talon'];
export const pickHostileWeapon = () => pick(['ak47', 'ak47', 'ak47', 'm4', 'm4', 'm16', 'm9', 'd50', 'm40', 'knife']);
