// The player: touch/keyboard driven movement (sprint, crouch, prone, slide,
// jump, mantle), over-the-shoulder camera with collision, and gunplay
// (hip-fire bloom, ADS, recoil with recovery, reloads, melee lunge, grenades).
import * as THREE from 'three';
import { Actor, STAND, CROUCH, PRONE, EYES, MARINES } from './actor.js';
import { WEAPONS, CATEGORIES, damageAt } from './weapons.js';
import { F_CAMERA, F_BULLET } from '../core/physics.js';
import { clamp, lerp, damp, smooth, angleDiff, rand } from '../core/util.js';

const DEG = Math.PI / 180;
const BASE_FOV = 68;
const SPEED = [4.7, 2.6, 1.0];       // stand, crouch, prone
const SPRINT = 6.7;
const JUMP_V = 5.9;
const _v = new THREE.Vector3(), _m = new THREE.Vector3();

// First person: where the weapon's sight point sits in camera space (x right,
// y up, -z forward) at the hip and when aiming down the sights.
const FP_HOLD = {
  rifle: { hip: [0.105, -0.074, -0.2], ads: -0.2 },
  sniper: { hip: [0.105, -0.082, -0.12], ads: -0.1 },
  pistol: { hip: [0.085, -0.085, -0.36], ads: -0.42 },
};
// eye relief behind the sight point when aiming (m), where it differs from the pose default
const FP_EYE = { ak47: -0.34, m16: -0.1, m4: -0.2, m1911: -0.45, ksr29: -0.05 };
// hip position of the sight point per weapon, where the pose default does not suit (big scopes)
const FP_HIP = { ksr29: [0.13, -0.125, -0.21], m40: [0.12, -0.11, -0.16], m107: [0.12, -0.115, -0.18] };
const _fpE = new THREE.Euler(), _fpQ = new THREE.Quaternion(), _fpP = new THREE.Vector3(), _fpS = new THREE.Vector3(1, 1, 1);
const _fpM = new THREE.Matrix4(), _fpM2 = new THREE.Matrix4(), _fpInv = new THREE.Matrix4();

export class Player extends Actor {
  constructor(game, loadout) {
    super(game, MARINES, 'YOU');
    this.isPlayer = true;
    this.slots = CATEGORIES.map((c) => {
      const def = WEAPONS[loadout[c.id]];
      return { def, mag: def.mag || 0, reserve: def.reserve || 0 };
    });
    this.slot = 0;
    this.lastSlot = 2;
    this.setWeapon(this.slots[0].def);
    this.grenades = 2;
    this.switchT = 0;
    this.fireCd = 0;
    this.burstLeft = 0;
    this.fireBuffer = 0;
    this.sprintBlock = 0;
    this.adsWanted = false;
    this.bloom = 0;
    this.recoilP = 0;        // recoverable part of the recoil (radians)
    this.sinceShot = 9;
    this.slideT = 0;
    this.slideCd = 0;
    this.slideX = 0; this.slideZ = 0;
    this.throwT = -1;
    this.autoReloadT = 0;
    this.lungeT = 0;
    this.lungeX = 0; this.lungeZ = 0;
    this.meleeHit = false;
    this.reloadStage = 0;
    this.regenDelay = 0;
    this.camY = 0;
    this.camBack = 3.3;
    this.camSide = 0.75;
    this.fp = game.settings.view === 'fpp';   // first-person camera
    this.fpK = this.fp ? 1 : 0;
    this.stepT = 0;
    this.shakeP = 0; this.shakeY = 0;
    this.scoped = false;
    this.spread = 2;         // current cone half-angle in degrees (for the crosshair)
    this.aimActor = null;    // enemy under / near the crosshair
    this.aimOn = false;      // crosshair exactly on an enemy
    this.assistT = 0;
    this.snap = null;
    this.autoFireT = 0;
    this.oobT = 0;
    this.stats = { shots: 0, hits: 0, headshots: 0, damage: 0 };
    this.aimDir = new THREE.Vector3(0, 0, -1);
    // FPP weapon & camera polish state (inertial sway, landing spring, slide roll, breathing)
    this._swayX = 0;
    this._swayY = 0;
    this._landDip = 0;
    this._camRoll = 0;
    this._breathT = 0;
    this._switchDur = 0.5;
  }

  get cur() { return this.slots[this.slot]; }

  resupply() {
    for (const s of this.slots) { s.mag = s.def.mag || 0; s.reserve = s.def.reserve || 0; }
    this.grenades = 2;
  }

  revive(x, z, yaw) {
    super.revive(x, z, yaw);
    this.resupply();
    this.slot = 0;
    this.setWeapon(this.slots[0].def);
    this.switchT = 0.3;
    this._switchDur = 0.3;
    this.adsWanted = false;
    this.recoilP = 0;
    this.bloom = 0;
    this.camY = this.body.y + EYES[STAND];
    this.throwT = -1;
    this.oobT = 0;
    this._swayX = 0; this._swayY = 0; this._landDip = 0; this._camRoll = 0;
  }

  selectSlot(i) {
    if (i === this.slot || i < 0 || i >= this.slots.length || !this.alive) return;
    this.lastSlot = this.slot;
    this.slot = i;
    this.setWeapon(this.slots[i].def);
    this.switchT = this.def.cat === 'melee' ? 0.25 : this.def.cat === 'handgun' ? 0.32 : 0.5;
    this._switchDur = this.switchT;
    this.reloadT = -1;
    this.meleeT = -1;
    this.burstLeft = 0;
    this.fireCd = 0;
    this.autoReloadT = 0;
    this.adsWanted = false;
    this.game.input.ads = false;
    this.game.audio.reload(1);
  }

  startReload() {
    const w = this.cur;
    if (!w.def.mag || this.reloadT >= 0 || w.mag >= w.def.mag || w.reserve <= 0 || this.switchT > 0) return;
    this.reloadT = 0;
    this.reloadStage = 0;
    this.burstLeft = 0;
  }

  onHurt(amount, attacker, fromX, fromZ) {
    this.regenDelay = 4.5;
    this.game.hud.damageFrom(fromX, fromZ, amount);
    this.game.audio.hurt();
    this.shakeP += rand(-0.012, 0.012);
    this.shakeY += rand(-0.012, 0.012);
  }

  // -------------------------------------------------------------------------
  update(dt, input) {
    const g = this.game, b = this.body, set = g.settings;
    this.invuln = Math.max(0, this.invuln - dt);
    if (!this.alive) {
      this.deadT += dt;
      this.adsK = damp(this.adsK, 0, 10, dt);
      b.vx *= 0.9; b.vz *= 0.9;
      g.world.stepBody(b, dt);
      this._kinematics();
      this._camera(dt, 1);
      this.updateModel(dt);
      this._fpView(dt);
      return;
    }
    const def = this.def;

    // --- look ---------------------------------------------------------------
    const zoom = lerp(1, clamp(def.adsFov ? def.adsFov / BASE_FOV : 1, 0.2, 1), this.adsK);
    let assist = 1;
    if (set.aimAssist && this.aimActor && input.touchLook) assist = this.aimOn ? 0.5 : 0.72;
    const sens = set.sensitivity * zoom * assist;
    const dYawLook = -input.lookX * sens;
    const dPitchLook = -input.lookY * sens * (set.invertY ? -1 : 1);
    this.yaw += dYawLook;
    this.pitch = clamp(this.pitch + dPitchLook, this.stance === PRONE ? -0.55 : -1.3, this.stance === PRONE ? 0.7 : 1.3);
    this._swayX = damp(this._swayX, clamp(-dYawLook * 1.4, -0.06, 0.06), 12, dt);
    this._swayY = damp(this._swayY, clamp(-dPitchLook * 1.2, -0.05, 0.05), 12, dt);
    this._breathT += dt;
    if (this.snap) {
      // gentle pull onto the target when bringing the sights up
      const s = this.snap, a = s.actor;
      s.t -= dt;
      if (s.t <= 0 || !a.alive) this.snap = null;
      else {
        const dx = a.x - b.x, dz = a.z - b.z, dy = a.chestY() - this.eyeY();
        const k = Math.min(1, dt * 9);
        this.yaw += angleDiff(this.yaw, Math.atan2(-dx, -dz)) * k;
        this.pitch += (Math.atan2(dy, Math.hypot(dx, dz)) - this.pitch) * k;
      }
    }
    // recoil settles back when the trigger is released
    this.sinceShot += dt;
    if (this.sinceShot > 0.09 && this.recoilP > 0) {
      const r = this.recoilP * (1 - Math.exp(-8 * dt));
      this.pitch -= r;
      this.recoilP -= r;
    }
    this.shakeP = damp(this.shakeP, 0, 12, dt);
    this.shakeY = damp(this.shakeY, 0, 12, dt);

    // --- stance -------------------------------------------------------------
    this.slideCd = Math.max(0, this.slideCd - dt);
    const mag = Math.min(1, Math.hypot(input.moveX, input.moveY));
    if (input.pressed.prone) {
      if (this.stance === PRONE) this.setStance(STAND);
      else if (b.onGround) { this.setStance(PRONE); this.sliding = false; }
    }
    if (input.pressed.crouch) {
      if (this.stance === PRONE) this.setStance(CROUCH);
      else if (this.stance === CROUCH) this.setStance(STAND);
      else if (this.sprinting && this.speed > 5.2 && b.onGround && this.slideCd <= 0) {
        // crouch while sprinting = slide
        this.sliding = true;
        this.slideT = 0.72;
        this.slideCd = 1.2;
        const l = Math.hypot(b.vx, b.vz) || 1;
        this.slideX = b.vx / l; this.slideZ = b.vz / l;
        this.setStance(CROUCH);
        g.fx.dust(b.x, b.y, b.z, 4);
        g.audio.swish();
      } else this.setStance(CROUCH);
    }
    if (input.pressed.jump && !this.mantle) {
      if (this.stance !== STAND) {
        this.sliding = false;
        this.setStance(STAND);
      } else if (!this.tryMantle() && b.onGround) {
        b.vy = JUMP_V;
        b.onGround = false;
        this._landDip = Math.min(this._landDip + 0.035, 0.05);
        g.audio.step(1.4);
      }
    }

    // --- movement -----------------------------------------------------------
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    let wx = fx * input.moveY + rx * input.moveX, wz = fz * input.moveY + rz * input.moveX;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) { wx /= wl; wz /= wl; }
    this.sprintBlock = Math.max(0, this.sprintBlock - dt);
    const wantsSprint = (input.sprint || input.sprintLock) && input.moveY > 0.55 && Math.abs(input.moveX) < 0.75;
    this.sprinting = wantsSprint && this.stance === STAND && !this.sliding && this.sprintBlock <= 0 && !this.adsWanted && this.reloadT < 0 && b.onGround && this.meleeT < 0;
    let speed = SPEED[this.stance] * (def.mobility || 1);
    if (this.sprinting) speed = SPRINT * (def.mobility || 1);
    else {
      // slower backwards and sideways
      const back = input.moveY < 0 ? 0.78 : 1, side = 1 - 0.1 * Math.min(1, Math.abs(input.moveX));
      speed *= back * side * lerp(1, def.adsMove || 1, this.adsK);
    }
    const wasGround = b.onGround;
    if (this.mantle) {
      this._updateMantle(dt);
    } else if (this.sliding) {
      this.slideT -= dt;
      const sp = lerp(3.2, 8.6, clamp(this.slideT / 0.72, 0, 1));
      b.vx = this.slideX * sp; b.vz = this.slideZ * sp;
      g.world.stepBody(b, dt);
      this._kinematics();
      if (this.slideT <= 0 || b.hitBox >= 0) this.sliding = false;
    } else if (this.lungeT > 0) {
      this.lungeT -= dt;
      b.vx = this.lungeX; b.vz = this.lungeZ;
      g.world.stepBody(b, dt);
      this._kinematics();
    } else {
      this.move(dt, wx, wz, speed * (wl > 1 ? 1 : wl));
      // run straight into a low obstacle while airborne -> climb it
      if (!b.onGround && b.hitBox >= 0 && input.moveY > 0.5 && b.vy < 3) this.tryMantle(1.6);
    }
    if (!wasGround && b.onGround) {
      this._landDip = -clamp(b.landSpeed / 10, 0.025, 0.09);
      if (b.landSpeed > 5) { g.audio.land(clamp(b.landSpeed / 12, 0.4, 1.2)); g.fx.dust(b.x, b.y, b.z, 3); this.shakeP -= 0.02; }
      if (b.landSpeed > 13.5) this.takeDamage((b.landSpeed - 13.5) * 9, null, null, false, b.x, b.z);
    }
    this._landDip = damp(this._landDip, 0, 11, dt);
    const targetRoll = this.sliding ? 0.042 : -input.moveX * 0.018 * (1 - this.adsK * 0.7);
    this._camRoll = damp(this._camRoll, targetRoll, 10, dt);
    // footsteps
    if (b.onGround && this.speed > 1.2 && !this.sliding) {
      this.stepT -= dt * this.speed;
      if (this.stepT <= 0) { this.stepT = this.sprinting ? 2.5 : 2.1; g.audio.step(this.stance === STAND ? (this.sprinting ? 1 : 0.7) : 0.35); }
    }

    // health regeneration
    this.regenDelay -= dt;
    if (this.regenDelay <= 0 && this.hp < this.maxHp) this.hp = Math.min(this.maxHp, this.hp + 38 * dt);

    // --- weapons ------------------------------------------------------------
    if (input.pressed.slot >= 0) this.selectSlot(input.pressed.slot);
    if (input.pressed.view) {
      this.fp = !this.fp;
      g.settings.view = this.fp ? 'fpp' : 'tpp';
      if (g.onSettings) g.onSettings();
    }
    if (input.pressed.next) this.selectSlot((this.slot + 1) % this.slots.length);
    if (input.pressed.last) this.selectSlot(this.lastSlot);
    this.switchT = Math.max(0, this.switchT - dt);
    this.fireCd = Math.max(-dt, this.fireCd - dt);   // keeps the remainder so the rate does not depend on fps
    this.fireBuffer = Math.max(0, this.fireBuffer - dt);
    if (input.pressed.fire) this.fireBuffer = 0.16;
    this.bloom = damp(this.bloom, 0, 7, dt);

    this._aimProbe(dt);
    // "simple mode": fire automatically when the crosshair sits on an enemy
    let trigger = input.fire, tap = this.fireBuffer > 0;
    if (set.autoFire && def.cat !== 'melee') {
      this.autoFireT = this.aimOn ? this.autoFireT + dt : 0;
      if (this.autoFireT > (def.scope ? 0.4 : 0.14) && (!def.scope || this.adsK > 0.95)) { trigger = true; tap = true; }
    }

    const w = this.cur;
    const busy = this.switchT > 0 || this.throwT >= 0 || this.mantle;
    if (def.cat === 'melee') {
      this.adsWanted = false;
      if ((trigger || tap) && this.meleeT < 0 && !busy) this._startMelee();
    } else {
      this.adsWanted = input.ads && !this.sprinting && this.reloadT < 0 && !busy;
      if (input.pressed.ads && input.ads && set.aimAssist && this.aimActor && input.touchLook) this.snap = { actor: this.aimActor, t: 0.14 };
      const canFire = !busy && this.reloadT < 0 && this.fireCd <= 0 && this.meleeT < 0;
      let wants;
      if (def.mode === 'auto') wants = trigger;
      else if (def.mode === 'burst') { if (tap && this.burstLeft === 0 && this.fireCd <= 0) { this.burstLeft = def.burst; this.fireBuffer = 0; } wants = this.burstLeft > 0; }
      else wants = tap;
      if (wants && (trigger || tap || this.burstLeft > 0)) {
        this.sprintBlock = 0.28;
        if (this.sprinting) { this.sprinting = false; this.fireCd = Math.max(this.fireCd, 0.16); }
        else if (canFire) {
          if (w.mag > 0) {
            this._shoot(w);
            this.fireBuffer = 0;
          } else {
            this.burstLeft = 0;
            if (tap) { g.audio.dry(); this.fireBuffer = 0; }
            this.startReload();
          }
        }
      }
      if (input.pressed.reload) this.startReload();
      if (this.autoReloadT > 0) {
        this.autoReloadT -= dt;
        if (this.autoReloadT <= 0 && w.mag === 0) this.startReload();
      }
      if (this.reloadT >= 0) {
        this.reloadT += dt;
        const k = this.reloadT / def.reload;
        if (this.reloadStage === 0 && k > 0.14) { g.audio.reload(0); this.reloadStage = 1; }
        if (this.reloadStage === 1 && k > 0.58) { g.audio.reload(1); this.reloadStage = 2; }
        if (this.reloadStage === 2 && k > 0.86) { g.audio.reload(2); this.reloadStage = 3; }
        if (k >= 1) {
          const need = Math.min(def.mag - w.mag, w.reserve);
          w.mag += need; w.reserve -= need;
          this.reloadT = -1;
        }
      }
    }
    // melee swing
    if (this.meleeT >= 0) {
      this.meleeT += dt;
      if (!this.meleeHit && this.meleeT >= def.hitAt) { this.meleeHit = true; this._meleeStrike(); }
      if (this.meleeT >= def.swing) this.meleeT = -1;
    }
    // grenade
    if (input.pressed.grenade && this.grenades > 0 && this.throwT < 0 && !this.mantle) {
      this.throwT = 0;
      this.adsWanted = false;
      g.audio.pin();
    }
    if (this.throwT >= 0) {
      this.throwT += dt;
      if (this.throwT > 0.28 && this.grenades > 0 && !this._thrown) {
        this._thrown = true;
        this.grenades--;
        const d = this._aimVector(_v);
        g.throwGrenade(this, b.x + d.x * 0.5 + rx * 0.25, this.eyeY() + 0.05, b.z + d.z * 0.5 + rz * 0.25,
          d.x * 17 + b.vx * 0.6, d.y * 17 + 4.2, d.z * 17 + b.vz * 0.6);
        g.audio.swish();
      }
      if (this.throwT > 0.6) { this.throwT = -1; this._thrown = false; }
    }

    // ADS blend
    const adsRate = 1 / Math.max(0.08, def.adsTime || 0.2);
    this.adsK = clamp(this.adsK + (this.adsWanted ? 1 : -1.4) * adsRate * dt, 0, 1);

    // current spread for the crosshair and the next shot
    if (def.cat !== 'melee') {
      let hip = def.hip * (1 + clamp(this.speed / 5, 0, 1) * 0.55);
      if (!b.onGround) hip *= 1.9;
      if (this.stance === CROUCH) hip *= 0.8;
      else if (this.stance === PRONE) hip *= 0.62;
      hip += this.bloom;
      const a = def.scope ? (this.adsK > 0.94 ? 1 : 0) : smooth(this.adsK);
      this.spread = lerp(hip, def.ads + this.bloom * 0.12 + clamp(this.speed / 5, 0, 1) * 0.12, a);
    } else this.spread = 1.2;

    this._camera(dt, 0);
    this.updateModel(dt);
    this._fpView(dt);
  }

  /**
   * First-person weapon hold: runs after the soldier animation and moves the
   * weapon so it is locked to the camera (sights on the screen centre when
   * aiming), then re-solves the arm IK onto the grips. The head is hidden.
   */
  _fpView(dt) {
    const sd = this.soldier, cam = this.game.camera;
    const fp = !!sd.fpCam;
    const hs = fp ? 0.001 : 1;
    if (sd.b.head.scale.x !== hs) sd.b.head.scale.setScalar(hs);
    const def = this.def;
    const w = sd.weapon;
    if (!fp || !w || !sd.points || !def || def.pose === 'melee' || !FP_HOLD[def.pose]) return;
    const H = FP_HOLD[def.pose], pts = sd.points, sc = w.scale.x;
    const sight = pts.sight || [0, pts.muzzle[1], pts.right[2]];
    const ads = smooth(clamp(this.adsK, 0, 1));
    const reload = sd.reloadK;
    const sprint = sd.sprintK * sd.moveK * (1 - ads) * (1 - reload);
    const amp = sd.moveK * clamp(this.speed / 4.8, 0, 1.3) * (1 - ads * 0.85);
    const sw = Math.sin(sd.phase), cw = Math.cos(sd.phase);
    // camera-space position of the sight point
    const hip = FP_HIP[def.id] || H.hip;
    let x = lerp(hip[0], 0, ads), y = lerp(hip[1], 0, ads), z = lerp(hip[2], FP_EYE[def.id] || H.ads, ads);
    let rx = 0, ry = lerp(0.04, 0, ads), rz = 0;
    // subtle idle figure-8 breathing sway
    const idleB = (1 - ads * 0.75) * (1 - sd.moveK * 0.6);
    x += Math.sin(this._breathT * 1.35) * 0.0022 * idleB;
    y += Math.sin(this._breathT * 2.70) * 0.0018 * idleB;
    // walk/run bob + subtle figure-8 rifle carry sway
    const s2 = Math.sin(sd.phase * 2);
    x += sw * 0.0085 * amp; y += -Math.abs(cw) * 0.011 * amp + s2 * 0.002 * amp;
    rx += -Math.abs(cw) * 0.014 * amp;
    rz += sw * 0.026 * amp;
    // inertial look sway (reduced in ADS)
    const swayK = 1 - ads * 0.82;
    x += this._swayX * 0.38 * swayK; y += this._swayY * 0.32 * swayK;
    rx += this._swayY * 0.75 * swayK; ry += this._swayX * 0.9 * swayK; rz += -this._swayX * 0.6 * swayK;
    // landing dip & jump lift spring
    const dipK = 1 - ads * 0.65;
    y += this._landDip * 0.45 * dipK;
    rx += this._landDip * 0.95 * dipK;
    // sprint: rifle swung across the chest, muzzle down
    x = lerp(x, 0.02, sprint); y = lerp(y, -0.17, sprint); z = lerp(z, -0.08, sprint);
    rx = lerp(rx, -0.45, sprint); ry = lerp(ry, 0.75, sprint); rz = lerp(rz, 0.35, sprint);
    // slide: tactical canted rifle (~22 deg) when sliding in FPP
    const sl = sd.slideK * (1 - ads) * (1 - reload);
    if (sl > 0.005) {
      x = lerp(x, x + 0.035, sl); y = lerp(y, y - 0.04, sl);
      rx += -0.06 * sl; ry += 0.14 * sl; rz += 0.38 * sl;
    }
    // reload: tilt the magazine well towards the support hand
    y = lerp(y, y - 0.05, reload); z = lerp(z, z + 0.03, reload);
    rx += 0.32 * reload; ry += 0.22 * reload; rz += -0.5 * reload;
    // weapon equip / switch raise animation
    if (this.switchT > 0) {
      const swK = smooth(clamp(this.switchT / (this._switchDur || 0.4), 0, 1));
      y -= 0.22 * swK; z += 0.07 * swK;
      rx -= 0.68 * swK; rz += 0.24 * swK;
    }
    // recoil kick
    z += sd.kick * 0.05; rx += sd.kick * 0.07;
    // mount (camera space) = T(x, y, z) * R * T(-sight * sc)
    _fpE.set(rx, ry, rz, 'YXZ');
    _fpQ.setFromEuler(_fpE);
    _fpM.compose(_fpP.set(x, y, z), _fpQ, _fpS);
    _fpM2.makeTranslation(-sight[0] * sc, -sight[1] * sc, -sight[2] * sc);
    _fpM.multiply(_fpM2);
    // -> world -> chest space
    sd.root.updateMatrixWorld(true);
    _fpM.premultiply(cam.matrixWorld);
    _fpInv.copy(sd.b.chest.matrixWorld).invert();
    _fpM.premultiply(_fpInv);
    const gm = sd.gunMount;
    _fpM.decompose(gm.position, gm.quaternion, _fpP);
    gm.updateMatrix();
    // hands back onto the grips (same rig and reload choreography as third person)
    sd.gripWeapon(this.reloadT >= 0 && def.reload ? this.reloadT / def.reload : -1);
  }

  _aimVector(out) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  /** Find the enemy the crosshair is on (or close to) for aim assist, auto-fire and the HUD. */
  _aimProbe(dt) {
    this.assistT -= dt;
    if (this.assistT > 0) return;
    this.assistT = 0.06;
    const g = this.game, cam = g.camera.position;
    const d = this._aimVector(_v);
    const range = this.def.cat === 'melee' ? 4 : Math.min(this.def.range || 200, this.def.scope ? 600 : 140);
    let best = null, bestA = this.adsK > 0.5 ? 0.05 : 0.085;
    this.aimOn = false;
    for (const a of g.actors) {
      if (!a.alive || a.team === this.team) continue;
      const dx = a.x - cam.x, dy = a.chestY() - cam.y, dz = a.z - cam.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > range + 4 || dist < 0.5) continue;
      const ang = Math.acos(clamp((dx * d.x + dy * d.y + dz * d.z) / dist, -1, 1));
      if (ang > bestA) continue;
      if (!g.world.clear(cam.x, cam.y, cam.z, a.x, a.chestY(), a.z, F_BULLET)) continue;
      best = a; bestA = ang;
    }
    this.aimActor = best;
    if (best) {
      const ex = this.body.x, ey = this.eyeY(), ez = this.body.z;
      const t = best.rayHit(cam.x, cam.y, cam.z, d.x, d.y, d.z, range + 6);
      this.aimOn = t >= 0 && g.world.clear(ex, ey, ez, cam.x + d.x * t, cam.y + d.y * t, cam.z + d.z * t, F_BULLET);
    }
  }

  _shoot(w) {
    const g = this.game, def = this.def, b = this.body;
    w.mag--;
    this.fireCd = Math.min(0, this.fireCd) + 60 / def.rpm;
    if (def.mode === 'burst') {
      this.burstLeft--;
      if (this.burstLeft === 0) this.fireCd = def.burstDelay;
    }
    this.sinceShot = 0;
    this.lastShotT = g.time;
    this.stats.shots++;
    // direction: random point inside the spread cone around the camera's forward
    const d = this._aimVector(_v);
    const ang = this.spread * DEG * Math.sqrt(Math.random()), az = Math.random() * Math.PI * 2;
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    // up vector perpendicular to d and right
    const ux = d.y * rz - d.z * 0, uy = d.z * rx - d.x * rz, uz = d.x * 0 - d.y * rx;
    const s = Math.tan(ang), ca = Math.cos(az) * s, sa = Math.sin(az) * s;
    let dx = d.x + rx * ca + ux * sa, dy = d.y + uy * sa, dz = d.z + rz * ca + uz * sa;
    const l = Math.hypot(dx, dy, dz);
    dx /= l; dy /= l; dz /= l;
    g.playerShot(this, dx, dy, dz, def);
    // recoil
    const stance = this.stance === PRONE ? 0.65 : this.stance === CROUCH ? 0.84 : 1;
    const adsMul = lerp(1, 0.78, this.adsK);
    const ceiling = (def.recoilMax || def.recoilV * 9) * DEG;
    const kv = def.recoilV * DEG * rand(0.85, 1.15) * stance * adsMul * Math.max(0.18, 1 - this.recoilP / ceiling);
    const kh = def.recoilH * DEG * rand(-1, 1) * stance * adsMul;
    this.pitch = Math.min(1.3, this.pitch + kv);
    this.yaw += kh;
    this.recoilP = Math.min(this.recoilP + kv, 14 * DEG);
    this.bloom = Math.min(this.bloom + (def.scope ? 3 : 0.42), def.scope ? 6 : 2.6);
    this.soldier.kick = 1;
    this.shakeP += kv * 0.35;
    this.shakeY += kh * 0.5;
    g.audio.shot(def.sound, 0, 0);
    g.noise(b.x, b.z, this.team, 70);
    if (def.mode === 'bolt') g.audio.bolt();
    if (w.mag === 0 && w.reserve > 0) { this.fireBuffer = 0; this.autoReloadT = 0.28; }
  }

  _startMelee() {
    const g = this.game, b = this.body, def = this.def;
    this.meleeT = 0;
    this.meleeHit = false;
    this.sprintBlock = 0.4;
    g.audio.swish();
    // lunge at an enemy that is close and roughly in front
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    let best = null, bd = def.lunge;
    for (const a of g.actors) {
      if (!a.alive || a.team === this.team) continue;
      const dx = a.x - b.x, dz = a.z - b.z, dist = Math.hypot(dx, dz);
      if (dist > bd || Math.abs(a.y - b.y) > 1.6) continue;
      if ((dx * fx + dz * fz) / (dist || 1) < 0.72) continue;
      best = a; bd = dist;
    }
    if (best && bd > 1.2) {
      const dx = best.x - b.x, dz = best.z - b.z;
      const sp = (bd - 0.9) / def.hitAt;
      this.lungeT = def.hitAt;
      this.lungeX = (dx / bd) * sp; this.lungeZ = (dz / bd) * sp;
      this.yaw = Math.atan2(-dx, -dz);
    }
  }

  _meleeStrike() {
    const g = this.game, b = this.body, def = this.def;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    let best = null, bd = def.reach;
    for (const a of g.actors) {
      if (!a.alive || a.team === this.team) continue;
      const dx = a.x - b.x, dz = a.z - b.z, dist = Math.hypot(dx, dz);
      if (dist > bd || Math.abs(a.y - b.y) > 1.6) continue;
      if ((dx * fx + dz * fz) / (dist || 1) < 0.45) continue;
      if (!g.world.clear(b.x, this.eyeY(), b.z, a.x, a.chestY(), a.z, F_BULLET)) continue;
      best = a; bd = dist;
    }
    if (best) {
      g.audio.stab();
      g.fx.blood(best.x, best.chestY(), best.z, fx, 0, fz);
      this.stats.hits++;
      g.hud.hitMarker(true, false);
      best.takeDamage(damageAt(def, bd), this, def, false, b.x, b.z);
    } else {
      // strike the scenery
      const t = g.world.raycast(b.x, this.eyeY(), b.z, fx * Math.cos(this.pitch), Math.sin(this.pitch), fz * Math.cos(this.pitch), def.reach, F_BULLET);
      if (t < def.reach) { const h = g.world.hit; g.fx.impact(h.x, h.y, h.z, h.nx, h.ny, h.nz, h.surf); }
    }
  }

  // -------------------------------------------------------------------------
  _camera(dt, deadK) {
    const g = this.game, b = this.body, cam = g.camera, w = g.world, def = this.def;
    const eye = this.sliding ? 0.95 : EYES[this.stance];
    const targetY = b.y + eye;
    this.camY = Math.abs(this.camY - targetY) > 2.5 ? targetY : damp(this.camY, targetY, b.onGround ? 13 : 30, dt);
    const ads = smooth(this.adsK);
    this.scoped = !!def.scope && this.adsK > 0.9 && this.alive;
    const d = this._aimVector(_v);
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    const px = b.x, py = this.camY + 0.1, pz = b.z;
    let side = lerp(0.75, 0.56, ads), back = lerp(3.3, def.pose === 'pistol' ? 1.95 : 1.6, ads), up = lerp(0.45, 0.32, ads);
    if (this.stance === PRONE) { back *= 0.8; up += 0.22; }
    if (!this.alive) { back = 3.6; up = 0.9; side = 0.2; }
    // shoulder offset, then the boom backwards, both with collision
    let t = w.raycast(px, py, pz, rx, 0, rz, side + 0.25, F_CAMERA, false);
    if (t < side + 0.25) side = Math.max(0, t - 0.25);
    this.camSide = damp(this.camSide, side, 14, dt);
    const sx = px + rx * this.camSide, sy = py + up, sz = pz + rz * this.camSide;
    t = w.raycast(sx, sy, sz, -d.x, -d.y, -d.z, back + 0.3, F_CAMERA, true);
    if (t < back + 0.3) back = Math.max(0.2, t - 0.3);
    this.camBack = back < this.camBack ? back : damp(this.camBack, back, 7, dt);
    const fp = this.fp && this.alive;
    this.fpK = fp ? 1 : 0;
    // the soldier reads this to hide the head and hold the weapon up to the camera
    this.soldier.fpCam = fp && !this.scoped ? cam : null;
    const near = fp ? 0.04 : 0.12;
    if (cam.near !== near) { cam.near = near; cam.updateProjectionMatrix(); }
    if (this.scoped) {
      cam.position.set(px + d.x * 0.2, this.camY + 0.02, pz + d.z * 0.2);
    } else if (fp) {
      // eyes: a little ahead of the neck, sliding forward when looking down so
      // the view never ends up inside the chest rig
      const fwd = 0.1 + Math.max(0, -this.pitch) * 0.3;
      const hx = -Math.sin(this.yaw), hz = -Math.cos(this.yaw);
      cam.position.set(px + hx * fwd, this.camY + 0.03 + this._landDip * 0.35 - Math.max(0, -this.pitch) * 0.06, pz + hz * fwd);
      // lying down the body stretches out ahead of the hips: put the eyes at the
      // head (from the chest, which is never hidden), just in front of the face,
      // so the view is not from inside the shoulders and the hidden head
      const pk = this.soldier.proneK;
      if (pk > 0.01) cam.position.lerp(_m.set(0, 0.42, -0.2).applyMatrix4(this.soldier.b.chest.matrixWorld), pk);
    } else {
      cam.position.set(sx - d.x * this.camBack, sy - d.y * this.camBack, sz - d.z * this.camBack);
      const floor = w.groundAt(cam.position.x, cam.position.z) + 0.22;
      if (cam.position.y < floor) cam.position.y = floor;
    }
    const shake = g.fx.shake;
    const roll = fp && !this.scoped ? this._camRoll : 0;
    cam.rotation.set(this.pitch + this.shakeP + rand(-1, 1) * shake * 0.03, this.yaw + this.shakeY + rand(-1, 1) * shake * 0.03, roll + rand(-1, 1) * shake * 0.02, 'YXZ');
    const fovBoost = this.sliding ? 9 : (this.sprinting ? 5 : 0);
    const fov = lerp(BASE_FOV + fovBoost, def.adsFov || BASE_FOV, ads);
    const f = damp(cam.fov, fov, 18, dt);
    if (Math.abs(f - cam.fov) > 0.01) { cam.fov = f; cam.updateProjectionMatrix(); }
    // do not look through our own head when the camera is squeezed in
    this.soldier.root.visible = !this.scoped && (fp || this.camBack > 0.55 || !this.alive);
    cam.updateMatrixWorld();
    this._aimVector(this.aimDir);
  }
}
