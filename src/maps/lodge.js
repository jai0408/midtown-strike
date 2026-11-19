// Cedar Lodge: the Blender-built scenery (lodge_asset.js), foliage, a lake,
// physics colliders and a grid nav, packaged as a map object (docs/MAP_CONTRACT.md).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { LODGE_GLB, LODGE_DATA as D } from './lodge_asset.js';
import { buildFoliage } from '../world/foliage.js';
import { createWater } from '../world/water.js';
import { buildGridNav } from '../world/gridnav.js';
import { applyTerrainSplat, testTerrainLayers } from '../world/terrain.js';
import { applyMountainShader } from '../world/mountain.js';
import { World } from '../core/physics.js';
import { getMaxAnisotropy, makeCanvas } from '../world/textures.js';
import { createKoiPond } from '../world/pond.js';
import { buildSchoolBuses } from '../world/school_bus.js';
import { createPhoenix } from '../world/phoenix.js';

// let the loading screen repaint between the heavy steps
const tick = () => new Promise((r) => setTimeout(r, 0));

function decodeBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function parseGlb(buf) {
  return new Promise((resolve, reject) => {
    try { new GLTFLoader().parse(buf, '', resolve, reject); } catch (e) { reject(e); }
  });
}

/** Bilinear terrain height from the exported grid (n x n samples spanning `size` metres corner to corner). */
function makeGroundAt(h) {
  const data = new Float32Array(decodeBase64(h.data));
  const n = h.n, cell = h.size / (n - 1), inv = 1 / cell;
  return (x, z) => {
    let fx = (x - h.x0) * inv, fz = (z - h.z0) * inv;
    fx = fx < 0 ? 0 : fx > n - 1.001 ? n - 1.001 : fx;
    fz = fz < 0 ? 0 : fz > n - 1.001 ? n - 1.001 : fz;
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = j * n + i;
    return (data[k] * (1 - u) + data[k + 1] * u) * (1 - v) + (data[k + n] * (1 - u) + data[k + n + 1] * u) * v;
  };
}

/** Glass is told apart by mesh extras ({ glass: true }) or, failing that, by the material's name. */
const extras = (o) => ({ ...(o.parent && o.parent.userData), ...o.userData });

function prepareMaterial(m, glass, matName) {
  const aniso = getMaxAnisotropy();
  for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
    if (m[k]) m[k].anisotropy = aniso;
  }
  if (glass) {
    m.transparent = true;
    m.depthWrite = false;
    m.roughness = 0.08;
    m.metalness = 0.05;
    m.envMapIntensity = 2.4;
    if (m.opacity > 0.6) m.opacity = 0.4;
    // Architectural glass Fresnel shader: high reflectivity at glancing angles, transparent head-on
    m.customProgramCacheKey = () => 'lodge-glass-v2';
    m.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <opaque_fragment>', `
          {
            float NdotV = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
            float fresnel = 0.04 + 0.96 * pow(1.0 - NdotV, 4.0);
            outgoingLight += reflectedLight.indirectSpecular * (fresnel * 2.2);
            gl_FragColor.a = clamp(mix(0.22, 0.92, fresnel), 0.0, 1.0);
            if (!(dot(outgoingLight, vec3(1.0)) < 20000.0)) outgoingLight = vec3(0.0);
            outgoingLight = clamp(outgoingLight, 0.0, 24.0);
          }
          #include <opaque_fragment>`);
    };
  } else {
    const name = (matName || m.name || '').toLowerCase();
    if (name.includes('metal')) {
      m.envMapIntensity = 2.2;
      m.roughness = Math.min(m.roughness, 0.35);
      m.metalness = Math.max(m.metalness, 0.85);
    } else if (name.includes('shingle')) {
      m.envMapIntensity = 1.3;
      m.roughness = 0.75;
    } else if (name.includes('log') || name.includes('planks')) {
      m.envMapIntensity = 1.15;
      m.roughness = 0.82;
    } else if (name.includes('stone') || name.includes('rock')) {
      m.envMapIntensity = 0.9;
    } else if (name.includes('glow')) {
      m.emissiveIntensity = 2.8;
    } else {
      m.envMapIntensity = 1.05;
    }
  }
}

async function loadMinimap(mm) {
  const S = 512;
  const c = makeCanvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#20301c';
  g.fillRect(0, 0, S, S);
  try {
    const img = new Image();
    img.src = 'data:image/png;base64,' + mm.png;
    await img.decode();
    g.drawImage(img, 0, 0, S, S);
  } catch (e) { console.warn('lodge minimap failed', e); }
  return { canvas: c, scale: mm.size / S, size: S, x0: mm.x0, z0: mm.z0, radius: 48 };
}

export async function buildLodge(onProgress = () => {}) {
  onProgress(0.03);
  await tick();

  // -- scenery ---------------------------------------------------------------
  const gltf = await parseGlb(decodeBase64(LODGE_GLB));
  onProgress(0.4);
  await tick();
  const scene = gltf.scene;
  const casters = [];   // [mesh, wants to cast]
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const ex = extras(o);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const glass = !!ex.glass || mats.some((m) => /glass/i.test(m.name || ''));
    for (const m of mats) prepareMaterial(m, glass, m.name || o.name);
    o.receiveShadow = !glass;
    casters.push([o, !glass && ex.castShadow !== false]);
  });
  // terrain: splat layers over the baked colour (falls back to the GLB material as is)
  let layers = D.terrainLayers;
  if (!layers && __DEV__ && /splat/.test(location.hash)) layers = testTerrainLayers();
  if (layers) {
    const mats = [];
    scene.traverse((o) => { if (o.isMesh && o.material && o.material.name === 'terrain') mats.push(o.material); });
    try { for (const m of new Set(mats)) await applyTerrainSplat(m, layers); } catch (e) { console.warn('terrain splat failed', e); }
  }
  // mountains: triplanar rock / forest / snow shader, rock texture from the terrain rock layer
  if (layers && layers.layers[3]) {
    const mm = [];
    scene.traverse((o) => { if (o.isMesh && o.material && o.material.name === 'mountain') mm.push(o.material); });
    for (const m of new Set(mm)) await applyMountainShader(m, layers.layers[3].albedo, D.sun && D.sun.dir);
  }
  // the baked terrain colour is oversaturated under the strong sun
  scene.traverse((o) => {
    if (o.isMesh && o.material && o.material.name === 'terrain') {
      // (the pond hole is cut in the splat shader itself, src/world/terrain.js: patching
      // the shader a second time here redeclared vWPos and the terrain failed to compile)
      o.material.color.set(0xc9d0bd);
    }
  });
  // static: skip the per-frame matrix updates
  scene.updateMatrixWorld(true);
  scene.traverse((o) => { o.matrixAutoUpdate = false; });

  // -- physics ---------------------------------------------------------------
  const rawGroundAt = makeGroundAt(D.height);
  // Excavate the 5ft deep Koi Pond basin in the physics terrain height function
  const groundAt = (x, z) => {
    const dx = x - (-18.5), dz = z - 20.0;
    const d = Math.hypot(dx, dz);
    const th = Math.atan2(dx, dz);
    const pr = 3.9 + 0.58 * Math.sin(2 * th + 0.5) + 0.35 * Math.cos(3 * th - 0.7) + 0.22 * Math.sin(5 * th + 1.1) + 0.15 * Math.cos(7 * th);
    if (d < pr) {
      const depthFrac = Math.min(1.0, (1.0 - d / pr) * 2.0);
      return rawGroundAt(x, z) - depthFrac * 1.52; // 5ft depth in the pond
    }
    return rawGroundAt(x, z);
  };
  const world = new World(D.half, 8);
  world.groundAt = groundAt;
  world.rough = true;   // terrain dips below 0 at the creek and the shore
  for (const c of D.colliders) world.addBox(c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]);
  onProgress(0.55);
  await tick();

  // -- foliage ---------------------------------------------------------------
  const foliage = await buildFoliage({ foliage: D.foliage, heightAt: groundAt, quality: 'medium' });
  for (const c of foliage.colliders) world.addBox(c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]);
  // foliage reacts to sun / hemi: rich, authentic Call of Duty Mobile forest tones
  const birchMats = new Map();
  foliage.group.traverse((o) => {
    const m = o.material;
    if (!m) return;
    if (m.userData && m.userData.uniforms && m.userData.uniforms.uSelfLit) m.userData.uniforms.uSelfLit.value = 0;
    if (!o.isMesh || !m.color) return;

    const name = o.name || '';
    if (/^pine|spruce/.test(name)) {
      // Deep, rich evergreen needle tones with subtle sun sheen
      m.color.set(0x365434);
      m.roughness = 0.68;
    } else if (/^bush.*leaf/.test(name)) {
      // Dense, rich woodland shrub foliage
      m.color.set(0x44682e);
      m.roughness = 0.72;
    } else if (/^birch.*leaf/.test(name)) {
      // Lush sunlit northern birch olive-gold
      let bm = birchMats.get(m);
      if (!bm) {
        bm = m.clone();
        bm.onBeforeCompile = m.onBeforeCompile;
        bm.customProgramCacheKey = m.customProgramCacheKey;
        bm.userData = m.userData;
        bm.color.set(0x648a3e);
        bm.roughness = 0.70;
        birchMats.set(m, bm);
      }
      o.material = bm;
    } else if (/^fern/.test(name)) {
      // Rich woodland floor green
      m.color.set(0x386426);
      m.roughness = 0.66;
    } else if (name === 'grass') {
      // Lush, vibrant meadow grass
      m.color.set(0x568c36);
      m.roughness = 0.74;
    } else if (/bark/.test(name)) {
      // Rich textured cedar and pine bark
      m.color.set(0x524234);
      m.roughness = 0.86;
    } else if (m.alphaTest > 0) {
      m.color.set(0x486c36);
    }
  });

  // -- school buses & koi pond ----------------------------------------------
  // Two American School Buses positioned between the lodges
  const buses = buildSchoolBuses(groundAt, world);

  // Natural uneven Koi Pond left side of the south yard lodge (~8m diameter, 5ft deep, 10 colorful Koi fish)
  const pond = createKoiPond({ x: -18.5, z: 20.0, groundAt, world });

  // Mythical Phoenix Bird soaring across the skies above the lodge and lake
  const phoenix = createPhoenix();

  world.finalize();
  onProgress(0.75);
  await tick();

  // -- nav -------------------------------------------------------------------
  const b = D.bounds;
  const nav = buildGridNav(world, { x0: b.x0 + 2, x1: b.x1 - 2, z0: b.z0 + 2, z1: b.z1 - 2 }, {
    step: 3.5, extra: D.hotspots, minGround: D.water.y + 0.2,
  });
  onProgress(0.88);
  await tick();

  // -- water, minimap --------------------------------------------------------
  const water = createWater(D.water, groundAt, D.sun && D.sun.dir);
  const minimap = await loadMinimap(D.minimap);

  const group = new THREE.Group();
  group.name = 'lodge';
  group.add(scene, foliage.group, water.mesh, pond.group, buses.group, phoenix.group);

  // the lodge interior gets almost no sky light: a few warm point lights, no shadows.
  // They are only switched on near the lodge (every lit pixel pays for each light).
  const inside = [[-5, 2.3, 0, 18], [4.5, 2.3, -1.5, 18], [0, 2.4, 2.4, 12]].map(([x, y, z, i]) => {
    const l = new THREE.PointLight(0xffb36b, i, 10, 2);
    l.position.set(x, y, z);
    l.visible = false;
    group.add(l);
    return l;
  });
  let lit = false;
  const setInterior = (on) => { lit = on; for (const l of inside) l.visible = on; };
  onProgress(1);

  // smallest zone containing the point (including Koi Pond and School Buses)
  const allZones = [
    { name: 'KOI POND', x0: -23.5, z0: 15.5, x1: -13.5, z1: 24.5 },
    { name: 'SCHOOL BUSES', x0: -28.0, z0: 25.0, x1: -12.0, z1: 42.0 },
    ...D.zones,
  ];
  const zones = allZones.map((z) => ({ ...z, area: (z.x1 - z.x0) * (z.z1 - z.z0) }));
  const zoneName = (x, z) => {
    let best = null;
    for (const q of zones) if (x >= q.x0 && x <= q.x1 && z >= q.z0 && z <= q.z1 && (!best || q.area < best.area)) best = q;
    return best ? best.name : (z < D.water.z1 ? 'LAKESHORE' : D.name);
  };

  return {
    id: 'lodge',
    name: D.name,
    deploy: 'DEPLOYING TO CEDAR LODGE',
    group, world, nav,
    ctx: { emitters: [], stations: [], buildings: [], parks: [] },
    setInterior,
    update(dt, camPos, drawScale = 1, camera) {
      const d = Math.hypot(camPos.x, camPos.z);
      if (!lit && d < 30) setInterior(true); else if (lit && d > 36) setInterior(false);
      foliage.update(dt, camPos, drawScale, camera);
      water.update(dt);
      pond.update(dt);
      phoenix.update(dt);
    },
    half: D.half,
    bounds: D.bounds,
    groundAt,
    zoneName,
    subName: (x, z) => (zoneName(x, z) === D.name ? '' : D.name),
    minimap,
    atmosphere: { preset: 'lodge', sunDir: D.sun && D.sun.dir },
    photoLim: Math.min(D.half, 150),   // drone limits (+-m) and ceiling
    photoMaxY: 140,
    // menu background: a slow orbit round the lodge
    flyover(t, cam) {
      const a = t * 0.05 + 0.4;
      cam.position.set(Math.sin(a) * 62, 14 + Math.sin(t * 0.11) * 4, Math.cos(a) * 70 + 4);
      cam.lookAt(0, 3, 0);
    },
    warmCam: [[0, 18, 70], [0, 2, 0]],
    setQuality(name) {
      const on = name !== 'low';
      for (const [m, wants] of casters) m.castShadow = on && wants;
      foliage.setQuality(name);
    },
    dispose() { foliage.dispose(); water.dispose(); pond.dispose(); buses.dispose(); phoenix.dispose(); },
  };
}
