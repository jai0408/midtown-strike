// Cedar Lodge koi pond. The outline / depth come from pond_shape.js (shared with the terrain hole and the
// physics basin). Everything static is one Blender-built set (tools/blender/build_lodge_props.py):
//   pond_rock   36 displaced, mossy river stones (merged)           -> 1 draw call
//   pond_floor  muddy gravel basin + sunken leaves + submerged rocks -> 1 draw call (caustics in its shader)
//   pond_plants lily pads, lotus flowers, reeds, cattails, ferns     -> 1 draw call (alpha-tested atlas)
// plus the water surface (1), and ten koi (CC-BY, 7PLUS) drawn as ONE InstancedMesh with the baked swim cycle
// replayed from a 4-mode PCA in the vertex shader (1). Five draw calls in total.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { F_DEFAULT, S_CONCRETE } from '../core/physics.js';
import { POND, pondRadius, pondDrop } from './pond_shape.js';
import { KOI_GLB } from './creatures_asset.js';
import { LODGE_PROPS_DATA } from './lodge_props_asset.js';
import { loadLodgeProps } from './school_bus.js';

export { pondRadius };

function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// 10 Japanese koi varieties: base (white/body), pat (red/yellow patches), dark (sumi / shading), sRGB 0..1
const KOI_SPECIES = [
  { name: 'Kohaku', base: [0.97, 0.96, 0.94], pat: [0.90, 0.20, 0.06], dark: [0.88, 0.30, 0.18] },
  { name: 'Taisho Sanke', base: [0.96, 0.95, 0.93], pat: [0.88, 0.18, 0.05], dark: [0.06, 0.06, 0.08] },
  { name: 'Showa', base: [0.10, 0.10, 0.12], pat: [0.88, 0.17, 0.05], dark: [0.94, 0.94, 0.90] },
  { name: 'Yamabuki Ogon', base: [0.96, 0.74, 0.10], pat: [1.00, 0.86, 0.22], dark: [0.80, 0.56, 0.05] },
  { name: 'Shiro Utsuri', base: [0.94, 0.94, 0.94], pat: [0.07, 0.07, 0.09], dark: [0.06, 0.06, 0.08] },
  { name: 'Tancho', base: [0.98, 0.98, 0.98], pat: [0.88, 0.08, 0.05], dark: [0.80, 0.82, 0.84] },
  { name: 'Asagi', base: [0.62, 0.72, 0.80], pat: [0.92, 0.36, 0.09], dark: [0.16, 0.24, 0.34] },
  { name: 'Ki Utsuri', base: [0.93, 0.76, 0.08], pat: [0.07, 0.07, 0.09], dark: [0.07, 0.07, 0.09] },
  { name: 'Beni Kumonryu', base: [0.95, 0.94, 0.92], pat: [0.86, 0.14, 0.06], dark: [0.10, 0.10, 0.14] },
  { name: 'Kin Matsuba', base: [0.80, 0.56, 0.16], pat: [0.95, 0.70, 0.24], dark: [0.25, 0.15, 0.06] },
];

const GLSL_CAUSTIC = `
  float causticPat(vec2 p, float t) {
    vec2 q = p * 1.55;
    float acc = 0.0;
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      q += vec2(sin(q.y * 1.35 + t * 0.7 + fi * 1.9), cos(q.x * 1.15 - t * 0.6 + fi * 2.3)) * 0.62;
      float l = abs(sin(q.x * 2.1 + q.y * 0.7) * sin(q.y * 2.3 - q.x * 0.5 + t * 0.35));
      acc += 1.0 - clamp(l * 2.6, 0.0, 1.0);
    }
    return clamp(acc * 0.5, 0.0, 1.0);
  }`;

/**
 * Creates the natural uneven Koi Pond with 10 animated koi.
 * @param {{x:number, z:number, groundAt:Function, world?:object}} opts  groundAt is the EXCAVATED height function
 */
export function createKoiPond({ x: cx = POND.x, z: cz = POND.z, groundAt, world } = {}) {
  const group = new THREE.Group();
  group.name = 'koi_pond';

  const rawAt = (x, z) => groundAt(x, z) + pondDrop(x, z);
  // base level = the lowest bank point, water sits just under it
  let baseY = Infinity;
  for (let i = 0; i < 16; i++) {
    const th = (i / 16) * Math.PI * 2;
    const r = pondRadius(th) + 0.3;
    baseY = Math.min(baseY, rawAt(cx + Math.sin(th) * r, cz + Math.cos(th) * r));
  }
  if (!isFinite(baseY)) baseY = rawAt(cx, cz);
  const WATER_Y = -0.06;                 // local
  group.position.set(cx, baseY, cz);

  const waterUniforms = { uTime: { value: 0 }, uRip: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, 99, 0)) }, uWaterY: { value: baseY + WATER_Y } };
  const owned = { geos: [], mats: [] };

  // ---- coping rock colliders (same layout rule as before: every second stone, 0.8 m box) ----------------
  if (world) {
    const rocks = LODGE_PROPS_DATA.pond.rocks;
    for (let i = 0; i < rocks.length; i += 2) {
      const rx = cx + rocks[i][0], rz = cz + rocks[i][1];
      const ry = groundAt(rx, rz) + 0.08;
      world.addBox(rx - 0.4, ry - 0.2, rz - 0.4, rx + 0.4, ry + 0.6, rz + 0.4, F_DEFAULT, S_CONCRETE);
    }
  }

  // ---- water surface ----------------------------------------------------------------------------------
  const SEG = 48, RINGS = [0, 0.35, 0.7, 1.0];
  const wp = [], wd = [], wi = [];
  for (let k = 0; k < RINGS.length; k++) {
    for (let i = 0; i < (k === 0 ? 1 : SEG); i++) {
      const th = (i / SEG) * Math.PI * 2;
      const r = pondRadius(th) * RINGS[k];
      wp.push(Math.sin(th) * r, 0, Math.cos(th) * r);
      wd.push(Math.min(1, (1 - RINGS[k]) * 2));
    }
  }
  for (let i = 0; i < SEG; i++) wi.push(0, 1 + i, 1 + (i + 1) % SEG);
  for (let k = 1; k < RINGS.length - 1; k++) {
    const a = 1 + (k - 1) * SEG, b = 1 + k * SEG;
    for (let i = 0; i < SEG; i++) {
      const j = (i + 1) % SEG;
      wi.push(a + i, b + i, b + j, a + i, b + j, a + j);
    }
  }
  const waterGeo = new THREE.BufferGeometry();
  waterGeo.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3));
  waterGeo.setAttribute('aDepth', new THREE.Float32BufferAttribute(wd, 1));
  waterGeo.setIndex(wi);
  // normals up; winding fixed below by DoubleSide
  const wn = new Float32Array(wp.length);
  for (let i = 1; i < wn.length; i += 3) wn[i] = 1;
  waterGeo.setAttribute('normal', new THREE.BufferAttribute(wn, 3));

  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x2a6a58, roughness: 0.05, metalness: 0.0, transparent: true, opacity: 0.7,
    envMapIntensity: 1.7, depthWrite: false, side: THREE.DoubleSide,
  });
  waterMat.customProgramCacheKey = () => 'koi-pond-water-2';
  waterMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = waterUniforms.uTime;
    shader.uniforms.uRip = waterUniforms.uRip;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aDepth;\nvarying float vDepth;\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDepth = aDepth;\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vDepth;
        varying vec3 vWPos;
        uniform float uTime;
        uniform vec4 uRip[4];`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float dep = clamp(vDepth, 0.0, 1.0);
          vec3 shallow = vec3(0.11, 0.30, 0.22);
          vec3 deep = vec3(0.012, 0.085, 0.075);
          diffuseColor.rgb = mix(shallow, deep, pow(dep, 0.7));
          diffuseColor.a = mix(0.18, 0.74, pow(dep, 0.8));
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec2 p = vWPos.xz;
          float t = uTime;
          vec2 s = vec2(cos(p.x * 3.1 + t * 1.3 + p.y * 1.7), cos(p.y * 2.7 - t * 1.1 + p.x * 1.3)) * 0.022;
          s += vec2(cos(p.x * 7.3 - t * 2.2 + p.y * 4.1), cos(p.y * 6.1 + t * 1.9 - p.x * 3.7)) * 0.010;
          for (int i = 0; i < 4; i++) {
            vec4 r = uRip[i];
            vec2 d = p - r.xy;
            float dist = max(length(d), 0.001);
            float w = dist - r.z * 0.8;
            float env = exp(-w * w * 14.0) * exp(-r.z * 0.8) * r.w;
            s += (d / dist) * cos(w * 20.0) * env * 0.30;
          }
          vec3 wnrm = normalize(vec3(-s.x, 1.0, -s.y));
          normal = normalize((viewMatrix * vec4(wnrm, 0.0)).xyz);
        }`)
      .replace('#include <opaque_fragment>', `
        {
          float NdotV = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
          float fres = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);
          outgoingLight += reflectedLight.indirectSpecular * (fres * 0.9);
          outgoingLight += vec3(0.50, 0.68, 0.85) * (fres * 0.30);
          diffuseColor.a = clamp(diffuseColor.a + fres * 0.55, 0.0, 1.0);
        }
        #include <opaque_fragment>`);
  };
  const waterMesh = new THREE.Mesh(waterGeo, waterMat);
  waterMesh.position.y = WATER_Y;
  waterMesh.renderOrder = 3;
  group.add(waterMesh);
  owned.geos.push(waterGeo); owned.mats.push(waterMat);

  // ---- static set from the shared props glb ------------------------------------------------------------
  const follow = (geo, wfun) => {
    const pa = geo.attributes.position;
    for (let i = 0; i < pa.count; i++) {
      const px = pa.getX(i), pz = pa.getZ(i);
      const w = wfun(px, pz);
      if (w <= 0) continue;
      pa.setY(i, pa.getY(i) + (rawAt(cx + px, cz + pz) - baseY) * w);
    }
    pa.needsUpdate = true;
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
  };
  const relR = (px, pz) => Math.hypot(px, pz) / pondRadius(Math.atan2(px, pz));

  loadLodgeProps().then((gltf) => {
    for (const name of ['pond_rock', 'pond_floor', 'pond_plants']) {
      const m = gltf.scene.getObjectByName(name);
      if (!m) continue;
      m.parent.remove(m);
      m.position.set(0, 0, 0);
      m.receiveShadow = true;
      m.castShadow = name === 'pond_rock';
      // the exported factors are metalness 1 / roughness 1: with the ORM maps that made the stones black mirrors
      m.material.metalness = 0;
      // the baked AO channel of this ORM averages 0.13 (near black): that was the dark crescents round the rim
      if (name === 'pond_rock') { m.material.aoMapIntensity = 0.2; m.material.color.setScalar(1.5); }
      owned.geos.push(m.geometry);
      if (name === 'pond_rock') {
        follow(m.geometry, () => 1);
        // every boulder came out the same dark grey: vary each one (by its world position,
        // coarse enough that one stone keeps one tone) between granite grey, warm sandstone
        // and dark basalt, and grow moss on the up-facing tops
        const mat = m.material;
        mat.customProgramCacheKey = () => 'koi-pond-rock-1';
        mat.onBeforeCompile = (shader) => {
          shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vRPos;\nvarying float vUp;')
            .replace('#include <begin_vertex>', `#include <begin_vertex>
              vRPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
              vUp = (modelMatrix * vec4(objectNormal, 0.0)).y;`);
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
              varying vec3 vRPos;
              varying float vUp;
              // small, bounded hash (world coords are within a few hundred metres here)
              float rockHash(vec2 p) { p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }`)
            .replace('#include <map_fragment>', `#include <map_fragment>
              {
                float hsel = rockHash(floor(vRPos.xz / 0.7));
                vec3 tone = hsel < 0.4 ? vec3(0.92, 0.92, 0.95)        // granite
                          : hsel < 0.75 ? vec3(1.18, 1.02, 0.82)       // sandstone
                          : vec3(0.62, 0.64, 0.66);                     // basalt
                float fine = 0.88 + 0.24 * rockHash(floor(vRPos.xz * 6.0) + floor(vRPos.y * 6.0));
                diffuseColor.rgb *= tone * fine;
                float moss = smoothstep(0.55, 0.9, vUp) * smoothstep(0.25, 0.7, rockHash(floor(vRPos.xz / 0.35) + 7.0));
                diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.20, 0.27, 0.11), moss * 0.7);
              }`);
        };
        mat.needsUpdate = true;
      } else if (name === 'pond_floor') {
        follow(m.geometry, (px, pz) => smoothstep(0.8, 1.0, relR(px, pz)));
        const mat = m.material;
        mat.roughness = 0.9;
        mat.customProgramCacheKey = () => 'koi-pond-floor-1';
        mat.onBeforeCompile = (shader) => {
          shader.uniforms.uTime = waterUniforms.uTime;
          shader.uniforms.uWaterY = waterUniforms.uWaterY;
          shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
              varying vec3 vWPos;
              uniform float uTime;
              uniform float uWaterY;
              ${GLSL_CAUSTIC}`)
            .replace('#include <map_fragment>', `#include <map_fragment>
              float cDepth = clamp(uWaterY - vWPos.y, 0.0, 3.0);
              float cFade = exp(-cDepth * 0.55);
              diffuseColor.rgb *= exp(-cDepth * vec3(0.20, 0.07, 0.12));`)
            .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
              {
                float cs = causticPat(vWPos.xz, uTime);
                float under = step(vWPos.y, uWaterY);
                totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.97, 0.80) * (cs * cs * 1.4 * cFade * under);
              }`);
        };
        mat.needsUpdate = true;
        owned.mats.push(mat);
      } else {
        follow(m.geometry, (px, pz) => smoothstep(-0.2, 0.4, relR(px, pz) - 1.0) * 1.0);
        const mat = m.material;
        mat.side = THREE.DoubleSide;
        mat.alphaTest = 0.5;
        owned.mats.push(mat);
      }
      if (name === 'pond_rock') owned.mats.push(m.material);
      group.add(m);
    }
  }).catch((e) => console.warn('koi pond props failed to load', e));

  // ---- koi: ONE InstancedMesh ---------------------------------------------------------------------------
  const NK = 10;
  const koi = { mesh: null, K: 4, frames: 1, weights: null, dur: 1, fish: [], aW: null };
  const rippleQueue = { next: 0 };
  const rippleAge = new Float32Array(4).fill(99);
  const rippleAmp = new Float32Array(4);
  const rippleXZ = [0, 1, 2, 3].map(() => new THREE.Vector2());

  const addRipple = (lx, lz, amp) => {
    const i = rippleQueue.next++ % 4;
    rippleAge[i] = 0; rippleAmp[i] = amp; rippleXZ[i].set(cx + lx, cz + lz);
  };

  try {
    new GLTFLoader().parse(decodeBase64(KOI_GLB), '', (gltf) => {
      let src = null;
      gltf.scene.traverse((o) => { if (o.isMesh && !src) src = o; });
      const info = gltf.parser.json.meshes[0].extras.koi;
      koi.K = info.K; koi.frames = info.frames; koi.dur = info.duration; koi.weights = info.weights;
      const geo = src.geometry;
      for (let k = 0; k < 4; k++) {
        geo.setAttribute('aM' + k, geo.getAttribute('_mode' + k));
        geo.deleteAttribute('_mode' + k);
      }
      const base = new THREE.InstancedBufferAttribute(new Float32Array(NK * 3), 3);
      const pat = new THREE.InstancedBufferAttribute(new Float32Array(NK * 3), 3);
      const dark = new THREE.InstancedBufferAttribute(new Float32Array(NK * 3), 3);
      const aW = new THREE.InstancedBufferAttribute(new Float32Array(NK * 4), 4);
      aW.setUsage(THREE.DynamicDrawUsage);
      const col = new THREE.Color();
      KOI_SPECIES.forEach((sp, i) => {
        col.setRGB(sp.base[0], sp.base[1], sp.base[2], THREE.SRGBColorSpace); base.setXYZ(i, col.r, col.g, col.b);
        col.setRGB(sp.pat[0], sp.pat[1], sp.pat[2], THREE.SRGBColorSpace); pat.setXYZ(i, col.r, col.g, col.b);
        col.setRGB(sp.dark[0], sp.dark[1], sp.dark[2], THREE.SRGBColorSpace); dark.setXYZ(i, col.r, col.g, col.b);
      });
      geo.setAttribute('aBase', base); geo.setAttribute('aPat', pat); geo.setAttribute('aDark', dark); geo.setAttribute('aW', aW);
      const ms = info.scales;
      const mat = src.material.clone();
      mat.roughness = 0.2;
      mat.metalness = 0.0;
      mat.customProgramCacheKey = () => 'koi-inst-1';
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uMS = { value: new THREE.Vector4(ms[0], ms[1], ms[2], ms[3]) };
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>
            attribute vec3 aM0; attribute vec3 aM1; attribute vec3 aM2; attribute vec3 aM3;
            attribute vec3 aBase; attribute vec3 aPat; attribute vec3 aDark; attribute vec4 aW;
            uniform vec4 uMS;
            varying vec3 vBase; varying vec3 vPat; varying vec3 vDark;`)
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            transformed += aM0 * (uMS.x * aW.x) + aM1 * (uMS.y * aW.y) + aM2 * (uMS.z * aW.z) + aM3 * (uMS.w * aW.w);
            vBase = aBase; vPat = aPat; vDark = aDark;`);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vBase; varying vec3 vPat; varying vec3 vDark;')
          .replace('#include <map_fragment>', `#include <map_fragment>
            {
              // re-colour the photo texture per variety: white / red / dark classes -> instance colours
              vec3 tx = clamp(diffuseColor.rgb, 0.0, 1.0);
              float L = dot(tx, vec3(0.2126, 0.7152, 0.0722));
              float R = clamp((tx.r - max(tx.g, tx.b)) * 4.0, 0.0, 1.0);
              float D = (1.0 - smoothstep(0.02, 0.14, L)) * (1.0 - R);
              vec3 tint = mix(mix(vBase, vPat, R), vDark, D);
              float ref = mix(mix(0.55, 0.20, R), 0.05, D);
              float detail = clamp(L / max(ref, 0.02), 0.35, 1.7);
              diffuseColor.rgb = tint * mix(1.0, detail, 0.7);
            }`)
          .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
            {
              float nv = clamp(abs(dot(normalize(normal), normalize(vViewPosition))), 0.0, 1.0);
              // cheap sub-surface look: wrapped glow at the edges of the body, tinted by the scale colour
              totalEmissiveRadiance += diffuseColor.rgb * (0.10 + 0.22 * pow(1.0 - nv, 2.0));
            }`);
      };
      mat.needsUpdate = true;
      const mesh = new THREE.InstancedMesh(geo, mat, NK);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.name = 'koi_school';
      group.add(mesh);
      koi.mesh = mesh; koi.aW = aW;
      owned.geos.push(geo); owned.mats.push(mat);

      for (let i = 0; i < NK; i++) {
        const th = Math.random() * Math.PI * 2, r = (0.3 + 0.55 * Math.random()) * pondRadius(th);
        koi.fish.push({
          x: Math.sin(th) * r, z: Math.cos(th) * r, y: -0.4 - Math.random() * 0.6,
          psi: Math.random() * Math.PI * 2, spd: 0.3, spdT: 0.3, turn: 0, pitch: 0,
          tx: 0, tz: 0, retarget: 0, depthT: -0.5, surf: 0, nextSurf: 6 + Math.random() * 25,
          len: 0.62 + 0.30 * Math.random(), phase: Math.random() * koi.dur, pr: 0.8 + Math.random() * 0.4, tmult: 1.0, seed: Math.random() * 100,
        });
      }
    }, (e) => console.warn('koi parse failed', e));
  } catch (err) {
    console.warn('Failed to load KOI_GLB:', err);
  }

  const dummy = new THREE.Object3D();
  const sampleW = (f, out, o) => {
    const n = koi.frames;
    const x = ((f % 1) + 1) % 1 * n;
    const i0 = Math.floor(x) % n, i1 = (i0 + 1) % n, t = x - Math.floor(x);
    for (let k = 0; k < 4; k++) {
      const row = koi.weights[k];
      out[o + k] = row[i0] * (1 - t) + row[i1] * t;
    }
  };
  const pickTarget = (f) => {
    for (let n = 0; n < 8; n++) {
      const th = Math.random() * Math.PI * 2;
      const r = pondRadius(th) * (0.2 + 0.6 * Math.random());
      f.tx = Math.sin(th) * r; f.tz = Math.cos(th) * r;
      if (Math.hypot(f.tx - f.x, f.tz - f.z) > 1.2) break;
    }
    f.retarget = 2.5 + Math.random() * 5;
    f.spdT = 0.18 + Math.random() * 0.55 + (Math.random() < 0.12 ? 0.6 : 0);   // now and then a burst
    f.depthT = -0.30 - Math.random() * 0.85;
  };

  let simT = 0;
  return {
    group,
    update(dt) {
      if (dt <= 0 || dt > 0.25) dt = 0.016;
      simT += dt;
      waterUniforms.uTime.value = (waterUniforms.uTime.value + dt) % 3600;
      for (let i = 0; i < 4; i++) {
        if (rippleAge[i] < 20) rippleAge[i] += dt;
        const v = waterUniforms.uRip.value[i];
        v.set(rippleXZ[i].x, rippleXZ[i].y, rippleAge[i], rippleAge[i] < 8 ? rippleAmp[i] : 0);
      }
      if (!koi.mesh) return;
      const fish = koi.fish;
      for (let i = 0; i < NK; i++) {
        const f = fish[i];
        f.retarget -= dt;
        if (f.retarget <= 0) pickTarget(f);
        // steer: toward the target, away from the bank and from neighbours, with a limited turn rate
        const pr = pondRadius(Math.atan2(f.x, f.z));
        const rr = Math.hypot(f.x, f.z);
        let dx = f.tx - f.x, dz = f.tz - f.z;
        const edge = smoothstep(pr - 1.1, pr - 0.45, rr);
        dx = dx * (1 - edge) - f.x * edge * 1.5;
        dz = dz * (1 - edge) - f.z * edge * 1.5;
        for (let j = 0; j < NK; j++) {
          if (j === i) continue;
          const ox = f.x - fish[j].x, oz = f.z - fish[j].z, d2 = ox * ox + oz * oz;
          if (d2 < 0.5 && d2 > 1e-4) { const w = (0.5 - d2) * 3 / Math.sqrt(d2); dx += ox * w; dz += oz * w; }
        }
        const want = Math.atan2(dx, dz);
        let da = want - f.psi;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        const maxTurn = 1.1 + f.spd * 1.5;
        const turnT = THREE.MathUtils.clamp(da * 2.2, -maxTurn, maxTurn);
        f.turn += (turnT - f.turn) * Math.min(1, dt * 3.0);
        f.psi += f.turn * dt;
        // natural speed changes: ease toward the target speed, slow down for sharp turns
        const slow = 1 - 0.45 * Math.min(1, Math.abs(da));
        f.spd += (f.spdT * slow - f.spd) * Math.min(1, dt * 1.2);
        f.x += Math.sin(f.psi) * f.spd * dt;
        f.z += Math.cos(f.psi) * f.spd * dt;
        // keep inside the water even if steering lags
        const rr2 = Math.hypot(f.x, f.z), lim = pondRadius(Math.atan2(f.x, f.z)) - 0.4;
        if (rr2 > lim) { f.x *= lim / rr2; f.z *= lim / rr2; }
        // depth: wander, occasionally surface (ripple), never touch the floor
        f.nextSurf -= dt;
        if (f.surf > 0) {
          f.surf -= dt;
          if (f.surf <= 0) f.nextSurf = 12 + Math.random() * 30;
        } else if (f.nextSurf <= 0) {
          f.surf = 1.6; f.rippled = false;
        }
        let yT = f.depthT;
        if (f.surf > 0) {
          yT = -0.07;
          if (!f.rippled && f.surf < 1.0) { f.rippled = true; addRipple(f.x, f.z, 0.9); f.spdT = 0.15; }
        }
        const floorY = -pondDrop(cx + f.x, cz + f.z) + 0.22;
        const prevY = f.y;
        f.y += (Math.max(yT, floorY) - f.y) * Math.min(1, dt * 1.4);
        f.y = Math.min(f.y, WATER_Y - 0.03);
        const vy = (f.y - prevY) / dt;
        f.pitch += (THREE.MathUtils.clamp(-vy / Math.max(f.spd, 0.2), -0.5, 0.5) - f.pitch) * Math.min(1, dt * 4);
        // swim cycle: tail-beat rate follows speed
        f.phase += dt * (1.6 + 4.5 * f.spd) * f.pr;   // ~1-2 tail beats per second
        const lenBase = f.len;
        dummy.position.set(f.x, f.y + 0.012 * Math.sin(simT * 1.7 + f.seed), f.z);
        dummy.rotation.set(f.pitch, f.psi, -f.turn * 0.22, 'YXZ');
        dummy.scale.setScalar(lenBase);
        dummy.updateMatrix();
        koi.mesh.setMatrixAt(i, dummy.matrix);
        sampleW(f.phase / koi.dur, koi.aW.array, i * 4);
      }
      koi.mesh.instanceMatrix.needsUpdate = true;
      koi.aW.needsUpdate = true;
    },
    dispose() {
      for (const g of owned.geos) g.dispose();
      for (const m of owned.mats) {
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) if (m[k]) m[k].dispose();
        m.dispose();
      }
      if (koi.mesh) koi.mesh.dispose();
    },
  };
}
