#!/usr/bin/env python3
"""
Builds a signed, installable APK without the Android SDK.

The usual toolchain (aapt2, d8, zipalign, apksigner) ships only with the SDK.
This script covers the same steps for this small app with pieces that come
from Maven Central plus a few hundred lines of Python:

  resources   -> a minimal aapt replacement below (binary XML + resources.arsc)
  javac       -> the JDK, against the public Android API stub jar
  dex         -> AOSP dx (tools/lib, resolved by tools/pom.xml)
  zipalign    -> done while writing the zip
  signing     -> Google's apksig (APK Signature Scheme v2), driven by tools/SignApk.java

Usage:  python3 build_apk.py [--out ../dist/MidtownStrike.apk]

If you have the Android SDK, the Gradle project in this directory builds the
same sources the conventional way (./gradlew assembleDebug).
"""
import argparse
import os
import re
import shutil
import struct
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
MAIN = os.path.join(HERE, 'app', 'src', 'main')
TOOLS = os.path.join(HERE, 'tools')
LIB = os.path.join(TOOLS, 'lib')
BUILD = os.path.join(HERE, 'build', 'nosdk')

ANDROID_NS = 'http://schemas.android.com/apk/res/android'
APP_PACKAGE_ID = 0x7F

# ---------------------------------------------------------------------------
# Framework constants (android.R.attr / android.R.style). Values are checked
# against the stub jar at build time by verify_framework_ids().
# ---------------------------------------------------------------------------
ATTRS = {
    'theme': (0x01010000, 'ref'),
    'label': (0x01010001, 'string'),
    'icon': (0x01010002, 'ref'),
    'name': (0x01010003, 'string'),
    'exported': (0x01010010, 'bool'),
    'launchMode': (0x0101001D, 'enum'),
    'screenOrientation': (0x0101001E, 'enum'),
    'configChanges': (0x0101001F, 'flags'),
    'drawable': (0x01010199, 'ref'),
    'minSdkVersion': (0x0101020C, 'int'),
    'versionCode': (0x0101021B, 'int'),
    'versionName': (0x0101021C, 'string'),
    'targetSdkVersion': (0x01010270, 'int'),
    'allowBackup': (0x01010280, 'bool'),
    'glEsVersion': (0x01010281, 'int'),
    'required': (0x0101028E, 'bool'),
    'hardwareAccelerated': (0x010102D3, 'bool'),
    'largeHeap': (0x0101035A, 'bool'),
}
ENUMS = {
    'launchMode': {'standard': 0, 'singleTop': 1, 'singleTask': 2, 'singleInstance': 3},
    'screenOrientation': {
        'unspecified': -1, 'landscape': 0, 'portrait': 1, 'user': 2, 'behind': 3,
        'sensor': 4, 'nosensor': 5, 'sensorLandscape': 6, 'sensorPortrait': 7,
        'reverseLandscape': 8, 'reversePortrait': 9, 'fullSensor': 10,
        'userLandscape': 11, 'userPortrait': 12, 'fullUser': 13, 'locked': 14,
    },
    'configChanges': {
        'mcc': 0x0001, 'mnc': 0x0002, 'locale': 0x0004, 'touchscreen': 0x0008,
        'keyboard': 0x0010, 'keyboardHidden': 0x0020, 'navigation': 0x0040,
        'orientation': 0x0080, 'screenLayout': 0x0100, 'uiMode': 0x0200,
        'screenSize': 0x0400, 'smallestScreenSize': 0x0800, 'density': 0x1000,
        'layoutDirection': 0x2000, 'fontScale': 0x40000000,
    },
}
FRAMEWORK_REFS = {
    '@android:style/Theme.NoTitleBar.Fullscreen': 0x01030007,
    '@android:style/Theme.Black.NoTitleBar.Fullscreen': 0x0103000A,
}

TYPE_REFERENCE, TYPE_STRING = 0x01, 0x03
TYPE_INT_DEC, TYPE_INT_HEX, TYPE_INT_BOOLEAN = 0x10, 0x11, 0x12

DENSITIES = {'ldpi': 120, 'mdpi': 160, 'tvdpi': 213, 'hdpi': 240, 'xhdpi': 320,
             'xxhdpi': 480, 'xxxhdpi': 640, 'anydpi': 0xFFFE, 'nodpi': 0xFFFF}
CONFIG_DENSITY, CONFIG_VERSION = 0x0100, 0x0400


def log(msg):
    print('[build_apk] ' + msg, flush=True)


def run(cmd, **kw):
    env = dict(os.environ)
    env.pop('JAVA_TOOL_OPTIONS', None)  # keeps tool output clean; no network needed here
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env, **kw)
    if r.returncode != 0:
        sys.stderr.write(r.stdout)
        raise SystemExit('command failed: ' + ' '.join(cmd))
    return r.stdout


# ---------------------------------------------------------------------------
# String pool (UTF-16), shared by binary XML and the resource table
# ---------------------------------------------------------------------------
def string_pool(strings):
    offsets, data = [], b''
    for s in strings:
        offsets.append(len(data))
        units = s.encode('utf-16-le')
        n = len(units) // 2
        if n >= 0x8000:
            raise ValueError('string too long for this encoder')
        data += struct.pack('<H', n) + units + b'\x00\x00'
    data += b'\x00' * (-len(data) % 4)
    header_size = 28
    strings_start = header_size + 4 * len(strings)
    size = strings_start + len(data)
    out = struct.pack('<HHIIIIII', 0x0001, header_size, size, len(strings), 0, 0, strings_start, 0)
    out += b''.join(struct.pack('<I', o) for o in offsets) + data
    return out


# ---------------------------------------------------------------------------
# Binary XML (AXML) compiler
# ---------------------------------------------------------------------------
class XmlCompiler:
    def __init__(self, resolve_ref):
        self.resolve_ref = resolve_ref
        self.attr_names = {}   # res id -> name; these lead the string pool
        self.strings = []      # all other strings, in first-use order
        self.index = {}

    def _str(self, s):
        if s not in self.index:
            self.index[s] = len(self.strings)
            self.strings.append(s)
        return ('s', s)

    def _attr(self, name):
        res_id = ATTRS[name][0]
        self.attr_names[res_id] = name
        return ('a', res_id)

    def _value(self, name, kind, raw):
        if kind == 'string':
            return TYPE_STRING, self._str(raw), self._str(raw)
        if kind == 'ref':
            return TYPE_REFERENCE, self.resolve_ref(raw), None
        if kind == 'bool':
            if raw not in ('true', 'false'):
                raise ValueError('bad boolean for %s: %s' % (name, raw))
            return TYPE_INT_BOOLEAN, 0xFFFFFFFF if raw == 'true' else 0, None
        if kind == 'int':
            if raw.lower().startswith('0x'):
                return TYPE_INT_HEX, int(raw, 16), None
            return TYPE_INT_DEC, int(raw) & 0xFFFFFFFF, None
        if kind == 'enum':
            return TYPE_INT_DEC, ENUMS[name][raw] & 0xFFFFFFFF, None
        if kind == 'flags':
            v = 0
            for part in raw.split('|'):
                v |= ENUMS[name][part.strip()]
            return TYPE_INT_HEX, v, None
        raise ValueError(kind)

    def compile(self, path):
        root = ET.parse(path).getroot()
        nodes = []
        self._walk(root, nodes)
        ns_prefix, ns_uri = self._str('android'), self._str(ANDROID_NS)

        # Final pool: attribute names (sorted by resource id) first so that
        # pool index i lines up with resource-map entry i.
        res_ids = sorted(self.attr_names)
        pool = [self.attr_names[i] for i in res_ids] + self.strings
        base = len(res_ids)

        def ref(x):
            if x is None:
                return 0xFFFFFFFF
            kind, key = x
            return res_ids.index(key) if kind == 'a' else base + self.index[key]

        body = struct.pack('<HHIIIII', 0x0100, 16, 24, 1, 0xFFFFFFFF, ref(ns_prefix), ref(ns_uri))
        for node in nodes:
            if node[0] == 'start':
                _, tag, attrs = node
                chunk = struct.pack('<HHIII', 0x0102, 16, 36 + 20 * len(attrs), 1, 0xFFFFFFFF)
                chunk += struct.pack('<IIHHHHHH', 0xFFFFFFFF, ref(tag), 20, 20, len(attrs), 0, 0, 0)
                for ns, name, raw, dtype, data in attrs:
                    data_val = ref(data) if isinstance(data, tuple) else data
                    chunk += struct.pack('<IIIHBBI', ref(ns), ref(name), ref(raw), 8, 0, dtype, data_val)
                body += chunk
            else:
                body += struct.pack('<HHIIIII', 0x0103, 16, 24, 1, 0xFFFFFFFF, 0xFFFFFFFF, ref(node[1]))
        body += struct.pack('<HHIIIII', 0x0101, 16, 24, 1, 0xFFFFFFFF, ref(ns_prefix), ref(ns_uri))

        res_map = struct.pack('<HHI', 0x0180, 8, 8 + 4 * len(res_ids))
        res_map += b''.join(struct.pack('<I', i) for i in res_ids)
        payload = string_pool(pool) + res_map + body
        return struct.pack('<HHI', 0x0003, 8, 8 + len(payload)) + payload

    def _walk(self, el, nodes):
        tag = self._str(el.tag)
        with_id, without_id = [], []
        for key, raw in el.attrib.items():
            if key.startswith('{' + ANDROID_NS + '}'):
                name = key.split('}', 1)[1]
                if name not in ATTRS:
                    raise SystemExit('unsupported attribute android:%s (add it to ATTRS)' % name)
                res_id, kind = ATTRS[name]
                dtype, data, rawref = self._value(name, kind, raw)
                with_id.append((res_id, (self._str(ANDROID_NS), self._attr(name), rawref, dtype, data)))
            elif key.startswith('{'):
                raise SystemExit('unsupported namespace on attribute ' + key)
            else:
                s = self._str(raw)
                without_id.append((key, (None, self._str(key), s, TYPE_STRING, s)))
        # The platform's attribute lookup expects ascending resource ids.
        attrs = [a for _, a in sorted(with_id, key=lambda t: t[0])]
        attrs += [a for _, a in sorted(without_id, key=lambda t: t[0])]
        nodes.append(('start', tag, attrs))
        for child in el:
            self._walk(child, nodes)
        nodes.append(('end', tag))


# ---------------------------------------------------------------------------
# resources.arsc writer (file resources only: drawables, mipmaps)
# ---------------------------------------------------------------------------
def parse_res_dir(dirname):
    """'mipmap-anydpi-v26' -> ('mipmap', density, sdk_version)"""
    parts = dirname.split('-')
    rtype, density, sdk = parts[0], 0, 0
    for q in parts[1:]:
        if q in DENSITIES:
            density = DENSITIES[q]
        elif re.fullmatch(r'v\d+', q):
            sdk = int(q[1:])
        else:
            raise SystemExit('unsupported resource qualifier: ' + dirname)
    if density and not sdk:
        sdk = 4  # density qualifiers imply API 4, as aapt records it
    return rtype, density, sdk


def collect_resources(res_root):
    """-> {type: {entry: [(density, sdk, apk_path, src_path)]}}"""
    table = {}
    for d in sorted(os.listdir(res_root)):
        full = os.path.join(res_root, d)
        if not os.path.isdir(full):
            continue
        rtype, density, sdk = parse_res_dir(d)
        for f in sorted(os.listdir(full)):
            name = f.split('.', 1)[0]
            table.setdefault(rtype, {}).setdefault(name, []).append(
                (density, sdk, 'res/%s/%s' % (d, f), os.path.join(full, f)))
    return table


def res_config(density, sdk):
    cfg = bytearray(64)
    struct.pack_into('<I', cfg, 0, 64)
    struct.pack_into('<H', cfg, 14, density)
    struct.pack_into('<H', cfg, 24, sdk)
    return bytes(cfg)


def build_arsc(package, table):
    type_names = sorted(table)
    ids, values = {}, []
    for ti, t in enumerate(type_names):
        for ei, e in enumerate(sorted(table[t])):
            ids['@%s/%s' % (t, e)] = (APP_PACKAGE_ID << 24) | ((ti + 1) << 16) | ei
            for _, _, apk_path, _ in table[t][e]:
                values.append(apk_path)
    key_names = sorted({e for t in type_names for e in table[t]})

    chunks = b''
    for ti, t in enumerate(type_names):
        entries = sorted(table[t])
        spec_flags = []
        for e in entries:
            cfgs = table[t][e]
            flags = 0
            if len({c[0] for c in cfgs}) > 1:
                flags |= CONFIG_DENSITY
            if len({c[1] for c in cfgs}) > 1:
                flags |= CONFIG_VERSION
            spec_flags.append(flags)
        chunks += struct.pack('<HHIBBHI', 0x0202, 16, 16 + 4 * len(entries), ti + 1, 0, 0, len(entries))
        chunks += b''.join(struct.pack('<I', f) for f in spec_flags)

        for density, sdk in sorted({(c[0], c[1]) for e in entries for c in table[t][e]}):
            offsets, data = [], b''
            for e in entries:
                match = [c for c in table[t][e] if (c[0], c[1]) == (density, sdk)]
                if not match:
                    offsets.append(0xFFFFFFFF)
                    continue
                offsets.append(len(data))
                data += struct.pack('<HHI', 8, 0, key_names.index(e))
                data += struct.pack('<HBBI', 8, 0, TYPE_STRING, values.index(match[0][2]))
            header_size = 20 + 64
            entries_start = header_size + 4 * len(entries)
            chunks += struct.pack('<HHIBBHII', 0x0201, header_size, entries_start + len(data),
                                  ti + 1, 0, 0, len(entries), entries_start)
            chunks += res_config(density, sdk)
            chunks += b''.join(struct.pack('<I', o) for o in offsets) + data

    type_pool, key_pool = string_pool(type_names), string_pool(key_names)
    pkg_header_size = 288
    name16 = package.encode('utf-16-le')
    name16 += b'\x00' * (256 - len(name16))
    pkg_size = pkg_header_size + len(type_pool) + len(key_pool) + len(chunks)
    pkg = struct.pack('<HHII', 0x0200, pkg_header_size, pkg_size, APP_PACKAGE_ID) + name16
    pkg += struct.pack('<IIIII', pkg_header_size, len(type_names),
                       pkg_header_size + len(type_pool), len(key_names), 0)
    pkg += type_pool + key_pool + chunks

    value_pool = string_pool(values)
    arsc = struct.pack('<HHII', 0x0002, 12, 12 + len(value_pool) + len(pkg), 1) + value_pool + pkg
    return arsc, ids


# ---------------------------------------------------------------------------
# Zip writer with zipalign semantics (stored entries start on 4-byte bounds)
# ---------------------------------------------------------------------------
STORED_EXT = ('.png', '.jpg', '.webp', '.ogg', '.mp3', '.arsc')


def write_apk(path, entries):
    """entries: [(name, bytes)]"""
    with zipfile.ZipFile(path, 'w') as zf:
        for name, data in entries:
            info = zipfile.ZipInfo(name, date_time=(2024, 1, 1, 0, 0, 0))
            info.external_attr = 0o644 << 16
            if name.endswith(STORED_EXT):
                info.compress_type = zipfile.ZIP_STORED
                pad = -(zf.fp.tell() + 30 + len(name.encode('utf-8'))) % 4
                info.extra = b'\x00' * pad
            else:
                info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, data, compresslevel=9)


def check_alignment(path):
    bad = []
    with open(path, 'rb') as fh, zipfile.ZipFile(path) as zf:
        for info in zf.infolist():
            if info.compress_type != zipfile.ZIP_STORED:
                continue
            fh.seek(info.header_offset + 26)
            name_len, extra_len = struct.unpack('<HH', fh.read(4))
            if (info.header_offset + 30 + name_len + extra_len) % 4:
                bad.append(info.filename)
    return bad


# ---------------------------------------------------------------------------
# Self-checks
# ---------------------------------------------------------------------------
def verify_framework_ids(android_jar):
    """Cross-check ATTRS / FRAMEWORK_REFS against android.R in the stub jar."""
    out = run(['javap', '-constants', '-cp', android_jar, 'android.R$attr', 'android.R$style'])
    consts = {m.group(1): int(m.group(2)) for m in re.finditer(r'int (\w+) = (\d+);', out)}
    for name, (res_id, _) in ATTRS.items():
        if consts.get(name) != res_id:
            raise SystemExit('attr id mismatch for %s: %r' % (name, consts.get(name)))
    for ref, res_id in FRAMEWORK_REFS.items():
        key = ref.split('/', 1)[1].replace('.', '_')
        if consts.get(key) != res_id:
            raise SystemExit('style id mismatch for %s' % ref)


def dump_axml(data):
    """Tiny independent reader used to sanity-check what the compiler wrote."""
    assert struct.unpack_from('<HH', data, 0) == (0x0003, 8)
    assert struct.unpack_from('<I', data, 4)[0] == len(data)
    pos, strings, res_map, lines, depth = 8, [], [], [], 0
    while pos < len(data):
        ctype, hsize, size = struct.unpack_from('<HHI', data, pos)
        if ctype == 0x0001:
            count, _, flags, sstart, _ = struct.unpack_from('<IIIII', data, pos + 8)
            assert flags == 0
            for i in range(count):
                off = pos + sstart + struct.unpack_from('<I', data, pos + 28 + 4 * i)[0]
                n = struct.unpack_from('<H', data, off)[0]
                strings.append(data[off + 2:off + 2 + 2 * n].decode('utf-16-le'))
        elif ctype == 0x0180:
            res_map = list(struct.unpack_from('<%dI' % ((size - 8) // 4), data, pos + 8))
        elif ctype == 0x0102:
            name = strings[struct.unpack_from('<I', data, pos + 20)[0]]
            astart, asize, acount = struct.unpack_from('<HHH', data, pos + 24)
            attrs, last = [], 0
            for i in range(acount):
                ns, nm, raw, _, _, dtype, val = struct.unpack_from('<IIIHBBI', data, pos + 16 + astart + asize * i)
                rid = res_map[nm] if nm < len(res_map) else None
                if rid is not None:
                    assert rid >= last, 'attributes not sorted by resource id'
                    last = rid
                    assert strings[ns] == ANDROID_NS
                shown = strings[val] if dtype == TYPE_STRING else '0x%08x(type %#x)' % (val, dtype)
                attrs.append('%s%s=%s' % ('android:' if rid else '', strings[nm], shown))
            lines.append('  ' * depth + '<' + name + ' ' + ' '.join(attrs) + '>')
            depth += 1
        elif ctype == 0x0103:
            depth -= 1
        pos += size
    assert depth == 0 and pos == len(data)
    return '\n'.join(lines)


# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(HERE, '..', 'dist', 'MidtownStrike.apk'))
    ap.add_argument('--keystore', default=os.path.join(HERE, 'debug.keystore'))
    ap.add_argument('--verbose', action='store_true')
    args = ap.parse_args()

    jars = {n: None for n in ('android', 'dalvik-dx', 'apksig')}
    if os.path.isdir(LIB):
        for f in os.listdir(LIB):
            for n in jars:
                if f.startswith(n + '-') and f.endswith('.jar'):
                    jars[n] = os.path.join(LIB, f)
    if not all(jars.values()):
        raise SystemExit('missing tool jars; run:  (cd tools && mvn -q dependency:copy-dependencies '
                         '-DoutputDirectory=lib)')

    game = os.path.join(MAIN, 'assets', 'game', 'index.html')
    if not os.path.isfile(game):
        raise SystemExit('assets/game/index.html not found; run `npm run build` in midtown-strike/ first')

    shutil.rmtree(BUILD, ignore_errors=True)
    os.makedirs(BUILD)
    verify_framework_ids(jars['android'])

    # 1. resources
    manifest_src = os.path.join(MAIN, 'AndroidManifest.xml')
    package = ET.parse(manifest_src).getroot().attrib['package']
    table = collect_resources(os.path.join(MAIN, 'res'))
    arsc, res_ids = build_arsc(package, table)

    def resolve_ref(ref):
        if ref in FRAMEWORK_REFS:
            return FRAMEWORK_REFS[ref]
        if ref in res_ids:
            return res_ids[ref]
        raise SystemExit('unresolved resource reference: ' + ref)

    manifest = XmlCompiler(resolve_ref).compile(manifest_src)
    entries = [('AndroidManifest.xml', manifest)]
    log('manifest: %d bytes, resources.arsc: %d bytes, %d resource ids' % (len(manifest), len(arsc), len(res_ids)))
    if args.verbose:
        print(dump_axml(manifest))
    else:
        dump_axml(manifest)

    # 2. javac + dx
    stubs_out, classes_out = os.path.join(BUILD, 'stubs'), os.path.join(BUILD, 'classes')
    os.makedirs(stubs_out)
    os.makedirs(classes_out)
    stub_srcs = [os.path.join(r, f) for r, _, fs in os.walk(os.path.join(HERE, 'stubs')) for f in fs if f.endswith('.java')]
    srcs = [os.path.join(r, f) for r, _, fs in os.walk(os.path.join(MAIN, 'java')) for f in fs if f.endswith('.java')]
    javac = ['javac', '-nowarn', '-Xlint:-options', '--release', '8', '-encoding', 'UTF-8']
    run(javac + ['-cp', jars['android'], '-d', stubs_out] + stub_srcs)
    run(javac + ['-cp', jars['android'] + os.pathsep + stubs_out, '-d', classes_out] + srcs)
    dex = os.path.join(BUILD, 'classes.dex')
    run(['java', '-cp', jars['dalvik-dx'], 'com.android.dx.command.Main', '--dex',
         '--min-sdk-version=24', '--output=' + dex, classes_out])
    with open(dex, 'rb') as fh:
        dex_bytes = fh.read()
    assert dex_bytes[:4] == b'dex\n' and zlib.adler32(dex_bytes[12:]) == struct.unpack_from('<I', dex_bytes, 8)[0]
    entries.append(('classes.dex', dex_bytes))
    log('classes.dex: %d bytes (dex version %s)' % (len(dex_bytes), dex_bytes[4:7].decode()))

    # 3. resources + assets
    entries.append(('resources.arsc', arsc))
    for t in sorted(table):
        for e in sorted(table[t]):
            for _, _, apk_path, src in table[t][e]:
                if src.endswith('.xml'):
                    data = XmlCompiler(resolve_ref).compile(src)
                    dump_axml(data)
                else:
                    with open(src, 'rb') as fh:
                        data = fh.read()
                entries.append((apk_path, data))
    assets_root = os.path.join(MAIN, 'assets')
    for r, _, fs in sorted(os.walk(assets_root)):
        for f in sorted(fs):
            full = os.path.join(r, f)
            with open(full, 'rb') as fh:
                entries.append(('assets/' + os.path.relpath(full, assets_root).replace(os.sep, '/'), fh.read()))

    unsigned = os.path.join(BUILD, 'unsigned.apk')
    write_apk(unsigned, entries)
    assert not check_alignment(unsigned)

    # 4. sign (APK Signature Scheme v2) and verify
    if not os.path.isfile(args.keystore):
        log('creating debug keystore')
        run(['keytool', '-genkeypair', '-keystore', args.keystore, '-storetype', 'PKCS12',
             '-storepass', 'android', '-keypass', 'android', '-alias', 'midtownstrike',
             '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
             '-dname', 'CN=Midtown Strike Debug, O=Midtown Strike'])
    signer_out = os.path.join(BUILD, 'signer')
    os.makedirs(signer_out)
    run(['javac', '-nowarn', '-cp', jars['apksig'], '-d', signer_out, os.path.join(TOOLS, 'SignApk.java')])
    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    opens = ['--add-exports=java.base/sun.security.x509=ALL-UNNAMED',
             '--add-exports=java.base/sun.security.pkcs=ALL-UNNAMED']  # apksig 2.3.0 predates JPMS
    print(run(['java'] + opens + ['-cp', jars['apksig'] + os.pathsep + signer_out, 'SignApk',
               args.keystore, 'android', 'midtownstrike', unsigned, out, '24']).strip())

    misaligned = check_alignment(out)
    if misaligned:
        raise SystemExit('signed APK lost alignment for: ' + ', '.join(misaligned))
    with zipfile.ZipFile(out) as zf:
        assert zf.testzip() is None
        names = zf.namelist()
        assert zf.getinfo('resources.arsc').compress_type == zipfile.ZIP_STORED
    log('entries: ' + ', '.join(names))
    log('OK  %s  (%.2f MB)' % (out, os.path.getsize(out) / 1e6))


if __name__ == '__main__':
    main()
