#!/usr/bin/env python3
"""Post-process the generated asset modules: re-encode textures as WebP to shrink the single-file bundle.

Run from anywhere:  python3 -I tools/recompress_assets.py [--dry-run] [--quiet] [--check]

Re-run it after every Blender export (the build_*.py / import_weapons.py scripts write JPEG/PNG textures).
It rewrites src/**/*_asset.js and src/game/weapons_glb.js IN PLACE and is idempotent: images that are
already WebP are skipped, and an image whose WebP would not be clearly smaller stays as it is.

What it touches
  * standalone data URIs   'data:image/jpeg|png;base64,...'  -> 'data:image/webp;base64,...'
    (also the raw-base64 terrain layer albedo/normal in lodge_asset.js, which become data URIs;
     terrain.js / mountain.js already pass 'data:' strings through untouched)
  * GLB base64 strings: embedded images -> WebP, texture.extensions.EXT_texture_webp, and
    extensionsUsed + extensionsRequired (three's GLTFLoader supports it; Android WebView / Chrome decode WebP)
What it never touches: the terrain 'splat' PNG (alpha = rock weight), height / grass grids, meshes, the
minimap PNG (its decoder hard-codes the PNG mime type).

Quality is searched per texture (lowest WebP quality that passes the class criterion, lossy encoder
method 6), and the texture is left alone if that is not at least MIN_GAIN smaller:
  color   PSNR vs the decoded source >= 38.5 dB
  gray    (AO) PSNR >= 38.5 dB
  alpha   (separate greyscale alpha, foliage cutouts) PSNR >= 42 dB and alpha-test mask flips <= 0.05 %
          at cutoffs 0.30 / 0.45 / 0.50
  rgba    (cutout colour with alpha) lossy with alpha_quality 100 + exact RGB under transparent texels,
          RGB PSNR (alpha > 0) >= 38.5 dB, alpha-test flips <= 0.05 %; else lossless
  normal  q >= 90 only; mean angular error <= 2.0 deg and p99 <= 20 deg vs the source (else JPEG stays);
          PNG normals -> lossless WebP
  orm     per-channel PSNR >= 40 dB (4:2:0 chroma would smear R / B); PNG -> lossless WebP
No texture is resized.
"""
import base64
import io
import json
import re
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
FILES = [
    'src/chars/soldier_asset.js',
    'src/chars/soldier2_asset.js',
    'src/world/foliage_asset.js',
    'src/world/vehicles_asset.js',
    'src/world/lodge_props_asset.js',
    'src/world/creatures_asset.js',
    'src/maps/lodge_asset.js',
    'src/game/weapons_glb.js',
]
NOTE = '// Post-processed by tools/recompress_assets.py (textures re-encoded as WebP). Re-run it after re-exporting.'
MIN_GAIN = 0.90        # keep the WebP only if size <= MIN_GAIN * original
SKIP_KEYS = {'splat', 'png', 'data', 'mesh'}   # never touched (splat alpha is data, png = minimap)
Q_LO, Q_HI = 60, 98     # never go below q60 (PSNR does not see banding); normals start at q90
ALPHA_CUTS = (0.30, 0.45, 0.50)
LOG = []


# ---------------------------------------------------------------- metrics
def psnr(a, b):
    d = a.astype(np.float32) - b.astype(np.float32)
    m = float((d * d).mean())
    return 99.0 if m == 0 else 10 * np.log10(255 * 255 / m)


def nvec(x):
    x = x.astype(np.float32) / 255 * 2 - 1
    x[..., 2] = np.sqrt(np.clip(1 - x[..., 0] ** 2 - x[..., 1] ** 2, 0, 1))
    return x / np.maximum(np.sqrt((x * x).sum(-1, keepdims=True)), 1e-6)


def ang_err(a, b, band=128):
    """Angle between the two decoded tangent-space normals, in degrees: (mean, p99).
    Processed in row bands (full-size temporaries segfaulted some macOS numpy builds)."""
    out = []
    for y in range(0, a.shape[0], band):
        c = np.clip((nvec(a[y:y + band]) * nvec(b[y:y + band])).sum(-1), -1, 1)
        out.append(np.degrees(np.arccos(c)).ravel())
    d = np.concatenate(out)
    return float(d.mean()), float(np.percentile(d, 99))


def flips(a, b):
    return max(float(((a >= c * 255) != (b >= c * 255)).mean()) for c in ALPHA_CUTS)


# ---------------------------------------------------------------- encoding
def webp(im, q, method=6, lossless=False, alpha=False):
    o = io.BytesIO()
    kw = dict(method=method)
    if lossless:
        im.save(o, 'WEBP', lossless=True, quality=100, exact=True, **kw)
    else:
        if alpha:
            kw.update(alpha_quality=100, exact=True)
        im.save(o, 'WEBP', quality=q, **kw)
    return o.getvalue()


def dec(b, mode):
    return np.array(Image.open(io.BytesIO(b)).convert(mode))


def ok_fn(kind, src_im, has_alpha):
    """Returns (mode, check(decoded_array) -> bool, describe(decoded_array) -> str)."""
    if kind == 'alpha':
        s = np.array(src_im.convert('L'))
        return 'L', (lambda r: psnr(s, r) >= 42 and flips(s, r) <= 0.0005), (lambda r: '%.1fdB flips %.4f%%' % (psnr(s, r), 100 * flips(s, r)))
    if kind == 'gray':
        s = np.array(src_im.convert('L'))
        return 'L', (lambda r: psnr(s, r) >= 38.5), (lambda r: '%.1fdB' % psnr(s, r))
    if kind == 'normal':
        s = np.array(src_im.convert('RGB'))
        return 'RGB', (lambda r: (lambda e: e[0] <= 2.0 and e[1] <= 20)(ang_err(s, r))), (lambda r: 'ang %.2f/p99 %.1f' % ang_err(s, r))
    if kind == 'orm':
        s = np.array(src_im.convert('RGB'))
        mn = lambda r: min(psnr(s[..., c], r[..., c]) for c in range(3))
        return 'RGB', (lambda r: mn(r) >= 40), (lambda r: 'min-ch %.1fdB' % mn(r))
    if has_alpha:
        s = np.array(src_im.convert('RGBA'))
        m = s[..., 3] > 0
        def rgb(r):
            return psnr(s[..., :3][m], r[..., :3][m]) if m.any() else 99
        return 'RGBA', (lambda r: rgb(r) >= 38.5 and flips(s[..., 3], r[..., 3]) <= 0.0005), (lambda r: 'rgb %.1fdB flips %.4f%%' % (rgb(r), 100 * flips(s[..., 3], r[..., 3])))
    s = np.array(src_im.convert('RGB'))
    return 'RGB', (lambda r: psnr(s, r) >= 38.5), (lambda r: '%.1fdB' % psnr(s, r))


def recompress(data, kind, label):
    """data: original JPEG/PNG bytes. Returns WebP bytes or None (keep). Logs one line."""
    im = Image.open(io.BytesIO(data))
    is_png = im.format == 'PNG'
    has_alpha = im.mode in ('RGBA', 'LA') or (im.mode == 'P' and 'transparency' in im.info)
    if im.mode == 'P':
        im = im.convert('RGBA' if has_alpha else 'RGB')
    if kind == 'color' and has_alpha:
        kind = 'rgba'
    pil = im.convert('L' if kind in ('alpha', 'gray') else ('RGBA' if has_alpha else 'RGB'))
    mode, check, describe = ok_fn(kind, im, has_alpha)

    def enc(q, method):
        return webp(pil, q, method, alpha=has_alpha)

    # PNG data textures (normal / orm) -> lossless; everything else lossy search
    if is_png and kind in ('normal', 'orm'):
        best, q = webp(pil, 0, 6, lossless=True), 'lossless'
        desc = 'bit-exact'
    else:
        lo, hi, best_q = (90 if kind == 'normal' else Q_LO), Q_HI, None
        if not check(dec(enc(hi, 4), mode)):
            if is_png:
                best, q, desc = webp(pil, 0, 6, lossless=True), 'lossless', 'bit-exact'
                return finish(label, kind, im, data, best, q, desc)
            LOG.append('%-34s %-6s %4dx%-4d %7d B  KEEP (no WebP quality <= %d passes)' % (label, kind, im.width, im.height, len(data), Q_HI))
            return None
        while lo < hi:
            mid = (lo + hi) // 2
            if check(dec(enc(mid, 4), mode)):
                hi = mid
            else:
                lo = mid + 1
        best_q = lo
        best = enc(best_q, 6)
        if not check(dec(best, mode)):          # method 6 is not guaranteed to match method 4
            best_q = min(Q_HI, best_q + 2)
            best = enc(best_q, 6)
        q, desc = 'q%d' % best_q, describe(dec(best, mode))
    return finish(label, kind, im, data, best, q, desc)


def finish(label, kind, im, data, best, q, desc):
    if len(best) > MIN_GAIN * len(data):
        LOG.append('%-34s %-6s %4dx%-4d %7d B  KEEP (webp %s = %d B, not >%d%% smaller)' % (label, kind, im.width, im.height, len(data), q, len(best), round((1 - MIN_GAIN) * 100)))
        return None
    LOG.append('%-34s %-6s %4dx%-4d %7d -> %7d B  %s  %s' % (label, kind, im.width, im.height, len(data), len(best), q, desc))
    return best


def kind_of_name(name):
    n = name.lower()
    if re.search(r'normal|(^|_)n$|[a-z]n$', n) and 'ao' not in n:
        return 'normal'
    if 'orm' in n:
        return 'orm'
    if n.endswith('ao'):
        return 'gray'
    if re.search(r'[a-z]A$', name) and name[:-1].lower() in ('leaf', 'pl', 'imp', 'bark'):
        return 'alpha'
    return 'color'


# ---------------------------------------------------------------- GLB
def split_glb(b):
    magic, ver, total = struct.unpack('<4sII', b[:12])
    assert magic == b'glTF' and ver == 2 and total == len(b)
    jl, jt = struct.unpack('<I4s', b[12:20])
    assert jt == b'JSON'
    j = json.loads(b[20:20 + jl])
    off = 20 + jl
    bl, bt = struct.unpack('<I4s', b[off:off + 8])
    assert bt == b'BIN\0'
    return j, b[off + 8:off + 8 + bl]


def join_glb(j, bin_):
    js = json.dumps(j, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    bin_ = bin_ + b'\0' * (-len(bin_) % 4)
    total = 12 + 8 + len(js) + 8 + len(bin_)
    return (struct.pack('<4sII', b'glTF', 2, total) + struct.pack('<I4s', len(js), b'JSON') + js
            + struct.pack('<I4s', len(bin_), b'BIN\0') + bin_)


def image_roles(j):
    roles = {}
    def mark(tex, role):
        if tex is None:
            return
        src = j['textures'][tex['index']]
        s = src.get('source')
        if s is None:
            s = src.get('extensions', {}).get('EXT_texture_webp', {}).get('source')
        if s is not None:
            roles.setdefault(s, set()).add(role)
    for m in j.get('materials', []):
        p = m.get('pbrMetallicRoughness', {})
        mark(p.get('baseColorTexture'), 'color')
        mark(p.get('metallicRoughnessTexture'), 'orm')
        mark(m.get('normalTexture'), 'normal')
        mark(m.get('occlusionTexture'), 'orm')
        mark(m.get('emissiveTexture'), 'color')
    return roles


def process_glb(b64, label):
    raw = base64.b64decode(b64)
    j, bin_ = split_glb(raw)
    images = j.get('images', [])
    if not images:
        return None
    roles = image_roles(j)
    views = j['bufferViews']
    new_img = {}
    for i, im in enumerate(images):
        if im.get('mimeType') == 'image/webp':
            continue
        bv = views[im['bufferView']]
        data = bin_[bv['byteOffset']:bv['byteOffset'] + bv['byteLength']]
        r = roles.get(i, {'color'})
        kind = 'normal' if 'normal' in r else 'orm' if 'orm' in r else 'color'
        out = recompress(data, kind, '%s img%d%s' % (label, i, (' ' + images[i]['name']) if images[i].get('name') else ''))
        if out is not None:
            new_img[i] = out
    if not new_img:
        return None
    # rebuild BIN: same bufferView order, 4-byte aligned, image payloads swapped
    order = sorted(range(len(views)), key=lambda k: views[k].get('byteOffset', 0))
    end = 0
    for k in order:                                     # sanity: views must not overlap
        assert views[k].get('byteOffset', 0) >= end, 'overlapping bufferViews'
        end = views[k].get('byteOffset', 0) + views[k]['byteLength']
    assert len(j['buffers']) == 1 and all(v['buffer'] == 0 for v in views)
    img_view = {im['bufferView']: i for i, im in enumerate(images) if 'bufferView' in im}
    assert len(img_view) == sum('bufferView' in im for im in images)
    out, newoff = bytearray(), {}
    for k in order:
        v = views[k]
        payload = new_img[img_view[k]] if k in img_view and img_view[k] in new_img else bin_[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']]
        out += b'\0' * (-len(out) % 4)
        newoff[k] = (len(out), len(payload))
        out += payload
    for k, (o, n) in newoff.items():
        views[k]['byteOffset'], views[k]['byteLength'] = o, n
    j['buffers'][0]['byteLength'] = len(out) + (-len(out) % 4)
    for i in new_img:
        images[i]['mimeType'] = 'image/webp'
    for t in j['textures']:
        if t.get('source') in new_img:
            t.setdefault('extensions', {})['EXT_texture_webp'] = {'source': t.pop('source')}
    for key in ('extensionsUsed', 'extensionsRequired'):
        lst = j.setdefault(key, [])
        if 'EXT_texture_webp' not in lst:
            lst.append('EXT_texture_webp')
    return base64.b64encode(join_glb(j, bytes(out))).decode()


# ---------------------------------------------------------------- module rewriting
BLOB = re.compile(r'(data:image/(?:jpeg|png|webp);base64,)?([A-Za-z0-9+/]{4000,}={0,2})')


def key_before(text, pos):
    m = re.search(r'''(\w+)["']?\s*[:=]\s*["']?$''', text[max(0, pos - 90):pos])
    return m.group(1) if m else ''


def process_module(path):
    text = path.read_text()
    stem = path.stem
    pieces, last, changed = [], 0, False
    for m in BLOB.finditer(text):
        prefix, b64 = m.group(1), m.group(2)
        start = m.start()
        key = key_before(text, start)
        if key in SKIP_KEYS:
            continue
        head = base64.b64decode(b64[:16] + '=' * (-len(b64[:16]) % 4))[:4]
        label = '%s:%s' % (stem, key)
        if head == b'glTF':
            repl = process_glb(b64, label)
        elif head[:2] == b'\xff\xd8' or head == b'\x89PNG':
            if key == 'albedo' or key == 'normal':
                layer = re.findall(r'"name":"(\w+)"', text[:start])
                label = '%s:%s.%s' % (stem, layer[-1] if layer else '?', key)
            kind = 'normal' if key == 'normal' else kind_of_name(key)
            out = recompress(base64.b64decode(b64), kind, label)
            repl = None if out is None else base64.b64encode(out).decode()
        else:
            continue          # WebP already, or not an image (mesh / grids)
        if repl is None:
            continue
        pieces.append(text[last:start])
        pieces.append(repl if head == b'glTF' else 'data:image/webp;base64,' + repl)
        last = m.end()
        changed = True
    if not changed:
        return False, len(text), len(text)
    pieces.append(text[last:])
    out = ''.join(pieces)
    if NOTE not in out:
        lines = out.split('\n', 1)
        out = lines[0] + '\n' + NOTE + '\n' + lines[1]
    return out, len(text.encode()), len(out.encode())


def check():
    """--check: decode every WebP image (standalone and inside GLBs) with Pillow; nonzero exit on failure."""
    n = bad = 0
    for rel in FILES:
        text = (ROOT / rel).read_text()
        for m in BLOB.finditer(text):
            raw = base64.b64decode(m.group(2))
            blobs = []
            if raw[:4] == b'glTF':
                j, bin_ = split_glb(raw)
                for im in j.get('images', []):
                    v = j['bufferViews'][im['bufferView']]
                    blobs.append((im.get('mimeType'), bin_[v['byteOffset']:v['byteOffset'] + v['byteLength']]))
            elif raw[:4] == b'RIFF':
                blobs.append(('image/webp', raw))
            for mime, b in blobs:
                if mime != 'image/webp':
                    continue
                n += 1
                try:
                    im = Image.open(io.BytesIO(b))
                    assert im.format == 'WEBP'
                    im.load()
                except Exception as e:      # noqa: BLE001
                    bad += 1
                    print('DECODE FAIL', rel, e)
    print('decoded %d WebP images, %d failures' % (n, bad))
    sys.exit(1 if bad else 0)


def main():
    if '--check' in sys.argv:
        check()
    dry = '--dry-run' in sys.argv
    quiet = '--quiet' in sys.argv
    tot0 = tot1 = 0
    for rel in FILES:
        p = ROOT / rel
        before = p.stat().st_size
        res, _, _ = process_module(p)
        after = before
        if res:
            after = len(res.encode())
            if not dry:
                p.write_text(res)
        tot0 += before
        tot1 += after
        print('%-34s %9d -> %9d B' % (rel, before, after))
    if not quiet:
        print('\n'.join(LOG))
    print('modules total %d -> %d B%s' % (tot0, tot1, ' (dry run, nothing written)' if dry else ''))


if __name__ == '__main__':
    main()
