// Static collision world: axis-aligned boxes in a uniform grid, an analytic
// ground height (roads vs. raised sidewalks) and a capsule-style character
// mover with step-up, step-down snapping and ceilings.
import { clamp } from './util.js';

export const GRAVITY = 15.5;
export const STEP_HEIGHT = 0.5;

// Collider flags
export const F_SOLID = 1;      // blocks movement
export const F_BULLET = 2;     // stops bullets
export const F_CAMERA = 4;     // camera boom collides with it
export const F_BUILDING = 8;   // large structure (used for nav + minimap)
export const F_SEE = 16;       // blocks AI line of sight
export const F_ALL = F_SOLID | F_BULLET | F_CAMERA | F_SEE;
export const F_DEFAULT = F_SOLID | F_BULLET | F_CAMERA | F_SEE;

// Surface kinds for impact effects
export const S_CONCRETE = 0, S_METAL = 1, S_GLASS = 2, S_WOOD = 3, S_GROUND = 4, S_DIRT = 5;

export class World {
  constructor(half, cell = 32) {
    this.half = half;
    this.cell = cell;
    this.n = Math.ceil((half * 2) / cell);
    this.count = 0;
    this._cap = 4096;
    this.minX = new Float32Array(this._cap);
    this.minY = new Float32Array(this._cap);
    this.minZ = new Float32Array(this._cap);
    this.maxX = new Float32Array(this._cap);
    this.maxY = new Float32Array(this._cap);
    this.maxZ = new Float32Array(this._cap);
    this.flags = new Uint8Array(this._cap);
    this.surf = new Uint8Array(this._cap);
    this.stamp = new Uint32Array(this._cap);
    this._stamp = 0;
    this._lists = new Array(this.n * this.n);
    this.cells = null;
    this.groundAt = () => 0;
    this._q = [];
    // result of the last raycast
    this.hit = { t: Infinity, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, box: -1, surf: S_GROUND };
  }

  _grow() {
    const cap = this._cap * 2;
    for (const k of ['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ']) {
      const a = new Float32Array(cap);
      a.set(this[k]);
      this[k] = a;
    }
    for (const k of ['flags', 'surf']) {
      const a = new Uint8Array(cap);
      a.set(this[k]);
      this[k] = a;
    }
    this.stamp = new Uint32Array(cap);
    this._cap = cap;
  }

  addBox(x0, y0, z0, x1, y1, z1, flags = F_DEFAULT, surf = S_CONCRETE) {
    if (this.count >= this._cap) this._grow();
    const i = this.count++;
    this.minX[i] = Math.min(x0, x1);
    this.maxX[i] = Math.max(x0, x1);
    this.minY[i] = Math.min(y0, y1);
    this.maxY[i] = Math.max(y0, y1);
    this.minZ[i] = Math.min(z0, z1);
    this.maxZ[i] = Math.max(z0, z1);
    this.flags[i] = flags;
    this.surf[i] = surf;
    const { half, cell, n } = this;
    const cx0 = clamp(Math.floor((this.minX[i] + half) / cell), 0, n - 1);
    const cx1 = clamp(Math.floor((this.maxX[i] + half) / cell), 0, n - 1);
    const cz0 = clamp(Math.floor((this.minZ[i] + half) / cell), 0, n - 1);
    const cz1 = clamp(Math.floor((this.maxZ[i] + half) / cell), 0, n - 1);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const k = cz * n + cx;
        (this._lists[k] || (this._lists[k] = [])).push(i);
      }
    }
    return i;
  }

  /** Disable a collider (used for destructible / removed props). */
  removeBox(i) {
    this.flags[i] = 0;
  }

  finalize() {
    this.cells = this._lists.map((l) => (l ? Int32Array.from(l) : null));
  }

  _cellList(cx, cz) {
    const k = cz * this.n + cx;
    return this.cells ? this.cells[k] : this._lists[k];
  }

  /** Unique collider indices overlapping an XZ rectangle. */
  query(x0, z0, x1, z1, out) {
    out.length = 0;
    const { half, cell, n } = this;
    const cx0 = clamp(Math.floor((x0 + half) / cell), 0, n - 1);
    const cx1 = clamp(Math.floor((x1 + half) / cell), 0, n - 1);
    const cz0 = clamp(Math.floor((z0 + half) / cell), 0, n - 1);
    const cz1 = clamp(Math.floor((z1 + half) / cell), 0, n - 1);
    const stamp = ++this._stamp;
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const list = this._cellList(cx, cz);
        if (!list) continue;
        for (let j = 0; j < list.length; j++) {
          const i = list[j];
          if (this.stamp[i] === stamp) continue;
          this.stamp[i] = stamp;
          if (this.maxX[i] < x0 || this.minX[i] > x1 || this.maxZ[i] < z0 || this.minZ[i] > z1) continue;
          out.push(i);
        }
      }
    }
    return out;
  }

  /**
   * Ray vs. world. Direction must be normalised. Returns the hit distance
   * (Infinity for none) and fills this.hit. Boxes that contain the origin are
   * ignored. `ground=false` skips the ground plane (used for 2D nav checks).
   */
  raycast(ox, oy, oz, dx, dy, dz, maxT, mask = F_BULLET, ground = true) {
    const h = this.hit;
    let best = maxT;
    let box = -1;
    let axis = 1;
    if (ground && dy < -1e-6) {
      // Roads sit at 0, sidewalks slightly higher: intersect y=0 first and
      // refine against the local ground height.
      let t = -oy / dy;
      const gy = this.groundAt(ox + dx * t, oz + dz * t);
      if (gy > 0) t = (gy - oy) / dy;
      if (t >= 0 && t < best) {
        best = t;
        box = -2;
      }
    }
    const { half, cell, n } = this;
    let px = ox, pz = oz, t0 = 0;
    // Advance to the grid if the origin is outside it.
    if (px < -half || px > half || pz < -half || pz > half) {
      let tEnter = 0;
      if (dx !== 0) {
        const a = (-half - ox) / dx, b = (half - ox) / dx;
        tEnter = Math.max(tEnter, Math.min(a, b));
      } else if (ox < -half || ox > half) return this._miss(maxT);
      if (dz !== 0) {
        const a = (-half - oz) / dz, b = (half - oz) / dz;
        tEnter = Math.max(tEnter, Math.min(a, b));
      } else if (oz < -half || oz > half) return this._miss(maxT);
      if (tEnter > best) return this._finish(best, box, axis, ox, oy, oz, dx, dy, dz, maxT);
      t0 = tEnter + 1e-4;
      px = ox + dx * t0;
      pz = oz + dz * t0;
    }
    let cx = Math.floor((px + half) / cell);
    let cz = Math.floor((pz + half) / cell);
    if (cx < 0 || cx >= n || cz < 0 || cz >= n) return this._finish(best, box, axis, ox, oy, oz, dx, dy, dz, maxT);
    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const invX = dx !== 0 ? 1 / dx : Infinity;
    const invY = dy !== 0 ? 1 / dy : Infinity;
    const invZ = dz !== 0 ? 1 / dz : Infinity;
    let tMaxX = dx !== 0 ? ((cx + (dx > 0 ? 1 : 0)) * cell - half - ox) * invX : Infinity;
    let tMaxZ = dz !== 0 ? ((cz + (dz > 0 ? 1 : 0)) * cell - half - oz) * invZ : Infinity;
    const tDeltaX = dx !== 0 ? cell * Math.abs(invX) : Infinity;
    const tDeltaZ = dz !== 0 ? cell * Math.abs(invZ) : Infinity;
    const stamp = ++this._stamp;
    const { minX, minY, minZ, maxX, maxY, maxZ, flags } = this;
    for (;;) {
      const list = this._cellList(cx, cz);
      if (list) {
        for (let j = 0; j < list.length; j++) {
          const i = list[j];
          if (this.stamp[i] === stamp) continue;
          this.stamp[i] = stamp;
          if (!(flags[i] & mask)) continue;
          let tn = -Infinity, tf = Infinity, ax = 0;
          if (dx !== 0) {
            let a = (minX[i] - ox) * invX, b = (maxX[i] - ox) * invX;
            if (a > b) { const s = a; a = b; b = s; }
            tn = a; tf = b;
          } else if (ox < minX[i] || ox > maxX[i]) continue;
          if (dy !== 0) {
            let a = (minY[i] - oy) * invY, b = (maxY[i] - oy) * invY;
            if (a > b) { const s = a; a = b; b = s; }
            if (a > tn) { tn = a; ax = 1; }
            if (b < tf) tf = b;
          } else if (oy < minY[i] || oy > maxY[i]) continue;
          if (dz !== 0) {
            let a = (minZ[i] - oz) * invZ, b = (maxZ[i] - oz) * invZ;
            if (a > b) { const s = a; a = b; b = s; }
            if (a > tn) { tn = a; ax = 2; }
            if (b < tf) tf = b;
          } else if (oz < minZ[i] || oz > maxZ[i]) continue;
          if (tn > tf || tn < 0) continue; // miss, or origin inside the box
          if (tn < best) {
            best = tn;
            box = i;
            axis = ax;
          }
        }
      }
      const tExit = tMaxX < tMaxZ ? tMaxX : tMaxZ;
      if (best <= tExit || tExit > maxT) break;
      if (tMaxX < tMaxZ) {
        cx += stepX;
        tMaxX += tDeltaX;
        if (cx < 0 || cx >= n) break;
      } else {
        cz += stepZ;
        tMaxZ += tDeltaZ;
        if (cz < 0 || cz >= n) break;
      }
    }
    return this._finish(best, box, axis, ox, oy, oz, dx, dy, dz, maxT);
  }

  _miss(maxT) {
    const h = this.hit;
    h.t = Infinity;
    h.box = -1;
    return Infinity;
  }

  _finish(best, box, axis, ox, oy, oz, dx, dy, dz, maxT) {
    const h = this.hit;
    if (box === -1) {
      h.t = Infinity;
      h.box = -1;
      return Infinity;
    }
    h.t = best;
    h.box = box;
    h.x = ox + dx * best;
    h.y = oy + dy * best;
    h.z = oz + dz * best;
    h.nx = 0; h.ny = 0; h.nz = 0;
    if (box === -2) {
      h.ny = 1;
      h.surf = S_GROUND;
    } else {
      if (axis === 0) h.nx = dx > 0 ? -1 : 1;
      else if (axis === 1) h.ny = dy > 0 ? -1 : 1;
      else h.nz = dz > 0 ? -1 : 1;
      h.surf = this.surf[box];
    }
    return best;
  }

  /** True when nothing with `mask` lies between two points. */
  clear(ax, ay, az, bx, by, bz, mask = F_SEE) {
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return true;
    dx /= len; dy /= len; dz /= len;
    return this.raycast(ax, ay, az, dx, dy, dz, len, mask, false) >= len;
  }

  /** Highest walkable surface under a body standing at (x,z) with feet near y. */
  supportAt(x, z, feetY, radius) {
    let g = this.groundAt(x, z);
    const r = radius * 0.7;
    const q = this.query(x - r, z - r, x + r, z + r, this._q);
    for (let j = 0; j < q.length; j++) {
      const i = q[j];
      if (!(this.flags[i] & F_SOLID)) continue;
      const top = this.maxY[i];
      if (top > g && top <= feetY + STEP_HEIGHT + 1e-3) g = top;
    }
    return g;
  }

  /** Is there room for a body of the given height standing at (x, y, z)? */
  fits(x, y, z, radius, height) {
    const q = this.query(x - radius, z - radius, x + radius, z + radius, this._q);
    for (let j = 0; j < q.length; j++) {
      const i = q[j];
      if (!(this.flags[i] & F_SOLID)) continue;
      if (this.maxY[i] <= y + 0.05 || this.minY[i] >= y + height) continue;
      return false;
    }
    return true;
  }

  /**
   * Integrates a character body one frame.
   * body: { x,y,z, vx,vy,vz, radius, height, onGround, hitBox, hitNX, hitNZ }
   */
  stepBody(b, dt) {
    const speed = Math.hypot(b.vx, b.vz);
    const steps = Math.max(1, Math.ceil((speed * dt) / (b.radius * 0.9)));
    const sdt = dt / steps;
    b.hitBox = -1;
    for (let s = 0; s < steps; s++) {
      b.x += b.vx * sdt;
      b.z += b.vz * sdt;
      this._resolveXZ(b);
    }
    const lim = this.half - b.radius - 0.5;
    b.x = clamp(b.x, -lim, lim);
    b.z = clamp(b.z, -lim, lim);

    const prevY = b.y;
    const wasGround = b.onGround;
    b.vy -= GRAVITY * dt;
    b.y += b.vy * dt;
    const g = this.supportAt(b.x, b.z, prevY, b.radius);
    if (b.y <= g) {
      b.y = g;
      b.landSpeed = -b.vy;
      b.vy = 0;
      b.onGround = true;
    } else if (wasGround && b.vy <= 0 && b.y - g < STEP_HEIGHT + 0.05) {
      // walking off a kerb or down stairs: stay glued to the ground
      b.y = g;
      b.vy = 0;
      b.onGround = true;
    } else {
      b.onGround = false;
    }
    if (b.vy > 0) {
      // ceilings
      const r = b.radius * 0.7;
      const q = this.query(b.x - r, b.z - r, b.x + r, b.z + r, this._q);
      for (let j = 0; j < q.length; j++) {
        const i = q[j];
        if (!(this.flags[i] & F_SOLID)) continue;
        if (this.minY[i] >= prevY + b.height - 0.02 && b.y + b.height > this.minY[i]) {
          b.y = this.minY[i] - b.height;
          b.vy = 0;
        }
      }
    }
  }

  _resolveXZ(b) {
    const r = b.radius;
    const q = this.query(b.x - r, b.z - r, b.x + r, b.z + r, this._q);
    if (!q.length) return;
    const feet = b.y + STEP_HEIGHT;
    const head = b.y + b.height;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (let j = 0; j < q.length; j++) {
        const i = q[j];
        if (!(this.flags[i] & F_SOLID)) continue;
        if (this.maxY[i] <= feet || this.minY[i] >= head) continue;
        const cx = clamp(b.x, this.minX[i], this.maxX[i]);
        const cz = clamp(b.z, this.minZ[i], this.maxZ[i]);
        let dx = b.x - cx, dz = b.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2);
          const push = r - d;
          dx /= d; dz /= d;
          b.x += dx * push;
          b.z += dz * push;
          b.hitNX = dx; b.hitNZ = dz;
        } else {
          // centre is inside the box: leave through the nearest face
          const l = b.x - this.minX[i], rr = this.maxX[i] - b.x;
          const n = b.z - this.minZ[i], f = this.maxZ[i] - b.z;
          const m = Math.min(l, rr, n, f);
          if (m === l) { b.x = this.minX[i] - r; b.hitNX = -1; b.hitNZ = 0; }
          else if (m === rr) { b.x = this.maxX[i] + r; b.hitNX = 1; b.hitNZ = 0; }
          else if (m === n) { b.z = this.minZ[i] - r; b.hitNX = 0; b.hitNZ = -1; }
          else { b.z = this.maxZ[i] + r; b.hitNX = 0; b.hitNZ = 1; }
        }
        b.hitBox = i;
        moved = true;
      }
      if (!moved) break;
    }
  }
}

export function makeBody(radius = 0.38, height = 1.8) {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    radius, height, onGround: true, landSpeed: 0,
    hitBox: -1, hitNX: 0, hitNZ: 0,
  };
}

// ---------------------------------------------------------------------------
// Ray helpers for character hit volumes
// ---------------------------------------------------------------------------
/** Ray vs sphere. Returns entry distance or -1. */
export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const mx = ox - cx, my = oy - cy, mz = oz - cz;
  const b = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - r * r;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t < 0 ? 0 : t;
}

/** Ray vs capsule (segment a-b, radius r). Returns approximate entry distance or -1. */
export function rayCapsule(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, r) {
  // closest points between the ray and the segment
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const wx = ox - ax, wy = oy - ay, wz = oz - az;
  const a = 1; // |d|^2
  const b = dx * ux + dy * uy + dz * uz;
  const c = ux * ux + uy * uy + uz * uz;
  const d = dx * wx + dy * wy + dz * wz;
  const e = ux * wx + uy * wy + uz * wz;
  const den = a * c - b * b;
  let s = den > 1e-8 ? clamp((a * e - b * d) / den, 0, 1) : 0;
  let t = b * s - d;
  if (t < 0) {
    t = 0;
    s = c > 1e-8 ? clamp(e / c, 0, 1) : 0;
  }
  const px = ox + dx * t - (ax + ux * s);
  const py = oy + dy * t - (ay + uy * s);
  const pz = oz + dz * t - (az + uz * s);
  const dist2 = px * px + py * py + pz * pz;
  if (dist2 > r * r) return -1;
  const back = Math.sqrt(r * r - dist2);
  return Math.max(0, t - back);
}
