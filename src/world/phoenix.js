// Mythical Phoenix soaring over Cedar Lodge (model: "phoenix_bird" by NORBERTO-3D, CC-BY-4.0).
// The asset is decimated and merged into ONE skinned mesh / one material (tools/blender/build_lodge_props.py).
// Look: the painted emissive map plus a procedural flame gradient (hotter towards wing / tail tips, soft
// rim glow) that is bright enough for bloom to catch, and a cheap additive ember trail (one Points draw).
// No point light by default (opts.light = true adds a small one).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PHOENIX_GLB } from './creatures_asset.js';

function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

const EMBERS = 56;

function makeEmberPoints() {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(EMBERS * 3);
  const age = new Float32Array(EMBERS).fill(1);   // 0..1 life fraction, >=1 = dead
  const size = new Float32Array(EMBERS);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aAge', new THREE.BufferAttribute(age, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uScale: { value: 520.0 } },
    vertexShader: `
      attribute float aAge; attribute float aSize;
      varying float vAge;
      uniform float uScale;
      void main() {
        vAge = clamp(aAge, 0.0, 1.0);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float z = max(-mv.z, 1.0);
        gl_PointSize = clamp(aSize * (1.0 - 0.6 * vAge) * uScale / z, 0.0, 20.0) * step(vAge, 0.999);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      precision mediump float;
      varying float vAge;
      void main() {
        vec2 c = gl_PointCoord - vec2(0.5);
        float d = clamp(length(c) * 2.0, 0.0, 1.0);
        float soft = (1.0 - d) * (1.0 - d);
        vec3 hot = vec3(1.0, 0.82, 0.30);
        vec3 cool = vec3(1.0, 0.25, 0.04);
        vec3 col = mix(hot, cool, clamp(vAge * 1.4, 0.0, 1.0));
        float a = soft * (1.0 - vAge) * 0.9;
        gl_FragColor = vec4(col * a * 1.6, a);
      }`,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 4;
  return { pts, geo, mat, pos, age, size };
}

/** Flame gradient + rim glow patched into the (standard) feather material. */
function patchFlame(mat) {
  mat.customProgramCacheKey = () => 'phoenix-flame-1';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    mat.userData.flameShader = shader;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vFlame;\nvarying float vTip;')
      .replace('#include <skinning_vertex>', `#include <skinning_vertex>
        {
          // object-space distance from the body centre (raw units: wing tip ~480, tail tip ~420)
          float rr = length(vec2(transformed.x, transformed.z * 0.8));
          vTip = clamp((rr - 60.0) / 380.0, 0.0, 1.0);
          vFlame = clamp(0.5 + transformed.y / 400.0, 0.0, 1.0);
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFlame;\nvarying float vTip;\nuniform float uTime;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float tip = clamp(vTip, 0.0, 1.0);
          float flick = 0.88 + 0.12 * sin(uTime * 7.0 + vTip * 14.0);
          vec3 ember = vec3(1.0, 0.28, 0.04);
          vec3 flame = vec3(1.0, 0.72, 0.18);
          vec3 heat = mix(ember, flame, smoothstep(0.15, 0.95, tip));
          float nv = clamp(abs(dot(normalize(normal), normalize(vViewPosition))), 0.0, 1.0);
          float rim = pow(1.0 - nv, 2.0);
          float lum = clamp(dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11)), 0.0, 1.0);
          float amt = (0.10 + 0.85 * tip * tip + 0.35 * rim) * (0.55 + 0.9 * lum);
          totalEmissiveRadiance += heat * amt * 0.78 * flick;
        }`);
  };
  mat.needsUpdate = true;
}

/**
 * Creates the animated flying Phoenix bird.
 * @param {{light?: boolean}} [opts]
 * @returns {{group: THREE.Group, update: Function, dispose: Function}}
 */
export function createPhoenix(opts = {}) {
  const group = new THREE.Group();
  group.name = 'phoenix_system';

  const phoenixGroup = new THREE.Group();
  phoenixGroup.name = 'phoenix_bird';
  group.add(phoenixGroup);

  // Inner wrapper orients model space (+X head, +Z up) to the flight frame (-Z forward, +Y up)
  const innerWrapper = new THREE.Group();
  innerWrapper.name = 'phoenix_inner';
  innerWrapper.quaternion.set(-0.5, 0.5, 0.5, 0.5);
  const SCALE = 0.0085;   // raw wingspan ~964 units -> ~8.2 m
  innerWrapper.scale.set(SCALE, SCALE, SCALE);
  phoenixGroup.add(innerWrapper);

  let fireLight = null;
  if (opts.light) {
    fireLight = new THREE.PointLight(0xff7a2a, 0.8, 18);
    phoenixGroup.add(fireLight);
  }

  const ember = makeEmberPoints();
  group.add(ember.pts);
  const emberVel = new Float32Array(EMBERS * 3);
  const emberLife = new Float32Array(EMBERS).fill(1);
  const emberT = new Float32Array(EMBERS);
  let emberHead = 0;
  let spawnAcc = 0;

  let mixer = null;
  let flameMat = null;
  let flightTime = 16.0;
  let prevYaw = 0.0;
  let currentBank = 0.0;
  const owned = [];

  const FLIGHT_PERIOD = 38.0;
  const pCurrent = new THREE.Vector3();
  const pAhead = new THREE.Vector3();
  const pTangent = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  function calcFlightPos(t, out) {
    const p = ((t % FLIGHT_PERIOD) / FLIGHT_PERIOD) * Math.PI * 2;
    const x = 46 * Math.sin(p) + 14 * Math.sin(2 * p);
    const z = -62 + 42 * Math.cos(p) - 12 * Math.sin(2 * p);
    const y = 44 + 8 * Math.sin(1.5 * p) + 3 * Math.cos(3 * p);
    out.set(x, y, z);
    return out;
  }

  try {
    new GLTFLoader().parse(decodeBase64(PHOENIX_GLB), '', (gltf) => {
      const model = gltf.scene;
      model.traverse((child) => {
        if (!child.isMesh && !child.isSkinnedMesh) return;
        child.castShadow = false;
        child.receiveShadow = false;
        child.frustumCulled = false;   // skinned bounds do not follow the flapping wings
        const m = child.material;
        m.emissiveIntensity = 1.0;
        m.roughness = 0.5;
        m.metalness = 0.0;
        m.side = THREE.DoubleSide;
        m.alphaTest = 0.4;
        patchFlame(m);
        flameMat = m;
        owned.push(child);
      });
      innerWrapper.add(model);
      if (gltf.animations && gltf.animations.length > 0) {
        mixer = new THREE.AnimationMixer(model);
        const action = mixer.clipAction(gltf.animations[0]);
        action.setEffectiveTimeScale(1.15);
        action.play();
      }
      calcFlightPos(flightTime, pCurrent);
      phoenixGroup.position.copy(pCurrent);
    }, (err) => console.warn('Failed to parse Phoenix GLB:', err));
  } catch (err) {
    console.warn('Phoenix loader initialization failed:', err);
  }

  const fwd = new THREE.Vector3();

  function spawnEmber(dt) {
    spawnAcc += dt * 16;
    while (spawnAcc >= 1) {
      spawnAcc -= 1;
      const i = emberHead;
      emberHead = (emberHead + 1) % EMBERS;
      // tail: behind the bird along its heading, with spread
      const spread = 1.6;
      ember.pos[i * 3] = pCurrent.x - fwd.x * 4.5 + (Math.random() - 0.5) * spread;
      ember.pos[i * 3 + 1] = pCurrent.y - fwd.y * 4.5 + (Math.random() - 0.5) * spread * 0.6;
      ember.pos[i * 3 + 2] = pCurrent.z - fwd.z * 4.5 + (Math.random() - 0.5) * spread;
      emberVel[i * 3] = -fwd.x * 1.2 + (Math.random() - 0.5) * 1.2;
      emberVel[i * 3 + 1] = 0.5 + Math.random() * 0.9;
      emberVel[i * 3 + 2] = -fwd.z * 1.2 + (Math.random() - 0.5) * 1.2;
      emberLife[i] = 1.8 + Math.random() * 1.8;
      emberT[i] = 0;
      ember.size[i] = 0.5 + Math.random() * 0.9;
    }
  }

  return {
    group,
    update(dt) {
      if (dt <= 0 || dt > 1.0) dt = 0.016;
      flightTime += dt;

      calcFlightPos(flightTime, pCurrent);
      calcFlightPos(flightTime + 0.12, pAhead);
      pTangent.subVectors(pAhead, pCurrent);
      phoenixGroup.position.copy(pCurrent);

      if (pTangent.lengthSq() > 0.0001) {
        const yaw = Math.atan2(-pTangent.x, -pTangent.z);
        const pitch = Math.atan2(pTangent.y, Math.hypot(pTangent.x, pTangent.z));
        let yawDelta = yaw - prevYaw;
        while (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
        while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
        prevYaw = yaw;
        const targetBank = THREE.MathUtils.clamp(-yawDelta * 8.5, -0.65, 0.65);
        currentBank = THREE.MathUtils.lerp(currentBank, targetBank, 0.12);
        phoenixGroup.rotation.set(pitch, yaw, 0, 'YXZ');
        innerWrapper.rotation.set(0, 0, currentBank);
        fwd.copy(pTangent).normalize();
      }

      if (mixer) mixer.update(dt);
      const sh = flameMat && flameMat.userData.flameShader;
      if (sh) sh.uniforms.uTime.value = flightTime % 600;
      if (fireLight) fireLight.intensity = 0.7 + 0.2 * Math.sin(flightTime * 4.0);

      // embers: world-space particles that drift up and fade
      spawnEmber(dt);
      for (let i = 0; i < EMBERS; i++) {
        if (emberLife[i] <= 0) { ember.age[i] = 1; continue; }
        emberT[i] += dt;
        const a = emberT[i] / emberLife[i];
        if (a >= 1) { emberLife[i] = 0; ember.age[i] = 1; continue; }
        const drag = Math.max(0, 1 - 0.8 * dt);
        emberVel[i * 3] *= drag; emberVel[i * 3 + 2] *= drag;
        emberVel[i * 3 + 1] += (0.25 - emberVel[i * 3 + 1] * 0.5) * dt;
        ember.pos[i * 3] += emberVel[i * 3] * dt;
        ember.pos[i * 3 + 1] += emberVel[i * 3 + 1] * dt;
        ember.pos[i * 3 + 2] += emberVel[i * 3 + 2] * dt;
        ember.age[i] = a;
      }
      ember.geo.attributes.position.needsUpdate = true;
      ember.geo.attributes.aAge.needsUpdate = true;
      ember.geo.attributes.aSize.needsUpdate = true;
    },
    dispose() {
      if (mixer) mixer.stopAllAction();
      ember.geo.dispose();
      ember.mat.dispose();
      const seen = new Set();
      for (const o of owned) {
        o.geometry.dispose();
        const m = o.material;
        if (seen.has(m)) continue;
        seen.add(m);
        for (const k of ['map', 'emissiveMap']) if (m[k]) m[k].dispose();
        m.dispose();
      }
    },
  };
}
