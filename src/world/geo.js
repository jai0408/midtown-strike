// Growable vertex buffer used to merge thousands of primitives (buildings,
// vehicles, street furniture...) into a handful of draw calls.
import * as THREE from 'three';

const _c = new THREE.Color();
/** sRGB hex -> linear [r,g,b] for vertex colours. */
export function C(hex, mul = 1) {
  _c.set(hex);
  return [_c.r * mul, _c.g * mul, _c.b * mul];
}
export const mulC = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

export class Geo {
  constructor({ uv = false, normal = true, color = true } = {}) {
    this.hasUV = uv;
    this.hasN = normal;
    this.hasC = color;
    this.nv = 0;
    this.ni = 0;
    this._vcap = 1024;
    this._icap = 2048;
    this.pos = new Float32Array(this._vcap * 3);
    this.nor = normal ? new Float32Array(this._vcap * 3) : null;
    this.uv = uv ? new Float32Array(this._vcap * 2) : null;
    this.col = color ? new Float32Array(this._vcap * 3) : null;
    this.idx = new Uint32Array(this._icap);
    // optional local transform (yaw about Y + translation)
    this.cos = 1; this.sin = 0; this.tx = 0; this.ty = 0; this.tz = 0;
  }

  setXform(x = 0, y = 0, z = 0, yaw = 0) {
    this.tx = x; this.ty = y; this.tz = z;
    this.cos = Math.cos(yaw); this.sin = Math.sin(yaw);
    return this;
  }
  resetXform() {
    return this.setXform();
  }

  _reserve(nv, ni) {
    if (this.nv + nv > this._vcap) {
      while (this.nv + nv > this._vcap) this._vcap *= 2;
      const grow = (a, n) => { const b = new Float32Array(this._vcap * n); b.set(a); return b; };
      this.pos = grow(this.pos, 3);
      if (this.nor) this.nor = grow(this.nor, 3);
      if (this.uv) this.uv = grow(this.uv, 2);
      if (this.col) this.col = grow(this.col, 3);
    }
    if (this.ni + ni > this._icap) {
      while (this.ni + ni > this._icap) this._icap *= 2;
      const b = new Uint32Array(this._icap);
      b.set(this.idx);
      this.idx = b;
    }
  }

  /** Adds a vertex in local space; returns its index. */
  vert(x, y, z, nx, ny, nz, u, v, c) {
    const i = this.nv++;
    const { cos, sin } = this;
    this.pos[i * 3] = x * cos + z * sin + this.tx;
    this.pos[i * 3 + 1] = y + this.ty;
    this.pos[i * 3 + 2] = -x * sin + z * cos + this.tz;
    if (this.nor) {
      this.nor[i * 3] = nx * cos + nz * sin;
      this.nor[i * 3 + 1] = ny;
      this.nor[i * 3 + 2] = -nx * sin + nz * cos;
    }
    if (this.uv) {
      this.uv[i * 2] = u;
      this.uv[i * 2 + 1] = v;
    }
    if (this.col) {
      this.col[i * 3] = c[0];
      this.col[i * 3 + 1] = c[1];
      this.col[i * 3 + 2] = c[2];
    }
    return i;
  }

  /**
   * Quad from four corners given counter-clockwise as seen from the front.
   * uv = [u0,v0,u1,v1] maps a->(u0,v0), b->(u1,v0), c->(u1,v1), d->(u0,v1).
   */
  quad(a, b, c, d, col, uv, cTop) {
    this._reserve(4, 6);
    // face normal from the corners
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const u0 = uv ? uv[0] : 0, v0 = uv ? uv[1] : 0, u1 = uv ? uv[2] : 1, v1 = uv ? uv[3] : 1;
    const ct = cTop || col;
    const i0 = this.vert(a[0], a[1], a[2], nx, ny, nz, u0, v0, col);
    this.vert(b[0], b[1], b[2], nx, ny, nz, u1, v0, col);
    this.vert(c[0], c[1], c[2], nx, ny, nz, u1, v1, ct);
    this.vert(d[0], d[1], d[2], nx, ny, nz, u0, v1, ct);
    const k = this.ni;
    this.idx[k] = i0; this.idx[k + 1] = i0 + 1; this.idx[k + 2] = i0 + 2;
    this.idx[k + 3] = i0; this.idx[k + 4] = i0 + 2; this.idx[k + 5] = i0 + 3;
    this.ni += 6;
  }

  tri(a, b, c, col) {
    this._reserve(3, 3);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const i0 = this.vert(a[0], a[1], a[2], nx, ny, nz, 0, 0, col);
    this.vert(b[0], b[1], b[2], nx, ny, nz, 1, 0, col);
    this.vert(c[0], c[1], c[2], nx, ny, nz, 0.5, 1, col);
    this.idx[this.ni++] = i0; this.idx[this.ni++] = i0 + 1; this.idx[this.ni++] = i0 + 2;
  }

  /**
   * Vertical wall from A to B (XZ) between y0 and y1. The front faces to the
   * left of the A->B direction, i.e. walk a footprint NW->NE->SE->SW.
   */
  wall(ax, az, bx, bz, y0, y1, col, uv, cTop) {
    this.quad([bx, y0, bz], [ax, y0, az], [ax, y1, az], [bx, y1, bz], col, uv, cTop);
  }

  /** Horizontal quad facing up; uv spans the rectangle. */
  floor(x0, z0, x1, z1, y, col, uv) {
    this.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], col, uv);
  }

  /**
   * Axis-aligned box (in local space). faces: bitmask 1=+x 2=-x 4=+z 8=-z 16=top 32=bottom.
   * cTop optionally gives the top vertices a different colour (cheap gradient / AO).
   */
  box(x0, y0, z0, x1, y1, z1, col, faces = 31, cTop) {
    if (faces & 8) this.wall(x0, z0, x1, z0, y0, y1, col, null, cTop);
    if (faces & 1) this.wall(x1, z0, x1, z1, y0, y1, col, null, cTop);
    if (faces & 4) this.wall(x1, z1, x0, z1, y0, y1, col, null, cTop);
    if (faces & 2) this.wall(x0, z1, x0, z0, y0, y1, col, null, cTop);
    if (faces & 16) this.floor(x0, z0, x1, z1, y1, cTop || col);
    if (faces & 32) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], col);
  }

  /**
   * Box whose top rectangle differs from the bottom one (cabins, roofs,
   * barriers). b = [x0,z0,x1,z1] at y0, t = [x0,z0,x1,z1] at y1.
   */
  taper(b, y0, t, y1, col, top = true, cTop) {
    const ct = cTop || col;
    this.quad([b[2], y0, b[1]], [b[0], y0, b[1]], [t[0], y1, t[1]], [t[2], y1, t[1]], col, null, ct); // -z
    this.quad([b[2], y0, b[3]], [b[2], y0, b[1]], [t[2], y1, t[1]], [t[2], y1, t[3]], col, null, ct); // +x
    this.quad([b[0], y0, b[3]], [b[2], y0, b[3]], [t[2], y1, t[3]], [t[0], y1, t[3]], col, null, ct); // +z
    this.quad([b[0], y0, b[1]], [b[0], y0, b[3]], [t[0], y1, t[3]], [t[0], y1, t[1]], col, null, ct); // -x
    if (top) this.floor(t[0], t[1], t[2], t[3], y1, ct);
  }

  /** Upright cylinder / cone frustum. */
  cyl(x, z, y0, y1, r0, r1, sides, col, capTop = true, cTop) {
    const ct = cTop || col;
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      this.quad(
        [x + c0 * r0, y0, z - s0 * r0], [x + c1 * r0, y0, z - s1 * r0],
        [x + c1 * r1, y1, z - s1 * r1], [x + c0 * r1, y1, z - s0 * r1], col, null, ct);
      if (capTop && r1 > 0.01) this.tri([x, y1, z], [x + c0 * r1, y1, z - s0 * r1], [x + c1 * r1, y1, z - s1 * r1], ct);
    }
  }

  /** Low-poly blob (octahedron) for tree crowns and shrubs. */
  blob(x, y, z, rx, ry, rz, col, cTop) {
    const ct = cTop || col;
    const top = [x, y + ry, z], bot = [x, y - ry, z];
    const ring = [[x + rx, y, z], [x, y, z - rz], [x - rx, y, z], [x, y, z + rz]];
    for (let i = 0; i < 4; i++) {
      const a = ring[i], b = ring[(i + 1) % 4];
      this.tri(a, b, top, ct);
      this.tri(b, a, bot, col);
    }
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, this.nv * 3), 3));
    if (this.nor) g.setAttribute('normal', new THREE.BufferAttribute(this.nor.slice(0, this.nv * 3), 3));
    if (this.uv) g.setAttribute('uv', new THREE.BufferAttribute(this.uv.slice(0, this.nv * 2), 2));
    if (this.col) g.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, this.nv * 3), 3));
    const idx = this.nv > 65535 ? this.idx.slice(0, this.ni) : Uint16Array.from(this.idx.subarray(0, this.ni));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}
