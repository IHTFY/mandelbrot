const display = document.getElementById("display");

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d", {
  alpha: false,
  imageSmoothingEnabled: false,
});
if (window.innerWidth / window.innerHeight > 1.25) {
  // wide screen, fill height
  ctx.canvas.height = window.innerHeight;
  ctx.canvas.width = 1.25 * window.innerHeight;
} else {
  // narrow screen, fill width
  ctx.canvas.width = window.innerWidth;
  ctx.canvas.height = window.innerWidth / 1.25;
}
const w = ctx.canvas.width;
const h = ctx.canvas.height;

let imageData = ctx.createImageData(w, h);

// modified from https://gist.github.com/mjackson/5311256
function hslToRgb(h, s, l) {
  let r, g, b;

  if (s == 0) {
    r = g = b = l; // achromatic
  } else {
    const hue2rgb = function hue2rgb(p, q, t) {
      if (t < 0) ++t;
      if (t > 1) --t;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  return [r, g, b].map((i) => Math.round(i * 255));
}

// complex multiply
function ix() {
  let product = [1, 0];
  for (let i = 0; i < arguments.length; ++i) {
    if (typeof arguments[i] === "number") {
      product = product.map((z) => z * arguments[i]);
    } else {
      product = [
        product[0] * arguments[i][0] - product[1] * arguments[i][1],
        product[0] * arguments[i][1] + product[1] * arguments[i][0],
      ];
    }
  }
  return product;
}

// complex square
function is(a) {
  return [a[0] * a[0] - a[1] * a[1], 2 * a[0] * a[1]];
}

// complex add
function ia() {
  let sum = [0, 0];
  for (let i = 0; i < arguments.length; ++i) {
    if (typeof arguments[i] === "number") {
      sum[0] += arguments[i];
    } else {
      sum[0] += arguments[i][0];
      sum[1] += arguments[i][1];
    }
  }
  return sum;
}

// dot product
function dot(a, b) {
  if (a.length !== b.length) return 0;
  return a.map((_, i) => a[i] * b[i]).reduce((m, n) => m + n);
}

const imax = 4000;

function mandel_normal(c) {
  z = [0, 0];
  for (let i = 0; i < imax; ++i) {
    if (dot(z, z) > 4) {
      return i - Math.log2(Math.log2(dot(z, z))) + 4;
    }
    z = ia(is(z), c);
  }
  return 0;
}

function mandel_normal_faster(x0, y0) {
  let x = 0;
  let y = 0;
  // iterate to find when it leaves the circle
  for (let i = 0; i < imax; ++i) {
    if (x * x + y * y > 4) {
      // https://www.iquilezles.org/www/articles/mset_smooth/mset_smooth.htm
      return i - Math.log2(Math.log2(x * x + y * y)) + 4;
    }
    [x, y] = [x * x - y * y + x0, 2 * x * y + y0];
  }
  return 0;
}

// C = a + dz, where dz should be much smaller than a (e.g. a is center of screen, and we're zoomed in far).
// Z = z0 + dz*z1  (higher powers of c are not discarded and go into z1).
// I also tried Z = z0 + dz*z1 + dz^2*z2, but it made no noticeable difference in all cases I tried.
// This seems to somewhat work when a is inside the mandelbrot set
// (i.e. center point of the screen is black).
function mandel_perturbative(a, dz) {
  let z0 = [0, 0];
  let z1 = [0, 0];
  for (let i = 0; i < imax; ++i) {
    let t = ia(z0, ix(z1, dz));
    if (dot(t, t) > 4) {
      return i;
    }
    z1 = ia(ix(z0, z1, 2), [1, 0], ix(is(z1), dz));
    z0 = ia(is(z0), a);
  }
  return 0;
}

function mandel_perturbative_faster(ref_x, ref_y, dz_x, dz_y) {
  let z0_x = 0;
  let z0_y = 0;
  let z1_x = 0;
  let z1_y = 0;
  for (let i = 0; i < imax; ++i) {
    let t_x = z0_x + z1_x * dz_x - z1_y * dz_y;
    let t_y = z0_y + z1_x * dz_y + z1_y * dz_x;
    if (t_x * t_x + t_y * t_y > 4) {
      return i - Math.log2(Math.log2(t_x * t_x + t_y * t_y)) + 4;
    }

    let z1z1_x = z1_x * z1_x - z1_y * z1_y;
    let z1z1_y = 2 * z1_x * z1_y;

    [z1_x, z1_y] = [
      2 * z0_x * z1_x - z0_y * z1_y + 1 + z1z1_x * dz_x - z1z1_y * dz_y,
      2 * z0_x * z1_y + z0_y * z1_x + z1z1_x * dz_y + z1z1_y * dz_x,
    ];

    [z0_x, z0_y] = [z0_x * z0_x - z0_y * z0_y + ref_x, 2 * z0_x * z0_y + ref_y];
  }
  return 0;
}

// returns a color based on a 1D color scale
function palette(i) {
  if (i === 0) return [0, 0, 0];
  const paletteLength = 250;
  const offset = 130;
  return hslToRgb(((i + offset) / paletteLength) % 1, 1, 0.5);
}

// sets color of a pixel
function plot(imageData, pixel, iter) {
  const color = palette(iter);
  imageData.data[pixel * 4 + 0] = color[0];
  imageData.data[pixel * 4 + 1] = color[1];
  imageData.data[pixel * 4 + 2] = color[2];
  imageData.data[pixel * 4 + 3] = 255;
}

let center_x = -0.75;
let center_y = 0;
let range_x = 3.5;
let range_y = 2.8;

let hp = false;

function draw(cx, cy, xrange, yrange) {
  let w_res = xrange / w;
  let h_res = yrange / h;

  if (h_res <= 1e-16 || w_res <= 1e-16) {
    hp = true;
    document.getElementsByName("hp")[0].checked = true;
    document.getElementsByName("hp")[0].disabled = true;
  }

  let t0 = performance.now();
  for (let p = 0; p < w * h; p++) {
    let iter = 0;

    // pixel distance from center
    let dx = (p % w) - w / 2;
    let dy = Math.floor(p / w) - h / 2;

    if (hp) {
      iter = mandel_perturbative_faster(cx, cy, dx * w_res, dy * h_res);
    } else {
      iter = mandel_normal_faster(cx + dx * w_res, cy + dy * h_res);
    }

    plot(imageData, p, iter);
  }
  let t1 = performance.now();

  document.getElementById("display").textContent = `Center: ${cx}, ${cy}
Range: ${xrange}, ${yrange}
Time: ${t1 - t0}ms ${hp ? "perturbed" : "normal"}`;

  // draw
  ctx.putImageData(imageData, 0, 0);
}

draw(center_x, center_y, range_x, range_y);

// handle zooming
canvas.addEventListener("click", (e) => {
  const rect = canvas.getBoundingClientRect();

  let w_res = range_x / w;
  let h_res = range_y / h;

  // update global center
  center_x += (e.clientX - rect.left - w / 2) * w_res;
  center_y += (e.clientY - rect.top - h / 2) * h_res;

  // update global range
  range_x /= 4;
  range_y /= 4;

  draw(center_x, center_y, range_x, range_y);
});

// display cursor location info
canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();

  let w_res = range_x / w;
  let h_res = range_y / h;

  let dx = e.clientX - rect.left - w / 2;
  let dy = e.clientY - rect.top - h / 2;

  let x0 = center_x + dx * w_res;
  let y0 = center_y + dy * h_res;

  document.getElementById("coord").textContent = `X: ${x0}
Y :${y0}
iter: ${mandel_normal_faster(x0, y0)}`;
});
