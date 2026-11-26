// Midtown baked world-space lighting & contact ambient occlusion map.
//
// At map build time (~8 ms on CPU, 0 bytes in bundle, 256 KB GPU VRAM), bakes a
// 256x256 RGBA8 world-space DataTexture covering the Times Square core and
// surrounding blocks:
//   RGB = accumulated colored neon billboard bounce, warm street-lamp pools,
//         storefront spill, TKTS red steps & police booth glow (encoded * 0.5
//         so linear intensities up to 2.0 survive without clipping)
//   A   = analytical ground contact AO from building footprints, sidewalk kerbs,
//         vehicles, containers, barriers, kiosks and street props.
//
// Sampled in 1 texture fetch (< 0.1 ms GPU on phones) across ground, sidewalks,
// markings, street props and facades on ALL quality levels (including Medium).
import * as THREE from 'three';
import { AVENUES, STREETS, CURB, broadwayX, PLAZA_Z0, PLAZA_Z1 } from './layout.js';
import { MED_WET_SPEC } from './road_shader.js';

// World region covered by the light-spill + contact-AO texture (metres)
const MIN_X = -220, MAX_X = 220;
const MIN_Z = -320, MAX_Z = 320;
const W = 256, H = 256;

const INV_W = 1 / (MAX_X - MIN_X);
const INV_H = 1 / (MAX_Z - MIN_Z);

const _col = new THREE.Color();
function hexLinear(hex) {
  if (Array.isArray(hex)) return hex;
  _col.set(hex);
  return [_col.r, _col.g, _col.b];
}

/**
 * Builds the world-space light-spill + contact-AO DataTexture from collected city data.
 * @param {object} ctx city builder context (buildings, vehicles, lights, occluders)
 */
export function buildCityLightMap(ctx) {
  const rgb = new Float32Array(W * H * 3);
  const ao = new Float32Array(W * H);
  ao.fill(1.0);

  const txOf = (x) => (x - MIN_X) * INV_W * W;
  const tzOf = (z) => (z - MIN_Z) * INV_H * H;
  const wxOf = (ix) => MIN_X + ((ix + 0.5) / W) * (MAX_X - MIN_X);
  const wzOf = (iz) => MIN_Z + ((iz + 0.5) / H) * (MAX_Z - MIN_Z);

  // Helper: splat a smooth radial colored light onto rgb[]
  const addLight = (cx, cz, radius, col, intensity) => {
    if (cx + radius < MIN_X || cx - radius > MAX_X || cz + radius < MIN_Z || cz - radius > MAX_Z) return;
    const x0 = Math.max(0, Math.floor(txOf(cx - radius)));
    const x1 = Math.min(W - 1, Math.ceil(txOf(cx + radius)));
    const z0 = Math.max(0, Math.floor(tzOf(cz - radius)));
    const z1 = Math.min(H - 1, Math.ceil(tzOf(cz + radius)));
    const invR = 1 / Math.max(radius, 0.5);
    const cr = col[0] * intensity, cg = col[1] * intensity, cb = col[2] * intensity;
    for (let iz = z0; iz <= z1; iz++) {
      const dz = wzOf(iz) - cz;
      const dz2 = dz * dz;
      const row = iz * W;
      for (let ix = x0; ix <= x1; ix++) {
        const dx = wxOf(ix) - cx;
        const d = Math.sqrt(dx * dx + dz2) * invR;
        if (d >= 1.0) continue;
        const t = 1.0 - d;
        const fall = t * t * (3.0 - 2.0 * t); // smoothstep falloff
        const o = (row + ix) * 3;
        rgb[o] += cr * fall;
        rgb[o + 1] += cg * fall;
        rgb[o + 2] += cb * fall;
      }
    }
  };

  // Helper: darken contact AO around an axis-aligned rectangle [x0, z0, x1, z1]
  const addBoxAO = (bx0, bz0, bx1, bz1, pad, minAO) => {
    if (bx1 + pad < MIN_X || bx0 - pad > MAX_X || bz1 + pad < MIN_Z || bz0 - pad > MAX_Z) return;
    const ix0 = Math.max(0, Math.floor(txOf(bx0 - pad)));
    const ix1 = Math.min(W - 1, Math.ceil(txOf(bx1 + pad)));
    const iz0 = Math.max(0, Math.floor(tzOf(bz0 - pad)));
    const iz1 = Math.min(H - 1, Math.ceil(tzOf(bz1 + pad)));
    const invP = 1 / Math.max(pad, 0.25);
    for (let iz = iz0; iz <= iz1; iz++) {
      const wz = wzOf(iz);
      const dz = wz < bz0 ? bz0 - wz : wz > bz1 ? wz - bz1 : 0;
      const row = iz * W;
      for (let ix = ix0; ix <= ix1; ix++) {
        const wx = wxOf(ix);
        const dx = wx < bx0 ? bx0 - wx : wx > bx1 ? wx - bx1 : 0;
        const d = Math.hypot(dx, dz) * invP;
        if (d >= 1.0) continue;
        const s = d * d * (3.0 - 2.0 * d);
        const k = minAO + (1.0 - minAO) * s;
        if (k < ao[row + ix]) ao[row + ix] = k;
      }
    }
  };

  // Helper: darken contact AO around a yawed box (vehicles)
  const addYawAO = (cx, cz, yaw, hl, hw, pad, minAO) => {
    const ext = Math.hypot(hl, hw) + pad;
    if (cx + ext < MIN_X || cx - ext > MAX_X || cz + ext < MIN_Z || cz - ext > MAX_Z) return;
    const ix0 = Math.max(0, Math.floor(txOf(cx - ext)));
    const ix1 = Math.min(W - 1, Math.ceil(txOf(cx + ext)));
    const iz0 = Math.max(0, Math.floor(tzOf(cz - ext)));
    const iz1 = Math.min(H - 1, Math.ceil(tzOf(cz + ext)));
    const c = Math.cos(-yaw), s = Math.sin(-yaw);
    const invP = 1 / Math.max(pad, 0.25);
    for (let iz = iz0; iz <= iz1; iz++) {
      const rz = wzOf(iz) - cz;
      const row = iz * W;
      for (let ix = ix0; ix <= ix1; ix++) {
        const rx = wxOf(ix) - cx;
        // local coordinates aligned with vehicle (X width, Z length)
        const lx = Math.abs(rx * c - rz * s);
        const lz = Math.abs(rx * s + rz * c);
        const dx = Math.max(0, lx - hw);
        const dz = Math.max(0, lz - hl);
        const d = Math.hypot(dx, dz) * invP;
        if (d >= 1.0) continue;
        const t = d * d * (3.0 - 2.0 * d);
        const k = minAO + (1.0 - minAO) * t;
        if (k < ao[row + ix]) ao[row + ix] = k;
      }
    }
  };

  // 1. Building base contact AO + subtle warm storefront spill onto sidewalks
  const shopWarm = hexLinear('#ffbe78');
  for (const b of ctx.buildings) {
    if (b.x1 + 10 < MIN_X || b.x0 - 10 > MAX_X || b.z1 + 10 < MIN_Z || b.z0 - 10 > MAX_Z) continue;
    addBoxAO(b.x0, b.z0, b.x1, b.z1, 2.8, 0.44);
    // Gentle warm storefront spill along street-facing edges
    if (b.shops) {
      const step = 7.5;
      if (b.shops & 1) for (let x = b.x0 + 3; x < b.x1 - 2; x += step) addLight(x, b.z0 - 2.8, 7.5, shopWarm, 0.22);
      if (b.shops & 4) for (let x = b.x0 + 3; x < b.x1 - 2; x += step) addLight(x, b.z1 + 2.8, 7.5, shopWarm, 0.22);
      if (b.shops & 2) for (let z = b.z0 + 3; z < b.z1 - 2; z += step) addLight(b.x1 + 2.8, z, 7.5, shopWarm, 0.22);
      if (b.shops & 8) for (let z = b.z0 + 3; z < b.z1 - 2; z += step) addLight(b.x0 - 2.8, z, 7.5, shopWarm, 0.22);
    }
  }

  // 2. Sidewalk kerb gutter contact darkening along roadways
  for (let iz = 0; iz < H; iz++) {
    const wz = wzOf(iz);
    const inPlaza = wz > PLAZA_Z0 && wz < PLAZA_Z1;
    const bwx = broadwayX(wz);
    const row = iz * W;
    for (let ix = 0; ix < W; ix++) {
      const wx = wxOf(ix);
      let dKerb = 99;
      for (let i = 0; i < AVENUES.length; i++) {
        const a = AVENUES[i];
        const dx = Math.abs(wx - a.x);
        if (dx < a.road + 0.5) dKerb = Math.min(dKerb, Math.abs(dx - a.road));
      }
      for (let i = 0; i < STREETS.length; i++) {
        const s = STREETS[i];
        const dz = Math.abs(wz - s.z);
        if (dz < s.road + 0.5) dKerb = Math.min(dKerb, Math.abs(dz - s.road));
      }
      if (!inPlaza) {
        const db = Math.abs(wx - bwx);
        if (db < 8.5) dKerb = Math.min(dKerb, Math.abs(db - 8.0));
      }
      if (dKerb < 1.8) {
        const t = dKerb / 1.8;
        const k = 0.72 + 0.28 * (t * t * (3.0 - 2.0 * t));
        if (k < ao[row + ix]) ao[row + ix] = k;
      }
    }
  }

  // 3. Vehicle & street-prop contact AO
  for (const v of ctx.vehicles) {
    addYawAO(v.x, v.z, v.yaw, v.hl + 0.1, v.hw + 0.1, 1.35, 0.30);
  }
  for (const o of (ctx.occluders || [])) {
    addBoxAO(o.x0, o.z0, o.x1, o.z1, o.pad || 1.3, o.minAO || 0.36);
  }

  // 4. Recorded colored light sources (billboards, street lamps, plaza features, wrecks)
  for (const l of (ctx.lights || [])) {
    addLight(l.x, l.z, l.r, hexLinear(l.color), l.k);
  }

  // 5. Soften RGB light spill with a quick separable 3-tap box blur for silky washes
  const tmp = new Float32Array(rgb.length);
  for (let iz = 0; iz < H; iz++) {
    const row = iz * W;
    for (let ix = 0; ix < W; ix++) {
      const i0 = (row + Math.max(0, ix - 1)) * 3;
      const i1 = (row + ix) * 3;
      const i2 = (row + Math.min(W - 1, ix + 1)) * 3;
      tmp[i1]     = rgb[i0]     * 0.25 + rgb[i1]     * 0.5 + rgb[i2]     * 0.25;
      tmp[i1 + 1] = rgb[i0 + 1] * 0.25 + rgb[i1 + 1] * 0.5 + rgb[i2 + 1] * 0.25;
      tmp[i1 + 2] = rgb[i0 + 2] * 0.25 + rgb[i1 + 2] * 0.5 + rgb[i2 + 2] * 0.25;
    }
  }
  const data = new Uint8Array(W * H * 4);
  for (let iz = 0; iz < H; iz++) {
    const r0 = Math.max(0, iz - 1) * W;
    const r1 = iz * W;
    const r2 = Math.min(H - 1, iz + 1) * W;
    for (let ix = 0; ix < W; ix++) {
      const p0 = (r0 + ix) * 3, p1 = (r1 + ix) * 3, p2 = (r2 + ix) * 3;
      // Soft knee compression so overlapping neon billboards stay saturated instead of blowing to white
      const rr = tmp[p0]     * 0.25 + tmp[p1]     * 0.5 + tmp[p2]     * 0.25;
      const gg = tmp[p0 + 1] * 0.25 + tmp[p1 + 1] * 0.5 + tmp[p2 + 1] * 0.25;
      const bb = tmp[p0 + 2] * 0.25 + tmp[p1 + 2] * 0.5 + tmp[p2 + 2] * 0.25;
      const peak = Math.max(rr, gg, bb);
      const tone = peak > 0.001 ? (1.0 - Math.exp(-peak * 0.75)) / peak * 1.32 : 1.0;
      let fr = rr * tone, fg = gg * tone, fb = bb * tone;
      // Preserve chromatic punch so overlapping neon stays rich instead of milky grey
      const lum = fr * 0.2126 + fg * 0.7152 + fb * 0.0722;
      fr = Math.max(0, lum + (fr - lum) * 1.18);
      fg = Math.max(0, lum + (fg - lum) * 1.18);
      fb = Math.max(0, lum + (fb - lum) * 1.18);
      const o = (r1 + ix) * 4;
      data[o]     = Math.min(255, Math.max(0, Math.round(fr * 0.5 * 255)));
      data[o + 1] = Math.min(255, Math.max(0, Math.round(fg * 0.5 * 255)));
      data[o + 2] = Math.min(255, Math.max(0, Math.round(fb * 0.5 * 255)));
      data[o + 3] = Math.min(255, Math.max(0, Math.round(ao[r1 + ix] * 255)));
    }
  }

  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;

  return {
    texture: tex,
    rect: new THREE.Vector4(MIN_X, MIN_Z, INV_W, INV_H),
  };
}

/**
 * Patches a Midtown material with baked neon light spill, ground contact AO,
 * and city-wide base-height contact darkening.
 * @param {THREE.Material} mat
 * @param {{texture: THREE.DataTexture, rect: THREE.Vector4}} lightMap
 * @param {object} opts { mode: 'ground'|'walk'|'marks'|'flat', spillGain, aoStrength, baseAO }
 */
export function applyCityLighting(mat, lightMap, {
  mode = 'ground',
  spillGain = 0.55,
  aoStrength = 1.0,
  baseAO = 0.0,
  key = mode,
} = {}) {
  const prevCompile = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey() : '';
  mat.onBeforeCompile = (s, renderer) => {
    if (prevCompile) prevCompile(s, renderer);
    const hasRw = s.fragmentShader.includes('float rwPuddle;');
    s.uniforms.uCityLight = { value: lightMap.texture };
    s.uniforms.uCityRect = { value: lightMap.rect };
    if (hasRw) s.uniforms.uMedWetSpec = MED_WET_SPEC;
    const hasWp = s.vertexShader.includes('vWp');
    if (!hasWp) {
      s.vertexShader = s.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWp;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    }
    const fragHasWp = s.fragmentShader.includes('varying vec3 vWp');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        ${fragHasWp ? '' : 'varying vec3 vWp;'}
        uniform sampler2D uCityLight;
        uniform vec4 uCityRect;
        ${hasRw ? 'uniform float uMedWetSpec;' : ''}
        vec4 sampleCityLight(vec2 xz) {
          vec2 uv = (xz - uCityRect.xy) * uCityRect.zw;
          vec2 inside = smoothstep(vec2(0.0), vec2(0.06), uv) * smoothstep(vec2(0.0), vec2(0.06), 1.0 - uv);
          float m = inside.x * inside.y;
          vec4 raw = texture2D(uCityLight, clamp(uv, 0.002, 0.998));
          return vec4(raw.rgb * 2.0 * m, mix(1.0, raw.a, m));
        }`);

    const isGround = mode === 'ground' || mode === 'walk' || mode === 'marks';

    // Compute light-spill + contact-AO sample ONCE in color_fragment and reuse in emissivemap_fragment
    const aoBlock = isGround
      ? `vec4 _clm = sampleCityLight(vWp.xz);
        {
          float aoK = mix(1.0, _clm.a, ${aoStrength.toFixed(2)});
          diffuseColor.rgb *= aoK;
        }`
      : `vec4 _clm = sampleCityLight(vWp.xz);
        {
          // Grounded wall/prop base darkening across the entire city
          float hAO = mix(${(1.0 - baseAO).toFixed(2)}, 1.0, smoothstep(0.0, 2.0, max(0.0, vWp.y - ${CURB.toFixed(2)})));
          float mapAO = mix(1.0, _clm.a, ${aoStrength.toFixed(2)} * (1.0 - smoothstep(0.0, 3.5, max(0.0, vWp.y - ${CURB.toFixed(2)}))));
          diffuseColor.rgb *= hAO * mapAO;
        }`;

    s.fragmentShader = s.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>\n${aoBlock}`);

    // Colored neon & lamp bounce spill added into emissive radiance; wet roads also
    // get grazing specular neon sheen from baked lightmap (drives Medium wet look at 0 extra passes).
    const spillBlock = isGround
      ? (hasRw && mode === 'ground'
        ? `{
            float _clLum = dot(_clm.rgb, vec3(0.2126, 0.7152, 0.0722));
            vec3 _diffBounce = mix(vec3(_clLum), _clm.rgb, 0.58);
            vec3 spill = _diffBounce * (diffuseColor.rgb * 0.85 + vec3(0.009)) * ${spillGain.toFixed(2)} * mix(0.42, 1.0, _clm.a);
            vec3 _vdf = vWp - cameraPosition;
            float _vdl = max(length(_vdf), 0.1);
            vec3 _vdir = _vdf / _vdl;
            float _hzl = length(_vdir.xz);
            vec2 _hdir = _hzl > 1e-4 ? _vdir.xz / _hzl : vec2(0.0, -1.0);
            float _f1 = 1.0 - clamp(-_vdir.y, 0.0, 1.0);
            float _f2 = _f1 * _f1;
            float _fres = 0.03 + 0.97 * _f2 * _f2 * _f1;
            vec3 _ahead = sampleCityLight(vWp.xz + _hdir * mix(8.0, 20.0, _fres)).rgb;
            float _gr = 0.65 + 0.35 * rwGr;
            float _wSpec = (rwPuddle * mix(0.14, 0.92, _fres) + rwDamp * (1.0 - rwPuddle) * mix(0.02, 0.24, _fres)) * _gr;
            totalEmissiveRadiance += spill + _ahead * _wSpec * uMedWetSpec * 0.42 * mix(0.35, 1.0, _clm.a);
          }`
        : `{
            float _clLum = dot(_clm.rgb, vec3(0.2126, 0.7152, 0.0722));
            vec3 _diffBounce = mix(vec3(_clLum), _clm.rgb, 0.65);
            vec3 spill = _diffBounce * (diffuseColor.rgb * 0.88 + vec3(0.018)) * ${spillGain.toFixed(2)} * mix(0.45, 1.0, _clm.a);
            totalEmissiveRadiance += spill;
          }`)
      : `{
          float hFade = smoothstep(-0.5, 3.0, vWp.y) * (1.0 - smoothstep(32.0, 82.0, vWp.y));
          vec3 spill = _clm.rgb * (diffuseColor.rgb * 0.75 + vec3(0.025)) * ${spillGain.toFixed(2)} * (0.35 + 0.65 * hFade);
          totalEmissiveRadiance += spill;
        }`;

    s.fragmentShader = s.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${spillBlock}`);
  };
  mat.customProgramCacheKey = () => `${prevKey}|cl_${key}`;
  mat.needsUpdate = true;
  return mat;
}
