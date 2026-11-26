// Midtown as a map object (docs/MAP_CONTRACT.md): buildCity() untouched, plus
// the layout helpers and the minimap picture the HUD used to paint itself.
import { buildCity } from '../world/city.js';
import { FACADE_PARALLAX_DIST, SHOP_PARALLAX_DIST } from '../world/facade_shader.js';
import { MED_WET_SPEC } from '../world/road_shader.js';
import { HALF, AVENUES, STREETS, broadwayX, districtName, crossStreet, groundAt } from '../world/layout.js';
import { makeCanvas } from '../world/textures.js';

/** Whole-map image (2.5 m per pixel), north up. */
function drawMinimap(city) {
  const S = 2.5, N = Math.round((HALF * 2) / S);
  const c = makeCanvas(N, N), g = c.getContext('2d');
  const X = (x) => (x + HALF) / S, Z = (z) => (z + HALF) / S;
  g.fillStyle = '#20232c';
  g.fillRect(0, 0, N, N);
  // sidewalks / blocks slightly lighter than the roadway
  g.fillStyle = '#2b2f3a';
  for (let c2 = -1; c2 < AVENUES.length; c2++) {
    const x0 = c2 < 0 ? -HALF : AVENUES[c2].x + AVENUES[c2].road, x1 = c2 + 1 >= AVENUES.length ? HALF : AVENUES[c2 + 1].x - AVENUES[c2 + 1].road;
    for (let r = -1; r < STREETS.length; r++) {
      const z0 = r < 0 ? -HALF : STREETS[r].z + STREETS[r].road, z1 = r + 1 >= STREETS.length ? HALF : STREETS[r + 1].z - STREETS[r + 1].road;
      g.fillRect(X(x0), Z(z0), (x1 - x0) / S, (z1 - z0) / S);
    }
  }
  // Broadway
  g.strokeStyle = '#20232c';
  g.lineWidth = 16 / S;
  g.beginPath();
  g.moveTo(X(broadwayX(-HALF)), Z(-HALF));
  g.lineTo(X(0), Z(0));
  g.lineTo(X(broadwayX(HALF)), Z(HALF));
  g.stroke();
  g.fillStyle = '#244a2c';
  for (const p of city.ctx.parks) g.fillRect(X(p.x0), Z(p.z0), (p.x1 - p.x0) / S, (p.z1 - p.z0) / S);
  for (const b of city.ctx.buildings) {
    if (Math.abs(b.x0) > HALF || Math.abs(b.z0) > HALF) continue;
    g.fillStyle = b.nearTS ? '#5d6480' : b.h > 150 ? '#565d70' : '#454b5b';
    if (b.round) { g.beginPath(); g.arc(X(b.cx), Z(b.cz), b.round / S, 0, 7); g.fill(); }
    else g.fillRect(X(b.x0) + 0.5, Z(b.z0) + 0.5, (b.x1 - b.x0) / S - 1, (b.z1 - b.z0) / S - 1);
  }
  g.fillStyle = '#10283f';
  g.fillRect(0, 0, 3, N);
  // the bowtie glows
  const grad = g.createRadialGradient(X(8), Z(30), 4, X(8), Z(30), 120);
  grad.addColorStop(0, 'rgba(255,90,170,0.16)');
  grad.addColorStop(1, 'rgba(255,90,170,0)');
  g.fillStyle = grad;
  g.fillRect(X(-300), Z(-300), 600 / S, 660 / S);
  return { canvas: c, scale: S, size: N, x0: -HALF, z0: -HALF, radius: 95, label: { text: 'TIMES SQUARE', x: 8, z: -360 } };
}

export async function buildMidtown(onProgress) {
  const city = buildCity({ onProgress });
  const minimap = drawMinimap(city);
  const facSet = new Set(
    Object.entries(city.materials).filter(([k]) => k.startsWith('facade')).map(([, v]) => v)
  );
  // Below High only the buildings cast sun shadows: the cars and street props
  // are most of the city's triangles and would be drawn a second time.
  const setQuality = (name) => {
    const all = name === 'high' || name === 'ultra';
    FACADE_PARALLAX_DIST.value = all ? 190.0 : 0.0;
    SHOP_PARALLAX_DIST.value = all ? 160.0 : 0.0;
    MED_WET_SPEC.value = all ? 0.20 : 1.0;
    city.group.traverse((m) => {
      if (!m.isMesh) return;
      if (m.material === city.materials.flat || m.userData.shadowHigh) m.castShadow = all;
      if (m.material === city.materials.shop || m.material === city.materials.shopLite) {
        m.material = all ? city.materials.shop : city.materials.shopLite;
        m.receiveShadow = all;
      } else if (facSet.has(m.material) || m.material === city.materials.marks) {
        // On phones (Medium/Low), streets/sidewalks/props/vehicles/soldiers keep crisp shadows
        // while skyscraper facades & transparent lane marks skip 9-tap shadow sampling.
        m.receiveShadow = all;
      }
    });
  };
  return {
    id: 'midtown',
    name: 'MIDTOWN',
    deploy: 'DEPLOYING TO TIMES SQUARE',
    group: city.group, world: city.world, nav: city.nav, ctx: city.ctx,
    update: city.update,
    half: HALF,
    bounds: { x0: -HALF, x1: HALF, z0: -HALF, z1: HALF },
    groundAt,
    zoneName: districtName,
    subName: crossStreet,
    minimap,
    atmosphere: { preset: 'midtown' },
    photoLim: HALF + 60,
    photoMaxY: 600,
    // menu background: slow flight around the bowtie
    flyover(t, cam) {
      const a = t * 0.045 + 0.6;
      cam.position.set(Math.sin(a) * 135 + 6, 48 + Math.sin(t * 0.11) * 14, Math.cos(a) * 170 + 30);
      cam.lookAt(6, 30, 20);
    },
    warmCam: [[60, 40, 260], [0, 20, 0]],
    setQuality,
    stats: city.stats,
  };
}
