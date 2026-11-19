// Mythical Phoenix Bird soaring across the Cedar Lodge skies:
// Features complete animated skeletal mesh from phoenix_bird.glb,
// continuous wing flapping, dynamic 3D flight trajectory curving above the lake
// and mountain ridges, banking physics into turns, and a warm fiery glow.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { PHOENIX_GLB } from './creatures_asset.js';

function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Creates the animated flying Phoenix bird.
 * @param {object} [opts]
 * @returns {{group: THREE.Group, update: Function, dispose: Function}}
 */
export function createPhoenix(opts = {}) {
  const group = new THREE.Group();
  group.name = 'phoenix_system';

  const phoenixGroup = new THREE.Group();
  phoenixGroup.name = 'phoenix_bird';
  group.add(phoenixGroup);

  // Inner wrapper to orient local coordinate space (+X head, +Z up -> -Z forward, +Y up)
  const innerWrapper = new THREE.Group();
  innerWrapper.name = 'phoenix_inner';
  innerWrapper.quaternion.set(-0.5, 0.5, 0.5, 0.5);
  // Scale factor: raw wingspan is ~964 units -> scaled to ~11.5m wingspan
  const SCALE = 0.012;
  innerWrapper.scale.set(SCALE, SCALE, SCALE);
  phoenixGroup.add(innerWrapper);

  // Fiery ambient glow light attached to the phoenix
  const fireLight = new THREE.PointLight(0xff6611, 2.8, 55);
  fireLight.position.set(0, 0, 0);
  phoenixGroup.add(fireLight);

  let mixer = null;
  let action = null;
  let flightTime = 0.0;
  let prevYaw = 0.0;
  let currentBank = 0.0;

  // 36-second smooth looping 3D flight trajectory across Cedar Lodge
  const FLIGHT_PERIOD = 38.0;
  const pCurrent = new THREE.Vector3();
  const pAhead = new THREE.Vector3();
  const pTangent = new THREE.Vector3();

  function calcFlightPos(t, out) {
    const p = ((t % FLIGHT_PERIOD) / FLIGHT_PERIOD) * Math.PI * 2;
    // Sweeps over the mountain ridges (y ~ 38m), glides low over the lake (y ~ 22m, z ~ -95),
    // banks around the boathouse and dock, climbs over Cedar Lodge roof,
    // and curves gracefully over the south yard & Koi pond.
    const x = 50 * Math.sin(p) + 16 * Math.sin(2 * p);
    const z = -32 + 65 * Math.cos(p) - 18 * Math.sin(2 * p);
    const y = 30 + 9 * Math.sin(1.5 * p) + 3 * Math.cos(3 * p);
    out.set(x, y, z);
    return out;
  }

  // Load and parse PHOENIX_GLB
  try {
    const loader = new GLTFLoader();
    const buf = decodeBase64(PHOENIX_GLB);
    loader.parse(buf, '', (gltf) => {
      const model = skeletonClone(gltf.scene);

      // Enhance fiery feather materials with emissive warmth and shadow casting
      model.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
          if (child.material) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            for (const m of mats) {
              if (m.isMeshStandardMaterial || m.isMeshBasicMaterial) {
                m.emissive = new THREE.Color(0xff4400);
                m.emissiveIntensity = 0.65;
                m.roughness = 0.35;
                m.metalness = 0.15;
              }
            }
          }
        }
      });

      innerWrapper.add(model);

      // Animation mixer for wing flapping & tail undulation ('Take 001')
      if (gltf.animations && gltf.animations.length > 0) {
        mixer = new THREE.AnimationMixer(model);
        action = mixer.clipAction(gltf.animations[0]);
        action.setEffectiveTimeScale(1.15); // Majestic, graceful wing flaps
        action.play();
      }

      // Initial position
      calcFlightPos(flightTime, pCurrent);
      phoenixGroup.position.copy(pCurrent);
    }, (err) => {
      console.warn('Failed to parse Phoenix GLB:', err);
    });
  } catch (err) {
    console.warn('Phoenix loader initialization failed:', err);
  }

  return {
    group,
    update(dt) {
      if (dt <= 0 || dt > 1.0) dt = 0.016;
      flightTime += dt;

      // 1. Advance along 3D trajectory
      calcFlightPos(flightTime, pCurrent);
      calcFlightPos(flightTime + 0.12, pAhead);
      pTangent.subVectors(pAhead, pCurrent);

      phoenixGroup.position.copy(pCurrent);

      // 2. Heading / Pitch orientation along velocity vector
      if (pTangent.lengthSq() > 0.0001) {
        const yaw = Math.atan2(-pTangent.x, -pTangent.z);
        const pitch = Math.atan2(pTangent.y, Math.hypot(pTangent.x, pTangent.z));

        // Compute yaw turning rate for aerodynamic banking
        let yawDelta = yaw - prevYaw;
        while (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
        while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
        prevYaw = yaw;

        const targetBank = THREE.MathUtils.clamp(-yawDelta * 8.5, -0.65, 0.65);
        currentBank = THREE.MathUtils.lerp(currentBank, targetBank, 0.12);

        phoenixGroup.rotation.set(pitch, yaw, 0, 'YXZ');
        // Roll (banking) into turns
        innerWrapper.rotation.set(0, 0, currentBank);
      }

      // 3. Subtle pulsing of the mythical firelight
      fireLight.intensity = 2.4 + 0.6 * Math.sin(flightTime * 4.0);

      // 4. Update skeletal wing-flap animation
      if (mixer) {
        mixer.update(dt);
      }
    },
    dispose() {
      if (mixer) mixer.stopAllAction();
      fireLight.dispose();
      innerWrapper.traverse((obj) => {
        if (obj.isMesh) {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) {
            const m = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (const mat of m) mat.dispose();
          }
        }
      });
    },
  };
}
