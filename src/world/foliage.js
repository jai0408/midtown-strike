// Cedar Lodge vegetation: instanced pines, spruces, birches, bushes, ferns and a camera-centred
// grass field, with LOD swapping per 32 m chunk and a gentle shader wind.
//
// Meshes and atlases come from foliage_asset.js (tools/blender/build_foliage.py).
//
//   const fol = await buildFoliage({ foliage, heightAt, quality });
//   scene.add(fol.group);
//   fol.update(dt, camera.position, drawScale, camera);   // 4th argument is optional
//   fol.colliders                                           // trunk boxes for physics
//
// Nominal model sizes (scale 1): pine 15 / 19 m, spruce 16 m, birch 10.5 / 9 m, bush 1.1-1.35 m,
// fern 1.05 m. Grass density is sampled with nodes at x0 + i * size / (n - 1).
import * as THREE from 'three';
import { FOLIAGE_TEX, FOLIAGE_MODELS } from './foliage_asset.js';
import { F_DEFAULT, S_WOOD } from '../core/physics.js';

const CHUNK = 32;
const TIME_WRAP = 20 * Math.PI; // wind frequencies are multiples of 0.1 so the wrap is seamless

/** Per-quality settings. dist/lod0 are metres at drawScale 1; grass is the radius around the camera. */
const QUALITY = {
  low: { dist: 60, lod0: 18, grass: 0, spacing: 0.9, shadow: false },
  medium: { dist: 90, lod0: 24, grass: 22, spacing: 0.75, shadow: false },
  high: { dist: 120, lod0: 32, grass: 35, spacing: 0.6, shadow: true },
  ultra: { dist: 160, lod0: 42, grass: 45, spacing: 0.5, shadow: true },
};

/** Draw / LOD0 distance multipliers per model class. */
const CLASS = {
  tree: { cull: 1.0, lod0: 1.0, shadow: true, amp: 0.38, flutter: 0.05 },
  bush: { cull: 0.5, lod0: 0.45, shadow: false, amp: 0.07, flutter: 0.035 },
  fern: { cull: 0.32, lod0: 0.4, shadow: false, amp: 0.06, flutter: 0.03 },
};
const MODEL_CLASS = { pine0: 'tree', pine1: 'tree', spruce0: 'tree', birch0: 'tree', birch1: 'tree', bush0: 'bush', bush1: 'bush', fern0: 'fern' };

// ---------------------------------------------------------------------------------------------
// decoding
// ---------------------------------------------------------------------------------------------

/**
 * Decodes one mesh blob of foliage_asset.js.
 * @param {{v:number,t:number,s:number,d:string}} m
 * @returns {{pos:Float32Array,uv:Float32Array,idx:Uint16Array,nor:Float32Array,ao:Uint8Array,sway:Uint8Array,nv:number,ni:number}}
 */
export function decodeFoliageMesh(m) {
  const bin = atob(m.d);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dv = new DataView(bytes.buffer);
  const nv = m.v, ni = m.t * 3;
  const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), nor = new Float32Array(nv * 3);
  const idx = new Uint16Array(ni);
  let o = 0;
  for (let i = 0; i < nv * 3; i++, o += 2) pos[i] = dv.getInt16(o, true) * m.s;
  for (let i = 0; i < nv * 2; i++, o += 2) uv[i] = dv.getUint16(o, true) / 65535;
  for (let i = 0; i < ni; i++, o += 2) idx[i] = dv.getUint16(o, true);
  for (let i = 0; i < nv * 3; i++, o++) nor[i] = dv.getInt8(o) / 127;
  const ao = bytes.slice(o, o + nv); o += nv;
  const sway = bytes.slice(o, o + nv); o += nv;
  if (o !== bytes.length) throw new Error('foliage mesh size mismatch');
  return { pos, uv, idx, nor, ao, sway, nv, ni };
}

function makeGeometry(m) {
  const d = decodeFoliageMesh(m);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(d.nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(d.uv, 2));
  const col = new Uint8Array(d.nv * 3); // baked AO as grey vertex colour
  for (let i = 0; i < d.nv; i++) col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = d.ao[i];
  g.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
  g.setAttribute('aSway', new THREE.BufferAttribute(d.sway, 1, true));
  g.setIndex(new THREE.BufferAttribute(d.idx, 1));
  g.computeBoundingSphere();
  return g;
}

function loadImage(uri) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('foliage texture failed to decode'));
    im.src = uri;
  });
}

function imagePixels(im, w, h) {
  const c = document.createElement('canvas');
  c.width = w || im.naturalWidth; c.height = h || im.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(im, 0, 0, c.width, c.height);
  return ctx.getImageData(0, 0, c.width, c.height);
}

/** Row-flipped (v = 0 at the bottom) RGBA DataTexture. */
function dataTexture(rgba, w, h, srgb, aniso) {
  const out = new Uint8Array(w * h * 4);
  const row = w * 4;
  for (let y = 0; y < h; y++) out.set(rgba.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  const t = new THREE.DataTexture(out, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

/** Decodes the JPEG atlases; leaf colour and its separate alpha JPEG become one RGBA texture. */
async function loadTextures(aniso) {
  if (typeof document === 'undefined') { // headless (tests): 1x1 stand-ins
    const px = (r, g, b, a) => dataTexture(new Uint8Array([r, g, b, a]), 1, 1, false, 1);
    return { bark: px(120, 90, 70, 255), barkN: px(128, 128, 255, 255), leaf: px(60, 110, 50, 255), leafN: px(128, 128, 255, 255), imp: px(60, 110, 50, 255) };
  }
  const [bark, barkN, leaf, leafA, leafN, imp, impA] = await Promise.all([FOLIAGE_TEX.bark, FOLIAGE_TEX.barkN, FOLIAGE_TEX.leaf, FOLIAGE_TEX.leafA, FOLIAGE_TEX.leafN, FOLIAGE_TEX.imp, FOLIAGE_TEX.impA].map(loadImage));
  const [bd, bnd, ld, nd] = [imagePixels(bark), imagePixels(barkN), imagePixels(leaf), imagePixels(leafN)];
  const ad = imagePixels(leafA, ld.width, ld.height).data;
  const lp = ld.data;
  for (let i = 0; i < lp.length; i += 4) lp[i + 3] = ad[i];
  const id = imagePixels(imp), ia = imagePixels(impA, id.width, id.height).data;
  for (let i = 0; i < id.data.length; i += 4) id.data[i + 3] = ia[i];
  return {
    bark: dataTexture(bd.data, bd.width, bd.height, true, aniso),
    barkN: dataTexture(bnd.data, bnd.width, bnd.height, false, aniso),
    leaf: dataTexture(lp, ld.width, ld.height, true, aniso),
    leafN: dataTexture(nd.data, nd.width, nd.height, false, aniso),
    imp: dataTexture(id.data, id.width, id.height, true, aniso),
  };
}

// ---------------------------------------------------------------------------------------------
// materials (wind in onBeforeCompile; shared time / wind uniforms)
// ---------------------------------------------------------------------------------------------

const WIND_DIR = new THREE.Vector2(0.82, 0.57).normalize();
const SUN_DIR = new THREE.Vector3(-0.5003, 0.7204, 0.4803).normalize();

const SHARED = {
  uTime: { value: 0 },
  uWind: { value: 0.85 },
  uWindDir: { value: WIND_DIR },
  uCam: { value: new THREE.Vector3() },
  uSunDir: { value: SUN_DIR },
};

const VERT_PARS = `
attribute float aSway;
uniform float uTime;
uniform float uWind;
uniform vec2 uWindDir;
uniform float uAmp;
uniform float uFlutter;
uniform vec3 uCam;
uniform float uFadeR;
`;

/** Shrinks grass into the ground towards the edge of the field and adds traveling wind waves. */
const FADE = `
if (uFadeR > 0.0) {
  #ifdef USE_INSTANCING
  vec3 gw = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  #else
  vec3 gw = (modelMatrix * vec4(transformed, 1.0)).xyz;
  #endif
  vec2 gd = gw.xz - uCam.xz;
  float gdist = sqrt(dot(gd, gd));
  transformed *= 1.0 - smoothstep(uFadeR * 0.62, uFadeR, gdist);
  
  // Dynamic traveling grass ripple wave aligned with wind direction
  float gCoord = dot(gw.xz, uWindDir);
  float gWave = sin(gCoord * 0.28 - uTime * 2.6) * 0.55 + sin(gCoord * 0.62 - uTime * 3.8) * 0.25;
  float gBend = (0.45 + 0.55 * gWave) * uWind * 0.26 * clamp(transformed.y * 1.5, 0.0, 1.0);
  transformed.x += uWindDir.x * gBend;
  transformed.z += uWindDir.y * gBend;
}
`;

/** Wind: physical traveling gust fronts along uWindDir, hierarchical trunk/branch/leaf sway. */
const SWAY = `
{
  vec3 ip = vec3(0.0);
  vec3 c0 = vec3(1.0, 0.0, 0.0);
  vec3 c2 = vec3(0.0, 0.0, 1.0);
  #ifdef USE_INSTANCING
  ip = instanceMatrix[3].xyz;
  c0 = instanceMatrix[0].xyz;
  c2 = instanceMatrix[2].xyz;
  #endif
  vec3 wd = vec3(uWindDir.x, 0.0, uWindDir.y);
  vec2 wl = vec2(dot(c0, wd) / max(dot(c0, c0), 0.0001), dot(c2, wd) / max(dot(c2, c2), 0.0001));
  
  // Physical gust propagation along the wind direction:
  float wCoord = dot(ip.xz, uWindDir);
  float gustFront1 = sin(wCoord * 0.032 - uTime * 1.5);
  float gustFront2 = sin(wCoord * 0.016 - uTime * 0.82 + 1.6);
  float gust = 0.55 + 0.45 * (gustFront1 * 0.68 + gustFront2 * 0.32);
  
  float ph = fract(ip.x * 0.0173 + ip.z * 0.0291) * 6.2831853;
  float w = aSway;
  float w2 = w * w;
  
  // Hierarchical sway: slow heavy trunk inertia + faster branch oscillations + wind lean
  float osc = 0.62 * sin(uTime * 1.15 + ph) + 0.38 * sin(uTime * 1.85 + ph * 1.5);
  float swayAmp = ((0.32 + 0.68 * osc) * gust * uWind + 0.22 * uWind) * w2 * uAmp;
  transformed.x += wl.x * swayAmp;
  transformed.z += wl.y * swayAmp;
  transformed.y -= abs(swayAmp) * 0.22;
  
  // High-frequency turbulent leaf/needle flutter:
  float flPhase = uTime * 4.9 + dot(position, vec3(2.4, 1.8, 3.0)) + ph;
  float flutter = sin(flPhase) * uWind * (0.35 + 0.65 * gust) * w * uFlutter;
  transformed += vec3(flutter, 0.4 * flutter, -flutter * 0.75);
}
`;

/**
 * Builds a wind material.
 * @param {object} p {map, normalMap, normalScale, side, amp, flutter, fade, alphaTest, roughness, selfLit, twoSidedLight}
 */
function windMaterial(p) {
  const m = new THREE.MeshStandardMaterial({
    map: p.map, normalMap: p.normalMap, normalScale: new THREE.Vector2(p.normalScale, p.normalScale),
    side: p.side, alphaTest: p.alphaTest, roughness: p.roughness, metalness: 0, vertexColors: true,
  });
  const uniforms = { ...SHARED, uAmp: { value: p.amp }, uFlutter: { value: p.flutter }, uFadeR: { value: 0 }, uSelfLit: { value: p.selfLit } };
  m.userData.uniforms = uniforms;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + FADE + SWAY);
    if (p.twoSidedLight) {
      // leaves are lit like thin shells: no normal flip on the back face (normals are bent already)
      // plus subsurface light scattering / canopy translucency when backlit by the sun
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uSunDir;')
        .replace('#include <normal_fragment_begin>',
          THREE.ShaderChunk.normal_fragment_begin.replace('float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;', 'float faceDirection = 1.0;'))
        .replace('#include <opaque_fragment>', `
          {
            vec3 vDir = normalize(vViewPosition);
            float backlight = clamp(dot(-vDir, uSunDir), 0.0, 1.0);
            float sss = pow(backlight, 2.6) * 0.4;
            vec3 sssCol = diffuseColor.rgb * vec3(1.15, 1.35, 0.75);
            outgoingLight += sssCol * sss;
          }
          #include <opaque_fragment>`);
    }
    if (p.selfLit > 0) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uSelfLit;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * uSelfLit;');
    }
  };
  m.customProgramCacheKey = () => `foliage-${p.amp}-${p.fade ? 'g' : 'f'}-${p.twoSidedLight ? 1 : 0}-${p.selfLit > 0 ? 1 : 0}`;
  return m;
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function hash(i, j, s) {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263) ^ Math.imul((s | 0) + 1, 1013904223);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function decodeU8(b64) {
  const bin = atob(b64);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

/** Writes a yaw + (sx, sy, sz) scale + translation matrix (column-major) into a[o..o+15]. */
function writeMatrix(a, o, x, y, z, yaw, sx, sy, sz) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  a[o] = c * sx; a[o + 1] = 0; a[o + 2] = -s * sx; a[o + 3] = 0;
  a[o + 4] = 0; a[o + 5] = sy; a[o + 6] = 0; a[o + 7] = 0;
  a[o + 8] = s * sz; a[o + 9] = 0; a[o + 10] = c * sz; a[o + 11] = 0;
  a[o + 12] = x; a[o + 13] = y; a[o + 14] = z; a[o + 15] = 1;
}

/** Maps a contract kind to a model variant (deterministic from the position). */
function modelFor(kind, x, z, tree) {
  const h = hash(Math.round(x * 4), Math.round(z * 4), 3);
  if (tree) {
    if (kind === 'spruce') return 'spruce0';
    if (kind === 'birch') return h < 0.5 ? 'birch0' : 'birch1';
    return h < 0.5 ? 'pine0' : 'pine1';
  }
  if (kind === 'fern') return 'fern0';
  if (kind === 'hedge') return 'bush1';
  return h < 0.5 ? 'bush0' : 'bush1';
}

/** Per-instance tint (multiplies the atlas colour). */
function tintFor(model, h1, h2, out) {
  const v = 0.86 + 0.24 * h1;
  if (model.startsWith('birch')) { out.r = v * (1.0 + 0.1 * h2); out.g = v * 0.97; out.b = v * 0.92; }
  else if (model.startsWith('pine')) { out.r = v * (0.92 + 0.08 * h2); out.g = v * 0.98; out.b = v * (1.02 + 0.08 * h2); }
  else if (model.startsWith('spruce')) { out.r = v * 0.95; out.g = v; out.b = v * (1.0 + 0.08 * h2); }
  else { out.r = v * (0.95 + 0.15 * h2); out.g = v; out.b = v * 0.92; }
}

// ---------------------------------------------------------------------------------------------
// the builder
// ---------------------------------------------------------------------------------------------

/**
 * Builds the vegetation of a map.
 * @param {object} opts
 * @param {{trees?:number[][],bushes?:number[][],grass?:{n:number,x0:number,z0:number,size:number,data:string}}} opts.foliage
 *        Contract data: trees / bushes are [x, y, z, scale, rotY, kind].
 * @param {(x:number,z:number)=>number} opts.heightAt Terrain height in metres.
 * @param {string} [opts.quality] 'low' | 'medium' | 'high' | 'ultra'
 * @returns {Promise<{group:THREE.Group, update:Function, colliders:number[][], setQuality:Function, dispose:Function}>}
 *   update(dt, camPos, drawScale, camera?) passes the camera to also cull chunks outside the view.
 */
export async function buildFoliage({ foliage, heightAt, quality = 'medium' }) {
  const tex = await loadTextures(4);
  const group = new THREE.Group();
  group.name = 'foliage';

  const barkMat = windMaterial({ map: tex.bark, normalMap: tex.barkN, normalScale: 0.8, side: THREE.FrontSide, amp: CLASS.tree.amp, flutter: 0, alphaTest: 0, roughness: 0.95, selfLit: 0 });
  const leafMats = {};
  for (const c of ['tree', 'bush', 'fern']) {
    leafMats[c] = windMaterial({ map: tex.leaf, normalMap: tex.leafN, normalScale: 0.8, side: THREE.DoubleSide, amp: CLASS[c].amp, flutter: CLASS[c].flutter, alphaTest: 0.45, roughness: 0.8, selfLit: 0.07, twoSidedLight: true });
  }
  // LOD1 birch crowns: crossed cards textured with renders of the LOD0 tree
  leafMats.imp = windMaterial({ map: tex.imp, normalMap: null, normalScale: 0, side: THREE.DoubleSide, amp: CLASS.tree.amp, flutter: 0.02, alphaTest: 0.45, roughness: 0.8, selfLit: 0.05, twoSidedLight: true });
  const grassMat = windMaterial({ map: tex.leaf, normalMap: tex.leafN, normalScale: 0.5, side: THREE.DoubleSide, amp: 0.16, flutter: 0.0, alphaTest: 0.5, roughness: 0.9, selfLit: 0.05, twoSidedLight: true, fade: true });
  const geoms = [];

  // ---- gather instances per model -------------------------------------------------------
  const colliders = [];
  const byModel = {};
  const tint = { r: 1, g: 1, b: 1 };
  const addInstance = (kind, a, tree) => {
    const x = a[0], y = a[1], z = a[2];
    const s = Math.min(3, Math.max(0.2, a[3] || 1));
    const model = modelFor(kind || a[5], x, z, tree);
    const rec = byModel[model] || (byModel[model] = { items: [] });
    const sx = a[5] === 'hedge' ? s * 1.7 : s, sy = a[5] === 'hedge' ? s * 0.85 : s;
    rec.items.push({ x, y, z, yaw: a[4] || 0, sx, sy, sz: s, ch: hash(Math.round(x * 8), Math.round(z * 8), 7), cs: hash(Math.round(z * 8), Math.round(x * 8), 9) });
    if (tree) {
      const m = FOLIAGE_MODELS[model];
      const w = Math.min(0.8, Math.max(0.4, m.trunk * 2 * s));
      const hh = Math.min(3, m.h * s);
      colliders.push([x - w / 2, y, z - w / 2, x + w / 2, y + hh, z + w / 2, F_DEFAULT, S_WOOD]);
    }
  };
  for (const t of (foliage && foliage.trees) || []) addInstance(t[5], t, true);
  for (const b of (foliage && foliage.bushes) || []) addInstance(b[5], b, false);

  // ---- per model: sorted instance arrays, chunk ranges, LOD meshes ------------------------
  const chunkMap = new Map();
  const kinds = [];
  for (const [name, rec] of Object.entries(byModel)) {
    const def = FOLIAGE_MODELS[name];
    const cls = MODEL_CLASS[name];
    const items = rec.items;
    items.forEach((it) => { it.key = Math.floor(it.x / CHUNK) * 100000 + Math.floor(it.z / CHUNK); });
    items.sort((p, q) => p.key - q.key);
    const n = items.length;
    const mats = new Float32Array(n * 16), cols = new Float32Array(n * 3), xz = new Float32Array(n * 2);
    const k = { name, cls, def, n, mats, cols, xz, lods: [], cursor: [0, 0] };
    items.forEach((it, i) => {
      writeMatrix(mats, i * 16, it.x, it.y, it.z, it.yaw, it.sx, it.sy, it.sz);
      tintFor(name, it.ch, it.cs, tint);
      cols[i * 3] = tint.r; cols[i * 3 + 1] = tint.g; cols[i * 3 + 2] = tint.b;
      xz[i * 2] = it.x; xz[i * 2 + 1] = it.z;
      let c = chunkMap.get(it.key);
      if (!c) {
        c = { cx: (Math.floor(it.x / CHUNK) + 0.5) * CHUNK, cz: (Math.floor(it.z / CHUNK) + 0.5) * CHUNK, min: new THREE.Vector3(1e9, 1e9, 1e9), max: new THREE.Vector3(-1e9, -1e9, -1e9), ranges: [], sphere: new THREE.Sphere() };
        chunkMap.set(it.key, c);
      }
      let r = c.ranges.find((q) => q.k === k);
      if (!r) { r = { k, start: i, count: 0 }; c.ranges.push(r); }
      r.count++;
      const ext = def.r * Math.max(it.sx, it.sz);
      c.min.set(Math.min(c.min.x, it.x - ext), Math.min(c.min.y, it.y), Math.min(c.min.z, it.z - ext));
      c.max.set(Math.max(c.max.x, it.x + ext), Math.max(c.max.y, it.y + def.h * it.sy), Math.max(c.max.z, it.z + ext));
    });
    for (let li = 0; li < def.lod.length; li++) {
      const L = def.lod[li];
      const parts = [];
      let shared = null;
      for (const key of ['bark', 'leaf']) {
        if (!L[key]) continue;
        const g = makeGeometry(L[key]);
        geoms.push(g);
        const mesh = new THREE.InstancedMesh(g, key === 'bark' ? barkMat : (L.imp ? leafMats.imp : leafMats[cls]), n);
        if (!shared) {
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
          mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
          shared = mesh;
        } else {
          mesh.instanceMatrix = shared.instanceMatrix;
          mesh.instanceColor = shared.instanceColor;
        }
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.receiveShadow = true;
        mesh.name = `${name}_lod${li}_${key}`;
        group.add(mesh);
        parts.push(mesh);
      }
      k.lods.push({ meshes: parts, shared });
    }
    kinds.push(k);
  }
  const chunks = [...chunkMap.values()];
  for (const c of chunks) {
    c.min.y -= 1;
    const box = new THREE.Box3(c.min, c.max);
    box.getBoundingSphere(c.sphere);
  }

  // ---- grass ------------------------------------------------------------------------------
  const gm = foliage && foliage.grass;
  const mask = gm && gm.data ? decodeU8(gm.data) : null;
  const grassGeo = makeGeometry(FOLIAGE_MODELS.grass0.lod[0].leaf);
  geoms.push(grassGeo);
  let grass = null; // { mesh, cap, scratchM, scratchC, count, R, spacing }
  let job = null;
  let lastGrassPos = null;

  const sampleMask = (x, z) => {
    const f = (gm.n - 1) / gm.size;
    const gx = Math.min(gm.n - 1.001, Math.max(0, (x - gm.x0) * f)), gz = Math.min(gm.n - 1.001, Math.max(0, (z - gm.z0) * f));
    const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
    const o = j * gm.n + i;
    const a = mask[o] * (1 - fx) + mask[o + 1] * fx, b = mask[o + gm.n] * (1 - fx) + mask[o + gm.n + 1] * fx;
    return (a * (1 - fz) + b * fz) / 255;
  };

  const setGrass = (R, spacing) => {
    if (grass) {
      group.remove(grass.mesh);
      grass.mesh.dispose();
      grass = null;
    }
    job = null;
    lastGrassPos = null;
    grassMat.userData.uniforms.uFadeR.value = R;
    if (!mask || R <= 0) return;
    const cap = Math.ceil((Math.PI * (R + 1) * (R + 1)) / (spacing * spacing));
    const mesh = new THREE.InstancedMesh(grassGeo, grassMat, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.name = 'grass';
    group.add(mesh);
    grass = { mesh, cap, scratchM: new Float32Array(cap * 16), scratchC: new Float32Array(cap * 3), R, spacing };
  };

  const startGrassJob = (cam) => {
    const { R, spacing } = grass;
    const r = R + 1;
    job = { cx: cam.x, cz: cam.z, i0: Math.floor((cam.x - r) / spacing), i1: Math.ceil((cam.x + r) / spacing), j: Math.floor((cam.z - r) / spacing), j1: Math.ceil((cam.z + r) / spacing), count: 0, r2: r * r };
  };

  const stepGrassJob = (budget) => {
    const g = grass, jb = job, sp = g.spacing;
    let cells = 0;
    while (jb.j <= jb.j1 && cells < budget) {
      const j = jb.j;
      for (let i = jb.i0; i <= jb.i1 && jb.count < g.cap; i++) {
        const x = (i + 0.1 + 0.8 * hash(i, j, 11)) * sp, z = (j + 0.1 + 0.8 * hash(i, j, 12)) * sp;
        const dx = x - jb.cx, dz = z - jb.cz;
        if (dx * dx + dz * dz > jb.r2) continue;
        const d = sampleMask(x, z);
        if (d < 0.03 || hash(i, j, 13) > Math.pow(d, 0.8)) continue;
        const h4 = hash(i, j, 14), h5 = hash(i, j, 15), h6 = hash(i, j, 16);
        const sxz = (0.75 + 0.7 * h4) * (0.65 + 0.35 * d), sy = (0.7 + 0.6 * h5) * (0.7 + 0.3 * d);
        const o = jb.count;
        writeMatrix(g.scratchM, o * 16, x, heightAt(x, z) - 0.03, z, h6 * 6.2831853, sxz, sy, sxz);
        const patch = 0.5 + 0.5 * Math.sin(x * 0.11 + 1.3) * Math.sin(z * 0.093 + 0.7); // dry patches
        const v = 0.82 + 0.3 * hash(i, j, 17);
        g.scratchC[o * 3] = v * (0.95 + 0.2 * patch);
        g.scratchC[o * 3 + 1] = v * (0.98 - 0.05 * patch);
        g.scratchC[o * 3 + 2] = v * (0.82 - 0.1 * patch);
        jb.count++;
      }
      jb.j++;
      cells += jb.i1 - jb.i0 + 1;
    }
    if (jb.j > jb.j1 || jb.count >= g.cap) {
      const m = g.mesh;
      m.instanceMatrix.array.set(g.scratchM.subarray(0, jb.count * 16));
      m.instanceColor.array.set(g.scratchC.subarray(0, jb.count * 3));
      m.count = jb.count;
      m.instanceMatrix.clearUpdateRanges(); m.instanceMatrix.addUpdateRange(0, Math.max(1, jb.count * 16)); m.instanceMatrix.needsUpdate = true;
      m.instanceColor.clearUpdateRanges(); m.instanceColor.addUpdateRange(0, Math.max(1, jb.count * 3)); m.instanceColor.needsUpdate = true;
      lastGrassPos = { x: jb.cx, z: jb.cz };
      job = null;
    }
  };

  // ---- quality / per-frame update -------------------------------------------------------
  let q = QUALITY[quality] || QUALITY.medium;
  let qName = QUALITY[quality] ? quality : 'medium';
  let scale = 1;
  let dirty = true;
  const lastCam = new THREE.Vector3(1e9, 0, 1e9);
  const frustum = new THREE.Frustum();
  const pm = new THREE.Matrix4();

  const applyQuality = () => {
    for (const k of kinds) {
      const casts = q.shadow && CLASS[k.cls].shadow;
      for (const L of k.lods) for (const m of L.meshes) m.castShadow = casts;
    }
    setGrass(q.grass, q.spacing);
    dirty = true;
  };
  applyQuality();

  const refreshInstances = (cam, camera) => {
    const dist = q.dist * scale, lod0 = q.lod0 * scale;
    const margin = q.shadow ? 40 : 0; // sun shadows from off-screen trees reach into the view
    let useFrustum = false;
    if (camera && camera.projectionMatrix && camera.matrixWorldInverse) {
      pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(pm);
      useFrustum = true;
    }
    for (const k of kinds) { k.cursor[0] = 0; k.cursor[1] = 0; }
    for (const c of chunks) {
      const dx = Math.max(c.min.x - cam.x, 0, cam.x - c.max.x), dz = Math.max(c.min.z - cam.z, 0, cam.z - c.max.z);
      if (dx * dx + dz * dz > dist * dist) continue;
      if (useFrustum) {
        c.sphere.radius += margin;
        const vis = frustum.intersectsSphere(c.sphere);
        c.sphere.radius -= margin;
        if (!vis) continue;
      }
      for (const r of c.ranges) {
        const k = r.k, cc = CLASS[k.cls];
        const cull2 = dist * cc.cull * dist * cc.cull, l02 = lod0 * cc.lod0 * lod0 * cc.lod0;
        const hasLod1 = k.lods.length > 1;
        for (let i = r.start; i < r.start + r.count; i++) {
          const ex = k.xz[i * 2] - cam.x, ez = k.xz[i * 2 + 1] - cam.z;
          const d2 = ex * ex + ez * ez;
          if (d2 > cull2) continue;
          const li = hasLod1 && d2 > l02 ? 1 : 0;
          const o = k.cursor[li]++;
          const dst = k.lods[li].shared;
          const ma = dst.instanceMatrix.array, ca = dst.instanceColor.array;
          const so = i * 16, dof = o * 16;
          for (let e = 0; e < 16; e++) ma[dof + e] = k.mats[so + e];
          ca[o * 3] = k.cols[i * 3]; ca[o * 3 + 1] = k.cols[i * 3 + 1]; ca[o * 3 + 2] = k.cols[i * 3 + 2];
        }
      }
    }
    for (const k of kinds) {
      for (let li = 0; li < k.lods.length; li++) {
        const L = k.lods[li], n = k.cursor[li];
        const s = L.shared;
        s.instanceMatrix.clearUpdateRanges(); s.instanceMatrix.addUpdateRange(0, Math.max(1, n * 16)); s.instanceMatrix.needsUpdate = true;
        s.instanceColor.clearUpdateRanges(); s.instanceColor.addUpdateRange(0, Math.max(1, n * 3)); s.instanceColor.needsUpdate = true;
        for (const m of L.meshes) { m.count = n; m.visible = n > 0; }
      }
    }
  };

  let time = 0;

  /**
   * Per frame: wind time, tree / bush LOD + culling, grass recentring.
   * @param {number} dt seconds
   * @param {THREE.Vector3} camPos camera world position
   * @param {number} [drawScale] draw distance multiplier (1 = default)
   * @param {THREE.Camera} [camera] optional; enables frustum culling of chunks
   */
  function update(dt, camPos, drawScale = 1, camera) {
    time = (time + Math.min(dt, 0.1)) % TIME_WRAP;
    SHARED.uTime.value = time;
    SHARED.uCam.value.copy(camPos);
    const sc = Math.min(2, Math.max(0.5, drawScale || 1));
    if (sc !== scale) { scale = sc; dirty = true; }
    const mx = camPos.x - lastCam.x, mz = camPos.z - lastCam.z;
    if (dirty || camera || mx * mx + mz * mz > 1) {
      lastCam.copy(camPos);
      refreshInstances(camPos, camera);
      dirty = false;
    }
    if (grass) {
      if (!job) {
        const gx = lastGrassPos ? camPos.x - lastGrassPos.x : 1e9, gz = lastGrassPos ? camPos.z - lastGrassPos.z : 1e9;
        if (gx * gx + gz * gz > 9) startGrassJob(camPos);
      }
      if (job) stepGrassJob(2500);
    }
  }

  /** @param {string} name 'low' | 'medium' | 'high' | 'ultra' */
  function setQuality(name) {
    if (!QUALITY[name] || name === qName) return;
    qName = name;
    q = QUALITY[name];
    applyQuality();
  }

  function dispose() {
    if (group.parent) group.parent.remove(group);
    for (const g of geoms) g.dispose();
    for (const k of kinds) for (const L of k.lods) { L.shared.dispose(); }
    if (grass) grass.mesh.dispose();
    barkMat.dispose(); grassMat.dispose();
    for (const m of Object.values(leafMats)) m.dispose();
    for (const t of Object.values(tex)) t.dispose();
    group.clear();
  }

  return { group, update, colliders, setQuality, dispose };
}
