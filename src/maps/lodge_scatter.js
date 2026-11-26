// Extra vegetation for Cedar Lodge (the exported data only uses the old plant kinds):
// reeds and cattails on the shore and pond rim, lupine / fireweed in the meadows, clover and
// blueberry under trees, a few mossy rocks and maples among the birches. Fixed seed, so it is
// identical every run. Everything respects the grass mask, buildings, props, spawns, buses and the pond.
import { RNG } from '../core/util.js';
import { pondRadius, inPond, POND } from '../world/pond_shape.js';

const BUSES = { x0: -29.5, z0: 23.5, x1: -10.5, z1: 43.5 };   // the bus yard (lodge.js zone, plus a margin)

function decodeMask(g) {
  const bin = atob(g.data), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const step = g.size / (g.n - 1);
  return (x, z) => {
    const i = Math.round((x - g.x0) / step), j = Math.round((z - g.z0) / step);
    return i < 0 || j < 0 || i >= g.n || j >= g.n ? 0 : u8[j * g.n + i];
  };
}

/** @returns {{bushes:number[][], trees:number[][]}} extra entries to append to the foliage lists */
export function scatterPlants(D, groundAt, world) {
  const rng = new RNG(0xced4a1);
  const grass = decodeMask(D.foliage.grass);
  const b = D.bounds, wy = D.water.y;
  const bushes = [], trees = [];
  const q = [];
  const baseTrees = D.foliage.trees;

  const nearSpawn = (x, z) => D.spawns.some((t) => t.some((s) => Math.hypot(s[0] - x, s[1] - z) < 5));
  const nearBuses = (x, z, m = 0) => x > BUSES.x0 - m && x < BUSES.x1 + m && z > BUSES.z0 - m && z < BUSES.z1 + m;
  // free of buildings, props and trunks (anything solid taller than a step)
  const blocked = (x, z, r) => {
    world.query(x - r, z - r, x + r, z + r, q);
    for (const i of q) if ((world.flags[i] & 1) && world.maxY[i] > groundAt(x, z) + 0.25) return true;
    return false;
  };
  const dry = (x, z) => groundAt(x, z) > wy + 0.35;
  const inArea = (x, z) => x > b.x0 + 2 && x < b.x1 - 2 && z > b.z0 + 4 && z < b.z1 - 3;
  const ok = (x, z, r = 0.8, mask = 110) => inArea(x, z) && dry(x, z) && grass(x, z) > mask && !inPond(x, z, -1.6) && !nearBuses(x, z, 1.5) && !nearSpawn(x, z) && !blocked(x, z, r);
  const put = (list, x, z, s, kind) => list.push([x, groundAt(x, z), z, s, rng.range(0, 6.283), kind]);
  const clump = (kind, cx, cz, n, spread, s0, s1, mask) => {
    for (let k = 0; k < n; k++) {
      const a = rng.range(0, 6.283), r = Math.sqrt(rng.next()) * spread;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      if (ok(x, z, 0.6, mask)) put(bushes, x, z, rng.range(s0, s1), kind);
    }
  };

  // -- reeds and cattails along the lake shore: where the ground is just above to a little under the water line
  for (let i = 0; i < 520 && bushes.length < 160; i++) {
    const x = rng.range(b.x0 + 3, b.x1 - 3), z = rng.range(-56, -44);
    const g = groundAt(x, z);
    if (g < wy - 0.3 || g > wy + 0.3) continue;
    if (x > -25 && x < -13 && z < -41) continue;   // keep the dock clear
    if (blocked(x, z, 0.5)) continue;
    put(bushes, x, z, rng.range(0.8, 1.35), rng.chance(0.35) ? 'cattail' : 'reed');
  }
  const shoreCount = bushes.length;
  // -- the pond rim, dry side only
  for (let k = 0; k < 9; k++) {
    const th = rng.range(0, 6.283), r = pondRadius(th) + rng.range(0.55, 1.1);
    const x = POND.x + Math.sin(th) * r, z = POND.z + Math.cos(th) * r;
    if (nearBuses(x, z, 0.5) || blocked(x, z, 0.4)) continue;
    put(bushes, x, z, rng.range(0.6, 0.95), rng.chance(0.4) ? 'cattail' : 'reed');
  }
  // -- open meadow: lupine and fireweed in clumps (away from the buildings' yard)
  for (const [kind, clumps] of [['lupine', 11], ['fireweed', 9]]) {
    for (let c = 0, tries = 0; c < clumps && tries < 400; tries++) {
      const cx = rng.range(b.x0 + 6, b.x1 - 6), cz = rng.range(-36, 60);
      if (Math.hypot(cx, cz) < 17 || !ok(cx, cz, 1.2, 200)) continue;   // not around the lodge itself
      clump(kind, cx, cz, 6, 2.6, 0.8, 1.2, 160);
      c++;
    }
  }
  // -- under the trees: clover and blueberry
  const forest = baseTrees.filter((t) => Math.abs(t[0]) < b.x1 + 4 && t[2] > -50 && t[2] < b.z1 + 4);
  for (let c = 0, tries = 0; c < 22 && tries < 300; tries++) {
    const t = forest[Math.floor(rng.next() * forest.length)];
    const a = rng.range(0, 6.283), r = rng.range(1.8, 4);
    const x = t[0] + Math.cos(a) * r, z = t[2] + Math.sin(a) * r;
    if (!ok(x, z, 0.8, 90)) continue;
    if (c % 2) clump('blueberry', x, z, 3, 1.4, 0.8, 1.15, 90); else clump('clover', x, z, 5, 1.8, 0.9, 1.3, 90);
    c++;
  }
  // -- gravel-to-grass yard & trail border transition clutter (clover, ferns, small mossy rocks)
  for (let c = 0, tries = 0; c < 30 && tries < 700; tries++) {
    const x = rng.range(-32, 46), z = rng.range(18, 68);
    const gm = grass(x, z);
    if (gm < 28 || gm > 135) continue;
    if (!inArea(x, z) || !dry(x, z) || inPond(x, z, -1.2) || nearBuses(x, z, 1.2) || nearSpawn(x, z) || blocked(x, z, 0.55)) continue;
    const roll = c % 3;
    if (roll === 0) clump('clover', x, z, 3, 1.3, 0.85, 1.2, 20);
    else if (roll === 1) put(bushes, x, z, rng.range(0.65, 1.05), rng.chance(0.5) ? 'fern' : 'fern2');
    else put(bushes, x, z, rng.range(0.55, 0.95), 'rock');
    c++;
  }
  // -- mossy rocks
  for (let c = 0, tries = 0; c < 14 && tries < 400; tries++) {
    const x = rng.range(b.x0 + 4, b.x1 - 4), z = rng.range(-40, 60);
    if (Math.hypot(x, z) < 15 || !ok(x, z, 1.2, 120)) continue;
    put(bushes, x, z, rng.range(0.7, 1.5), 'rock');
    c++;
  }
  // -- maples among the birches
  const birches = baseTrees.filter((t) => t[5] === 'birch');
  for (let c = 0, tries = 0; c < 12 && tries < 200 && birches.length; tries++) {
    const t = birches[Math.floor(rng.next() * birches.length)];
    const a = rng.range(0, 6.283), r = rng.range(3.5, 6);
    const x = t[0] + Math.cos(a) * r, z = t[2] + Math.sin(a) * r;
    if (!ok(x, z, 1.1, 90) || trees.some((m) => Math.hypot(m[0] - x, m[2] - z) < 5)) continue;
    put(trees, x, z, rng.range(0.9, 1.25), 'maple');
    c++;
  }
  return { bushes, trees, shoreCount };
}
