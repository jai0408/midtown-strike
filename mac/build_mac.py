#!/usr/bin/env python3
"""
Packs the macOS app:  dist/MidtownStrike-mac.zip  ->  "Midtown Strike.app"

The app is a plain bundle: Info.plist, an icon, the single-file game and a
small launcher script as its executable, so it can be assembled on any
operating system with nothing but Python 3. No Xcode, no code signing.

  python3 mac/build_mac.py            # after `npm run build`

Regenerating the icon (only when the artwork changes) needs Playwright and
Pillow:  node mac/make_icon.mjs && python3 mac/build_mac.py --icon
"""
import argparse
import json
import os
import plistlib
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GAME = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'game', 'index.html')
APP = 'Midtown Strike.app'


def make_icns():
    from PIL import Image  # only needed for --icon
    im = Image.open(os.path.join(HERE, 'AppIcon.png')).convert('RGBA')
    im.save(os.path.join(HERE, 'AppIcon.icns'), sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--icon', action='store_true', help='rebuild AppIcon.icns from AppIcon.png first')
    ap.add_argument('--out', default=os.path.join(ROOT, 'dist', 'MidtownStrike-mac.zip'))
    args = ap.parse_args()
    if args.icon:
        make_icns()
    if not os.path.isfile(GAME):
        raise SystemExit('game bundle not found; run `npm run build` first')
    with open(os.path.join(ROOT, 'package.json'), encoding='utf-8') as fh:
        version = json.load(fh)['version']
    with open(os.path.join(HERE, 'Info.plist'), encoding='utf-8') as fh:
        plist = fh.read().replace('__VERSION__', version).encode('utf-8')
    info = plistlib.loads(plist)  # fails loudly on a malformed plist
    exe = info['CFBundleExecutable']

    def read(path):
        with open(path, 'rb') as fh:
            return fh.read()

    files = [
        ('Contents/Info.plist', plist, 0o644),
        ('Contents/PkgInfo', b'APPL????', 0o644),
        ('Contents/MacOS/' + exe, read(os.path.join(HERE, 'launcher.sh')), 0o755),
        ('Contents/Resources/' + info['CFBundleIconFile'] + '.icns', read(os.path.join(HERE, 'AppIcon.icns')), 0o644),
        ('Contents/Resources/game/index.html', read(GAME), 0o644),
    ]
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    stamp = (2024, 1, 1, 0, 0, 0)  # fixed, so the archive is reproducible
    with zipfile.ZipFile(args.out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        dirs = set()
        for name, _, _ in files:
            parts = (APP + '/' + name).split('/')[:-1]
            for i in range(1, len(parts) + 1):
                dirs.add('/'.join(parts[:i]) + '/')
        for d in sorted(dirs):
            zi = zipfile.ZipInfo(d, date_time=stamp)
            zi.create_system = 3                       # Unix: keep the permission bits
            zi.external_attr = (0o40755 << 16) | 0x10
            zf.writestr(zi, b'')
        for name, data, mode in files:
            zi = zipfile.ZipInfo(APP + '/' + name, date_time=stamp)
            zi.create_system = 3
            zi.external_attr = (0o100000 | mode) << 16
            zi.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(zi, data, compresslevel=9)
    print('[build_mac] %s %s -> %s (%.2f MB)' % (APP, version, os.path.abspath(args.out), os.path.getsize(args.out) / 1e6))


if __name__ == '__main__':
    main()
