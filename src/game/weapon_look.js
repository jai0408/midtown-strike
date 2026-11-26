// Tactical firearm shading & holographic optic overlay for procedural weapons.
// Brushed directional metal grain, stippled polymer micro-bump, uniform-flow bevel
// edge-wear catchlights (Mali/Adreno safe), grazing metallic sheen, and coated holo lens.
import * as THREE from 'three';

const NOISE_GLSL = /* glsl */`
  float wHash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float wNoise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(wHash(i), wHash(i + vec3(1.0, 0.0, 0.0)), f.x),
          mix(wHash(i + vec3(0.0, 1.0, 0.0)), wHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
      mix(mix(wHash(i + vec3(0.0, 0.0, 1.0)), wHash(i + vec3(1.0, 0.0, 1.0)), f.x),
          mix(wHash(i + vec3(0.0, 1.0, 1.0)), wHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
      f.z
    );
  }
  float wMicroFast(vec3 p, float isMetal) {
    return wNoise(mix(p * 460.0, vec3(p.x * 340.0, p.y * 340.0, p.z * 78.0), isMetal));
  }
  float wMicroHeight(vec3 p, float isMetal) {
    // Anisotropic brushed metal along barrel Z vs fine tactile polymer stipple
    vec3 q = mix(p * 460.0, vec3(p.x * 340.0, p.y * 340.0, p.z * 78.0), isMetal);
    return wNoise(q) * 0.65 + wNoise(q * 2.2) * 0.35;
  }
`;

/** Dedicated tactical weapon MeshStandardMaterial using per-vertex color + rm(rough, metal). */
export function createWeaponMaterial() {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1.0,
    metalness: 1.0,
    envMapIntensity: 1.65,
  });
  m.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 rm;
        varying vec2 vRm;
        varying vec3 vObj;
        varying vec3 vObjN;
        varying vec3 vMvX;
        varying vec3 vMvY;
        varying vec3 vMvZ;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vRm = rm;
        vObj = position;
        vObjN = normalize(objectNormal);
        mat3 mv3 = mat3(modelViewMatrix);
        vMvX = normalize(mv3[0]);
        vMvY = normalize(mv3[1]);
        vMvZ = normalize(mv3[2]);`);

    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vRm;
        varying vec3 vObj;
        varying vec3 vObjN;
        varying vec3 vMvX;
        varying vec3 vMvY;
        varying vec3 vMvZ;
        ${NOISE_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float wIsMetal = smoothstep(0.25, 0.70, vRm.y);
        float wGrain = wMicroHeight(vObj, wIsMetal);
        // Uniform-flow bevel curvature detector for subtle anodized edge wear (Mali-safe)
        float wEdge = clamp(length(fwidth(vObjN)) * 2.2, 0.0, 1.0);
        // Brushed/stippled surface albedo micro-variation
        diffuseColor.rgb *= 1.0 + (wGrain - 0.5) * mix(0.24, 0.18, wIsMetal);
        // Crisp worn-anodizing metallic edge catch on machined rails, bevels & optic shroud
        diffuseColor.rgb += mix(vec3(0.018, 0.018, 0.017), vec3(0.105, 0.112, 0.124), wIsMetal) * (wEdge * 0.85);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor *= vRm.x;
        // Micro-roughness breakup + glossier worn bevel edges; keep >= 0.14 for phone half-float safety
        roughnessFactor = clamp(
          roughnessFactor + (wGrain - 0.5) * mix(0.20, 0.16, wIsMetal) - wEdge * 0.24 * wIsMetal,
          0.14, 0.96
        );`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor *= vRm.y;
        metalnessFactor = clamp(metalnessFactor + wEdge * 0.15 * wIsMetal, 0.0, 1.0);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          // Subtle object-space micro-bump transformed into view space (1-octave fast gradient)
          float eps = 0.0009;
          float h0 = wMicroFast(vObj, wIsMetal);
          vec3 g = vec3(
            wMicroFast(vObj + vec3(eps, 0.0, 0.0), wIsMetal) - h0,
            wMicroFast(vObj + vec3(0.0, eps, 0.0), wIsMetal) - h0,
            wMicroFast(vObj + vec3(0.0, 0.0, eps), wIsMetal) - h0
          );
          vec3 gView = vMvX * g.x + vMvY * g.y + vMvZ * g.z;
          normal = normalize(normal + gView * mix(0.36, 0.20, wIsMetal));
        }`)
      .replace('#include <opaque_fragment>', `
        {
          // Subtle pow-free grazing anodized/oiled metal Fresnel sheen picking up sky & neon bounce
          float f1 = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
          float f2 = f1 * f1;
          float fres = f2 * f2;
          outgoingLight += reflectedLight.indirectSpecular * (fres * mix(0.22, 0.72, wIsMetal));
        }
        #include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => 'weapon-tactical-v2';
  return m;
}

let holoLensMat = null;
let holoReticleMat = null;
let holoLensGeo = null;
let holoReticleGeo = null;

function makeReticleTexture() {
  if (typeof document === 'undefined') return null;
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const cx = S / 2, cy = S / 2;
  g.clearRect(0, 0, S, S);

  // Soft outer crimson holographic bloom halo
  const grad = g.createRadialGradient(cx, cy, 1, cx, cy, S * 0.32);
  grad.addColorStop(0, 'rgba(255, 70, 50, 0.36)');
  grad.addColorStop(0.55, 'rgba(255, 40, 30, 0.12)');
  grad.addColorStop(1, 'rgba(255, 20, 20, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);

  // Crisp 65-MOA holographic ring + cardinal hash ticks
  g.strokeStyle = 'rgba(255, 55, 45, 0.92)';
  g.lineWidth = 2.6;
  const R = S * 0.22;
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.stroke();

  g.lineWidth = 2.6;
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    g.beginPath();
    g.moveTo(cx + ca * (R - 5), cy + sa * (R - 5));
    g.lineTo(cx + ca * (R + 6), cy + sa * (R + 6));
    g.stroke();
  }

  // Hot glowing center 1-MOA dot
  g.fillStyle = 'rgba(255, 195, 180, 1.0)';
  g.beginPath();
  g.arc(cx, cy, 2.6, 0, Math.PI * 2);
  g.fill();

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Attaches a subtle dielectric coated glass pane + glowing crimson holographic reticle
 * inside the open window of a holo-optic weapon mesh (e.g. M4).
 */
export function attachHoloOptic(weaponMesh, points) {
  if (!points || !points.sight) return;
  if (!holoLensGeo) {
    holoLensGeo = new THREE.PlaneGeometry(0.038, 0.035);
    holoReticleGeo = new THREE.PlaneGeometry(0.024, 0.024);
  }
  if (!holoLensMat) {
    holoLensMat = new THREE.MeshStandardMaterial({
      color: 0x3a94a8,
      emissive: 0x091e26,
      emissiveIntensity: 0.40,
      roughness: 0.10,
      metalness: 0.15,
      envMapIntensity: 2.2,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }
  if (!holoReticleMat) {
    holoReticleMat = new THREE.MeshBasicMaterial({
      map: makeReticleTexture(),
      color: 0xff3c2e,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
  }
  const [sx, sy, sz] = points.sight;
  const lens = new THREE.Mesh(holoLensGeo, holoLensMat);
  lens.position.set(sx, sy - 0.004, sz - 0.032);
  lens.renderOrder = 4;
  lens.castShadow = false;
  lens.frustumCulled = false;
  lens.visible = false;
  lens.userData.fpOnly = true;

  const ret = new THREE.Mesh(holoReticleGeo, holoReticleMat);
  ret.position.set(sx, sy - 0.003, sz - 0.035);
  ret.renderOrder = 5;
  ret.castShadow = false;
  ret.frustumCulled = false;
  ret.visible = false;
  ret.userData.fpOnly = true;

  weaponMesh.add(lens, ret);
}
