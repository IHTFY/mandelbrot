import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

// The reference worker, loaded as the page loads it, with postMessage captured.
const worker = { self: {} };
vm.createContext(worker);
vm.runInContext(readFileSync(new URL('../reference-worker.js', import.meta.url), 'utf8'), worker);
function request(data) {
  let reply;
  worker.self.postMessage = (message) => {
    reply = message;
  };
  worker.self.onmessage({ data });
  return reply;
}

// What the page sends for "Zoom to minibrot" on a 900-pixel-tall canvas
// (bitsFor and requestReference in mandelbrot.js).
const HEIGHT = 900;
const MIN_SPACING = 1e-290;
const MIN_RADIUS = (MIN_SPACING * HEIGHT) / 2;
const bitsFor = (spacing) => Math.max(64, Math.ceil(-Math.log2(spacing)) + 64);
function zoomToMinibrot(re, im, radius) {
  const spacing = (2 * radius) / HEIGHT;
  const bits = bitsFor(spacing);
  const big = (x) => BigInt(x) << BigInt(bits);
  return { reply: ask(big(re), big(im), bits, radius), spacing };
}
function ask(re, im, bits, radius) {
  return request({
    id: 1, re, im, bits, radius: radius * 0.5, spacing: (2 * radius) / HEIGHT, minRadius: MIN_RADIUS,
    maxIter: 4000, wantSize: true,
  });
}

for (const [re, im] of [[-2, 0], [0, 1]]) {
  for (const radius of [1e-30, 1e-60]) {
    test(`zoom to minibrot near ${re}+${im}i at radius ${radius} centers on the minibrot`, () => {
      const { reply, spacing } = zoomToMinibrot(re, im, radius);
      assert.ok(reply.size > 0 && reply.size < radius, `found a minibrot smaller than the view (${reply.size})`);
      // Solve the same nucleus with 400 more bits and a tolerance far below its
      // size, in steps of at most a pixel of the view the search started from.
      const fineBits = reply.bits + 400;
      const fine = worker.nucleus(
        reply.re << 400n, reply.im << 400n, fineBits, reply.period, reply.size * 1e-12, spacing,
      );
      assert.ok(fine, 'the nucleus solves at higher precision');
      const error = Math.hypot(
        worker.toNum(fine.cr - (reply.re << 400n), fineBits),
        worker.toNum(fine.ci - (reply.im << 400n), fineBits),
      );
      assert.ok(error < reply.size, `nucleus error ${error} is below the minibrot size ${reply.size}`);
    });
  }
}

// The page's Zoom to minibrot, then a zoom back out to `radius`; the view keeps
// the bits it has, as ensureBits only ever adds.
for (const radius of [1e-150, 1e-160]) {
  test(`repeated zoom to minibrot from radius ${radius} near -2+0i keeps its precision and stays pannable`, () => {
    let view = { re: -2n << BigInt(bitsFor((2 * radius) / HEIGHT)), im: 0n, bits: bitsFor((2 * radius) / HEIGHT) };
    for (let cycle = 0; cycle < 6; cycle++) {
      const need = bitsFor((2 * radius) / HEIGHT);
      if (need > view.bits) {
        const up = BigInt(need - view.bits);
        view = { re: view.re << up, im: view.im << up, bits: need };
      }
      const reply = ask(view.re, view.im, view.bits, radius);
      assert.ok(reply.size > 0, 'a minibrot is found');
      // The page adopts the reply, then limits the destination radius.
      const destRadius = Math.max(reply.size * 1.5, MIN_RADIUS);
      const destSpacing = (2 * destRadius) / HEIGHT;
      assert.ok(reply.bits <= bitsFor(destSpacing) + 8, `cycle ${cycle}: ${reply.bits} bits for a view that needs ${bitsFor(destSpacing)}`);
      // One destination pixel of panning converts without an exception.
      assert.doesNotThrow(() => worker.fromNum(destSpacing, reply.bits));
      // The center sits within the destination view of the refined nucleus.
      const fineBits = reply.bits + 400;
      const fine = worker.nucleus(
        reply.re << 400n, reply.im << 400n, fineBits, reply.period, destSpacing * 1e-9, destSpacing * 1e6,
      );
      assert.ok(fine, 'the nucleus solves at higher precision');
      const error = Math.hypot(
        worker.toNum(fine.cr - (reply.re << 400n), fineBits),
        worker.toNum(fine.ci - (reply.im << 400n), fineBits),
      );
      assert.ok(error < destRadius, `cycle ${cycle}: center error ${error} is within the destination view ${destRadius}`);
      view = { re: reply.re, im: reply.im, bits: reply.bits };
    }
  });
}
