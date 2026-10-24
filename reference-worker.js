// High-precision work for the perturbation renderer, kept off the main thread.
//
// Coordinates are fixed-point BigInts: a value v stands for v / 2^bits.
// For each view the worker finds a reference point near the requested center:
//   1. ball-method period detection finds the lowest period p of any
//      hyperbolic component whose nucleus may lie within `radius` of the center,
//   2. Newton's method solves z_p(c) = 0 for that nucleus; the ball test is
//      conservative, so if the nucleus lands too far away the search repeats
//      with a smaller ball (and a higher period),
//   3. the reference orbit Z_0 .. Z_p is iterated at full precision.
// A nucleus is a periodic (super-attracting) point: Z_p = 0 = Z_0, so the orbit
// never escapes and p values are enough for any iteration count.
// If no nucleus is found, the center itself is used as the reference.

const ESCAPE_R2 = 1e6; // must match ESCAPE_R2 in mandelbrot.js

// Number() rounds a BigInt of any size correctly, so small values keep full
// relative precision (bits stays far below the 1023 where 2^-bits underflows).
function toNum(v, bits) {
  return Number(v) * 2 ** -bits;
}

function fromNum(x, bits) {
  return BigInt(Math.round(x * 2 ** bits));
}

// Lowest period p such that a ball of `radius` around c may contain a
// nucleus of period p (the ball around z_p contains 0). 0 if none found.
function ballPeriod(cr, ci, bits, radius, maxPeriod) {
  const F = BigInt(bits);
  let zr = 0n;
  let zi = 0n;
  let rz = 0;
  for (let p = 1; p <= maxPeriod; p++) {
    const az = Math.hypot(toNum(zr, bits), toNum(zi, bits));
    rz = rz * (2 * az + rz) + radius;
    const t = ((zr * zr - zi * zi) >> F) + cr;
    zi = ((zr * zi) >> (F - 1n)) + ci;
    zr = t;
    const a = Math.hypot(toNum(zr, bits), toNum(zi, bits));
    if (a < rz) return p;
    if (a - rz > 2 || !Number.isFinite(rz)) return 0; // the whole ball escaped
  }
  return 0;
}

// Newton's method for the nucleus of period p near c. The derivative
// dz/dc is tracked in doubles: only its leading digits matter for the step.
// Steps are capped at maxStep: far from the nucleus a full step can throw c
// to an unrelated root. Returns the true period, which may divide p.
function nucleus(cr, ci, bits, period, tolerance, maxStep) {
  const F = BigInt(bits);
  for (let step = 0; step < 64; step++) {
    let zr = 0n;
    let zi = 0n;
    let dr = 0;
    let di = 0;
    for (let i = 0; i < period; i++) {
      const x = toNum(zr, bits);
      const y = toNum(zi, bits);
      const t = 2 * (x * dr - y * di) + 1;
      di = 2 * (x * di + y * dr);
      dr = t;
      const u = ((zr * zr - zi * zi) >> F) + cr;
      zi = ((zr * zi) >> (F - 1n)) + ci;
      zr = u;
      // an escaping orbit doubles its digits every step until memory runs out
      if (x * x + y * y > ESCAPE_R2) return null;
    }
    // delta = z / dz, scaled first so |dz|^2 can't overflow
    const s = Math.max(Math.abs(dr), Math.abs(di));
    if (!Number.isFinite(s) || s === 0) return null;
    const x = toNum(zr, bits) / s;
    const y = toNum(zi, bits) / s;
    const ur = dr / s;
    const ui = di / s;
    const den = ur * ur + ui * ui;
    const deltaR = (x * ur + y * ui) / den;
    const deltaI = (y * ur - x * ui) / den;
    const length = Math.hypot(deltaR, deltaI);
    if (!Number.isFinite(length)) return null;
    const scale = Math.min(1, maxStep / length);
    cr -= fromNum(deltaR * scale, bits);
    ci -= fromNum(deltaI * scale, bits);
    if (length < tolerance) return { cr, ci, period: truePeriod(cr, ci, bits, period, tolerance) };
  }
  return null;
}

// Smallest q dividing p where c is already a root of z_q, i.e. the Newton
// step z_q / (dz_q/dc) is below tolerance.
function truePeriod(cr, ci, bits, period, tolerance) {
  const F = BigInt(bits);
  let zr = 0n;
  let zi = 0n;
  let dr = 0;
  let di = 0;
  for (let q = 1; q < period; q++) {
    const x = toNum(zr, bits);
    const y = toNum(zi, bits);
    const t = 2 * (x * dr - y * di) + 1;
    di = 2 * (x * di + y * dr);
    dr = t;
    const u = ((zr * zr - zi * zi) >> F) + cr;
    zi = ((zr * zi) >> (F - 1n)) + ci;
    zr = u;
    if (period % q === 0) {
      const step = Math.hypot(toNum(zr, bits), toNum(zi, bits)) / Math.hypot(dr, di);
      if (step < tolerance) return q;
    }
  }
  return period;
}

// Search balls of radius, radius/4, ... around c for a nucleus closer than
// `accept` that also passes `wanted`. null if none.
function findNucleus(cr, ci, bits, radius, accept, maxIter, tolerance, wanted) {
  for (let r = radius, tries = 0; tries < 6; tries++, r /= 4) {
    const period = ballPeriod(cr, ci, bits, r, maxIter);
    if (period === 0) return null; // smaller balls find nothing either
    const found = nucleus(cr, ci, bits, period, tolerance, accept);
    if (
      found &&
      Math.hypot(toNum(found.cr - cr, bits), toNum(found.ci - ci, bits)) < accept &&
      wanted(found)
    ) {
      return found;
    }
  }
  return null;
}

// Approximate radius of the minibrot with nucleus c and period p
// (Claude Heiland-Allen's size estimate, as used for Newton zooming in KF).
function minibrotSize(cr, ci, bits, period) {
  const F = BigInt(bits);
  let zr = 0n;
  let zi = 0n;
  let lr = 1;
  let li = 0;
  let br = 1;
  let bi = 0;
  for (let i = 1; i < period; i++) {
    const u = ((zr * zr - zi * zi) >> F) + cr;
    zi = ((zr * zi) >> (F - 1n)) + ci;
    zr = u;
    const x = toNum(zr, bits);
    const y = toNum(zi, bits);
    const t = 2 * (x * lr - y * li);
    li = 2 * (x * li + y * lr);
    lr = t;
    const den = lr * lr + li * li;
    br += lr / den;
    bi -= li / den;
  }
  // size = 1 / (b l^2)
  const l2r = lr * lr - li * li;
  const l2i = 2 * lr * li;
  return 1 / Math.hypot(br * l2r - bi * l2i, br * l2i + bi * l2r);
}

// Z_0 .. Z_n as interleaved doubles, stopping early once Z escapes.
function orbit(cr, ci, bits, n) {
  const F = BigInt(bits);
  const out = new Float64Array(2 * (n + 1));
  let zr = 0n;
  let zi = 0n;
  let len = 1;
  for (let i = 1; i <= n; i++) {
    const u = ((zr * zr - zi * zi) >> F) + cr;
    zi = ((zr * zi) >> (F - 1n)) + ci;
    zr = u;
    const x = toNum(zr, bits);
    const y = toNum(zi, bits);
    out[2 * i] = x;
    out[2 * i + 1] = y;
    len = i + 1;
    if (x * x + y * y > ESCAPE_R2) break;
  }
  return { values: out.slice(0, 2 * len), escaped: len <= n };
}

self.onmessage = ({ data }) => {
  const { id, re, im, bits, radius, spacing, maxIter, wantSize } = data;
  const tolerance = spacing * 1e-6;
  let size = 0;
  // A minibrot to zoom to must be smaller than the view, or the button would
  // zoom out to the component already on screen.
  const wanted = wantSize
    ? (n) => {
        size = minibrotSize(n.cr, n.ci, bits, n.period);
        return Number.isFinite(size) && size > 0 && size < radius;
      }
    : () => true;
  const found = findNucleus(re, im, bits, radius, 2 * radius, maxIter, tolerance, wanted);
  if (wantSize && !found) {
    self.postMessage({ id, size: 0 });
    return;
  }
  const cr = found ? found.cr : re;
  const ci = found ? found.ci : im;
  const period = found ? found.period : 0;
  const { values, escaped } = orbit(cr, ci, bits, period || maxIter);
  self.postMessage(
    { id, re: cr, im: ci, bits, radius, period, maxIter, orbit: values, escaped, size },
    [values.buffer]
  );
};
