// Verifies every GLB embedded in the asset modules: header / chunk structure, bufferView bounds, and that
// every image is consistent with its mimeType and every WebP image is wired through EXT_texture_webp
// (extensionsUsed + extensionsRequired). Usage: node tools/check_glb_webp.mjs   (exit 1 on any problem)
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['src/maps/lodge_asset.js', 'src/world/lodge_props_asset.js', 'src/world/creatures_asset.js', 'src/game/weapons_glb.js'];
const EXT = 'EXT_texture_webp';
let glbs = 0, webp = 0, other = 0, errors = 0;
const fail = (where, msg) => { errors++; console.log(`FAIL ${where}: ${msg}`); };

for (const f of FILES) {
  const text = readFileSync(resolve(root, f), 'utf8');
  for (const m of text.matchAll(/(\w+)['"]?\s*[:=]\s*['"](Z2xURg[A-Za-z0-9+/=]+)['"]/g)) {
    const where = `${f}:${m[1]}#${++glbs}`;
    const b = Buffer.from(m[2], 'base64');
    if (b.toString('latin1', 0, 4) !== 'glTF' || b.readUInt32LE(4) !== 2) { fail(where, 'bad magic/version'); continue; }
    if (b.readUInt32LE(8) !== b.length) fail(where, `header length ${b.readUInt32LE(8)} != ${b.length}`);
    const jl = b.readUInt32LE(12);
    if (b.toString('latin1', 16, 20) !== 'JSON' || jl % 4) fail(where, 'bad JSON chunk');
    const j = JSON.parse(b.toString('utf8', 20, 20 + jl));
    const bo = 20 + jl, bl = b.readUInt32LE(bo);
    if (b.toString('latin1', bo + 4, bo + 8) !== 'BIN\0' || bl % 4) fail(where, 'bad BIN chunk');
    if (bo + 8 + bl !== b.length) fail(where, 'trailing bytes / wrong BIN length');
    if (j.buffers[0].byteLength > bl || j.buffers[0].byteLength < bl - 3) fail(where, `buffers[0].byteLength ${j.buffers[0].byteLength} vs BIN ${bl}`);
    j.bufferViews.forEach((v, i) => {
      const o = v.byteOffset || 0;
      if (o + v.byteLength > bl) fail(where, `bufferView ${i} out of range`);
      if (o % 4) fail(where, `bufferView ${i} offset ${o} not 4-aligned`);
    });
    const used = j.extensionsUsed || [], req = j.extensionsRequired || [];
    const webpImgs = new Set();
    (j.images || []).forEach((im, i) => {
      const v = j.bufferViews[im.bufferView];
      const d = b.subarray(bo + 8 + (v.byteOffset || 0), bo + 8 + (v.byteOffset || 0) + v.byteLength);
      const isWebp = d.toString('latin1', 0, 4) === 'RIFF' && d.toString('latin1', 8, 12) === 'WEBP';
      const isJpg = d[0] === 0xff && d[1] === 0xd8, isPng = d[0] === 0x89 && d.toString('latin1', 1, 4) === 'PNG';
      if (isWebp) {
        webp++; webpImgs.add(i);
        if (im.mimeType !== 'image/webp') fail(where, `image ${i} is WebP data but mimeType ${im.mimeType}`);
        if (RIFFLEN(d) !== d.length) fail(where, `image ${i} RIFF size mismatch`);
      } else if (isJpg || isPng) {
        other++;
        if (im.mimeType !== (isJpg ? 'image/jpeg' : 'image/png')) fail(where, `image ${i} mimeType ${im.mimeType} does not match its data`);
      } else fail(where, `image ${i} unknown data`);
    });
    for (const [i, t] of (j.textures || []).entries()) {
      const e = t.extensions && t.extensions[EXT];
      if (e) {
        if (!webpImgs.has(e.source)) fail(where, `texture ${i} ${EXT}.source ${e.source} is not a WebP image`);
        if (t.source !== undefined) fail(where, `texture ${i} still has a plain source`);
      } else if (webpImgs.has(t.source)) fail(where, `texture ${i} points at a WebP image without ${EXT}`);
      else if (t.source === undefined) fail(where, `texture ${i} has no source`);
    }
    if (webpImgs.size) {
      if (!used.includes(EXT)) fail(where, `${EXT} missing from extensionsUsed`);
      if (!req.includes(EXT)) fail(where, `${EXT} missing from extensionsRequired`);
    } else if (used.includes(EXT) || req.includes(EXT)) fail(where, `${EXT} declared but no WebP image`);
    for (const r of req) if (!used.includes(r)) fail(where, `required ${r} not in extensionsUsed`);
    console.log(`ok   ${where}: ${j.images?.length || 0} images (${webpImgs.size} webp), used=${used.join(',') || '-'} required=${req.join(',') || '-'}`);
  }
}
function RIFFLEN(d) { return d.readUInt32LE(4) + 8; }
console.log(`${glbs} GLBs, ${webp} WebP + ${other} JPEG/PNG images, ${errors} problems`);
process.exit(errors ? 1 : 0);
