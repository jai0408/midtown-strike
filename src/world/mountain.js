// Backdrop mountains: a cheap triplanar rock shader on the GLB's mountain material.
// Rock texture (taken from the terrain rock layer) projected along x / y / z, forest green on the low gentle
// slopes, snow on high up-facing ground, a little darker than the export. Fog supplies the distance haze.
import * as THREE from 'three';
import { getMaxAnisotropy } from './textures.js';

export async function applyMountainShader(mat, rockImageB64, sunDir = [-0.5003, 0.7204, 0.4803]) {
  let rock = null;
  try {
    const src = rockImageB64.startsWith('data:') ? rockImageB64 : 'data:image/png;base64,' + (rockImageB64.indexOf(',') >= 0 ? rockImageB64.slice(rockImageB64.indexOf(',') + 1) : rockImageB64);
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
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWN = normalize(mat3(modelMatrix) * normal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos;
        varying vec3 vWN;
        uniform sampler2D uRock;
        uniform vec3 uSunDir;
        float mhash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float mnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mhash(i), mhash(i + vec2(1.0, 0.0)), f.x), mix(mhash(i + vec2(0.0, 1.0)), mhash(i + vec2(1.0, 1.0)), f.x), f.y);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 n = normalize(vWN);
          vec3 w = pow(abs(n), vec3(4.0));
          w /= (w.x + w.y + w.z + 1e-4);
          // triplanar rock at two scales (the big one breaks the repetition)
          vec3 p = vWPos;
          vec3 r1 = texture2D(uRock, p.zy / 26.0).rgb * w.x + texture2D(uRock, p.xz / 26.0).rgb * w.y + texture2D(uRock, p.xy / 26.0).rgb * w.z;
          vec3 r2 = texture2D(uRock, p.zy / 140.0).rgb * w.x + texture2D(uRock, p.xz / 140.0).rgb * w.y + texture2D(uRock, p.xy / 140.0).rgb * w.z;
          vec3 rockC = r1 * r2 * 1.9 * vec3(0.92, 0.94, 1.0);
          float h = vWPos.y;
          float nz = mnoise(vWPos.xz * 0.02) * 0.6 + mnoise(vWPos.xz * 0.09) * 0.4;
          float up = n.y;
          // forest: low and not too steep, darker green with the rock showing through
          float forest = (1.0 - smoothstep(50.0 + nz * 50.0, 140.0 + nz * 70.0, h)) * smoothstep(0.45, 0.75, up);
          float grain = mnoise(vWPos.xz * 0.45) * 0.5 + mnoise(vWPos.xz * 1.7) * 0.5;   // tree-canopy mottling
          vec3 forestC = mix(vec3(0.03, 0.06, 0.03), vec3(0.075, 0.12, 0.05), nz) * (0.45 + 1.1 * grain) * (0.7 + 0.6 * r1.g);
          // snow: high, and only where the slope is gentle
          float snow = smoothstep(250.0 + nz * 90.0, 330.0 + nz * 90.0, h) * smoothstep(0.42, 0.7, up + (nz - 0.5) * 0.2);
          vec3 c = mix(rockC, forestC, forest);
          c = mix(c, vec3(0.78, 0.82, 0.88), snow);
          diffuseColor.rgb = c * 0.88;
        }`);
  };
  mat.vertexColors = true;
  mat.customProgramCacheKey = () => 'lodge-mountain';
  mat.needsUpdate = true;
  return mat;
}
