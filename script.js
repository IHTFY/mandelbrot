const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
if (window.innerWidth / window.innerHeight > 1.75) {
  // wide screen, fill height
  ctx.canvas.height = window.innerHeight;
  ctx.canvas.width = 1.75 * window.innerHeight;
} else {
  // narrow screen, fill width
  ctx.canvas.width = window.innerWidth;
  ctx.canvas.height = window.innerWidth / 1.75;
};
const w = ctx.canvas.width;
const h = ctx.canvas.height;

let imageData = ctx.createImageData(w, h);

let xmin = -2.5;
let xmax = 1;
let ymin = -1;
let ymax = 1;

for (let p = 0; p < w * h; p++) {
  const x0 = ((p % w) / w) * (xmax - xmin) + xmin;
  const y0 = (Math.floor(p / w) / h) * (ymax - ymin) + ymin;
  let x = 0;
  let y = 0;
  let iter = 0;
  let imax = 100;
  while (x ** 2 + y ** 2 <= 4 && iter++ < imax) {
    [x, y] = [x ** 2 - y ** 2 + x0, 2 * x * y + y0];
  }
  plot(imageData, p, iter, imax);

}

ctx.putImageData(imageData, 0, 0);

function plot(imageData, p, i, imax) {
  const color = palette(i, imax);
  imageData.data[p * 4 + 0] = color[0];
  imageData.data[p * 4 + 1] = color[1];
  imageData.data[p * 4 + 2] = color[2];
  imageData.data[p * 4 + 3] = color[3];
}

function palette(i, max) {
  const proportion = i / max;
  return [
    (proportion - 0.6) / 0.2,
    (2 - (Math.abs(proportion - 0.6) / 0.2)),
    (1.5 - (Math.abs(proportion - 0.3) / 0.2)),
    255
  ].map(i => Math.max(Math.min(i * 255, 255), 0));
}