// Authentic American School Buses for Cedar Lodge:
// Features complete Type-C school bus geometry (hood/cowl, split windshield,
// passenger window bays with pillar dividers, passenger entry bi-fold door,
// rear emergency exit door, triple black rub rails, heavy-duty bumpers,
// dual side mirrors on tubular brackets, red octagonal STOP sign blade,
// overhead 'SCHOOL BUS' sign headers with 8-way warning flashers,
// roof emergency hatches, and 6 heavy-duty wheels with rubber tires & steel rims).
import * as THREE from 'three';
import { F_DEFAULT, S_METAL } from '../core/physics.js';

/** Creates the shared 'SCHOOL BUS' header sign texture. */
function createSignTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#141416';
  g.fillRect(0, 0, 256, 64);
  g.fillStyle = '#f5b30c';
  g.font = 'bold 30px "Arial Black", "Impact", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('SCHOOL BUS', 128, 34);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Builds the shared PBR materials for the school bus. */
function createBusMaterials(signTex) {
  return {
    yellow: new THREE.MeshStandardMaterial({ color: 0xf5b30c, roughness: 0.32, metalness: 0.05 }),
    hoodBlack: new THREE.MeshStandardMaterial({ color: 0x1f1f22, roughness: 0.6, metalness: 0.1 }),
    blackTrim: new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.65, metalness: 0.2 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xd8dadd, roughness: 0.18, metalness: 0.88 }),
    glass: new THREE.MeshStandardMaterial({
      color: 0x1a2e3b, roughness: 0.08, metalness: 0.15, transparent: true, opacity: 0.82,
    }),
    tire: new THREE.MeshStandardMaterial({ color: 0x18181a, roughness: 0.9, metalness: 0.0 }),
    rim: new THREE.MeshStandardMaterial({ color: 0x4e5054, roughness: 0.35, metalness: 0.7 }),
    hub: new THREE.MeshStandardMaterial({ color: 0x111113, roughness: 0.5, metalness: 0.8 }),
    white: new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.4, metalness: 0.05 }),
    stopRed: new THREE.MeshStandardMaterial({ color: 0xd61818, roughness: 0.3, metalness: 0.1 }),
    redLight: new THREE.MeshStandardMaterial({
      color: 0xcc1111, emissive: 0xff2222, emissiveIntensity: 1.5, roughness: 0.2,
    }),
    amberLight: new THREE.MeshStandardMaterial({
      color: 0xdd7700, emissive: 0xff9900, emissiveIntensity: 1.5, roughness: 0.2,
    }),
    headlight: new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0xfffae0, emissiveIntensity: 2.0, roughness: 0.1,
    }),
    sign: new THREE.MeshBasicMaterial({ map: signTex }),
  };
}

/** Builds a detailed American School Bus model. */
function createSchoolBusModel(mats) {
  const bus = new THREE.Group();
  bus.name = 'school_bus_model';

  const addBox = (w, h, l, x, y, z, mat, rotX = 0, rotY = 0, rotZ = 0) => {
    const geo = new THREE.BoxGeometry(w, h, l);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    if (rotX || rotY || rotZ) mesh.rotation.set(rotX, rotY, rotZ);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    bus.add(mesh);
    return mesh;
  };

  const addCyl = (r, len, x, y, z, mat, rotX = 0, rotY = 0, rotZ = 0) => {
    const geo = new THREE.CylinderGeometry(r, r, len, 16);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    if (rotX || rotY || rotZ) mesh.rotation.set(rotX, rotY, rotZ);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    bus.add(mesh);
    return mesh;
  };

  // Coordinates:
  // -Z = Forward (hood, grille, headlights)
  // +Z = Rear (emergency exit door)
  // +X = Right side (passenger entry door)
  // -X = Left side (driver side, STOP sign)
  // +Y = Up

  const CABIN_L = 8.8, CABIN_W = 2.55, CABIN_H = 2.30;
  const CABIN_Z = 0.9;
  const CABIN_Y = 0.85 + CABIN_H / 2; // 2.00

  // 1. Main Passenger Cabin Body
  addBox(CABIN_W, CABIN_H, CABIN_L, 0, CABIN_Y, CABIN_Z, mats.yellow);

  // 2. Arched Roof Cap & Escape Hatches
  addBox(CABIN_W - 0.08, 0.28, CABIN_L, 0, CABIN_Y + CABIN_H / 2 + 0.12, CABIN_Z, mats.yellow);
  addBox(0.85, 0.08, 0.85, 0, CABIN_Y + CABIN_H / 2 + 0.28, CABIN_Z - 2.2, mats.white);
  addBox(0.85, 0.08, 0.85, 0, CABIN_Y + CABIN_H / 2 + 0.28, CABIN_Z + 2.2, mats.white);

  // 3. Front Engine Hood / Cowl (Type C)
  const HOOD_L = 2.4, HOOD_W = 1.95, HOOD_H = 1.25;
  const HOOD_Z = -CABIN_L / 2 + CABIN_Z - HOOD_L / 2; // -4.7
  const HOOD_Y = 0.85 + HOOD_H / 2; // 1.475
  addBox(HOOD_W, HOOD_H, HOOD_L, 0, HOOD_Y, HOOD_Z, mats.yellow);
  addBox(HOOD_W - 0.06, 0.16, HOOD_L * 0.9, 0, HOOD_Y + HOOD_H / 2 + 0.04, HOOD_Z + 0.1, mats.yellow, 0.05, 0, 0);
  addBox(0.75, 0.02, HOOD_L - 0.4, 0, HOOD_Y + HOOD_H / 2 + 0.13, HOOD_Z + 0.1, mats.hoodBlack);

  // 4. Radiator Grille & Chrome Surround
  addBox(1.50, 0.88, 0.10, 0, HOOD_Y - 0.08, HOOD_Z - HOOD_L / 2 - 0.02, mats.chrome);
  addBox(1.38, 0.78, 0.08, 0, HOOD_Y - 0.08, HOOD_Z - HOOD_L / 2 - 0.05, mats.blackTrim);
  for (let si = 0; si < 4; si++) {
    const slatY = (HOOD_Y - 0.08) - 0.28 + si * 0.18;
    addBox(1.36, 0.03, 0.10, 0, slatY, HOOD_Z - HOOD_L / 2 - 0.07, mats.chrome);
  }

  // 5. Headlights & Amber Turn Signals
  for (const sd of [-1, 1]) {
    addCyl(0.18, 0.12, sd * 0.82, HOOD_Y - 0.02, HOOD_Z - HOOD_L / 2 - 0.02, mats.chrome, Math.PI / 2, 0, 0);
    addCyl(0.15, 0.06, sd * 0.82, HOOD_Y - 0.02, HOOD_Z - HOOD_L / 2 - 0.07, mats.headlight, Math.PI / 2, 0, 0);
    addCyl(0.09, 0.08, sd * 0.82, HOOD_Y - 0.32, HOOD_Z - HOOD_L / 2 - 0.03, mats.amberLight, Math.PI / 2, 0, 0);
  }

  // 6. Windshield (Slanted split pane)
  const WS_Z = -CABIN_L / 2 + CABIN_Z + 0.04;
  const WS_Y = HOOD_Y + HOOD_H / 2 + 0.44;
  addBox(CABIN_W - 0.12, 0.92, 0.16, 0, WS_Y, WS_Z, mats.blackTrim, 0.10, 0, 0);
  addBox(CABIN_W - 0.26, 0.82, 0.18, 0, WS_Y, WS_Z - 0.02, mats.glass, 0.10, 0, 0);
  addBox(0.07, 0.86, 0.20, 0, WS_Y, WS_Z - 0.03, mats.blackTrim, 0.10, 0, 0);
  for (const sd of [-0.55, 0.55]) {
    addBox(0.50, 0.04, 0.03, sd, WS_Y - 0.25, WS_Z - 0.12, mats.blackTrim, 0.10, 0.2, 0);
  }

  // 7. Side Passenger Windows
  const WIN_L = CABIN_L - 1.2;
  const WIN_H = 0.82;
  const WIN_Y = CABIN_Y + 0.32;

  // Left side (driver side)
  addBox(0.05, WIN_H + 0.08, WIN_L, -CABIN_W / 2 - 0.01, WIN_Y, CABIN_Z, mats.blackTrim);
  addBox(0.07, WIN_H, WIN_L - 0.1, -CABIN_W / 2 - 0.01, WIN_Y, CABIN_Z, mats.glass);
  for (let wi = 0; wi < 8; wi++) {
    const pz = CABIN_Z - WIN_L / 2 + wi * (WIN_L / 7);
    addBox(0.09, WIN_H + 0.06, 0.07, -CABIN_W / 2 - 0.01, WIN_Y, pz, mats.blackTrim);
  }

  // Right side (passenger entry door + window bays)
  const DOOR_W = 0.95;
  const DOOR_Z = CABIN_Z - CABIN_L / 2 + 0.70;
  const DOOR_Y = CABIN_Y - 0.22;
  addBox(0.06, 1.85, DOOR_W, CABIN_W / 2 + 0.01, DOOR_Y, DOOR_Z, mats.blackTrim);
  addBox(0.08, 0.72, 0.38, CABIN_W / 2 + 0.01, DOOR_Y + 0.42, DOOR_Z - 0.22, mats.glass);
  addBox(0.08, 0.72, 0.38, CABIN_W / 2 + 0.01, DOOR_Y + 0.42, DOOR_Z + 0.22, mats.glass);
  addBox(0.08, 0.48, 0.38, CABIN_W / 2 + 0.01, DOOR_Y - 0.40, DOOR_Z - 0.22, mats.glass);
  addBox(0.08, 0.48, 0.38, CABIN_W / 2 + 0.01, DOOR_Y - 0.40, DOOR_Z + 0.22, mats.glass);

  const WIN_R_L = WIN_L - DOOR_W - 0.3;
  const WIN_R_Z = CABIN_Z + (DOOR_W / 2);
  addBox(0.05, WIN_H + 0.08, WIN_R_L, CABIN_W / 2 + 0.01, WIN_Y, WIN_R_Z, mats.blackTrim);
  addBox(0.07, WIN_H, WIN_R_L - 0.1, CABIN_W / 2 + 0.01, WIN_Y, WIN_R_Z, mats.glass);
  for (let wi = 0; wi < 7; wi++) {
    const pz = WIN_R_Z - WIN_R_L / 2 + wi * (WIN_R_L / 6);
    addBox(0.09, WIN_H + 0.06, 0.07, CABIN_W / 2 + 0.01, WIN_Y, pz, mats.blackTrim);
  }

  // 8. Rear Emergency Exit Door & Windows
  const REAR_Z = CABIN_Z + CABIN_L / 2 + 0.01;
  addBox(0.95, 1.85, 0.04, 0, CABIN_Y - 0.15, REAR_Z, mats.yellow);
  addBox(1.02, 1.90, 0.05, 0, CABIN_Y - 0.15, REAR_Z - 0.01, mats.blackTrim);
  addBox(0.74, 0.65, 0.06, 0, CABIN_Y + 0.42, REAR_Z, mats.glass);
  addBox(0.55, 0.48, 0.06, 0, CABIN_Y - 0.38, REAR_Z, mats.glass);
  for (const sd of [-1, 1]) {
    addBox(0.50, 0.65, 0.05, sd * 0.95, CABIN_Y + 0.42, REAR_Z, mats.glass);
  }

  // 9. Triple Black Rub Rails
  for (const sd of [-1, 1]) {
    const rx = sd * (CABIN_W / 2 + 0.02);
    addBox(0.04, 0.08, CABIN_L + 0.05, rx, CABIN_Y - 0.88, CABIN_Z, mats.blackTrim);
    addBox(0.04, 0.08, CABIN_L + 0.05, rx, CABIN_Y - 0.42, CABIN_Z, mats.blackTrim);
    addBox(0.04, 0.08, CABIN_L + 0.05, rx, CABIN_Y - 0.10, CABIN_Z, mats.blackTrim);
  }

  // 10. Heavy-Duty Bumpers
  addBox(HOOD_W + 0.40, 0.38, 0.32, 0, 0.60, HOOD_Z - HOOD_L / 2 - 0.16, mats.blackTrim);
  addBox(CABIN_W + 0.15, 0.40, 0.34, 0, 0.60, REAR_Z + 0.16, mats.blackTrim);
  addBox(1.20, 0.08, 0.04, 0.2, 0.60, HOOD_Z - HOOD_L / 2 - 0.34, mats.yellow); // Crossing arm

  // 11. Large American Side-View Mirrors
  for (const sd of [-1, 1]) {
    const mx = sd * (CABIN_W / 2 + 0.32);
    const mz = HOOD_Z + HOOD_L * 0.25;
    const my = WS_Y - 0.10;
    addBox(0.35, 0.04, 0.04, mx - sd * 0.16, my + 0.35, mz, mats.blackTrim);
    addBox(0.35, 0.04, 0.04, mx - sd * 0.16, my - 0.35, mz, mats.blackTrim);
    addBox(0.08, 0.45, 0.18, mx, my + 0.15, mz, mats.blackTrim);
    addBox(0.09, 0.42, 0.16, mx - sd * 0.01, my + 0.15, mz + 0.01, mats.chrome);
    addCyl(0.11, 0.06, mx, my - 0.22, mz, mats.chrome, Math.PI / 2, 0, 0);
  }

  // 12. Red Octagonal STOP Sign on Driver Side
  const STOP_X = -CABIN_W / 2 - 0.09;
  const STOP_Z = CABIN_Z - CABIN_L / 2 + 1.3;
  const STOP_Y = CABIN_Y - 0.15;
  addBox(0.08, 0.45, 0.06, STOP_X + 0.04, STOP_Y, STOP_Z, mats.blackTrim);
  addCyl(0.30, 0.03, STOP_X, STOP_Y, STOP_Z, mats.stopRed, 0, 0, Math.PI / 2);
  addBox(0.04, 0.14, 0.38, STOP_X, STOP_Y, STOP_Z, mats.white);

  // 13. Overhead "SCHOOL BUS" Headers & Warning Flashers
  for (const isFront of [true, false]) {
    const hz = isFront ? (WS_Z - 0.08) : (REAR_Z + 0.02);
    const hy = CABIN_Y + CABIN_H / 2 + 0.06;
    addBox(1.85, 0.32, 0.10, 0, hy, hz, mats.blackTrim);

    // Header sign plane
    const signPlane = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.22), mats.sign);
    signPlane.position.set(0, hy, hz + (isFront ? -0.06 : 0.06));
    if (isFront) signPlane.rotation.y = Math.PI;
    bus.add(signPlane);

    // Dual amber and red warning flashers
    for (const lSide of [-1, 1]) {
      addCyl(0.10, 0.08, lSide * 0.72, hy, hz, mats.amberLight, Math.PI / 2, 0, 0);
      addCyl(0.10, 0.08, lSide * 1.02, hy, hz, mats.redLight, Math.PI / 2, 0, 0);
    }
  }

  // Roof clearance marker lights
  for (const rx of [-1.1, -0.2, 0.0, 0.2, 1.1]) {
    addCyl(0.03, 0.04, rx, CABIN_Y + CABIN_H / 2 + 0.25, WS_Z + 0.05, mats.amberLight, Math.PI / 2, 0, 0);
  }

  // 14. Wheels & Tires
  const TIRE_R = 0.52;
  const TIRE_W = 0.30;

  // Front steer axle
  const FRONT_AXLE_Z = HOOD_Z + 0.25;
  for (const sd of [-1, 1]) {
    const wx = sd * (CABIN_W / 2 - 0.14);
    addCyl(TIRE_R, TIRE_W, wx, TIRE_R, FRONT_AXLE_Z, mats.tire, 0, 0, Math.PI / 2);
    addCyl(TIRE_R * 0.65, TIRE_W + 0.02, wx, TIRE_R, FRONT_AXLE_Z, mats.rim, 0, 0, Math.PI / 2);
    addCyl(TIRE_R * 0.22, TIRE_W + 0.05, wx + sd * 0.02, TIRE_R, FRONT_AXLE_Z, mats.hub, 0, 0, Math.PI / 2);
    addBox(0.08, 0.65, 1.35, sd * (CABIN_W / 2 + 0.01), TIRE_R + 0.20, FRONT_AXLE_Z, mats.blackTrim);
  }

  // Rear dual drive axle
  const REAR_AXLE_Z = CABIN_Z + CABIN_L / 2 - 1.85;
  for (const sd of [-1, 1]) {
    const wxOut = sd * (CABIN_W / 2 - 0.12);
    const wxIn = sd * (CABIN_W / 2 - 0.44);
    addCyl(TIRE_R, TIRE_W, wxOut, TIRE_R, REAR_AXLE_Z, mats.tire, 0, 0, Math.PI / 2);
    addCyl(TIRE_R, TIRE_W, wxIn, TIRE_R, REAR_AXLE_Z, mats.tire, 0, 0, Math.PI / 2);
    addCyl(TIRE_R * 0.65, TIRE_W * 2.1, (wxOut + wxIn) / 2, TIRE_R, REAR_AXLE_Z, mats.rim, 0, 0, Math.PI / 2);
    addCyl(TIRE_R * 0.22, TIRE_W * 2.15, wxOut + sd * 0.02, TIRE_R, REAR_AXLE_Z, mats.hub, 0, 0, Math.PI / 2);
    addBox(0.08, 0.65, 1.45, sd * (CABIN_W / 2 + 0.01), TIRE_R + 0.20, REAR_AXLE_Z, mats.blackTrim);
    addBox(0.34, 0.42, 0.04, wxOut - sd * 0.08, TIRE_R - 0.15, REAR_AXLE_Z + 0.85, mats.blackTrim);
  }

  // Undercarriage frame, battery box & chrome exhaust tip
  addBox(CABIN_W - 0.7, 0.22, CABIN_L + 1.0, 0, 0.68, CABIN_Z - 0.3, mats.blackTrim);
  addBox(0.35, 0.35, 0.8, -CABIN_W / 2 + 0.2, 0.55, CABIN_Z - 0.8, mats.blackTrim);
  addCyl(0.06, 0.30, -CABIN_W / 2 + 0.25, 0.45, REAR_AXLE_Z + 1.4, mats.chrome, Math.PI / 2, 0, 0);

  return bus;
}

/** Adds segmented collision boxes along the yawed bus body. */
function addBusColliders(world, x, z, yaw, yBase) {
  const W = 2.6, H = 3.2;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  // Three tight bounding segments along the bus body
  const segments = [-3.6, 0.0, 3.6];
  const halfSeg = 2.0, halfW = W / 2;
  const ex = Math.abs(c) * halfW + Math.abs(s) * halfSeg;
  const ez = Math.abs(s) * halfW + Math.abs(c) * halfSeg;

  for (const seg of segments) {
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

  const signTex = createSignTexture();
  const mats = createBusMaterials(signTex);

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

    const busModel = createSchoolBusModel(mats);
    busModel.position.set(x, y, z);
    busModel.rotation.y = yaw;
    busModel.name = `school_bus_${i + 1}`;

    group.add(busModel);

    // Register physics colliders
    if (world) {
      addBusColliders(world, x, z, yaw, y);
    }
  }

  return {
    group,
    dispose() {
      signTex.dispose();
      for (const key of Object.keys(mats)) {
        if (mats[key].dispose) mats[key].dispose();
      }
    },
  };
}
