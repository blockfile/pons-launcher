// The dApp's first-load size budget (spec "Testing": the first load, without the
// lazy three.js chunk, stays under 250 KB gzipped).
//
// First load = the module script dist/dapp/index.html names, every chunk it
// imports STATICALLY (transitively), every <link rel="modulepreload"> the HTML
// lists, and the stylesheets it links (the page does not paint without them).
// Dynamic import() chunks (the EmptyScene / three.js chunk) are left out. Gzip
// level 6: the level the dApp's nginx block serves at (Task 14,
// gzip_comp_level 6). Fonts are not counted: woff2 is compressed already and a
// browser fetches only the unicode ranges it draws.
//
// Run after `npm run build`, from frontend/:   node scripts/dapp-size.mjs
// Exit 0 = within budget; exit 1 = over budget, three.js in the first load, or
// a malformed build.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DIST = path.resolve(process.argv[2] || 'dist');
const LIMIT = 250 * 1024;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const gz = (buf) => zlib.gzipSync(buf, { level: 6 }).length;
const fromHref = (href) => path.join(DIST, href.replace(/^\//, ''));

const html = fs.readFileSync(path.join(DIST, 'dapp', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)].map((m) => m[1]);
if (scripts.length !== 1) {
  console.error(`expected exactly one module script in dist/dapp/index.html, found ${scripts.length}`);
  process.exit(1);
}
const preloads = [...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
const styles = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]);

// A static import or re-export of a sibling chunk in minified ES output:
//   import{a as b}from"./x.js"   import"./x.js"   export{a}from"./x.js"
// A dynamic import is import("./x.js") — the "(" after `import` keeps it out.
const STATIC = /(?:^|[;}\s])(?:import|export)\s*(?:[\w$*{},\s]+?from\s*)?["'](\.{1,2}\/[^"']+\.js)["']/g;

const first = new Set();
const queue = [fromHref(scripts[0]), ...preloads.map(fromHref)];
while (queue.length) {
  const file = path.normalize(queue.pop());
  if (first.has(file)) continue;
  first.add(file);
  const code = fs.readFileSync(file, 'utf8');
  for (const m of code.matchAll(STATIC)) queue.push(path.resolve(path.dirname(file), m[1]));
}

let total = 0;
let failed = false;
for (const file of [...first].sort()) {
  const buf = fs.readFileSync(file);
  const size = gz(buf);
  total += size;
  const three = buf.includes('THREE.WebGLRenderer');
  if (three) failed = true;
  console.log(`${path.relative(DIST, file).split(path.sep).join('/').padEnd(44)} ${kb(size).padStart(10)} gz${three ? '   <- three.js: must be lazy' : ''}`);
}
for (const href of styles) {
  const size = gz(fs.readFileSync(fromHref(href)));
  total += size;
  console.log(`${href.replace(/^\//, '').padEnd(44)} ${kb(size).padStart(10)} gz   (css)`);
}
console.log(`first load (JS + CSS): ${kb(total)} = ${total} bytes gzipped (level 6) of ${kb(LIMIT)} = ${LIMIT} bytes budget`);
if (total >= LIMIT) {
  console.error('OVER BUDGET');
  failed = true;
}
process.exit(failed ? 1 : 0);
