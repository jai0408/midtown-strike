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
 */
export function createWater(water, heightAt) {
  const { y, x0, z0, x1, z1 } = water;
  const normals = rippleNormals();
  const depth = depthMap(y, water, heightAt);
  const uniforms = {
    uTime: { value: 0 },
    uNormalMap: { value: normals },
    uDepthMap: { value: depth.texture },
    uRect: { value: depth.rect },
    uDeep: { value: new THREE.Color(0x041d2b) },
    uShallow: { value: new THREE.Color(0x2c6468) },
  };
  // roughness stays well above ~0.1: a mirror-sharp sun glint overflows half-float
  // targets on phones (NaN squares through bloom). The shader also clamps its output.
  const material = new THREE.MeshStandardMaterial({
    color: 0x0b3a4a, roughness: 0.3, metalness: 0, transparent: true, opacity: 0.95, depthWrite: false, envMapIntensity: 1.3,
  });
  material.customProgramCacheKey = () => 'lodge-water';
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
        uniform vec3 uDeep, uShallow;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 dUv = (vWPos.xz - uRect.xy) * uRect.zw;
        vec2 inside = step(vec2(0.0), dUv) * step(dUv, vec2(1.0));
        float depth = mix(1.0, texture2D(uDepthMap, clamp(dUv, 0.0, 1.0)).r, inside.x * inside.y);
        diffuseColor.rgb = mix(uShallow, uDeep, smoothstep(0.05, 0.8, depth));
        // soft shoreline: the surface fades out over the last ~0.6 m of depth
        diffuseColor.a *= smoothstep(0.0, 0.12, depth);
        float wFoam = smoothstep(0.0, 0.025, depth) * (1.0 - smoothstep(0.025, 0.1, depth));`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec2 p = vWPos.xz;
          vec3 n1 = texture2D(uNormalMap, p * 0.045 + uTime * vec2(0.010, 0.006)).xyz * 2.0 - 1.0;
          vec3 n2 = texture2D(uNormalMap, p * 0.13 + uTime * vec2(-0.012, 0.017)).xyz * 2.0 - 1.0;
          vec2 sl = (n1.xy + n2.xy) * mix(0.3, 0.65, smoothstep(0.0, 0.3, depth));
          vec3 wn = normalize(vec3(sl.x, 1.0, sl.y));
          normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
          wFoam *= 0.5 + 0.5 * n2.x + 0.3 * sin(uTime * 0.8 + p.x * 0.7 + p.y * 0.5);
        }`)
      .replace('#include <opaque_fragment>', `
        {
          // Fresnel: more of the sky at grazing angles, the deep colour looking down
          float fr = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 4.0);
          outgoingLight += reflectedLight.indirectSpecular * (fr * 1.2);
          outgoingLight += vec3(0.55 * clamp(wFoam, 0.0, 1.0));
          // no NaN / Inf / half-float overflow may leave this shader (a failed compare catches NaN too)
          if (!(dot(outgoingLight, vec3(1.0)) < 20000.0)) outgoingLight = vec3(0.0);
          outgoingLight = clamp(outgoingLight, 0.0, 16.0);
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
