// Bundles the game into ONE self-contained HTML file (no network needed at
// runtime) and writes it where the Android project picks it up.
//
//   node build.mjs            production build
//   node build.mjs --serve    rebuild on change + http://localhost:8080
import { build, context } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const outFile = resolve(root, 'android/app/src/main/assets/game/index.html');
const serve = process.argv.includes('--serve');

const options = {
  entryPoints: [resolve(root, 'src/main.js')],
  bundle: true,
  format: 'iife',
  target: ['es2019', 'chrome80'],
  minify: !serve,
  legalComments: 'none',
  write: false,
  logLevel: 'warning',
  define: { __DEV__: JSON.stringify(serve) },
};

function emit(js) {
  const html = readFileSync(resolve(root, 'src/index.html'), 'utf8');
  const css = readFileSync(resolve(root, 'src/style.css'), 'utf8');
  const out = html
    .replace('/*__CSS__*/', () => css)
    .replace('/*__JS__*/', () => js.replace(/<\/script/gi, '<\\/script'));
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, out);
  return out;
}

if (!serve) {
  const result = await build(options);
  const out = emit(result.outputFiles[0].text);
  console.log(`built ${outFile} (${(out.length / 1024).toFixed(0)} KiB)`);
} else {
  let page = '';
  const ctx = await context({
    ...options,
    plugins: [{
      name: 'emit',
      setup(b) {
        b.onEnd((r) => {
          if (r.outputFiles && r.outputFiles[0]) {
            page = emit(r.outputFiles[0].text);
            console.log(new Date().toLocaleTimeString(), 'rebuilt');
          }
        });
      },
    }],
  });
  await ctx.watch();
  createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(page);
  }).listen(8080, () => console.log('http://localhost:8080'));
}
