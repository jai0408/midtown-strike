// Shared base for the player and the bots: collision body, stances, mantling,
// hit volumes, health and the link to the animated soldier model.
import { makeBody, raySphere, rayCapsule, F_SOLID, STEP_HEIGHT } from '../core/physics.js';
import { Soldier } from '../chars/soldier.js';
import { clamp, lerp, smooth, damp } from '../core/util.js';

export const STAND = 0, CROUCH = 1, PRONE = 2;
export const HEIGHTS = [1.8, 1.2, 0.62];
export const EYES = [1.6, 1.08, 0.38];
export const HEAD = 0, TORSO = 1, LEGS = 2;
export const MARINES = 0, HOSTILES = 1;

export class Actor {
  constructor(game, team, name) {
    this.game = game;
    this.team = team;
    this.name = name;
    this.isPlayer = false;
    this.body = makeBody(0.38, HEIGHTS[STAND]);
    this.soldier = new Soldier(team === MARINES ? 'marine' : 'enemy');
    game.scene.add(this.soldier.root);
    this.yaw = 0;
    this.pitch = 0;
    this.stance = STAND;
    this.maxHp = 100;
    this.hp = 100;
    this.alive = true;
    this.deadT = 0;
    this.deadDir = 1;
    this.kills = 0;
    this.deaths = 0;
    this.def = null;         // current weapon
    this.reloadT = -1;       // seconds into the reload, -1 when idle
    this.meleeT = -1;
    this.adsK = 0;
    this.sprinting = false;
    this.sliding = false;
    this.mantle = null;
    this.speed = 0;          // horizontal speed (m/s)
    this.localX = 0;         // movement direction in model space
    this.localZ = 0;
    this.lastHurtT = -99;
    this.lastShotT = -99;
    this.invuln = 0;
    this.hitPart = TORSO;
    this.modelY = 0;
    this._q = [];
  }

  get x() { return this.body.x; }
  get y() { return this.body.y; }
  get z() { return this.body.z; }
  eyeY() { return this.body.y + (this.sliding ? 0.95 : EYES[this.stance]); }
  chestY() { return this.body.y + (this.stance === PRONE ? 0.28 : this.stance === CROUCH ? 0.8 : 1.25); }

  setWeapon(def) {
    this.def = def;
    this.soldier.setWeapon(def);
  }

  place(x, z, yaw = 0) {
    const b = this.body;
    b.x = x; b.z = z;
    b.y = this.game.world.supportAt(x, z, 0.3, b.radius);
    b.vx = b.vy = b.vz = 0;
    b.onGround = true;
    this.yaw = yaw;
    this.pitch = 0;
    this.modelY = b.y;
    this.mantle = null;
  }

  revive(x, z, yaw) {
    this.alive = true;
    this.hp = this.maxHp;
    this.deadT = 0;
    this.stance = STAND;
    this.body.height = HEIGHTS[STAND];
    this.reloadT = -1;
    this.meleeT = -1;
    this.sliding = false;
    this.sprinting = false;
    this.adsK = 0;
    this.invuln = 1.2;
    this.soldier.root.visible = true;
    this.place(x, z, yaw);
  }

  /** Returns false when there is no head room to rise. */
  setStance(s) {
    if (s === this.stance) return true;
    const b = this.body;
    if (HEIGHTS[s] > b.height && !this.game.world.fits(b.x, b.y, b.z, b.radius * 0.8, HEIGHTS[s])) return false;
    this.stance = s;
    b.height = HEIGHTS[s];
    return true;
  }

  /** Steer towards a world-space velocity and integrate one step. */
  move(dt, wx, wz, speed) {
    const b = this.body;
    const k = Math.min(1, (b.onGround ? 13 : 2.2) * dt);
    b.vx += (wx * speed - b.vx) * k;
    b.vz += (wz * speed - b.vz) * k;
    this.game.world.stepBody(b, dt);
    this._kinematics();
  }

  _kinematics() {
    const b = this.body;
    this.speed = Math.hypot(b.vx, b.vz);
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    // world -> model space (model faces -Z, yaw about +Y)
    this.localX = b.vx * c - b.vz * s;
    this.localZ = b.vx * s + b.vz * c;
  }

  /** Vault or climb the obstacle straight ahead, if there is one of the right height. */
  tryMantle(maxRise = 1.9) {
    if (this.mantle) return false;
    const b = this.body, w = this.game.world;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const px = b.x + fx * (b.radius + 0.45), pz = b.z + fz * (b.radius + 0.45);
    const q = w.query(px - 0.42, pz - 0.42, px + 0.42, pz + 0.42, this._q);
    let top = -1;
    for (let j = 0; j < q.length; j++) {
      const i = q[j];
      if (!(w.flags[i] & F_SOLID)) continue;
      const rel = w.maxY[i] - b.y;
      if (w.minY[i] > b.y + 1.3) continue;
      if (rel > maxRise) return false;            // a wall: nothing to climb
      if (rel > STEP_HEIGHT + 0.05 && w.maxY[i] > top) top = w.maxY[i];
    }
    if (top < 0) return false;
    const tx = b.x + fx * 1.35, tz = b.z + fz * 1.35;
    if (!w.fits(tx, top + 0.03, tz, b.radius * 0.85, 1.15)) return false;
    this.mantle = { t: 0, dur: 0.3 + (top - b.y) * 0.12, x0: b.x, y0: b.y, z0: b.z, x1: tx, y1: top + 0.03, z1: tz };
    this.sliding = false;
    return true;
  }

  _updateMantle(dt) {
    const m = this.mantle, b = this.body;
    m.t += dt;
    const k = clamp(m.t / m.dur, 0, 1);
    const up = smooth(clamp(k / 0.65, 0, 1)), fwd = smooth(clamp((k - 0.3) / 0.7, 0, 1));
    b.x = lerp(m.x0, m.x1, fwd);
    b.z = lerp(m.z0, m.z1, fwd);
    b.y = lerp(m.y0, m.y1, up);
    b.vy = 0;
    if (k >= 1) {
      const fx = (m.x1 - m.x0), fz = (m.z1 - m.z0), l = Math.hypot(fx, fz) || 1;
      b.vx = (fx / l) * 3; b.vz = (fz / l) * 3;
      b.onGround = false;
      this.mantle = null;
    }
    this._kinematics();
  }

  /**
   * Ray vs. this actor's hit volumes. Returns the entry distance or -1 and
   * records the body part in this.hitPart.
   */
  rayHit(ox, oy, oz, dx, dy, dz, maxT) {
    const b = this.body;
    // coarse reject against a bounding sphere
    const cx = b.x - ox, cy = b.y + 0.9 - oy, cz = b.z - oz;
    const along = cx * dx + cy * dy + cz * dz;
    if (along < -1.5 || along > maxT + 1.5) return -1;
    const perp2 = cx * cx + cy * cy + cz * cz - along * along;
    if (perp2 > 1.7 * 1.7) return -1;
    let best = -1, part = TORSO;
    const test = (t, p) => { if (t >= 0 && t <= maxT && (best < 0 || t < best)) { best = t; part = p; } };
    const st = this.sliding ? CROUCH : this.stance;
    if (st === PRONE) {
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      test(raySphere(ox, oy, oz, dx, dy, dz, b.x + fx * 0.78, b.y + 0.36, b.z + fz * 0.78, 0.17), HEAD);
      test(rayCapsule(ox, oy, oz, dx, dy, dz, b.x + fx * 0.05, b.y + 0.24, b.z + fz * 0.05, b.x + fx * 0.6, b.y + 0.3, b.z + fz * 0.6, 0.23), TORSO);
      test(rayCapsule(ox, oy, oz, dx, dy, dz, b.x - fx * 0.95, b.y + 0.14, b.z - fz * 0.95, b.x, b.y + 0.2, b.z, 0.18), LEGS);
    } else if (st === CROUCH) {
      const fx = -Math.sin(this.yaw) * 0.1, fz = -Math.cos(this.yaw) * 0.1;
      test(raySphere(ox, oy, oz, dx, dy, dz, b.x + fx, b.y + 1.27, b.z + fz, 0.17), HEAD);
      test(rayCapsule(ox, oy, oz, dx, dy, dz, b.x, b.y + 0.6, b.z, b.x + fx, b.y + 1.06, b.z + fz, 0.25), TORSO);
      test(rayCapsule(ox, oy, oz, dx, dy, dz, b.x, b.y + 0.16, b.z, b.x, b.y + 0.55, b.z, 0.27), LEGS);
    } else {
      test(raySphere(ox, oy, oz, dx, dy, dz, b.x, b.y + 1.68, b.z, 0.17), HEAD);
      test(rayCapsule(ox, oy, oz, dx, dy, dz, b.x, b.y + 0.98, b.z, b.x, b.y + 1.46, b.z, 0.25), TORSO);
      test(rayCapsule(ox, oy, oz, dx, dy, dz, b.x, b.y + 0.2, b.z, b.x, b.y + 0.92, b.z, 0.2), LEGS);
    }
    this.hitPart = part;
    return best;
  }

  takeDamage(amount, attacker, def, head = false, fromX = 0, fromZ = 0) {
    if (!this.alive || this.invuln > 0) return false;
    this.hp -= amount;
    this.lastHurtT = this.game.time;
    this.soldier.flinch = Math.random() < 0.5 ? 1 : -1;
    this.onHurt(amount, attacker, fromX, fromZ);
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this.deadT = 0;
      this.deaths++;
      // fall away from the shot
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      const dx = this.body.x - fromX, dz = this.body.z - fromZ;
      this.deadDir = dx * fx + dz * fz > 0 ? -1 : 1;
      this.reloadT = -1;
      this.meleeT = -1;
      this.mantle = null;
      this.sliding = false;
      this.game.onKill(attacker, this, def, head);
      return true;
    }
    return false;
  }

  onHurt() {}

  /** Push the simulation state into the visual model. */
  updateModel(dt, detail = true) {
    const b = this.body, sd = this.soldier;
    // smooth out kerbs and stair steps
    this.modelY = Math.abs(this.modelY - b.y) > 1.2 || !b.onGround ? b.y : damp(this.modelY, b.y, 22, dt);
    sd.root.position.set(b.x, this.modelY, b.z);
    sd.root.rotation.y = this.yaw;
    if (!detail) return;
    const st = this.sliding ? CROUCH : this.stance;
    sd.update(dt, {
      speed: this.alive ? this.speed : 0,
      moveX: this.localX, moveZ: this.localZ,
      pitch: this.pitch,
      crouch: st === CROUCH, prone: st === PRONE,
      sprint: this.sprinting, ads: this.adsK,
      air: (!b.onGround && !this.mantle) || !!this.mantle, slide: this.sliding,
      reload: this.reloadT >= 0 && this.def && this.def.reload ? this.reloadT / this.def.reload : -1,
      melee: this.meleeT >= 0 && this.def && this.def.swing ? this.meleeT / this.def.swing : -1,
      dead: this.alive ? 0 : this.deadT / 0.55, deadDir: this.deadDir,
      groundY: b.onGround ? this.modelY : this.game.world.groundAt(b.x, b.z),
    });
  }

  dispose() {
    this.soldier.dispose();
  }
}
