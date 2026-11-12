export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const saturate = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smooth = (t) => t * t * (3 - 2 * t);
/** Frame-rate independent exponential approach of a towards b. */
export const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));

export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
export const angleDiff = (from, to) => wrapAngle(to - from);
export function dampAngle(a, b, rate, dt) {
  return a + angleDiff(a, b) * (1 - Math.exp(-rate * dt));
}

/** Small deterministic PRNG so the city is identical on every device. */
export class RNG {
  constructor(seed) {
    this.s = seed >>> 0;
  }
  next() {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) {
    return a + (b - a) * this.next();
  }
  int(a, b) {
    return Math.floor(this.range(a, b + 1));
  }
  chance(p) {
    return this.next() < p;
  }
  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }
  sign() {
    return this.next() < 0.5 ? -1 : 1;
  }
}

export const rand = (a = 0, b = 1) => a + (b - a) * Math.random();
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export function fmtTime(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}
