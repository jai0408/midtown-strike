// Unified input. Touch: floating left stick, drag-to-look on the right half
// (also while holding the fire button) and HUD buttons marked with data-act.
// Desktop: WASD + mouse with pointer lock, for testing in a browser.
import { clamp } from '../core/util.js';

const blankPressed = () => ({ fire: false, ads: false, jump: false, crouch: false, prone: false, reload: false, grenade: false, interact: false, pause: false, map: false, next: false, last: false, slot: -1 });

export class Input {
  constructor(root, canvas) {
    this.root = root;
    this.canvas = canvas;
    this.enabled = false;
    this.moveX = 0; this.moveY = 0;
    this.lookX = 0; this.lookY = 0;
    this.fire = false;
    this.ads = false;
    this.sprint = false;
    this.sprintLock = false;
    this.touchLook = false;
    this.pressed = blankPressed();
    this.idle = { moveX: 0, moveY: 0, lookX: 0, lookY: 0, fire: false, ads: false, sprint: false, sprintLock: false, touchLook: false, pressed: blankPressed() };
    this.holdAds = false;
    this.keys = new Set();
    this.touches = new Map();   // identifier -> { role, x, y, act }
    this.stick = null;          // { id, ox, oy }
    this.stickEl = null;
    this.knobEl = null;
    this.isTouch = false;
    this.fireTouches = 0;
    this.onPause = null;
    this.onLockLost = null;
    this.locked = false;
    this._wheelAt = 0;
    this._bind();
  }

  /** Capture the mouse for looking around. Must be called from a click or key press. */
  lockPointer() {
    if (this.isTouch || !this.canvas.requestPointerLock || document.pointerLockElement === this.canvas) return;
    try {
      const p = this.canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* not available: dragging with a button held still looks around */ }
  }

  setStickElements(base, knob) {
    this.stickEl = base;
    this.knobEl = knob;
  }

  reset() {
    this.moveX = this.moveY = this.lookX = this.lookY = 0;
    this.fire = false; this.ads = false; this.sprint = false; this.sprintLock = false;
    this.fireTouches = 0;
    this.touches.clear();
    this.stick = null;
    this.keys.clear();
    this.pressed = blankPressed();
    if (this.stickEl) this.stickEl.style.opacity = '0';
  }

  endFrame() {
    this.lookX = 0; this.lookY = 0;
    const p = this.pressed;
    p.fire = p.ads = p.jump = p.crouch = p.prone = p.reload = p.grenade = p.interact = p.pause = p.map = p.next = p.last = false;
    p.slot = -1;
  }

  _press(act, el) {
    const p = this.pressed;
    switch (act) {
      case 'fire': case 'fire2': this.fire = true; p.fire = true; break;
      case 'ads':
        if (this.holdAds) this.ads = true; else this.ads = !this.ads;
        p.ads = true;
        break;
      case 'slot': p.slot = +el.dataset.slot; break;
      case 'pause': if (this.onPause) this.onPause(); break;
      default: if (act in p) p[act] = true;
    }
    if (el) el.classList.add('down');
  }

  _release(act, el) {
    if (act === 'fire' || act === 'fire2') { if (this.fireTouches <= 0) this.fire = false; }
    else if (act === 'ads' && this.holdAds) this.ads = false;
    if (el) el.classList.remove('down');
  }

  _bind() {
    const root = this.root;
    const opts = { passive: false };
    root.addEventListener('touchstart', (e) => {
      if (!this.enabled) return;
      this.isTouch = true;
      e.preventDefault();
      const W = window.innerWidth, H = window.innerHeight;
      for (const t of e.changedTouches) {
        const el = t.target.closest ? t.target.closest('[data-act]') : null;
        if (el) {
          const act = el.dataset.act;
          const rec = { role: 'button', act, el, x: t.clientX, y: t.clientY };
          if (act === 'fire' || act === 'fire2') { rec.role = 'fire'; this.fireTouches++; }
          this.touches.set(t.identifier, rec);
          this._press(act, el);
        } else if (t.clientX < W * 0.42 && !this.stick) {
          this.stick = { id: t.identifier, ox: t.clientX, oy: t.clientY };
          this.touches.set(t.identifier, { role: 'stick' });
          if (this.stickEl) {
            this.stickEl.style.opacity = '1';
            this.stickEl.style.left = t.clientX + 'px';
            this.stickEl.style.top = t.clientY + 'px';
            this.knobEl.style.transform = 'translate(-50%,-50%)';
          }
        } else {
          this.touches.set(t.identifier, { role: 'look', x: t.clientX, y: t.clientY });
        }
      }
    }, opts);
    root.addEventListener('touchmove', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      const H = window.innerHeight;
      const R = Math.max(44, Math.min(78, H * 0.17));
      for (const t of e.changedTouches) {
        const rec = this.touches.get(t.identifier);
        if (!rec) continue;
        if (rec.role === 'stick') {
          let dx = t.clientX - this.stick.ox, dy = t.clientY - this.stick.oy;
          const d = Math.hypot(dx, dy);
          if (d > R) { dx *= R / d; dy *= R / d; }
          const mx = dx / R, my = -dy / R, m = Math.hypot(mx, my);
          if (m < 0.14) { this.moveX = 0; this.moveY = 0; }
          else { this.moveX = mx; this.moveY = my; }
          this.sprintLock = d > R * 1.25 && my > 0.75;
          if (this.knobEl) {
            this.knobEl.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
            this.stickEl.classList.toggle('sprint', this.sprintLock);
          }
        } else if (rec.role === 'look' || rec.role === 'fire') {
          const dx = t.clientX - rec.x, dy = t.clientY - rec.y;
          rec.x = t.clientX; rec.y = t.clientY;
          // a little acceleration: fast flicks turn further
          const speed = Math.hypot(dx, dy);
          const k = 0.0048 * (1 + Math.min(1.2, speed / 38) * 0.55);
          this.lookX += dx * k;
          this.lookY += dy * k * 0.82;
          this.touchLook = true;
        }
      }
    }, opts);
    const end = (e) => {
      if (!this.enabled && !this.touches.size) return;
      e.preventDefault();
      for (const t of e.changedTouches) {
        const rec = this.touches.get(t.identifier);
        if (!rec) continue;
        this.touches.delete(t.identifier);
        if (rec.role === 'stick') {
          this.stick = null;
          this.moveX = 0; this.moveY = 0; this.sprintLock = false;
          if (this.stickEl) { this.stickEl.style.opacity = '0'; this.stickEl.classList.remove('sprint'); }
        } else if (rec.role === 'fire') {
          this.fireTouches = Math.max(0, this.fireTouches - 1);
          this._release(rec.act, rec.el);
        } else if (rec.role === 'button') this._release(rec.act, rec.el);
      }
    };
    root.addEventListener('touchend', end, opts);
    root.addEventListener('touchcancel', end, opts);

    // --- desktop ------------------------------------------------------------
    const KEY = { Space: 'jump', KeyC: 'crouch', ControlLeft: 'crouch', KeyZ: 'prone', KeyR: 'reload', KeyG: 'grenade', KeyF: 'interact', KeyE: 'interact', KeyM: 'map', KeyQ: 'last', Tab: 'map' };
    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if (e.metaKey) {
        // macOS never sends keyup for keys released while Cmd is down: drop
        // everything rather than leave the player running into a wall
        this.keys.clear();
        this._keys();
        return;
      }
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'KeyX') { this.ads = !this.ads; this.pressed.ads = true; }   // trackpad-friendly ADS toggle
      if (KEY[e.code]) this.pressed[KEY[e.code]] = true;
      if (e.code >= 'Digit1' && e.code <= 'Digit4') this.pressed.slot = +e.code.slice(5) - 1;
      if (e.code === 'Escape' || e.code === 'KeyP') { if (this.onPause) this.onPause(); }
      this._keys();
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      this._keys();
    });
    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled || this.isTouch) return;
      if (document.pointerLockElement !== this.canvas && this.canvas.requestPointerLock) {
        try { this.canvas.requestPointerLock(); } catch (err) { /* headless */ }
      }
      if (e.button === 0) { this.fire = true; this.pressed.fire = true; }
      if (e.button === 2) { this.ads = true; this.pressed.ads = true; }
    });
    window.addEventListener('mouseup', (e) => {
      if (this.isTouch) return;
      if (e.button === 0) this.fire = false;
      if (e.button === 2) this.ads = false;
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.enabled || this.isTouch) return;
      if (document.pointerLockElement === this.canvas || e.buttons) {
        // browsers occasionally report one huge jump when the capture starts
        this.lookX += clamp(e.movementX, -220, 220) * 0.0023;
        this.lookY += clamp(e.movementY, -220, 220) * 0.0023;
        this.touchLook = false;
      }
    });
    // A trackpad swipe is a long stream of wheel events with inertia, a mouse
    // wheel is separate notches: switch weapon once at the start of each
    // gesture, and keep the browser from scrolling, zooming (pinch arrives as
    // ctrl+wheel) or navigating back.
    window.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      const now = performance.now();
      const fresh = now - this._wheelAt > 180;
      this._wheelAt = now;
      if (fresh && !e.ctrlKey && Math.abs(e.deltaY) >= 1) this.pressed.next = true;
    }, { passive: false });
    // losing the mouse capture (Esc, Cmd-Tab) pauses the game
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === this.canvas;
      if (!locked && this.locked && this.enabled && this.onLockLost) this.onLockLost();
      this.locked = locked;
    });
    window.addEventListener('contextmenu', (e) => { if (this.enabled) e.preventDefault(); });
    window.addEventListener('blur', () => { this.keys.clear(); this._keys(); this.fire = false; });
  }

  _keys() {
    if (this.stick) return;
    const k = this.keys;
    this.moveX = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    this.moveY = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    this.sprint = k.has('ShiftLeft') || k.has('ShiftRight');
  }
}
