// All sound is synthesised with WebAudio at run time: no audio files.
import { clamp } from '../core/util.js';

const SHOTS = {
  //            noise dur, band Hz, thump Hz, thump dur, gain
  rifle: { dur: 0.16, band: 1900, thump: 150, tdur: 0.07, gain: 0.55 },
  rifleHeavy: { dur: 0.2, band: 1300, thump: 115, tdur: 0.09, gain: 0.62 },
  pistol: { dur: 0.11, band: 2400, thump: 190, tdur: 0.05, gain: 0.45 },
  pistolHeavy: { dur: 0.2, band: 1500, thump: 120, tdur: 0.1, gain: 0.62 },
  sniper: { dur: 0.5, band: 1000, thump: 85, tdur: 0.2, gain: 0.8 },
  sniperHeavy: { dur: 0.7, band: 750, thump: 60, tdur: 0.28, gain: 0.95 },
};

export class AudioSys {
  constructor() {
    this.ctx = null;
    this.volume = 0.8;
    this.voices = 0;
    this.ambient = null;
  }

  /** Must be called from a user gesture at least once. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC();
      } catch (e) {
        return;
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 6;
      this.master.connect(comp);
      comp.connect(this.ctx.destination);
      const n = this.ctx.sampleRate * 2;
      this.noise = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  _out(gain, pan) {
    const g = this.ctx.createGain();
    g.gain.value = gain;
    if (pan && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      g.connect(p);
      p.connect(this.master);
    } else g.connect(this.master);
    return g;
  }

  _noise(dur, type, freq, q, gain, pan, attack = 0.002, when = 0) {
    const c = this.ctx, t = c.currentTime + when;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const env = c.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(1, t + attack);
    env.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f);
    f.connect(env);
    env.connect(this._out(gain, pan));
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.02);
    this.voices++;
    src.onended = () => { this.voices--; };
    return f;
  }

  _tone(type, f0, f1, dur, gain, pan, when = 0) {
    const c = this.ctx, t = c.currentTime + when;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const env = c.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(1, t + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(env);
    env.connect(this._out(gain, pan));
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /** dist in metres from the listener, pan -1..1. */
  shot(kind, dist = 0, pan = 0) {
    if (!this.ctx || this.voices > 22) return;
    const s = SHOTS[kind] || SHOTS.rifle;
    const att = 1 / (1 + dist / 28);
    if (att < 0.03) return;
    const far = clamp(dist / 160, 0, 1);
    const f = this._noise(s.dur * (1 + far * 0.8), 'bandpass', s.band * (1 - far * 0.65), 0.7, s.gain * att, pan);
    f.frequency.exponentialRampToValueAtTime(Math.max(120, s.band * 0.25 * (1 - far * 0.5)), this.ctx.currentTime + s.dur);
    this._tone('sine', s.thump * 1.6, s.thump * 0.4, s.tdur, s.gain * att * 0.9, pan);
    if (dist < 12) this._noise(0.03, 'highpass', 4500, 0.5, s.gain * 0.35 * att, pan);
  }

  explosion(dist = 0, pan = 0) {
    if (!this.ctx) return;
    const att = 1 / (1 + dist / 45);
    this._noise(1.3, 'lowpass', 700, 0.4, 1.0 * att, pan, 0.004);
    this._tone('sine', 110, 28, 0.7, 1.0 * att, pan);
    this._noise(0.25, 'bandpass', 2400, 0.6, 0.5 * att, pan);
  }

  reload(stage) {
    if (!this.ctx) return;
    // 0: magazine out, 1: magazine in, 2: charging handle
    if (stage === 0) { this._noise(0.05, 'bandpass', 2600, 3, 0.25); this._tone('square', 320, 180, 0.04, 0.05); }
    else if (stage === 1) { this._noise(0.06, 'bandpass', 1800, 3, 0.3); this._tone('square', 220, 420, 0.05, 0.06); }
    else { this._noise(0.05, 'bandpass', 3200, 4, 0.28); this._noise(0.05, 'bandpass', 2400, 4, 0.28, 0, 0.002, 0.09); }
  }

  bolt() {
    if (!this.ctx) return;
    this._noise(0.05, 'bandpass', 3000, 4, 0.22, 0, 0.002, 0.12);
    this._noise(0.06, 'bandpass', 2200, 4, 0.24, 0, 0.002, 0.3);
  }

  dry() { if (this.ctx) this._tone('square', 900, 500, 0.03, 0.06); }
  swish() { if (this.ctx) { const f = this._noise(0.2, 'bandpass', 900, 1.5, 0.3, 0, 0.03); f.frequency.exponentialRampToValueAtTime(3200, this.ctx.currentTime + 0.16); } }
  stab() { if (this.ctx) { this._noise(0.09, 'lowpass', 900, 1, 0.5); this._tone('sine', 140, 60, 0.1, 0.4); } }
  hit(head) {
    if (!this.ctx) return;
    this._tone('triangle', head ? 1500 : 1050, head ? 1300 : 900, 0.05, 0.22);
    if (head) this._tone('triangle', 2100, 1900, 0.07, 0.18, 0, 0.04);
  }
  kill() {
    if (!this.ctx) return;
    this._tone('triangle', 660, 660, 0.09, 0.2);
    this._tone('triangle', 990, 990, 0.16, 0.2, 0, 0.08);
  }
  hurt() { if (this.ctx) { this._noise(0.12, 'lowpass', 500, 1, 0.5); this._tone('sine', 95, 50, 0.14, 0.5); } }
  whiz(pan) { if (this.ctx && this.voices < 18) { const f = this._noise(0.16, 'bandpass', 2600, 6, 0.22, pan, 0.02); f.frequency.exponentialRampToValueAtTime(900, this.ctx.currentTime + 0.15); } }
  step(vol = 1, pan = 0) { if (this.ctx && this.voices < 16) this._noise(0.06, 'lowpass', 420, 0.8, 0.16 * vol, pan, 0.004); }
  land(v = 1) { if (this.ctx) { this._noise(0.12, 'lowpass', 300, 0.8, 0.35 * v); this._tone('sine', 90, 45, 0.1, 0.3 * v); } }
  ui() { if (this.ctx) this._tone('triangle', 880, 1100, 0.05, 0.12); }
  pickup() { if (this.ctx) { this._tone('triangle', 520, 780, 0.08, 0.16); this._tone('triangle', 780, 1040, 0.1, 0.16, 0, 0.07); } }
  objective() {
    if (!this.ctx) return;
    [523, 659, 784, 1047].forEach((f, i) => this._tone('triangle', f, f, 0.22, 0.2, 0, i * 0.11));
  }
  defeat() {
    if (!this.ctx) return;
    [392, 330, 262, 196].forEach((f, i) => this._tone('sawtooth', f, f * 0.98, 0.3, 0.1, 0, i * 0.16));
  }
  pin() { if (this.ctx) this._tone('square', 2200, 1800, 0.03, 0.06); }
  bounce(dist) { if (this.ctx) this._tone('square', 700, 400, 0.04, 0.12 / (1 + dist / 12)); }

  /** Low city rumble under everything. */
  startAmbient() {
    if (!this.ctx || this.ambient) return;
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 220;
    const g = c.createGain();
    g.gain.value = 0.11;
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start();
    this.ambient = { src, g, t: 4 };
  }

  stopAmbient() {
    if (!this.ambient) return;
    try { this.ambient.src.stop(); } catch (e) { /* already stopped */ }
    this.ambient = null;
  }

  /** Occasional distant siren / gunfire so the city never feels dead. */
  updateAmbient(dt) {
    if (!this.ambient || !this.ctx) return;
    this.ambient.t -= dt;
    if (this.ambient.t > 0) return;
    this.ambient.t = 6 + Math.random() * 14;
    const pan = Math.random() * 2 - 1;
    if (Math.random() < 0.4) {
      for (let i = 0; i < 4; i++) {
        this._tone('sine', 620, 940, 0.55, 0.018, pan, i * 1.1);
        this._tone('sine', 940, 620, 0.55, 0.018, pan, i * 1.1 + 0.55);
      }
    } else {
      const n = 3 + Math.floor(Math.random() * 6);
      for (let i = 0; i < n; i++) this._noise(0.25, 'lowpass', 500, 0.6, 0.05, pan, 0.003, i * (0.09 + Math.random() * 0.05));
    }
  }
}
