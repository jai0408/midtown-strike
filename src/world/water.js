// Lake surface: one big plane on the standard PBR material (so fog, the sky
// reflection from scene.environment and the sun highlight come for free) with
// two scrolling procedural normal layers, a depth-tinted body colour, a
// Fresnel boost of the sky reflection and a shoreline fade driven by a small
// depth texture baked from the terrain height.
import * as THREE from 'three';
import { makeCanvas, getMaxAnisotropy } from './textures.js';
import { RNG } from '../core/util.js';

const MAX_DEPTH = 5;   // metres of water that map to depth = 1
const COVER = 200;     // the depth map covers at most +-COVER m; beyond it the lake counts as deep

/** Tileable ripple normals, from a few analytic sine waves (no per-pixel noise, so no seams). */
function rippleNormals(size = 256) {
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const rng = new RNG(1701);
  const waves = [];
  for (let i = 0; i < 9; i++) {
    const fx = Math.round(rng.range(-9, 9)), fy = Math.round(rng.range(-9, 9));
    if (!fx && !fy) { i--; continue; }
    waves.push({ fx, fy, ph: rng.range(0, 6.283), a: 1 / (1 + Math.hypot(fx, fy) * 0.55) });
  }
  const T = Math.PI * 2, K = 0.55;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let gx = 0, gy = 0;
      for (const w of waves) {
        const d = Math.cos(T * (w.fx * u + w.fy * v) + w.ph) * w.a * T;
        gx += d * w.fx; gy += d * w.fy;
      }
      gx *= K / 9; gy *= K / 9;
      const l = Math.hypot(gx, gy, 1);
      const o = (y * size + x) * 4;
      img.data[o] = Math.round((-gx / l * 0.5 + 0.5) * 255);
      img.data[o + 1] = Math.round((-gy / l * 0.5 + 0.5) * 255);
      img.data[o + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = getMaxAnisotropy();
  return t;
}

/** Water depth (0 at the shore, 1 at MAX_DEPTH) as an 8 bit texture over the lake rect. */
function depthMap(level, rect, heightAt) {
  const x0 = Math.max(rect.x0, -COVER), x1 = Math.min(rect.x1, COVER);
  const z0 = Math.max(rect.z0, -COVER), z1 = Math.min(rect.z1, COVER);
  const w = THREE.MathUtils.clamp(Math.round((x1 - x0) / 1.5), 8, 512);
  const h = THREE.MathUtils.clamp(Math.round((z1 - z0) / 1.5), 8, 512);
  const data = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    const z = z0 + ((j + 0.5) / h) * (z1 - z0);
    for (let i = 0; i < w; i++) {
      const x = x0 + ((i + 0.5) / w) * (x1 - x0);
      const d = (level - heightAt(x, z)) / MAX_DEPTH;
      data[j * w + i] = Math.round(THREE.MathUtils.clamp(d, 0, 1) * 255);
    }
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.UnsignedByteType);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.unpackAlignment = 1;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return { texture: t, rect: new THREE.Vector4(x0, z0, 1 / (x1 - x0), 1 / (z1 - z0)) };
}

/**
 * @param {{y:number,x0:number,z0:number,x1:number,z1:number}} water lake plane in game space
 * @param {(x:number,z:number)=>number} heightAt terrain height, for the shoreline fade
 * @param {number[]} [sunDir] optional sun direction [x, y, z]
 */
export function createWater(water, heightAt, sunDir = [-0.5003, 0.7204, 0.4803]) {
  const { y, x0, z0, x1, z1 } = water;
  const normals = rippleNormals();
  const depth = depthMap(y, water, heightAt);
  const wDir = new THREE.Vector2(0.82, 0.57).normalize();
  const sDir = new THREE.Vector3(sunDir[0], sunDir[1], sunDir[2]).normalize();
  const uniforms = {
    uTime: { value: 0 },
    uNormalMap: { value: normals },
    uDepthMap: { value: depth.texture },
    uRect: { value: depth.rect },
    uDeep: { value: new THREE.Color(0x021624) },
    uMid: { value: new THREE.Color(0x072b38) },
    uShallow: { value: new THREE.Color(0x1e5a5c) },
    uWindDir: { value: wDir },
    uSunDir: { value: sDir },
    uSunColor: { value: new THREE.Color(0xffedcc) },
  };
  // roughness stays well above ~0.1: a mirror-sharp sun glint overflows half-float
  // targets on phones (NaN squares through bloom). The shader also clamps its output.
  const material = new THREE.MeshStandardMaterial({
    color: 0x0a3442, roughness: 0.18, metalness: 0.05, transparent: true, opacity: 0.98, depthWrite: false, envMapIntensity: 1.8,
  });
  material.customProgramCacheKey = () => 'lodge-water-v2';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos;
        uniform float uTime;
        uniform sampler2D uNormalMap, uDepthMap;
        uniform vec4 uRect;
        uniform vec3 uDeep, uMid, uShallow;
        uniform vec2 uWindDir;
        uniform vec3 uSunDir, uSunColor;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 dUv = (vWPos.xz - uRect.xy) * uRect.zw;
        vec2 inside = step(vec2(0.0), dUv) * step(dUv, vec2(1.0));
        float depth = mix(1.0, texture2D(uDepthMap, clamp(dUv, 0.0, 1.0)).r, inside.x * inside.y);
        
        // Multi-stop alpine water color gradient: shallow emerald -> deep navy
        vec3 wBody = mix(uShallow, uMid, smoothstep(0.02, 0.32, depth));
        wBody = mix(wBody, uDeep, smoothstep(0.32, 0.85, depth));
        diffuseColor.rgb = wBody;
        
        // Soft shoreline: natural shoreline fade over shallow water
        diffuseColor.a *= smoothstep(0.0, 0.07, depth);
        
        // Dynamic shoreline wave lap & foam
        float waveLap = sin(uTime * 2.2 - depth * 26.0);
        float wFoam = smoothstep(0.003, 0.028, depth) * (1.0 - smoothstep(0.028, 0.11, depth)) * (0.5 + 0.5 * waveLap);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec2 p = vWPos.xz;
          // Physically wind-aligned waves:
          // Octave 1: primary swell along wind direction
          vec2 flow1 = uWindDir * (uTime * 0.018);
          // Octave 2: angled chop (+24 deg)
          vec2 wRot1 = vec2(uWindDir.x * 0.91 - uWindDir.y * 0.41, uWindDir.y * 0.91 + uWindDir.x * 0.41);
          vec2 flow2 = wRot1 * (uTime * 0.028);
          // Octave 3: fine capillary ripples (-20 deg)
          vec2 wRot2 = vec2(uWindDir.x * 0.94 + uWindDir.y * 0.34, uWindDir.y * 0.94 - uWindDir.x * 0.34);
          vec2 flow3 = wRot2 * (uTime * 0.042);
          
          vec3 n1 = texture2D(uNormalMap, p * 0.038 + flow1).xyz * 2.0 - 1.0;
          vec3 n2 = texture2D(uNormalMap, p * 0.095 + flow2).xyz * 2.0 - 1.0;
          vec3 n3 = texture2D(uNormalMap, p * 0.22 - flow3).xyz * 2.0 - 1.0;
          
          // Slope dampens in very shallow water
          vec2 sl = (n1.xy * 0.52 + n2.xy * 0.33 + n3.xy * 0.15) * mix(0.2, 0.7, smoothstep(0.0, 0.25, depth));
          vec3 wn = normalize(vec3(sl.x, 1.0, sl.y));
          normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
          wFoam *= 0.6 + 0.4 * n2.x;
        }`)
      .replace('#include <opaque_fragment>', `
        {
          vec3 vDir = normalize(vViewPosition);
          float NdotV = clamp(dot(normal, vDir), 0.0, 1.0);
          
          // Physically-based Fresnel reflection (water IOR 1.333, F0 = 0.02)
          float fresnel = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);
          outgoingLight += reflectedLight.indirectSpecular * (fresnel * 2.0);
          
          // Sun specular glint track across the waves (Call of Duty Mobile style sun glints)
          vec3 sunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
          vec3 halfVec = normalize(sunV + vDir);
          float NdotH = max(dot(normal, halfVec), 0.0);
          float sunGlint = pow(NdotH, 160.0) * 7.0 + pow(NdotH, 24.0) * 1.2;
          outgoingLight += uSunColor * (sunGlint * fresnel * 0.45);
          
          // Shoreline foam highlight
          outgoingLight += vec3(0.65, 0.75, 0.78) * clamp(wFoam, 0.0, 1.0);
          
          // Safe half-float clamping to prevent GPU bloom artifacts
          if (!(dot(outgoingLight, vec3(1.0)) < 20000.0)) outgoingLight = vec3(0.0);
          outgoingLight = clamp(outgoingLight, 0.0, 24.0);
        }
        #include <opaque_fragment>`);
  };

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.scale.set(x1 - x0, z1 - z0, 1);
  mesh.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
  mesh.renderOrder = 4;
  mesh.frustumCulled = false;
  mesh.name = 'water';

  return {
    mesh,
    update(dt) { uniforms.uTime.value = (uniforms.uTime.value + dt) % 4096; },
    dispose() {
      mesh.geometry.dispose(); material.dispose();
      normals.dispose(); depth.texture.dispose();
    },
  };
}
