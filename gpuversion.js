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

const imax = 4000;

function hue2rgb(p, q, t) {
  if (t < 0) ++t;
  if (t > 1) --t;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

// modified from https://gist.github.com/mjackson/5311256
function hslToRgb(h, s, l) {
  let r = 1;
  let g = 1;
  let b = 1;

  if (s > 0) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  return [r, g, b];
}

// returns a color based on a 1D color scale
function palette(i) {
  if (i === 0) return [0, 0, 0];
  const paletteLength = 250;
  const offset = 15;

  const h = ((i + offset) / paletteLength) % 1;
  // const r = hue2rgb(0, 1, h + 1 / 3);
  // const g = hue2rgb(0, 1, h);
  // const b = hue2rgb(0, 1, h - 1 / 3);

  // return [r, g, b];
  return hslToRgb(((i + offset) / paletteLength) % 1, 1, 0.5);
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
    if (x * x + y * y > 4) return i; //- Math.log2(Math.log2(x * x + y * y)) + 4;
    let xNew = x * x - y * y + x0;
    y = 2 * x * y + y0;
    x = xNew;
  }
  return 0;
}

const gpu = new GPU()
  .addFunction(mandel_normal_faster)
  .addFunction(palette)
  .addFunction(hslToRgb)
  .addFunction(hue2rgb);

const render = gpu
  .createKernel(function (cx, cy, xrange, yrange, imax) {
    // dimensions of a pixel in mandelbrot coordinates
    let w_res = xrange / this.output.x;
    let h_res = yrange / this.output.y;

    // pixel distance from center
    let dx = this.thread.x - this.output.x / 2;
    let dy = this.output.y / 2 - this.thread.y;

    // mandelbrot coordinates
    let x0 = cx + dx * w_res;
    let y0 = cy + dy * h_res;
    let iter = mandel_normal_faster(x0, y0, imax);

    let col = palette(iter);

    this.color(col[0], col[1], col[2]);
  })
  .setGraphical(true)
  .setOutput([w, h]);

let center_x = -0.75;
let center_y = 0;
let range_x = 3.5;
let range_y = 2.8;

render(center_x, center_y, range_x, range_y, imax);
canvas.replaceWith(render.canvas);
canvas = render.canvas;
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("mouseup", (e) => {
  let zoom = e.button === 2 ? 4 : 0.25;
  const rect = canvas.getBoundingClientRect();

  let w_res = range_x / w;
  let h_res = range_y / h;

  // update global center
  center_x += (e.clientX - rect.left - w / 2) * w_res;
  center_y += (e.clientY - rect.top - h / 2) * h_res;

  // update global range
  range_x *= zoom;
  range_y *= zoom;

  render(center_x, center_y, range_x, range_y, imax);
  canvas.replaceWith(render.canvas);
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
