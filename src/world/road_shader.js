// World-space wet-asphalt shading, tire-track & puddle mask, non-repeating road
// wear (utility patches, tar snakes, hairline cracks, oil stains), worn lane
// markings, and height-stratified blue-hour depth haze for Midtown Manhattan.
//
// Shared across Midtown road/sidewalk/markings materials and StreetReflectionPass
// so dry crowns, damp tyre ruts, gutter puddles, and standing water match 100%.
// Phone-safe GLSL: polynomial falloffs (zero per-pixel exp), guarded divisions,
// pow-free Fresnel, and zero derivatives inside non-uniform branches.
import * as THREE from 'three';

/** Scale for baked-lightmap wet specular on Medium/Low (and subtle fill on High). */
export const MED_WET_SPEC = { value: 1.0 };

export const ROAD_WETNESS_GLSL = `
  float rwHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float rwNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(rwHash(i), rwHash(i + vec2(1.0, 0.0)), f.x),
      mix(rwHash(i + vec2(0.0, 1.0)), rwHash(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  float rwGrain(vec2 xz) {
    return rwNoise(xz * 6.5);
  }

  // Returns vec4(damp, puddle, rutMask, ax) from world XZ and surface Y.
  // Roadways sit at y ~ 0.0; sidewalks and Times Square plazas sit at y ~ 0.15.
  vec4 rwEvalWetness(vec2 xz, float y) {
    float ax = xz.x < 630.0 ? mod(xz.x + 140.0, 280.0) - 140.0 : mod(xz.x + 70.0, 140.0) - 70.0;
    float sz = mod(xz.y + 40.0, 80.0) - 40.0;
    float isWalk = smoothstep(0.06, 0.13, y);

    // Organic low-spot topography (2 octaves, domain-shifted)
    float coarse = rwNoise(xz * 0.036);
    float mid = rwNoise(xz * 0.135 + vec2(coarse * 0.65, coarse * 0.45 + 5.1));
    float lowSpot = coarse * 0.62 + mid * 0.38;

    // Gutters along avenue & cross-street kerbs (broken into intermittent pools)
    float aveGutter = smoothstep(6.2, 8.4, abs(ax)) * (1.0 - smoothstep(8.9, 10.6, abs(ax)));
    float stGutter  = smoothstep(3.4, 4.9, abs(sz)) * (1.0 - smoothstep(5.3, 8.8, abs(sz)));
    float gutter = max(aveGutter, stGutter) * smoothstep(0.32, 0.72, mid) * (1.0 - isWalk);

    // Paired tyre-track bands inside 3.0 m traffic lanes (polynomial peak, zero exp)
    float lAx = abs(fract((ax + 1.5) / 3.0) - 0.5) - 0.26;
    float rutA = max(0.0, 1.0 - lAx * lAx * 52.0) * (1.0 - smoothstep(7.2, 8.8, abs(ax)));
    float lSz = abs(fract((sz + 1.5) / 3.0) - 0.5) - 0.26;
    float rutS = max(0.0, 1.0 - lSz * lSz * 52.0) * (1.0 - smoothstep(4.2, 5.2, abs(sz)));
    float rut = clamp(max(rutA, rutS) * (0.42 + 0.58 * mid) * (1.0 - isWalk), 0.0, 1.0);

    // Roadways drain outward from a drier centre crown
    float crownDry = max(0.0, 1.0 - ax * ax * 0.045) * (1.0 - isWalk) * 0.46;

    float wetField = lowSpot + gutter * 0.30 + rut * 0.22 - crownDry * 0.28 - isWalk * 0.22;
    float puddle = smoothstep(0.50, 0.74, wetField + (mid - 0.5) * 0.06);
    float damp = smoothstep(0.24, 0.62, wetField + 0.12 * (1.0 - isWalk));
    return vec4(damp, puddle, rut, ax);
  }
`;

const ROAD_DETAIL_GLSL = `
  // Non-repeating world-space asphalt wear surviving mipmapping past 10-50 m:
  // lane-to-lane paving differences, worn wheel paths, bold utility cuts, tar snakes & cracks.
  vec4 rwAsphaltWear(vec2 xz, float rut, float coarseN, float ax) {
    float laneShade = 0.91 + 0.18 * rwHash(vec2(floor((ax + 1.5) / 3.0), 7.3));

    vec2 pCell = floor(xz / 11.0);
    vec2 pLocal = fract(xz / 11.0) - 0.5;
    float hP = rwHash(pCell + vec2(3.1, 7.7));
    float hasPatch = step(0.58, hP);
    float hS = rwHash(pCell + vec2(11.3, 5.9));
    vec2 dBox = abs(pLocal) - vec2(0.16 + 0.18 * hS, 0.30 - 0.14 * hS);
    float boxDist = max(dBox.x, dBox.y);
    float patchIn = hasPatch * (1.0 - smoothstep(-0.015, 0.008, boxDist));
    float seam = hasPatch * (1.0 - smoothstep(0.0, 0.022, abs(boxDist)));
    float fresh = step(0.79, hP);

    // Bolder matte-dark tar-snake sealant lines (never catches white sun glare)
    vec2 wTar = xz * 0.18 + vec2(coarseN * 0.9, coarseN * 0.6);
    float rTar = 1.0 - abs(rwNoise(wTar) * 2.0 - 1.0);
    float rTar2 = rTar * rTar;
    float rTar4 = rTar2 * rTar2;
    float tarLine = smoothstep(0.78, 0.94, rTar4) * smoothstep(0.42, 0.68, coarseN);

    // Hairline cracks + oil lane grime
    float midN = rwNoise(xz * 0.65 + 3.7);
    float rCrk = 1.0 - abs(midN * 2.0 - 1.0);
    float rCrk4 = rCrk * rCrk * rCrk * rCrk;
    float crack = smoothstep(0.84, 0.96, rCrk4) * smoothstep(0.40, 0.66, coarseN + rut * 0.20);
    float oil = smoothstep(0.70, 0.88, midN + rut * 0.16);

    float aMul = laneShade
               * mix(1.0, mix(1.18, 0.68, fresh), patchIn)
               * mix(1.0, 0.30, seam)
               * mix(1.0, 0.28, tarLine)
               * mix(1.0, 0.46, crack)
               * mix(1.0, 0.74, oil * 0.7);

    float tRough = mix(0.88, mix(0.90, 0.76, fresh), patchIn);
    tRough = mix(tRough, 0.58, oil * 0.55);
    tRough = mix(tRough, 0.68, tarLine);
    float wRough = clamp(patchIn * 0.60 + oil * 0.50 + tarLine * 0.80, 0.0, 1.0);
    return vec4(aMul, tRough, wRough, seam);
  }
`;

/**
 * Patches Midtown road or sidewalk/plaza MeshStandardMaterial with world-space
 * wetness, tyre-track ruts, non-repeating surface wear, and puddle flattening.
 */
export function applyRoadSurface(mat, { isWalk = false, key = 'road' } = {}) {
  const prevCompile = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey() : '';
  mat.onBeforeCompile = (s, renderer) => {
    if (prevCompile) prevCompile(s, renderer);
    const hasWpV = s.vertexShader.includes('vWp');
    if (!hasWpV) {
      s.vertexShader = s.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWp;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    }
    const hasWpF = s.fragmentShader.includes('varying vec3 vWp');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        ${hasWpF ? '' : 'varying vec3 vWp;'}
        ${ROAD_WETNESS_GLSL}
        ${isWalk ? '' : ROAD_DETAIL_GLSL}
        float rwDamp;
        float rwPuddle;
        float rwRut;
        float rwGr;
        vec4 rwWear;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          ${isWalk
            ? `float _drift = rwNoise(vWp.xz * 0.036);
               float _midW = rwNoise(vWp.xz * 0.135 + vec2(_drift * 0.65, _drift * 0.45 + 5.1));
               float _wf = _drift * 0.62 + _midW * 0.38 - 0.20;
               rwDamp = smoothstep(0.28, 0.68, _wf);
               rwPuddle = smoothstep(0.63, 0.78, _wf);
               rwRut = 0.0;
               rwGr = _midW;
               rwWear = vec4(1.0, 0.86, 0.0, 0.0);
               diffuseColor.rgb *= 0.88 + 0.22 * _drift;
               float _wetDark = clamp(rwDamp * 0.42 + rwPuddle * 0.45, 0.0, 1.0);
               diffuseColor.rgb *= mix(1.0, 0.64, _wetDark);`
            : `vec4 _rw = rwEvalWetness(vWp.xz, vWp.y);
               rwDamp = _rw.x;
               rwPuddle = _rw.y;
               rwRut = _rw.z;
               rwGr = rwGrain(vWp.xz);
               float _drift = rwNoise(vWp.xz * 0.032);
               rwWear = rwAsphaltWear(vWp.xz, rwRut, _drift, _rw.w);
               diffuseColor.rgb *= (0.76 + 0.42 * _drift) * rwWear.x;
               diffuseColor.rgb *= 1.0 + rwRut * 0.14 * (1.0 - rwPuddle);
               float _wetDark = clamp(rwDamp * 0.56 + rwPuddle * 0.48, 0.0, 1.0);
               diffuseColor.rgb *= mix(1.0, 0.54, _wetDark);`}
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        {
          ${isWalk
            ? `roughnessFactor = mix(roughnessFactor, 0.78 + 0.12 * rwGr, rwDamp * 0.52);
               roughnessFactor = mix(roughnessFactor, 0.14 + 0.08 * rwGr, rwPuddle * 0.85);`
            : `roughnessFactor = mix(roughnessFactor, rwWear.y, rwWear.z);
               float _dampR = mix(0.88, 0.58, rwDamp) - rwRut * 0.10 + (rwGr - 0.5) * 0.08;
               roughnessFactor = mix(roughnessFactor, clamp(_dampR, 0.44, 0.95), 0.76);
               roughnessFactor = mix(roughnessFactor, 0.09 + 0.07 * rwGr, rwPuddle);`}
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 _upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          normal = normalize(mix(normal, _upV, rwPuddle * ${isWalk ? '0.55' : '0.72'}));
        }`)
      .replace('#include <lights_fragment_end>', isWalk ? '#include <lights_fragment_end>' : `#include <lights_fragment_end>
        {
          reflectedLight.directSpecular *= mix(0.12, 0.52, rwPuddle);
          reflectedLight.indirectSpecular = min(reflectedLight.indirectSpecular, vec3(mix(0.14, 0.48, rwPuddle)));
        }`);
  };
  mat.customProgramCacheKey = () => `${prevKey}|rw_${key}`;
  mat.needsUpdate = true;
  return mat;
}

/**
 * Adds world-space tyre-path scuffing, wear breakup, and damp darkening to road
 * lane markings so lines do not repeat identically every block.
 */
export function applyMarkingsWear(mat) {
  const prevCompile = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey() : '';
  mat.onBeforeCompile = (s, renderer) => {
    if (prevCompile) prevCompile(s, renderer);
    const hasWpV = s.vertexShader.includes('vWp');
    if (!hasWpV) {
      s.vertexShader = s.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWp;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    }
    const hasWpF = s.fragmentShader.includes('varying vec3 vWp');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        ${hasWpF ? '' : 'varying vec3 vWp;'}
        ${ROAD_WETNESS_GLSL}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          float _scuff = rwNoise(vWp.xz * 0.52 + 4.7);
          float _wear = smoothstep(0.18, 0.54, _scuff);
          diffuseColor.a *= mix(0.46, 1.0, _wear);
          diffuseColor.rgb *= 0.74 + 0.22 * _scuff;
        }`);
  };
  mat.customProgramCacheKey = () => `${prevKey}|mw_3`;
  mat.needsUpdate = true;
  return mat;
}

/**
 * Height-stratified blue-hour aerial perspective haze for Midtown Manhattan.
 * Uses Three's existing vFogDepth (zero per-pixel exp/length) and preserves neon.
 */
export function applyMidtownHaze(mat, { strength = 1.0, neonPreserve = 0.72, baseFogScale = 1.0, key = 'haze' } = {}) {
  const prevCompile = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey() : '';
  mat.onBeforeCompile = (s, renderer) => {
    if (prevCompile) prevCompile(s, renderer);
    if (strength <= 0.01) {
      s.fragmentShader = s.fragmentShader.replace('#include <fog_fragment>', `#ifdef USE_FOG
          float fogFactor = smoothstep(fogNear, fogFar, vFogDepth) * ${baseFogScale.toFixed(2)};
          gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
        #endif`);
      return;
    }
    const hasWpV = s.vertexShader.includes('vWp');
    if (!hasWpV) {
      s.vertexShader = s.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWp;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    }
    const hasWpF = s.fragmentShader.includes('varying vec3 vWp');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        ${hasWpF ? '' : 'varying vec3 vWp;'}`)
      .replace('#include <fog_fragment>', `${baseFogScale < 0.99
        ? `#ifdef USE_FOG
          float fogFactor = smoothstep(fogNear, fogFar, vFogDepth) * ${baseFogScale.toFixed(2)};
          gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
        #endif`
        : '#include <fog_fragment>'}
        #ifdef USE_FOG
        {
          float _hd = max(vFogDepth - 95.0, 0.0);
          if (_hd > 0.5) {
            float _hAlt = clamp(1.0 - max(vWp.y, 0.0) * 0.0085, 0.28, 1.0);
            float _hF = (_hd / (_hd + 340.0)) * _hAlt * ${strength.toFixed(2)};
            float _peak = max(gl_FragColor.r, max(gl_FragColor.g, gl_FragColor.b));
            float _keep = 1.0 - smoothstep(0.45, 1.60, _peak) * ${neonPreserve.toFixed(2)};
            gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.055, 0.085, 0.165), clamp(_hF * _keep, 0.0, 0.72));
          }
        }
        #endif`);
  };
  mat.customProgramCacheKey = () => `${prevKey}|hz_${key}`;
  mat.needsUpdate = true;
  return mat;
}
