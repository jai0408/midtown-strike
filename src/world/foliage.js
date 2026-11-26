// Cedar Lodge vegetation: instanced pines, spruces, birches, maples, bushes, ferns, wildflowers,
// reeds, rocks and a camera-centred grass field, with LOD swapping per 32 m chunk and a gentle shader wind.
//
// Meshes and atlases come from foliage_asset.js (tools/blender/build_foliage.py).
//
//   const fol = await buildFoliage({ foliage, heightAt, quality });
//   scene.add(fol.group);
//   fol.update(dt, camera.position, drawScale, camera);   // 4th argument is optional
//   fol.colliders                                           // trunk boxes for physics
//
//   fol.setFocus(x, y, z)                                   // player position: grass / shrubs react to it
//
// Kinds. trees: pine, spruce, birch, maple. bushes: bush, hedge, fern, fern2, blueberry, clover, lupine,
// fireweed, reed, cattail, rock (unknown kinds fall back to bush).
// Nominal model sizes (scale 1): pine 15 / 19 m, spruce 16 m, birch 10.5 / 9 m, maple 11 m, bush 1.1-1.35 m,
// fern 1.0 m, reed / cattail 2 m, fireweed 1.6 m. Grass density is sampled with nodes at x0 + i * size / (n - 1).
import * as THREE from 'three';
import { FOLIAGE_TEX, FOLIAGE_MODELS } from './foliage_asset.js';
import { F_DEFAULT, S_WOOD } from '../core/physics.js';

const CHUNK = 32;
const TIME_WRAP = 20 * Math.PI; // wind frequencies are multiples of 0.1 so the wrap is seamless

/** Per-quality settings. dist/lod0 are metres at drawScale 1; grass is the radius around the camera. */
/** The farthest any class draws, as a multiple of dist (chunk-level early out). */
let MAX_CULL = 1;
const QUALITY = {
  // grass blades ~ pi * grass^2 / spacing^2: low 0.8k, medium 3.4k, high 13k, ultra 29k
  low: { dist: 70, lod0: 20, grass: 14, spacing: 0.86, shadow: false },
  medium: { dist: 100, lod0: 28, grass: 24, spacing: 0.72, shadow: false },
  high: { dist: 135, lod0: 36, grass: 36, spacing: 0.54, shadow: true },
  ultra: { dist: 175, lod0: 48, grass: 46, spacing: 0.46, shadow: true },
};

/** Draw / LOD0 distance multipliers per model class. */
const CLASS = {
  // trees reach far (the 8-triangle impostors cover the hillsides around the map); the rest stays near
  tree: { cull: 2.4, lod0: 1.0, shadow: true, amp: 0.38, flutter: 0.05 },
  bush: { cull: 0.5, lod0: 0.45, shadow: false, amp: 0.07, flutter: 0.035 },
  fern: { cull: 0.32, lod0: 0.4, shadow: false, amp: 0.06, flutter: 0.03 },
  plant: { cull: 0.3, lod0: 0.4, shadow: false, amp: 0.06, flutter: 0.03 },
  tall: { cull: 0.45, lod0: 0.4, shadow: false, amp: 0.1, flutter: 0.03 },
  rock: { cull: 0.4, lod0: 0.4, shadow: false, amp: 0, flutter: 0 },
};
MAX_CULL = Math.max(...Object.values(CLASS).map((c) => c.cull));

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

/**
 * Mip chain whose alpha keeps the base level's alpha-test coverage, so distant canopies do not thin
 * out: after each box filter the alpha is scaled until the same fraction of texels passes the cutoff.
 */
function alphaMips(base, w, h, cutoff) {
  const cut = Math.round(cutoff * 255);
  const cover = (d, n, k) => { let c = 0; for (let i = 3; i < n * 4; i += 4) if (d[i] * k >= cut) c++; return c / n; };
  const target = cover(base, w * h, 1);
  const mips = [{ data: base, width: w, height: h }];
  let prev = base, pw = w, ph = h;
  while (pw > 1 || ph > 1) {
    const nw = Math.max(1, pw >> 1), nh = Math.max(1, ph >> 1);
    const d = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      const y0 = Math.min(ph - 1, y * 2), y1 = Math.min(ph - 1, y * 2 + 1);
      for (let x = 0; x < nw; x++) {
        const x0 = Math.min(pw - 1, x * 2), x1 = Math.min(pw - 1, x * 2 + 1);
        let r = 0, g = 0, b = 0, a = 0, ra = 0, ga = 0, ba = 0;
        for (const o of [(y0 * pw + x0) * 4, (y0 * pw + x1) * 4, (y1 * pw + x0) * 4, (y1 * pw + x1) * 4]) {
          const al = prev[o + 3];
          r += prev[o]; g += prev[o + 1]; b += prev[o + 2]; a += al;
          ra += prev[o] * al; ga += prev[o + 1] * al; ba += prev[o + 2] * al;
        }
        const o = (y * nw + x) * 4;
        if (a > 0) { d[o] = ra / a; d[o + 1] = ga / a; d[o + 2] = ba / a; } else { d[o] = r / 4; d[o + 1] = g / 4; d[o + 2] = b / 4; }
        d[o + 3] = a / 4;
      }
    }
    if (nw * nh > 4) {
      let lo = 1, hi = 4;
      if (cover(d, nw * nh, 1) < target) {
        for (let it = 0; it < 7; it++) { const mid = (lo + hi) / 2; if (cover(d, nw * nh, mid) < target) lo = mid; else hi = mid; }
        for (let i = 3; i < d.length; i += 4) d[i] = Math.min(255, d[i] * hi);
      }
    }
    mips.push({ data: d, width: nw, height: nh });
    prev = d; pw = nw; ph = nh;
  }
  return mips;
}

/** Row-flipped (v = 0 at the bottom) RGBA DataTexture; alphaCut > 0 builds alpha-preserving mips. */
function dataTexture(rgba, w, h, srgb, aniso, alphaCut = 0) {
  const out = new Uint8Array(w * h * 4);
  const row = w * 4;
  for (let y = 0; y < h; y++) out.set(rgba.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  const t = new THREE.DataTexture(out, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  if (alphaCut > 0 && w > 1) { t.mipmaps = alphaMips(out, w, h, alphaCut); t.generateMipmaps = false; } else t.generateMipmaps = true;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

/** Decodes the JPEG atlases; each colour JPEG plus its separate greyscale alpha JPEG becomes one RGBA texture. */
async function loadTextures(aniso) {
  if (typeof document === 'undefined') { // headless (tests): 1x1 stand-ins
    const px = (r, g, b, a) => dataTexture(new Uint8Array([r, g, b, a]), 1, 1, false, 1);
    return { bark: px(120, 90, 70, 255), barkN: px(128, 128, 255, 255), leaf: px(60, 110, 50, 255), leafN: px(128, 128, 255, 255), imp: px(60, 110, 50, 255), pl: px(60, 110, 50, 255), plN: px(128, 128, 255, 255) };
  }
  const T = FOLIAGE_TEX;
  const imgs = await Promise.all(['bark', 'barkN', 'leaf', 'leafA', 'leafN', 'imp', 'impA', 'pl', 'plA', 'plN'].map((k) => loadImage(T[k])));
  const [bark, barkN, leaf, leafA, leafN, imp, impA, pl, plA, plN] = imgs;
  const withAlpha = (c, a) => {
    const cd = imagePixels(c), ad = imagePixels(a, cd.width, cd.height).data, p = cd.data;
    for (let i = 0; i < p.length; i += 4) p[i + 3] = ad[i];
    return cd;
  };
  const bd = imagePixels(bark), bnd = imagePixels(barkN), nd = imagePixels(leafN), pnd = imagePixels(plN);
  const ld = withAlpha(leaf, leafA), id = withAlpha(imp, impA), pd = withAlpha(pl, plA);
  return {
    bark: dataTexture(bd.data, bd.width, bd.height, true, aniso),
    barkN: dataTexture(bnd.data, bnd.width, bnd.height, false, aniso),
    leaf: dataTexture(ld.data, ld.width, ld.height, true, aniso, 0.45),
    leafN: dataTexture(nd.data, nd.width, nd.height, false, aniso),
    imp: dataTexture(id.data, id.width, id.height, true, aniso, 0.45),
    pl: dataTexture(pd.data, pd.width, pd.height, true, aniso, 0.45),
    plN: dataTexture(pnd.data, pnd.width, pnd.height, false, aniso),
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
  uFocus: { value: new THREE.Vector3() }, // player position: trampling / brushing centre
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
uniform vec3 uFocus;
uniform vec3 uSunDir;
uniform float uFadeR;
varying float vGT;
varying float vCrown;
varying vec3 vSunV;
`;

/** Shrinks grass into the ground towards the edge of the field, adds traveling wind waves, and player trampling physics. */
const FADE = `
vGT = 0.5;
vCrown = clamp(aSway, 0.0, 1.0);
vSunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
if (uFadeR > 0.0) {
  #ifdef USE_INSTANCING
  vec3 gw = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  #else
  vec3 gw = (modelMatrix * vec4(transformed, 1.0)).xyz;
  #endif
  vec2 gd = gw.xz - uCam.xz;
  float gdist = sqrt(dot(gd, gd));
  // low-frequency colour field (dry / lush patches), read by the grass fragment shader
  vGT = clamp(0.5 + 0.38 * sin(gw.x * 0.045 + 1.7) * sin(gw.z * 0.038 + 0.4) + 0.16 * sin(gw.x * 0.13 + gw.z * 0.11 + 2.0), 0.0, 1.0);
  transformed *= 1.0 - smoothstep(uFadeR * 0.62, uFadeR, gdist);
  
  // Dynamic traveling grass ripple wave aligned with wind direction
  float gCoord = dot(gw.xz, uWindDir);
  float gWave = sin(gCoord * 0.28 - uTime * 2.6) * 0.55 + sin(gCoord * 0.62 - uTime * 3.8) * 0.25;
  float gBend = (0.45 + 0.55 * gWave) * uWind * 0.26 * clamp(transformed.y * 1.5, 0.0, 1.0);
  transformed.x += uWindDir.x * gBend;
  transformed.z += uWindDir.y * gBend;

  // Player Trampling Physics: grass physically parts and bends outward around player's feet
  vec2 fd = gw.xz - uFocus.xz;
  float pDist = length(fd);
  float pRadius = 1.7;
  if (pDist < pRadius && pDist > 0.01) {
    float pPush = (1.0 - pDist / pRadius) * clamp(transformed.y * 1.8, 0.0, 1.0);
    vec2 pDir = fd / pDist;
    transformed.xz += pDir * (pPush * 0.44);
    transformed.y -= pPush * 0.26;
  }
}
`;

/** Wind: physical traveling gust fronts along uWindDir, hierarchical trunk/branch/leaf sway, and player proximity rustle. */
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

  // Proximity brush displacement for shrubs and low foliage (uAmp < 0.2)
  if (uAmp < 0.2) {
    vec2 toCam = ip.xz - uFocus.xz;
    float cDist = length(toCam);
    float bRadius = 2.4;
    if (cDist < bRadius && cDist > 0.01) {
      float bPush = (1.0 - cDist / bRadius) * w * 0.32;
      vec2 bDir = toCam / cDist;
      transformed.xz += bDir * bPush;
      transformed.y -= bPush * 0.14;
    }
  }
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
    alphaToCoverage: !!p.a2c && p.alphaTest > 0,
  });
  const uniforms = { ...SHARED, uAmp: { value: p.amp }, uFlutter: { value: p.flutter }, uFadeR: { value: 0 }, uSelfLit: { value: p.selfLit } };
  m.userData.uniforms = uniforms;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS + (p.isBark ? 'varying float vBarkY;\n' : ''))
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + FADE + SWAY + (p.isBark ? 'vBarkY = transformed.y;\n' : ''));
    if (p.isBark) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vBarkY;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          diffuseColor.rgb = min(diffuseColor.rgb * mix(0.54, 1.0, smoothstep(0.0, 1.5, vBarkY)), vec3(0.46));`);
    }
    if (p.twoSidedLight) {
      // Leaves are lit like thin translucent shells: no normal flip on back faces,
      // internal crown AO depth gradient, wrap-diffuse warm sun transmission, and
      // directional sunlit subsurface scattering on outer crown tips.
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vCrown;\nvarying vec3 vSunV;')
        .replace('#include <map_fragment>', `#include <map_fragment>
          {
            // Sculptural canopy depth: cooler/deeper inner foliage, warmer sunlit outer tips
            float tip = smoothstep(0.08, 0.88, vCrown);
            diffuseColor.rgb *= mix(vec3(0.66, 0.72, 0.74), vec3(1.06, 1.08, 0.94), tip);
          }`)
        .replace('#include <normal_fragment_begin>',
          THREE.ShaderChunk.normal_fragment_begin.replace('float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;', 'float faceDirection = 1.0;'))
        .replace('#include <opaque_fragment>', `
          {
            vec3 vDir = normalize(vViewPosition);
            vec3 sunV = normalize(vSunV);
            float nDotS = dot(normal, sunV);
            // Wrap-diffuse transmission warms shadowed foliage undersides like light filtering through leaves
            float wrapTrans = clamp((nDotS + 0.55) / 1.55, 0.0, 1.0) * (1.0 - max(nDotS, 0.0) * 0.45);
            // View-dependent backlit subsurface scatter (wide canopy halo + crisp forward glow, pow-free)
            float bl = clamp(dot(-vDir, sunV), 0.0, 1.0);
            float bl2 = bl * bl;
            float bl5 = bl2 * bl2 * bl;
            float tipWeight = 0.35 + 0.65 * vCrown;
            float sss = (bl2 * 0.36 + bl5 * 0.46) * tipWeight;
            vec3 leafGlow = diffuseColor.rgb * vec3(1.02, 1.12, 0.62);
            // Subtle waxy leaf sky sheen at grazing angles on outer tips
            float f1 = 1.0 - clamp(dot(normal, vDir), 0.0, 1.0);
            float f2 = f1 * f1;
            float sheen = f2 * f2 * 0.04 * vCrown;
            outgoingLight += leafGlow * (sss + wrapTrans * 0.22 * tipWeight) + vec3(0.75, 0.88, 1.0) * sheen * diffuseColor.rgb;
          }
          #include <opaque_fragment>`);
    }
    if (p.grass) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vGT;')
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= mix(vec3(0.8, 0.88, 0.7), vec3(1.2, 1.1, 0.8), vGT);')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n{ float ndv = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0); totalEmissiveRadiance += diffuseColor.rgb * pow(max(0.0, 1.0 - ndv), 3.0) * 0.14; }');
    }
    if (p.selfLit > 0) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uSelfLit;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * uSelfLit;');
    }
  };
  m.customProgramCacheKey = () => `foliage-${p.amp}-${p.grass ? 'g' : 'f'}-${p.twoSidedLight ? 1 : 0}-${p.isBark ? 'b' : '0'}-${p.selfLit > 0 ? 1 : 0}`;
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
    if (kind === 'maple' || kind === 'alder') return 'maple0';
    return h < 0.5 ? 'pine0' : 'pine1';
  }
  switch (kind) {
    case 'fern': return h < 0.5 ? 'fern0' : 'fern1';
    case 'fern2': return 'fern1';
    case 'hedge': return 'bush1';
    case 'blueberry': return 'blueberry0';
    case 'clover': return 'clover0';
    case 'lupine': return 'lupine0';
    case 'fireweed': return 'fireweed0';
    case 'reed': return 'reed0';
    case 'cattail': return 'cattail0';
    case 'rock': return h < 0.5 ? 'rock0' : 'rock1';
    default: return h < 0.5 ? 'bush0' : 'bush1';
  }
}

/** Per-instance tint of the leaf / plant colour (the atlas supplies the real colour; this only varies it). */
function tintFor(model, h1, h2, out) {
  const v = 0.88 + 0.22 * h1;
  if (model.startsWith('birch')) { const bv = v * 0.88; out.r = bv * (1.0 + 0.06 * h2); out.g = bv * 0.97; out.b = bv * 0.93; }
  else if (model.startsWith('maple')) { out.r = v * (1.0 + 0.1 * h2); out.g = v; out.b = v * 0.92; }
  else if (model.startsWith('pine')) { out.r = v * (0.94 + 0.06 * h2); out.g = v * 0.99; out.b = v * (1.0 + 0.06 * h2); }
  else if (model.startsWith('spruce')) { out.r = v * 0.96; out.g = v; out.b = v * (1.0 + 0.06 * h2); }
  else if (model.startsWith('rock')) { out.r = out.g = out.b = 0.85 + 0.25 * h1; }
  else { out.r = v * (0.95 + 0.12 * h2); out.g = v; out.b = v * 0.93; }
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
 * @param {(x:number,z:number)=>boolean} [opts.exclude] true where no grass may grow (e.g. a pond basin)
 * @param {boolean} [opts.msaa] true (default) enables alpha-to-coverage on the cutout cards
 * @returns {Promise<{group:THREE.Group, update:Function, colliders:number[][], setQuality:Function, setFocus:Function, dispose:Function}>}
 *   update(dt, camPos, drawScale, camera?) passes the camera to also cull chunks outside the view.
 */
export async function buildFoliage({ foliage, heightAt, quality = 'medium', exclude = null, msaa = true }) {
  const tex = await loadTextures(4);
  const group = new THREE.Group();
  group.name = 'foliage';

  const barkMat = windMaterial({ map: tex.bark, normalMap: tex.barkN, normalScale: 1.5, side: THREE.FrontSide, amp: CLASS.tree.amp, flutter: 0, alphaTest: 0, roughness: 0.88, selfLit: 0, isBark: true });
  const matCache = new Map();
  /** Leaf material per class + atlas (trees / shrubs: leaf atlas; undergrowth: plants atlas; LOD1: impostors). */
  const leafMatFor = (cls, atlas, imp) => {
    const key = imp ? 'imp' : `${cls}:${atlas}`;
    let m = matCache.get(key);
    if (!m) {
      const c = CLASS[cls] || CLASS.bush;
      const map = imp ? tex.imp : atlas === 'pl' ? tex.pl : tex.leaf;
      const normalMap = imp ? null : atlas === 'pl' ? tex.plN : tex.leafN;
      const rock = cls === 'rock';
      m = windMaterial({
        map, normalMap, normalScale: imp ? 0 : cls === 'tree' ? 1.15 : 0.85, side: rock ? THREE.FrontSide : THREE.DoubleSide,
        amp: c.amp, flutter: imp ? 0.02 : c.flutter, alphaTest: cls === 'tree' && !imp ? 0.48 : 0.45, roughness: rock ? 0.95 : 0.7, selfLit: rock ? 0 : 0.05, twoSidedLight: !rock, a2c: msaa,
      });
      matCache.set(key, m);
    }
    return m;
  };
  const grassMat = windMaterial({ map: tex.pl, normalMap: tex.plN, normalScale: 0.7, side: THREE.DoubleSide, amp: 0.16, flutter: 0.0, alphaTest: 0.5, roughness: 0.74, selfLit: 0.04, twoSidedLight: true, grass: true, a2c: msaa });
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
    const cls = def.cls || 'bush';
    const items = rec.items;
    items.forEach((it) => { it.key = Math.floor(it.x / CHUNK) * 100000 + Math.floor(it.z / CHUNK); });
    items.sort((p, q) => p.key - q.key);
    const n = items.length;
    const mats = new Float32Array(n * 16), cols = new Float32Array(n * 3), xz = new Float32Array(n * 2), bcols = new Float32Array(n * 3);
    const k = { name, cls, def, n, mats, cols, bcols, xz, lods: [], cursor: [0, 0] };
    items.forEach((it, i) => {
      writeMatrix(mats, i * 16, it.x, it.y, it.z, it.yaw, it.sx, it.sy, it.sz);
      tintFor(name, it.ch, it.cs, tint);
      cols[i * 3] = tint.r; cols[i * 3 + 1] = tint.g; cols[i * 3 + 2] = tint.b;
      bcols[i * 3] = bcols[i * 3 + 1] = bcols[i * 3 + 2] = tint.g * (name.startsWith('birch') ? 0.78 : 1.0); // bark: brightness only, clamp birch poles
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
      const L2 = { meshes: parts, shared: null, colors: [] };
      for (const key of ['bark', 'leaf']) {
        if (!L[key]) continue;
        const g = makeGeometry(L[key]);
        geoms.push(g);
        const mesh = new THREE.InstancedMesh(g, key === 'bark' ? barkMat : leafMatFor(cls, def.atlas, !!L.imp), n);
        if (!shared) {
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          shared = mesh;
        } else {
          mesh.instanceMatrix = shared.instanceMatrix;
        }
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
        L2.colors.push({ mesh, bark: key === 'bark' });
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.receiveShadow = true;
        mesh.name = `${name}_lod${li}_${key}`;
        group.add(mesh);
        parts.push(mesh);
      }
      L2.shared = shared;
      k.lods.push(L2);
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
        if (exclude && exclude(x, z)) continue;
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
      if (dx * dx + dz * dz > dist * dist * MAX_CULL * MAX_CULL) continue;   // per-kind cull below
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
          const L = k.lods[li];
          const ma = L.shared.instanceMatrix.array;
          const so = i * 16, dof = o * 16;
          for (let e = 0; e < 16; e++) ma[dof + e] = k.mats[so + e];
          for (const c of L.colors) {
            const src = c.bark ? k.bcols : k.cols, ca = c.mesh.instanceColor.array;
            ca[o * 3] = src[i * 3]; ca[o * 3 + 1] = src[i * 3 + 1]; ca[o * 3 + 2] = src[i * 3 + 2];
          }
        }
      }
    }
    for (const k of kinds) {
      for (let li = 0; li < k.lods.length; li++) {
        const L = k.lods[li], n = k.cursor[li];
        const s = L.shared;
        s.instanceMatrix.clearUpdateRanges(); s.instanceMatrix.addUpdateRange(0, Math.max(1, n * 16)); s.instanceMatrix.needsUpdate = true;
        for (const c of L.colors) { const ic = c.mesh.instanceColor; ic.clearUpdateRanges(); ic.addUpdateRange(0, Math.max(1, n * 3)); ic.needsUpdate = true; }
        for (const m of L.meshes) { m.count = n; m.visible = n > 0; }
      }
    }
  };

  let time = 0;
  let focusSet = false;

  /** Player position: grass is trampled and shrubs brushed around it (defaults to the camera). */
  function setFocus(x, y, z) {
    focusSet = true;
    SHARED.uFocus.value.set(x, y, z);
  }

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
    if (!focusSet) SHARED.uFocus.value.copy(camPos);
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
    for (const k of kinds) for (const L of k.lods) for (const m of L.meshes) m.dispose();
    if (grass) grass.mesh.dispose();
    barkMat.dispose(); grassMat.dispose();
    for (const m of matCache.values()) m.dispose();
    for (const t of Object.values(tex)) t.dispose();
    group.clear();
  }

  return { group, update, colliders, setQuality, setFocus, dispose };
}
