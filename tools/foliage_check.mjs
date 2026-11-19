// Sanity check for the foliage asset: decodes every mesh of src/world/foliage_asset.js and prints
// triangle / vertex counts and the asset size. Optionally runs a headless buildFoliage() smoke test.
//   node tools/foliage_check.mjs
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FOLIAGE_MODELS, FOLIAGE_TEX } from '../src/world/foliage_asset.js';
import { decodeFoliageMesh, buildFoliage } from '../src/world/foliage.js';

const file = fileURLToPath(new URL('../src/world/foliage_asset.js', import.meta.url));
const kb = (n) => (n / 1024).toFixed(0) + ' KB';
let bad = 0;
const fail = (m) => { bad++; console.log('FAIL', m); };

console.log('asset size', kb(statSync(file).size), '(limit 2560 KB)');
for (const [k, uri] of Object.entries(FOLIAGE_TEX)) {
  if (typeof uri !== 'string') continue;
  const b = Buffer.from(uri.split(',')[1], 'base64');
  if (b[0] !== 0xff || b[1] !== 0xd8) fail(`${k} is not a JPEG`);
  console.log(`  tex ${k.padEnd(6)} ${kb(b.length)}`);
}
for (const [name, m] of Object.entries(FOLIAGE_MODELS)) {
  const parts = m.lod.map((L, i) => {
    let tris = 0, verts = 0;
    for (const key of ['bark', 'leaf']) {
      if (!L[key]) continue;
      const d = decodeFoliageMesh(L[key]);
      tris += d.ni / 3; verts += d.nv;
      for (let j = 0; j < d.ni; j++) if (d.idx[j] >= d.nv) fail(`${name} lod${i} ${key} index out of range`);
      for (let j = 0; j < d.pos.length; j++) if (!Number.isFinite(d.pos[j])) fail(`${name} ${key} NaN position`);
    }
    if (tris !== L.tris) fail(`${name} lod${i} triangle count ${tris} != ${L.tris}`);
    return `LOD${i} ${tris} tris / ${verts} verts`;
  });
  console.log(`  ${name.padEnd(8)} ${parts.join('   ')}   (h ${m.h} m)`);
}

// headless smoke test of the builder (textures are stubbed without a DOM)
const trees = [], bushes = [];
for (let i = 0; i < 400; i++) {
  const x = ((i * 37) % 200) - 100, z = ((i * 91) % 200) - 100;
  trees.push([x, 0, z, 0.8 + (i % 5) * 0.1, i, ['pine', 'spruce', 'birch'][i % 3]]);
  bushes.push([x + 3, 0, z + 2, 1, i, ['bush', 'fern', 'hedge'][i % 3]]);
}
const n = 65, grid = Buffer.alloc(n * n, 180).toString('base64');
const fol = await buildFoliage({ foliage: { trees, bushes, grass: { n, x0: -100, z0: -100, size: 200, data: grid } }, heightAt: () => 0, quality: 'high' });
const cam = { x: 0, y: 1.7, z: 0, copy() { return this; } };
const v = { x: 0, y: 1.7, z: 0 };
for (let f = 0; f < 30; f++) fol.update(0.016, v, 1);
let drawn = 0, tris = 0;
fol.group.traverse((o) => { if (o.isInstancedMesh && o.count) { drawn++; tris += o.count * (o.geometry.index.count / 3); } });
console.log(`smoke: ${fol.colliders.length} colliders, ${drawn} instanced draws, ${tris} triangles around the origin`);
fol.setQuality('low');
fol.update(0.016, v, 1);
fol.dispose();
console.log(bad ? `${bad} problem(s)` : 'OK');
process.exit(bad ? 1 : 0);
