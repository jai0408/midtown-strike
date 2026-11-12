// Pooled visual effects: tracers, muzzle flashes, impact sparks and dust,
// bullet-hole decals, explosions and the fires of burning wrecks.
// Everything lives in a handful of dynamic buffers (five draw calls total).
import * as THREE from 'three';
import { glowTexture, smokeTexture, flashTexture } from '../world/textures.js';
import { rand } from '../core/util.js';
import { S_METAL, S_GLASS, S_WOOD, S_GROUND, S_DIRT } from '../core/physics.js';

const VERT = `
  attribute float psize;
  attribute vec4 pcolor;
  uniform float scale;
  varying vec4 vColor;
  void main() {
    vColor = pcolor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = min(psize * scale / max(0.1, -mv.z), 512.0);
    gl_Position = projectionMatrix * mv;
  }`;
const FRAG = `
  uniform sampler2D map;
  varying vec4 vColor;
  void main() {
    vec4 t = texture2D(map, gl_PointCoord);
    gl_FragColor = vec4(vColor.rgb * t.rgb, vColor.a * t.a);
    #include <colorspace_fragment>
  }`;

class Particles {
  constructor(scene, cap, map, additive) {
    this.cap = cap;
    this.next = 0;
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 4);
    this.size = new Float32Array(cap);
    this.vel = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.max = new Float32Array(cap);
    this.s0 = new Float32Array(cap);
    this.s1 = new Float32Array(cap);
    this.rgb = new Float32Array(cap * 3);
    this.alpha = new Float32Array(cap);
    this.grav = new Float32Array(cap);
    this.drag = new Float32Array(cap);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('psize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: map }, scale: { value: 500 } },
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 6 : 5;
    scene.add(this.points);
    this.live = 0;
  }

  spawn(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a = 1, grav = 0, drag = 0) {
    const i = this.next;
    this.next = (i + 1) % this.cap;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life; this.max[i] = life;
    this.s0[i] = s0; this.s1[i] = s1;
    this.rgb[i * 3] = r; this.rgb[i * 3 + 1] = g; this.rgb[i * 3 + 2] = b;
    this.alpha[i] = a; this.grav[i] = grav; this.drag[i] = drag;
  }

  update(dt) {
    let live = 0;
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) {
        if (this.size[i] !== 0) this.size[i] = 0;
        continue;
      }
      live++;
      this.life[i] -= dt;
      const k = Math.max(0, this.life[i] / this.max[i]);
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= d; this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - this.grav[i] * dt; this.vel[i * 3 + 2] *= d;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = this.life[i] > 0 ? this.s0[i] + (this.s1[i] - this.s0[i]) * (1 - k) : 0;
      this.col[i * 4] = this.rgb[i * 3]; this.col[i * 4 + 1] = this.rgb[i * 3 + 1]; this.col[i * 4 + 2] = this.rgb[i * 3 + 2];
      this.col[i * 4 + 3] = this.alpha[i] * Math.min(1, k * 2.2);
    }
    if (live || this.live) {
      const g = this.points.geometry;
      g.attributes.position.needsUpdate = true;
      g.attributes.pcolor.needsUpdate = true;
      g.attributes.psize.needsUpdate = true;
    }
    this.live = live;
  }
}

const MAX_TRACERS = 40, MAX_DECALS = 64;
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _side = new THREE.Vector3(), _view = new THREE.Vector3();

export class FX {
  constructor(scene) {
    this.scene = scene;
    const glow = glowTexture();
    this.sparks = new Particles(scene, 320, glow, true);
    this.flash = new Particles(scene, 48, flashTexture(), true);
    this.smoke = new Particles(scene, 260, smokeTexture(), false);

    // tracers: camera-facing streak quads
    this.tr = [];
    for (let i = 0; i < MAX_TRACERS; i++) this.tr.push({ t: 0, dur: 0, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, r: 1, g: 0.9, b: 0.6, w: 0.05 });
    this.trNext = 0;
    this.trPos = new Float32Array(MAX_TRACERS * 12);
    this.trCol = new Float32Array(MAX_TRACERS * 12);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this.trPos, 3).setUsage(THREE.DynamicDrawUsage));
    tg.setAttribute('color', new THREE.BufferAttribute(this.trCol, 3).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    for (let i = 0; i < MAX_TRACERS; i++) idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    tg.setIndex(idx);
    this.trMesh = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    }));
    this.trMesh.frustumCulled = false;
    this.trMesh.renderOrder = 6;
    scene.add(this.trMesh);

    // bullet holes / scorch marks
    this.dcPos = new Float32Array(MAX_DECALS * 12);
    this.dcUv = new Float32Array(MAX_DECALS * 8);
    this.dcCol = new Float32Array(MAX_DECALS * 16);
    for (let i = 0; i < MAX_DECALS; i++) this.dcUv.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8);
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(this.dcPos, 3).setUsage(THREE.DynamicDrawUsage));
    dg.setAttribute('uv', new THREE.BufferAttribute(this.dcUv, 2));
    dg.setAttribute('color', new THREE.BufferAttribute(this.dcCol, 4).setUsage(THREE.DynamicDrawUsage));
    const di = [];
    for (let i = 0; i < MAX_DECALS; i++) di.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    dg.setIndex(di);
    this.dcMesh = new THREE.Mesh(dg, new THREE.MeshBasicMaterial({
      map: glowTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)'), vertexColors: true, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }));
    this.dcMesh.frustumCulled = false;
    this.dcMesh.renderOrder = 4;
    scene.add(this.dcMesh);
    this.dcNext = 0;
    this.emitters = [];
    this.emitT = 0;
    this.shake = 0;
  }

  setEmitters(list) {
    this.emitters = list;
  }

  tracer(ax, ay, az, bx, by, bz, friendly = true, heavy = false) {
    const t = this.tr[this.trNext];
    this.trNext = (this.trNext + 1) % MAX_TRACERS;
    const len = Math.hypot(bx - ax, by - ay, bz - az);
    t.ax = ax; t.ay = ay; t.az = az; t.bx = bx; t.by = by; t.bz = bz;
    t.dur = Math.max(0.06, Math.min(0.45, len / 420));
    t.t = t.dur;
    t.len = len;
    t.w = heavy ? 0.085 : 0.05;
    if (friendly) { t.r = 1.0; t.g = 0.82; t.b = 0.45; } else { t.r = 1.0; t.g = 0.35; t.b = 0.25; }
  }

  muzzle(x, y, z, big = false) {
    this.flash.spawn(x, y, z, 0, 0, 0, 0.055, big ? 1.5 : 0.85, big ? 2.0 : 1.1, 1, 0.9, 0.7, 1);
    this.smoke.spawn(x, y, z, rand(-0.3, 0.3), 0.5, rand(-0.3, 0.3), 0.5, 0.25, 0.9, 0.7, 0.7, 0.7, 0.22, 0, 2);
  }

  decal(x, y, z, nx, ny, nz, size, r = 0.03, g = 0.03, b = 0.03, a = 0.85) {
    const i = this.dcNext;
    this.dcNext = (i + 1) % MAX_DECALS;
    // tangent basis
    let tx, ty, tz;
    if (Math.abs(ny) > 0.9) { tx = 1; ty = 0; tz = 0; } else { tx = -nz; ty = 0; tz = nx; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l; }
    const ux = ny * tz - nz * ty, uy = nz * tx - nx * tz, uz = nx * ty - ny * tx;
    const o = 0.012, p = this.dcPos, k = i * 12;
    const cx = x + nx * o, cy = y + ny * o, cz = z + nz * o;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (let c = 0; c < 4; c++) {
      const [s, t] = corners[c];
      p[k + c * 3] = cx + (tx * s + ux * t) * size;
      p[k + c * 3 + 1] = cy + (ty * s + uy * t) * size;
      p[k + c * 3 + 2] = cz + (tz * s + uz * t) * size;
      this.dcCol.set([r, g, b, a], i * 16 + c * 4);
    }
    this.dcMesh.geometry.attributes.position.needsUpdate = true;
    this.dcMesh.geometry.attributes.color.needsUpdate = true;
  }

  impact(x, y, z, nx, ny, nz, surf) {
    const metal = surf === S_METAL, glass = surf === S_GLASS, soft = surf === S_DIRT || surf === S_WOOD;
    const n = metal ? 7 : 4;
    for (let i = 0; i < n; i++) {
      const sp = rand(2, metal ? 9 : 5);
      this.sparks.spawn(x, y, z, nx * sp + rand(-2.5, 2.5), ny * sp + rand(-1, 3.5), nz * sp + rand(-2.5, 2.5),
        rand(0.12, 0.3), 0.16, 0.03, 1, metal ? 0.85 : 0.7, metal ? 0.5 : 0.35, 1, 9, 1);
    }
    const c = soft ? [0.5, 0.42, 0.3] : glass ? [0.75, 0.82, 0.9] : [0.62, 0.62, 0.6];
    for (let i = 0; i < 2; i++) {
      this.smoke.spawn(x + nx * 0.05, y + ny * 0.05, z + nz * 0.05, nx * rand(0.4, 1.4) + rand(-0.4, 0.4), ny * rand(0.4, 1.4) + rand(0.1, 0.7), nz * rand(0.4, 1.4) + rand(-0.4, 0.4),
        rand(0.45, 0.8), 0.25, rand(0.9, 1.5), c[0], c[1], c[2], 0.4, -0.2, 2.5);
    }
    this.decal(x, y, z, nx, ny, nz, glass ? 0.11 : 0.07, glass ? 0.7 : 0.03, glass ? 0.8 : 0.03, glass ? 0.9 : 0.03, glass ? 0.5 : 0.85);
  }

  blood(x, y, z, dx, dy, dz) {
    for (let i = 0; i < 5; i++) {
      this.smoke.spawn(x, y, z, dx * rand(0.5, 2.5) + rand(-0.8, 0.8), rand(-0.2, 1.4), dz * rand(0.5, 2.5) + rand(-0.8, 0.8),
        rand(0.25, 0.45), 0.12, rand(0.35, 0.6), 0.5, 0.02, 0.02, 0.75, 4, 3);
    }
  }

  dust(x, y, z, n = 3) {
    for (let i = 0; i < n; i++) {
      this.smoke.spawn(x + rand(-0.2, 0.2), y + 0.05, z + rand(-0.2, 0.2), rand(-0.7, 0.7), rand(0.2, 0.7), rand(-0.7, 0.7), rand(0.4, 0.7), 0.3, 1.0, 0.55, 0.53, 0.5, 0.22, 0, 2);
    }
  }

  explosion(x, y, z) {
    this.flash.spawn(x, y + 0.6, z, 0, 0, 0, 0.12, 7, 12, 1, 0.85, 0.55, 1);
    for (let i = 0; i < 7; i++) {
      this.sparks.spawn(x + rand(-0.6, 0.6), y + rand(0.2, 1.2), z + rand(-0.6, 0.6), rand(-3, 3), rand(1, 5), rand(-3, 3), rand(0.25, 0.5), 3.5, 6.5, 1, 0.55, 0.15, 0.9, 0, 2.5);
    }
    for (let i = 0; i < 26; i++) {
      const a = rand(0, 6.283), sp = rand(5, 19);
      this.sparks.spawn(x, y + 0.3, z, Math.cos(a) * sp, rand(3, 15), Math.sin(a) * sp, rand(0.35, 0.9), 0.22, 0.04, 1, 0.75, 0.3, 1, 14, 0.6);
    }
    for (let i = 0; i < 12; i++) {
      this.smoke.spawn(x + rand(-1, 1), y + rand(0.3, 1.6), z + rand(-1, 1), rand(-2.2, 2.2), rand(1, 4), rand(-2.2, 2.2), rand(1.4, 2.6), 2.2, rand(5, 8), 0.18, 0.17, 0.16, 0.7, -0.4, 1.4);
    }
    this.decal(x, y + 0.02, z, 0, 1, 0, 2.6, 0.02, 0.02, 0.02, 0.9);
  }

  update(dt, camera, viewportHeight) {
    const scale = viewportHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
    this.sparks.mat.uniforms.scale.value = scale;
    this.flash.mat.uniforms.scale.value = scale;
    this.smoke.mat.uniforms.scale.value = scale;

    // fires burn only near the camera
    this.emitT -= dt;
    if (this.emitT <= 0) {
      this.emitT = 0.07;
      for (let i = 0; i < this.emitters.length; i++) {
        const e = this.emitters[i];
        const d2 = (e.x - camera.position.x) ** 2 + (e.z - camera.position.z) ** 2;
        if (d2 > 170 * 170) continue;
        this.sparks.spawn(e.x + rand(-0.9, 0.9), e.y + rand(-0.3, 0.3), e.z + rand(-0.9, 0.9), rand(-0.3, 0.3), rand(1.4, 3.2), rand(-0.3, 0.3), rand(0.5, 0.9), 1.9, 0.5, 1, rand(0.35, 0.6), 0.08, 0.85, -1, 0.5);
        if (Math.random() < 0.45) this.smoke.spawn(e.x + rand(-0.6, 0.6), e.y + 1.2, e.z + rand(-0.6, 0.6), rand(0.4, 1.1), rand(2.2, 3.6), rand(-0.3, 0.3), rand(3, 4.6), 1.6, rand(6, 9), 0.1, 0.1, 0.11, 0.6, 0, 0.25);
      }
    }
    this.sparks.update(dt);
    this.flash.update(dt);
    this.smoke.update(dt);

    // tracers
    const p = this.trPos, c = this.trCol;
    let any = false;
    for (let i = 0; i < MAX_TRACERS; i++) {
      const t = this.tr[i], k = i * 12;
      if (t.t <= 0) {
        if (p[k] !== 0 || p[k + 3] !== 0) { for (let j = 0; j < 12; j++) p[k + j] = 0; any = true; }
        continue;
      }
      any = true;
      t.t -= dt;
      const f = 1 - Math.max(0, t.t) / t.dur;           // head progress 0..1
      const streak = Math.min(0.5, 16 / Math.max(1, t.len));
      const f0 = Math.max(0, f - streak), f1 = Math.min(1, f + 0.02);
      _a.set(t.ax + (t.bx - t.ax) * f0, t.ay + (t.by - t.ay) * f0, t.az + (t.bz - t.az) * f0);
      _b.set(t.ax + (t.bx - t.ax) * f1, t.ay + (t.by - t.ay) * f1, t.az + (t.bz - t.az) * f1);
      _view.copy(_a).add(_b).multiplyScalar(0.5).sub(camera.position);
      const dist = _view.length();
      _side.subVectors(_b, _a).cross(_view).normalize().multiplyScalar(t.w * (1 + dist * 0.012));
      p[k] = _a.x - _side.x; p[k + 1] = _a.y - _side.y; p[k + 2] = _a.z - _side.z;
      p[k + 3] = _a.x + _side.x; p[k + 4] = _a.y + _side.y; p[k + 5] = _a.z + _side.z;
      p[k + 6] = _b.x + _side.x; p[k + 7] = _b.y + _side.y; p[k + 8] = _b.z + _side.z;
      p[k + 9] = _b.x - _side.x; p[k + 10] = _b.y - _side.y; p[k + 11] = _b.z - _side.z;
      for (let v = 0; v < 4; v++) {
        const tail = v < 2 ? 0.15 : 1;
        c[k + v * 3] = t.r * tail; c[k + v * 3 + 1] = t.g * tail; c[k + v * 3 + 2] = t.b * tail;
      }
    }
    if (any) {
      this.trMesh.geometry.attributes.position.needsUpdate = true;
      this.trMesh.geometry.attributes.color.needsUpdate = true;
    }
    this.shake = Math.max(0, this.shake - dt * 2.2);
  }
}
