// School Buses for Cedar Lodge: builds two American School Buses placed between
// the lodges, using the game's compact vehicle asset, custom yellow paint, decals,
// roof flasher lights, and physics colliders.
import * as THREE from 'three';
import { decodeVehicle, vehicleMaterial } from './vehicle_material.js';
import { VEHICLE_ASSETS } from './vehicles_asset.js';
import { F_DEFAULT, S_METAL, S_GLASS } from '../core/physics.js';

const YELLOW = [0.96, 0.72, 0.08];   // School Bus Yellow
const BLACK = [0.12, 0.12, 0.14];    // Black trim / bumper
const WHITE = [1.0, 1.0, 1.0];

/** Creates a school bus mesh with proper vertex colors and attributes. */
function createBusGeometry() {
  const a = VEHICLE_ASSETS.bus;
  const m = decodeVehicle(a.mesh, a.meta);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(m.nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
  geo.setIndex(new THREE.BufferAttribute(m.idx, 1));

  const rm = new Float32Array(m.nv * 2);
  const col = new Float32Array(m.nv * 3);
  for (let i = 0; i < m.nv; i++) {
    rm[i * 2] = m.ao[i];
    rm[i * 2 + 1] = 0; // not burnt wreck
    const c = m.mask[i] === 1 ? YELLOW : m.mask[i] === 2 ? BLACK : WHITE;
    col[i * 3] = c[0];
    col[i * 3 + 1] = c[1];
    col[i * 3 + 2] = c[2];
  }
  geo.setAttribute('rm', new THREE.BufferAttribute(rm, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Builds school bus decals: 'SCHOOL BUS' signs, roof warning lights, black rub rails. */
function createBusDetails() {
  const group = new THREE.Group();
  group.name = 'bus_details';

  // 1. 'SCHOOL BUS' sign textures (front and rear header boxes)
  const makeSignCanvas = () => {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#111';
    g.fillRect(0, 0, 256, 64);
    g.fillStyle = '#f5b30c';
    g.font = 'bold 30px "Arial Black", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('SCHOOL BUS', 128, 34);
    return c;
  };

  const signTex = new THREE.CanvasTexture(makeSignCanvas());
  signTex.colorSpace = THREE.SRGBColorSpace;
  const signMat = new THREE.MeshBasicMaterial({ map: signTex, roughness: 0.9 });

  // Front sign above windshield (local: facing -Z)
  const frontSign = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.38), signMat);
  frontSign.position.set(0, 2.92, -5.92);
  frontSign.rotation.y = Math.PI;
  group.add(frontSign);

  // Rear sign (local: facing +Z)
  const rearSign = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.38), signMat);
  rearSign.position.set(0, 2.92, 5.92);
  group.add(rearSign);

  // 2. Red & Amber roof warning flashers (emissive)
  const flasherMatRed = new THREE.MeshStandardMaterial({
    color: 0xcc1111, emissive: 0xff2222, emissiveIntensity: 1.2, roughness: 0.2,
  });
  const flasherMatAmber = new THREE.MeshStandardMaterial({
    color: 0xdd7700, emissive: 0xff9900, emissiveIntensity: 1.2, roughness: 0.2,
  });
  const flasherGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.08, 8);

  const addFlasher = (mat, x, y, z, rotX = 0) => {
    const f = new THREE.Mesh(flasherGeo, mat);
    f.position.set(x, y, z);
    f.rotation.x = rotX;
    group.add(f);
  };

  // Front roof flashers
  addFlasher(flasherMatAmber, -1.05, 3.02, -5.93, Math.PI / 2);
  addFlasher(flasherMatRed, -0.75, 3.02, -5.93, Math.PI / 2);
  addFlasher(flasherMatRed, 0.75, 3.02, -5.93, Math.PI / 2);
  addFlasher(flasherMatAmber, 1.05, 3.02, -5.93, Math.PI / 2);

  // Rear roof flashers
  addFlasher(flasherMatAmber, -1.05, 3.02, 5.93, -Math.PI / 2);
  addFlasher(flasherMatRed, -0.75, 3.02, 5.93, -Math.PI / 2);
  addFlasher(flasherMatRed, 0.75, 3.02, 5.93, -Math.PI / 2);
  addFlasher(flasherMatAmber, 1.05, 3.02, 5.93, -Math.PI / 2);

  // 3. Black rub rails along both sides of the bus
  const railMat = new THREE.MeshStandardMaterial({ color: 0x18181c, roughness: 0.8, metalness: 0.3 });
  const railGeo = new THREE.BoxGeometry(0.04, 0.06, 11.2);
  for (const xSide of [-1.62, 1.62]) {
    const rail1 = new THREE.Mesh(railGeo, railMat);
    rail1.position.set(xSide, 0.92, 0);
    const rail2 = new THREE.Mesh(railGeo, railMat);
    rail2.position.set(xSide, 1.48, 0);
    group.add(rail1, rail2);
  }

  // 4. Headlights and taillights
  const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfffae0, emissiveIntensity: 1.5 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xaa1111, emissive: 0xff2222, emissiveIntensity: 0.8 });
  const lampGeo = new THREE.BoxGeometry(0.22, 0.16, 0.05);

  const h1 = new THREE.Mesh(lampGeo, headMat); h1.position.set(-1.18, 0.95, -5.98);
  const h2 = new THREE.Mesh(lampGeo, headMat); h2.position.set(1.18, 0.95, -5.98);
  const t1 = new THREE.Mesh(lampGeo, tailMat); t1.position.set(-1.22, 0.88, 5.98);
  const t2 = new THREE.Mesh(lampGeo, tailMat); t2.position.set(1.22, 0.88, 5.98);
  group.add(h1, h2, t1, t2);

  return group;
}

/** Adds segmented collision boxes along the yawed bus body. */
function addBusColliders(world, x, z, yaw, yBase) {
  const L = 12.0, W = 2.6, H = 3.16;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  // Three overlapping segments along the bus length for tight oriented bounding
  const segments = [-3.8, 0.0, 3.8];
  const halfSeg = 2.1, halfW = W / 2;
  const ex = Math.abs(c) * halfW + Math.abs(s) * halfSeg;
  const ez = Math.abs(s) * halfW + Math.abs(c) * halfSeg;

  for (const seg of segments) {
    // Local offset along Z (-Z forward, +Z back)
    const sx = x + s * seg;
    const sz = z + c * seg;
    world.addBox(sx - ex, yBase, sz - ez, sx + ex, yBase + H, sz + ez, F_DEFAULT, S_METAL);
  }
}

/**
 * Builds the two school buses between the lodges.
 * @param {(x:number, z:number)=>number} groundAt Terrain height function
 * @param {object} world Physics world for adding colliders
 */
export function buildSchoolBuses(groundAt, world) {
  const group = new THREE.Group();
  group.name = 'school_buses';

  const busGeo = createBusGeometry();
  const busMat = vehicleMaterial();
  const detailsGroup = createBusDetails();

  // Two strategic locations between the Main Lodge and the Cabin:
  const BUS_CONFIGS = [
    // Bus 1: Near the pathway between Main Lodge and Cabin
    { x: -24.0, z: 28.5, yaw: -0.35 },
    // Bus 2: Angled across the approach lane connecting the lodges to the parking area
    { x: -16.5, z: 36.5, yaw: 1.18 },
  ];

  for (let i = 0; i < BUS_CONFIGS.length; i++) {
    const { x, z, yaw } = BUS_CONFIGS[i];
    const y = groundAt(x, z);

    const busMesh = new THREE.Mesh(busGeo, busMat);
    busMesh.castShadow = true;
    busMesh.receiveShadow = true;
    busMesh.name = `school_bus_${i + 1}`;

    const busInstance = new THREE.Group();
    busInstance.position.set(x, y, z);
    busInstance.rotation.y = yaw;
    busInstance.add(busMesh, detailsGroup.clone());

    group.add(busInstance);

    // Register physics colliders
    if (world) {
      addBusColliders(world, x, z, yaw, y);
    }
  }

  return {
    group,
    dispose() {
      busGeo.dispose();
      busMat.dispose();
    },
  };
}
