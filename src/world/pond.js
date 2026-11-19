// Uneven natural Koi Pond left side of Cedar Lodge south yard:
// ~8m diameter, 5ft depth, river stone coping, crystal clear water with ripples,
// lily pads, and 10 colorful Japanese Koi fish with realistic swimming physics.
import * as THREE from 'three';
import { F_DEFAULT, S_CONCRETE, S_DIRT } from '../core/physics.js';

/** Uneven, natural, organic perimeter radius function (averaging ~4m radius, 8m diameter). */
export function pondRadius(th) {
  return 3.9 + 0.58 * Math.sin(2 * th + 0.5) + 0.35 * Math.cos(3 * th - 0.7) + 0.22 * Math.sin(5 * th + 1.1) + 0.15 * Math.cos(7 * th);
}

// 10 Distinct Japanese Koi Color Schemes (RGB floats)
const KOI_SPECIES = [
  // 1. Kohaku: Pure white with fire-red patches
  { name: 'Kohaku', base: [0.98, 0.98, 0.96], pat: [0.92, 0.22, 0.06], dark: [0.92, 0.22, 0.06], style: 'patch' },
  // 2. Taisho Sanke: White with red patches & black sumi spots
  { name: 'Taisho Sanke', base: [0.97, 0.97, 0.95], pat: [0.90, 0.20, 0.05], dark: [0.10, 0.10, 0.12], style: 'tri' },
  // 3. Showa Sanshoku: Black base with bold red & white patterns
  { name: 'Showa', base: [0.12, 0.12, 0.14], pat: [0.88, 0.18, 0.05], dark: [0.95, 0.95, 0.92], style: 'swirl' },
  // 4. Yamabuki Ogon: Metallic golden yellow
  { name: 'Yamabuki Ogon', base: [0.98, 0.78, 0.08], pat: [1.0, 0.88, 0.20], dark: [0.82, 0.62, 0.05], style: 'solid' },
  // 5. Shiro Utsuri: Jet black with white lightning patches
  { name: 'Shiro Utsuri', base: [0.10, 0.10, 0.12], pat: [0.96, 0.96, 0.96], dark: [0.10, 0.10, 0.12], style: 'stripe' },
  // 6. Tancho: Snowy white with iconic crimson-red round crest on head
  { name: 'Tancho', base: [0.98, 0.98, 0.98], pat: [0.92, 0.12, 0.05], dark: [0.98, 0.98, 0.98], style: 'tancho' },
  // 7. Asagi: Slate blue-grey scaled back with fiery orange-red belly & fins
  { name: 'Asagi', base: [0.32, 0.40, 0.48], pat: [0.94, 0.35, 0.08], dark: [0.22, 0.28, 0.35], style: 'asagi' },
  // 8. Ki Utsuri: Jet black with bright golden-yellow markings
  { name: 'Ki Utsuri', base: [0.11, 0.11, 0.12], pat: [0.94, 0.74, 0.05], dark: [0.11, 0.11, 0.12], style: 'stripe' },
  // 9. Beni Kumonryu: Pearl white with flowing black & scarlet patterns
  { name: 'Beni Kumonryu', base: [0.96, 0.96, 0.95], pat: [0.88, 0.16, 0.06], dark: [0.15, 0.15, 0.18], style: 'tri' },
  // 10. Kin Matsuba: Shimmering bronze-gold with dark scale reticulation
  { name: 'Kin Matsuba', base: [0.82, 0.58, 0.18], pat: [0.96, 0.72, 0.24], dark: [0.28, 0.18, 0.08], style: 'scale' },
];

/** Builds an individual 3D Koi Fish geometry with vertex colors for the species. */
function buildKoiMesh(species, scale = 1.0) {
  // 7 longitudinal cross-sections along fish length (Z = -0.35 to +0.35 m):
  // z: front/snout to rear/tail tip; w: half-width; h: half-height; yOff: spine curve
  const sections = [
    { z: -0.34, w: 0.02, h: 0.015, y: 0.00 }, // mouth / snout
    { z: -0.25, w: 0.07, h: 0.055, y: 0.01 }, // head / gills
    { z: -0.12, w: 0.10, h: 0.085, y: 0.02 }, // shoulder / dorsal start
    { z:  0.04, w: 0.09, h: 0.075, y: 0.01 }, // mid-body
    { z:  0.18, w: 0.05, h: 0.045, y: 0.00 }, // peduncle start
    { z:  0.28, w: 0.02, h: 0.020, y: -0.01 }, // caudal peduncle
    { z:  0.42, w: 0.005, h: 0.080, y: -0.01 }, // flared tail fin
  ];

  const verts = [], norms = [], colors = [], uvs = [], idxs = [];
  const C_BASE = species.base, C_PAT = species.pat, C_DARK = species.dark;

  // Generate 8 radial vertices per cross section
  const RAD_SEGS = 8;
  for (let s = 0; s < sections.length; s++) {
    const sec = sections[s];
    const isTail = s === sections.length - 1;
    for (let r = 0; r < RAD_SEGS; r++) {
      const a = (r / RAD_SEGS) * Math.PI * 2;
      const vx = Math.sin(a) * sec.w * scale;
      const vy = (Math.cos(a) * sec.h + sec.y) * scale;
      const vz = sec.z * scale;

      verts.push(vx, vy, vz);

      // Normal
      const nx = Math.sin(a);
      const ny = Math.cos(a);
      const nz = s === 0 ? -0.7 : s === sections.length - 1 ? 0.7 : 0.0;
      const nl = Math.hypot(nx, ny, nz) || 1;
      norms.push(nx / nl, ny / nl, nz / nl);

      // UV
      uvs.push(r / RAD_SEGS, s / (sections.length - 1));

      // Color pattern determination based on position & species style
      let col = C_BASE;
      const isTop = Math.cos(a) > -0.1;
      const normZ = (sec.z + 0.35) / 0.7; // 0 = head, 1 = tail

      if (species.style === 'solid') {
        col = (isTop && Math.sin(normZ * 20) > 0.3) ? C_PAT : C_BASE;
      } else if (species.style === 'tancho') {
        // Red crest only on top of the head
        if (normZ < 0.26 && isTop && Math.abs(vx) < 0.05 * scale) col = C_PAT;
        else col = C_BASE;
      } else if (species.style === 'patch') {
        const p1 = normZ > 0.12 && normZ < 0.38 && isTop;
        const p2 = normZ > 0.52 && normZ < 0.74 && (isTop || Math.sin(a) > 0.2);
        col = (p1 || p2) ? C_PAT : C_BASE;
      } else if (species.style === 'tri') {
        const p1 = normZ > 0.15 && normZ < 0.42 && isTop;
        const p2 = normZ > 0.58 && normZ < 0.82 && isTop;
        const sumi = (Math.sin(normZ * 14.0 + a * 2.0) > 0.55) && isTop && normZ > 0.3;
        col = sumi ? C_DARK : (p1 || p2) ? C_PAT : C_BASE;
      } else if (species.style === 'swirl') {
        const redP = Math.sin(normZ * 10.0 + a) > 0.3;
        const whiteP = Math.cos(normZ * 8.0 - a) > 0.45;
        col = redP ? C_PAT : whiteP ? C_DARK : C_BASE;
      } else if (species.style === 'stripe') {
        const str = Math.sin(normZ * 12.0) > 0.1;
        col = str ? C_PAT : C_BASE;
      } else if (species.style === 'asagi') {
        if (!isTop || vy < -0.01) col = C_PAT; // orange belly & flanks
        else col = (Math.sin(normZ * 25.0) > 0) ? C_BASE : C_DARK; // scaled blue back
      } else {
        col = (isTop && Math.sin(normZ * 16.0) > 0.2) ? C_PAT : C_BASE;
      }

      // Slightly translucent fins / tail
      if (isTail) col = [col[0] * 0.95 + 0.05, col[1] * 0.95 + 0.05, col[2] * 0.95 + 0.05];

      colors.push(col[0], col[1], col[2]);
    }
  }

  // Indices linking radial rings
  for (let s = 0; s < sections.length - 1; s++) {
    const o1 = s * RAD_SEGS;
    const o2 = (s + 1) * RAD_SEGS;
    for (let r = 0; r < RAD_SEGS; r++) {
      const rNext = (r + 1) % RAD_SEGS;
      idxs.push(o1 + r, o2 + r, o2 + rNext);
      idxs.push(o1 + r, o2 + rNext, o1 + rNext);
    }
  }

  // Pectoral fins (paired angled quads)
  const addFin = (xSide) => {
    const bIdx = verts.length / 3;
    const fx = xSide * 0.06 * scale;
    const fy = -0.02 * scale;
    const fz = -0.15 * scale;
    const tipX = xSide * 0.14 * scale;
    const tipY = -0.05 * scale;
    const tipZ = -0.06 * scale;

    verts.push(fx, fy, fz, fx, fy + 0.01, fz + 0.05 * scale, tipX, tipY, tipZ);
    norms.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
    uvs.push(0, 0, 1, 0, 0.5, 1);
    const fc = species.pat;
    colors.push(fc[0], fc[1], fc[2], fc[0], fc[1], fc[2], fc[0], fc[1], fc[2]);
    idxs.push(bIdx, bIdx + 1, bIdx + 2);
    idxs.push(bIdx, bIdx + 2, bIdx + 1); // double sided
  };
  addFin(1);
  addFin(-1);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idxs);
  return geo;
}

/**
 * Creates the natural uneven Koi Pond with 10 animated colorful Koi fish.
 * @param {{x:number, z:number, groundAt:Function, world?:object}} opts
 */
export function createKoiPond({ x: cx = -18.5, z: cz = 20.0, groundAt, world }) {
  const group = new THREE.Group();
  group.name = 'koi_pond';

  const baseGroundY = groundAt(cx, cz);
  const DEPTH = 1.52; // ~5 feet deep
  const WATER_Y = baseGroundY - 0.06;
  const SEGS = 36;

  // -------------------------------------------------------------------------
  // 1. Natural Uneven Basin Geometry
  // -------------------------------------------------------------------------
  const basinVerts = [], basinNorms = [], basinColors = [], basinIdxs = [];
  const gravelCol = [0.18, 0.22, 0.19];
  const shelfCol = [0.24, 0.28, 0.22];
  const rimCol = [0.38, 0.44, 0.32];

  // Ring 0: Center bottom
  basinVerts.push(0, -DEPTH, 0);
  basinNorms.push(0, 1, 0);
  basinColors.push(gravelCol[0], gravelCol[1], gravelCol[2]);

  // Ring 1: Deep floor perimeter (radius 0.45 * R)
  for (let i = 0; i < SEGS; i++) {
    const th = (i / SEGS) * Math.PI * 2;
    const r = pondRadius(th) * 0.45;
    basinVerts.push(Math.sin(th) * r, -DEPTH + 0.05 * Math.sin(th * 3), Math.cos(th) * r);
    basinNorms.push(0, 1, 0);
    basinColors.push(gravelCol[0] * 1.05, gravelCol[1] * 1.05, gravelCol[2] * 1.05);
  }

  // Ring 2: Underwater shelf (radius 0.78 * R, depth -0.55m)
  for (let i = 0; i < SEGS; i++) {
    const th = (i / SEGS) * Math.PI * 2;
    const r = pondRadius(th) * 0.78;
    basinVerts.push(Math.sin(th) * r, -0.55 + 0.08 * Math.cos(th * 2), Math.cos(th) * r);
    basinNorms.push(-Math.sin(th) * 0.4, 0.8, -Math.cos(th) * 0.4);
    basinColors.push(shelfCol[0], shelfCol[1], shelfCol[2]);
  }

  // Ring 3: Outer pond rim (radius 1.0 * R, depth +0.06m)
  for (let i = 0; i < SEGS; i++) {
    const th = (i / SEGS) * Math.PI * 2;
    const r = pondRadius(th);
    const wy = (groundAt(cx + Math.sin(th) * r, cz + Math.cos(th) * r) - baseGroundY) + 0.06;
    basinVerts.push(Math.sin(th) * r, wy, Math.cos(th) * r);
    basinNorms.push(-Math.sin(th) * 0.7, 0.7, -Math.cos(th) * 0.7);
    basinColors.push(rimCol[0], rimCol[1], rimCol[2]);
  }

  // Indices for basin
  // Center fan to Ring 1
  for (let i = 0; i < SEGS; i++) {
    const next = (i + 1) % SEGS;
    basinIdxs.push(0, 1 + i, 1 + next);
  }
  // Ring 1 to Ring 2
  for (let i = 0; i < SEGS; i++) {
    const next = (i + 1) % SEGS;
    const r1a = 1 + i, r1b = 1 + next;
    const r2a = 1 + SEGS + i, r2b = 1 + SEGS + next;
    basinIdxs.push(r1a, r2a, r2b);
    basinIdxs.push(r1a, r2b, r1b);
  }
  // Ring 2 to Ring 3
  for (let i = 0; i < SEGS; i++) {
    const next = (i + 1) % SEGS;
    const r2a = 1 + SEGS + i, r2b = 1 + SEGS + next;
    const r3a = 1 + SEGS * 2 + i, r3b = 1 + SEGS * 2 + next;
    basinIdxs.push(r2a, r3a, r3b);
    basinIdxs.push(r2a, r3b, r2b);
  }

  const basinGeo = new THREE.BufferGeometry();
  basinGeo.setAttribute('position', new THREE.Float32BufferAttribute(basinVerts, 3));
  basinGeo.setAttribute('normal', new THREE.Float32BufferAttribute(basinNorms, 3));
  basinGeo.setAttribute('color', new THREE.Float32BufferAttribute(basinColors, 3));
  basinGeo.setIndex(basinIdxs);

  const basinMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.88, metalness: 0.05,
  });
  const basinMesh = new THREE.Mesh(basinGeo, basinMat);
  basinMesh.position.set(cx, baseGroundY, cz);
  basinMesh.receiveShadow = true;
  group.add(basinMesh);

  // -------------------------------------------------------------------------
  // 2. Perimeter Rock Coping (Natural Uneven River Stones)
  // -------------------------------------------------------------------------
  const stoneMat = new THREE.MeshStandardMaterial({
    color: 0x686c62, roughness: 0.85, metalness: 0.1,
  });
  const mossMat = new THREE.MeshStandardMaterial({
    color: 0x4e6b36, roughness: 0.92, metalness: 0.0,
  });

  const ROCKS = 32;
  const rockGeos = [
    new THREE.DodecahedronGeometry(0.38, 1),
    new THREE.DodecahedronGeometry(0.46, 1),
    new THREE.DodecahedronGeometry(0.55, 1),
  ];

  for (let i = 0; i < ROCKS; i++) {
    const th = (i / ROCKS) * Math.PI * 2 + (Math.sin(i * 3.7) * 0.06);
    const r = pondRadius(th) + 0.12 + 0.15 * Math.sin(i * 5.3);
    const rx = cx + Math.sin(th) * r;
    const rz = cz + Math.cos(th) * r;
    const ry = groundAt(rx, rz) + 0.08;

    const gIdx = i % rockGeos.length;
    const rockMesh = new THREE.Mesh(rockGeos[gIdx], i % 3 === 0 ? mossMat : stoneMat);
    const scale = 0.85 + 0.35 * Math.sin(i * 4.2);
    rockMesh.scale.set(scale * (0.9 + 0.2 * Math.cos(i)), scale * 0.75, scale * (0.9 + 0.2 * Math.sin(i)));
    rockMesh.position.set(rx, ry, rz);
    rockMesh.rotation.set(Math.sin(i * 1.5) * 0.3, th + Math.PI / 2, Math.cos(i * 2.1) * 0.3);
    rockMesh.castShadow = true;
    rockMesh.receiveShadow = true;
    group.add(rockMesh);

    // Add perimeter collision boxes
    if (world && i % 2 === 0) {
      world.addBox(rx - 0.4, ry - 0.2, rz - 0.4, rx + 0.4, ry + 0.6, rz + 0.4, F_DEFAULT, S_CONCRETE);
    }
  }

  // -------------------------------------------------------------------------
  // 3. Crystal Clear Koi Pond Water Surface
  // -------------------------------------------------------------------------
  const waterVerts = [0, 0, 0], waterNorms = [0, 1, 0], waterUvs = [0.5, 0.5], waterIdxs = [];
  for (let i = 0; i < SEGS; i++) {
    const th = (i / SEGS) * Math.PI * 2;
    const r = pondRadius(th);
    waterVerts.push(Math.sin(th) * r, 0, Math.cos(th) * r);
    waterNorms.push(0, 1, 0);
    waterUvs.push(Math.sin(th) * 0.5 + 0.5, Math.cos(th) * 0.5 + 0.5);
    const next = (i + 1) % SEGS;
    waterIdxs.push(0, 1 + i, 1 + next);
  }

  const waterGeo = new THREE.BufferGeometry();
  waterGeo.setAttribute('position', new THREE.Float32BufferAttribute(waterVerts, 3));
  waterGeo.setAttribute('normal', new THREE.Float32BufferAttribute(waterNorms, 3));
  waterGeo.setAttribute('uv', new THREE.Float32BufferAttribute(waterUvs, 2));
  waterGeo.setIndex(waterIdxs);

  const waterUniforms = {
    uTime: { value: 0 },
  };

  const pondWaterMat = new THREE.MeshStandardMaterial({
    color: 0x246268, roughness: 0.08, metalness: 0.04, transparent: true, opacity: 0.82,
    envMapIntensity: 2.2, depthWrite: false,
  });
  pondWaterMat.customProgramCacheKey = () => 'koi-pond-water';
  pondWaterMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = waterUniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos;
        uniform float uTime;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec2 p = vWPos.xz;
          float rip1 = sin(p.x * 4.5 + uTime * 2.1 + sin(p.y * 3.8));
          float rip2 = cos(p.y * 4.8 - uTime * 1.8 + cos(p.x * 4.2));
          vec2 slope = vec2(rip1 + rip2 * 0.5, rip2 + rip1 * 0.5) * 0.08;
          vec3 wn = normalize(vec3(slope.x, 1.0, slope.y));
          normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
        }`)
      .replace('#include <opaque_fragment>', `
        {
          float NdotV = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
          float fresnel = 0.04 + 0.96 * pow(1.0 - NdotV, 4.0);
          outgoingLight += reflectedLight.indirectSpecular * (fresnel * 1.8);
          gl_FragColor.a = clamp(mix(0.65, 0.95, fresnel), 0.0, 1.0);
        }
        #include <opaque_fragment>`);
  };

  const pondWaterMesh = new THREE.Mesh(waterGeo, pondWaterMat);
  pondWaterMesh.position.set(cx, WATER_Y, cz);
  pondWaterMesh.renderOrder = 3;
  group.add(pondWaterMesh);

  // -------------------------------------------------------------------------
  // 4. Floating Water Lily Pads with Lotus Blossoms
  // -------------------------------------------------------------------------
  const padMat = new THREE.MeshStandardMaterial({ color: 0x3e7a32, roughness: 0.6, side: THREE.DoubleSide });
  const flowerMat = new THREE.MeshStandardMaterial({ color: 0xf2799c, emissive: 0x330011, roughness: 0.5 });
  const flowerCenterMat = new THREE.MeshStandardMaterial({ color: 0xf5d020, roughness: 0.4 });

  const LILY_CLUSTERS = [
    { x: -1.6, z: 1.4, count: 4 },
    { x: 1.8, z: -1.2, count: 5 },
    { x: 0.8, z: 2.1, count: 3 },
  ];

  for (const cl of LILY_CLUSTERS) {
    for (let p = 0; p < cl.count; p++) {
      const px = cx + cl.x + (Math.sin(p * 2.1) * 0.6);
      const pz = cz + cl.z + (Math.cos(p * 1.8) * 0.6);
      const pr = 0.22 + 0.08 * Math.sin(p * 3.4);

      // Notched circular lily pad
      const padGeo = new THREE.CircleGeometry(pr, 16, 0.25, Math.PI * 1.85);
      const padMesh = new THREE.Mesh(padGeo, padMat);
      padMesh.rotation.x = -Math.PI / 2;
      padMesh.position.set(px, WATER_Y + 0.005, pz);
      group.add(padMesh);

      // Flower on every 3rd pad
      if (p % 3 === 0) {
        const flower = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.09, 8), flowerMat);
        flower.position.set(px, WATER_Y + 0.045, pz);
        const center = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), flowerCenterMat);
        center.position.set(px, WATER_Y + 0.075, pz);
        group.add(flower, center);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 5. 10 Colorful Japanese Koi Fish with Natural Swimming Physics
  // -------------------------------------------------------------------------
  const fishMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.35, metalness: 0.15,
  });

  const koiFishes = [];
  for (let i = 0; i < 10; i++) {
    const species = KOI_SPECIES[i % KOI_SPECIES.length];
    const scale = 0.95 + (i % 4) * 0.12; // varying fish sizes (0.95m - 1.35m scaled length)
    const geo = buildKoiMesh(species, scale);
    const mesh = new THREE.Mesh(geo, fishMat);
    mesh.castShadow = true;
    group.add(mesh);

    // Initial swim trajectory state
    const th0 = (i / 10) * Math.PI * 2;
    const rOrbit = 1.3 + (i % 5) * 0.42; // orbit distance from pond center (1.3 to 3.0 m)
    const depthTarget = -0.35 - (i % 4) * 0.26; // varying swimming depth
    const speed = 0.45 + (i % 3) * 0.16; // swimming speed (m/s)
    const dir = i % 2 === 0 ? 1 : -1; // clockwise / counter-clockwise

    koiFishes.push({
      mesh,
      geo,
      origPos: geo.attributes.position.array.slice(),
      th: th0,
      rOrbit,
      depthTarget,
      speed,
      dir,
      phase: i * 1.3,
      tailFreq: 4.8 * speed,
    });
  }

  // Return container and animation update function
  return {
    group,
    update(dt) {
      waterUniforms.uTime.value = (waterUniforms.uTime.value + dt) % 4096;
      const t = waterUniforms.uTime.value;

      // Update 10 Koi swimming physics & spine undulation
      for (let i = 0; i < koiFishes.length; i++) {
        const fish = koiFishes[i];
        // Advance angle around pond
        fish.th += (fish.dir * (fish.speed / Math.max(1.0, fish.rOrbit))) * dt;

        // Current orbit radius with subtle breathing wander
        const rNow = Math.min(fish.rOrbit + 0.25 * Math.sin(t * 0.7 + fish.phase), pondRadius(fish.th) - 0.45);
        const fx = cx + Math.sin(fish.th) * rNow;
        const fz = cz + Math.cos(fish.th) * rNow;
        const fy = WATER_Y + fish.depthTarget + 0.08 * Math.sin(t * 1.1 + fish.phase);

        // Heading angle (tangential to orbit)
        const yaw = fish.th + (fish.dir > 0 ? Math.PI / 2 : -Math.PI / 2) + 0.15 * Math.sin(t * 1.5 + fish.phase);
        fish.mesh.position.set(fx, fy, fz);
        fish.mesh.rotation.set(0, yaw, 0.08 * Math.sin(t * 2.0 + fish.phase));

        // Spine & tail sinusoidal undulation animation (swimming physics)
        const pos = fish.geo.attributes.position.array;
        const orig = fish.origPos;
        const wave = Math.sin(t * fish.tailFreq + fish.phase);

        for (let v = 0; v < pos.length; v += 3) {
          const zOrig = orig[v + 2];
          // Vertices towards rear tail (z > -0.1) wiggle horizontally with increasing amplitude
          const flexFactor = Math.max(0.0, (zOrig + 0.15) * 1.8);
          pos[v] = orig[v] + wave * 0.045 * flexFactor * flexFactor;
          pos[v + 1] = orig[v + 1];
          pos[v + 2] = orig[v + 2];
        }
        fish.geo.attributes.position.needsUpdate = true;
      }
    },
    dispose() {
      basinGeo.dispose(); basinMat.dispose();
      waterGeo.dispose(); pondWaterMat.dispose();
      padMat.dispose(); flowerMat.dispose(); flowerCenterMat.dispose();
      stoneMat.dispose(); mossMat.dispose();
      fishMat.dispose();
      for (const f of koiFishes) f.geo.dispose();
      for (const rg of rockGeos) rg.dispose();
    },
  };
}
