// NOTE: game of life example https://observablehq.com/@brakdag/conway-game-of-life-gpu-js
// TODO example: https://observablehq.com/@ukabuer/julia-set-fractal-using-gpu-js
// GPU imported from https://unpkg.com/gpu.js@latest/dist/gpu-browser.min.js

// found mandelbrot example
// https://observablehq.com/@robertleeplummerjr/gpu-js-example-mandelbrot-set

let canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

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

let imax = 4000;
const slider = document.getElementsByName("imax")[0];
slider.addEventListener("input", () => {
  imax = parseInt(slider.value);
  document.getElementById("imaxDisplay").textContent = slider.value;
});

const hp = () => document.getElementsByName("hp")[0].checked;

/**
 *
 * @param {number} h float from 0 to 1, but will automatically mod to be in the domain
 * @returns
 */
function h2c(h) {
  h = ((h % 1) + 1) % 1;
  if (h < 1 / 6) return 6 * h;
  if (h < 1 / 2) return 1;
  if (h < 2 / 3) return 4 - 6 * h;
  return 0;
}

// returns a color based on a 1D color scale
function palette(i) {
  if (i === 0) return [0, 0, 0];
  const paletteLength = 250; // how many iterations before colors loop
  const offset = 0; // [0,1)

  const h = i / paletteLength + offset;
  const r = h2c(h + 1 / 3);
  const g = h2c(h);
  const b = h2c(h - 1 / 3);

  return [r, g, b];
}

function track(x0, y0, imax) {
  let path = [[x0, y0]];
  let x = 0;
  let y = 0;
  // iterate to find when it leaves the circle
  for (let i = 0; i < imax; ++i) {
    if (x * x + y * y > 4) return path;
    x = x * x - y * y + x0;
    y = 2 * x * y + y0;
    path.push([x, y]);
  }
  return path;
}

function mandel_normal_faster(x0, y0, imax) {
  let x = 0;
  let y = 0;
  // iterate to find when it leaves the circle
  for (let i = 0; i < imax; ++i) {
    if (x * x + y * y > 4) return i - Math.log2(Math.log2(x * x + y * y)) + 1;
    let xNew = x * x - y * y + x0;
    y = 2 * x * y + y0;
    x = xNew;
  }
  return 0;
}

function mandel_perturbative_faster(ref_x, ref_y, dz_x, dz_y, imax) {
  let z0_x = 0;
  let z0_y = 0;
  let z1_x = 0;
  let z1_y = 0;
  for (let i = 0; i < imax; ++i) {
    let t_x = z0_x + z1_x * dz_x - z1_y * dz_y;
    let t_y = z0_y + z1_x * dz_y + z1_y * dz_x;
    if (t_x * t_x + t_y * t_y > 4) {
      return i - Math.log2(Math.log2(t_x * t_x + t_y * t_y)) + 1;
    }

    let z1z1_x = z1_x * z1_x - z1_y * z1_y;
    let z1z1_y = 2 * z1_x * z1_y;

    let z1_x_temp =
      2 * z0_x * z1_x - z0_y * z1_y + 1 + z1z1_x * dz_x - z1z1_y * dz_y;
    z1_y = 2 * z0_x * z1_y + z0_y * z1_x + z1z1_x * dz_y + z1z1_y * dz_x;
    z1_x = z1_x_temp;

    z0_x = z0_x * z0_x - z0_y * z0_y + ref_x;
    z0_y = 2 * z0_x * z0_y + ref_y;
  }
  return 0;
}

const gpu = new GPU()
  .addFunction(mandel_normal_faster)
  .addFunction(mandel_perturbative_faster)
  .addFunction(palette)
  .addFunction(h2c);

const render = gpu
  .createKernel(function (cx, cy, xrange, yrange, imax, hp) {
    // dimensions of a pixel in mandelbrot coordinates
    let w_res = xrange / this.output.x;
    let h_res = yrange / this.output.y;

    // pixel distance from center
    let dx = this.thread.x - this.output.x / 2;
    let dy = this.output.y / 2 - this.thread.y;

    let dx0 = dx * w_res;
    let dy0 = dy * h_res;

    // mandelbrot coordinates
    let x0 = cx + dx0;
    let y0 = cy + dy0;

    // why is this reversed?
    let iter = hp
      ? mandel_perturbative_faster(cx, cy, dx0, dy0, imax)
      : mandel_normal_faster(x0, y0, imax);

    let col = palette(iter);

    this.color(col[0], col[1], col[2]);
  })
  .setGraphical(true)
  .setOutput([w, h]);

let center_x = -0.75;
let center_y = 0;
let range_x = 3.5;
let range_y = 2.8;

render(center_x, center_y, range_x, range_y, imax, hp());
canvas.replaceWith(render.canvas);
canvas = render.canvas;
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("mouseup", (e) => {
  let zoom = e.button === 2 ? 2 : 0.5;
  const rect = canvas.getBoundingClientRect();

  let w_res = range_x / w;
  let h_res = range_y / h;

  // update global center
  center_x += (e.clientX - rect.left - w / 2) * w_res;
  center_y += (e.clientY - rect.top - h / 2) * h_res;

  // update global range
  range_x *= zoom;
  range_y *= zoom;

  let t0 = performance.now();
  render(center_x, center_y, range_x, range_y, imax, hp());
  canvas.replaceWith(render.canvas);
  let t1 = performance.now();

  document.getElementById(
    "display"
  ).textContent = `Center: ${center_x}, ${center_y}
Range: ${range_x}, ${range_y}
Time: ${t1 - t0}ms ${hp() ? "perturbed" : "normal"}`;
});

document.getElementById(
  "display"
).textContent = `Center: ${center_x}, ${center_y}
Range: ${range_x}, ${range_y}`;

// display cursor location info
let can = document.getElementsByTagName("canvas")[0];
can.addEventListener("mousemove", (e) => {
  const rect = can.getBoundingClientRect();

  let w_res = range_x / w;
  let h_res = range_y / h;

  let dx = e.clientX - rect.left - w / 2;
  let dy = h / 2 - e.clientY - rect.top;

  let x0 = center_x + dx * w_res;
  let y0 = center_y + dy * h_res;

  // the graphical output of the gpu kernal is a webgl2 context, so it's hard to draw a LINE_STRIP
  // maybe neeed to make array buffer, bind it, etc.
  // Probably easier to make another 2d canvas on top and draw the tracked path on that.

  // let path = track(x0, y0, imax);
  // // let gl = can.getContext("webgl2");
  // path = path.map((point) => [
  //   Math.floor((point[0] - center_x) / w_res + w / 2),
  //   Math.floor(h / 2 - (point[1] - center_y) / h_res),
  // ]);

  document.getElementById("coord").textContent = `X: ${x0}
Y :${y0}
iter: ${mandel_normal_faster(x0, y0, imax)}`;
});
