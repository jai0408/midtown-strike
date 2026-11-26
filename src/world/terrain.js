// Terrain splat shading, patched into the GLB's own terrain material.
//
// LODGE_DATA.terrainLayers = {
//   x0, z0, size,            // the square (metres) the splat covers
//   splat,                   // base64 PNG, RGBA weights: R grass, G soil, B gravel, A rock
//   layers: [4 x { name, tile, albedo, normal, rough }]   // tile = metres per repeat,
//                            // albedo / normal = base64 JPEG or PNG (normal: OpenGL, +Y up), rough = 0..1
// }
// The four albedos and normals live in two texture arrays (3 sampler units in total, phones have 16).
// The baked terrain colour stays on as soft macro colour / AO, and the detail fades out with distance.
import * as THREE from 'three';
import { makeCanvas, getMaxAnisotropy } from './textures.js';
import { POND_GLSL } from './pond_shape.js';

const LAYER = 512;   // texels per layer side

// The gravel albedo has its pebbles pre-shaded from the top left; lit again by the
// sun and the normal map that read as big harsh cobbles. Squash its baked shading
// towards a warm crushed-stone mean, tile it finer with anti-tiling & dusty macro
// variation, and keep its normal relief subtle so it reads as packed yard gravel.
const GRAVEL_MEAN_LINEAR = '0.205, 0.188, 0.162';   // warm crushed granite/limestone mean, linear
const GRAVEL_SHADE_KEEP = 0.28;                      // 1 = baked shading as authored
const GRAVEL_TILE_SCALE = 2.45;                      // > 1 = finer crushed gravel per metre
const GRAVEL_NORMAL_KEEP = 0.28;                     // tame embossed cobble bump on gravel layer

function blobOf(s) {
  const b64 = s.indexOf(',') >= 0 ? s.slice(s.indexOf(',') + 1) : s;
  const bin = atob(b64), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const png = u8[0] === 0x89;
  return new Blob([u8], { type: png ? 'image/png' : 'image/jpeg' });
}

/** Four images (base64 or ready canvases / elements) -> one RGBA8 texture array. */
async function arrayOf(images, srgb) {
  const data = new Uint8Array(LAYER * LAYER * 4 * images.length);
  const c = makeCanvas(LAYER, LAYER), g = c.getContext('2d', { willReadFrequently: true });
  for (let i = 0; i < images.length; i++) {
    let src = images[i];
    g.clearRect(0, 0, LAYER, LAYER);
    if (typeof src === 'string') {
      src = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src.startsWith('data:') ? src : 'data:image/png;base64,' + (src.indexOf(',') >= 0 ? src.slice(src.indexOf(',') + 1) : src);
      });
    }
    g.drawImage(src, 0, 0, LAYER, LAYER);
    data.set(g.getImageData(0, 0, LAYER, LAYER).data, i * LAYER * LAYER * 4);
  }
  const t = new THREE.DataArrayTexture(data, LAYER, LAYER, images.length);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = getMaxAnisotropy();
  t.needsUpdate = true;
  return t;
}

async function splatTexture(png) {
  let source = png;
  // createImageBitmap with premultiplyAlpha 'none': alpha is the rock weight, not transparency,
  // so where it is 0 (most of the map) a premultiplied decode would wipe the other three weights.
  // The <img> path is only a fallback for WebViews without createImageBitmap options.
  if (typeof png === 'string' && typeof createImageBitmap === 'function') {
    try { source = await createImageBitmap(blobOf(png), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }); } catch (e) { source = png; }
  }
  if (typeof source === 'string') {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = png.startsWith('data:') ? png : 'data:image/png;base64,' + (png.indexOf(',') >= 0 ? png.slice(png.indexOf(',') + 1) : png);
    });
  }
  const t = new THREE.Texture(source);
  t.flipY = false;   // image row 0 is z0
  t.premultiplyAlpha = false;
  t.colorSpace = THREE.NoColorSpace;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/**
 * Patches `mat` (the GLB terrain MeshStandardMaterial, with its baked map / normalMap / aoMap) so that
 * the splat layers add the close-up detail. Returns the same material.
 */
export async function applyTerrainSplat(mat, T) {
  const L = T.layers;
  const [albedo, normals, splat] = await Promise.all([
    arrayOf(L.map((l) => l.albedo), true),
    arrayOf(L.map((l) => l.normal), false),
    splatTexture(T.splat),
  ]);
  const uniforms = {
    uSplat: { value: splat }, uAlb: { value: albedo }, uNrm: { value: normals },
    uRect: { value: new THREE.Vector4(T.x0, T.z0, 1 / T.size, 1 / T.size) },
    uTile: { value: new THREE.Vector4(...L.map((l) => (l.name === 'gravel' ? GRAVEL_TILE_SCALE : 1) / (l.tile || 4))) },
    uRough: { value: new THREE.Vector4(...L.map((l) => (l.rough === undefined ? 0.9 : l.rough))) },
    uFade: { value: new THREE.Vector2(30, 90) },   // detail fully on up to x m, gone by y m
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos;
        uniform sampler2D uSplat;
        uniform sampler2DArray uAlb, uNrm;
        uniform vec4 uRect, uTile, uRough;
        uniform vec2 uFade;
        ${POND_GLSL}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        // the koi pond basin: no terrain surface over it (shape from world/pond_shape.js)
        {
          vec2 pPond = vWPos.xz - POND_C;
          float pD = length(pPond);
          if (pD < 2.5 || pD < pondRadiusGL(atan(pPond.x, pPond.y + 1e-4)) - 0.15) discard;   // atan(0, 0) is undefined
        }
        vec2 dnTotal = vec2(0.0);
        float dRough = 1.0, dFade = 1.0 - smoothstep(uFade.x, uFade.y, length(vViewPosition));
        vec2 p = vWPos.xz;
        vec2 gx = dFdx(p), gy = dFdy(p);   // taken outside the branch: derivatives need uniform flow
        if (dFade > 0.01) {
          // Break up sharp splat-map polygon edges with two-scale organic world-space noise warp
          vec2 uvS = clamp((vWPos.xz - uRect.xy) * uRect.zw, 0.0, 1.0);
          float sWarp = 0.55 * sin(p.x * 0.85 + p.y * 0.62) + 0.35 * sin(p.x * 2.1 - p.y * 1.9 + 1.4);
          vec2 warpUv = vec2(sin(p.y * 0.55 + 0.7), cos(p.x * 0.52 - 0.9)) * (0.0042 * uRect.z * 320.0);
          vec4 sw = texture2D(uSplat, clamp(uvS + warpUv * (0.4 + 0.6 * abs(sWarp)), 0.0, 1.0));
          // outside the splat's weights (or a black texel) = grass
          float sSum = sw.r + sw.g + sw.b + sw.a;
          sw = sSum > 0.01 ? sw / sSum : vec4(1.0, 0.0, 0.0, 0.0);
          // Inject dusty soil shoulder along the gravel-to-grass border so edges feather naturally
          float gvBorder = clamp(sw.z * (1.0 - sw.z) * 4.0, 0.0, 1.0);
          sw.y += gvBorder * (0.28 + 0.18 * sWarp);
          sw = max(sw, vec4(0.0));
          sw /= (sw.x + sw.y + sw.z + sw.w + 1e-4);
          vec3 a0 = textureGrad(uAlb, vec3(p * uTile.x, 0.0), gx * uTile.x, gy * uTile.x).rgb;
          vec3 a1 = textureGrad(uAlb, vec3(p * uTile.y, 1.0), gx * uTile.y, gy * uTile.y).rgb;
          vec3 a2 = textureGrad(uAlb, vec3(p * uTile.z, 2.0), gx * uTile.z, gy * uTile.z).rgb;
          vec3 a3 = textureGrad(uAlb, vec3(p * uTile.w, 3.0), gx * uTile.w, gy * uTile.w).rgb;
          // anti-tiling: grass (the biggest area) gets a second, rotated and rescaled sample
          mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
          vec2 p2 = rot * p * 0.37;
          vec3 a0b = textureGrad(uAlb, vec3(p2 * uTile.x, 0.0), rot * gx * (0.37 * uTile.x), rot * gy * (0.37 * uTile.x)).rgb;
          a0 = mix(a0, a0b, 0.5);
          // anti-tiling & compacted wheel-path / fine dust binder on gravel
          vec2 pg2 = rot * p * 0.43;
          vec3 a2b = textureGrad(uAlb, vec3(pg2 * uTile.z, 2.0), rot * gx * (0.43 * uTile.z), rot * gy * (0.43 * uTile.z)).rgb;
          a2 = mix(a2, a2b, 0.42);
          float gMacro = 0.5 + 0.32 * sin(p.x * 0.11 + 1.4) * sin(p.y * 0.09 - 0.6)
                       + 0.18 * sin(p.x * 0.29 - p.y * 0.23 + 2.1);
          // height-aware blend: organic transition shoulder instead of hard polygon cut
          vec4 lum = vec4(dot(a0, vec3(0.3333)), dot(a1, vec3(0.3333)), dot(a2, vec3(0.3333)), dot(a3, vec3(0.3333)));
          vec4 hb = sw + lum * 0.36;
          vec4 bw = max(hb - (max(max(hb.x, hb.y), max(hb.z, hb.w)) - 0.34), 0.0);
          bw *= step(0.001, sw);
          bw /= (bw.x + bw.y + bw.z + bw.w + 1e-4);
          a2 = vec3(${GRAVEL_MEAN_LINEAR}) + (a2 - vec3(${GRAVEL_MEAN_LINEAR})) * ${GRAVEL_SHADE_KEEP.toFixed(2)};
          // warm dusty crushed-stone patches & compacted wheel-path variation
          a2 *= mix(vec3(0.73, 0.72, 0.68), vec3(0.93, 0.90, 0.84), clamp(gMacro, 0.0, 1.0));
          vec3 detail = (a0 * bw.x + a1 * bw.y + a2 * bw.z + a3 * bw.w) * 0.90;
          // the baked colour stays as soft macro variation and ground AO
          vec3 macro = clamp(diffuseColor.rgb * 2.35, 0.42, 1.45);
          diffuseColor.rgb = mix(diffuseColor.rgb, detail * mix(vec3(1.0), macro, 0.52), dFade);
          // tangent-space normals as slopes in world x / z, only for layers that count (gravel kept subtle)
          if (bw.x > 0.03) dnTotal += (textureGrad(uNrm, vec3(p * uTile.x, 0.0), gx * uTile.x, gy * uTile.x).xy * 2.0 - 1.0) * bw.x;
          if (bw.y > 0.03) dnTotal += (textureGrad(uNrm, vec3(p * uTile.y, 1.0), gx * uTile.y, gy * uTile.y).xy * 2.0 - 1.0) * bw.y;
          if (bw.z > 0.03) dnTotal += (textureGrad(uNrm, vec3(p * uTile.z, 2.0), gx * uTile.z, gy * uTile.z).xy * 2.0 - 1.0) * (bw.z * ${GRAVEL_NORMAL_KEEP.toFixed(2)});
          if (bw.w > 0.03) dnTotal += (textureGrad(uNrm, vec3(p * uTile.w, 3.0), gx * uTile.w, gy * uTile.w).xy * 2.0 - 1.0) * bw.w;
          dnTotal *= dFade;
          dRough = mix(1.0, dot(bw, vec4(uRough.x, uRough.y, 0.95, uRough.w)), dFade);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor * dRough, 0.05, 1.0);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          // image up is -z in texture space
          vec3 wn = inverseTransformDirection(normal, viewMatrix);
          wn = normalize(wn + vec3(dnTotal.x, 0.0, -dnTotal.y) * 0.8);
          normal = normalize(transformDirection(wn, viewMatrix));
        }`);
  };
  mat.customProgramCacheKey = () => 'lodge-terrain-splat';
  mat.needsUpdate = true;
  return mat;
}

/** Dev-only stand-in layers (procedural noise) to exercise the shader before the real ones exist. */
export function testTerrainLayers(size = 256) {
  const noise = (seed, base, amp) => {
    const c = makeCanvas(size, size), g = c.getContext('2d');
    const img = g.createImageData(size, size);
    let s = seed;
    const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const grid = 32, v = new Float32Array(grid * grid).map(r);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let n = 0, a = 1, f = 4;
      for (let o = 0; o < 4; o++) {
        const fx = (x / size) * f, fy = (y / size) * f, ix = Math.floor(fx), iy = Math.floor(fy), u = fx - ix, w = fy - iy;
        const h = (i, j) => v[((j % grid) * grid + (i % grid))];
        n += a * ((h(ix, iy) * (1 - u) + h(ix + 1, iy) * u) * (1 - w) + (h(ix, iy + 1) * (1 - u) + h(ix + 1, iy + 1) * u) * w);
        a *= 0.5; f *= 2;
      }
      n = n / 1.875 - 0.5;
      const o = (y * size + x) * 4;
      for (let k = 0; k < 3; k++) img.data[o + k] = Math.max(0, Math.min(255, base[k] + n * amp));
      img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c;
  };
  const flat = () => { const c = makeCanvas(8, 8), g = c.getContext('2d'); g.fillStyle = '#8080ff'; g.fillRect(0, 0, 8, 8); return c; };
  // splat: grass everywhere, soil / gravel / rock in blobs
  const sc = makeCanvas(128, 128), sg = sc.getContext('2d'), si = sg.createImageData(128, 128);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const o = (y * 128 + x) * 4, a = Math.sin(x * 0.17) * Math.cos(y * 0.13), b = Math.sin(x * 0.07 + 2) * Math.sin(y * 0.09);
    si.data[o] = 200; si.data[o + 1] = a > 0.4 ? 255 : 0; si.data[o + 2] = b > 0.5 ? 255 : 0; si.data[o + 3] = a < -0.6 ? 255 : 0;
  }
  sg.putImageData(si, 0, 0);
  return {
    x0: -160, z0: -160, size: 320, splat: sc.toDataURL('image/png'),
    layers: [
      { name: 'grass', tile: 3, albedo: noise(1, [70, 110, 40], 90), normal: flat(), rough: 0.95 },
      { name: 'soil', tile: 3, albedo: noise(2, [95, 70, 48], 70), normal: flat(), rough: 0.9 },
      { name: 'gravel', tile: 2, albedo: noise(3, [130, 125, 115], 110), normal: flat(), rough: 0.85 },
      { name: 'rock', tile: 4, albedo: noise(4, [105, 100, 98], 80), normal: flat(), rough: 0.8 },
    ],
  };
}
