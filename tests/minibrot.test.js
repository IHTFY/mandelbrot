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
function zoomToMinibrot(re, im, radius) {
  const spacing = (2 * radius) / HEIGHT;
  const bits = Math.max(64, Math.ceil(-Math.log2(spacing)) + 64);
  const big = (x) => BigInt(x) << BigInt(bits);
  const reply = request({
    id: 1, re: big(re), im: big(im), bits, radius: radius * 0.5, spacing, maxIter: 4000, wantSize: true,
  });
  return { reply, spacing };
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
