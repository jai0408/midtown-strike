// Backdrop mountains: chiseled Cascade granite crags, exposed alpine rock ribs,
// couloir snowfields, conifer foothills, and light valley mist.
// Mali/Adreno safe: no derivatives in non-uniform branches, guarded normalizes, pow-free weights.
import * as THREE from 'three';
import { getMaxAnisotropy } from './textures.js';

const MOUNTAIN_NOISE_GLSL = `
        float mHash(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }
        float mNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(mHash(i), mHash(i + vec2(1.0, 0.0)), f.x),
            mix(mHash(i + vec2(0.0, 1.0)), mHash(i + vec2(1.0, 1.0)), f.x),
            f.y
          );
        }
        float mFbm(vec2 p) {
          float s = mNoise(p) * 0.54;
          p = mat2(0.8, -0.6, 0.6, 0.8) * p * 2.07;
          s += mNoise(p) * 0.30;
          p = mat2(0.8, -0.6, 0.6, 0.8) * p * 2.03;
          s += mNoise(p) * 0.16;
          return s;
        }
        float mCliffHeight(vec3 p) {
          float warp = mNoise(p.xz * 0.0085 + vec2(p.y * 0.004, 3.1));
          float strata = sin(p.y * 0.105 + warp * 5.2 + p.x * 0.009) * 0.5 + 0.5;
          float rib0 = 1.0 - abs(mNoise(p.xz * 0.016 + vec2(p.y * 0.003, -p.y * 0.003)) * 2.0 - 1.0);
          float rib1 = 1.0 - abs(mNoise(p.xz * 0.042 + vec2(-p.y * 0.009, p.y * 0.008)) * 2.0 - 1.0);
          float rib2 = 1.0 - abs(mNoise(p.xz * 0.105 + vec2(p.y * 0.02, -p.y * 0.015)) * 2.0 - 1.0);
          return strata * 0.24 + rib0 * rib0 * 0.42 + rib1 * rib1 * 0.24 + rib2 * 0.10;
        }`;

export async function applyMountainShader(mat, rockImageB64, sunDir = [-0.5003, 0.7204, 0.4803]) {
  let rock = null;
  try {
    const src = rockImageB64.startsWith('data:')
      ? rockImageB64
      : 'data:image/png;base64,' + (rockImageB64.indexOf(',') >= 0 ? rockImageB64.slice(rockImageB64.indexOf(',') + 1) : rockImageB64);
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = src;
    });
    rock = new THREE.Texture(img);
    rock.colorSpace = THREE.SRGBColorSpace;
    rock.wrapS = rock.wrapT = THREE.RepeatWrapping;
    rock.anisotropy = getMaxAnisotropy();
    rock.generateMipmaps = true;
    rock.flipY = false;
    rock.needsUpdate = true;
  } catch (e) { console.warn('mountain rock texture failed', e); return mat; }

  const sDir = new THREE.Vector3(sunDir[0], sunDir[1], sunDir[2]).normalize();
  const uniforms = { uRock: { value: rock }, uSunDir: { value: sDir } };
  mat.roughness = 0.94;
  mat.metalness = 0.0;
  mat.vertexColors = false;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWN;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWN = normalize(mat3(modelMatrix) * normal);`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos;
        varying vec3 vWN;
        uniform sampler2D uRock;
        uniform vec3 uSunDir;
        ${MOUNTAIN_NOISE_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float mSnowMask = 0.0;
        vec3 mBumpGrad = vec3(0.0);
        {
          vec3 n = normalize(vWN);
          vec3 an = abs(n);
          vec3 w2 = an * an;
          vec3 w = w2 * w2;
          w /= max(w.x + w.y + w.z, 1e-4);

          vec3 p = vWPos;
          // Crisp dual-scale triplanar rock detail (no giant stretched cobbles)
          vec3 r1 = texture2D(uRock, p.zy * 0.052).rgb * w.x
                  + texture2D(uRock, p.xz * 0.052).rgb * w.y
                  + texture2D(uRock, p.xy * 0.052).rgb * w.z;
          vec3 r2 = texture2D(uRock, p.zy * 0.016 + vec2(0.37, 0.19)).rgb * w.x
                  + texture2D(uRock, p.xz * 0.016 + vec2(0.37, 0.19)).rgb * w.y
                  + texture2D(uRock, p.xy * 0.016 + vec2(0.37, 0.19)).rgb * w.z;

          float rMicro = clamp(dot(r1, vec3(0.3333)), 0.0, 1.0);
          float rMacro = clamp(dot(r2, vec3(0.3333)), 0.0, 1.0);

          float hC = mCliffHeight(p);
          float eps = 5.5;
          mBumpGrad = vec3(
            mCliffHeight(p + vec3(eps, 0.0, 0.0)) - hC,
            mCliffHeight(p + vec3(0.0, eps, 0.0)) - hC,
            mCliffHeight(p + vec3(0.0, 0.0, eps)) - hC
          ) / eps;

          // Compute bumped rock slope so steep procedural rock ribs shed snow naturally!
          vec3 rockWN = normalize(n - mBumpGrad * 8.5);
          float rockUp = rockWN.y;

          // Rich Cascade alpine granite: deep shadowed slate gullies + warm grey-ochre sunlit ribs
          float nzLarge = mFbm(p.xz * 0.009 + vec2(2.4, -1.7));
          float nzMed   = mFbm(p.xz * 0.032 + vec2(-4.1, 6.3));
          float strataBand = smoothstep(0.28, 0.78, sin(p.y * 0.11 + nzLarge * 5.8) * 0.5 + 0.5);
          vec3 darkCrevice = vec3(0.055, 0.068, 0.088);
          vec3 midGranite  = vec3(0.165, 0.175, 0.195);
          vec3 warmLedge   = vec3(0.235, 0.210, 0.182);
          vec3 rockC = mix(darkCrevice, midGranite, clamp(hC * 1.10 + rMacro * 0.25 - 0.10, 0.0, 1.0));
          rockC = mix(rockC, warmLedge, strataBand * 0.44 * (0.35 + 0.65 * nzMed));
          rockC *= (0.72 + 0.54 * rMicro);

          float h = p.y;

          // Conifer foothills: dense dark timber canopy clusters + rocky cliff breaks (zero smooth green cones)
          float treeline = 90.0 + (nzLarge - 0.5) * 44.0 + (nzMed - 0.5) * 28.0;
          float forestAlt = 1.0 - smoothstep(treeline - 24.0, treeline + 30.0, h);
          float forestSlope = smoothstep(0.75, 0.92, rockUp + (nzMed - 0.5) * 0.14);
          float standBreak = smoothstep(0.32, 0.68, mNoise(p.xz * 0.09 + vec2(3.1, -1.9)) * 0.65 + hC * 0.35);
          float forest = forestAlt * forestSlope * (0.15 + 0.85 * standBreak);
          float canopy = mNoise(p.xz * 0.35) * 0.45 + mNoise(p.xz * 0.95) * 0.35 + mNoise(p.xz * 0.14) * 0.20;
          float crownDot = smoothstep(0.28, 0.76, canopy);
          vec3 pineDark = vec3(0.008, 0.022, 0.013);
          vec3 pineMid  = vec3(0.024, 0.050, 0.021);
          vec3 forestC = mix(pineDark, pineMid, clamp(crownDot * 0.82 + nzMed * 0.18, 0.0, 1.0)) * (0.35 + 0.88 * crownDot);

          // Sub-alpine talus & scrub transition
          float scree = smoothstep(treeline - 16.0, treeline + 18.0, h)
                      * (1.0 - smoothstep(treeline + 38.0, treeline + 95.0, h))
                      * smoothstep(0.66, 0.88, rockUp);
          vec3 screeC = mix(vec3(0.11, 0.115, 0.095), vec3(0.185, 0.175, 0.145), nzMed) * (0.78 + 0.40 * rMicro);

          // Sculpted glacier snowfields & couloirs:
          // Snow settles in recessed bowls/couloirs (low hC) and gentler bumped ledges (high rockUp),
          // leaving sharp granite buttresses & rocky crags boldly exposed all the way to the summit!
          float gully = smoothstep(0.56, 0.16, hC);
          float snowAlt = smoothstep(145.0 + (nzLarge - 0.5) * 44.0 - gully * 38.0,
                                     225.0 + (nzLarge - 0.5) * 38.0 - gully * 26.0, h);
          float couloirDrift = smoothstep(0.42, 0.76, gully) * smoothstep(0.52, 0.80, rockUp + 0.12);
          float benchSnow = smoothstep(0.76, 0.92, rockUp + (nzMed - 0.5) * 0.14) * smoothstep(175.0, 245.0, h);
          float summitCap = smoothstep(235.0, 300.0, h) * smoothstep(0.66, 0.86, rockUp + (gully - 0.30) * 0.25);
          mSnowMask = clamp(max(snowAlt * couloirDrift, max(benchSnow, summitCap)), 0.0, 1.0);

          // Physical glacier snow: crisp cool blue in shadow creases, warm bright snow on sunlit facets
          float sunSide = clamp(dot(rockWN, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
          vec3 snowC = mix(vec3(0.42, 0.54, 0.70), vec3(0.76, 0.80, 0.84), smoothstep(0.18, 0.82, sunSide));
          snowC *= (0.90 + 0.18 * rMicro);

          vec3 col = mix(rockC, screeC, scree * 0.65);
          col = mix(col, forestC, forest);
          col = mix(col, snowC, mSnowMask);
          diffuseColor.rgb = col;
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(0.95, 0.72, mSnowMask);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 wn = normalize(vWN);
          // Bold chiseled granite faces vs sculpted snow gullies
          float bumpAmt = mix(9.5, 2.8, mSnowMask);
          vec3 pertW = normalize(wn - mBumpGrad * bumpAmt);
          normal = normalize(transformDirection(pertW, viewMatrix));
        }`)
      .replace('#include <fog_fragment>', `
        {
          // Subtle low-altitude valley mist only (keeps upper granite & glacier peaks razor-crisp)
          float dist = length(vWPos.xz - cameraPosition.xz);
          float valleyHaze = smoothstep(210.0, 760.0, dist) * (1.0 - smoothstep(25.0, 165.0, vWPos.y));
          vec3 valleyMist = vec3(0.48, 0.64, 0.82);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, valleyMist, clamp(valleyHaze * 0.24, 0.0, 0.30));
        }
        #include <fog_fragment>`);
  };
  mat.customProgramCacheKey = () => 'lodge-mountain-v4';
  mat.needsUpdate = true;
  return mat;
}

/** Procedural granite outcrops + dark conifer mottling for Lodge outer terrain hills (88..160 m). */
export function applyOuterGroundShader(mat) {
  mat.roughness = 0.94;
  mat.metalness = 0.0;
  mat.vertexColors = false;
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWN;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWN = normalize(mat3(modelMatrix) * normal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos;\nvarying vec3 vWN;
        ${MOUNTAIN_NOISE_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 ogBump = vec3(0.0);
        {
          vec3 n = normalize(vWN);
          vec3 p = vWPos;
          float hC = mCliffHeight(p * 1.45);
          float eps = 3.2;
          ogBump = vec3(mCliffHeight((p + vec3(eps, 0.0, 0.0)) * 1.45) - hC,
                        mCliffHeight((p + vec3(0.0, eps, 0.0)) * 1.45) - hC,
                        mCliffHeight((p + vec3(0.0, 0.0, eps)) * 1.45) - hC) / eps;
          vec3 rockWN = normalize(n - ogBump * 7.5);
          float nzL = mFbm(p.xz * 0.025 + vec2(1.7, -2.9));
          float nzM = mFbm(p.xz * 0.085 + vec2(-3.2, 4.1));
          float crown = smoothstep(0.26, 0.78, mNoise(p.xz * 0.34) * 0.48 + mNoise(p.xz * 0.92) * 0.36 + nzM * 0.16);
          float slopeRock = 1.0 - smoothstep(0.66, 0.88, rockWN.y + (nzM - 0.5) * 0.16);
          float cragBreak = smoothstep(0.56, 0.78, hC * 0.68 + nzL * 0.32);
          float rockMask = clamp(max(slopeRock, cragBreak * 0.82) * smoothstep(-0.3, 1.8, p.y), 0.0, 1.0);
          vec3 pineDark = vec3(0.010, 0.026, 0.015);
          vec3 pineMid  = vec3(0.028, 0.056, 0.022);
          vec3 duff     = vec3(0.048, 0.036, 0.022);
          vec3 vegC = mix(pineDark, pineMid, crown) * (0.45 + 0.82 * crown);
          vegC = mix(vegC, duff, (1.0 - crown) * 0.28);
          vec3 rockC = mix(vec3(0.075, 0.082, 0.095), vec3(0.185, 0.175, 0.155), clamp(hC * 0.9 + nzM * 0.3, 0.0, 1.0));
          diffuseColor.rgb = mix(vegC, rockC, rockMask);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = 0.94;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 wn = normalize(vWN);
          vec3 pertW = normalize(wn - ogBump * 7.5);
          normal = normalize(transformDirection(pertW, viewMatrix));
        }`);
  };
  mat.customProgramCacheKey = () => 'lodge-outer-ground-v1';
  mat.needsUpdate = true;
  return mat;
}
