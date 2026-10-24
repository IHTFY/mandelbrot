// Deep-zoom Mandelbrot renderer: WebGL2 perturbation with a high-precision
// reference orbit, after the methods in Kalles Fraktaler 2+ and Fraktaler 3
// (https://mathr.co.uk/kf/kf.html, https://fraktaler.mathr.co.uk/).
//
// Each pixel c = C + dc is iterated as an offset z from the reference orbit Z:
//   z -> 2 Z z + z^2 + dc
// in float32 on the GPU, while Z is computed once per view in BigInt
// fixed point by reference-worker.js.
//
// Tricks borrowed from KF / Fraktaler 3:
// - the reference is the nucleus (periodic point) of the lowest-period
//   minibrot near the view center, found with ball period detection and
//   Newton's method, so the reference never escapes;
// - rebasing (Zhuoran's trick): whenever the pixel's orbit Z + z comes closer
//   to 0 than to the reference, restart the reference from Z_0 with z = Z + z.
//   This removes perturbation glitches without detecting or re-rendering them;
// - bilinear approximation (BLA): precomputed z -> A z + B dc steps that skip
//   many iterations at once while z is small;
// - derivative tracking for distance estimation and slope shading;
// - scaled iterations past float32's range, to zooms of about 1e290;
// - interior detection, so pixels inside the set stop early.

const ESCAPE_R2 = 1e6; // must match reference-worker.js
const MAX_LEVELS = 24;
const TEX_WIDTH = 2048;
// Below DEEP_SPACING, float32 deltas would underflow, so pixels iterate with
// scaled mantissas. MIN_SPACING keeps the view size and Newton tolerance
// (spacing * 1e-6) inside the range of doubles.
const DEEP_SPACING = 1e-32;
const MIN_SPACING = 1e-290;
const HOME = { re: "-0.75", im: "0", radius: 1.4 };

const canvas = document.getElementById("canvas");
const gl = canvas.getContext("webgl2", {
  antialias: false,
  depth: false,
  alpha: false,
});

function fail(message) {
  document.getElementById("status").textContent = message;
  throw new Error(message);
}

if (!gl) fail("This browser doesn't support WebGL2, which this viewer needs.");
if (!gl.getExtension("EXT_color_buffer_float"))
  fail("This browser can't render to float textures (EXT_color_buffer_float).");

// ---------------------------------------------------------------------------
// Fixed-point helpers (value = v / 2^bits)

// Number(v) rounds a BigInt correctly but is Infinity past 2^1024, and
// 2^bits overflows past bits = 1023, so deep coordinates are scaled in steps.
const BIG = 1n << 1000n;
function toNum(v, bits) {
  if (bits <= 1000) return Number(v) * 2 ** -bits;
  if (v < BIG && v > -BIG) return Number(v) * 2 ** -1000 * 2 ** (1000 - bits);
  return Number(v >> BigInt(bits - 1000)) * 2 ** -1000;
}

function fromNum(x, bits) {
  if (x === 0) return 0n;
  const e = Math.floor(Math.log2(Math.abs(x)));
  if (bits + e < 1000) return BigInt(Math.round(x * 2 ** (bits >> 1) * 2 ** (bits - (bits >> 1))));
  return BigInt(x * 2 ** (60 - e)) << BigInt(bits + e - 60);
}

function rescale(v, from, to) {
  return to >= from ? v << BigInt(to - from) : v >> BigInt(from - to);
}

function parseDecimal(text, bits) {
  const match = /^\s*([+-]?)(\d*)(?:\.(\d*))?\s*$/.exec(text);
  if (!match) return null;
  const [, sign, int = "", frac = ""] = match;
  let v = BigInt(int || "0") << BigInt(bits);
  if (frac) v += (BigInt(frac) << BigInt(bits)) / 10n ** BigInt(frac.length);
  return sign === "-" ? -v : v;
}

function formatDecimal(v, bits, digits) {
  const sign = v < 0n ? "-" : "";
  if (v < 0n) v = -v;
  const int = v >> BigInt(bits);
  const frac = v - (int << BigInt(bits));
  const scaled = (frac * 10n ** BigInt(digits)) >> BigInt(bits);
  return `${sign}${int}.${scaled.toString().padStart(digits, "0")}`;
}

// Bits for new coordinates; references stay usable down to REFERENCE_MARGIN,
// so a reference survives about 30 zoom doublings before it's recomputed.
const REFERENCE_MARGIN = 32;
function bitsFor(spacing, margin = 64) {
  return Math.max(64, Math.ceil(-Math.log2(spacing)) + margin);
}

// ---------------------------------------------------------------------------
// View state

const view = { re: 0n, im: 0n, bits: 64, radius: HOME.radius };
let maxIter = 4000;

function setCenter(re, im, bits) {
  view.re = re;
  view.im = im;
  view.bits = bits;
}

function spacingOf(radius) {
  return (2 * radius) / canvas.height;
}

function ensureBits() {
  const need = bitsFor(spacingOf(view.radius));
  if (need > view.bits) {
    view.re = rescale(view.re, view.bits, need);
    view.im = rescale(view.im, view.bits, need);
    view.bits = need;
  }
}

function clampRadius(radius) {
  return Math.min(4, Math.max(radius, (MIN_SPACING * canvas.height) / 2));
}

// Complex offset of a canvas pixel (x right, y down) from the view center.
function pixelOffset(x, y) {
  const s = spacingOf(view.radius);
  return [(x - canvas.width / 2) * s, (canvas.height / 2 - y) * s];
}

function moveCenter(dre, dim) {
  ensureBits();
  view.re += fromNum(dre, view.bits);
  view.im += fromNum(dim, view.bits);
}

// Zoom by `factor` (new radius / old radius), keeping pixel (x, y) fixed.
function zoomAt(x, y, factor) {
  const radius = clampRadius(view.radius * factor);
  const f = radius / view.radius;
  const [dx, dy] = pixelOffset(x, y);
  view.radius = radius;
  moveCenter(dx * (1 - f), dy * (1 - f));
  viewChanged();
}

// Zoom by `factor` and center the view on pixel (x, y).
function zoomTo(x, y, factor) {
  const [dx, dy] = pixelOffset(x, y);
  view.radius = clampRadius(view.radius * factor);
  moveCenter(dx, dy);
  viewChanged();
}

// ---------------------------------------------------------------------------
// WebGL setup

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// Writes (smooth iteration count, distance estimate in pixels, surface normal)
// per pixel. The iteration count is -1 for pixels found to be inside the set
// and -2 for pixels still unresolved after the maximum iteration count.
//
// Two variants share this source. The plain one iterates z in float32. The
// DEEP one, used once pixel spacing is too small for float32, stores z, the
// c-derivative and the z-derivative as a float32 mantissa times 2^int (the
// scaled iterations of KF and Fraktaler), so the depth is limited only by the
// doubles used for the view size.
function iterateSource(deep) {
  return `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
${deep ? "#define DEEP" : ""}
#define MAX_LEVELS ${MAX_LEVELS}
const float ESCAPE_R2 = ${ESCAPE_R2.toExponential()};

uniform sampler2D uRef;
uniform sampler2D uBla;
uniform int uRefLen;
uniform int uMaxIter;
uniform int uLevels;
uniform int uBlaOffset[MAX_LEVELS];
uniform int uBlaCount[MAX_LEVELS];
uniform vec2 uOffsetPx; // reference to view center, in units of 2^uE0
uniform float uSigma; // pixel spacing in units of 2^uE0
uniform int uE0;
uniform vec2 uHalfRes;

out vec4 outData;

vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
vec4 fetch(sampler2D t, int i) { return texelFetch(t, ivec2(i & ${TEX_WIDTH - 1}, i >> ${Math.log2(TEX_WIDTH)}), 0); }
// L1 norm: no squaring, so tiny deltas don't underflow to 0
float norm1(vec2 v) { return abs(v.x) + abs(v.y); }

// v * 2^k for |k| up to 254, past the range where exp2 alone overflows
vec2 ldexp2(vec2 v, int k) {
  int h = k / 2;
  return v * exp2(float(h)) * exp2(float(k - h));
}

// Moves powers of 2 from the mantissa v into the exponent e, keeping
// |v| within [2^-20, 2^20] so later products can't overflow.
void renorm(inout vec2 v, inout int e) {
  float m = max(abs(v.x), abs(v.y));
  if (m > exp2(20.0) || (m < exp2(-20.0) && m > 0.0)) {
    int k = int(floor(log2(m)));
    v *= exp2(float(-k));
    e += k;
  }
}

void main() {
  // A pixel is inside once |dW/dW_1| < 2^interiorLog2: its orbit is being
  // pulled into an attracting cycle (the derivative shrinks by the cycle's
  // multiplier every period) and will never escape. Outside points near a
  // parabolic point (a cusp or bulb root) linger there and the derivative
  // shrinks too, but only to about 1/N^2 for an orbit escaping after N
  // iterations, so the threshold sits 2^24 below that.
  float interiorLog2 = -24.0 - 2.0 * log2(float(uMaxIter));
  vec2 delta = uOffsetPx + (gl_FragCoord.xy - uHalfRes) * uSigma; // dc / 2^uE0
  vec2 Z = vec2(0.0);
  vec2 W = vec2(0.0);
  int m = 0;
  int n = 0;
  int result = 0; // 0 unresolved, 1 escaped, 2 inside
#ifdef DEEP
  vec2 w = vec2(0.0); int e = uE0;   // z = w 2^e
  vec2 q = vec2(0.0); int eq = 0;    // dW/dc = q 2^eq
  vec2 v = vec2(1.0, 0.0); int ev = 0; // dW/dW_1 = v 2^ev, for interior checks
  while (true) {
    W = Z + w * exp2(float(e));
    if (dot(W, W) > ESCAPE_R2) { result = 1; break; }
    if (ev < 0 && log2(norm1(v)) + float(ev) < interiorLog2) { result = 2; break; }
    if (n >= uMaxIter) break;
    // W = Ws 2^eW. While z is tiny, W is scaled too when Z is 0 or no
    // bigger than about z (then Z >= 2^-149 keeps ldexp2 in range); only
    // then can W be smaller than z, so only then is a rebase possible.
    // Ws is renormalized so the products with q and v below can't underflow.
    vec2 Ws = W; int eW = 0;
    bool rebase = false;
    if (e >= -40) {
      rebase = norm1(W) < norm1(w * exp2(float(e)));
    } else if (Z == vec2(0.0)) {
      Ws = w;
      eW = e;
    } else if (norm1(Z) <= exp2(float(e + 40))) {
      Ws = ldexp2(Z, -e) + w;
      eW = e;
      rebase = norm1(Ws) < norm1(w);
    }
    renorm(Ws, eW);
    if (m == uRefLen - 1 || rebase) {
      w = Ws;
      e = eW;
      Z = vec2(0.0);
      m = 0;
    }
    int best = -1;
    int bestLen = 0;
    if (m > 0) {
      float lz = log2(norm1(w)) + float(e);
      for (int k = 0; k < MAX_LEVELS; k++) {
        int len = 2 << k;
        int j = (m - 1) >> (k + 1);
        if (k >= uLevels || ((m - 1) & (len - 1)) != 0 || j >= uBlaCount[k] || n + len > uMaxIter) break;
        int b = uBlaOffset[k] + j;
        if (!(lz < fetch(uBla, 2 * b).y)) break;
        best = b;
        bestLen = len;
      }
    }
    if (best >= 0) {
      vec4 ex = fetch(uBla, 2 * best);
      vec4 ab = fetch(uBla, 2 * best + 1);
      int eA = int(ex.z);
      int eB = int(ex.w);
      // z -> A z + B dc
      int e1 = e + eA;
      int e2 = eB + uE0;
      int e3 = max(e1, e2);
      w = ldexp2(cmul(ab.xy, w), e1 - e3) + ldexp2(cmul(ab.zw, delta), e2 - e3);
      e = e3;
      // dW/dc -> A dW/dc + B
      e1 = eq + eA;
      e3 = max(e1, eB);
      q = ldexp2(cmul(ab.xy, q), e1 - e3) + ldexp2(ab.zw, eB - e3);
      eq = e3;
      v = cmul(ab.xy, v);
      ev += eA;
      m += bestLen;
      n += bestLen;
    } else {
      // z -> 2 Z z + z^2 + dc
      if (e >= -40) {
        // |z| > 2^-60, so plain floats do; dc may still matter when Z is
        // near 0, and underflows to 0 when it doesn't
        vec2 z = w * exp2(float(e));
        w = cmul(2.0 * Z + z, z) + ldexp2(delta, uE0);
        e = 0;
      } else {
        // each term at its own power of 2
        int e3 = max(e, uE0); // e < 0, so z^2 is smaller than z
        w = ldexp2(2.0 * cmul(Z, w), e - e3) + ldexp2(cmul(w, w), 2 * e - e3) + ldexp2(delta, uE0 - e3);
        e = e3;
      }
      // dW/dc -> 2 W dW/dc + 1
      int e1 = eW + eq;
      int e3 = max(e1, 0);
      q = ldexp2(2.0 * cmul(Ws, q), e1 - e3) + vec2(exp2(float(-e3)), 0.0);
      eq = e3;
      if (n > 0) {
        v = 2.0 * cmul(Ws, v);
        ev += eW;
      }
      m++;
      n++;
    }
    renorm(w, e);
    renorm(q, eq);
    renorm(v, ev);
    Z = fetch(uRef, m).xy;
  }
  // dW/dc times the pixel spacing
  vec2 d = ldexp2(q * uSigma, clamp(eq + uE0, -254, 254));
  vec2 dn = q / max(abs(q.x), abs(q.y));
#else
  float scale = exp2(float(uE0));
  vec2 dc = delta * scale;
  float spacing = uSigma * scale;
  vec2 z = vec2(0.0);
  vec2 d = vec2(0.0); // dW/dc times the pixel spacing
  vec2 v = vec2(1.0, 0.0); // dW/dW_1, for interior checks
  while (true) {
    W = Z + z;
    if (dot(W, W) > ESCAPE_R2) { result = 1; break; }
    if (norm1(v) < exp2(interiorLog2)) { result = 2; break; }
    if (n >= uMaxIter) break;
    if (m == uRefLen - 1 || norm1(W) < norm1(z)) {
      z = W;
      Z = vec2(0.0);
      m = 0;
    }
    int best = -1;
    int bestLen = 0;
    if (m > 0) {
      float az = norm1(z);
      for (int k = 0; k < MAX_LEVELS; k++) {
        int len = 2 << k;
        int j = (m - 1) >> (k + 1);
        if (k >= uLevels || ((m - 1) & (len - 1)) != 0 || j >= uBlaCount[k] || n + len > uMaxIter) break;
        int b = uBlaOffset[k] + j;
        if (!(az < fetch(uBla, 2 * b).x)) break;
        best = b;
        bestLen = len;
      }
    }
    if (best >= 0) {
      vec4 ex = fetch(uBla, 2 * best);
      vec4 ab = fetch(uBla, 2 * best + 1);
      vec2 A = ab.xy * exp2(ex.z);
      vec2 B = ab.zw * exp2(ex.w);
      z = cmul(A, z) + cmul(B, dc);
      d = cmul(A, d) + B * spacing;
      v = cmul(A, v);
      m += bestLen;
      n += bestLen;
    } else {
      d = 2.0 * cmul(W, d) + vec2(spacing, 0.0);
      if (n > 0) v = 2.0 * cmul(W, v);
      z = cmul(2.0 * Z + z, z) + dc;
      m++;
      n++;
    }
    Z = fetch(uRef, m).xy;
  }
  vec2 dn = d / max(abs(d.x), abs(d.y));
#endif
  if (result != 1) { outData = vec4(result == 2 ? -1.0 : -2.0, 0.0, 0.0, 0.0); return; }
  float r = length(W);
  float mu = float(n) + 1.0 - log2(log(r));
  float dl = length(d);
  float de = dl > 0.0 ? 2.0 * r * log(r) / dl : 0.0;
  vec2 u = cmul(W / r, vec2(dn.x, -dn.y));
  u = dot(u, u) > 0.0 ? normalize(u) : vec2(0.0);
  outData = vec4(mu, de, u);
}`;
}

// Colors the iteration data. Rows below uDoneY aren't rendered yet, so they
// show the previous image, moved and scaled to the new view.
const MAX_STOPS = 8;
const COLOR = `#version 300 es
precision highp float;
#define MAX_STOPS ${MAX_STOPS}
precision highp sampler2D;

uniform sampler2D uData;
uniform sampler2D uOld;
uniform bool uHasOld;
uniform float uDoneY;
uniform vec2 uHalfRes;
uniform float uOldScale;
uniform vec2 uOldShift;
uniform float uCycle;
uniform float uOffset;
uniform int uTransfer; // 0 linear, 1 square root, 2 log
uniform vec3 uStops[MAX_STOPS]; // cyclic gradient; none means rainbow
uniform int uStopCount;
uniform float uSlopes; // slope shading strength, 0 for off
uniform vec2 uLight; // light direction
uniform bool uEdges;
uniform vec3 uInside;

out vec4 outColor;

float h2c(float h) {
  h = fract(h);
  if (h < 1.0 / 6.0) return 6.0 * h;
  if (h < 0.5) return 1.0;
  if (h < 2.0 / 3.0) return 4.0 - 6.0 * h;
  return 0.0;
}

void main() {
  vec4 s;
  if (gl_FragCoord.y >= uDoneY) {
    s = texelFetch(uData, ivec2(gl_FragCoord.xy), 0);
  } else {
    vec2 p = (gl_FragCoord.xy - uHalfRes) * uOldScale + uHalfRes + uOldShift;
    if (!uHasOld || any(lessThan(p, vec2(0.0))) || any(greaterThanEqual(p, 2.0 * uHalfRes))) {
      outColor = vec4(0.08, 0.08, 0.1, 1.0);
      return;
    }
    s = texelFetch(uOld, ivec2(p), 0);
  }
  if (s.x < 0.0) { outColor = vec4(uInside, 1.0); return; }
  // transfer functions as in KF: one color cycle at uCycle iterations, then
  // the cycles get longer for square root and log
  float h = uTransfer == 1 ? sqrt(s.x / uCycle)
          : uTransfer == 2 ? log(1.0 + s.x) / log(1.0 + uCycle)
          : s.x / uCycle;
  h = fract(h + uOffset);
  vec3 col;
  if (uStopCount == 0) {
    col = vec3(h2c(h + 1.0 / 3.0), h2c(h), h2c(h - 1.0 / 3.0));
  } else {
    float x = h * float(uStopCount);
    int i = min(int(x), uStopCount - 1);
    vec3 a = uStops[i], b = uStops[(i + 1) % uStopCount];
    col = mix(a, b, smoothstep(0.0, 1.0, fract(x)));
  }
  if (uSlopes > 0.0) {
    float light = dot(s.zw, uLight);
    col *= max(0.0, 1.0 + uSlopes * (0.35 * light - 0.25));
  }
  if (uEdges) col *= mix(0.15, 1.0, smoothstep(0.0, 1.0, s.y));
  outColor = vec4(col, 1.0);
}`;

function compile(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
    fail(`Shader error: ${gl.getShaderInfoLog(shader)}`);
  return shader;
}

function program(fragment) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    fail(`Shader link error: ${gl.getProgramInfoLog(p)}`);
  const uniforms = {};
  const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, "");
    uniforms[name] = gl.getUniformLocation(p, name);
  }
  return { program: p, uniforms };
}

const iterateFast = program(iterateSource(false));
const iterateDeep = program(iterateSource(true));
const color = program(COLOR);
gl.bindVertexArray(gl.createVertexArray());

function dataTexture(internal, format, width, height, data) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, gl.FLOAT, data);
  return t;
}

// Uploads `texels` RGBA or RG float texels laid out TEX_WIDTH per row.
function tableTexture(old, values, channels) {
  if (old) gl.deleteTexture(old);
  const texels = Math.max(1, values.length / channels);
  const height = Math.ceil(texels / TEX_WIDTH);
  const padded = new Float32Array(TEX_WIDTH * height * channels);
  padded.set(values);
  return channels === 4
    ? dataTexture(gl.RGBA32F, gl.RGBA, TEX_WIDTH, height, padded)
    : dataTexture(gl.RG32F, gl.RG, TEX_WIDTH, height, padded);
}

// Two render targets: the one being rendered and the last finished image.
let targets = [];
function makeTargets() {
  for (const t of targets) {
    gl.deleteTexture(t.texture);
    gl.deleteFramebuffer(t.fbo);
  }
  targets = [0, 1].map(() => {
    const texture = dataTexture(gl.RGBA32F, gl.RGBA, canvas.width, canvas.height, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return { texture, fbo, view: null };
  });
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

// ---------------------------------------------------------------------------
// Reference orbit and bilinear approximation table

let reference = null; // { re, im, bits, period, maxIter, escaped, orbit, texture }
let blaTexture = null;
let blaLevels = { offsets: [], counts: [] };
const worker = new Worker("reference-worker.js");
let workerBusy = false;
let requestId = 0;
let pendingSize = false;
let sizeRequestVersion = 0; // a minibrot found after navigating away is dropped

function referenceOffset() {
  const bits = Math.max(view.bits, reference.bits);
  return [
    toNum(rescale(view.re, view.bits, bits) - rescale(reference.re, reference.bits, bits), bits),
    toNum(rescale(view.im, view.bits, bits) - rescale(reference.im, reference.bits, bits), bits),
  ];
}

function viewDiagonal() {
  return Math.hypot(canvas.width, canvas.height) * spacingOf(view.radius) / 2;
}

function referenceUsable() {
  if (!reference) return false;
  if (reference.bits < bitsFor(spacingOf(view.radius), REFERENCE_MARGIN)) return false;
  // without a nucleus, look for one again whenever the zoom changes
  if (reference.period === 0 && reference.radius !== view.radius) return false;
  if (reference.period === 0 && !reference.escaped && maxIter > reference.maxIter) return false;
  // a far-off reference wastes float32 precision on the offset
  return Math.hypot(...referenceOffset()) < 2 * viewDiagonal();
}

function requestReference(wantSize = false) {
  ensureBits();
  workerBusy = true;
  pendingSize = wantSize;
  sizeRequestVersion = viewVersion;
  worker.postMessage({
    id: ++requestId,
    re: view.re,
    im: view.im,
    bits: view.bits,
    radius: wantSize ? view.radius * 0.5 : view.radius,
    spacing: spacingOf(view.radius),
    maxIter,
    wantSize,
  });
  setStatus(wantSize ? "Looking for a minibrot…" : "Computing reference orbit…");
}

worker.onmessage = ({ data }) => {
  workerBusy = false;
  const wasSizeRequest = pendingSize;
  pendingSize = false;
  if (wasSizeRequest && sizeRequestVersion !== viewVersion) return;
  if (wasSizeRequest && data.size === 0) {
    setStatus("No minibrot found here. Try more iterations.");
    return;
  }
  if (reference) gl.deleteTexture(reference.texture);
  reference = { ...data, texture: tableTexture(null, new Float32Array(data.orbit), 2) };
  if (wasSizeRequest) {
    setCenter(data.re, data.im, data.bits);
    view.radius = clampRadius(data.size * 1.5);
  }
  viewChanged();
};

// Don't ask again for the same view: the failure would repeat every frame.
let failedVersion = -1;
worker.onerror = (e) => {
  workerBusy = false;
  failedVersion = viewVersion;
  setStatus(`Reference orbit failed: ${e.message}`);
};

// (x + iy) as (mantissa, exponent) with the larger part in [0.5, 1).
// Overflowed values become 0; their R is 0, so the step is never taken.
function splitExponent(x, y) {
  const m = Math.max(Math.abs(x), Math.abs(y));
  if (m === 0 || !Number.isFinite(m)) return [0, 0, 0];
  const e = Math.floor(Math.log2(m)) + 1;
  const s = 2 ** -e;
  return [x * s, y * s, e];
}

// BLA steps z -> A z + B dc, valid while |z| < R (mathr, "Deep zoom theory
// and practice (again)", 2022). Level k holds steps of 2^(k+1) iterations
// starting at iterations 1, 1 + 2^(k+1), ...; single steps aren't stored,
// since they cost the same as a perturbation step.
function buildBla(orbit, cMax) {
  const M = orbit.length / 2;
  const eps = 2 ** -24;
  let count = M - 2;
  let A = new Float64Array(2 * Math.max(count, 0));
  let B = new Float64Array(2 * Math.max(count, 0));
  let R = new Float64Array(Math.max(count, 0));
  for (let j = 0; j < count; j++) {
    const zr = orbit[2 * j + 2];
    const zi = orbit[2 * j + 3];
    const az = Math.hypot(zr, zi);
    A[2 * j] = 2 * zr;
    A[2 * j + 1] = 2 * zi;
    B[2 * j] = 1;
    R[j] = Math.max(0, (eps * (az / 2 - cMax)) / (2 * az + 1));
  }
  const levels = [];
  while (count >= 2 && levels.length < MAX_LEVELS) {
    const next = Math.floor(count / 2);
    const A2 = new Float64Array(2 * next);
    const B2 = new Float64Array(2 * next);
    const R2 = new Float64Array(next);
    for (let j = 0; j < next; j++) {
      const x = 2 * j;
      const y = x + 1;
      const axr = A[2 * x], axi = A[2 * x + 1];
      const ayr = A[2 * y], ayi = A[2 * y + 1];
      const bxr = B[2 * x], bxi = B[2 * x + 1];
      A2[2 * j] = ayr * axr - ayi * axi;
      A2[2 * j + 1] = ayr * axi + ayi * axr;
      B2[2 * j] = ayr * bxr - ayi * bxi + B[2 * y];
      B2[2 * j + 1] = ayr * bxi + ayi * bxr + B[2 * y + 1];
      const r = Math.min(R[x], Math.max(0, (R[y] - Math.hypot(bxr, bxi) * cMax) / Math.hypot(axr, axi)));
      R2[j] = Number.isFinite(r) ? r : 0; // A overflowed: never use this step
    }
    A = A2;
    B = B2;
    R = R2;
    count = next;
    levels.push({ A, B, R, count });
  }

  const total = levels.reduce((sum, l) => sum + l.count, 0);
  // Two texels per step: [R, log2 R, exponent of A, exponent of B] and the
  // mantissas [A, B], so A and B keep their size past float32's range.
  const packed = new Float32Array(8 * Math.max(total, 1));
  const offsets = [];
  const counts = [];
  let e = 0;
  for (const level of levels) {
    offsets.push(e);
    counts.push(level.count);
    for (let j = 0; j < level.count; j++, e++) {
      const r = level.R[j];
      const [ar, ai, eA] = splitExponent(level.A[2 * j], level.A[2 * j + 1]);
      const [br, bi, eB] = splitExponent(level.B[2 * j], level.B[2 * j + 1]);
      packed.set([r, r > 0 ? Math.log2(r) : -1e38, eA, eB, ar, ai, br, bi], 8 * e);
    }
  }
  blaTexture = tableTexture(blaTexture, packed, 4);
  blaLevels = { offsets, counts };
}

// ---------------------------------------------------------------------------
// Progressive rendering, one tile per frame so long renders don't stall the
// page or trip the browser's GPU watchdog.

let job = null; // the render in progress
let finished = null; // target holding the last finished image
let dirty = true;
let viewVersion = 0;

function viewChanged() {
  viewVersion++;
  dirty = true;
  scheduleFrame();
  saveHash();
}

function startJob() {
  const target = targets.find((t) => t !== finished);
  const spacing = spacingOf(view.radius);
  const [ore, oim] = referenceOffset();
  const corner = Math.hypot(ore, oim) + viewDiagonal();
  buildBla(reference.orbit, corner);
  target.view = { re: view.re, im: view.im, bits: view.bits, radius: view.radius };
  job = {
    target,
    version: viewVersion,
    offset: [ore, oim],
    spacing,
    doneY: canvas.height, // rows at or above this (GL coordinates) are done
    x: 0,
    tileW: canvas.width,
    tileH: 8,
    fence: null,
    started: performance.now(),
    tileStart: 0,
  };
}

function drawTile() {
  const { target } = job;
  const y0 = Math.max(0, job.doneY - job.tileH);
  const w = Math.min(job.tileW, canvas.width - job.x);
  const iterate = job.spacing < DEEP_SPACING ? iterateDeep : iterateFast;
  const u = iterate.uniforms;
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(job.x, y0, w, job.doneY - y0);
  gl.useProgram(iterate.program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, reference.texture);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, blaTexture);
  gl.uniform1i(u.uRef, 0);
  gl.uniform1i(u.uBla, 1);
  gl.uniform1i(u.uRefLen, reference.orbit.length / 2);
  gl.uniform1i(u.uMaxIter, maxIter);
  gl.uniform1i(u.uLevels, blaLevels.counts.length);
  const pad = (a) => Int32Array.from({ length: MAX_LEVELS }, (_, i) => a[i] ?? 0);
  gl.uniform1iv(u.uBlaOffset, pad(blaLevels.offsets));
  gl.uniform1iv(u.uBlaCount, pad(blaLevels.counts));
  // spacing = sigma 2^E0 with sigma in [1, 2); the offset is in the same units
  const e0 = Math.floor(Math.log2(job.spacing));
  const toUnits = (x) => x * 2 ** -(e0 >> 1) * 2 ** -(e0 - (e0 >> 1));
  gl.uniform1i(u.uE0, e0);
  gl.uniform1f(u.uSigma, toUnits(job.spacing));
  gl.uniform2f(u.uOffsetPx, toUnits(job.offset[0]), toUnits(job.offset[1]));
  gl.uniform2f(u.uHalfRes, canvas.width / 2, canvas.height / 2);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.disable(gl.SCISSOR_TEST);
  job.pending = { x: job.x + w, y0 };
  job.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  gl.flush();
  job.tileStart = performance.now();
}

// Called once per frame: collects the finished tile, then queues the next.
function advanceJob() {
  if (job.fence) {
    if (gl.getSyncParameter(job.fence, gl.SYNC_STATUS) !== gl.SIGNALED) return;
    gl.deleteSync(job.fence);
    job.fence = null;
    const elapsed = performance.now() - job.tileStart;
    const strip = job.pending.x >= canvas.width;
    if (strip) {
      job.x = 0;
      job.doneY = job.pending.y0;
      setStatus(`Rendering… ${Math.round(100 * (1 - job.doneY / canvas.height))}%`);
    } else {
      job.x = job.pending.x;
    }
    // aim for tiles that take about a frame or two
    if (elapsed > 50) {
      if (job.tileH > 1) job.tileH = Math.ceil(job.tileH / 2);
      else job.tileW = Math.max(64, Math.ceil(job.tileW / 2));
    } else if (elapsed < 20 && job.x === 0) {
      if (job.tileW < canvas.width) job.tileW = Math.min(canvas.width, job.tileW * 2);
      else job.tileH = Math.min(canvas.height, job.tileH * 2);
    }
    dirty = true;
  }
  if (job.doneY <= 0) {
    finished = job.target;
    const ms = performance.now() - job.started;
    job = null;
    showInfo(ms);
    return;
  }
  drawTile();
}

function drawColors() {
  const u = color.uniforms;
  // `live` holds this view's data down to doneY; the rest previews `finished`
  const live = job ? job.target : finished && sameView(finished.view) ? finished : null;
  const doneY = job ? job.doneY : live ? 0 : canvas.height;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.useProgram(color.program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, live ? live.texture : null);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, finished ? finished.texture : null);
  gl.uniform1i(u.uData, 0);
  gl.uniform1i(u.uOld, 1);
  gl.uniform1f(u.uDoneY, doneY);
  gl.uniform2f(u.uHalfRes, canvas.width / 2, canvas.height / 2);
  gl.uniform1i(u.uHasOld, finished ? 1 : 0);
  if (finished) {
    // where this view's pixels sit in the finished image
    const v = finished.view;
    const bits = Math.max(v.bits, view.bits);
    const s = spacingOf(v.radius);
    gl.uniform1f(u.uOldScale, view.radius / v.radius);
    gl.uniform2f(
      u.uOldShift,
      toNum(rescale(view.re, view.bits, bits) - rescale(v.re, v.bits, bits), bits) / s,
      toNum(rescale(view.im, view.bits, bits) - rescale(v.im, v.bits, bits), bits) / s
    );
  }
  const stops = PALETTES[controls.palette.value];
  const angle = (Number(controls.angle.value) * Math.PI) / 180;
  gl.uniform1f(u.uCycle, Number(controls.cycle.value));
  gl.uniform1f(u.uOffset, Number(controls.offset.value));
  gl.uniform1i(u.uTransfer, Number(controls.transfer.value));
  gl.uniform1i(u.uStopCount, stops.length);
  if (stops.length) gl.uniform3fv(u.uStops, stops.flatMap(hexColor));
  gl.uniform1f(u.uSlopes, Number(controls.slopes.value));
  gl.uniform2f(u.uLight, Math.cos(angle), Math.sin(angle));
  gl.uniform1i(u.uEdges, controls.edges.checked ? 1 : 0);
  gl.uniform3fv(u.uInside, hexColor(controls.inside.value));
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// Cyclic gradients that run from one end to the other and back; [] is the HSV rainbow.
const PALETTES = {
  rainbow: [],
  fire: ["#000000", "#5c0a00", "#d43a00", "#ff9e1f", "#fff3c4", "#ff9e1f", "#d43a00", "#5c0a00"],
  ocean: ["#020b2a", "#0b3b8c", "#2aa7c9", "#e6f7ff", "#f2c14e", "#2aa7c9", "#0b3b8c"],
  ice: ["#000814", "#1d3557", "#a8dadc", "#ffffff", "#a8dadc", "#1d3557"],
  sunset: ["#1a0533", "#6b1d5c", "#c43c5c", "#f28d52", "#fde3a7", "#f28d52", "#c43c5c", "#6b1d5c"],
  gray: ["#000000", "#ffffff"],
};

function hexColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

let frameScheduled = false;
function scheduleFrame() {
  if (!frameScheduled) {
    frameScheduled = true;
    requestAnimationFrame(frame);
  }
}

function frame() {
  frameScheduled = false;
  if (job && job.version !== viewVersion) {
    if (job.fence) gl.deleteSync(job.fence);
    job = null;
  }
  if (!job && finished?.view && sameView(finished.view) && finished.maxIter === maxIter) {
    // nothing to render
  } else if (!job) {
    if (referenceUsable()) {
      startJob();
      job.target.maxIter = maxIter;
      setStatus("Rendering…");
    } else if (!workerBusy && failedVersion !== viewVersion) {
      requestReference();
    }
  }
  if (job) advanceJob();
  if (dirty) {
    drawColors();
    dirty = false;
  }
  if (job || workerBusy) scheduleFrame();
}

function sameView(v) {
  return v.re === view.re && v.im === view.im && v.bits === view.bits && v.radius === view.radius;
}

// ---------------------------------------------------------------------------
// UI

const controls = {
  iterations: document.getElementById("iterations"),
  iterationsValue: document.getElementById("iterations-value"),
  cycle: document.getElementById("cycle"),
  offset: document.getElementById("offset"),
  palette: document.getElementById("palette"),
  transfer: document.getElementById("transfer"),
  slopes: document.getElementById("slopes"),
  angle: document.getElementById("angle"),
  edges: document.getElementById("edges"),
  inside: document.getElementById("inside"),
  resolution: document.getElementById("resolution"),
};
const info = {
  center: document.getElementById("center"),
  zoom: document.getElementById("zoom"),
  reference: document.getElementById("reference"),
  status: document.getElementById("status"),
  cursor: document.getElementById("cursor"),
};

function setStatus(text) {
  info.status.textContent = text;
}

function digits() {
  return Math.max(4, Math.ceil(-Math.log10(spacingOf(view.radius))) + 2);
}

function showInfo(ms) {
  const d = digits();
  info.center.textContent = `${formatDecimal(view.re, view.bits, d)}\n${formatDecimal(view.im, view.bits, d)}i`;
  info.zoom.textContent = `${(HOME.radius / view.radius).toExponential(2)}×`;
  info.reference.textContent =
    reference.period > 0 ? `Minibrot nucleus, period ${reference.period.toLocaleString()}` : "View center (no nucleus found)";
  const limit = view.radius <= clampRadius(0) * 1.0001 ? " · deepest zoom supported" : "";
  setStatus(`Rendered in ${(ms / 1000).toFixed(2)} s${limit}`);
}

function setIterations(value) {
  maxIter = Math.round(Math.min(1e6, Math.max(10, value)));
  controls.iterations.value = Math.log10(maxIter);
  controls.iterationsValue.textContent = maxIter.toLocaleString();
  viewChanged();
}

controls.iterations.addEventListener("input", () => setIterations(10 ** Number(controls.iterations.value)));
for (const c of [
  controls.cycle,
  controls.offset,
  controls.palette,
  controls.transfer,
  controls.slopes,
  controls.angle,
  controls.edges,
  controls.inside,
]) {
  c.addEventListener("input", () => {
    dirty = true;
    scheduleFrame();
  });
}

document.getElementById("zoom-out").addEventListener("click", () => zoomAt(canvas.width / 2, canvas.height / 2, 4));
document.getElementById("reset").addEventListener("click", () => {
  setCenter(parseDecimal(HOME.re, 64), parseDecimal(HOME.im, 64), 64);
  view.radius = HOME.radius;
  viewChanged();
});
document.getElementById("minibrot").addEventListener("click", () => {
  if (!workerBusy) requestReference(true);
});
document.getElementById("save").addEventListener("click", () => {
  drawColors();
  canvas.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "mandelbrot.png";
    a.click();
    URL.revokeObjectURL(a.href);
  });
});
document.getElementById("toggle-panel").addEventListener("click", () => {
  document.getElementById("panel").classList.toggle("collapsed");
});

// Pointer input: tap or click zooms in on the point, right-click zooms out,
// drag pans, pinch and wheel zoom around the pointer.
const pointers = new Map();
let gesture = null;

function canvasPoint(e) {
  const rect = canvas.getBoundingClientRect();
  return [
    ((e.clientX - rect.left) * canvas.width) / rect.width,
    ((e.clientY - rect.top) * canvas.height) / rect.height,
  ];
}

canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, canvasPoint(e));
  gesture = { moved: false, button: e.button, start: canvasPoint(e) };
});
canvas.addEventListener("pointermove", (e) => {
  const p = canvasPoint(e);
  showCursor(p);
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const other = a === prev ? b : a;
    const before = Math.hypot(prev[0] - other[0], prev[1] - other[1]);
    const after = Math.hypot(p[0] - other[0], p[1] - other[1]);
    gesture.moved = true;
    pointers.set(e.pointerId, p);
    if (before > 0 && after > 0) zoomAt((p[0] + other[0]) / 2, (p[1] + other[1]) / 2, before / after);
    return;
  }
  if (!gesture.moved && Math.hypot(p[0] - gesture.start[0], p[1] - gesture.start[1]) < 6) return;
  gesture.moved = true;
  const s = spacingOf(view.radius);
  moveCenter(-(p[0] - prev[0]) * s, (p[1] - prev[1]) * s);
  pointers.set(e.pointerId, p);
  viewChanged();
});
canvas.addEventListener("pointerup", (e) => {
  const p = canvasPoint(e);
  pointers.delete(e.pointerId);
  if (gesture && !gesture.moved && pointers.size === 0) {
    zoomTo(p[0], p[1], gesture.button === 2 ? 2 : 0.5);
  }
  if (pointers.size === 0) gesture = null;
});
canvas.addEventListener("pointercancel", (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size === 0) gesture = null;
});
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const lines = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    zoomAt(...canvasPoint(e), 2 ** (e.deltaY * lines * 0.003));
  },
  { passive: false }
);

function showCursor([x, y]) {
  const [dx, dy] = pixelOffset(x, y);
  const d = digits();
  const re = view.re + fromNum(dx, view.bits);
  const im = view.im + fromNum(dy, view.bits);
  let iterations = "";
  if (!job && finished) {
    const px = new Float32Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, finished.fbo);
    gl.readPixels(Math.floor(x), canvas.height - 1 - Math.floor(y), 1, 1, gl.RGBA, gl.FLOAT, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    iterations =
      px[0] === -1
        ? "\ninside"
        : px[0] < 0
          ? "\nno escape within the iteration limit"
          : `\n${Math.floor(px[0]).toLocaleString()} iterations`;
  }
  info.cursor.textContent = `${formatDecimal(re, view.bits, d)}\n${formatDecimal(im, view.bits, d)}i${iterations}`;
}

// Location is kept in the URL hash so views can be shared and survive reloads.
let hashTimer = 0;
function saveHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const d = digits();
    const params = new URLSearchParams({
      re: formatDecimal(view.re, view.bits, d),
      im: formatDecimal(view.im, view.bits, d),
      r: view.radius.toExponential(4),
      it: maxIter,
    });
    history.replaceState(null, "", `#${params}`);
  }, 300);
}

function loadHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const radius = Number(params.get("r"));
  view.radius = clampRadius(radius > 0 ? radius : HOME.radius);
  const bits = bitsFor(spacingOf(view.radius));
  const re = parseDecimal(params.get("re") ?? HOME.re, bits);
  const im = parseDecimal(params.get("im") ?? HOME.im, bits);
  if (re === null || im === null) {
    setCenter(parseDecimal(HOME.re, bits), parseDecimal(HOME.im, bits), bits);
    view.radius = HOME.radius;
  } else {
    setCenter(re, im, bits);
  }
  const it = Number(params.get("it"));
  maxIter = it >= 10 ? Math.min(1e6, Math.round(it)) : maxIter;
  controls.iterations.value = Math.log10(maxIter);
  controls.iterationsValue.textContent = maxIter.toLocaleString();
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2) * Number(controls.resolution.value);
  const width = Math.round(canvas.clientWidth * dpr);
  const height = Math.round(canvas.clientHeight * dpr);
  if (width === canvas.width && height === canvas.height && targets.length) return;
  canvas.width = width;
  canvas.height = height;
  if (job?.fence) gl.deleteSync(job.fence);
  job = null;
  finished = null;
  makeTargets();
  view.radius = clampRadius(view.radius);
  viewChanged();
}

if (window.innerWidth < 600) document.getElementById("panel").classList.add("collapsed");
window.addEventListener("resize", resize);
controls.resolution.addEventListener("input", resize);
window.addEventListener("hashchange", () => {
  loadHash();
  viewChanged();
});
loadHash();
resize();
