import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const html = read('index.html');

function pngSize(path) {
  const data = readFileSync(new URL(path, root));
  return `${data.readUInt32BE(16)}x${data.readUInt32BE(20)}`;
}

test('the page links a standalone manifest and registers the worker', () => {
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest"/);
  assert.match(html, /serviceWorker\.register\('sw\.js'\)/);
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.name, 'Mandelbrot');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
});

test('manifest icons exist at the declared sizes, with a maskable 512', () => {
  const { icons } = JSON.parse(read('manifest.webmanifest'));
  for (const icon of icons) assert.equal(pngSize(icon.src), icon.sizes, icon.src);
  assert.ok(icons.some((i) => i.sizes === '192x192'));
  assert.ok(icons.some((i) => i.sizes === '512x512' && !i.purpose));
  assert.ok(icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
});

test('the worker precaches only files that exist, and everything the page loads', () => {
  const sw = read('sw.js');
  const list = sw.match(/const PRECACHE = \[([^\]]*)\]/)[1];
  const files = [...list.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1] || 'index.html');
  for (const file of files) assert.ok(existsSync(new URL(file, root)), file);

  const loaded = [
    ...[...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/<link[^>]*\shref="([^"]+)"/g)].map((m) => m[1]),
    ...[...read('mandelbrot.js').matchAll(/new Worker\("([^"]+)"/g)].map((m) => m[1]),
    ...[...read('mandelbrot.js').matchAll(/import\("\.\/([^"]+)"\)/g)].map((m) => m[1]),
  ].filter((f) => !/^https?:/.test(f));
  assert.ok(loaded.includes('reference-worker.js') && loaded.includes('ads.js'));
  for (const file of loaded) assert.ok(files.includes(file), `${file} is not precached`);
});

test('the worker is network first and leaves cross-origin requests alone', () => {
  const sw = read('sw.js');
  assert.match(sw, /cache: 'reload'/);
  assert.match(sw, /origin !== self\.location\.origin\) return/);
  assert.match(sw, /request\.method !== 'GET'/);
  assert.match(sw, /\.catch\(\(\) => caches\.match/);
});

test('the launch screen copy matches the manifest background and the page calls launchExit', () => {
  const { background_color } = JSON.parse(read('manifest.webmanifest'));
  assert.match(html, new RegExp(`\\.launching #launch \\{[^}]*background: ${background_color};`));
  assert.match(html, /<div id="launch" aria-hidden="true">\s*<img id="launch-icon" src="icons\/icon-maskable-512\.png"/);
  assert.match(read('mandelbrot.js'), /globalThis\.launchExit\?\.\(/);
});

test('a tap or key during the launch only skips it, and a touch\'s click is eaten', () => {
  assert.match(html, /addEventListener\('pointerdown', swallow, true\)/);
  assert.match(html, /addEventListener\('keydown', swallow, true\)/);
  assert.match(html, /addEventListener\('click', eat, \{ capture: true, once: true \}\)/);
  assert.match(html, /removeEventListener\('pointerdown', swallow, true\)/);
  assert.match(html, /removeEventListener\('keydown', swallow, true\)/);
});
